// Integration test for the Phase 1 security fixes, against your running
// backend (`npm run dev` on :3001, RESTARTED after the Phase 1 changes) and
// the database in server/.env (production, no real users yet).
//
// Throwaway users A, B (who chat), C, D (who chat, and are outsiders to
// A-B), E (PawPrint 2FA on) and F (created through /auth/social-complete
// with a server-signed ticket). Checks:
//   C1  /auth/google never signs anyone in from a bare email;
//   H2  /auth/social-complete needs a valid sign-up ticket and takes the
//       email from it, not from the body;
//   H1  the 2FA temp token is not a session and carries no readable
//       Supabase tokens; the code step still works;
//   C2  malformed socket events don't take the server down;
//   C3  replyToId can't quote a message from another conversation;
//   H5  blocked users can't message over the socket; only text, pet
//       profile cards and meetups can be sent there;
//   H6  outsiders can't mark a conversation seen or show "typing";
//   C4  nothing is relayed before the callee accepts; only the callee can
//       accept, only participants can end, offers only from the caller;
//   H4  other users never receive pets' coordinates (profile, discover,
//       nearby, search, Spotlight, profile_updated, live location).
// H3 (concurrent Supabase refreshes) needs Supabase-backed accounts and is
// not exercised here. Cleanup removes every test row even if a check fails.
// Never touches user 1.
//
//   node scripts/testSecurityPhase1.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { default: jwt } = await import('jsonwebtoken');
await import('../config.js');
const { default: config } = await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { signPurposeToken } = await import('../middleware/auth.js');
const { default: UserRepo } = await import('../models/UserRepository.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
// South Georgia: no real users nearby. A spot of its own -- Spotlight freezes
// each day's board per exact location in server memory, so sharing one with
// another test script (testDiscoveryFilters uses -54.28,-36.50) would hand
// that script a board of this script's deleted pets.
const COORDS = { lat: -54.4000, lng: -36.6000 };
const mk = key => ({ key, email: `sec1-test-${stamp}-${key}@example.invalid`, username: `sec1${key}_${stamp}`.slice(0, 20) });
const [A, B, C, D, E] = ['a', 'b', 'c', 'd', 'e'].map(mk);
const F = mk('f');

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail !== '' ? ` -- got ${detail}` : ''}`); }
}
const section = title => console.log(`\n── ${title}`);
const show = r => `${r.status} ${JSON.stringify(r.data).slice(0, 200)}`;
const one = (sql, params = []) => db.get(sql, params);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const noCoords = obj => !JSON.stringify(obj ?? null).match(/"(latitude|longitude|last_updated_location_timestamp)"/);

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
const put = (path, token, body) => call('PUT', path, token, body);
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
// Resolves with the first matching payload, or null after `ms`.
const waitFor = (socket, event, ms = 2000, match = () => true) => new Promise(resolve => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  function handler(payload) {
    if (!match(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload ?? true);
  }
  socket.on(event, handler);
});
const emitAck = (socket, event, payload, ms = 6000) => new Promise(resolve => {
  socket.timeout(ms).emit(event, payload, (err, res) => resolve(err ? { timeout: true } : res));
});

async function createUser(spec, created, { withPet = true, twoFactor = false, coords = COORDS } = {}) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified, pawprint_2fa_enabled)
     VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
    [spec.email, spec.username, hash, `Sec Test ${spec.key.toUpperCase()}`, twoFactor ? 1 : 0]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  if (twoFactor) return; // logs in through the 2FA flow in section 2
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
  if (withPet) {
    spec.petName = `Sec${spec.key.toUpperCase()}${stamp}`;
    spec.pet = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, {
      name: spec.petName, pet_username: testPetUsername(`sec${spec.key}`), type: 'dog',
      latitude: coords.lat, longitude: coords.lng,
    }))).id;
  }
}

async function connectSocket(spec, created) {
  const ioClient = loadSocketClient();
  if (!ioClient) throw new Error('socket.io-client not found in client/node_modules');
  const socket = ioClient(API_BASE, { auth: { token: spec.token }, transports: ['websocket'], reconnection: false });
  created.sockets.push(socket);
  const ok = await Promise.race([
    new Promise(res => socket.once('connect', () => res(true))),
    new Promise(res => socket.once('connect_error', () => res(false))),
    sleep(5000).then(() => false),
  ]);
  if (!ok) throw new Error(`${spec.key}'s socket did not connect`);
  spec.socket = socket;
  await sleep(300);
}

// ── 1. Google sign-in and social-complete ──────────────────────────────
async function googleChecks(created) {
  section('1. C1/H2: Google sign-in needs a verified Google token; social-complete needs a ticket');
  const probeEmail = `sec1-probe-${stamp}@example.invalid`;
  const noSession = r => !r.data.accessToken && !r.data.refreshToken && !r.data.signupTicket && !r.data.needsSignup;

  let r = await post('/api/auth/google', null, { email: probeEmail });
  check('email only -> refused, no session, no sign-up prefill', [400, 503].includes(r.status) && noSession(r), show(r));
  r = await post('/api/auth/google', null, { manual: true, email: A.email, name: 'x', google_id: '1' });
  check("the old client's shape with an EXISTING user's email -> refused, no session", [400, 503].includes(r.status) && noSession(r), show(r));
  r = await post('/api/auth/google', null, { accessToken: 'ya29.not-a-real-token' });
  check('a fake access token -> refused', [401, 503].includes(r.status) && noSession(r), show(r));
  if (r.status === 503) console.log('  note: GOOGLE_CLIENT_ID is not set in server/.env, so Google tokens are refused before any check (503)');

  r = await post('/api/auth/social-complete', null, { email: probeEmail, username: `sec1p${String(stamp).slice(-8)}` });
  check('social-complete without a ticket -> 401', r.status === 401 && r.data.error === 'SIGNUP_TICKET_INVALID', show(r));
  const forged = jwt.sign({ purpose: 'google_signup', email: probeEmail }, config.JWT_ACCESS_SECRET, { algorithm: 'HS256' });
  r = await post('/api/auth/social-complete', null, { signupTicket: forged, username: `sec1p${String(stamp).slice(-8)}` });
  check('a ticket signed with the access secret -> 401', r.status === 401, show(r));
  check('...and no account was created for the probe email', !(await one('SELECT id FROM users WHERE email = ?', [probeEmail])));

  // A ticket exactly as /auth/google issues it after verifying Google.
  const ticket = signPurposeToken('google_signup', { email: F.email, name: 'Sec Test F' }, '30m');
  r = await post('/api/auth/social-complete', null, { signupTicket: ticket, username: 'bad name!' });
  check('a valid ticket with an invalid username -> 400 INVALID_USERNAME', r.status === 400 && r.data.error === 'INVALID_USERNAME', show(r));
  r = await post('/api/auth/social-complete', null, { signupTicket: ticket, email: probeEmail, username: F.username });
  if (r.data?.user?.id) created.users.push({ id: r.data.user.id, email: F.email });
  check('a valid ticket signs up (regression: Google sign-up still works)', r.status === 200 && !!r.data.accessToken, show(r));
  check("...with the ticket's email, not the one in the body", r.data?.user?.email === F.email, r.data?.user?.email);
}

// ── 2. PawPrint 2FA temp token ──────────────────────────────────────────
async function twoFactorChecks(created) {
  section('2. H1: the 2FA temp token is not a session');
  await createUser(E, created, { twoFactor: true });
  const login = await post('/api/auth/login', null, { email: E.email, password: PASSWORD });
  check('password login asks for the Paw Code', login.status === 200 && login.data.requires2FA === true && !login.data.accessToken, show(login));
  const temp = login.data.tempToken;
  const payload = JSON.parse(Buffer.from(String(temp).split('.')[1] || '', 'base64url').toString() || '{}');
  check('the temp token carries no readable session tokens', !('sat' in payload) && !('srt' in payload) && payload.purpose === '2fa_login', JSON.stringify(payload));

  let r = await get('/api/auth/me', temp);
  check('temp token as Bearer on /auth/me -> 401', r.status === 401, show(r));
  r = await post('/api/auth/2fa/disable', temp);
  check('temp token as Bearer on /2fa/disable -> 401 (2FA stays on)', r.status === 401
    && (await one('SELECT pawprint_2fa_enabled FROM users WHERE id = ?', [E.userId]))?.pawprint_2fa_enabled === 1, show(r));
  const oldStyle = jwt.sign({ id: E.userId, is2FATemp: true }, config.JWT_ACCESS_SECRET, { expiresIn: '10m', algorithm: 'HS256' });
  r = await get('/api/auth/me', oldStyle);
  check('an old-format temp token (access secret) -> 401', r.status === 401, show(r));

  r = await post('/api/auth/2fa/verify-login', null, { tempToken: temp, code: '000000' });
  check('a wrong code is refused', r.status === 400, show(r));
  const code = '482913';
  await UserRepo.setPawCode(E.userId, crypto.createHash('sha256').update(code).digest('hex'), new Date(Date.now() + 5 * 60000).toISOString());
  r = await post('/api/auth/2fa/verify-login', null, { tempToken: temp, code });
  check('the right code completes the login (regression)', r.status === 200 && !!r.data.accessToken, show(r));
  const me = r.data.accessToken ? await get('/api/auth/me', r.data.accessToken) : { status: 0 };
  check('...and that session works', me.status === 200, show(me));
}

// ── 3. Socket robustness ───────────────────────────────────────────────
async function malformedEvents(ids) {
  section('3. C2: malformed socket events do not crash the server');
  const s = A.socket;
  const events = ['join_conversation', 'leave_conversation', 'typing_start', 'typing_stop', 'send_message', 'messages_seen',
    'react_to_message', 'fetch_back_message', 'call_initiate', 'call_accept', 'call_reject', 'call_end', 'webrtc_offer',
    'webrtc_answer', 'webrtc_ice_candidate', 'call_mute_state', 'join_community_chat', 'leave_community_chat',
    'community_typing', 'send_community_message', 'react_to_community_message', 'fetch_back_community_message', 'join_meet'];
  for (const ev of events) {
    for (const payload of [null, 'x', 42, [1], { conversationId: 'x', messageId: 'x', communityId: 'x', callId: {}, to: 'x' }]) s.emit(ev, payload);
    s.emit(ev);
  }
  await sleep(2500);
  const health = await get('/api/health');
  check('server still healthy after ~140 malformed events', health.status === 200, show(health));
  check("A's socket still connected", s.connected);
  s.emit('join_conversation', { conversationId: ids.convAB });
  await sleep(500);
  const ack = await emitAck(s, 'send_message', { conversationId: ids.convAB, content: `still works ${stamp}`, messageType: 'text', clientTempId: 't1' });
  check('a normal message still sends afterwards', ack?.success === true, JSON.stringify(ack));
}

// ── 4. replyToId ────────────────────────────────────────────────────────
async function replyChecks(ids) {
  section('4. C3: replies can only quote the same conversation');
  C.socket.emit('join_conversation', { conversationId: ids.convCD });
  await sleep(500);
  const secret = await emitAck(C.socket, 'send_message', { conversationId: ids.convCD, content: `SECRET-${stamp}`, messageType: 'text', clientTempId: 's' });
  check('fixture: C sends a private message in C-D', secret?.success === true, JSON.stringify(secret));
  ids.secretMsg = secret?.message?.id;

  const before = (await one('SELECT count(*)::int AS n FROM messages WHERE conversation_id = ?', [ids.convAB])).n;
  const stolen = await emitAck(A.socket, 'send_message', { conversationId: ids.convAB, content: 'quote', messageType: 'text', replyToId: ids.secretMsg, clientTempId: 'r1' });
  check("A quoting C-D's message from A-B -> refused (INVALID_REPLY)", stolen?.success === false && stolen.error === 'INVALID_REPLY', JSON.stringify(stolen));
  check('...the ack carries none of the secret text', !JSON.stringify(stolen).includes('SECRET-'));
  check('...and nothing was saved', (await one('SELECT count(*)::int AS n FROM messages WHERE conversation_id = ?', [ids.convAB])).n === before);

  const orig = await emitAck(A.socket, 'send_message', { conversationId: ids.convAB, content: `hello ${stamp}`, messageType: 'text', clientTempId: 'r2' });
  B.socket.emit('join_conversation', { conversationId: ids.convAB });
  await sleep(500);
  const reply = await emitAck(B.socket, 'send_message', { conversationId: ids.convAB, content: 'reply', messageType: 'text', replyToId: orig?.message?.id, clientTempId: 'r3' });
  check('a reply within the conversation still works, with its preview (regression)',
    reply?.success === true && reply.message?.reply_content === `hello ${stamp}`, JSON.stringify(reply).slice(0, 200));

  // A row poisoned before the fix (reply_to_id pointing into C-D) shows no preview.
  const poisoned = await one("INSERT INTO messages (conversation_id, sender_id, content, message_type, status, reply_to_id) VALUES (?, ?, 'old row', 'text', 'sent', ?) RETURNING id",
    [ids.convAB, A.userId, ids.secretMsg]);
  const list = await get(`/api/chat/messages/${ids.convAB}`, A.token);
  const row = (list.data.messages || list.data || []).find?.(m => m.id === poisoned.id);
  check('an older row quoting another conversation returns no preview', list.status === 200 && row && !row.reply_content && !JSON.stringify(list.data).includes('SECRET-'), row ? JSON.stringify(row).slice(0, 200) : show(list));
}

// ── 5. Blocks and message types ────────────────────────────────────────
async function typeAndBlockChecks(ids) {
  section('5. H5: message types and blocks on the socket');
  const send = (payload, tag) => emitAck(A.socket, 'send_message', { conversationId: ids.convAB, clientTempId: tag, ...payload });
  let r = await send({ messageType: 'image', mediaUrl: 'https://evil.example/pixel.png', content: '' }, 'm1');
  check('an outside image link -> INVALID_MESSAGE', r?.error === 'INVALID_MESSAGE', JSON.stringify(r));
  r = await send({ messageType: 'file', mediaUrl: 'javascript:alert(1)', content: 'doc.pdf' }, 'm2');
  check('a javascript: "file" -> INVALID_MESSAGE', r?.error === 'INVALID_MESSAGE', JSON.stringify(r));
  r = await send({ messageType: 'system', content: 'Your account is suspended' }, 'm3');
  check('a fake system message -> INVALID_MESSAGE', r?.error === 'INVALID_MESSAGE', JSON.stringify(r));
  r = await send({ messageType: 'text', content: 'hi', mediaUrl: 'https://evil.example/x' }, 'm4');
  check('text with a media link -> INVALID_MESSAGE', r?.error === 'INVALID_MESSAGE', JSON.stringify(r));
  r = await send({ messageType: 'pet_profile', content: '🐶 Profile shared', mediaUrl: String(C.pet) }, 'm5');
  check('a pet profile card still sends (regression)', r?.success === true && r.message?.message_type === 'pet_profile', JSON.stringify(r).slice(0, 200));
  r = await send({ messageType: 'meetup', content: JSON.stringify({ place: 'Park', date: '2026-10-10', time: '10:00', status: 'pending' }) }, 'm6');
  check('a meetup invite still sends (regression)', r?.success === true && r.message?.message_type === 'meetup', JSON.stringify(r).slice(0, 200));

  await must('B blocks A', post('/api/profile/block', B.token, { blockedUserId: A.userId }));
  const chatError = waitFor(A.socket, 'chat_error', 3000, p => p?.error === 'BLOCKED');
  r = await send({ messageType: 'text', content: 'are you there?' }, 'm7');
  check('blocked: A cannot message B over the socket', r?.success === false && r.error === 'BLOCKED', JSON.stringify(r));
  check('...and gets a chat_error BLOCKED', !!(await chatError));
  await must('B unblocks A', post('/api/profile/unblock', B.token, { blockedUserId: A.userId }));
  r = await send({ messageType: 'text', content: 'after unblock' }, 'm8');
  check('after unblocking, messages go through again', r?.success === true, JSON.stringify(r));
}

// ── 6. Read receipts and typing ─────────────────────────────────────────
async function membershipChecks(ids) {
  section('6. H6: only participants can mark seen or show typing');
  B.socket.emit('leave_conversation', { conversationId: ids.convAB });
  await sleep(400);
  const fresh = await emitAck(A.socket, 'send_message', { conversationId: ids.convAB, content: `unseen ${stamp}`, messageType: 'text', clientTempId: 'u1' });
  const status = async () => (await one('SELECT status FROM messages WHERE id = ?', [fresh?.message?.id]))?.status;
  check('fixture: a fresh message, not seen yet', fresh?.success === true && (await status()) !== 'seen', await status());
  D.socket.emit('messages_seen', { conversationId: ids.convAB });
  await sleep(1200);
  check("an outsider's messages_seen does nothing", (await status()) !== 'seen', await status());

  const typingFromD = waitFor(A.socket, 'user_typing', 1500, p => p?.userId === D.userId);
  D.socket.emit('typing_start', { conversationId: ids.convAB });
  check('an outsider cannot show "typing" in A-B', !(await typingFromD));

  B.socket.emit('join_conversation', { conversationId: ids.convAB });
  await sleep(800);
  B.socket.emit('messages_seen', { conversationId: ids.convAB });
  await sleep(1200);
  check("the participant's read receipt still works (regression)", (await status()) === 'seen', await status());
  const typingFromB = waitFor(A.socket, 'user_typing', 2000, p => p?.userId === B.userId && p.isTyping);
  B.socket.emit('typing_start', { conversationId: ids.convAB });
  check("the participant's typing indicator still works (regression)", !!(await typingFromB));
  B.socket.emit('typing_stop', { conversationId: ids.convAB });
}

// ── 7. Calls ────────────────────────────────────────────────────────────
async function callChecks() {
  section('7. C4: ringing -> accepted -> media negotiation');
  const selfError = waitFor(A.socket, 'call_error', 2000);
  A.socket.emit('call_initiate', { to: A.userId, type: 'audio' });
  check('calling yourself -> call_error', !!(await selfError));

  const incoming = waitFor(B.socket, 'call_incoming', 4000);
  const ringing = waitFor(A.socket, 'call_ringing', 4000);
  A.socket.emit('call_initiate', { to: B.userId, type: 'audio' });
  const inc = await incoming;
  const ring = await ringing;
  check('fixture: B is ringing', !!inc?.callId && ring?.callId === inc.callId, JSON.stringify(inc));
  const callId = inc?.callId;

  let early = waitFor(B.socket, 'webrtc_offer', 1500);
  A.socket.emit('webrtc_offer', { to: B.userId, sdp: { type: 'offer', sdp: 'v=0' } });
  check('an offer while still ringing is NOT delivered to the callee', !(await early));
  early = waitFor(B.socket, 'webrtc_ice_candidate', 1500);
  A.socket.emit('webrtc_ice_candidate', { to: B.userId, candidate: { candidate: 'x' } });
  check('...nor ICE candidates', !(await early));

  let connected = waitFor(A.socket, 'call_connected', 1500);
  A.socket.emit('call_accept', { callId });
  check('the CALLER cannot accept their own call', !(await connected));
  connected = waitFor(B.socket, 'call_connected', 1500);
  C.socket.emit('call_accept', { callId });
  check('an outsider cannot accept it', !(await connected));

  const aConn = waitFor(A.socket, 'call_connected', 3000);
  const bConn = waitFor(B.socket, 'call_connected', 3000);
  B.socket.emit('call_accept', { callId });
  check('the callee accepts -> both connected (regression)', !!(await aConn) && !!(await bConn));

  const offer = waitFor(B.socket, 'webrtc_offer', 2000);
  A.socket.emit('webrtc_offer', { to: B.userId, sdp: { type: 'offer', sdp: 'v=0' } });
  check("after accept, the caller's offer reaches the callee (regression)", !!(await offer));
  const reverse = waitFor(A.socket, 'webrtc_offer', 1500);
  B.socket.emit('webrtc_offer', { to: A.userId, sdp: { type: 'offer', sdp: 'v=0' } });
  check('the callee cannot send offers (only the caller offers)', !(await reverse));
  const answer = waitFor(A.socket, 'webrtc_answer', 2000);
  B.socket.emit('webrtc_answer', { to: A.userId, sdp: { type: 'answer', sdp: 'v=0' } });
  check("the callee's answer reaches the caller (regression)", !!(await answer));
  const ice1 = waitFor(B.socket, 'webrtc_ice_candidate', 2000);
  const ice2 = waitFor(A.socket, 'webrtc_ice_candidate', 2000);
  A.socket.emit('webrtc_ice_candidate', { to: B.userId, candidate: { candidate: 'a' } });
  B.socket.emit('webrtc_ice_candidate', { to: A.userId, candidate: { candidate: 'b' } });
  check('ICE candidates flow both ways (regression)', !!(await ice1) && !!(await ice2));

  let ended = waitFor(B.socket, 'call_ended', 1500);
  C.socket.emit('call_end', { callId });
  check('an outsider cannot end the call', !(await ended));
  ended = waitFor(B.socket, 'call_ended', 3000);
  A.socket.emit('call_end', { callId });
  check('a participant ends it (regression)', !!(await ended));
}

// ── 8. GPS ──────────────────────────────────────────────────────────────
async function gpsChecks() {
  section('8. H4: other users never get coordinates');
  let r = await get(`/api/profile/${B.pet}`, A.token);
  check("B's profile as seen by A has no coordinates", r.status === 200 && noCoords(r.data.pet), show(r));
  r = await get(`/api/profile/${A.pet}`, A.token);
  check('A still sees their OWN coordinates (edit form)', r.status === 200 && r.data.pet?.latitude != null, show(r));
  r = await get(`/api/matches/discover?lat=${COORDS.lat}&lng=${COORDS.lng}&radius=50`, A.token);
  // D, not B: A and B chat, and Meet never shows someone you chat with
  // (MatchRepository.getExcludedMeetPetIds).
  const dInDiscover = (r.data.pets || []).find(p => p.id === D.pet);
  check('discover lists D with a distance', r.status === 200 && dInDiscover && typeof dInDiscover.distance === 'number', show(r));
  check('...and no coordinates for anyone', noCoords(r.data.pets));
  r = await get(`/api/chat/nearby?lat=${COORDS.lat}&lng=${COORDS.lng}&radius=50`, A.token);
  check('chat "nearby" has no coordinates', r.status === 200 && noCoords(r.data.pets), show(r));
  r = await get(`/api/chat/search?q=${encodeURIComponent(B.petName)}`, A.token);
  check('chat search has no coordinates', r.status === 200 && noCoords(r.data.results), show(r));
  r = await get(`/api/spotlight?area=locality&lat=${COORDS.lat}&lng=${COORDS.lng}`, A.token);
  check('Spotlight has no coordinates', r.status === 200 && noCoords(r.data), show(r));

  const updated = waitFor(A.socket, 'profile_updated', 4000, p => p?.pet_id === B.pet);
  await must('B edits bio', put('/api/profile', B.token, { bio: `bio ${stamp}` }));
  const upd = await updated;
  check('the profile_updated broadcast carries no coordinates', !!upd && noCoords(upd), upd ? JSON.stringify(upd).slice(0, 200) : 'no event');

  A.socket.emit('join_meet', { lat: COORDS.lat, lng: COORDS.lng });
  await sleep(500);
  const live = waitFor(A.socket, 'location_updated', 4000, p => p?.pet_id === B.pet);
  await must('B moves', post('/api/profile/location', B.token, { latitude: COORDS.lat + 0.01, longitude: COORDS.lng }));
  const lv = await live;
  check('a live move reaches the Meet viewer as a distance', !!lv && typeof lv.distance === 'number' && Math.abs(lv.distance - 1.11) < 0.1, JSON.stringify(lv)?.slice(0, 200));
  // The event's own last_updated_location_timestamp is just when it moved
  // (the moment of this event); the coordinates are what must never appear.
  check('...with no coordinates anywhere', !!lv && !JSON.stringify(lv).match(/"(latitude|longitude)"/)
    && !('last_updated_location_timestamp' in (lv.pet || {})) && !JSON.stringify(lv).includes(String(COORDS.lat + 0.01)), JSON.stringify(lv)?.slice(0, 600));
  A.socket.emit('leave_meet');
}

async function runTests(created) {
  section('Setup');
  for (const s of [A, B, C, D]) await createUser(s, created, { coords: s === B ? { lat: COORDS.lat + 0.005, lng: COORDS.lng } : COORDS });
  for (const s of [A, B, C, D]) await connectSocket(s, created);
  const ids = created.ids;
  ids.convAB = (await must('A-B conversation', post('/api/chat/conversations', A.token, { recipientPetId: B.pet }))).conversation?.id;
  ids.convCD = (await must('C-D conversation', post('/api/chat/conversations', C.token, { recipientPetId: D.pet }))).conversation?.id;
  if (!ids.convAB || !ids.convCD) throw new Error('fixture: conversations not created');
  A.socket.emit('join_conversation', { conversationId: ids.convAB });
  await sleep(500);
  console.log(`  A #${A.userId}, B #${B.userId}, C #${C.userId}, D #${D.userId}; conversations A-B #${ids.convAB}, C-D #${ids.convCD}`);

  await googleChecks(created);
  await twoFactorChecks(created);
  await malformedEvents(ids);
  await replyChecks(ids);
  await typeAndBlockChecks(ids);
  await membershipChecks(ids);
  await callChecks();
  await gpsChecks();
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  for (const socket of created.sockets) socket.disconnect();
  if (!created.users.length) { console.log('  nothing to clean up'); return; }
  await withTransaction(async tx => {
    const users = created.users.map(u => u.id);
    for (const { id, email } of created.users) {
      const row = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!row) continue;
      if (row.email !== email || row.is_admin || id === PROTECTED_USER_ID) throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
    }
    const list = async (sql, params) => (await tx.all(sql, params)).map(r => r.id);
    const pets = await list('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [users]);
    const matches = await list('SELECT id FROM matches WHERE pet1_id = ANY(?::int[]) OR pet2_id = ANY(?::int[])', [pets, pets]);
    const convs = await list('SELECT id FROM conversations WHERE match_id = ANY(?::int[])', [matches]);
    const msgs = await list('SELECT id FROM messages WHERE conversation_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [convs, users]);
    const steps = [
      ['message_reactions', 'user_id = ANY(?::int[]) OR message_id = ANY(?::int[])', [users, msgs]],
      ['messages', 'id = ANY(?::int[])', [msgs]],
      ['conversations', 'id = ANY(?::int[])', [convs]],
      ['matches', 'id = ANY(?::int[])', [matches]],
      ['calls', 'caller_pet_id = ANY(?::int[]) OR receiver_pet_id = ANY(?::int[])', [pets, pets]],
      ['swipes', 'from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [pets, pets]],
      ['profile_views', 'viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [pets, pets]],
      ['spotlight_rank_tracking', 'pet_id = ANY(?::int[])', [pets]],
      ['spotlight_history', 'pet_id = ANY(?::int[])', [pets]], // the Spotlight check can record a test pet
      ['notifications', 'user_id = ANY(?::int[]) OR sender_pet_id = ANY(?::int[])', [users, pets]],
      ['blocked_users', 'blocker_id = ANY(?::int[]) OR blocked_id = ANY(?::int[])', [users, users]],
      ['plan_history', 'user_id = ANY(?::int[])', [users]],
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
    await tx.run('UPDATE users SET active_pet_id = NULL WHERE id = ANY(?::int[])', [users]);
    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} test users and ${petDel.rowCount} pets`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}   Backend: ${API_BASE}`);
  console.log(`Creates throwaway users sec1-test-${stamp}-{a..f}@example.invalid, runs the checks, then deletes them.`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "production" to continue: ');
  rl.close();
  if (answer.trim() !== 'production') { console.log('Aborted -- nothing was done.'); return; }
  try {
    const health = await fetch(`${API_BASE}/api/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (err) {
    console.error(`Backend not reachable at ${API_BASE} (${err.message}). Start it with "npm run dev" first.`);
    process.exitCode = 1;
    return;
  }
  // Refuse to run against a backend still serving the old /auth/google
  // (it would sign a bare email in -- and the old social-complete would
  // create accounts from the probes).
  const probe = await post('/api/auth/google', null, { email: `sec1-precheck-${stamp}@example.invalid` });
  if (probe.status === 200) {
    console.error('The backend is still running the OLD code (/auth/google accepted a bare email). Restart it, then run this again.');
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
