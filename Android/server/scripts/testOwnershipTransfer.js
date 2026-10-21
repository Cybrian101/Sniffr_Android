// Integration test for PawCircle ownership transfers, against your running
// backend (`npm run dev` on :3001) and the database in server/.env
// (production, no real users yet).
//
// Throwaway users (reserved .invalid domain), all on the Free plan:
//   A   owns circle C (the main flow) and circle CN (refusals + recipient deletion)
//   B   member of C: offered, declines, leaves (cancels), rejoins, accepts
//   M   member of C (Admin of CN): re-target, cancel, expiry
//   P   member of C who already owns 5 circles: plan limit on accept
//   D   member of CN: deletes their account while a transfer to them is pending
//   N   outsider
//   FO  owns CF and CF2, offers both to R, then deletes their account
//   R   recipient: accepts CF (reactivated), declines CF2 (stays frozen)
//   X   plain member of CF
// Cleanup removes every test row even if a check fails. Never touches user 1.
//
//   node scripts/testOwnershipTransfer.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { deleteUserAccount } = await import('../services/accountDeletion.js');
const { afterAccountDeletion } = await import('../services/accountDeletionFollowUp.js');
const { expireOwnershipTransfers, startTransfer } = await import('../services/circleOwnershipTransfers.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `transfer-test-${stamp}-${key}@example.invalid`, username: `xfr${key}_${stamp}` });
const A = mk('a');
const B = mk('b');
const M = mk('m');
const P = mk('p');
const D = mk('d');
const N = mk('n');
const FO = mk('fo');
const R = mk('r');
const X = mk('x');

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
const is = (r, status, code) => r.status === status && r.data?.error === code;

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
const del = (path, token) => call('DELETE', path, token);
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
const waitFor = (socket, event, ms = 5000, match = () => true) => new Promise(resolve => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  function handler(payload) {
    if (!match(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload);
  }
  socket.on(event, handler);
});
const emitAck = (socket, event, payload, ms = 5000) => new Promise(resolve => {
  const t = setTimeout(() => resolve(null), ms);
  socket.emit(event, payload, a => { clearTimeout(t); resolve(a); });
});
async function connect(ioClient, spec, created) {
  const socket = ioClient(API_BASE, { auth: { token: spec.token }, transports: ['websocket'], reconnection: false });
  created.sockets.push(socket);
  const ok = await Promise.race([
    new Promise(res => socket.once('connect', () => res(true))),
    new Promise(res => socket.once('connect_error', () => res(false))),
    new Promise(res => setTimeout(() => res(false), 5000)),
  ]);
  if (!ok) throw new Error(`socket for ${spec.key} did not connect`);
  return socket;
}

async function createUser(spec, created) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `Transfer Test ${spec.key.toUpperCase()}`]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
  // Creating/joining circles acts as a pet (no pet -> 403 NO_PET).
  spec.petId = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, {
    name: `Xfr${spec.key.toUpperCase()}${stamp}`, pet_username: testPetUsername(`xfr${spec.key}`), type: 'dog',
  }))).id;
}
async function createCircle(spec, created, name) {
  const c = (await must(`${spec.key} creates ${name}`, post('/api/communities', spec.token, { name, description: 'ownership transfer test' }))).community;
  created.circles.push(c.id);
  return c.id;
}
const join = (spec, circleId) => must(`${spec.key} joins #${circleId}`, post(`/api/communities/${circleId}/join`, spec.token));
const xfer = id => `/api/communities/${id}/ownership-transfer`;
const role = (circleId, userId) => one('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [circleId, userId]).then(r => r?.role || null);
const transferRow = id => one('SELECT id, status, from_user_id, to_user_id, (expires_at > NOW()) AS live, expires_at FROM community_ownership_transfers WHERE id = ?', [id]);
// The notification with exactly this title, for this user.
const notifWithTitle = (userId, title) => one('SELECT id, type, action_status FROM notifications WHERE user_id = ? AND title = ? ORDER BY id DESC LIMIT 1', [userId, title]);
const requestNotif = (userId, transferId) => one(
  `SELECT id, title, action_status FROM notifications
   WHERE user_id = ? AND type = 'community_ownership_transfer' AND (metadata_json::jsonb ->> 'transfer_id') = ?`, [userId, String(transferId)]);

async function runTests(created) {
  const ioClient = loadSocketClient();
  if (!ioClient) throw new Error('socket.io-client not found in client/node_modules');

  section('Setup');
  for (const spec of [A, B, M, P, D, N, FO, R, X]) await createUser(spec, created);
  const cName = `Transfer C ${stamp}`;
  const C = await createCircle(A, created, cName);
  const CN = await createCircle(A, created, `Transfer CN ${stamp}`);
  for (let i = 1; i <= 5; i++) await createCircle(P, created, `P owned ${i} ${stamp}`);
  for (const spec of [B, M, P]) await join(spec, C);
  for (const spec of [B, M, D]) await join(spec, CN);
  await must('A makes M an Admin of CN', post(`/api/communities/${CN}/members/${M.userId}/role`, A.token, { role: 'Admin' }));
  const cfName = `Transfer CF ${stamp}`;
  const CF = await createCircle(FO, created, cfName);
  const CF2 = await createCircle(FO, created, `Transfer CF2 ${stamp}`);
  for (const spec of [R, X]) await join(spec, CF);
  await join(R, CF2);
  console.log(`  C #${C}, CN #${CN}, CF #${CF}, CF2 #${CF2}; users #${created.users.map(u => u.id).join(', #')}`);
  const bSock = await connect(ioClient, B, created);
  const mSock = await connect(ioClient, M, created);

  section('Who can start a transfer (CN)');
  let r = await post(xfer(CN), B.token, { toUserId: D.userId });
  check('a Member -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));
  r = await post(xfer(CN), M.token, { toUserId: D.userId });
  check('an Admin -> 403 FORBIDDEN (owner only)', is(r, 403, 'FORBIDDEN'), show(r));
  r = await post(xfer(CN), N.token, { toUserId: D.userId });
  check('an outsider -> 403 NOT_A_MEMBER', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await post(xfer(CN), A.token, { toUserId: N.userId });
  check('to a non-member -> 404 MEMBER_NOT_FOUND', is(r, 404, 'MEMBER_NOT_FOUND'), show(r));
  r = await post(xfer(CN), A.token, { toUserId: A.userId });
  check('to yourself -> 400 INVALID_RECIPIENT', is(r, 400, 'INVALID_RECIPIENT'), show(r));
  r = await post(`/api/communities/${CN}/members/${B.userId}/role`, A.token, { role: 'Owner' });
  check('making someone Owner by a role change -> 400 USE_OWNERSHIP_TRANSFER', is(r, 400, 'USE_OWNERSHIP_TRANSFER') && await role(CN, B.userId) === 'Member', show(r));
  r = await post(`/api/communities/${CN}/members/${A.userId}/role`, M.token, { role: 'Member' });
  check("an Admin demoting the Owner -> 403 FORBIDDEN", is(r, 403, 'FORBIDDEN') && await role(CN, A.userId) === 'Owner', show(r));
  check('no transfer rows were created by any of that',
    (await one('SELECT count(*)::int AS n FROM community_ownership_transfers WHERE community_id = ?', [CN])).n === 0);

  section('Start and confirm (A -> B on C)');
  const bUpdated = waitFor(bSock, 'community_transfer_updated', 5000, p => p?.communityId === C);
  r = await post(xfer(C), A.token, { toUserId: B.userId });
  const t1 = r.data.transfer?.id;
  check('start -> 201', r.status === 201 && !!t1, show(r));
  const t1Row = await transferRow(t1);
  check('pending, A -> B, expires in about 5 days', t1Row?.status === 'pending' && t1Row.from_user_id === A.userId && t1Row.to_user_id === B.userId
    && Math.abs(new Date(t1Row.expires_at).getTime() - Date.now() - 5 * 86400000) < 10 * 60000, JSON.stringify(t1Row));
  check("B's open page is told", !!(await bUpdated));
  const offerTitle = `${A.username} wants to transfer ownership of '${cName}' to you.`;
  check('B got the offer notification (Accept/Decline pending)', (await requestNotif(B.userId, t1))?.title === offerTitle
    && (await requestNotif(B.userId, t1))?.action_status === 'pending', JSON.stringify(await requestNotif(B.userId, t1)));
  r = await get(xfer(C), A.token);
  check('GET as the owner: isSender', r.data.transfer?.id === t1 && r.data.transfer?.isSender === true && r.data.transfer?.toUsername === B.username, show(r));
  r = await get(xfer(C), B.token);
  check('GET as the recipient: isRecipient', r.data.transfer?.id === t1 && r.data.transfer?.isRecipient === true && r.data.transfer?.fromUsername === A.username, show(r));
  r = await get(xfer(C), M.token);
  check('GET as another member: nothing', r.status === 200 && r.data.transfer === null, show(r));
  r = await post(xfer(C), A.token, { toUserId: B.userId });
  check('offering B again -> 200, same transfer, no second notification', r.status === 200 && r.data.transfer?.id === t1
    && (await one("SELECT count(*)::int AS n FROM notifications WHERE user_id = ? AND type = 'community_ownership_transfer'", [B.userId])).n === 1, show(r));

  section('Only the recipient can answer');
  r = await post(`${xfer(C)}/${t1}/accept`, M.token);
  check('another member accepts -> 403 NOT_RECIPIENT', is(r, 403, 'NOT_RECIPIENT'), show(r));
  r = await post(`${xfer(C)}/${t1}/accept`, A.token);
  check('the owner accepts their own offer -> 403 NOT_RECIPIENT', is(r, 403, 'NOT_RECIPIENT'), show(r));
  r = await post(`${xfer(C)}/${t1}/decline`, M.token);
  check('another member declines -> 403 NOT_RECIPIENT', is(r, 403, 'NOT_RECIPIENT'), show(r));
  r = await del(xfer(C), B.token);
  check('the recipient cannot cancel (owner only) -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));
  check('still pending, A still Owner', (await transferRow(t1))?.status === 'pending' && await role(C, A.userId) === 'Owner');

  section('Re-target to M, then cancel');
  r = await post(xfer(C), A.token, { toUserId: M.userId });
  const t2 = r.data.transfer?.id;
  check('picking M -> 201, a new transfer', r.status === 201 && t2 && t2 !== t1, show(r));
  check('the one to B was cancelled first', (await transferRow(t1))?.status === 'cancelled');
  const cancelTitle = `${A.username} cancelled the ownership transfer of '${cName}'.`;
  check("B is told, and B's offer shows cancelled", !!(await notifWithTitle(B.userId, cancelTitle)) && (await requestNotif(B.userId, t1))?.action_status === 'cancelled');
  check('M got the offer', (await requestNotif(M.userId, t2))?.action_status === 'pending');
  r = await del(xfer(C), A.token);
  check('the owner cancels -> 200', r.status === 200 && (await transferRow(t2))?.status === 'cancelled', show(r));
  check("M is told, and M's offer shows cancelled", !!(await notifWithTitle(M.userId, cancelTitle)) && (await requestNotif(M.userId, t2))?.action_status === 'cancelled');
  r = await del(xfer(C), A.token);
  check('cancel again -> 404 NO_PENDING_TRANSFER', is(r, 404, 'NO_PENDING_TRANSFER'), show(r));
  r = await post(`${xfer(C)}/${t2}/accept`, M.token);
  check('accepting a cancelled offer -> 409 TRANSFER_NOT_PENDING', is(r, 409, 'TRANSFER_NOT_PENDING'), show(r));

  section('Decline (A -> B)');
  r = await post(xfer(C), A.token, { toUserId: B.userId });
  const t3 = r.data.transfer?.id;
  r = await post(`${xfer(C)}/${t3}/decline`, B.token);
  check('B declines -> 200', r.status === 200 && (await transferRow(t3))?.status === 'declined', show(r));
  check(`A is told "<B> declined the ownership transfer for '<circle>'."`,
    !!(await notifWithTitle(A.userId, `${B.username} declined the ownership transfer for '${cName}'.`)));
  check("B's offer shows declined; nothing changed", (await requestNotif(B.userId, t3))?.action_status === 'declined'
    && await role(C, A.userId) === 'Owner' && await role(C, B.userId) === 'Member');
  r = await post(`${xfer(C)}/${t3}/accept`, B.token);
  check('accepting after declining -> 409 TRANSFER_NOT_PENDING', is(r, 409, 'TRANSFER_NOT_PENDING'), show(r));

  section('Expiry after 5 days (A -> M)');
  r = await post(xfer(C), A.token, { toUserId: M.userId });
  const t4 = r.data.transfer?.id;
  await db.run("UPDATE community_ownership_transfers SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ?", [t4]);
  r = await get(xfer(C), A.token);
  check('past 5 days the owner no longer sees it as pending', r.status === 200 && r.data.transfer === null, show(r));
  r = await post(`${xfer(C)}/${t4}/accept`, M.token);
  check('accepting it -> 410 TRANSFER_EXPIRED, nothing changes', is(r, 410, 'TRANSFER_EXPIRED') && await role(C, M.userId) === 'Member', show(r));
  const expiryTitle = `The ownership transfer for '${cName}' expired.`;
  // The job runs here without the server's io (like the hourly job): its live
  // events are handed to the running server over Postgres NOTIFY.
  const liveTransfer = waitFor(mSock, 'community_transfer_updated', 8000, p => p?.communityId === C);
  const liveNotif = waitFor(mSock, 'notification_received', 8000, p => p?.notification?.title === expiryTitle);
  const expired = await expireOwnershipTransfers();
  check('the hourly job expires it', expired >= 1 && (await transferRow(t4))?.status === 'expired', expired);
  check("M's open page hears it live (community_transfer_updated relayed via NOTIFY)", !!(await liveTransfer));
  check('...and the expiry notification pops up live', !!(await liveNotif));
  check('BOTH sides got the expiry notification', !!(await notifWithTitle(A.userId, expiryTitle)) && !!(await notifWithTitle(M.userId, expiryTitle)));
  check("M's offer shows expired", (await requestNotif(M.userId, t4))?.action_status === 'expired');

  section('Recipient leaves -> cancelled (A -> B)');
  r = await post(xfer(C), A.token, { toUserId: B.userId });
  const t5 = r.data.transfer?.id;
  r = await post(`/api/communities/${C}/leave`, B.token);
  check('B leaves C -> 200, transfer cancelled', r.status === 200 && (await transferRow(t5))?.status === 'cancelled', show(r));
  check('A is told B left and the transfer was cancelled',
    !!(await notifWithTitle(A.userId, `${B.username} left '${cName}', so the ownership transfer was cancelled.`)));
  check("B's offer shows cancelled", (await requestNotif(B.userId, t5))?.action_status === 'cancelled');
  await join(B, C);

  section('Plan limit on accept (A -> P, who owns 5 circles)');
  r = await post(xfer(C), A.token, { toUserId: P.userId });
  const t6 = r.data.transfer?.id;
  r = await post(`${xfer(C)}/${t6}/accept`, P.token);
  check('P accepts -> 409 OWNER_LIMIT_REACHED with a clear message',
    is(r, 409, 'OWNER_LIMIT_REACHED') && /Sniffr Free/.test(r.data.message || '') && /upgrade/.test(r.data.message || ''), show(r));
  check('...the transfer stays pending; A still Owner, P still Member', (await transferRow(t6))?.status === 'pending'
    && await role(C, A.userId) === 'Owner' && await role(C, P.userId) === 'Member' && (await requestNotif(P.userId, t6))?.action_status === 'pending');
  await must('A cancels the transfer to P', del(xfer(C), A.token));

  section('Accept (A -> B)');
  r = await post(xfer(C), A.token, { toUserId: B.userId });
  const t7 = r.data.transfer?.id;
  check('offer to B -> 201', r.status === 201, show(r));
  await emitAck(mSock, 'join_community_chat', { communityId: C });
  const ownerChanged = waitFor(mSock, 'community_ownership_changed', 5000, p => p?.communityId === C);
  r = await post(`${xfer(C)}/${t7}/accept`, B.token);
  check('B accepts -> 200', r.status === 200 && r.data.success === true && r.data.reactivated === false, show(r));
  const cRow = await one('SELECT created_by, status FROM communities WHERE id = ?', [C]);
  check('B is the Owner (role and created_by); A is a regular Member', await role(C, B.userId) === 'Owner' && await role(C, A.userId) === 'Member'
    && cRow?.created_by === B.userId, JSON.stringify(cRow));
  check('exactly one Owner', (await one("SELECT count(*)::int AS n FROM community_members WHERE community_id = ? AND role = 'Owner'", [C])).n === 1);
  check('transfer accepted', (await transferRow(t7))?.status === 'accepted');
  check(`A is told "Ownership transfer successful. <B> is now the admin of '<circle>'."`,
    !!(await notifWithTitle(A.userId, `Ownership transfer successful. ${B.username} is now the admin of '${cName}'.`)));
  check("B's offer shows accepted", (await requestNotif(B.userId, t7))?.action_status === 'accepted');
  check('open pages in the circle are told the owner changed', (await ownerChanged)?.ownerId === B.userId);
  r = await post(xfer(C), A.token, { toUserId: M.userId });
  check('A (now a Member) can no longer start a transfer -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));

  section('Recipient deletes their account -> cancelled (A -> D on CN)');
  r = await post(xfer(CN), A.token, { toUserId: D.userId });
  const t8 = r.data.transfer?.id;
  check('offer to D -> 201', r.status === 201, show(r));
  const dDeleted = await deleteUserAccount(D.userId, { skipCode: true });
  await afterAccountDeletion(D.userId, dDeleted, {});
  check('D deleted: the transfer is cancelled', (await transferRow(t8))?.status === 'cancelled');
  check('A is told', !!(await notifWithTitle(A.userId, `The ownership transfer of 'Transfer CN ${stamp}' was cancelled: that member deleted their account.`)));

  section('Owner deletes their account: the pending transfer can still revive the circle');
  r = await post(xfer(CF), FO.token, { toUserId: R.userId });
  const t9 = r.data.transfer?.id;
  r = await post(xfer(CF2), FO.token, { toUserId: R.userId });
  const t10 = r.data.transfer?.id;
  check('FO offers CF and CF2 to R', !!t9 && !!t10);
  await deleteUserAccount(FO.userId, { skipCode: true });
  check('FO deleted: CF and CF2 frozen, both transfers still pending',
    (await one('SELECT status FROM communities WHERE id = ?', [CF]))?.status === 'frozen'
    && (await one('SELECT status FROM communities WHERE id = ?', [CF2]))?.status === 'frozen'
    && (await transferRow(t9))?.status === 'pending' && (await transferRow(t10))?.status === 'pending');
  r = await post(xfer(CF), X.token, { toUserId: R.userId });
  check('no new transfer on a frozen circle (HTTP) -> 403 COMMUNITY_READ_ONLY', is(r, 403, 'COMMUNITY_READ_ONLY'), show(r));
  const direct = await startTransfer(CF, FO.userId, X.userId, null);
  check('...nor through the service itself -> 403 COMMUNITY_READ_ONLY', direct.status === 403 && direct.body?.error === 'COMMUNITY_READ_ONLY', JSON.stringify(direct));
  r = await get(xfer(CF), R.token);
  check('R still sees the offer on the frozen circle', r.data.transfer?.id === t9 && r.data.transfer?.isRecipient === true, show(r));
  r = await post(`${xfer(CF)}/${t9}/accept`, R.token);
  check('R accepts -> 200, reactivated', r.status === 200 && r.data.reactivated === true, show(r));
  const cf = await one('SELECT status, frozen_at, frozen_reason, created_by, member_count FROM communities WHERE id = ?', [CF]);
  check('CF is active again with R as owner', cf?.status === 'active' && cf.frozen_at === null && cf.frozen_reason === null && cf.created_by === R.userId
    && await role(CF, R.userId) === 'Owner', JSON.stringify(cf));
  check("FO's SniffedOut owner row is gone, X still a member, count = 2", await role(CF, FO.userId) === null && await role(CF, X.userId) === 'Member'
    && cf?.member_count === 2, JSON.stringify(cf));
  r = await post(`/api/communities/${CF}/messages`, X.token, { content: 'we are back' });
  check('the circle takes writes again', r.status === 201, show(r));
  r = await post(`${xfer(CF2)}/${t10}/decline`, R.token);
  check('R declines CF2 -> 200, CF2 stays frozen', r.status === 200 && (await transferRow(t10))?.status === 'declined'
    && (await one('SELECT status FROM communities WHERE id = ?', [CF2]))?.status === 'frozen', show(r));
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  for (const s of created.sockets) s.disconnect();
  if (!created.users.length) {
    console.log('  nothing to clean up');
    return;
  }
  await withTransaction(async tx => {
    const users = created.users.map(u => u.id);
    for (const { id, email } of created.users) {
      const row = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!row) continue;
      if (id === PROTECTED_USER_ID || row.is_admin || !(row.email === email || row.email === `sniffedout~${id}`)) {
        throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
      }
    }
    const list = async (sql, params) => (await tx.all(sql, params)).map(r => r.id);
    const pets = await list('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [users]);
    const circles = await list('SELECT id FROM communities WHERE id = ANY(?::int[]) OR created_by = ANY(?::int[])', [created.circles, users]);
    const outsiders = await tx.get(
      'SELECT count(*)::int AS n FROM community_members WHERE community_id = ANY(?::int[]) AND NOT (user_id = ANY(?::int[]))', [circles, users]);
    if (outsiders.n) throw new Error(`${outsiders.n} non-test member(s) joined a test circle -- leaving it for a manual look`);
    const circleMsgs = await list('SELECT id FROM community_messages WHERE community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]);
    const queueExists = (await tx.get("SELECT to_regclass('public.pending_auth_deletions') IS NOT NULL AS ok")).ok;
    const steps = [
      ['community_message_reactions', 'user_id = ANY(?::int[]) OR community_message_id = ANY(?::int[])', [users, circleMsgs]],
      ['community_messages', 'id = ANY(?::int[])', [circleMsgs]],
      ['community_photos', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['community_announcements', 'community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]],
      ['community_events', 'community_id = ANY(?::int[]) OR created_by = ANY(?::int[])', [circles, users]],
      ['community_polls', 'community_id = ANY(?::int[]) OR created_by = ANY(?::int[])', [circles, users]],
      ['community_join_requests', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[]) OR decided_by = ANY(?::int[])', [circles, users, users]],
      ['community_ownership_transfers', 'community_id = ANY(?::int[]) OR to_user_id = ANY(?::int[]) OR from_user_id = ANY(?::int[])', [circles, users, users]],
      ['community_members', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['communities', 'id = ANY(?::int[])', [circles]],
      ['profile_views', 'viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [pets, pets]],
      ['spotlight_rank_tracking', 'pet_id = ANY(?::int[])', [pets]],
      ['notifications', 'user_id = ANY(?::int[]) OR sender_pet_id = ANY(?::int[])', [users, pets]],
      ['plan_history', 'user_id = ANY(?::int[])', [users]],
      ['pending_media_deletions', 'deleted_user_id = ANY(?::int[])', [users]],
      ['media_files', 'user_id = ANY(?::int[])', [users]],
      ['notification_preferences', 'user_id = ANY(?::int[])', [users]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [users]],
      ['trusted_devices', 'user_id = ANY(?::int[])', [users]],
      ['verification_codes', 'user_id = ANY(?::int[])', [users]],
      ...(queueExists ? [['pending_auth_deletions', 'deleted_user_id = ANY(?::int[])', [users]]] : []),
    ];
    for (const [table, where, params] of steps) await tx.run(`DELETE FROM ${table} WHERE ${where}`, params);

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
    console.log(`  deleted ${userDel.rowCount} test users, ${petDel.rowCount} pets, ${circles.length} circle(s) and their rows`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}   Backend: ${API_BASE}`);
  console.log(`Creates throwaway users transfer-test-${stamp}-*@example.invalid and their circles, then removes them.`);
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
  const created = { users: [], circles: [], sockets: [] };
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
