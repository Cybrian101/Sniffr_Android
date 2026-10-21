// Integration test for PRIVATE PawCircles (join by approval), against your
// running backend (`npm run dev` on :3001) and the database in server/.env
// (production, no real users yet). Needs db/sql/2026-10-02_private_circle_requests.sql.
//
// Throwaway users (reserved .invalid domain), all on the Free plan:
//   OWN  owns private circle P, private circle P2 and public circle PUB
//   OUT  outsider: sees only P's public info, is refused every private read
//        and the live room, requests via search, cancels, is accepted, later
//        made Admin of P (and declines R2)
//   R2   requests via the invite link page, is declined (24h cooldown), later
//        deleted (their request disappears)
//   R3   plan limit: joins 3 public circles while their request is pending
//   R4   expiry (on P2), public circles unchanged (PUB), disabled circle (P2)
//   LO   owns the three public "limit" circles L1-L3
//   FO / FR  FO's private circle F gets a request from FR, then FO deletes
//        their account: F freezes and the request is cancelled
// Event announcements use remote coordinates (South Georgia) so no real
// user is ever near them. Cleanup removes every test row even if a check
// fails. Never touches user 1.
//
//   node scripts/testPrivateCircles.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { deleteUserAccount } = await import('../services/accountDeletion.js');
const { expireJoinRequests } = await import('../services/circleJoinRequests.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const FAR = { lat: -54.2800, lng: -36.5000 }; // South Georgia
const mk = key => ({ key, email: `private-test-${stamp}-${key}@example.invalid`, username: `prv${key}_${stamp}` });
const OWN = mk('own');
const OUT = mk('out');
const R2 = mk('r2');
const R3 = mk('r3');
const R4 = mk('r4');
const LO = mk('lo');
const FO = mk('fo');
const FR = mk('fr');
// What a non-member may see of a private circle.
const LOCKED_KEYS = ['id', 'name', 'description', 'cover_image', 'icon_image', 'member_count', 'is_private', 'locked', 'frozen',
  'disabled', 'joinStatus', 'requestExpiresAt', 'requestCooldownUntil', 'userRole', 'userBadge', 'clearedAt', 'isHiddenFromList'];
const SECRET_RULES = `secret pack rules ${stamp}`;
const SECRET_CITY = `Zqcity${stamp}`;
const SECRET_TAG = `zqtag${stamp}`;

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
const n = async (sql, params = []) => (await db.get(sql, params)).n;
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

async function createUser(spec, created, location = null) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `Private Test ${spec.key.toUpperCase()}`]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
  spec.petName = `Prv${spec.key.toUpperCase()}${stamp}`;
  spec.petId = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, {
    name: spec.petName, pet_username: testPetUsername(`prv${spec.key}`), type: 'dog',
    ...(location ? { latitude: location.lat, longitude: location.lng, location_text: 'Private circle test' } : {}),
  }))).id;
}
async function createCircle(spec, created, fields) {
  const c = (await must(`${spec.key} creates ${fields.name}`, post('/api/communities', spec.token, { description: 'private circle test', ...fields }))).community;
  created.circles.push(c.id);
  return c.id;
}
const search = (spec, query) => get(`/api/communities?${query}`, spec.token);
const found = (r, id) => (r.data.communities || []).find(c => c.id === id);
const requestRow = (circleId, userId) => one(
  'SELECT id, status, decided_by, (expires_at > NOW()) AS live FROM community_join_requests WHERE community_id = ? AND user_id = ?', [circleId, userId]);
const notifCount = (userId, type, circleId) => n(
  'SELECT count(*)::int AS n FROM notifications WHERE user_id = ? AND type = ? AND target_id = ?', [userId, type, String(circleId)]);
const isMember = async (circleId, userId) => !!(await one('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', [circleId, userId]));

async function runTests(created) {
  const ioClient = loadSocketClient();
  if (!ioClient) throw new Error('socket.io-client not found in client/node_modules');

  section('Setup');
  await createUser(OWN, created);
  await createUser(OUT, created, FAR);
  for (const spec of [R2, R3, R4, LO, FO, FR]) await createUser(spec, created);
  const P = await createCircle(OWN, created, {
    name: `Private P ${stamp}`, is_private: 1, city: SECRET_CITY, tags: SECRET_TAG, rules: SECRET_RULES, category: 'Activities',
  });
  const P2 = await createCircle(OWN, created, { name: `Private Two ${stamp}`, is_private: 1 });
  const PUB = await createCircle(OWN, created, { name: `Public Pub ${stamp}`, city: `Pubcity${stamp}`, rules: `public rules ${stamp}` });
  const L = [];
  for (let i = 1; i <= 3; i++) L.push(await createCircle(LO, created, { name: `Limit L${i} ${stamp}` }));
  const F = await createCircle(FO, created, { name: `Frozen F ${stamp}`, is_private: 1 });
  await must('OWN message in P', post(`/api/communities/${P}/messages`, OWN.token, { content: `inside P ${stamp}` }));
  await must('OWN event announcement in P', post(`/api/communities/${P}/announcements`, OWN.token,
    { title: 'Secret walk', content: `private walk ${stamp}`, is_event: true, latitude: FAR.lat, longitude: FAR.lng }));
  await must('OWN event announcement in PUB', post(`/api/communities/${PUB}/announcements`, OWN.token,
    { title: 'Open walk', content: `public walk ${stamp}`, is_event: true, latitude: FAR.lat, longitude: FAR.lng }));
  console.log(`  P #${P}, P2 #${P2}, PUB #${PUB}, L #${L.join('/#')}, F #${F}; users #${created.users.map(u => u.id).join(', #')}`);
  check('P and P2 are private, PUB public', (await one('SELECT is_private FROM communities WHERE id = ?', [P]))?.is_private === 1
    && (await one('SELECT is_private FROM communities WHERE id = ?', [P2]))?.is_private === 1
    && (await one('SELECT is_private FROM communities WHERE id = ?', [PUB]))?.is_private === 0);

  section('Outsider: search shows only public info');
  let r = await search(OUT, `q=${encodeURIComponent(`Private P ${stamp}`)}`);
  let c = found(r, P);
  check('search by name finds P, locked, "Request to Join"', !!c && c.locked === true && c.is_private === 1 && c.joinStatus === 'Request to Join', show(r));
  check('...with only name, cover/icon, description, member count (+ request state)',
    !!c && Object.keys(c).every(k => LOCKED_KEYS.includes(k)) && c.name && 'member_count' in c && 'description' in c,
    c ? JSON.stringify(Object.keys(c).filter(k => !LOCKED_KEYS.includes(k))) : 'not found');
  check('...and nothing private in the response (rules, city, tags, invite code, creator)',
    !JSON.stringify(r.data).includes(SECRET_RULES) && !JSON.stringify(r.data).includes(SECRET_CITY) && !JSON.stringify(r.data).includes(SECRET_TAG)
      && !('invite_code' in (c || {})) && !('created_by' in (c || {})));
  r = await search(OUT, `q=${SECRET_TAG}`);
  check("searching a private circle's hidden tag doesn't find it", r.status === 200 && !found(r, P), show(r));
  r = await search(OUT, `city=${SECRET_CITY}`);
  check("filtering by a private circle's hidden city doesn't find it", r.status === 200 && !found(r, P), show(r));
  r = await search(OUT, `q=${encodeURIComponent(`Private P ${stamp}`)}&category=Activities`);
  check('name + category filter: private circles never matched through filters', r.status === 200 && !found(r, P), show(r));
  r = await search(OWN, `q=${SECRET_TAG}`);
  check('...while the owner still finds their own circle by tag (full info)', found(r, P)?.locked === false && found(r, P)?.rules === SECRET_RULES, show(r));
  r = await get('/api/communities?recommended=true', OUT.token);
  check('recommendations never include a private circle', r.status === 200 && !found(r, P) && !found(r, P2), show(r));
  r = await get(`/api/communities/${P}`, OUT.token);
  check('GET /:id (the invite-link page) -> same locked public info', r.status === 200 && r.data.community?.locked === true
    && Object.keys(r.data.community).every(k => LOCKED_KEYS.includes(k)) && !JSON.stringify(r.data).includes(SECRET_RULES), show(r));

  section('Outsider: every private read and the live room refused');
  for (const what of ['messages', 'announcements', 'photos', 'events', 'polls', 'members']) {
    r = await get(`/api/communities/${P}/${what}`, OUT.token);
    check(`GET /${what} -> 403 NOT_A_MEMBER`, is(r, 403, 'NOT_A_MEMBER'), show(r));
  }
  r = await get(`/api/communities/${P}/join-requests`, OUT.token);
  check('GET /join-requests -> 403 NOT_A_MEMBER', is(r, 403, 'NOT_A_MEMBER'), show(r));
  const outSock = await connect(ioClient, OUT, created);
  const ownSock = await connect(ioClient, OWN, created);
  let ack = await emitAck(outSock, 'join_community_chat', { communityId: P });
  check('socket join_community_chat -> refused NOT_A_MEMBER', ack?.success === false && ack?.error === 'NOT_A_MEMBER', JSON.stringify(ack));
  ack = await emitAck(outSock, 'send_community_message', { communityId: P, content: 'let me in' });
  check('socket send_community_message -> refused NOT_A_MEMBER', ack?.success === false && ack?.error === 'NOT_A_MEMBER', JSON.stringify(ack));
  await emitAck(ownSock, 'join_community_chat', { communityId: P });
  const leaked = waitFor(outSock, 'community_message_received', 2000, m => m?.community_id === P);
  await must('OWN posts while OUT listens', post(`/api/communities/${P}/messages`, OWN.token, { content: `still private ${stamp}` }));
  check("OUT's socket gets none of P's live messages", (await leaked) === null);
  check("no 'nearby event' notification about P's event went to anyone", await n(
    "SELECT count(*)::int AS n FROM notifications WHERE type = 'nearby_event' AND target_id = ?", [String(P)]) === 0);
  check("...while PUB's event did reach the nearby outsider (control)", await notifCount(OUT.userId, 'nearby_event', PUB) === 1);
  r = await post(`/api/communities/${P}/join`, OUT.token);
  check('direct join -> 403 APPROVAL_REQUIRED, not a member', is(r, 403, 'APPROVAL_REQUIRED') && !(await isMember(P, OUT.userId)), show(r));

  section('Request (via search), cancel, request again');
  const changed = waitFor(ownSock, 'community_join_requests_changed', 5000, p => p?.communityId === P);
  r = await post(`/api/communities/${P}/join-request`, OUT.token);
  check('request -> 201 Requested', r.status === 201 && r.data.joinStatus === 'Requested' && !!r.data.request?.id, show(r));
  check("the owner's open page is told the Requests list changed", !!(await changed));
  check('the owner got one join-request notification', await notifCount(OWN.userId, 'community_join_request', P) === 1);
  r = await get(`/api/communities/${P}`, OUT.token);
  check('the page now shows "Requested"', r.data.community?.joinStatus === 'Requested' && !!r.data.community?.requestExpiresAt, show(r));
  r = await post(`/api/communities/${P}/join-request`, OUT.token);
  check('requesting again while pending -> 200, same request, no second notification',
    r.status === 200 && r.data.joinStatus === 'Requested' && await notifCount(OWN.userId, 'community_join_request', P) === 1, show(r));
  r = await del(`/api/communities/${P}/join-request`, OUT.token);
  check('cancel -> 200, row cancelled', r.status === 200 && (await requestRow(P, OUT.userId))?.status === 'cancelled', show(r));
  r = await del(`/api/communities/${P}/join-request`, OUT.token);
  check('cancel again -> 404 NO_PENDING_REQUEST', is(r, 404, 'NO_PENDING_REQUEST'), show(r));
  check('page back to "Request to Join"', (await get(`/api/communities/${P}`, OUT.token)).data.community?.joinStatus === 'Request to Join');
  r = await post(`/api/communities/${P}/join-request`, OUT.token);
  check('request again right after cancelling -> 201 (no cooldown)', r.status === 201, show(r));
  const outRequestId = r.data.request?.id;

  section('Accept -> member with full access');
  r = await get(`/api/communities/${P}/join-requests`, OWN.token);
  check("owner's Requests list shows OUT's request", r.status === 200 && (r.data.requests || []).some(q => q.id === outRequestId && q.user_id === OUT.userId), show(r));
  const answered = waitFor(outSock, 'community_join_request_updated', 5000, p => p?.communityId === P);
  r = await post(`/api/communities/${P}/join-requests/${outRequestId}/accept`, OWN.token);
  check('accept -> 200', r.status === 200 && r.data.success === true, show(r));
  check("OUT's open page is told: accepted", (await answered)?.status === 'accepted');
  const outRole = await one('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [P, OUT.userId]);
  const reqAfter = await requestRow(P, OUT.userId);
  check('OUT is a Member; request accepted, decided by the owner', outRole?.role === 'Member' && reqAfter?.status === 'accepted' && reqAfter?.decided_by === OWN.userId,
    JSON.stringify({ outRole, reqAfter }));
  check('OUT got the "You\'re in!" notification', !!(await one(
    "SELECT 1 FROM notifications WHERE user_id = ? AND type = 'community_join_accepted' AND target_id = ? AND title LIKE 'You''re in!%'", [OUT.userId, String(P)])));
  r = await get(`/api/communities/${P}`, OUT.token);
  check('now OUT sees the full circle (rules included)', r.data.community?.locked === false && r.data.community?.rules === SECRET_RULES
    && r.data.community?.joinStatus === 'Joined', show(r));
  let reads = [];
  for (const what of ['messages', 'announcements', 'photos', 'events', 'polls', 'members']) reads.push((await get(`/api/communities/${P}/${what}`, OUT.token)).status);
  check('...and every read works', reads.every(s => s === 200), reads.join(','));
  ack = await emitAck(outSock, 'join_community_chat', { communityId: P });
  check('...and the live room admits OUT', ack?.success === true, JSON.stringify(ack));
  r = await post(`/api/communities/${P}/join-requests/${outRequestId}/accept`, OWN.token);
  check('accepting the same request again -> 409 REQUEST_NOT_PENDING', is(r, 409, 'REQUEST_NOT_PENDING'), show(r));
  r = await get(`/api/communities/${P}/join-requests`, OUT.token);
  check('a plain Member cannot see the Requests list -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));

  section('Invite link -> request -> declined by an Admin, 24h cooldown');
  await must('OWN makes OUT an Admin of P', post(`/api/communities/${P}/members/${OUT.userId}/role`, OWN.token, { role: 'Admin' }));
  r = await get(`/api/communities/${P}`, R2.token);
  check('R2 opens the invite link: locked page, "Request to Join"', r.data.community?.locked === true && r.data.community?.joinStatus === 'Request to Join', show(r));
  r = await post(`/api/communities/${P}/join`, R2.token);
  check('an invite link never joins directly -> 403 APPROVAL_REQUIRED', is(r, 403, 'APPROVAL_REQUIRED'), show(r));
  const ownRequestNotesBefore = await notifCount(OWN.userId, 'community_join_request', P);
  r = await post(`/api/communities/${P}/join-request`, R2.token);
  const r2RequestId = r.data.request?.id;
  check('R2 requests -> 201', r.status === 201, show(r));
  check('both the Owner and the new Admin were notified', await notifCount(OWN.userId, 'community_join_request', P) === ownRequestNotesBefore + 1
    && await notifCount(OUT.userId, 'community_join_request', P) === 1);
  r = await post(`/api/communities/${P}/join-requests/${r2RequestId}/decline`, OUT.token);
  check('the Admin declines -> 200', r.status === 200, show(r));
  const r2Row = await requestRow(P, R2.userId);
  check('request declined, decided by the Admin; R2 not a member', r2Row?.status === 'declined' && r2Row?.decided_by === OUT.userId
    && !(await isMember(P, R2.userId)), JSON.stringify(r2Row));
  check('R2 got the decline notification', await notifCount(R2.userId, 'community_join_declined', P) === 1);
  r = await post(`/api/communities/${P}/join-request`, R2.token);
  check('asking again at once -> 429 REQUEST_COOLDOWN, about 24h to wait',
    is(r, 429, 'REQUEST_COOLDOWN') && r.data.retryAfterSeconds > 23 * 3600 && r.data.retryAfterSeconds <= 24 * 3600, show(r));
  r = await get(`/api/communities/${P}`, R2.token);
  check('the page shows when R2 can ask again', !!r.data.community?.requestCooldownUntil && r.data.community?.joinStatus === 'Request to Join', show(r));
  await db.run("UPDATE community_join_requests SET decided_at = NOW() - INTERVAL '25 hours' WHERE id = ?", [r2RequestId]);
  r = await post(`/api/communities/${P}/join-request`, R2.token);
  check('25 hours later -> 201, a new pending request', r.status === 201 && (await requestRow(P, R2.userId))?.status === 'pending', show(r));

  section('Plan limit on accept');
  r = await post(`/api/communities/${P}/join-request`, R3.token);
  const r3RequestId = r.data.request?.id;
  check('R3 (Free, 0 circles) requests -> 201', r.status === 201, show(r));
  for (const id of L) await must(`R3 joins public L #${id}`, post(`/api/communities/${id}/join`, R3.token));
  r = await post(`/api/communities/${P}/join-requests/${r3RequestId}/accept`, OWN.token);
  check('R3 joined 3 circles meanwhile (the Free limit): accept -> 409 REQUESTER_LIMIT_REACHED with a clear message',
    is(r, 409, 'REQUESTER_LIMIT_REACHED') && /Sniffr Free/.test(r.data.message || '') && /leave one or upgrade/.test(r.data.message || ''), show(r));
  check('...R3 not added, request still pending', !(await isMember(P, R3.userId)) && (await requestRow(P, R3.userId))?.status === 'pending');
  await must('R3 leaves L3', post(`/api/communities/${L[2]}/leave`, R3.token));
  r = await post(`/api/communities/${P}/join-requests/${r3RequestId}/accept`, OWN.token);
  check('after leaving one: accept -> 200, R3 is in', r.status === 200 && await isMember(P, R3.userId), show(r));
  r = await post(`/api/communities/${P2}/join-request`, R3.token);
  check('back at the limit, R3 cannot even request another private circle -> 403 COMMUNITY_JOIN_LIMIT_REACHED',
    is(r, 403, 'COMMUNITY_JOIN_LIMIT_REACHED'), show(r));
  await must('OWN makes R3 a Moderator', post(`/api/communities/${P}/members/${R3.userId}/role`, OWN.token, { role: 'Moderator' }));
  r = await get(`/api/communities/${P}/join-requests`, R3.token);
  check('a Moderator cannot manage requests -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));

  section('Expiry after 7 days (P2)');
  r = await post(`/api/communities/${P2}/join-request`, R4.token);
  const r4First = r.data.request?.id;
  check('R4 requests P2 -> 201, expires in about 7 days', r.status === 201
    && Math.abs(new Date(r.data.request?.expiresAt).getTime() - Date.now() - 7 * 86400000) < 10 * 60000, show(r));
  await db.run("UPDATE community_join_requests SET expires_at = NOW() - INTERVAL '1 second' WHERE id = ?", [r4First]);
  r = await get(`/api/communities/${P2}`, R4.token);
  check('past 7 days the page no longer says "Requested"', r.data.community?.joinStatus === 'Request to Join', show(r));
  r = await get(`/api/communities/${P2}/join-requests`, OWN.token);
  check("...and it's gone from the owner's list", r.status === 200 && !(r.data.requests || []).some(q => q.id === r4First), show(r));
  r = await post(`/api/communities/${P2}/join-requests/${r4First}/accept`, OWN.token);
  check('accepting it -> 410 REQUEST_EXPIRED, marked expired, not a member', is(r, 410, 'REQUEST_EXPIRED')
    && (await requestRow(P2, R4.userId))?.status === 'expired' && !(await isMember(P2, R4.userId)), show(r));
  r = await post(`/api/communities/${P2}/join-request`, R4.token);
  check('R4 can ask again right away -> 201', r.status === 201, show(r));
  await db.run("UPDATE community_join_requests SET expires_at = NOW() - INTERVAL '1 second' WHERE community_id = ? AND user_id = ?", [P2, R4.userId]);
  const expiredCount = await expireJoinRequests();
  check('the hourly job marks overdue requests expired', expiredCount >= 1 && (await requestRow(P2, R4.userId))?.status === 'expired', expiredCount);
  r = await post(`/api/communities/${P2}/join-request`, R4.token);
  check('...and R4 can ask again -> 201', r.status === 201, show(r));

  section('Public circles unchanged');
  r = await search(R4, `q=${encodeURIComponent(`Public Pub ${stamp}`)}`);
  c = found(r, PUB);
  check('search shows PUB with full info and "Join"', c?.locked === false && c?.joinStatus === 'Join' && c?.city === `Pubcity${stamp}` && c?.rules === `public rules ${stamp}`, show(r));
  r = await post(`/api/communities/${PUB}/join-request`, R4.token);
  check('a request on a public circle -> 400 NOT_PRIVATE', is(r, 400, 'NOT_PRIVATE'), show(r));
  r = await post(`/api/communities/${PUB}/join`, R4.token);
  check('instant join -> 200 Joined', r.status === 200 && r.data.community?.joinStatus === 'Joined' && await isMember(PUB, R4.userId), show(r));
  check('...and reads work at once', (await get(`/api/communities/${PUB}/messages`, R4.token)).status === 200);

  section('Disabled circle (P2): no new members');
  await must('OWN disables P2', post(`/api/communities/${P2}/disable`, OWN.token));
  const p2Row = await one('SELECT is_private, disabled_at FROM communities WHERE id = ?', [P2]);
  check('disabled_at set, still private', !!p2Row?.disabled_at && p2Row?.is_private === 1, JSON.stringify(p2Row));
  check("R4's pending request was cancelled", (await requestRow(P2, R4.userId))?.status === 'cancelled');
  r = await search(R4, `q=${encodeURIComponent(`Private Two ${stamp}`)}`);
  check('not in search any more', r.status === 200 && !found(r, P2), show(r));
  r = await get(`/api/communities/${P2}`, R4.token);
  check('GET -> 404 COMMUNITY_UNAVAILABLE', is(r, 404, 'COMMUNITY_UNAVAILABLE'), show(r));
  r = await post(`/api/communities/${P2}/join-request`, R4.token);
  check('request -> 404 COMMUNITY_UNAVAILABLE', is(r, 404, 'COMMUNITY_UNAVAILABLE'), show(r));

  section('Frozen circle (F): pending requests cancelled, no new ones');
  r = await post(`/api/communities/${F}/join-request`, FR.token);
  check('FR requests F -> 201', r.status === 201, show(r));
  await deleteUserAccount(FO.userId, { skipCode: true });
  check('FO deleted their account: F is frozen', (await one('SELECT status FROM communities WHERE id = ?', [F]))?.status === 'frozen');
  check("FR's pending request was cancelled", (await requestRow(F, FR.userId))?.status === 'cancelled');
  r = await post(`/api/communities/${F}/join-request`, FR.token);
  check('a new request -> 403 COMMUNITY_READ_ONLY', is(r, 403, 'COMMUNITY_READ_ONLY'), show(r));
  r = await get(`/api/communities/${F}`, FR.token);
  check('the page -> 404 COMMUNITY_UNAVAILABLE for a non-member', is(r, 404, 'COMMUNITY_UNAVAILABLE'), show(r));
  r = await search(FR, `q=${encodeURIComponent(`Frozen F ${stamp}`)}`);
  check('not in search', r.status === 200 && !found(r, F), show(r));

  section('Deleted requester: their request disappears');
  check('R2 has a pending request before', (await requestRow(P, R2.userId))?.status === 'pending');
  await deleteUserAccount(R2.userId, { skipCode: true });
  check("R2's join requests are gone", await n('SELECT count(*)::int AS n FROM community_join_requests WHERE user_id = ?', [R2.userId]) === 0);
  r = await get(`/api/communities/${P}/join-requests`, OWN.token);
  check("...and not in the owner's list", r.status === 200 && !(r.data.requests || []).some(q => q.user_id === R2.userId), show(r));
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
  console.log(`Creates throwaway users private-test-${stamp}-*@example.invalid and their circles, then removes them.`);
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
