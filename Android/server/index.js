import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { initDb, getDb } from './db/connection.js';
import { startCleanupJobs } from './db/cleanup.js';
import { authenticateSocket } from './middleware/auth.js';
import { setupChatSocket } from './socket/chat.js';
import { setupCallSocket } from './socket/calls.js';
import { setupNotificationSocket } from './socket/notifications.js';
import { setupCommunitySocket } from './socket/communities.js';
import { setupMeetSocket } from './socket/meet.js';
import { guardSocketHandlers } from './socket/safeHandlers.js';
import { listenForDeletionAnnouncements } from './services/accountDeletionFollowUp.js';
import { sendServerError } from './utils/errors.js';

import authRoutes from './routes/auth.js';
import postRoutes from './routes/posts.js';
import matchRoutes from './routes/matches.js';
import chatRoutes from './routes/chat.js';
import profileRoutes from './routes/profile.js';
import spotlightRoutes from './routes/spotlight.js';
import privacyRoutes from './routes/privacy.js';
import accountRoutes from './routes/account.js';
import communityRoutes from './routes/communities.js';
import notificationRoutes from './routes/notifications.js';
import premiumRoutes from './routes/premium.js';
import ratingRoutes from './routes/ratings.js';
import adminRoutes from './routes/admin.js';
import callRoutes from './routes/calls.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A promise rejection nobody handled exits Node (>= 15) and takes every user
// down with it. Log it instead (message only: no request data).
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandled promise rejection:', reason?.stack || reason?.message || reason);
});

async function start() {
  // Initialize database (Postgres via Supabase)
  await initDb();
  startCleanupJobs();

  const app = express();

  // Behind Render's proxy: req.ip (which every IP rate limit keys on) is the
  // X-Forwarded-For entry TRUST_PROXY_HOPS from the right. Entries a client
  // sends itself sit further left, so they can't be picked as long as the
  // hop count isn't higher than the proxies really in front (see config.js).
  app.set('trust proxy', config.TRUST_PROXY_HOPS);

  const server = createServer(app);

  const io = new Server(server, {
    cors: {
      origin: config.CORS_ORIGINS,
      methods: ['GET', 'POST']
    }
  });

  // Middleware
  app.set('io', io);

  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' }
    })
  );

  // The landing site's public account-deletion page (sniffrweb.com/delete-account,
  // a Google Play requirement) calls /api/account/public/* from these origins,
  // whatever CORS_ORIGINS is set to. Registered first so it answers their
  // preflights; no cookies or auth headers are involved.
  const LANDING_ORIGINS = ['https://sniffrweb.com', 'https://www.sniffrweb.com'];
  app.use(
    '/api/account/public',
    cors({
      origin: config.CORS_ORIGINS === '*' ? '*' : [...new Set([...LANDING_ORIGINS, ...config.CORS_ORIGINS])],
      methods: ['POST'],
    })
  );

  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      credentials: true
    })
  );

  // Dev-only request log -- unconditional console.log on every single
  // request is pure noise (and a minor perf cost) once this is deployed
  // and getting real traffic; nothing downstream depends on it.
  if (config.NODE_ENV !== 'production') {
    app.use((req, res, next) => {
      console.log('[REQ]', req.method, req.url, 'origin=' + req.headers.origin);
      next();
    });
  }

  // L1: an explicit, documented cap rather than relying on express.json()'s
  // undocumented-at-the-call-site default (100kb). File/media uploads go
  // through multer on their own routes, never through this JSON body
  // parser, so 1mb is already generous for every real JSON payload this API
  // accepts. A malformed body or one over this limit is now returned as a
  // clean 400/413 (see utils/errors.js's sendServerError) instead of
  // falling through to a raw 500.
  app.use(express.json({ limit: '1mb' }));

  // Static files
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/posts', postRoutes);
  app.use('/api/matches', matchRoutes);
  app.use('/api/chat', chatRoutes);
  app.use('/api/profile', profileRoutes);
  app.use('/api/spotlight', spotlightRoutes);
  app.use('/api/privacy', privacyRoutes);
  app.use('/api/account', accountRoutes);
  app.use('/api/communities', communityRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/premium', premiumRoutes);
  app.use('/api/ratings', ratingRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/calls', callRoutes);

  // Root route
  app.get('/', (req, res) => {
    res.json({
      status: 'online',
      app: 'Sniffr API',
      version: '1.0.0'
    });
  });

  // Health check
  // Off unless DEBUG_CLIENT_IP=1: shows the CALLER their own client IP as the
  // server resolves it, plus the raw forwarding headers, to check
  // TRUST_PROXY_HOPS on a deployment (compare "ip" with your real public IP,
  // then repeat with a fake X-Forwarded-For header: "ip" must not change).
  // Nothing is logged. Turn it off again afterwards.
  if (process.env.DEBUG_CLIENT_IP === '1') {
    console.warn('[debug] GET /api/debug/client-ip is enabled (DEBUG_CLIENT_IP=1) -- unset it when done');
    app.get('/api/debug/client-ip', (req, res) => {
      res.json({
        ip: req.ip,
        trustProxyHops: config.TRUST_PROXY_HOPS,
        xForwardedFor: req.headers['x-forwarded-for'] ?? null,
        cfConnectingIp: req.headers['cf-connecting-ip'] ?? null,
        trueClientIp: req.headers['true-client-ip'] ?? null,
      });
    });
  }

  app.get('/api/health', (req, res) => {
    res.json({
      status: 'ok',
      time: new Date().toISOString()
    });
  });

  // 404 for unmatched API routes -- must come after every real /api/* route
  // above, otherwise it would shadow them. Otherwise an unmatched API path
  // falls through to Express's own default HTML "Cannot GET" page instead
  // of a clean JSON error.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'NOT_FOUND', message: 'No such endpoint.' });
  });

  // Centralized error handler -- Express requires exactly 4 params for this
  // to be recognized as an error handler (not a regular middleware). Without
  // this, an exception thrown synchronously in a route/middleware (not
  // caught by that route's own try/catch) crashes the whole process instead
  // of returning a clean 500.
  app.use((err, req, res, next) => {
    sendServerError(res, err);
  });

  // Socket.IO authentication
  io.use(authenticateSocket);
  // Before any handler attaches: malformed payloads and handler errors are
  // caught per event instead of crashing the process (socket/safeHandlers.js).
  io.use(guardSocketHandlers);

  // Socket handlers
  setupChatSocket(io);
  setupCallSocket(io);
  setupNotificationSocket(io);
  setupCommunitySocket(io);
  setupMeetSocket(io);
  // Deletions made by the support script (scripts/deleteAccount.js) reach
  // this server's sockets through Postgres NOTIFY, as do live events from the
  // hourly job (services/liveEvents.js).
  const notifyListener = listenForDeletionAnnouncements(io);

  // Graceful shutdown -- stop accepting new connections, let in-flight
  // HTTP requests and open sockets finish (bounded by a timeout so a stuck
  // connection can't block the shutdown forever), then close the DB pool.
  // Render sends SIGTERM before killing the process on every deploy/restart;
  // the previous immediate process.exit() dropped in-flight requests.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, closing gracefully...`);

    const forceExit = setTimeout(() => {
      console.warn('[shutdown] Timed out waiting for connections to close, forcing exit.');
      process.exit(1);
    }, 10000);
    forceExit.unref();

    notifyListener.stop();
    io.close();
    server.close(async () => {
      try {
        await getDb().end();
      } catch (err) {
        console.error('[shutdown] Error closing DB pool:', err.message);
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server.listen(config.PORT, () => {
    console.log(`🐾 Sniffr server running on http://localhost:${config.PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});