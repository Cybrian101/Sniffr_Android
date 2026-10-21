// Integration test for the PUBLIC (not signed in) account deletion used by
// the landing page, POST /api/account/public/delete/request-code and
// /confirm, against your running backend (`npm run dev` on :3001) and the
// database in server/.env (production, no real users yet).
//
// Throwaway users on the reserved .invalid domain (the mailer never sends to
// it). The test can't read the emailed code, so it issues its own in-process
// (which invalidates the emailed one) and uses that over HTTP.
//
// Per-IP limits: every section sends its own made-up X-Forwarded-For address
// (random per run). The server trusts one proxy hop (index.js), so locally
// that address is the client IP: each run and section starts with clean
// per-IP counters, and the in-memory failed-lookup block (1 hour) from one
// run can't affect the next. On Render the proxy appends the real address,
// so clients can't pick their own there.
//
// Cleanup deletes everything created, even if a check fails. Never touches
// user 1.
//
//   node scripts/testPublicDeletion.js
import readline from 'readline/promises';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import { initDb, getDb, dbAdapter as db, withTransaction } from '../db/connection.js';
import { issueCode } from '../services/verificationCodes.js';
import { deleteUserAccount } from '../services/accountDeletion.js';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `pubdel-test-${stamp}-${key}@example.invalid`, username: `pubdel${key}_${stamp}` });
const A = mk('a');     // lookups by email; the per-account code limit
const B = mk('b');     // lookups by username; deleted by username
const C = mk('c');     // successful lookups in between failed ones
const D = mk('d');     // already SniffedOut
const E = mk('e');     // wrong / expired / locked codes
const X = mk('x');     // owns the code ...
const Y = mk('y');     // ... that must not work with Y's identifier
const ADM = mk('adm'); // throwaway admin
const PHRASE = 'DELETE ACCOUNT';
const LANDING_ORIGINS = ['https://sniffrweb.com', 'https://www.sniffrweb.com'];

const ipBase = `10.${crypto.randomInt(1, 255)}.${crypto.randomInt(1, 255)}`;
let ipCounter = 0;
const newIp = () => `${ipBase}.${++ipCounter}`;

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

async function call(method, path, { ip, body, headers = {} } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'X-Forwarded-For': ip } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data, headers: res.headers };
}
const requestCode = (ip, identifier) => call('POST', '/api/account/public/delete/request-code', { ip, body: { identifier } });
const confirm = (ip, identifier, code, confirmation = PHRASE) =>
  call('POST', '/api/account/public/delete/confirm', { ip, body: { identifier, code, confirmation } });
const is = (r, status, error) => r.status === status && r.data?.error === error;
const latestCode = userId => one(
  "SELECT id, attempts, consumed_at, invalidated_at FROM verification_codes WHERE user_id = ? AND purpose = 'delete_account' ORDER BY id DESC LIMIT 1",
  [userId]);
const codeCount = userId => one("SELECT count(*)::int AS n FROM verification_codes WHERE user_id = ? AND purpose = 'delete_account'", [userId]).then(r => r.n);
const isDeleted = async userId => !!(await one('SELECT deleted_at FROM users WHERE id = ?', [userId]))?.deleted_at;
const upperLocal = email => { const [n, d] = email.split('@'); return `${n.toUpperCase()}@${d}`; };

async function createUser(spec, created, admin = false) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified, is_admin)
     VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
    [spec.email, spec.username, hash, `Public Deletion Test ${spec.key}`, admin]);
  spec.userId = row.id;
  created.push({ id: row.id, email: spec.email });
}

async function runTests(created) {
  section('Setup');
  for (const spec of [A, B, C, D, E, X, Y]) await createUser(spec, created);
  await createUser(ADM, created, true);
  await deleteUserAccount(D.userId, { skipCode: true });
  check('D is SniffedOut before the test starts', await isDeleted(D.userId));
  console.log(`  users #${created.map(u => u.id).join(', #')}; per-IP addresses ${ipBase}.N`);

  section('CORS for the landing page');
  for (const origin of LANDING_ORIGINS) {
    const pre = await call('OPTIONS', '/api/account/public/delete/request-code', {
      headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    const allowed = pre.headers.get('access-control-allow-origin');
    check(`preflight from ${origin} -> 204, origin allowed`, pre.status === 204 && (allowed === origin || allowed === '*'), `${pre.status} ${allowed}`);
  }
  let r = await call('POST', '/api/account/public/delete/request-code', { ip: newIp(), body: {}, headers: { Origin: LANDING_ORIGINS[0] } });
  const allowedOnPost = r.headers.get('access-control-allow-origin');
  check('POST response carries Access-Control-Allow-Origin for sniffrweb.com',
    allowedOnPost === LANDING_ORIGINS[0] || allowedOnPost === '*', String(allowedOnPost));
  check('missing identifier -> 400 MISSING_IDENTIFIER', is(r, 400, 'MISSING_IDENTIFIER'), show(r));
  if (config.CORS_ORIGINS !== '*') {
    const pre = await call('OPTIONS', '/api/account/public/delete/request-code', {
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    check('preflight from an unrelated origin is not allowed', !pre.headers.get('access-control-allow-origin'), pre.headers.get('access-control-allow-origin'));
  }

  section('request-code: lookups that match');
  const ipLookup = newIp();
  r = await requestCode(ipLookup, A.email);
  check('by email -> 200 "Code sent to your registered email", 10-minute expiry',
    r.status === 200 && r.data.success === true && r.data.message === 'Code sent to your registered email' && r.data.expiresInSeconds === 600, show(r));
  check('response shows no email (masked or not) and no code',
    !JSON.stringify(r.data).includes('@') && !('maskedEmail' in r.data) && !JSON.stringify(r.data).match(/\b\d{6}\b/), show(r));
  check('a live code row was issued for A', !!(await latestCode(A.userId)) && !(await latestCode(A.userId)).invalidated_at);
  r = await requestCode(ipLookup, `  ${upperLocal(A.email)}  `);
  check('by email, different case and padded with spaces -> 200', r.status === 200 && (await codeCount(A.userId)) === 2, show(r));
  r = await requestCode(ipLookup, B.username);
  check('by username -> 200', r.status === 200 && (await codeCount(B.userId)) === 1, show(r));
  r = await requestCode(ipLookup, B.username.toUpperCase());
  check('by username, different case -> 200', r.status === 200 && (await codeCount(B.userId)) === 2, show(r));
  r = await requestCode(ipLookup, ADM.email);
  check('admin -> 403 ADMIN_CANNOT_SELF_DELETE, no code issued', is(r, 403, 'ADMIN_CANNOT_SELF_DELETE') && (await codeCount(ADM.userId)) === 0, show(r));
  r = await requestCode(ipLookup, A.email);
  check("A's 3rd code within the hour -> 200", r.status === 200, show(r));
  r = await requestCode(ipLookup, A.email);
  check("A's 4th code within the hour -> 429 RATE_LIMITED with retryAfterSeconds (per-account limit)",
    is(r, 429, 'RATE_LIMITED') && r.data.retryAfterSeconds >= 1 && r.data.retryAfterSeconds <= 3600 && (await codeCount(A.userId)) === 3, show(r));
  r = await requestCode(newIp(), A.email);
  check('...also from another IP (the limit is the account\'s)', is(r, 429, 'RATE_LIMITED'), show(r));

  section('request-code: failed lookups, 3 per IP per hour (successes do not count)');
  const ipFail = newIp();
  r = await requestCode(ipFail, `nobody-${stamp}@example.invalid`);
  check('unknown email -> 404 ACCOUNT_NOT_FOUND (failure 1)', is(r, 404, 'ACCOUNT_NOT_FOUND')
    && r.data.message === "We couldn't sniff out that account. Please check your details.", show(r));
  r = await requestCode(ipFail, C.email);
  check('a match in between -> 200 (not counted)', r.status === 200, show(r));
  r = await requestCode(ipFail, D.email);
  check("SniffedOut account's old email -> 404 ACCOUNT_NOT_FOUND (failure 2)", is(r, 404, 'ACCOUNT_NOT_FOUND'), show(r));
  r = await requestCode(ipFail, C.username);
  check('another match in between -> 200 (not counted)', r.status === 200, show(r));
  r = await requestCode(ipFail, D.username);
  check("SniffedOut account's old username -> 404 (failure 3: the two matches didn't count)", is(r, 404, 'ACCOUNT_NOT_FOUND'), show(r));
  r = await requestCode(ipFail, `nobody2-${stamp}`);
  check('4th failed lookup within the hour -> 429 RATE_LIMITED, retry in about an hour',
    is(r, 429, 'RATE_LIMITED') && r.data.retryAfterSeconds > 3000 && r.data.retryAfterSeconds <= 3600, show(r));
  const cCodes = await codeCount(C.userId);
  r = await requestCode(ipFail, C.email);
  check('while blocked, even a real account -> 429 (no probing), no code issued',
    is(r, 429, 'RATE_LIMITED') && (await codeCount(C.userId)) === cCodes, show(r));
  r = await confirm(ipFail, C.email, '123456');
  check('...and confirm from the blocked IP -> 429 RATE_LIMITED', is(r, 429, 'RATE_LIMITED'), show(r));
  r = await requestCode(newIp(), `nobody3-${stamp}`);
  check('another IP is not blocked -> 404', is(r, 404, 'ACCOUNT_NOT_FOUND'), show(r));
  r = await confirm(newIp(), `nobody4-${stamp}@example.invalid`, '123456');
  check('confirm with an unknown identifier -> 404 ACCOUNT_NOT_FOUND', is(r, 404, 'ACCOUNT_NOT_FOUND'), show(r));
  r = await confirm(newIp(), D.email, '123456');
  check('confirm for a SniffedOut account -> 404 ACCOUNT_NOT_FOUND', is(r, 404, 'ACCOUNT_NOT_FOUND'), show(r));

  section('confirm: wrong, expired and locked codes (E)');
  let ip = newIp();
  const first = await issueCode(E.userId, 'delete_account');
  const wrong = first.code === '000000' ? '111111' : '000000';
  r = await confirm(ip, E.email, first.code, 'delete account');
  check('lowercase phrase -> 400 CONFIRMATION_MISMATCH, no attempt used',
    is(r, 400, 'CONFIRMATION_MISMATCH') && (await latestCode(E.userId))?.attempts === 0, show(r));
  for (let i = 1; i <= 4; i++) {
    r = await confirm(ip, E.email, wrong);
    check(`wrong code #${i} -> 400 INVALID_CODE, ${5 - i} attempts left`, is(r, 400, 'INVALID_CODE') && r.data.attemptsRemaining === 5 - i, show(r));
  }
  ip = newIp(); // the confirm route allows 10 per IP per minute
  r = await confirm(ip, E.username, wrong);
  check('wrong code #5 (by username) -> 429 TOO_MANY_ATTEMPTS', is(r, 429, 'TOO_MANY_ATTEMPTS'), show(r));
  r = await confirm(ip, E.email, first.code);
  check('correct code after lockout -> still 429 TOO_MANY_ATTEMPTS', is(r, 429, 'TOO_MANY_ATTEMPTS'), show(r));
  const second = await issueCode(E.userId, 'delete_account');
  await db.run("UPDATE verification_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ? AND user_id = ?", [second.codeId, E.userId]);
  r = await confirm(ip, E.email, second.code);
  check('correct but expired code -> 400 CODE_EXPIRED', is(r, 400, 'CODE_EXPIRED'), show(r));
  check('E was never deleted by any of that', !(await isDeleted(E.userId)));
  r = await confirm(ip, ADM.email, '123456');
  check('admin confirm -> 403 ADMIN_CANNOT_SELF_DELETE, not deleted', is(r, 403, 'ADMIN_CANNOT_SELF_DELETE') && !(await isDeleted(ADM.userId)), show(r));

  section("confirm: one account's code can't delete another (X and Y)");
  ip = newIp();
  const xCode = await issueCode(X.userId, 'delete_account');
  r = await confirm(ip, Y.email, xCode.code);
  check("Y's identifier + X's code (Y has no code) -> 400 NO_ACTIVE_CODE", is(r, 400, 'NO_ACTIVE_CODE'), show(r));
  await issueCode(Y.userId, 'delete_account');
  r = await confirm(ip, Y.username, xCode.code);
  check("Y's identifier + X's code (Y has its own code) -> 400 INVALID_CODE", is(r, 400, 'INVALID_CODE'), show(r));
  check('neither X nor Y deleted', !(await isDeleted(X.userId)) && !(await isDeleted(Y.userId)));
  const xRow = await one('SELECT attempts, consumed_at, invalidated_at FROM verification_codes WHERE id = ?', [xCode.codeId]);
  check("X's code untouched (no attempt used, still valid)", xRow.attempts === 0 && !xRow.consumed_at && !xRow.invalidated_at, JSON.stringify(xRow));

  section('confirm: success');
  r = await confirm(ip, upperLocal(X.email), xCode.code);
  check("X by email (different case) with X's own code -> 200 { success, mediaCleanup: 'complete' }",
    r.status === 200 && r.data.success === true && r.data.mediaCleanup === 'complete', show(r));
  let u = await one('SELECT email, username, deleted_at FROM users WHERE id = ?', [X.userId]);
  check('X is tombstoned', !!u?.deleted_at && u.email === `sniffedout~${X.userId}`, JSON.stringify(u));
  check('Y untouched', !(await isDeleted(Y.userId)));

  ip = newIp();
  const bCode = await issueCode(B.userId, 'delete_account');
  r = await confirm(ip, B.username.toUpperCase(), bCode.code);
  check('B by username (different case) -> 200', r.status === 200 && r.data.success === true, show(r));
  u = await one('SELECT username, deleted_at FROM users WHERE id = ?', [B.userId]);
  check('B is tombstoned', !!u?.deleted_at && u.username === `sniffedout~${B.userId}`, JSON.stringify(u));
  r = await confirm(ip, B.username, bCode.code);
  check('confirming B again -> 404 ACCOUNT_NOT_FOUND (it is SniffedOut now)', is(r, 404, 'ACCOUNT_NOT_FOUND'), show(r));
  r = await requestCode(newIp(), B.email);
  check("request-code for B's old email -> 404 ACCOUNT_NOT_FOUND", is(r, 404, 'ACCOUNT_NOT_FOUND'), show(r));

  section('confirm: per-IP limit');
  ip = newIp();
  let statuses = [];
  for (let i = 1; i <= 10; i++) statuses.push((await confirm(ip, E.email, '123456', 'nope')).status);
  check('10 confirms in a minute from one IP -> all answered (400 CONFIRMATION_MISMATCH)', statuses.every(s => s === 400), statuses.join(','));
  r = await confirm(ip, E.email, '123456', 'nope');
  check('11th within the minute -> 429 RATE_LIMIT', r.status === 429 && r.data.error === 'RATE_LIMIT', show(r));
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  if (!created.length) {
    console.log('  nothing to clean up');
    return;
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
    const queueExists = (await tx.get("SELECT to_regclass('public.pending_auth_deletions') IS NOT NULL AS ok")).ok;
    const steps = [
      ['notifications', 'user_id = ANY(?::int[])', [users]],
      ['plan_history', 'user_id = ANY(?::int[])', [users]],
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
      `SELECT cl.relname AS table_name, a.attname::text AS column_name
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND cl.relnamespace = 'public'::regnamespace
         AND con.confrelid = 'public.users'::regclass AND cl.relname <> 'users'`);
    const leftovers = [];
    for (const f of fks) {
      const row = await tx.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ANY(?::int[])`, [users]);
      if (row.n) leftovers.push(`${f.table_name}.${f.column_name} (${row.n})`);
    }
    if (leftovers.length) throw new Error(`unexpected rows still reference the test accounts: ${leftovers.join(', ')}`);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} test users${counts.length ? `, ${counts.join(', ')}` : ''}`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Backend under test: ${API_BASE}`);
  console.log(`Creates throwaway users pubdel-test-${stamp}-*@example.invalid, runs the tests, then deletes them.`);
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
