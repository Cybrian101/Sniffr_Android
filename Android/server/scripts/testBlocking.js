// Integration test for blocking (H11), against your running backend (`npm
// run dev` on :3001, RESTARTED after the blocking changes) and the database
// in server/.env (production, no real users yet).
//
// Throwaway users: A (blocks B), B (blocked) and C (control: blocks nobody,
// so everything between C and the others must keep working). Before the
// block, B chats with A, sends A a sniff request and comments on A's post.
// Then A blocks B, and the test checks that, in BOTH directions:
//   - no DMs (socket and REST), no new chat, no share, no reaction, no meetup
//     answer, no typing, no call; the chat is read-only (flags);
//   - no Meet card, search or nearby result; no sniff, no accepting the old
//     request (Pending tab or notification); the request is hidden;
//   - no seeing, liking, reacting to, commenting on or sharing each other's
//     posts; old comments/notifications between them hidden; no replying to
//     each other's comments elsewhere; no mention notification;
//   - no realtime new_post / post_commented / online presence;
//   - the blocker sees "You blocked" (+ the Settings list), the blocked user
//     sees nothing;
// that C is unaffected; that the block survives a fresh login; and that
// after A unblocks B everything works again. Meet is checked with D (see
// below), a pair no other Meet rule hides.
// Cleanup removes every test row even if a check fails. Never touches user 1.
//
//   node scripts/testBlocking.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
// South Georgia: no real users nearby. A spot of its own -- Spotlight freezes
// each day's board per exact location in server memory, so sharing one with
// another test script would hand that script a board of deleted pets.
const COORDS = { lat: -54.5000, lng: -36.8000 };
const mk = key => ({ key, email: `block-test-${stamp}-${key}@example.invalid`, username: `blk${key}_${stamp}`.slice(0, 20) });
// D only ever meets A in Meet: no chat or sniff request between them, so
// Meet's own rules (it hides pets you chat with or have a live request with,
// MatchRepository.getExcludedMeetPetIds) never apply, and the Meet checks
// test the block alone. A-B do chat, so A never shows in B's deck anyway.
const [A, B, C, D] = ['a', 'b', 'c', 'd'].map(mk);

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
const isBlocked = r => r.status === 403 && r.data?.error === 'BLOCKED';

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

async function login(spec) {
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
}

async function createUser(spec, created, coords) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  spec.userId = (await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified) VALUES (?, ?, ?, ?, 1) RETURNING id`,
    [spec.email, spec.username, hash, `Block Test ${spec.key.toUpperCase()}`])).id;
  created.users.push({ id: spec.userId, email: spec.email });
  await login(spec);
  spec.petName = `Blk${spec.key.toUpperCase()}${stamp}`;
  spec.handle = testPetUsername(`blk${spec.key}`);
  spec.pet = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, {
    name: spec.petName, pet_username: spec.handle, type: 'dog', latitude: coords.lat, longitude: coords.lng,
  }))).id;
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
  return socket;
}

const feedIds = async (spec) => ((await get('/api/posts?limit=50', spec.token)).data.posts || []).map(p => p.id);
const discoverIds = async (spec) => ((await get(`/api/matches/discover?lat=${COORDS.lat}&lng=${COORDS.lng}&radius=50`, spec.token)).data.pets || []).map(p => p.id);
const searchIds = async (spec, q) => ((await get(`/api/chat/search?q=${encodeURIComponent(q)}`, spec.token)).data.results || []).map(p => p.id);
const nearbyIds = async (spec) => ((await get(`/api/chat/nearby?lat=${COORDS.lat}&lng=${COORDS.lng}&radius=50`, spec.token)).data.pets || []).map(p => p.id);
const commentIds = async (spec, postId) => ((await get(`/api/posts/${postId}/comments`, spec.token)).data.comments || []).map(c => c.id);
const conv = async (spec, id) => ((await get('/api/chat/conversations', spec.token)).data.conversations || []).find(c => c.id === id);
const notifIds = async (spec) => ((await get('/api/notifications?limit=100', spec.token)).data.notifications || []).map(n => n.id);

async function runTests(created) {
  const ids = created.ids;
  section('Setup (before any block)');
  await createUser(A, created, COORDS);
  await createUser(B, created, { lat: COORDS.lat + 0.004, lng: COORDS.lng });
  await createUser(C, created, { lat: COORDS.lat + 0.008, lng: COORDS.lng });
  await createUser(D, created, { lat: COORDS.lat + 0.012, lng: COORDS.lng });
  for (const s of [A, B, C]) await connectSocket(s, created);
  ids.convAB = (await must('A-B chat', post('/api/chat/conversations', B.token, { recipientPetId: A.pet }))).conversation.id;
  for (const s of [A, B]) s.socket.emit('join_conversation', { conversationId: ids.convAB });
  await sleep(600);
  const aMsg = await emitAck(A.socket, 'send_message', { conversationId: ids.convAB, content: `hi B ${stamp}`, messageType: 'text', clientTempId: 'x1' });
  const meetup = await emitAck(A.socket, 'send_message', { conversationId: ids.convAB, content: JSON.stringify({ location: 'Park', date_time: 'Sat', status: 'pending' }), messageType: 'meetup', clientTempId: 'x2' });
  ids.aMsg = aMsg?.message?.id;
  ids.meetup = meetup?.message?.id;
  ids.postA = (await must('A posts', post('/api/posts', A.token, { caption: `A post ${stamp}` }))).id;
  ids.postC = (await must('C posts', post('/api/posts', C.token, { caption: `C post ${stamp}` }))).id;
  ids.bOldComment = (await must('B comments on A', post(`/api/posts/${ids.postA}/comment`, B.token, { content: `nice ${stamp}` }))).id;
  ids.aCommentOnC = (await must('A comments on C', post(`/api/posts/${ids.postC}/comment`, A.token, { content: `A on C ${stamp}` }))).id;
  await must('B sniffs A', post(`/api/matches/like/${A.pet}`, B.token));
  await sleep(6000); // the 5s undo window commits the request
  ids.requestNotif = (await one("SELECT id FROM notifications WHERE user_id = ? AND type = 'match_request' AND sender_pet_id = ? ORDER BY id DESC LIMIT 1", [A.userId, B.pet]))?.id;
  ids.commentNotif = (await one("SELECT id FROM notifications WHERE user_id = ? AND type = 'comment' AND sender_pet_id = ? ORDER BY id DESC LIMIT 1", [A.userId, B.pet]))?.id;
  check('fixture: chat, posts, comments, sniff request and notifications exist',
    !!(ids.aMsg && ids.meetup && ids.postA && ids.bOldComment && ids.requestNotif && ids.commentNotif), JSON.stringify(ids));
  check("before: B sees A's post in the feed", (await feedIds(B)).includes(ids.postA));
  check('before: B finds A in search', (await searchIds(B, A.petName)).includes(A.pet));
  check('before: D sees A in Meet and A sees D', (await discoverIds(D)).includes(A.pet) && (await discoverIds(A)).includes(D.pet));

  section('1. Blocking itself');
  let r = await post('/api/profile/block', A.token, { blockedUserId: A.userId });
  check('blocking yourself -> 400 CANNOT_BLOCK_SELF', r.status === 400 && r.data.error === 'CANNOT_BLOCK_SELF', show(r));
  r = await post('/api/profile/block', A.token, { blockedUserId: 'abc' });
  check('an invalid id -> 400', r.status === 400, show(r));
  r = await post('/api/profile/block', A.token, { blockedUserId: 2147480000 });
  check('a user that does not exist -> 404', r.status === 404, show(r));
  const aEvent = waitFor(A.socket, 'block_updated', 3000, p => p?.userId === B.userId && p.blockedByMe === true);
  const bEvent = waitFor(B.socket, 'block_updated', 1500);
  r = await post('/api/profile/block', A.token, { blockedUserId: B.userId });
  check('A blocks B -> 200 blockedByMe', r.status === 200 && r.data.blockedByMe === true, show(r));
  check("A's other devices get block_updated", !!(await aEvent));
  check('B is not told', !(await bEvent));
  r = await get('/api/profile/blocked', A.token);
  const listed = (r.data.blocked || []).find(x => x.user_id === B.userId);
  check("A's Blocked accounts list shows B with B's pet", r.status === 200 && listed?.pet_id === B.pet && listed?.pet_name === B.petName, show(r));
  r = await get('/api/profile/blocked', B.token);
  check("B's list is empty (it never reveals who blocked you)", r.status === 200 && (r.data.blocked || []).length === 0 && !(r.data.blockedUserIds || []).includes(A.userId), show(r));

  r = await post('/api/profile/block', A.token, { blockedUserId: D.userId });
  check('A blocks D too (the Meet-only pair)', r.status === 200 && r.data.blockedByMe === true, show(r));

  section('2. Messages and calls (both directions)');
  for (const [from, label] of [[B, 'B -> A'], [A, 'A -> B']]) {
    const ack = await emitAck(from.socket, 'send_message', { conversationId: ids.convAB, content: 'hello?', messageType: 'text', clientTempId: `b${from.key}` });
    check(`${label}: socket message refused (BLOCKED)`, ack?.success === false && ack.error === 'BLOCKED', JSON.stringify(ack));
  }
  r = await post('/api/chat/conversations', B.token, { recipientPetId: A.pet });
  check('B cannot (re)open a chat with A', isBlocked(r), show(r));
  r = await post('/api/chat/share', B.token, { postId: ids.postC, recipientPetId: A.pet });
  check('B cannot share a post to A', isBlocked(r), show(r));
  const reactErr = waitFor(B.socket, 'chat_error', 3000, p => p?.error === 'BLOCKED');
  B.socket.emit('react_to_message', { messageId: ids.aMsg, reaction: '❤️' });
  check("B cannot react to A's message", !!(await reactErr));
  r = await post(`/api/chat/meetup/${ids.meetup}`, B.token, { status: 'accepted' });
  check("B cannot answer A's meetup invite", isBlocked(r), show(r));
  const typing = waitFor(A.socket, 'user_typing', 1500, p => p?.userId === B.userId);
  B.socket.emit('typing_start', { conversationId: ids.convAB });
  check('B\'s "typing" never reaches A', !(await typing));
  const callErr = waitFor(B.socket, 'call_error', 3000);
  const ringing = waitFor(A.socket, 'call_incoming', 1500);
  B.socket.emit('call_initiate', { to: A.userId, type: 'audio' });
  check('B cannot call A', !!(await callErr) && !(await ringing));
  const cA = await conv(A, ids.convAB);
  const cB = await conv(B, ids.convAB);
  check("A's chat list marks the chat blocked, by A", cA?.blocked === true && cA?.blocked_by_me === true, JSON.stringify(cA && { b: cA.blocked, m: cA.blocked_by_me }));
  check("B's chat list marks it blocked, not by B", cB?.blocked === true && cB?.blocked_by_me === false, JSON.stringify(cB && { b: cB.blocked, m: cB.blocked_by_me }));

  section('3. Meet, search, requests');
  check("D is not in A's Meet deck, A not in D's", !(await discoverIds(A)).includes(D.pet) && !(await discoverIds(D)).includes(A.pet));
  check('...C still is in both (control)', (await discoverIds(A)).includes(C.pet) && (await discoverIds(D)).includes(C.pet));
  check('search and nearby hide them from each other', !(await searchIds(B, A.petName)).includes(A.pet) && !(await nearbyIds(B)).includes(A.pet)
    && !(await nearbyIds(A)).includes(B.pet));
  r = await post(`/api/matches/like/${A.pet}`, B.token);
  check('B cannot sniff A', isBlocked(r), show(r));
  r = await get('/api/matches/activity', A.token);
  check("B's old request is hidden from A's Pending", r.status === 200 && !(r.data.pending || []).some(p => p.pet_id === B.pet), show(r));
  r = await get('/api/matches/activity', B.token);
  check("...and from B's Requested", r.status === 200 && !(r.data.requested || []).some(p => p.pet_id === A.pet), show(r));
  r = await post(`/api/matches/pending/${B.pet}/respond`, A.token, { action: 'accept' });
  check("A cannot accept B's request (Pending tab)", isBlocked(r), show(r));
  r = await post(`/api/notifications/match-request/${ids.requestNotif}/respond`, A.token, { action: 'accept' });
  check("A cannot accept it from the notification either", isBlocked(r), show(r));
  check('...no match was created', !(await one('SELECT id FROM matches WHERE ((pet1_id = ? AND pet2_id = ?) OR (pet1_id = ? AND pet2_id = ?)) AND source = ?', [A.pet, B.pet, B.pet, A.pet, 'meet'])));

  section('4. Posts, comments, mentions');
  ids.postB = (await must('B posts', post('/api/posts', B.token, { caption: `B post ${stamp}` }))).id;
  check("B doesn't see A's post in the feed, A doesn't see B's", !(await feedIds(B)).includes(ids.postA) && !(await feedIds(A)).includes(ids.postB));
  check("...C sees both (control)", (await feedIds(C)).includes(ids.postA) && (await feedIds(C)).includes(ids.postB));
  for (const [label, req] of [
    ['open', () => get(`/api/posts/${ids.postA}`, B.token)],
    ['like', () => post(`/api/posts/${ids.postA}/like`, B.token)],
    ['react to', () => post(`/api/posts/${ids.postA}/react`, B.token, { reaction: 'paw' })],
    ['comment on', () => post(`/api/posts/${ids.postA}/comment`, B.token, { content: 'hey' })],
    ['share', () => post(`/api/posts/${ids.postA}/share`, B.token)],
    ['read the comments of', () => get(`/api/posts/${ids.postA}/comments`, B.token)],
    ['see who reacted to', () => get(`/api/posts/${ids.postA}/reactions`, B.token)],
  ]) {
    r = await req();
    check(`B cannot ${label} A's post`, isBlocked(r), show(r));
  }
  r = await post(`/api/posts/${ids.postB}/like`, A.token);
  check("A cannot like B's post either", isBlocked(r), show(r));
  check("B's old comment on A's post is hidden from A", !(await commentIds(A, ids.postA)).includes(ids.bOldComment));
  check('...but C still sees it (control)', (await commentIds(C, ids.postA)).includes(ids.bOldComment));
  r = await post(`/api/posts/${ids.postC}/comment`, B.token, { content: 'reply', parentCommentId: ids.aCommentOnC });
  check("B cannot reply to A's comment on C's post", isBlocked(r), show(r));
  const cLive = waitFor(C.socket, 'post_commented', 4000, p => p?.post_id === ids.postC);
  const aLive = waitFor(A.socket, 'post_commented', 2500, p => p?.post_id === ids.postC);
  const bOnC = await post(`/api/posts/${ids.postC}/comment`, B.token, { content: `B on C ${stamp}` });
  check("B can still comment on C's post (control)", bOnC.status === 201, show(bOnC));
  check('...C gets it live, A does not', !!(await cLive) && !(await aLive));
  check("...and A doesn't see it in C's comments, C does", !(await commentIds(A, ids.postC)).includes(bOnC.data.id) && (await commentIds(C, ids.postC)).includes(bOnC.data.id));

  const aNew = waitFor(A.socket, 'new_post', 2500);
  const cNew = waitFor(C.socket, 'new_post', 4000);
  const mention = await must('B posts mentioning A and C', post('/api/posts', B.token, { caption: `hey @${A.handle} and @${C.handle} ${stamp}` }));
  check("B's new post reaches C live, not A", !!(await cNew) && !(await aNew));
  await sleep(800);
  const mentionNotif = async u => one("SELECT id FROM notifications WHERE user_id = ? AND type = 'mention' AND target_id = ?", [u.userId, String(mention.id)]);
  check('mentioning A sends A no notification', !(await mentionNotif(A)));
  check('...mentioning C still notifies C (control)', !!(await mentionNotif(C)));

  section('5. Profiles, notifications, presence');
  r = await get(`/api/profile/${A.pet}`, B.token);
  check("B cannot view A's profile", isBlocked(r), show(r));
  r = await get(`/api/profile/${B.pet}`, A.token);
  check('A sees "You blocked" with just the pet basics (no posts, no stats)', r.status === 200 && r.data.blocked_by_me === true
    && r.data.pet?.id === B.pet && (r.data.posts || []).length === 0 && r.data.pet.total_likes === undefined, show(r));
  const aNotifs = await notifIds(A);
  check("B's earlier notifications are hidden from A", !aNotifs.includes(ids.requestNotif) && !aNotifs.includes(ids.commentNotif));
  const unreadBefore = (await get('/api/notifications/unread-count', A.token)).data;
  const unreadRaw = (await one('SELECT count(*)::int AS n FROM notifications WHERE user_id = ? AND is_read = 0', [A.userId])).n;
  const unreadShown = unreadBefore.unreadCount ?? unreadBefore.count;
  check("...and left out of A's unread badge", typeof unreadShown === 'number' && unreadShown < unreadRaw, `${JSON.stringify(unreadBefore)} vs ${unreadRaw} stored`);

  B.socket.disconnect();
  await sleep(800);
  const aOnline = waitFor(A.socket, 'user_online', 2500, p => p?.userId === B.userId);
  const cOnline = waitFor(C.socket, 'user_online', 4000, p => p?.userId === B.userId);
  await connectSocket(B, created);
  check("B coming online is not shown to A, is shown to C", !(await aOnline) && !!(await cOnline));

  section('6. Persistence: a fresh login');
  await login(A);
  await login(B);
  r = await get('/api/profile/blocked', A.token);
  check('after logging in again, A still has B blocked', (r.data.blocked || []).some(x => x.user_id === B.userId), show(r));
  r = await post(`/api/posts/${ids.postA}/like`, B.token);
  check('...and B is still refused', isBlocked(r), show(r));

  section('7. Unblocking');
  r = await post('/api/profile/unblock', B.token, { blockedUserId: A.userId });
  check("B can't lift A's block (only the blocker can)", (await get('/api/profile/blocked', A.token)).data.blocked?.some(x => x.user_id === B.userId), show(r));
  const unEvent = waitFor(A.socket, 'block_updated', 3000, p => p?.userId === B.userId && p.blockedByMe === false);
  r = await post('/api/profile/unblock', A.token, { blockedUserId: B.userId });
  check('A unblocks B -> 200', r.status === 200 && r.data.blockedByMe === false, show(r));
  check("A's devices get block_updated", !!(await unEvent));
  check("A's Blocked accounts list no longer has B", !((await get('/api/profile/blocked', A.token)).data.blocked || []).some(x => x.user_id === B.userId));

  await connectSocket(B, created); // the fresh login's token
  for (const s of [A, B]) s.socket.emit('join_conversation', { conversationId: ids.convAB });
  await sleep(700);
  const ack = await emitAck(B.socket, 'send_message', { conversationId: ids.convAB, content: `back ${stamp}`, messageType: 'text', clientTempId: 'u1' });
  check('B can message A again', ack?.success === true, JSON.stringify(ack));
  const typingBack = waitFor(A.socket, 'user_typing', 2500, p => p?.userId === B.userId);
  B.socket.emit('typing_start', { conversationId: ids.convAB });
  check('...and "typing" shows again', !!(await typingBack));
  B.socket.emit('typing_stop', { conversationId: ids.convAB });
  const c2 = await conv(B, ids.convAB);
  check('the chat is no longer marked blocked', c2?.blocked === false, JSON.stringify(c2 && { b: c2.blocked }));
  check("B sees A's post in the feed again", (await feedIds(B)).includes(ids.postA));
  check('B finds A in search again', (await searchIds(B, A.petName)).includes(A.pet));
  r = await post('/api/profile/unblock', A.token, { blockedUserId: D.userId });
  check('A unblocks D -> 200', r.status === 200, show(r));
  check('D sees A in Meet again and A sees D', (await discoverIds(D)).includes(A.pet) && (await discoverIds(A)).includes(D.pet));
  check("A's Blocked accounts list is empty again", ((await get('/api/profile/blocked', A.token)).data.blocked || []).length === 0);
  r = await post(`/api/posts/${ids.postA}/like`, B.token);
  check("B can like A's post again", r.status === 200, show(r));
  r = await post(`/api/posts/${ids.postA}/comment`, B.token, { content: `again ${stamp}` });
  check('...and comment on it', r.status === 201, show(r));
  r = await get(`/api/profile/${A.pet}`, B.token);
  check("B can view A's profile again", r.status === 200 && r.data.pet?.id === A.pet && !r.data.blocked_by_me, show(r));
  check("B's old comment is visible to A again", (await commentIds(A, ids.postA)).includes(ids.bOldComment));
  check("B's earlier notifications show for A again", (await notifIds(A)).includes(ids.commentNotif));
  r = await post(`/api/matches/pending/${B.pet}/respond`, A.token, { action: 'accept' });
  check("A can now accept B's request -> match", r.status === 200 && r.data.matched === true, show(r));
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
    const posts = await list('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [pets]);
    const steps = [
      ['message_reactions', 'user_id = ANY(?::int[]) OR message_id = ANY(?::int[])', [users, msgs]],
      ['messages', 'id = ANY(?::int[])', [msgs]],
      ['conversations', 'id = ANY(?::int[])', [convs]],
      ['matches', 'id = ANY(?::int[])', [matches]],
      ['calls', 'caller_pet_id = ANY(?::int[]) OR receiver_pet_id = ANY(?::int[])', [pets, pets]],
      ['swipes', 'from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [pets, pets]],
      ['profile_views', 'viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [pets, pets]],
      ['spotlight_history', 'pet_id = ANY(?::int[])', [pets]],
      ['spotlight_rank_tracking', 'pet_id = ANY(?::int[])', [pets]],
      ['likes', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['reactions', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['shares', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['post_reports', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['comments', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['posts', 'id = ANY(?::int[])', [posts]],
      ['notifications', 'user_id = ANY(?::int[]) OR sender_pet_id = ANY(?::int[])', [users, pets]],
      ['blocked_users', 'blocker_id = ANY(?::int[]) OR blocked_id = ANY(?::int[])', [users, users]],
      ['media_files', 'user_id = ANY(?::int[])', [users]],
      ['notification_preferences', 'user_id = ANY(?::int[])', [users]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [users]],
      ['trusted_devices', 'user_id = ANY(?::int[])', [users]],
      ['verification_codes', 'user_id = ANY(?::int[])', [users]],
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
    await tx.run('UPDATE users SET active_pet_id = NULL WHERE id = ANY(?::int[])', [users]);
    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} test users and ${petDel.rowCount} pets`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}   Backend: ${API_BASE}`);
  console.log(`Creates throwaway users block-test-${stamp}-{a,b,c}@example.invalid, runs the checks, then deletes them.`);
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
  // The blocked-accounts list only reports people you blocked since this
  // change; the old server returned { blockedUserIds } only. Refuse to run
  // against an old backend (its results would be meaningless).
  const precheck = await post('/api/auth/google', null, { email: `block-precheck-${stamp}@example.invalid` });
  if (precheck.status === 200) {
    console.error('The backend is still running OLD code. Restart it (npm run dev), then run this again.');
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
