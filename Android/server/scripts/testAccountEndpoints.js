// Integration test for /api/account/delete/request-code + /confirm and the
// removed POST /api/privacy/delete, against your running backend (`npm run
// dev` on :3001) and the database in server/.env (currently production, no
// real users yet).
//
// Throwaway users (emails on the reserved .invalid domain, so the mailer skips
// them): U1 is deleted through the real endpoint, U2 exercises the error
// paths, U3 the hourly code limit, and ADM is a throwaway admin. U4 signs up
// through the real /api/auth/signup (a Supabase Auth email/password account):
// deleting it must remove its auth.users identity, and the same email must be
// able to sign up again. Cleanup also deletes every Supabase identity the
// test created (needs SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in server/.env;
// without them the U4 checks are skipped). The test
// can't read the emailed code, so after request-code it issues its own code
// in-process (which invalidates the emailed one) and uses that over HTTP.
// Cleanup deletes everything created, even if a check fails. Never touches
// user 1.
//
//   node scripts/testAccountEndpoints.js
import readline from 'readline/promises';
import crypto from 'crypto';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import '../config.js';
import { initDb, getDb, dbAdapter as db, withTransaction } from '../db/connection.js';
import { issueCode } from '../services/verificationCodes.js';
import { testPetUsername } from './lib/testIds.js';
import config from '../config.js';
import { getAdminClient } from '../lib/supabase.js';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `acct-test-${stamp}-${key}@example.invalid`, username: `acct${key}_${stamp}` });
const U1 = mk('u1');
const U2 = mk('u2');
const U3 = mk('u3');
const ADM = mk('adm');
const U4 = mk('u4');
const U4_PASSWORD = `Aa1!${crypto.randomBytes(6).toString('hex')}`;
const supabaseReady = !!(config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY);
// Supabase identities this run created (deleted in cleanup, even on failure).
const createdAuthIds = new Set();
const PHRASE = 'DELETE ACCOUNT';

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
const show = r => `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`;
const one = (sql, params = []) => db.get(sql, params);

async function call(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const post = (path, token, body) => call('POST', path, token, body);
const requestCode = user => post('/api/account/delete/request-code', user.token);
const confirm = (user, code, confirmation = PHRASE) => post('/api/account/delete/confirm', user.token, { code, confirmation });
const latestCode = userId => one(
  "SELECT id, attempts, consumed_at, invalidated_at FROM verification_codes WHERE user_id = ? AND purpose = 'delete_account' ORDER BY id DESC LIMIT 1",
  [userId]);
const isDeleted = async userId => !!(await one('SELECT deleted_at FROM users WHERE id = ?', [userId]))?.deleted_at;

async function createUser(spec, created, admin = false) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified, is_admin)
     VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
    [spec.email, spec.username, hash, `Account Endpoint Test ${spec.key}`, admin]);
  spec.userId = row.id;
  created.push({ id: row.id, email: spec.email });
  const login = await post('/api/auth/login', null, { email: spec.email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed for ${spec.key}: ${show(login)}`);
  spec.token = login.data.accessToken;
}

function loadSocketClient() {
  try {
    const require = createRequire(new URL('../../client/package.json', import.meta.url));
    return require('socket.io-client').io;
  } catch {
    return null;
  }
}

async function runTests(created) {
  section('Setup');
  await createUser(U1, created);
  await createUser(U2, created);
  await createUser(U3, created);
  await createUser(ADM, created, true);
  const pet = await post('/api/profile', U1.token, { name: `AcctPet${stamp}`, pet_username: testPetUsername('acct'), type: 'dog' });
  check('U1 has a pet (so the deletion has something to scrub)', pet.status === 201, show(pet));

  section('request-code');
  let r = await requestCode(U1);
  check('request-code -> 200 with masked email and 10-minute expiry',
    r.status === 200 && r.data.success === true && r.data.expiresInSeconds === 600
      && typeof r.data.maskedEmail === 'string' && r.data.maskedEmail.includes('***') && r.data.maskedEmail.endsWith('@example.invalid'),
    show(r));
  check('request-code response never contains the code itself', !JSON.stringify(r.data).match(/\b\d{6}\b/), show(r));
  const httpCode = await latestCode(U1.userId);
  check('a live code row exists for U1', !!httpCode && !httpCode.consumed_at && !httpCode.invalidated_at, JSON.stringify(httpCode));

  for (let i = 1; i <= 3; i++) {
    r = await requestCode(U3);
    check(`U3 request #${i} within the hour -> 200`, r.status === 200, show(r));
  }
  r = await requestCode(U3);
  check('U3 request #4 within the hour -> 429 RATE_LIMITED with retryAfterSeconds',
    r.status === 429 && r.data.error === 'RATE_LIMITED' && r.data.retryAfterSeconds >= 1 && r.data.retryAfterSeconds <= 3600, show(r));

  section('confirm: error paths (U2)');
  const first = await issueCode(U2.userId, 'delete_account');
  const wrong = first.code === '000000' ? '111111' : '000000';
  r = await confirm(U2, first.code, 'delete account');
  check('lowercase phrase -> 400 CONFIRMATION_MISMATCH', r.status === 400 && r.data.error === 'CONFIRMATION_MISMATCH', show(r));
  r = await confirm(U2, first.code, 'DELETE  ACCOUNT');
  check('phrase with an extra space -> 400 CONFIRMATION_MISMATCH', r.status === 400 && r.data.error === 'CONFIRMATION_MISMATCH', show(r));
  check('CONFIRMATION_MISMATCH used no attempt', (await latestCode(U2.userId))?.attempts === 0, JSON.stringify(await latestCode(U2.userId)));
  for (let i = 1; i <= 4; i++) {
    r = await confirm(U2, wrong);
    check(`wrong code #${i} -> 400 INVALID_CODE, ${5 - i} attempts left`,
      r.status === 400 && r.data.error === 'INVALID_CODE' && r.data.attemptsRemaining === 5 - i, show(r));
  }
  r = await confirm(U2, wrong);
  check('wrong code #5 -> 429 TOO_MANY_ATTEMPTS', r.status === 429 && r.data.error === 'TOO_MANY_ATTEMPTS', show(r));
  r = await confirm(U2, first.code);
  check('correct code after lockout -> still 429 TOO_MANY_ATTEMPTS', r.status === 429 && r.data.error === 'TOO_MANY_ATTEMPTS', show(r));
  const second = await issueCode(U2.userId, 'delete_account');
  await db.run("UPDATE verification_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ? AND user_id = ?", [second.codeId, U2.userId]);
  r = await confirm(U2, second.code);
  check('correct but expired code -> 400 CODE_EXPIRED', r.status === 400 && r.data.error === 'CODE_EXPIRED', show(r));
  check('U2 was never deleted by any of that', !(await isDeleted(U2.userId)));

  section('admin');
  r = await requestCode(ADM);
  check('admin request-code -> 403 ADMIN_CANNOT_SELF_DELETE', r.status === 403 && r.data.error === 'ADMIN_CANNOT_SELF_DELETE', show(r));
  r = await confirm(ADM, '123456');
  check('admin confirm -> 403 ADMIN_CANNOT_SELF_DELETE', r.status === 403 && r.data.error === 'ADMIN_CANNOT_SELF_DELETE', show(r));
  check('admin not deleted', !(await isDeleted(ADM.userId)));

  section('old endpoint');
  r = await post('/api/privacy/delete', U2.token);
  check('POST /api/privacy/delete -> 410 ENDPOINT_REMOVED', r.status === 410 && r.data.error === 'ENDPOINT_REMOVED', show(r));
  check('...and deleted nothing', !(await isDeleted(U2.userId)) && !!(await one('SELECT id FROM users WHERE id = ?', [U2.userId])));

  section('confirm: success (U1)');
  const ioClient = loadSocketClient();
  let socket = null;
  const events = { accountDeleted: null, disconnectReason: null };
  if (ioClient) {
    socket = ioClient(API_BASE, { auth: { token: U1.token }, transports: ['websocket'], reconnection: false });
    const connected = await Promise.race([
      new Promise(res => socket.once('connect', () => res(true))),
      new Promise(res => socket.once('connect_error', () => res(false))),
      new Promise(res => setTimeout(() => res(false), 5000)),
    ]);
    check("U1's socket connected before deletion", connected);
    socket.on('account_deleted', payload => { events.accountDeleted = payload; });
    socket.on('disconnect', reason => { events.disconnectReason = reason; });
  } else {
    console.log('  SKIP  socket.io-client not found in client/node_modules -- 3 socket checks not run');
  }

  const own = await issueCode(U1.userId, 'delete_account');
  check("the test's own code invalidated the emailed one", !!(await one('SELECT invalidated_at FROM verification_codes WHERE id = ?', [httpCode.id]))?.invalidated_at);
  r = await confirm(U1, own.code);
  // U1 uploaded nothing (its pet has no avatar), so the deletion queues no
  // files and the post-deletion purge has nothing to wait for: 'complete' is
  // the only right answer. 'pending' here would mean files were queued for a
  // user who never uploaded any.
  const queuedForU1 = await one(
    "SELECT count(*)::int AS n FROM pending_media_deletions WHERE deleted_user_id = ? AND source <> 'tag_sweep'", [U1.userId]);
  check("confirm -> 200 { success: true, mediaCleanup: 'complete' }, no files queued for U1",
    r.status === 200 && r.data.success === true && r.data.mediaCleanup === 'complete' && queuedForU1.n === 0,
    `${show(r)} queued=${queuedForU1.n}`);
  const u = await one('SELECT email, username, deleted_at FROM users WHERE id = ?', [U1.userId]);
  check('U1 is tombstoned', !!u?.deleted_at && u.email === `sniffedout~${U1.userId}` && u.username === `sniffedout~${U1.userId}`, JSON.stringify(u));

  r = await call('GET', '/api/auth/me', U1.token);
  check("U1's old access token -> 401 ACCOUNT_DELETED", r.status === 401 && r.data.error === 'ACCOUNT_DELETED', show(r));
  r = await confirm(U1, own.code);
  check('confirming again with the old token -> 401 ACCOUNT_DELETED', r.status === 401 && r.data.error === 'ACCOUNT_DELETED', show(r));

  if (socket) {
    for (let waited = 0; waited < 5000 && !(events.accountDeleted && events.disconnectReason); waited += 100) {
      await new Promise(res => setTimeout(res, 100));
    }
    check("U1's socket received account_deleted", events.accountDeleted?.userId === U1.userId, JSON.stringify(events.accountDeleted));
    check("U1's socket was disconnected by the server", events.disconnectReason === 'io server disconnect', events.disconnectReason);
    socket.disconnect();
  }

  section('Supabase-linked account (U4): identity deleted, email reusable');
  if (!supabaseReady) {
    console.log('  SKIP  SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set in server/.env -- 3 Supabase checks not run');
    return;
  }
  const signupBody = { full_name: 'Account Endpoint Test U4', username: `acctu4${String(stamp).slice(-8)}`, email: U4.email, password: U4_PASSWORD, confirmPassword: U4_PASSWORD };
  r = await post('/api/auth/signup', null, signupBody);
  let row = await one('SELECT id, auth_user_id FROM users WHERE email = ? AND deleted_at IS NULL', [U4.email]);
  if (row) {
    U4.userId = row.id;
    created.push({ id: row.id, email: U4.email });
    if (row.auth_user_id) createdAuthIds.add(row.auth_user_id);
  }
  const identity = row?.auth_user_id ? await one('SELECT id FROM auth.users WHERE id = ?::uuid', [row.auth_user_id]) : null;
  check('signup through the API -> linked Supabase identity in auth.users',
    (r.status === 200 || r.status === 201) && !!r.data.accessToken && !!identity, `${show(r)} row=${JSON.stringify(row)}`);
  if (!identity) return;
  U4.token = r.data.accessToken;
  const authId = row.auth_user_id;

  r = await requestCode(U4);
  if (r.status !== 200) throw new Error(`U4 request-code failed: ${show(r)}`);
  const u4Code = await issueCode(U4.userId, 'delete_account');
  r = await confirm(U4, u4Code.code);
  const after = await one(
    `SELECT (SELECT count(*)::int FROM auth.users WHERE id = ?::uuid) AS identity,
            (SELECT auth_user_id FROM users WHERE id = ?) AS link,
            (SELECT count(*)::int FROM pending_auth_deletions WHERE deleted_user_id = ?) AS queued`,
    [authId, U4.userId, U4.userId]);
  check("deleting U4 removes its auth.users identity (authCleanup 'complete', link cleared, nothing queued)",
    r.status === 200 && r.data.authCleanup === 'complete' && after.identity === 0 && after.link === null && after.queued === 0,
    `${show(r)} ${JSON.stringify(after)}`);

  r = await post('/api/auth/signup', null, signupBody);
  row = await one('SELECT id, auth_user_id FROM users WHERE email = ? AND deleted_at IS NULL', [U4.email]);
  if (row) {
    created.push({ id: row.id, email: U4.email });
    if (row.auth_user_id) createdAuthIds.add(row.auth_user_id);
  }
  check('the same email can sign up again (new account, new identity)',
    (r.status === 200 || r.status === 201) && !!row && row.id !== U4.userId && !!row.auth_user_id && row.auth_user_id !== authId,
    `${show(r)} row=${JSON.stringify(row)}`);
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  if (!created.length) {
    console.log('  nothing to clean up');
    return;
  }
  // Every Supabase identity tied to a test user: still linked, still queued
  // for deletion, or created by this run.
  const userIds = created.map(u => u.id);
  for (const r of await db.all('SELECT auth_user_id FROM users WHERE id = ANY(?::int[]) AND auth_user_id IS NOT NULL', [userIds])) {
    createdAuthIds.add(r.auth_user_id);
  }
  const queueExists = (await one("SELECT to_regclass('public.pending_auth_deletions') IS NOT NULL AS ok")).ok;
  if (queueExists) {
    for (const r of await db.all('SELECT auth_user_id FROM pending_auth_deletions WHERE deleted_user_id = ANY(?::int[])', [userIds])) {
      createdAuthIds.add(r.auth_user_id);
    }
  }
  await withTransaction(async tx => {
    const users = created.map(u => u.id);
    for (const { id, email } of created) {
      const row = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!row) continue;
      if (id === PROTECTED_USER_ID || !(row.email === email || row.email === `sniffedout~${id}`)) {
        throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
      }
      if (row.is_admin) await tx.run('UPDATE users SET is_admin = FALSE WHERE id = ? AND email = ?', [id, email]);
    }
    const pets = (await tx.all('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [users])).map(r => r.id);
    const posts = (await tx.all('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [pets])).map(r => r.id);
    const steps = [
      ['likes', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['comments', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['posts', 'id = ANY(?::int[])', [posts]],
      ['swipes', 'from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [pets, pets]],
      ['profile_views', 'viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [pets, pets]],
      ['spotlight_history', 'pet_id = ANY(?::int[])', [pets]],
      ['spotlight_rank_tracking', 'pet_id = ANY(?::int[])', [pets]],
      ['notifications', 'user_id = ANY(?::int[]) OR sender_pet_id = ANY(?::int[])', [users, pets]],
      ['plan_history', 'user_id = ANY(?::int[])', [users]],
      ['payment_sessions', 'user_id = ANY(?::int[])', [users]],
      ['pending_media_deletions', 'deleted_user_id = ANY(?::int[])', [users]],
      ['media_files', 'user_id = ANY(?::int[])', [users]],
      ['notification_preferences', 'user_id = ANY(?::int[])', [users]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [users]],
      ['trusted_devices', 'user_id = ANY(?::int[])', [users]],
      ['verification_codes', 'user_id = ANY(?::int[])', [users]],
      ...(queueExists ? [['pending_auth_deletions', 'deleted_user_id = ANY(?::int[])', [users]]] : []),
    ];
    const counts = [];
    for (const [table, where, params] of steps) {
      const res = await tx.run(`DELETE FROM ${table} WHERE ${where}`, params);
      if (res.rowCount) counts.push(`${res.rowCount} ${table}`);
    }
    const fks = await tx.all(
      `SELECT cl.relname AS table_name, a.attname::text AS column_name, rc.relname AS ref_table
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_class rc ON rc.oid = con.confrelid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND cl.relnamespace = 'public'::regnamespace
         AND con.confrelid IN ('public.users'::regclass, 'public.pets'::regclass)
         AND cl.relname NOT IN ('pets', 'users')`);
    const leftovers = [];
    for (const f of fks) {
      const ids = f.ref_table === 'users' ? users : pets;
      const row = await tx.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ANY(?::int[])`, [ids]);
      if (row.n) leftovers.push(`${f.table_name}.${f.column_name} (${row.n})`);
    }
    if (leftovers.length) throw new Error(`unexpected rows still reference the test accounts: ${leftovers.join(', ')}`);
    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} test users, ${petDel.rowCount} pets${counts.length ? `, ${counts.join(', ')}` : ''}`);
  });

  if (createdAuthIds.size) {
    if (!supabaseReady) throw new Error(`${createdAuthIds.size} Supabase identities to remove but SUPABASE_* is not set`);
    let removed = 0;
    for (const id of createdAuthIds) {
      const { error } = await getAdminClient().auth.admin.deleteUser(id);
      if (error && !(error.status === 404 || /not\s*found/i.test(error.message || ''))) {
        throw new Error(`could not delete Supabase identity ${id}: ${error.message}`);
      }
      removed++;
    }
    console.log(`  Supabase: removed ${removed} test identit${removed === 1 ? 'y' : 'ies'}`);
  }
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Backend under test: ${API_BASE}`);
  console.log(`Creates throwaway users acct-test-${stamp}-{u1,u2,u3,adm}@example.invalid, runs the tests, then deletes them.`);
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
  const created = [];
  try {
    await runTests(created);
  } catch (err) {
    failed++;
    console.error(`\nTest run stopped early: ${err.stack || err.message}`);
  } finally {
    try {
      await cleanup(created);
    } catch (err) {
      failed++;
      console.error(`\nCLEANUP FAILED (rolled back): ${err.message}\n  Remove users ${created.map(u => `#${u.id}`).join(', ')} by hand.`);
    } finally {
      await getDb().end();
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
