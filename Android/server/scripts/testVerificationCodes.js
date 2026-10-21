// Integration test for services/verificationCodes.js against the database in
// server/.env (currently production -- no real users yet).
//
// Creates ONE throwaway user with an obviously fake email and no pets, runs
// the checks, then deletes exactly the rows it created -- even if a test
// fails. Never touches user 1 or any admin account.
//
//   node scripts/testVerificationCodes.js
import readline from 'readline/promises';
import '../config.js'; // loads server/.env (and refuses to run without CODE_PEPPER)
import { initDb, getDb, dbAdapter as db, withTransaction } from '../db/connection.js';
import {
  issueCode, checkCode, VerificationCodeError,
  MAX_ATTEMPTS, MAX_CODES_PER_HOUR, CODE_TTL_SECONDS,
} from '../services/verificationCodes.js';

const PURPOSE = 'delete_account';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const TEST_EMAIL = `vc-test-${stamp}@example.invalid`;
const TEST_USERNAME = `vctest_${stamp}`;

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
const codeRow = id => db.get('SELECT * FROM verification_codes WHERE id = ?', [id]);
const wrongCodeFor = code => (code === '000000' ? '111111' : '000000');

// Every write this script makes goes through a user that must be the
// throwaway account created below -- never user 1, never an admin.
async function assertSafeTarget(userId) {
  const u = await db.get('SELECT id, email, is_admin FROM users WHERE id = ?', [userId]);
  if (!u || u.id === PROTECTED_USER_ID || u.is_admin || u.email !== TEST_EMAIL) {
    throw new Error(`Refusing to touch user #${userId}: not the throwaway test account.`);
  }
}

async function createTestUser() {
  const row = await db.get(
    `INSERT INTO users (email, username, password_hash, full_name)
     VALUES (?, ?, ?, ?) RETURNING id`,
    [TEST_EMAIL, TEST_USERNAME, '!test-account-cannot-log-in', 'Verification Code Test']
  );
  return row.id;
}

async function runTests(userId) {
  section('No code yet');
  let r = await checkCode(db, userId, PURPOSE, '123456');
  check('checkCode before any code -> NO_ACTIVE_CODE', r.status === 'NO_ACTIVE_CODE', JSON.stringify(r));

  section('Correct code');
  const a = await issueCode(userId, PURPOSE);
  check('code is 6 digits', /^\d{6}$/.test(a.code), a.code);
  check(`expiresInSeconds = ${CODE_TTL_SECONDS}`, a.expiresInSeconds === CODE_TTL_SECONDS, a.expiresInSeconds);
  let rowA = await codeRow(a.codeId);
  check('stored value is a 64-char hash, not the code', /^[0-9a-f]{64}$/.test(rowA.code_hash) && rowA.code_hash !== a.code);
  const ttl = (new Date(rowA.expires_at) - new Date(rowA.created_at)) / 1000;
  check('row expires 10 minutes after creation', Math.abs(ttl - CODE_TTL_SECONDS) < 2, ttl);
  r = await checkCode(db, userId, PURPOSE, a.code);
  check('correct code -> OK with its codeId', r.status === 'OK' && r.codeId === a.codeId, JSON.stringify(r));
  r = await checkCode(db, userId, PURPOSE, a.code);
  check('second check still OK (checkCode does not consume)', r.status === 'OK', JSON.stringify(r));
  rowA = await codeRow(a.codeId);
  check('row not consumed, attempts still 0', rowA.consumed_at === null && rowA.attempts === 0, `attempts=${rowA.attempts}`);

  section('Wrong code: attempts count down, 5th invalidates');
  const wrong = wrongCodeFor(a.code);
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    r = await checkCode(db, userId, PURPOSE, wrong);
    check(`wrong attempt ${i} -> INVALID_CODE, ${MAX_ATTEMPTS - i} left`,
      r.status === 'INVALID_CODE' && r.attemptsRemaining === MAX_ATTEMPTS - i, JSON.stringify(r));
  }
  r = await checkCode(db, userId, PURPOSE, wrong);
  check(`wrong attempt ${MAX_ATTEMPTS} -> TOO_MANY_ATTEMPTS`, r.status === 'TOO_MANY_ATTEMPTS', JSON.stringify(r));
  rowA = await codeRow(a.codeId);
  check(`row invalidated with attempts = ${MAX_ATTEMPTS}`,
    rowA.invalidated_at !== null && rowA.attempts === MAX_ATTEMPTS, `attempts=${rowA.attempts}`);
  r = await checkCode(db, userId, PURPOSE, a.code);
  check('correct code after lockout -> still TOO_MANY_ATTEMPTS', r.status === 'TOO_MANY_ATTEMPTS', JSON.stringify(r));

  // Move this user's codes out of the rolling hour so the next sections
  // start with an empty quota.
  await assertSafeTarget(userId);
  await db.run("UPDATE verification_codes SET created_at = created_at - INTERVAL '2 hours' WHERE user_id = ?", [userId]);

  section('Expiry');
  const b = await issueCode(userId, PURPOSE);
  await assertSafeTarget(userId);
  await db.run("UPDATE verification_codes SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ? AND user_id = ?", [b.codeId, userId]);
  r = await checkCode(db, userId, PURPOSE, b.code);
  check('correct but expired code -> CODE_EXPIRED', r.status === 'CODE_EXPIRED', JSON.stringify(r));
  check('expired check did not count an attempt', (await codeRow(b.codeId)).attempts === 0);

  section('A new code invalidates the old one');
  const c = await issueCode(userId, PURPOSE);
  const d = await issueCode(userId, PURPOSE);
  check('older code row is invalidated', (await codeRow(c.codeId)).invalidated_at !== null);
  if (c.code !== d.code) {
    r = await checkCode(db, userId, PURPOSE, c.code);
    check('old code no longer accepted -> INVALID_CODE', r.status === 'INVALID_CODE', JSON.stringify(r));
  } else {
    console.log('  SKIP  old and new code are identical by chance');
  }
  r = await checkCode(db, userId, PURPOSE, d.code);
  check('new code accepted -> OK', r.status === 'OK' && r.codeId === d.codeId, JSON.stringify(r));

  section(`Hourly cap (${MAX_CODES_PER_HOUR} per rolling hour)`);
  const inWindow = await db.get(
    "SELECT count(*)::int AS n FROM verification_codes WHERE user_id = ? AND created_at > NOW() - INTERVAL '1 hour'", [userId]);
  check(`${MAX_CODES_PER_HOUR} codes already sent this hour`, inWindow.n === MAX_CODES_PER_HOUR, inWindow.n);
  let err = null;
  try { await issueCode(userId, PURPOSE); } catch (e) { err = e; }
  check(`code #${MAX_CODES_PER_HOUR + 1} -> RATE_LIMITED`,
    err instanceof VerificationCodeError && err.code === 'RATE_LIMITED', err ? `${err.code}: ${err.message}` : 'no error');
  check('retryAfterSeconds between 1 and 3600',
    !!err && err.retryAfterSeconds >= 1 && err.retryAfterSeconds <= 3600, err?.retryAfterSeconds);
  const live = await db.get(
    'SELECT count(*)::int AS n FROM verification_codes WHERE user_id = ? AND consumed_at IS NULL AND invalidated_at IS NULL', [userId]);
  check('rate-limited request created nothing and left the current code live',
    live.n === 1 && (await codeRow(d.codeId)).invalidated_at === null, `live codes=${live.n}`);

  section('Input validation');
  err = null;
  try { await issueCode(userId, 'bogus'); } catch (e) { err = e; }
  check('unknown purpose rejected', err?.code === 'INVALID_PURPOSE', err?.code);
}

// Any other row pointing at the test user would be something this script
// didn't create -- in that case leave everything for a manual look.
async function otherReferences(userId) {
  const fks = await db.all(
    `SELECT cl.relname AS table_name, a.attname::text AS column_name
     FROM pg_constraint con
     JOIN pg_class cl ON cl.oid = con.conrelid
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     WHERE con.contype = 'f' AND con.confrelid = 'public.users'::regclass
       AND cl.relnamespace = 'public'::regnamespace AND cl.relname <> 'verification_codes'`);
  const hits = [];
  for (const f of fks) {
    const row = await db.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ?`, [userId]);
    if (row.n) hits.push(`${f.table_name}.${f.column_name} (${row.n})`);
  }
  return hits;
}

async function cleanup(userId) {
  if (!userId) return;
  section('Cleanup');
  const u = await db.get('SELECT id, email, is_admin FROM users WHERE id = ?', [userId]);
  if (!u) {
    console.log('  test user already gone');
    return;
  }
  await assertSafeTarget(userId);
  const others = await otherReferences(userId);
  if (others.length) {
    throw new Error(`test user #${userId} is referenced by rows this script didn't create: ${others.join(', ')}`);
  }
  await withTransaction(async tx => {
    const codes = await tx.run('DELETE FROM verification_codes WHERE user_id = ?', [userId]);
    const users = await tx.run(
      'DELETE FROM users WHERE id = ? AND email = ? AND NOT is_admin AND id <> ?', [userId, TEST_EMAIL, PROTECTED_USER_ID]);
    if (users.rowCount !== 1) throw new Error(`expected to delete 1 user row, deleted ${users.rowCount}`);
    console.log(`  deleted ${codes.rowCount} verification_codes row(s) and test user #${userId} (${TEST_EMAIL})`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Creates one throwaway user (${TEST_EMAIL}), runs the tests, then deletes it.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "production" to continue: ');
  rl.close();
  if (answer.trim() !== 'production') {
    console.log('Aborted -- nothing was done.');
    return;
  }

  await initDb();
  let userId = null;
  try {
    userId = await createTestUser();
    console.log(`Created test user #${userId}`);
    await assertSafeTarget(userId);
    await runTests(userId);
  } catch (err) {
    failed++;
    console.error(`\nTest run stopped early: ${err.stack || err.message}`);
  } finally {
    try {
      await cleanup(userId);
    } catch (err) {
      failed++;
      console.error(`\nCLEANUP FAILED: ${err.message}\n  Remove user #${userId} (${TEST_EMAIL}) and its verification_codes by hand.`);
    }
    await getDb().end();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
