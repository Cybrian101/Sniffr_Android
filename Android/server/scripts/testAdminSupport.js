// Integration test for task 13 (admin payments for deleted accounts + the
// support deletion tool), against your running backend (`npm run dev` on
// :3001, restarted after task 13) and the database in server/.env
// (production, no real users yet).
//
// Throwaway users: an admin ADM, U (has a 'pending_review' payment, then is
// deleted the way scripts/deleteAccount.js does it) and V (a live user with
// a 'pending_review' payment, as a control). Checks:
//   - U's open socket gets account_deleted and is disconnected through the
//     support-tool hand-off (Postgres NOTIFY -> running server);
//   - the admin queue still shows U's payment, flagged account_deleted, with
//     amount/plan/date/transaction id/proof;
//   - approving it is refused (409 ACCOUNT_DELETED) and activates nothing;
//     subscribeToPlan() itself refuses a deleted account;
//   - rejecting it works, without notifying U;
//   - V's payment still approves normally;
//   - deleteAccount.js's guard refuses user 1, admins and deleted accounts
//     (called directly, no prompts).
// Cleanup removes every test row even if a check fails. Never touches user 1
// (its guard case uses a plain object, not the real row).
//
//   node scripts/testAdminSupport.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { deleteUserAccount } = await import('../services/accountDeletion.js');
const { afterAccountDeletion } = await import('../services/accountDeletionFollowUp.js');
const { subscribeToPlan } = await import('../services/subscriptionService.js');
const { deletionRefusal, loadUserSummary } = await import('./deleteAccount.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `support-test-${stamp}-${key}@example.invalid`, username: `sup${key}_${stamp}` });
const ADM = mk('adm');
const U = mk('u');
const V = mk('v');

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
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const get = (path, token) => call('GET', path, token);
const post = (path, token, body) => call('POST', path, token, body);
async function must(label, promise, ok = [200, 201]) {
  const r = await promise;
  if (!ok.includes(r.status)) throw new Error(`fixture step failed: ${label}: ${show(r)}`);
  return r.data;
}

function loadSocketClient() {
  try {
    const require = createRequire(new URL('../../client/package.json', import.meta.url));
    return require('socket.io-client').io;
  } catch {
    return null;
  }
}
const waitFor = (socket, event, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  socket.once(event, payload => { clearTimeout(timer); resolve(payload ?? true); });
});

async function createUser(spec, created, { admin = false, withPet = true } = {}) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified, is_admin)
     VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
    [spec.email, spec.username, hash, `Support Test ${spec.key.toUpperCase()}`, admin]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
  if (withPet) {
    spec.petId = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, { name: `Sup${spec.key.toUpperCase()}${stamp}`, pet_username: testPetUsername(`sup${spec.key}`), type: 'dog' }))).id;
  }
}

async function pendingSession(spec, tag) {
  return (await one(
    `INSERT INTO payment_sessions (user_id, plan, amount, provider, status, payment_method, upi_transaction_id, proof_url, submitted_at)
     VALUES (?, 'gold', 199, 'upi_manual', 'pending_review', 'upi', ?, ?, NOW()) RETURNING id`,
    [spec.userId, `SUPTEST${stamp}${tag}`, `https://example.invalid/support-test-${stamp}-${tag}.jpg`])).id;
}

async function runTests(created) {
  const ids = created.ids;
  section('Setup');
  await createUser(ADM, created, { admin: true, withPet: false });
  await createUser(U, created);
  await createUser(V, created);
  ids.sessionU = await pendingSession(U, 'u');
  ids.sessionV = await pendingSession(V, 'v');
  console.log(`  ADM #${ADM.userId} (admin), U #${U.userId}, V #${V.userId}; sessions U #${ids.sessionU}, V #${ids.sessionV}`);

  section('1. Support-tool deletion of U reaches live sessions');
  const ioClient = loadSocketClient();
  if (!ioClient) throw new Error('socket.io-client not found in client/node_modules');
  const socket = ioClient(API_BASE, { auth: { token: U.token }, transports: ['websocket'], reconnection: false });
  created.sockets.push(socket);
  const connected = await Promise.race([
    new Promise(res => socket.once('connect', () => res(true))),
    new Promise(res => socket.once('connect_error', () => res(false))),
    new Promise(res => setTimeout(() => res(false), 5000)),
  ]);
  if (!connected) throw new Error("U's socket did not connect");
  const gotDeleted = waitFor(socket, 'account_deleted', 8000);
  const gotDisconnect = waitFor(socket, 'disconnect', 8000);
  // Exactly what scripts/deleteAccount.js does after its prompts.
  const deleted = await deleteUserAccount(U.userId, { skipCode: true });
  await afterAccountDeletion(U.userId, deleted, { purgeTimeoutMs: 5000 });
  check("U's open socket received account_deleted (NOTIFY -> running server)", !!(await gotDeleted),
    'nothing within 8s -- was the backend restarted after task 13?');
  check("U's socket was disconnected by the server", !!(await gotDisconnect));

  section('2. Admin queue: deleted account flagged, details kept');
  let r = await get('/api/admin/payments/pending', ADM.token);
  const rowU = (r.data.payments || []).find(p => p.id === ids.sessionU);
  check("U's payment listed with account_deleted and amount/plan/date/transaction id/proof", r.status === 200 && rowU?.account_deleted === true
    && Number(rowU.amount) === 199 && rowU.plan === 'gold' && !!rowU.submitted_at
    && rowU.upi_transaction_id === `SUPTEST${stamp}u` && rowU.proof_url?.includes(`support-test-${stamp}-u`), show(r));

  section('3. Approve refused for the deleted account');
  r = await post(`/api/admin/payments/${ids.sessionU}/approve`, ADM.token, {});
  check('approve -> 409 ACCOUNT_DELETED', r.status === 409 && r.data.error === 'ACCOUNT_DELETED', show(r));
  const nothing = await one(
    `SELECT ps.status, ps.reviewed_by, u.current_plan, u.subscription_status,
            (SELECT count(*)::int FROM plan_history WHERE payment_session_id = ps.id) AS history,
            (SELECT count(*)::int FROM notifications WHERE user_id = u.id AND type = 'premium_payment_approved') AS notes
     FROM payment_sessions ps JOIN users u ON u.id = ps.user_id WHERE ps.id = ?`, [ids.sessionU]);
  check('nothing activated: session still pending_review, plan free/inactive, no history row, no notification',
    nothing?.status === 'pending_review' && nothing.reviewed_by === null && nothing.current_plan === 'free'
    && nothing.subscription_status === 'inactive' && nothing.history === 0 && nothing.notes === 0, JSON.stringify(nothing));
  let thrown = null;
  try { await subscribeToPlan(U.userId, 'gold', { source: 'paid' }); } catch (err) { thrown = err; }
  const planAfter = await one('SELECT current_plan, subscription_status FROM users WHERE id = ?', [U.userId]);
  check('subscribeToPlan() itself refuses a deleted account (race guard), plan unchanged',
    thrown?.code === 'ACCOUNT_DELETED' && planAfter.current_plan === 'free' && planAfter.subscription_status === 'inactive',
    `${thrown?.code || 'no error'} ${JSON.stringify(planAfter)}`);

  section('4. Reject still works, without notifying U');
  r = await post(`/api/admin/payments/${ids.sessionU}/reject`, ADM.token, { rejectionReason: 'Account deleted before review' });
  check('reject -> 200', r.status === 200 && r.data.success === true, show(r));
  const rejected = await one(
    `SELECT ps.status, ps.rejection_reason,
            (SELECT count(*)::int FROM notifications WHERE user_id = ps.user_id AND type = 'premium_payment_rejected') AS notes
     FROM payment_sessions ps WHERE ps.id = ?`, [ids.sessionU]);
  check('session rejected with the reason, no notification for U',
    rejected?.status === 'rejected' && rejected.rejection_reason === 'Account deleted before review' && rejected.notes === 0, JSON.stringify(rejected));

  section("5. Control: a live user's payment still approves");
  r = await post(`/api/admin/payments/${ids.sessionV}/approve`, ADM.token, {});
  const vState = await one(
    'SELECT u.current_plan, u.subscription_status, ps.status FROM users u JOIN payment_sessions ps ON ps.user_id = u.id WHERE ps.id = ?', [ids.sessionV]);
  check('approve V -> 200, gold active, session succeeded', r.status === 200
    && vState?.current_plan === 'gold' && vState.subscription_status === 'active' && vState.status === 'succeeded', `${show(r)} ${JSON.stringify(vState)}`);

  section('6. deleteAccount.js guard (no prompts)');
  check('refuses user 1', deletionRefusal({ id: PROTECTED_USER_ID, is_admin: false, deleted_at: null }) === 'user 1 is protected');
  const admSummary = await loadUserSummary(db, ADM.userId);
  check('refuses an admin (real row)', deletionRefusal(admSummary?.user) === "admin accounts can't be deleted", JSON.stringify(admSummary?.user));
  const uSummary = await loadUserSummary(db, U.userId);
  check('refuses an already-deleted account', deletionRefusal(uSummary?.user) === 'this account is already deleted');
  check('refuses a missing user', deletionRefusal(await loadUserSummary(db, 2147483647)) === 'no such user');
  const vSummary = await loadUserSummary(db, V.userId);
  check('allows a live member, and the summary shows username, email, plan and pets',
    deletionRefusal(vSummary?.user) === null && vSummary.user.username === V.username && vSummary.user.email === V.email
    && vSummary.user.current_plan === 'gold' && vSummary.pets.length === 1 && !!vSummary.user.created_at, JSON.stringify(vSummary));
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
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
      const ours = row.email === email || row.email === `sniffedout~${id}`;
      if (!ours || id === PROTECTED_USER_ID) throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
      // The throwaway admin was created by this run; demote it before deleting.
      if (row.is_admin) await tx.run('UPDATE users SET is_admin = FALSE WHERE id = ? AND email = ?', [id, email]);
    }
    const list = async (sql, params) => (await tx.all(sql, params)).map(r => r.id);
    const pets = await list('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [users]);
    const sessions = await list('SELECT id FROM payment_sessions WHERE user_id = ANY(?::int[])', [users]);
    const steps = [
      ['plan_history', 'user_id = ANY(?::int[]) OR payment_session_id = ANY(?::int[])', [users, sessions]],
      ['payment_sessions', 'id = ANY(?::int[])', [sessions]],
      ['notifications', 'user_id = ANY(?::int[]) OR sender_pet_id = ANY(?::int[])', [users, pets]],
      ['spotlight_rank_tracking', 'pet_id = ANY(?::int[])', [pets]],
      ['pending_media_deletions', 'deleted_user_id = ANY(?::int[])', [users]],
      ['media_files', 'user_id = ANY(?::int[])', [users]],
      ['notification_preferences', 'user_id = ANY(?::int[])', [users]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [users]],
      ['trusted_devices', 'user_id = ANY(?::int[])', [users]],
      ['verification_codes', 'user_id = ANY(?::int[])', [users]],
    ];
    for (const [table, where, params] of steps) await tx.run(`DELETE FROM ${table} WHERE ${where}`, params);

    // Anything else still pointing at the test users/pets: stop and roll back.
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
      const refIds = f.ref_table === 'users' ? users : pets;
      const row = await tx.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ANY(?::int[])`, [refIds]);
      if (row.n) leftovers.push(`${f.table_name}.${f.column_name} (${row.n})`);
    }
    if (leftovers.length) throw new Error(`unexpected rows still reference the test accounts: ${leftovers.join(', ')}`);

    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} test users, ${petDel.rowCount} pets and their payment rows`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}   Backend: ${API_BASE}`);
  console.log(`Creates throwaway users support-test-${stamp}-{adm,u,v}@example.invalid (adm is a throwaway admin), runs the tests, then deletes them.`);
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
  const created = { users: [], sockets: [], ids: {} };
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
