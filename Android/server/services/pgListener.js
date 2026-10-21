import os from 'os';
import crypto from 'crypto';
import pg from 'pg';
import db from '../db/connection.js';

// One long-lived Postgres connection that LISTENs on a set of channels and
// survives losing that connection. Used for the NOTIFY hand-offs from code
// without the server's io (the account-deletion support tool, the hourly
// job's live events -- see accountDeletionFollowUp.js and liveEvents.js).
//
// A LISTEN connection sits idle for hours, which is exactly what poolers,
// NAT routers and load balancers drop -- sometimes without telling either
// side, so pg never sees an 'error' or 'end' and the server simply stops
// hearing anything. So:
//   - TCP keepalive on the socket (finds dead peers, keeps NAT entries alive);
//   - any 'error'/'end' reconnects (1s, 2s, 5s, 10s, then every 30s) and
//     LISTENs on every channel again, logging the disconnect and reconnect;
//   - a self-check every minute: a NOTIFY on PING_CHANNEL sent through the
//     ordinary pool (another connection) must come back on this one within
//     10s, otherwise the connection is treated as dead and replaced. That
//     proves the whole path works, not just that the socket is open.
// NOTIFYs sent while the connection is down are lost (Postgres doesn't keep
// them); the gap is normally a second or two.
//
// After connecting it runs `SELECT 1 AS <listenerTag>`, which stays as its
// last query in pg_stat_activity, so scripts/testListenerRecovery.js can find
// this machine's listener connection and kill it.

export const PING_CHANNEL = 'sniffr_listener_ping';
const RETRY_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const CHANNEL_NAME = /^[a-z_][a-z0-9_]*$/;

// 'sniffr_listener_<host>_' -- shared by every listener on this machine.
export function listenerTagPrefix(host = os.hostname()) {
  return `sniffr_listener_${String(host).toLowerCase().replace(/[^a-z0-9]/g, '_')}_`;
}

/**
 * channels: { channelName: (payload: string) => void }
 * Returns { start, stop, status, client } (client is for tests only).
 */
export function createPgListener(channels, {
  connectionString = process.env.DATABASE_URL,
  label = 'pg listener',
  selfCheckMs = 60000,
  pingTimeoutMs = 10000,
} = {}) {
  const handlers = new Map(Object.entries(channels));
  handlers.set(PING_CHANNEL, payload => onPing(payload));
  for (const name of handlers.keys()) {
    if (!CHANNEL_NAME.test(name)) throw new Error(`[${label}] invalid channel name: ${name}`);
  }
  const instanceId = crypto.randomBytes(6).toString('hex');
  const tag = `${listenerTagPrefix()}${process.pid}`;

  let client = null;
  let connected = false;
  let stopped = true;
  let generation = 0;     // bumped per connection attempt; stale clients' events are ignored
  let attempt = 0;        // consecutive failed attempts, for the backoff
  let reconnects = 0;
  let downSince = null;
  let retryTimer = null;
  let checkTimer = null;
  let checking = false;
  let pingSeq = 0;
  let pendingPing = null; // { token, resolve }
  let lastPingOkAt = null;

  function onPing(payload) {
    if (pendingPing && payload === pendingPing.token) pendingPing.resolve(true);
  }

  function dropClient(c) {
    if (!c) return;
    c.removeAllListeners('notification');
    c.removeAllListeners('end');
    c.removeAllListeners('error');
    c.on('error', () => {}); // a late error on a discarded client must not crash the server
    c.end().catch(() => {});
    // end() waits for the server to answer, which never happens on a dead
    // socket: free it now.
    c.connection?.stream?.destroy?.();
  }

  function lost(gen, reason) {
    if (stopped || gen !== generation) return; // already being replaced
    generation++;
    const wasConnected = connected;
    connected = false;
    dropClient(client);
    client = null;
    if (pendingPing) pendingPing.resolve(false);
    if (wasConnected) downSince = Date.now();
    const delay = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
    attempt++;
    console.error(`[${label}] ${wasConnected ? 'connection lost' : 'could not connect'} (${reason}) -- retrying in ${delay / 1000}s; live hand-offs are missed until then`);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, delay);
    retryTimer.unref?.();
  }

  async function connect() {
    retryTimer = null;
    if (stopped) return;
    const gen = ++generation;
    const c = new pg.Client({
      connectionString,
      ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      connectionTimeoutMillis: 10000,
      query_timeout: 10000,
      application_name: tag,
    });
    client = c;
    c.on('error', err => lost(gen, err.message || String(err)));
    c.on('end', () => lost(gen, 'connection closed'));
    c.on('notification', msg => {
      if (gen !== generation) return;
      const handler = handlers.get(msg.channel);
      if (!handler) return;
      try {
        handler(msg.payload);
      } catch (err) {
        console.error(`[${label}] handler for ${msg.channel} failed:`, err.message);
      }
    });
    try {
      await c.connect();
      for (const name of handlers.keys()) await c.query(`LISTEN ${name}`);
      await c.query(`SELECT 1 AS ${tag}`);
    } catch (err) {
      lost(gen, err.message || String(err));
      return;
    }
    if (gen !== generation) return; // lost while connecting
    connected = true;
    attempt = 0;
    const names = [...handlers.keys()].filter(n => n !== PING_CHANNEL).join(', ');
    if (downSince) {
      reconnects++;
      console.log(`[${label}] reconnected after ${Math.round((Date.now() - downSince) / 1000)}s, listening again on: ${names}`);
      downSince = null;
    } else {
      console.log(`[${label}] listening on: ${names}`);
    }
  }

  // NOTIFY through the pool, expect it back here.
  async function selfCheck() {
    if (stopped || !connected || checking) return;
    checking = true;
    const gen = generation;
    const token = `${instanceId}:${++pingSeq}`;
    try {
      const arrived = new Promise(resolve => {
        pendingPing = { token, resolve };
        setTimeout(() => resolve(false), pingTimeoutMs).unref?.();
      });
      try {
        await db.run('SELECT pg_notify(?::text, ?::text)', [PING_CHANNEL, token]);
      } catch (err) {
        // The pool can't reach the database either: ask the listener itself.
        console.error(`[${label}] self-check could not send its ping (${err.message}); checking the connection directly`);
        try {
          await client?.query(`SELECT 1 AS ${tag}`);
        } catch (e) {
          lost(gen, `self-check: ${e.message}`);
        }
        return;
      }
      if (await arrived) {
        lastPingOkAt = new Date();
      } else {
        lost(gen, `self-check: ping not received within ${pingTimeoutMs / 1000}s`);
      }
    } finally {
      pendingPing = null;
      checking = false;
    }
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      connect();
      checkTimer = setInterval(selfCheck, selfCheckMs);
      checkTimer.unref?.();
    },
    async stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(checkTimer);
      connected = false;
      const c = client;
      client = null;
      generation++;
      dropClient(c);
    },
    selfCheck,
    status: () => ({ connected, generation, reconnects, lastPingOkAt, tag, channels: [...handlers.keys()] }),
    client: () => client,
  };
}
