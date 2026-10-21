// Integration test for a batch of fixes, against your running backend
// (`npm run dev` on :3001, STORAGE_TYPE=cloud) and the database in server/.env
// (production, no real users yet):
//   - GET /api/posts/reports (your own reports) works on the live schema;
//   - the chat list knows each last message's type, and the client's preview
//     formatter turns meetups, photos, shared posts... into friendly labels;
//   - creating a PawCircle poll (members only, validation, chat line, live event);
//   - circle photos save as media messages (upload and socket), not text;
//   - disabling a circle archives it (read-only, hidden, transfer cancelled)
//     and the Owner can re-enable it;
//   - circle messages only take media URLs of our own uploads (REST + socket);
//   - the removed post_liked / new_match socket relays no longer broadcast;
//   - an ACTIVE circle deleted by its owner leaving it empty queues its media.
// Throwaway users (reserved .invalid domain): A owns circle C, B is a member,
// N an outsider; A and B are matched for the chat checks. One tiny image is
// uploaded and destroyed in cleanup. Never touches user 1.
//
//   node scripts/testCircleChatFixes.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { default: config } = await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { default: cloudStorage } = await import('../storage/CloudStorage.js');
const { parseCloudinaryUrl } = await import('../services/accountDeletion.js');
const { testPetUsername } = await import('./lib/testIds.js');
const { messagePreview } = await import('../../client/src/utils/messagePreview.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `fixes-test-${stamp}-${key}@example.invalid`, username: `fix${key}_${stamp}` });
const A = mk('a');
const B = mk('b');
const N = mk('n');
// A valid 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

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
const get = (p, t) => call('GET', p, t);
const post = (p, t, b) => call('POST', p, t, b);
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
     VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `Fixes Test ${spec.key.toUpperCase()}`]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
  spec.petId = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, {
    name: `Fix${spec.key.toUpperCase()}${stamp}`, pet_username: testPetUsername(`fix${spec.key}`), type: 'dog',
  }))).id;
}

async function uploadToCircle(circleId, token, filename) {
  const form = new FormData();
  form.append('media', new Blob([PNG], { type: 'image/png' }), filename);
  // What older app versions send: the file's name as the text.
  form.append('content', filename);
  const res = await fetch(`${API_BASE}/api/communities/${circleId}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function runTests(created) {
  const ioClient = loadSocketClient();
  if (!ioClient) throw new Error('socket.io-client not found in client/node_modules');

  section('Setup');
  for (const spec of [A, B, N]) await createUser(spec, created);
  const cName = `Fixes C ${stamp}`;
  const C = (await must('A creates C', post('/api/communities', A.token, { name: cName, description: 'fixes test' }))).community.id;
  created.circles.push(C);
  await must('B joins C', post(`/api/communities/${C}/join`, B.token));
  const bPost = (await must('B posts', post('/api/posts', B.token, { caption: `B's post ${stamp}` }))).id;
  await must('B sniffs A', post(`/api/matches/like/${A.petId}`, B.token));
  const matched = await must('A accepts', post(`/api/matches/pending/${B.petId}/respond`, A.token, { action: 'accept' }));
  if (!matched.matched) throw new Error(`A and B did not match: ${JSON.stringify(matched)}`);
  const convId = (await get('/api/chat/conversations', A.token)).data.conversations?.find(c => c.partner_pet_id === B.petId)?.id;
  if (!convId) throw new Error('no A-B conversation');
  console.log(`  A #${A.userId}, B #${B.userId}, N #${N.userId}; circle #${C}, conversation #${convId}`);
  const aSock = await connect(ioClient, A, created);
  const bSock = await connect(ioClient, B, created);

  section('My reports (GET /api/posts/reports)');
  await must('A reports B\'s post', post(`/api/posts/${bPost}/report`, A.token, { reason: 'Spam' }));
  await must('A reports circle C', post(`/api/communities/${C}/report`, A.token, { reason: 'Other', details: 'test' }));
  let r = await get('/api/posts/reports', A.token);
  const reports = r.data.reports || [];
  check('-> 200 (no more missing status column)', r.status === 200, show(r));
  check("lists A's post report as Pending, with the post's caption",
    reports.some(x => x.post_id === bPost && x.status === 'Pending' && x.caption === `B's post ${stamp}`), JSON.stringify(reports).slice(0, 300));
  check('...and the circle report (no post) too', reports.some(x => x.post_id === null && /Community #/.test(x.reason)), JSON.stringify(reports).slice(0, 300));
  r = await get('/api/posts/reports', N.token);
  check("someone else doesn't see A's reports", r.status === 200 && (r.data.reports || []).length === 0, show(r));

  section('Chat list previews');
  const previewFor = async () => (await get('/api/chat/conversations', B.token)).data.conversations?.find(c => c.id === convId);
  const cases = [
    ['meetup', { content: JSON.stringify({ location: 'Central Park', date_time: 'Sat • 10:00', note: '', status: 'pending' }) }, '📍 Meetup invitation'],
    ['image', { content: '', mediaUrl: 'https://res.cloudinary.com/demo/image/upload/v1/sniffr/chat/fixtest.jpg' }, '📷 Photo'],
    ['pet_profile', { content: '🐶 Profile shared', mediaUrl: String(B.petId) }, '🐶 Shared a pet profile'],
    ['voice', { content: '', mediaUrl: 'https://res.cloudinary.com/demo/video/upload/v1/sniffr/chat/fixtest.webm' }, '🎤 Voice message'],
    ['text', { content: `plain hello ${stamp}` }, `plain hello ${stamp}`],
  ];
  for (const [type, payload, label] of cases) {
    // Photos and voice notes are uploads (POST /api/chat/messages sets their
    // type and URL); the socket only takes text, profile cards and meetups.
    // Those rows are written directly here, exactly as the upload route
    // stores them -- the preview is what's under test.
    const ack = ['image', 'voice'].includes(type)
      ? { success: !!(await db.get(
        "INSERT INTO messages (conversation_id, sender_id, content, media_url, message_type, status) VALUES (?, ?, ?, ?, ?, 'sent') RETURNING id",
        [convId, A.userId, payload.content, payload.mediaUrl, type])) }
      : await emitAck(aSock, 'send_message', { conversationId: convId, messageType: type, ...payload });
    const conv = await previewFor();
    check(`last message ${type}: last_message_type '${type}', preview "${label}"`,
      ack?.success === true && conv?.last_message_type === type && messagePreview(conv.last_message, conv.last_message_type) === label,
      JSON.stringify({ ack: ack?.success, type: conv?.last_message_type, preview: conv && messagePreview(conv.last_message, conv.last_message_type) }));
  }
  r = await post('/api/chat/share', A.token, { postId: bPost, recipientPetIds: [B.petId] });
  let conv = await previewFor();
  check('a shared post previews as "🐾 Shared a post"', (r.status === 200 || r.status === 201)
    && conv?.last_message_type === 'shared_post' && messagePreview(conv.last_message, conv.last_message_type) === '🐾 Shared a post', show(r));
  check('older rows: a meetup JSON stored as text still previews as a meetup',
    messagePreview('{"location":"Park","date_time":"x"}', 'text') === '📍 Meetup invitation');

  section('Create Poll');
  await emitAck(bSock, 'join_community_chat', { communityId: C });
  const pollEvent = waitFor(bSock, 'community_poll_created', 5000, p => p?.communityId === C);
  const question = `Park or beach ${stamp}`;
  r = await post(`/api/communities/${C}/polls`, A.token, { question: `  ${question}  `, options: [' Park ', 'Beach'] });
  const poll = r.data.poll;
  check('a member creates a poll -> 201 with trimmed question and options', r.status === 201 && poll?.question === question
    && JSON.stringify(poll?.options) === JSON.stringify(['Park', 'Beach']) && poll?.community_id === C, show(r));
  check('open pages get community_poll_created', (await pollEvent)?.poll?.id === poll?.id);
  check('the chat got a "New Pack Poll" system line', !!(await one(
    "SELECT id FROM community_messages WHERE community_id = ? AND message_type = 'system' AND content = ?", [C, `📊 New Pack Poll: ${question}`])));
  r = await post(`/api/communities/${C}/polls/${poll?.id}/vote`, B.token, { optionIndex: 1 });
  check('the existing vote route works on it', r.status === 200 && (r.data.poll?.votes?.['1'] || []).includes(B.userId), show(r));
  r = await get(`/api/communities/${C}/polls`, B.token);
  check('it is listed', (r.data.polls || []).some(p => p.id === poll?.id), show(r));
  const invalid = [
    [{ question: '   ', options: ['a', 'b'] }, 'INVALID_QUESTION', 'empty question'],
    [{ question: 'x'.repeat(201), options: ['a', 'b'] }, 'INVALID_QUESTION', 'question over 200 characters'],
    [{ question: 'One?', options: ['only'] }, 'INVALID_OPTIONS', 'one option'],
    [{ question: 'Dup?', options: ['Same', ' same '] }, 'INVALID_OPTIONS', 'duplicate options'],
    [{ question: 'Blank?', options: ['a', ''] }, 'INVALID_OPTIONS', 'a blank option'],
    [{ question: 'Many?', options: Array.from({ length: 11 }, (_, i) => `o${i}`) }, 'INVALID_OPTIONS', '11 options'],
  ];
  for (const [body, code, label] of invalid) {
    r = await post(`/api/communities/${C}/polls`, B.token, body);
    check(`${label} -> 400 ${code}`, is(r, 400, code), show(r));
  }
  r = await post(`/api/communities/${C}/polls`, N.token, { question: 'Outsider?', options: ['a', 'b'] });
  check('an outsider -> 403 NOT_A_MEMBER', is(r, 403, 'NOT_A_MEMBER'), show(r));
  check('none of the refused polls was created', (await one('SELECT count(*)::int AS n FROM community_polls WHERE community_id = ?', [C])).n === 1);

  section('Circle photos save as media messages');
  r = await uploadToCircle(C, B.token, 'holiday-photo.png');
  const upMsg = r.data.message;
  if (upMsg?.media_url) created.files.push(upMsg.media_url);
  check("upload -> 201, message_type 'image', the file name is not saved as text",
    r.status === 201 && upMsg?.message_type === 'image' && !!upMsg?.media_url && upMsg?.content === '', show(r));
  // Re-sharing our own upload by URL (recorded in media_files by the upload).
  let ack = await emitAck(bSock, 'send_community_message', { communityId: C, content: 'look', mediaUrl: upMsg?.media_url });
  check("socket message re-sharing our uploaded photo -> message_type 'image', caption kept", ack?.success === true && ack.message?.message_type === 'image'
    && ack.message?.content === 'look', JSON.stringify(ack).slice(0, 200));
  // A video "upload" (a media_files row, no real file) to check the type.
  const videoUrl = `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME || 'demo'}/video/upload/v1/sniffr/community_media/fixtest_${stamp}.mp4`;
  await db.run("INSERT INTO media_files (user_id, url, bytes, provider, resource_type, subdir) VALUES (?, ?, 1, 'cloudinary', 'video', 'community_media')", [B.userId, videoUrl]);
  ack = await emitAck(bSock, 'send_community_message', { communityId: C, mediaUrl: videoUrl });
  check("socket message with our video URL -> message_type 'video'", ack?.success === true && ack.message?.message_type === 'video', JSON.stringify(ack).slice(0, 200));

  section('Circle media URLs: our own uploads only');
  const outsideUrl = `https://example.com/not-ours-${stamp}.jpg`;
  const lookalikeUrl = `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME || 'demo'}/image/upload/v1/sniffr/community_media/never_uploaded_${stamp}.jpg`;
  const countWith = url => one('SELECT count(*)::int AS n FROM community_messages WHERE media_url = ?', [url]).then(x => x.n);
  r = await post(`/api/communities/${C}/messages`, B.token, { content: 'outside', media_url: outsideUrl });
  check('REST message with an outside URL -> 400 INVALID_MEDIA, nothing saved', is(r, 400, 'INVALID_MEDIA') && await countWith(outsideUrl) === 0, show(r));
  r = await post(`/api/communities/${C}/messages`, B.token, { content: 'lookalike', media_url: lookalikeUrl });
  check('REST message with a never-uploaded Cloudinary URL -> 400 INVALID_MEDIA', is(r, 400, 'INVALID_MEDIA') && await countWith(lookalikeUrl) === 0, show(r));
  r = await post(`/api/communities/${C}/messages`, B.token, { content: 'reshare', media_url: upMsg?.media_url });
  check('REST message re-sharing our upload -> 201', r.status === 201 && r.data.message?.message_type === 'image', show(r));
  ack = await emitAck(bSock, 'send_community_message', { communityId: C, content: 'outside', mediaUrl: outsideUrl });
  check('socket message with an outside URL -> refused INVALID_MEDIA, nothing saved',
    ack?.success === false && ack?.error === 'INVALID_MEDIA' && await countWith(outsideUrl) === 0, JSON.stringify(ack));

  section('Removed socket relays');
  const relayedLike = waitFor(bSock, 'post_like_update', 1500);
  const relayedMatch = waitFor(bSock, 'match_notification', 1500);
  aSock.emit('post_liked', { postId: bPost, likeCount: 9999 });
  aSock.emit('new_match', { matchedPet: { id: 1, name: 'Fake' } });
  check("a client's post_liked is no longer broadcast to everyone", (await relayedLike) === null);
  check("a client's new_match is no longer broadcast to everyone", (await relayedMatch) === null);
  ack = await emitAck(bSock, 'send_community_message', { communityId: C, content: `just text ${stamp}` });
  check("a text message stays 'text'", ack?.success === true && ack.message?.message_type === 'text', JSON.stringify(ack).slice(0, 200));

  section('Disable = archive; the Owner re-enables');
  const t = await must('A offers C to B', post(`/api/communities/${C}/ownership-transfer`, A.token, { toUserId: B.userId }));
  const disabledEvent = waitFor(bSock, 'community_disabled', 5000, p => p?.communityId === C);
  r = await post(`/api/communities/${C}/disable`, A.token);
  check('the Owner disables C -> 200', r.status === 200, show(r));
  check("B's open page is told", !!(await disabledEvent));
  check('the pending ownership transfer was cancelled', (await one('SELECT status FROM community_ownership_transfers WHERE id = ?', [t.transfer.id]))?.status === 'cancelled');
  r = await post(`/api/communities/${C}/messages`, B.token, { content: 'still here?' });
  check('a member writes -> 403 COMMUNITY_READ_ONLY, reason disabled, owner message',
    is(r, 403, 'COMMUNITY_READ_ONLY') && r.data.reason === 'disabled' && /disabled by its owner/.test(r.data.message || ''), show(r));
  r = await post(`/api/communities/${C}/messages`, A.token, { content: 'owner too?' });
  check('...the Owner too (read-only for everyone)', is(r, 403, 'COMMUNITY_READ_ONLY') && r.data.reason === 'disabled', show(r));
  r = await post(`/api/communities/${C}/polls`, B.token, { question: 'Archived?', options: ['a', 'b'] });
  check('creating a poll -> 403 (disabled)', is(r, 403, 'COMMUNITY_READ_ONLY'), show(r));
  r = await post(`/api/communities/${C}/polls/${poll?.id}/vote`, B.token, { optionIndex: 0 });
  check('voting -> 403 (disabled)', is(r, 403, 'COMMUNITY_READ_ONLY'), show(r));
  const sockErr = waitFor(bSock, 'community_error', 5000, p => p?.communityId === C);
  ack = await emitAck(bSock, 'send_community_message', { communityId: C, content: 'socket?' });
  const se = await sockErr;
  check('socket write -> refused, reason disabled', ack?.success === false && ack?.error === 'COMMUNITY_READ_ONLY' && se?.reason === 'disabled', JSON.stringify(ack));
  r = await get(`/api/communities/${C}/messages`, B.token);
  check('reading still works for members', r.status === 200 && (r.data.messages || []).length > 0, show(r));
  r = await get(`/api/communities/${C}`, B.token);
  check('details show disabled: true', r.status === 200 && r.data.community?.disabled === true, show(r));
  r = await get(`/api/communities?q=${encodeURIComponent(cName)}`, N.token);
  check('hidden from search for non-members', r.status === 200 && !(r.data.communities || []).some(c => c.id === C), show(r));
  r = await get('/api/communities?recommended=true', N.token);
  check('...and from recommendations', r.status === 200 && !(r.data.communities || []).some(c => c.id === C), show(r));
  r = await get(`/api/communities?q=${encodeURIComponent(cName)}`, A.token);
  check("still in the Owner's own list (to re-enable it), marked disabled", (r.data.communities || []).some(c => c.id === C && c.disabled === true), show(r));
  r = await get(`/api/communities/${C}`, N.token);
  check('a non-member opening it -> 404 COMMUNITY_UNAVAILABLE', is(r, 404, 'COMMUNITY_UNAVAILABLE'), show(r));
  r = await post(`/api/communities/${C}/join`, N.token);
  check('a non-member joining -> 404 COMMUNITY_UNAVAILABLE', is(r, 404, 'COMMUNITY_UNAVAILABLE'), show(r));
  r = await post(`/api/communities/${C}/enable`, B.token);
  check('a member cannot re-enable -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));
  const enabledEvent = waitFor(bSock, 'community_enabled', 5000, p => p?.communityId === C);
  r = await post(`/api/communities/${C}/enable`, A.token);
  check('the Owner re-enables -> 200, back to normal', r.status === 200 && r.data.community?.disabled === false, show(r));
  check("B's open page is told", !!(await enabledEvent));
  r = await post(`/api/communities/${C}/messages`, B.token, { content: `back again ${stamp}` });
  check('members can write again', r.status === 201, show(r));
  r = await get(`/api/communities?q=${encodeURIComponent(cName)}`, N.token);
  check('back in search', (r.data.communities || []).some(c => c.id === C), show(r));
  r = await post(`/api/communities/${C}/enable`, A.token);
  check('re-enabling an active circle -> 409 NOT_DISABLED', is(r, 409, 'NOT_DISABLED'), show(r));

  section("Owner leaves their empty ACTIVE circle: it's deleted and its media queued");
  const D2 = (await must('A creates D2', post('/api/communities', A.token, { name: `Fixes D2 ${stamp}`, description: 'fixes test' }))).community.id;
  created.circles.push(D2);
  const d2Public = `sniffr/community_media/fixtest_d2_${stamp}`;
  const d2Url = `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME || 'demo'}/image/upload/v1/${d2Public}.jpg`;
  await db.run("INSERT INTO media_files (user_id, url, bytes, provider, resource_type, subdir) VALUES (?, ?, 1, 'cloudinary', 'image', 'community_media')", [A.userId, d2Url]);
  await must('A posts a photo in D2', post(`/api/communities/${D2}/messages`, A.token, { content: 'only me', media_url: d2Url }));
  r = await post(`/api/communities/${D2}/leave`, A.token);
  check('A (owner, only member) leaves -> 200, deleted', r.status === 200 && r.data.deleted === true, show(r));
  check('D2 is gone', !(await one('SELECT id FROM communities WHERE id = ?', [D2])));
  const queued = await one('SELECT deleted_user_id, resource_type FROM pending_media_deletions WHERE public_id = ?', [d2Public]);
  check("its photo is queued for the Cloudinary purge (like a frozen circle's)", queued?.deleted_user_id === A.userId && queued?.resource_type === 'image',
    JSON.stringify(queued));
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  for (const s of created.sockets) s.disconnect();
  for (const url of created.files) {
    const parsed = parseCloudinaryUrl(url);
    if (!parsed) continue;
    try {
      await cloudStorage.destroy(parsed.publicId, parsed.resourceType);
    } catch (err) {
      failed++;
      console.error(`  could not remove ${parsed.publicId} from Cloudinary: ${err.message}`);
    }
  }
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
    const posts = await list('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [pets]);
    const circleMsgs = await list('SELECT id FROM community_messages WHERE community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]);
    const matches = await list('SELECT id FROM matches WHERE pet1_id = ANY(?::int[]) OR pet2_id = ANY(?::int[])', [pets, pets]);
    const convs = await list('SELECT id FROM conversations WHERE match_id = ANY(?::int[])', [matches]);
    const msgs = await list('SELECT id FROM messages WHERE conversation_id = ANY(?::int[])', [convs]);
    const queueExists = (await tx.get("SELECT to_regclass('public.pending_auth_deletions') IS NOT NULL AS ok")).ok;
    const steps = [
      ['community_message_reactions', 'user_id = ANY(?::int[]) OR community_message_id = ANY(?::int[])', [users, circleMsgs]],
      ['community_messages', 'id = ANY(?::int[])', [circleMsgs]],
      ['community_polls', 'community_id = ANY(?::int[]) OR created_by = ANY(?::int[])', [circles, users]],
      ['community_join_requests', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[]) OR decided_by = ANY(?::int[])', [circles, users, users]],
      ['community_ownership_transfers', 'community_id = ANY(?::int[]) OR to_user_id = ANY(?::int[]) OR from_user_id = ANY(?::int[])', [circles, users, users]],
      ['community_members', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['communities', 'id = ANY(?::int[])', [circles]],
      ['message_reactions', 'message_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [msgs, users]],
      ['messages', 'id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [msgs, users]],
      ['conversations', 'id = ANY(?::int[])', [convs]],
      ['matches', 'id = ANY(?::int[])', [matches]],
      ['swipes', 'from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [pets, pets]],
      ['post_reports', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['likes', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['reactions', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['shares', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['comments', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['posts', 'id = ANY(?::int[])', [posts]],
      ['profile_views', 'viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [pets, pets]],
      ['spotlight_history', 'pet_id = ANY(?::int[])', [pets]],
      ['spotlight_rank_tracking', 'pet_id = ANY(?::int[])', [pets]],
      ['calls', 'caller_pet_id = ANY(?::int[]) OR receiver_pet_id = ANY(?::int[])', [pets, pets]],
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
  console.log(`Creates throwaway users fixes-test-${stamp}-{a,b,n}@example.invalid and one tiny Cloudinary image, then removes them.`);
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
  const created = { users: [], circles: [], sockets: [], files: [] };
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
