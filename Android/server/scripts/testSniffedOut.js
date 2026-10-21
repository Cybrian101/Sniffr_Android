// Integration test: once an account is SniffedOut (tombstoned), everything it
// left behind is still shown -- flagged and named "SniffedOut" -- and every
// action aimed at it is refused with 403 SNIFFED_OUT. Talks to the LOCAL
// backend (your `npm run dev` on :3001), same database as this script --
// currently production, no real users yet.
//
// Creates TWO throwaway users (A and B) with one pet each, builds real
// interactions between them (match + chat with a reply, comment/like/
// reaction on A's post, notifications, a call, a PawCircle owned by B with a
// message/announcement/poll/event, a Spotlight win), then tombstones B the way
// the real deletion does (deleted_at on user and pet, pet name "SniffedOut",
// no avatar) and checks everything from A's side. Cleanup deletes both users
// and everything the test created, even if a check fails. Never touches
// user 1 or any admin account.
//
//   node scripts/testSniffedOut.js
import readline from 'readline/promises';
import crypto from 'crypto';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import '../config.js';
import { initDb, getDb, dbAdapter as db, withTransaction } from '../db/connection.js';
import { testPetUsername } from './lib/testIds.js';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const A = { email: `so-test-${stamp}-a@example.invalid`, username: `soa_${stamp}`, petName: `SoA${stamp}`, handle: testPetUsername('soa') };
const B = { email: `so-test-${stamp}-b@example.invalid`, username: `sob_${stamp}`, petName: `SoB${stamp}`, handle: testPetUsername('sob') };
const TEST_EMAILS = [A.email, B.email];
const COORDS = { lat: -54.2800, lng: -36.5000 }; // remote, far from any real pet

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
const isSniffedOut403 = r => r.status === 403 && r.data?.error === 'SNIFFED_OUT';

async function call(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
const get = (path, token) => call('GET', path, token);
const post = (path, token, body) => call('POST', path, token, body);

async function createUser(spec, created) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await db.get(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`,
    [spec.email, spec.username, hash, `SniffedOut Test ${spec === A ? 'A' : 'B'}`]
  );
  spec.userId = row.id;
  created.userIds.push(row.id);
  const login = await post('/api/auth/login', null, { email: spec.email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed for ${spec.email}: ${show(login)}`);
  spec.token = login.data.accessToken;
  const pet = await post('/api/profile', spec.token, {
    name: spec.petName, pet_username: spec.handle, type: 'dog', latitude: COORDS.lat, longitude: COORDS.lng, location_text: 'SniffedOut test',
  });
  if (pet.status !== 201) throw new Error(`pet creation failed for ${spec.email}: ${show(pet)}`);
  spec.petId = pet.data.id;
}

function loadSocketClient() {
  try {
    const require = createRequire(new URL('../../client/package.json', import.meta.url));
    return require('socket.io-client').io;
  } catch {
    return null;
  }
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Polls a user's notification count until it hasn't changed for quietMs
// (or maxMs passes), so background senders have finished.
async function settleNotificationCount(userId, quietMs = 3000, maxMs = 30000) {
  const started = Date.now();
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() - started < maxMs) {
    const { n } = await db.get('SELECT count(*)::int AS n FROM notifications WHERE user_id = ?', [userId]);
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= quietMs) {
      return n;
    }
    await sleep(500);
  }
  return last;
}

const waitFor = (socket, event, ms = 5000) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms);
  socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
});

async function runTests(created) {
  section('Setup: two users with pets');
  await createUser(A, created);
  await createUser(B, created);
  console.log(`  A = user #${A.userId} / pet #${A.petId}, B = user #${B.userId} / pet #${B.petId}`);

  section('Setup: real interactions while B is live');
  let r = await post(`/api/matches/like/${A.petId}`, B.token);
  if (r.status !== 200) throw new Error(`B -> A sniff failed: ${show(r)}`);
  r = await post(`/api/matches/pending/${B.petId}/respond`, A.token, { action: 'accept' });
  if (!r.data.matched) throw new Error(`A accepting B failed: ${show(r)}`);
  const convs = await get('/api/chat/conversations', A.token);
  const conversationId = convs.data.conversations?.find(c => c.partner_pet_id === B.petId)?.id;
  if (!conversationId) throw new Error(`no conversation between A and B: ${show(convs)}`);

  const bMsg = await post('/api/chat/messages', B.token, { conversationId, content: `hello from B ${stamp}` });
  if (bMsg.status !== 201) throw new Error(`B message failed: ${show(bMsg)}`);
  const reply = await db.get(
    `INSERT INTO messages (conversation_id, sender_id, content, message_type, status, reply_to_id)
     VALUES (?, ?, ?, 'text', 'sent', ?) RETURNING id`,
    [conversationId, A.userId, `A replying to B ${stamp}`, bMsg.data.id]
  );

  const aPost = await post('/api/posts', A.token, { caption: `A's post ${stamp}` });
  const bPost = await post('/api/posts', B.token, { caption: `B's post ${stamp}` });
  if (aPost.status !== 201 || bPost.status !== 201) throw new Error(`post creation failed: ${show(aPost)} / ${show(bPost)}`);
  const bComment = await post(`/api/posts/${aPost.data.id}/comment`, B.token, { content: `B comments ${stamp}` });
  if (bComment.status !== 201 && bComment.status !== 200) throw new Error(`B comment failed: ${show(bComment)}`);
  const bCommentId = bComment.data.comment?.id ?? bComment.data.id;
  await post(`/api/posts/${aPost.data.id}/like`, B.token);
  await post(`/api/posts/${aPost.data.id}/react`, B.token, { reaction: 'paw' });
  await post('/api/chat/calls/log', B.token, { receiverPetId: A.petId, type: 'audio', status: 'completed', duration: 12 });

  const circle = await post('/api/communities', B.token, { name: `SO Test Circle ${stamp}`, description: 'SniffedOut test circle', category: 'Activities' });
  if (circle.status !== 201) throw new Error(`circle creation failed: ${show(circle)}`);
  const circleId = circle.data.community.id;
  created.communityIds.push(circleId);
  await post(`/api/communities/${circleId}/messages`, B.token, { content: `B in the circle ${stamp}` });
  await post(`/api/communities/${circleId}/announcements`, B.token, { title: 'B announces', content: `announcement ${stamp}` });
  // No create endpoints exist for polls/events -- insert them as B.
  await db.run(
    "INSERT INTO community_polls (community_id, question, options_json, votes_json, created_by) VALUES (?, ?, '[\"yes\",\"no\"]', '{}', ?)",
    [circleId, `B's poll ${stamp}`, B.userId]);
  await db.run(
    'INSERT INTO community_events (community_id, title, description, created_by) VALUES (?, ?, ?, ?)',
    [circleId, `B's event ${stamp}`, 'test', B.userId]);
  r = await post(`/api/communities/${circleId}/join`, A.token);
  if (r.status !== 200) throw new Error(`A joining B's circle failed: ${show(r)}`);
  // A past Spotlight win for B (sorts first: cycle_date is text).
  await db.run("INSERT INTO spotlight_history (pet_id, area, score, cycle_date) VALUES (?, 'locality', 7, ?)", [B.petId, `zz-test-${stamp}`]);

  const matchRequest = await db.get(
    "SELECT id FROM notifications WHERE user_id = ? AND sender_pet_id = ? AND type = 'match_request'", [A.userId, B.petId]);

  // Some setup requests start background work that can keep writing
  // notifications after they respond -- e.g. a like kicks off a Spotlight
  // check that may send B a "new #1" notification. Let that settle first.
  const settled = await settleNotificationCount(B.userId);
  console.log(`  B's notifications settled at ${settled}`);

  section("Tombstone B (like the real scrub: deleted_at, pet name 'SniffedOut', no avatar)");
  const u = await db.get('SELECT id, email, is_admin FROM users WHERE id = ?', [B.userId]);
  if (!u || u.id === PROTECTED_USER_ID || u.is_admin || u.email !== B.email) throw new Error('refusing to tombstone a non-test user');
  await db.run('UPDATE users SET deleted_at = NOW() WHERE id = ?', [B.userId]);
  await db.run("UPDATE pets SET deleted_at = NOW(), name = 'SniffedOut', avatar_url = NULL WHERE user_id = ?", [B.userId]);
  const beforeRow = await db.get('SELECT count(*)::int AS n, COALESCE(MAX(id), 0) AS max_id FROM notifications WHERE user_id = ?', [B.userId]);
  const notificationsForBBefore = beforeRow.n;

  section('A still sees everything, flagged as SniffedOut');
  r = await get('/api/chat/conversations', A.token);
  const conv = r.data.conversations?.find(c => c.id === conversationId);
  check('conversation with B is still listed', !!conv, show(r));
  check('conversation: other_sniffed_out + read_only', conv?.other_sniffed_out === true && conv?.read_only === true, JSON.stringify(conv));
  check('conversation: partner shown as SniffedOut, no avatar/handle',
    conv?.partner_name === 'SniffedOut' && conv?.partner_avatar === null && conv?.partner_username === null, JSON.stringify(conv));

  r = await get(`/api/chat/messages/${conversationId}`, A.token);
  const msgs = r.data.messages || r.data;
  const bMessage = Array.isArray(msgs) ? msgs.find(m => m.id === bMsg.data.id) : null;
  check("B's message is still there, sender SniffedOut, flagged, no avatar",
    bMessage?.sender_username === 'SniffedOut' && bMessage?.sender_sniffed_out === true && bMessage?.sender_avatar === null, JSON.stringify(bMessage));
  const replyRow = Array.isArray(msgs) ? msgs.find(m => m.id === reply.id) : null;
  check("reply preview names B as SniffedOut",
    replyRow?.reply_sender_username === 'SniffedOut' && replyRow?.reply_sender_sniffed_out === true, JSON.stringify(replyRow));

  r = await get('/api/matches', A.token);
  const match = r.data.matches?.find(m => m.matched_pet_id === B.petId);
  check('match with B is still listed, flagged, SniffedOut, no avatar',
    match?.sniffed_out === true && match?.matched_pet_name === 'SniffedOut' && match?.matched_pet_avatar === null, JSON.stringify(match));

  r = await get(`/api/posts/${aPost.data.id}/comments`, A.token);
  const comments = r.data.comments || r.data;
  const comment = Array.isArray(comments) ? comments.find(c => c.user_id === B.userId) : null;
  check("B's comment is kept, author SniffedOut, flagged, no avatar",
    comment?.username === 'SniffedOut' && comment?.full_name === 'SniffedOut' && comment?.sniffed_out === true && comment?.avatar_url === null,
    JSON.stringify(comment));
  const likes = await db.get('SELECT count(*)::int AS n FROM likes WHERE post_id = ? AND user_id = ?', [aPost.data.id, B.userId]);
  check("B's like on A's post still counts", likes.n === 1, likes.n);
  r = await get(`/api/posts/${aPost.data.id}/reactions`, A.token);
  const reaction = r.data.reactions?.find(x => x.user_id === B.userId);
  check("B's reaction is kept, shown as SniffedOut, flagged",
    reaction?.pet_name === 'SniffedOut' && reaction?.sniffed_out === true && reaction?.pet_avatar === null, JSON.stringify(reaction));

  r = await get('/api/notifications?limit=50', A.token);
  const fromB = (r.data.notifications || []).filter(n => n.sender_pet_id === B.petId);
  check("A's notifications from B are kept and flagged sender_sniffed_out, no avatar",
    fromB.length > 0 && fromB.every(n => n.sender_sniffed_out === true && n.avatar_url === null && n.is_premium === false),
    JSON.stringify(fromB.map(n => ({ type: n.type, sender_sniffed_out: n.sender_sniffed_out, avatar_url: n.avatar_url }))));

  r = await get('/api/chat/calls/history', A.token);
  const callRow = r.data.history?.find(h => h.caller_pet_id === B.petId);
  check('call with B is still in history, flagged, SniffedOut, no avatar',
    callRow?.sniffed_out === true && callRow?.partner_name === 'SniffedOut' && callRow?.partner_avatar === null, JSON.stringify(callRow));

  r = await get(`/api/communities/${circleId}/members`, A.token);
  const bMember = r.data.members?.find(m => m.user_id === B.userId);
  check("B still listed in their circle's members, SniffedOut, flagged, no avatar",
    bMember?.sniffed_out === true && bMember?.username === 'SniffedOut' && bMember?.pet_name === 'SniffedOut' && bMember?.pet_avatar === null,
    JSON.stringify(bMember));
  r = await get(`/api/communities/${circleId}/messages`, A.token);
  const bCircleMsg = r.data.messages?.find(m => m.sender_id === B.userId && m.message_type !== 'system');
  check("B's circle message kept, sender SniffedOut, flagged",
    bCircleMsg?.sniffed_out === true && bCircleMsg?.username === 'SniffedOut' && bCircleMsg?.sender_avatar === null, JSON.stringify(bCircleMsg));
  r = await get(`/api/communities/${circleId}/announcements`, A.token);
  const ann = r.data.announcements?.find(a => a.sender_id === B.userId);
  check("B's announcement kept, sender SniffedOut, flagged", ann?.sniffed_out === true && ann?.username === 'SniffedOut', JSON.stringify(ann));
  r = await get(`/api/communities/${circleId}/polls`, A.token);
  const poll = r.data.polls?.[0];
  check("B's poll kept, creator SniffedOut, flagged", poll?.creator_sniffed_out === true && poll?.creator_name === 'SniffedOut', JSON.stringify(poll));
  r = await get(`/api/communities/${circleId}/events`, A.token);
  const event = r.data.events?.[0];
  check("B's event kept, creator SniffedOut, flagged", event?.creator_sniffed_out === true && event?.creator_name === 'SniffedOut', JSON.stringify(event));

  r = await get('/api/spotlight/history?area=locality', A.token);
  const win = r.data.history?.find(h => h.pet_id === B.petId);
  check("B's past Spotlight win kept, SniffedOut, flagged, no avatar",
    win?.sniffed_out === true && win?.name === 'SniffedOut' && win?.avatar_url === null, JSON.stringify(win));

  r = await get(`/api/posts/${bPost.data.id}`, A.token);
  const single = r.data.post || r.data;
  check("B's post (single view) is flagged with author SniffedOut",
    single?.sniffed_out === true && single?.pet_name === 'SniffedOut' && single?.pet_avatar === null, show(r));

  section("B's profile");
  r = await get(`/api/profile/${B.petId}`, A.token);
  check('GET /profile/:id -> 200 with only { sniffed_out: true }',
    r.status === 200 && r.data.sniffed_out === true && Object.keys(r.data).length === 1, show(r));
  // Username profile URLs (app.sniffrweb.com/<pet username>) hit the same
  // endpoint by username. This tombstone keeps B's pet_username (the real
  // scrub clears it), so the lookup finds the row and the flag must hold.
  r = await get(`/api/profile/${B.handle}`, A.token);
  check('GET /profile/<B pet username> -> 200 with only { sniffed_out: true }',
    r.status === 200 && r.data.sniffed_out === true && Object.keys(r.data).length === 1, show(r));
  r = await post(`/api/profile/${B.petId}/view`, A.token);
  const views = await db.get('SELECT count(*)::int AS n FROM profile_views WHERE viewer_pet_id = ? AND viewed_pet_id = ?', [A.petId, B.petId]);
  check('POST /profile/:id/view does nothing (no view row, not notified)',
    r.status === 200 && r.data.notified === false && views.n === 0, `${show(r)} views=${views.n}`);

  section('Actions aimed at B -> 403 SNIFFED_OUT');
  const actions = [
    ['sniff (like) B', () => post(`/api/matches/like/${B.petId}`, A.token)],
    ['decline B', () => post(`/api/matches/decline/${B.petId}`, A.token)],
    ["respond to B's pending request", () => post(`/api/matches/pending/${B.petId}/respond`, A.token, { action: 'accept' })],
    ["accept B's request from the notification", () => post(`/api/notifications/match-request/${matchRequest?.id}/respond`, A.token, { action: 'accept' })],
    ['start a conversation with B', () => post('/api/chat/conversations', A.token, { recipientPetId: B.petId })],
    ['send a message in the conversation with B', () => post('/api/chat/messages', A.token, { conversationId, content: 'still there?' })],
    ['share a post to B', () => post('/api/chat/share', A.token, { postId: aPost.data.id, recipientPetId: B.petId })],
    ['log a call to B', () => post('/api/chat/calls/log', A.token, { receiverPetId: B.petId, type: 'audio', status: 'missed', duration: 0 })],
    ['respond to a meetup in the conversation with B', () => post(`/api/chat/meetup/${bMsg.data.id}`, A.token, { status: 'accepted' })],
    ['block B', () => post('/api/profile/block', A.token, { blockedUserId: B.userId })],
    ["like B's post", () => post(`/api/posts/${bPost.data.id}/like`, A.token)],
    ["comment on B's post", () => post(`/api/posts/${bPost.data.id}/comment`, A.token, { content: 'hello?' })],
    ["react to B's post", () => post(`/api/posts/${bPost.data.id}/react`, A.token, { reaction: 'paw' })],
    ["share B's post", () => post(`/api/posts/${bPost.data.id}/share`, A.token)],
    ["report B's post", () => post(`/api/posts/${bPost.data.id}/report`, A.token, { reason: 'test' })],
  ];
  for (const [label, run] of actions) {
    r = await run();
    check(`${label} -> 403 SNIFFED_OUT`, isSniffedOut403(r), show(r));
  }

  section('Mentions and notifications never reach B');
  r = await post('/api/posts', A.token, { caption: `hey @${B.handle}` });
  check('A can still post a caption mentioning B', r.status === 201, show(r));
  r = await post(`/api/posts/${aPost.data.id}/comment`, A.token, { content: 'replying to B', parentCommentId: bCommentId });
  check("A can still reply under B's old comment", r.status === 201 || r.status === 200, show(r));
  const notificationsForBAfter = (await db.get('SELECT count(*)::int AS n FROM notifications WHERE user_id = ?', [B.userId])).n;
  const newRows = await db.all(
    `SELECT id, type, category, created_at, sender_pet_id, target_id, title
     FROM notifications WHERE user_id = ? AND id > ? ORDER BY id`,
    [B.userId, beforeRow.max_id]);
  check('B received no new notifications after being tombstoned (mention, reply, anything)',
    notificationsForBAfter === notificationsForBBefore && newRows.length === 0,
    `${notificationsForBBefore} -> ${notificationsForBAfter}; new rows: ${JSON.stringify(newRows.map(n => ({
      id: n.id, type: n.type, category: n.category, created_at: n.created_at,
      sender_pet_id: n.sender_pet_id, sender: n.sender_pet_id === A.petId ? 'A' : n.sender_pet_id === B.petId ? 'B' : 'other',
      target_id: n.target_id, title: n.title,
    })))}`);

  section('Socket actions aimed at B');
  const ioClient = loadSocketClient();
  if (!ioClient) {
    console.log('  SKIP  socket.io-client not found in client/node_modules -- 5 socket checks not run');
    return;
  }
  const socket = ioClient(API_BASE, { auth: { token: A.token }, transports: ['websocket'], reconnection: false });
  try {
    const connected = await Promise.race([
      new Promise(res => socket.once('connect', () => res(true))),
      new Promise(res => socket.once('connect_error', () => res(false))),
      new Promise(res => setTimeout(() => res(false), 5000)),
    ]);
    if (!connected) throw new Error('socket did not connect');

    // Sent immediately after connecting on purpose: the server must already
    // be listening (it used to drop events sent before its connect-time DB
    // work finished).
    const countMessages = async () =>
      (await db.get('SELECT count(*)::int AS n FROM messages WHERE conversation_id = ?', [conversationId])).n;
    const messagesBefore = await countMessages();
    const sendErr = waitFor(socket, 'chat_error');
    const ack = await new Promise(res => {
      const t = setTimeout(() => res(null), 5000);
      socket.emit('send_message', { conversationId, content: 'socket hello?', clientTempId: 'so-test' }, a => { clearTimeout(t); res(a); });
    });
    check('socket send_message to B -> ack refused with SNIFFED_OUT', ack?.success === false && ack?.error === 'SNIFFED_OUT', JSON.stringify(ack));
    const sendErrPayload = await sendErr;
    check('socket send_message to B -> chat_error SNIFFED_OUT', sendErrPayload?.error === 'SNIFFED_OUT', JSON.stringify(sendErrPayload));
    const messagesAfter = await countMessages();
    check('no message row was created in the conversation with B', messagesAfter === messagesBefore, `${messagesBefore} -> ${messagesAfter}`);

    const reactErr = waitFor(socket, 'chat_error');
    socket.emit('react_to_message', { messageId: bMsg.data.id, conversationId, reaction: 'paw' });
    const reactPayload = await reactErr;
    check("socket reaction on B's message -> chat_error SNIFFED_OUT", reactPayload?.error === 'SNIFFED_OUT', JSON.stringify(reactPayload));

    const callErr = waitFor(socket, 'call_error');
    socket.emit('call_initiate', { to: B.userId, type: 'audio' });
    const callPayload = await callErr;
    check('socket call to B -> call_error SNIFFED_OUT', callPayload?.error === 'SNIFFED_OUT', JSON.stringify(callPayload));
  } finally {
    socket.disconnect();
  }
}

// Deletes everything the test created for its throwaway users, in one
// transaction. Refuses if any user isn't one of this run's test accounts or
// a real user has joined a test circle; rolls back if anything else still
// points at the test accounts.
async function cleanup(created) {
  section('Cleanup');
  const users = created.userIds;
  if (!users.length) {
    console.log('  nothing to clean up');
    return;
  }
  await withTransaction(async tx => {
    for (const id of users) {
      const u = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (u && (u.id === PROTECTED_USER_ID || u.is_admin || !TEST_EMAILS.includes(u.email))) {
        throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
      }
    }
    const ids = async sql => (await tx.all(sql, [users])).map(r => r.id);
    const pets = await ids('SELECT id FROM pets WHERE user_id = ANY(?::int[])');
    const circles = await ids('SELECT id FROM communities WHERE created_by = ANY(?::int[])');
    const outsiders = await tx.get(
      'SELECT count(*)::int AS n FROM community_members WHERE community_id = ANY(?::int[]) AND NOT (user_id = ANY(?::int[]))', [circles, users]);
    if (outsiders.n) throw new Error(`${outsiders.n} non-test member(s) joined a test circle -- leaving it for a manual look`);
    const matches = (await tx.all('SELECT id FROM matches WHERE pet1_id = ANY(?::int[]) OR pet2_id = ANY(?::int[])', [pets, pets])).map(r => r.id);
    const convs = (await tx.all('SELECT id FROM conversations WHERE match_id = ANY(?::int[])', [matches])).map(r => r.id);
    const msgs = (await tx.all('SELECT id FROM messages WHERE conversation_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [convs, users])).map(r => r.id);
    const posts = (await tx.all('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [pets])).map(r => r.id);
    const circleMsgs = (await tx.all(
      'SELECT id FROM community_messages WHERE community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users])).map(r => r.id);

    const steps = [
      ['community_message_reactions', 'user_id = ANY(?::int[]) OR community_message_id = ANY(?::int[])', [users, circleMsgs]],
      ['community_messages', 'id = ANY(?::int[])', [circleMsgs]],
      ['community_photos', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['community_announcements', 'community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]],
      ['community_events', 'community_id = ANY(?::int[]) OR created_by = ANY(?::int[])', [circles, users]],
      ['community_polls', 'community_id = ANY(?::int[]) OR created_by = ANY(?::int[])', [circles, users]],
      ['community_join_requests', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['community_members', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['communities', 'id = ANY(?::int[])', [circles]],
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
      ['notification_preferences', 'user_id = ANY(?::int[])', [users]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [users]],
      ['trusted_devices', 'user_id = ANY(?::int[])', [users]],
      ['verification_codes', 'user_id = ANY(?::int[])', [users]],
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
      const list = f.ref_table === 'users' ? users : pets;
      const row = await tx.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ANY(?::int[])`, [list]);
      if (row.n) leftovers.push(`${f.table_name}.${f.column_name} (${row.n})`);
    }
    if (leftovers.length) throw new Error(`unexpected rows still reference the test accounts: ${leftovers.join(', ')}`);

    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    if (userDel.rowCount !== users.length) throw new Error(`expected to delete ${users.length} users, deleted ${userDel.rowCount}`);
    console.log(`  deleted ${userDel.rowCount} test users, ${petDel.rowCount} pets${counts.length ? `, ${counts.join(', ')}` : ''}`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Backend under test: ${API_BASE}`);
  console.log(`Creates two throwaway users (${A.email}, ${B.email}), runs the tests, then deletes them.`);
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
  const created = { userIds: [], communityIds: [] };
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
      console.error(`\nCLEANUP FAILED (rolled back): ${err.message}\n  Remove users ${created.userIds.join(', ')} (${TEST_EMAILS.join(', ')}) by hand.`);
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
