// Integration test for the NOTIFY listener (services/pgListener.js): the one
// long-lived connection through which the support tool's account_deleted
// announcements and the hourly job's live events reach open pages. Runs
// against your running backend (`npm run dev` on :3001, restarted after the
// listener change) and the database in server/.env (production, no real
// users yet).
//
// Part 1, in this process: a listener of our own on a test channel must keep
// delivering after its connection
//   - is reset abruptly (socket destroyed),
//   - goes silent without any error (socket paused -- what a dropped idle
//     connection looks like; only the self-check can notice),
//   - is killed from the database side (pg_terminate_backend).
// Part 2, the running backend: with one throwaway user's socket open,
//   - a relayed live event arrives (the listener survived however long the
//     server has been up),
//   - after killing the backend's listener connection(s) from the database
//     side, the backend reconnects, and a live event AND an account_deleted
//     announcement still arrive.
// Only listener connections from THIS machine are killed (matched by the
// hostname in their tag). The throwaway user is never really deleted (the
// announcement only signs its socket out) and is removed at the end. Never
// touches user 1.
//
//   node scripts/testListenerRecovery.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { createPgListener, listenerTagPrefix } = await import('../services/pgListener.js');
const { emitLive } = await import('../services/liveEvents.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const DELETION_CHANNEL = 'sniffr_account_deleted'; // accountDeletionFollowUp.js
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const T = { email: `listener-test-${stamp}@example.invalid`, username: `lst_${stamp}` };
const TEST_CHANNEL = `sniffr_listener_test_${stamp}`;

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail !== '' ? ` -- got ${detail}` : ''}`);
  }
}
const section = title => console.log(`\n── ${title}`);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const token = () => crypto.randomBytes(8).toString('hex');

async function call(method, path, auth, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function loadSocketClient() {
  try {
    const require = createRequire(new URL('../../client/package.json', import.meta.url));
    return require('socket.io-client').io;
  } catch {
    return null;
  }
}
const waitFor = (socket, event, ms, match = () => true) => new Promise(resolve => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  function handler(payload) {
    if (!match(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload ?? true);
  }
  socket.on(event, handler);
});

async function until(fn, ms, every = 250) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await sleep(every);
  }
  return null;
}

// Backends whose last query starts with `SELECT 1 AS <prefix>` (a listener's tag).
const listenerBackends = prefix => db.all(
  `SELECT pid, backend_start FROM pg_stat_activity
   WHERE left(query, length(?::text)) = ?::text AND pid <> pg_backend_pid()`,
  [`SELECT 1 AS ${prefix}`, `SELECT 1 AS ${prefix}`]);
const terminate = pids => db.all('SELECT pid, pg_terminate_backend(pid) AS ok FROM unnest(?::int[]) AS pid', [pids]);

// ── Part 1: our own listener ───────────────────────────────────────────
async function partOne(created) {
  section('1. A listener in this process recovers from every kind of loss');
  const received = new Set();
  const listener = createPgListener({ [TEST_CHANNEL]: payload => received.add(payload) },
    { label: 'test listener', selfCheckMs: 1500, pingTimeoutMs: 1500 });
  created.listener = listener;
  listener.start();

  const connectedAfter = gen => until(() => {
    const s = listener.status();
    return s.connected && s.generation > gen;
  }, 25000);
  const delivers = async () => {
    const t = token();
    await db.run('SELECT pg_notify(?::text, ?::text)', [TEST_CHANNEL, t]);
    return !!(await until(() => received.has(t), 5000, 100));
  };

  check('connects and LISTENs', !!(await connectedAfter(0)));
  check('baseline: a NOTIFY arrives', await delivers());

  // a) abrupt reset
  let gen = listener.status().generation;
  listener.client().connection.stream.destroy();
  check('a) socket destroyed: reconnects', !!(await connectedAfter(gen)));
  check('a) ...and a NOTIFY arrives again', await delivers());

  // b) silent: nothing is read any more, no error, no end
  gen = listener.status().generation;
  listener.client().connection.stream.pause();
  check('b) connection goes silent: the self-check notices and reconnects', !!(await connectedAfter(gen)));
  check('b) ...and a NOTIFY arrives again', await delivers());

  // c) killed by the database
  gen = listener.status().generation;
  const tag = listener.status().tag;
  const mine = await listenerBackends(tag);
  check('c) our listener connection is visible in pg_stat_activity', mine.length === 1, JSON.stringify(mine));
  if (mine.length) {
    await terminate(mine.map(r => r.pid));
    check('c) terminated by the database: reconnects', !!(await connectedAfter(gen)));
    check('c) ...and a NOTIFY arrives again', await delivers());
  }
  check('three reconnects counted', listener.status().reconnects === 3, listener.status().reconnects);

  await listener.stop();
  created.listener = null;
}

// ── Part 2: the running backend's listener ─────────────────────────────
async function partTwo(created) {
  section('2. The running backend keeps hearing NOTIFY after losing its listener');
  const hash = await bcrypt.hash(PASSWORD, 10);
  T.userId = (await db.get(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, 'Listener Test', 1) RETURNING id`, [T.email, T.username, hash])).id;
  created.users.push({ id: T.userId, email: T.email });
  const login = await call('POST', '/api/auth/login', null, { email: T.email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`fixture step failed: login: ${login.status} ${JSON.stringify(login.data).slice(0, 200)}`);
  console.log(`  T #${T.userId}`);

  const ioClient = loadSocketClient();
  if (!ioClient) throw new Error('socket.io-client not found in client/node_modules');
  const socket = ioClient(API_BASE, { auth: { token: login.data.accessToken }, transports: ['websocket'], reconnection: false });
  created.sockets.push(socket);
  const connected = await Promise.race([
    new Promise(res => socket.once('connect', () => res(true))),
    new Promise(res => socket.once('connect_error', () => res(false))),
    new Promise(res => setTimeout(() => res(false), 5000)),
  ]);
  if (!connected) throw new Error("T's socket did not connect");
  await sleep(500); // the server joins user_<id> on connection

  const liveArrives = async () => {
    const t = token();
    const got = waitFor(socket, 'listener_test_ping', 8000, p => p?.token === t);
    await emitLive(null, `user_${T.userId}`, 'listener_test_ping', { token: t }); // no io: goes via NOTIFY
    return !!(await got);
  };

  check('before: a live event reaches the open socket (listener alive since the backend started)', await liveArrives(),
    'nothing within 8s -- the backend\'s listener is dead (see its log for "[NOTIFY listener]" lines)');

  const prefix = listenerTagPrefix();
  const before = await listenerBackends(prefix);
  check("the backend's listener connection is visible in pg_stat_activity", before.length >= 1,
    'none -- was the backend restarted after the listener change?');
  if (!before.length) return;
  if (before.length > 1) console.log(`  note: ${before.length} listener connections from this machine (another backend running?) -- killing all`);
  const killed = await terminate(before.map(r => r.pid));
  check('terminated', killed.every(r => r.ok), JSON.stringify(killed));

  const back = await until(async () => {
    const rows = await listenerBackends(prefix);
    return rows.find(r => !before.some(b => b.pid === r.pid));
  }, 30000, 500);
  check('the backend reconnected its listener', !!back, 'no new listener connection within 30s');

  check('after: a live event reaches the open socket again', await liveArrives());

  const gotDeleted = waitFor(socket, 'account_deleted', 8000, p => Number(p?.userId) === T.userId);
  await db.run('SELECT pg_notify(?::text, ?::text)', [DELETION_CHANNEL, JSON.stringify({ userId: T.userId, conversationIds: [], ownedCircleIds: [] })]);
  check('after: an account_deleted announcement reaches it too (second channel re-LISTENed)', !!(await gotDeleted));
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  if (created.listener) await created.listener.stop();
  for (const socket of created.sockets) socket.disconnect();
  if (!created.users.length) {
    console.log('  nothing to clean up');
    return;
  }
  await withTransaction(async tx => {
    const users = created.users.map(u => u.id);
    for (const { id, email } of created.users) {
      const row = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!row) continue;
      if (row.email !== email || row.is_admin || id === PROTECTED_USER_ID) throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
    }
    for (const table of ['notifications', 'notification_preferences', 'refresh_tokens', 'trusted_devices', 'verification_codes']) {
      await tx.run(`DELETE FROM ${table} WHERE user_id = ANY(?::int[])`, [users]);
    }
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} test user`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}   Backend: ${API_BASE}`);
  console.log(`Creates throwaway user ${T.email}, briefly kills this machine's NOTIFY listener connections (they reconnect), then deletes the user.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "production" to continue: ');
  rl.close();
  if (answer.trim() !== 'production') {
    console.log('Aborted -- nothing was done.');
    return;
  }
  try {
    const health = await fetch(`${API_BASE}/api/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`Backend not reachable at ${API_BASE} (${err.message}). Start it with "npm run dev" first.`);
    process.exitCode = 1;
    return;
  }

  await initDb();
  const created = { users: [], sockets: [], listener: null };
  try {
    await partOne(created);
    await partTwo(created);
  } catch (err) {
    failed++;
    console.error(`\nTest run stopped early: ${err.stack || err.message}`);
  } finally {
    try {
      await cleanup(created);
    } catch (err) {
      failed++;
      console.error(`\nCLEANUP FAILED (rolled back): ${err.message}\n  Remove users ${created.users.map(u => `#${u.id}`).join(', ')} by hand.`);
    } finally {
      await getDb().end();
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0); // socket.io-client can keep the process alive
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
