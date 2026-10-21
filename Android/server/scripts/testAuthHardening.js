// Integration test for the deleted-account (tombstone) auth hardening and the
// reserved "SniffedOut" names. Talks to the LOCAL backend over HTTP (start it
// first with `npm run dev`), which uses the same database as this script --
// currently production, no real users yet.
//
// Creates TWO throwaway users (fake emails, no pets): the test user, which it
// logs in, runs the reserved-name checks with, tombstones by setting
// deleted_at and runs the deleted-account checks against; and a live control
// user that forgot-password answers are compared with. Then deletes exactly
// what the test created -- even if a check fails. Never touches user 1 or any
// admin account.
//
// Forgot password answers every identifier with the same generic 200 (no
// account enumeration), so the deleted-account checks compare the response
// with a live account's, check the database for a reset token, and call the
// route handler in-process to watch for the reset email (the mailer logs a
// line for every send, including skipped @example.invalid ones).
//
//   node scripts/testAuthHardening.js
import readline from 'readline/promises';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import { initDb, getDb, dbAdapter as db, withTransaction } from '../db/connection.js';
import { authenticateSocket, signPurposeToken } from '../middleware/auth.js';
import { isReservedName } from '../utils/reservedNames.js';
import authRouter from '../routes/auth.js';
import { testPetUsername } from './lib/testIds.js';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const TEST_EMAIL = `ah-test-${stamp}@example.invalid`;
const TEST_USERNAME = `ahtest_${stamp}`;
const TEST_PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
// Would only ever be created if a reserved-name check wrongly let a signup through.
const SIGNUP_EMAIL = `ah-test-${stamp}-signup@example.invalid`;
const SOCIAL_EMAIL = `ah-test-${stamp}-social@example.invalid`;
// Live control account for the forgot-password comparisons.
const LIVE_EMAIL = `ah-test-${stamp}-live@example.invalid`;
const LIVE_USERNAME = `ahlive_${stamp}`;
// Never created: forgot password for an identifier with no account at all.
const NOBODY_EMAIL = `ah-test-${stamp}-nobody@example.invalid`;
// Subject of the reset email (utils/mailer.js); sendEmail logs it on every
// send, and on the skip for reserved test domains such as @example.invalid.
const RESET_EMAIL_SUBJECT = 'Reset Your Sniffr Password';
// Rows the running app may create for the test user (login, reminders...),
// plus its fixture pet (deleted last).
const ALLOWED_CHILD_TABLES = ['refresh_tokens', 'notifications', 'notification_preferences', 'trusted_devices', 'verification_codes', 'plan_history', 'pets'];

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
const show = r => `${r.status} ${JSON.stringify(r.data)}`;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const socketAuth = token => new Promise(resolve =>
  authenticateSocket({ handshake: { auth: { token } } }, err => resolve(err || null)));

async function assertSafeTarget(userId, email) {
  const u = await db.get('SELECT id, email, is_admin FROM users WHERE id = ?', [userId]);
  if (!u || u.id === PROTECTED_USER_ID || u.is_admin || u.email !== email) {
    throw new Error(`Refusing to touch user #${userId}: not a throwaway test account.`);
  }
}

async function createTestUser(email = TEST_EMAIL, username = TEST_USERNAME, fullName = 'Auth Hardening Test') {
  const hash = await bcrypt.hash(TEST_PASSWORD, 10);
  // email_verified = 1 so /me doesn't queue a "verify your email" reminder.
  const row = await db.get(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`,
    [email, username, hash, fullName]
  );
  return row.id;
}

// Runs the real POST /forgot-password handler in this process (no HTTP, no
// rate limiter) and records everything it logs. Captured lines are never
// printed: in development without SMTP they include the reset link.
async function forgotPasswordInProcess(identifier) {
  const layer = authRouter.stack.find(l => l.route?.path === '/forgot-password' && l.route.methods.post);
  if (!layer) throw new Error('POST /forgot-password not found on the auth router');
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const lines = [];
  const originals = {};
  for (const level of ['log', 'info', 'warn', 'error']) {
    originals[level] = console[level];
    console[level] = (...args) => { lines.push(args.map(String).join(' ')); };
  }
  try {
    const result = await new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        set() { return this; },
        json(data) { resolve({ status: this.statusCode, data }); return this; },
      };
      Promise.resolve(handler({ body: { identifier }, ip: '127.0.0.1', headers: {}, get: () => undefined }, res, reject)).catch(reject);
    });
    const resetEmail = lines.some(l => l.includes(RESET_EMAIL_SUBJECT) || l.includes('password reset link'));
    return { ...result, resetEmail, lineCount: lines.length };
  } finally {
    Object.assign(console, originals);
  }
}

async function runTests(userId, liveId) {
  section('Live account');
  const login = await call('POST', '/api/auth/login', { body: { email: TEST_EMAIL, password: TEST_PASSWORD } });
  check('login by email succeeds', login.status === 200 && !!login.data.accessToken, show(login));
  const { accessToken, refreshToken } = login.data;
  const me = await call('GET', '/api/auth/me', { token: accessToken });
  check('GET /auth/me works with the access token', me.status === 200 && me.data.user?.id === userId, show(me));
  check('socket auth accepts the access token', (await socketAuth(accessToken)) === null);

  section('Reserved names');
  for (const v of ['SniffedOut', 'sniffed_out', 'Sniffed.Out', 'Sniffed Out', '@SNIFFED-OUT']) {
    check(`isReservedName("${v}") is true`, isReservedName(v));
  }
  for (const v of ['SniffedOutFan', 'Sniffer', 'Out']) {
    check(`isReservedName("${v}") is false`, !isReservedName(v));
  }
  for (const username of ['SniffedOut', 'sniffed_out', 'SNIFFEDOUT']) {
    const r = await call('POST', '/api/auth/signup', {
      body: { full_name: 'Reserved Test', username, email: SIGNUP_EMAIL, password: 'Aa1!aaaa', confirmPassword: 'Aa1!aaaa' },
    });
    const usernameError = r.data.errors?.find(e => e.field === 'username');
    check(`signup with username "${username}" -> 400, reserved`,
      r.status === 400 && /reserved/i.test(usernameError?.message || ''), show(r));
  }
  // social-complete takes the email only from the ticket /auth/google issues
  // after verifying Google; minted here the same way.
  const signupTicket = signPurposeToken('google_signup', { email: SOCIAL_EMAIL, name: 'Reserved Test' }, '30m');
  const social = await call('POST', '/api/auth/social-complete', { body: { signupTicket, username: 'Sniffed.Out' } });
  check('social-complete with username "Sniffed.Out" -> 400 RESERVED_NAME',
    social.status === 400 && social.data.error === 'RESERVED_NAME', show(social));
  const stray = await db.get('SELECT count(*)::int AS n FROM users WHERE email IN (?, ?)', [SIGNUP_EMAIL, SOCIAL_EMAIL]);
  check('no account was created by the rejected signups', stray.n === 0, stray.n);

  // A real pet first: editing a pet needs one (no pet -> 403 NO_PET), and
  // the rename check below must reach the reserved-name rule.
  const fixturePetName = `Ahpet${stamp}`;
  const fixturePet = await call('POST', '/api/profile', {
    token: accessToken, body: { name: fixturePetName, pet_username: testPetUsername('ahpet'), type: 'dog' },
  });
  if (fixturePet.status !== 201 || !fixturePet.data.id) throw new Error(`fixture pet failed: ${show(fixturePet)}`);

  let r = await call('POST', '/api/profile', { token: accessToken, body: { name: 'Sniffed Out' } });
  check('create pet named "Sniffed Out" -> 400 RESERVED_NAME (name)',
    r.status === 400 && r.data.error === 'RESERVED_NAME' && r.data.field === 'name', show(r));
  r = await call('POST', '/api/profile', { token: accessToken, body: { name: 'Rex', pet_username: 'sniffed.out' } });
  check('create pet with pet username "sniffed.out" -> 400 RESERVED_NAME (pet_username)',
    r.status === 400 && r.data.error === 'RESERVED_NAME' && r.data.field === 'pet_username', show(r));
  r = await call('PUT', '/api/profile', { token: accessToken, body: { name: 'SNIFFEDOUT' } });
  check('edit pet name to "SNIFFEDOUT" -> 400 RESERVED_NAME, name unchanged',
    r.status === 400 && r.data.error === 'RESERVED_NAME'
      && (await db.get('SELECT name FROM pets WHERE id = ?', [fixturePet.data.id]))?.name === fixturePetName, show(r));
  const pets = await db.get('SELECT count(*)::int AS n FROM pets WHERE user_id = ?', [userId]);
  check('the rejected pet creations added no pet (only the fixture pet)', pets.n === 1, pets.n);

  section('Tombstone the account (deleted_at = NOW())');
  await assertSafeTarget(userId, TEST_EMAIL);
  await db.run('UPDATE users SET deleted_at = NOW() WHERE id = ? AND email = ?', [userId, TEST_EMAIL]);

  r = await call('GET', '/api/auth/me', { token: accessToken });
  check('old access token on /auth/me -> 401 ACCOUNT_DELETED', r.status === 401 && r.data.error === 'ACCOUNT_DELETED', show(r));
  r = await call('GET', '/api/communities', { token: accessToken });
  check('old access token on another router (/communities) -> 401 ACCOUNT_DELETED',
    r.status === 401 && r.data.error === 'ACCOUNT_DELETED', show(r));
  const sockErr = await socketAuth(accessToken);
  check('socket auth rejects the old access token', sockErr?.message === 'Account deleted', sockErr?.message ?? 'accepted');
  r = await call('POST', '/api/auth/refresh', { body: { refreshToken } });
  check('refresh token -> 401 ACCOUNT_DELETED (no new tokens)',
    r.status === 401 && r.data.error === 'ACCOUNT_DELETED' && !r.data.accessToken, show(r));

  r = await call('POST', '/api/auth/login', { body: { email: TEST_EMAIL, password: TEST_PASSWORD } });
  check('login by email fails', r.status === 401 && !r.data.accessToken, show(r));
  r = await call('POST', '/api/auth/login', { body: { username: TEST_USERNAME, password: TEST_PASSWORD } });
  check('login by username fails', r.status === 401 && !r.data.accessToken, show(r));
  r = await call('POST', '/api/auth/google', { body: { email: TEST_EMAIL } });
  check('Google sign-in with the same email does not log in', !r.data.accessToken, show(r));

  section('Forgot password: same answer as a live account, nothing issued');
  const liveReset = await call('POST', '/api/auth/forgot-password', { body: { identifier: LIVE_EMAIL } });
  check('forgot password for the live control account -> 200 with a message',
    liveReset.status === 200 && typeof liveReset.data.message === 'string' && !liveReset.data.error, show(liveReset));
  const live = await db.get('SELECT reset_token, reset_token_expires_at FROM users WHERE id = ?', [liveId]);
  check('the live control account got a reset token (the route does issue them)',
    !!live.reset_token && !!live.reset_token_expires_at, JSON.stringify({ token: !!live.reset_token, expires: live.reset_token_expires_at }));
  const sameAsLive = x => x.status === liveReset.status && JSON.stringify(x.data) === JSON.stringify(liveReset.data);
  r = await call('POST', '/api/auth/forgot-password', { body: { identifier: TEST_EMAIL } });
  check('forgot password by email for the deleted account -> same 200 and message as the live account', sameAsLive(r), show(r));
  r = await call('POST', '/api/auth/forgot-password', { body: { identifier: TEST_USERNAME } });
  check('forgot password by username for the deleted account -> same 200 and message as the live account', sameAsLive(r), show(r));
  r = await call('POST', '/api/auth/forgot-password', { body: { identifier: NOBODY_EMAIL } });
  check('forgot password for an email with no account -> the same response too', sameAsLive(r), show(r));

  // The backend under test runs in another process, so its mailer can't be
  // watched over HTTP; run the same route handler here and watch its logs.
  section('Forgot password in-process: no reset email for the deleted account');
  let ip = await forgotPasswordInProcess(LIVE_EMAIL);
  check('live control account: the handler sends a reset email (proves the capture sees it)',
    ip.status === 200 && ip.resetEmail, `${ip.status}, reset email: ${ip.resetEmail}`);
  for (const identifier of [TEST_EMAIL, TEST_USERNAME]) {
    ip = await forgotPasswordInProcess(identifier);
    check(`deleted account by ${identifier === TEST_EMAIL ? 'email' : 'username'}: same 200, no reset email sent`,
      sameAsLive(ip) && !ip.resetEmail, `${show(ip)}, reset email: ${ip.resetEmail}, ${ip.lineCount} log line(s)`);
  }

  // Minted exactly as /auth/login does after a correct password.
  const tempToken = signPurposeToken('2fa_login', { id: userId }, '10m');
  r = await call('POST', '/api/auth/2fa/verify-login', { body: { tempToken, code: '000000' } });
  check('2FA verify-login -> 401 ACCOUNT_DELETED', r.status === 401 && r.data.error === 'ACCOUNT_DELETED', show(r));
  r = await call('POST', '/api/auth/2fa/resend-code', { body: { tempToken } });
  check('2FA resend-code -> 401 ACCOUNT_DELETED', r.status === 401 && r.data.error === 'ACCOUNT_DELETED', show(r));

  const after = await db.get('SELECT reset_token, reset_token_expires_at, paw_code FROM users WHERE id = ?', [userId]);
  check('deleted account: no reset token and no 2FA code were written',
    after.reset_token === null && after.reset_token_expires_at === null && after.paw_code === null,
    JSON.stringify({ reset_token: after.reset_token && 'set', reset_token_expires_at: after.reset_token_expires_at, paw_code: after.paw_code && 'set' }));
}

// Any row pointing at a throwaway user outside ALLOWED_CHILD_TABLES would be
// something unexpected -- leave everything for a manual look.
async function unexpectedReferences(tx, userId) {
  const fks = await tx.all(
    `SELECT cl.relname AS table_name, a.attname::text AS column_name
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f' AND con.confrelid = 'public.users'::regclass
       AND cl.relnamespace = 'public'::regnamespace`);
  const hits = [];
  for (const f of fks.filter(f => !ALLOWED_CHILD_TABLES.includes(f.table_name))) {
    const row = await tx.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ?`, [userId]);
    if (row.n) hits.push(`${f.table_name}.${f.column_name} (${row.n})`);
  }
  return hits;
}

async function deleteThrowaway(userId, email) {
  await withTransaction(async tx => {
    const u = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!u) return;
    if (u.id === PROTECTED_USER_ID || u.is_admin || u.email !== email) {
      throw new Error(`Refusing to delete user #${userId}: not a throwaway test account.`);
    }
    const others = await unexpectedReferences(tx, userId);
    if (others.length) throw new Error(`user #${userId} is referenced by unexpected rows: ${others.join(', ')}`);
    const counts = [];
    for (const table of ALLOWED_CHILD_TABLES) {
      const res = await tx.run(`DELETE FROM public."${table}" WHERE user_id = ?`, [userId]);
      if (res.rowCount) counts.push(`${res.rowCount} ${table}`);
    }
    const del = await tx.run('DELETE FROM users WHERE id = ? AND email = ? AND NOT is_admin AND id <> ?',
      [userId, email, PROTECTED_USER_ID]);
    if (del.rowCount !== 1) throw new Error(`expected to delete 1 user row, deleted ${del.rowCount}`);
    console.log(`  deleted user #${userId} (${email})${counts.length ? ` and ${counts.join(', ')}` : ''}`);
  });
}

async function cleanup(userId, liveId) {
  section('Cleanup');
  const targets = [];
  if (userId) targets.push([userId, TEST_EMAIL]);
  if (liveId) targets.push([liveId, LIVE_EMAIL]);
  // Accounts a broken reserved-name check might have let through.
  const strays = await db.all('SELECT id, email FROM users WHERE email IN (?, ?)', [SIGNUP_EMAIL, SOCIAL_EMAIL]);
  for (const s of strays) targets.push([s.id, s.email]);
  let ok = true;
  for (const [id, email] of targets) {
    try {
      await deleteThrowaway(id, email);
    } catch (err) {
      ok = false;
      failed++;
      console.error(`  CLEANUP FAILED for user #${id} (${email}): ${err.message} -- remove it by hand.`);
    }
  }
  if (ok && !targets.length) console.log('  nothing to clean up');
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Backend under test: ${API_BASE}`);
  console.log(`Creates two throwaway users (${TEST_EMAIL}, ${LIVE_EMAIL}), runs the tests, then deletes them.`);
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
  let userId = null;
  let liveId = null;
  try {
    userId = await createTestUser();
    console.log(`Created test user #${userId}`);
    await assertSafeTarget(userId, TEST_EMAIL);
    liveId = await createTestUser(LIVE_EMAIL, LIVE_USERNAME, 'Auth Hardening Live Control');
    console.log(`Created live control user #${liveId}`);
    await assertSafeTarget(liveId, LIVE_EMAIL);
    await runTests(userId, liveId);
  } catch (err) {
    failed++;
    console.error(`\nTest run stopped early: ${err.stack || err.message}`);
  } finally {
    try {
      await cleanup(userId, liveId);
    } finally {
      await getDb().end();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

// Explicit exit: routes/auth.js loads the rate limiter, whose cleanup
// interval would otherwise keep the process alive.
main().then(() => process.exit()).catch(err => {
  console.error(err);
  process.exit(1);
});
