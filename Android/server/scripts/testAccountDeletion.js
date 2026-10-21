// Integration test for services/accountDeletion.js (deleteUserAccount),
// against the database in server/.env (currently production, no real users
// yet) and the LOCAL backend (your `npm run dev` on :3001) for fixture
// requests. The deletion itself runs in this process.
//
// Throwaway users: A (deleted; 2 pets, active paid plan), B and C (their
// data must stay untouched), and a throwaway admin. Builds a realistic
// fixture, then checks:
//   1. an injected mid-transaction failure rolls back EVERYTHING and the
//      code stays valid;
//   2. admins (incl. user 1), unknown users and a missing code are refused;
//   3. the real deletion does exactly what the design says;
//   4. a second call returns ALREADY_DELETED.
// Cleanup hard-deletes every test user and everything created, even if a
// check fails. Never modifies user 1 or any real admin.
//
//   node scripts/testAccountDeletion.js

// Must be set before config.js is loaded (dynamic imports below): enables
// the test-only failure hook in THIS process, and gives fake Cloudinary URLs
// a cloud name the deletion treats as ours.
const CLOUD = 'sniffr-deltest-cloud';
process.env.SNIFFR_TEST_HOOKS = '1';
process.env.CLOUDINARY_CLOUD_NAME = CLOUD;

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { issueCode, checkCode } = await import('../services/verificationCodes.js');
const { deleteUserAccount, AccountDeletionError } = await import('../services/accountDeletion.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({
  key, email: `del-test-${stamp}-${key}@example.invalid`, username: `del${key}_${stamp}`,
  petName: `Del${key.toUpperCase()}${stamp}`, handle: testPetUsername(`del${key}`),
});
const A = mk('a');
const B = mk('b');
const C = mk('c');
const ADM = mk('adm');
const COORDS = { lat: -54.2800, lng: -36.5000 };
const cloudUrl = (type, folder, name, ext) =>
  `https://res.cloudinary.com/${CLOUD}/${type}/upload/v1700000000/sniffr/${folder}/deltest_${stamp}_${name}.${ext}`;
const pid = (folder, name) => `sniffr/${folder}/deltest_${stamp}_${name}`;

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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const one = async (sql, params = []) => db.get(sql, params);
const n = async (sql, params = []) => (await db.get(sql, params)).n;

async function call(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}
async function must(label, promise, okStatuses = [200, 201]) {
  const r = await promise;
  if (!okStatuses.includes(r.status)) throw new Error(`fixture step failed: ${label}: ${show(r)}`);
  return r.data;
}
const get = (path, token) => call('GET', path, token);
const post = (path, token, body) => call('POST', path, token, body);

async function expectError(label, promise, code) {
  try {
    await promise;
    check(`${label} -> ${code}`, false, 'no error thrown');
  } catch (err) {
    check(`${label} -> ${code}`, err instanceof AccountDeletionError && err.code === code, `${err.code || ''} ${err.message}`);
  }
}

async function createUser(spec, created, { admin = false, login = true } = {}) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified, is_admin)
     VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
    [spec.email, spec.username, hash, `Deletion Test ${spec.key.toUpperCase()}`, admin]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  if (login) {
    const r = await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }));
    spec.token = r.accessToken;
  }
}
async function createPet(spec, name, handle) {
  const pet = await must(`pet for ${spec.key}`, post('/api/profile', spec.token, {
    name, pet_username: handle, type: 'dog', latitude: COORDS.lat, longitude: COORDS.lng, location_text: 'Deletion test',
  }));
  return pet.id;
}
// Every like starts a background Spotlight job (posts.js) that can still be
// writing after the request returned: spotlight_rank_tracking upserts,
// Spotlight notifications, and a lazy "yesterday's champion"
// spotlight_history row. Wait until all three stop changing for the test
// users/pets before building on them or deleting.
async function settleBackground(label, quietMs = 4000, maxMs = 60000) {
  const users = [A.userId, B.userId, C.userId].filter(Boolean);
  const pets = [A.pet1, A.pet2, B.pet, C.pet].filter(Boolean);
  const signature = async () => JSON.stringify(await one(
    `SELECT (SELECT count(*) FROM notifications WHERE user_id = ANY(?::int[])) AS notifications,
            (SELECT count(*) FROM spotlight_rank_tracking WHERE pet_id = ANY(?::int[])) AS rank_tracking,
            (SELECT count(*) FROM spotlight_history WHERE pet_id = ANY(?::int[])) AS history`,
    [users, pets, pets]));
  const started = Date.now();
  let last = null;
  let stableSince = Date.now();
  while (Date.now() - started < maxMs) {
    const now = await signature();
    if (now !== last) { last = now; stableSince = Date.now(); } else if (Date.now() - stableSince >= quietMs) {
      console.log(`  background settled (${label}) after ${Math.round((Date.now() - started) / 1000)}s`);
      return;
    }
    await sleep(500);
  }
  console.log(`  background did not settle within ${maxMs / 1000}s (${label}) -- continuing`);
}

// ── Fixture ─────────────────────────────────────────────────────────────
async function buildFixture(created) {
  section('Fixture');
  await createUser(A, created);
  await createUser(B, created);
  await createUser(C, created);
  await createUser(ADM, created, { admin: true, login: false });

  await db.run(
    `UPDATE users SET current_plan = 'gold', plan_source = 'paid', subscription_status = 'active',
       plan_start_date = NOW(), plan_expiry_date = NOW() + INTERVAL '30 days', auto_renew = 1
     WHERE id = ? AND email = ?`, [A.userId, A.email]);
  A.pet1 = await createPet(A, A.petName, A.handle);
  A.pet2 = await createPet(A, `${A.petName}Two`, testPetUsername('dela2'));
  B.pet = await createPet(B, B.petName, B.handle);
  C.pet = await createPet(C, C.petName, C.handle);
  await db.run('UPDATE pets SET avatar_url = ? WHERE id = ?', [cloudUrl('image', 'avatars', 'a_pet1', 'jpg'), A.pet1]);
  await db.run('UPDATE pets SET avatar_url = ? WHERE id = ?', ['https://lh3.googleusercontent.com/deltest-not-ours', A.pet2]);

  // Posts
  const aPost1 = await must('A post1', post('/api/posts', A.token, { caption: `A post one ${stamp}` }));
  const aPost2 = await must('A post2', post('/api/posts', A.token, { caption: `A post two ${stamp}` }));
  const bPost = await must('B post', post('/api/posts', B.token, { caption: `@${A.handle} hello from B ${stamp}` }));
  const cPost = await must('C post', post('/api/posts', C.token, { caption: `C post ${stamp}` }));
  const cPost2 = await must('C post2', post('/api/posts', C.token, { caption: `C post two ${stamp}` }));
  Object.assign(created.ids, { aPost1: aPost1.id, aPost2: aPost2.id, bPost: bPost.id, cPost: cPost.id, cPost2: cPost2.id });
  await db.run('UPDATE posts SET media_url = ? WHERE id = ?', [cloudUrl('image', 'posts', 'a_post1', 'jpg'), aPost1.id]);
  // Wrong folder for a post: must not be queued.
  await db.run('UPDATE posts SET media_url = ? WHERE id = ?', [cloudUrl('image', 'community_media', 'a_post2_wrong_folder', 'jpg'), aPost2.id]);

  // B and C on A's post (all deleted with the post)
  const bOnA = await must('B comments on A post', post(`/api/posts/${aPost1.id}/comment`, B.token, { content: `B on A ${stamp}` }));
  created.ids.bCommentOnA = bOnA.id;
  const cReply = await must('C replies under A post', post(`/api/posts/${aPost1.id}/comment`, C.token, { content: `C reply ${stamp}`, parentCommentId: bOnA.id }));
  created.ids.cReplyOnA = cReply.id;
  await must('B likes A post', post(`/api/posts/${aPost1.id}/like`, B.token));
  await must('C likes A post', post(`/api/posts/${aPost1.id}/like`, C.token));
  await must('B reacts A post', post(`/api/posts/${aPost1.id}/react`, B.token, { reaction: 'paw' }));
  await must('B shares A post', post(`/api/posts/${aPost1.id}/share`, B.token));
  await must('B reports A post', post(`/api/posts/${aPost1.id}/report`, B.token, { reason: 'test' }));

  // A on B's and C's posts (kept, except A's share)
  const aOnB = await must('A comments on B post', post(`/api/posts/${bPost.id}/comment`, A.token, { content: `A on B ${stamp}` }));
  created.ids.aCommentOnB = aOnB.id;
  const bReply = await must('B replies to A', post(`/api/posts/${bPost.id}/comment`, B.token, { content: `B reply to A ${stamp}`, parentCommentId: aOnB.id }));
  created.ids.bReplyToA = bReply.id;
  const bMention = await must('B mentions A in a comment', post(`/api/posts/${bPost.id}/comment`, B.token, { content: `hey @${A.handle} look` }));
  created.ids.bMentionComment = bMention.id;
  await must('A likes B post', post(`/api/posts/${bPost.id}/like`, A.token));
  await must('C likes B post', post(`/api/posts/${bPost.id}/like`, C.token)); // grouped for B: [C, A]
  await must('A likes C post', post(`/api/posts/${cPost.id}/like`, A.token));
  await must('A reacts B post', post(`/api/posts/${bPost.id}/react`, A.token, { reaction: 'bone' }));
  await must('A shares B post', post(`/api/posts/${bPost.id}/share`, A.token));
  await must('A reports B post', post(`/api/posts/${bPost.id}/report`, A.token, { reason: 'test' }));
  // The six likes above each started a background Spotlight job.
  await settleBackground('after likes');

  // Match + conversation A–B
  await must('B sniffs A', post(`/api/matches/like/${A.pet1}`, B.token));
  await must('A accepts B', post(`/api/matches/pending/${B.pet}/respond`, A.token, { action: 'accept' }));
  const convs = await must('A conversations', get('/api/chat/conversations', A.token));
  created.ids.conversation = convs.conversations.find(c => c.partner_pet_id === B.pet)?.id;
  if (!created.ids.conversation) throw new Error('no A–B conversation');
  const conv = created.ids.conversation;
  const aText = await must('A text', post('/api/chat/messages', A.token, { conversationId: conv, content: `A says hi ${stamp}` }));
  const bText = await must('B text', post('/api/chat/messages', B.token, { conversationId: conv, content: `B says hi @${A.handle}` }));
  Object.assign(created.ids, { aText: aText.id, bText: bText.id });
  created.ids.aImage = (await one(
    "INSERT INTO messages (conversation_id, sender_id, content, media_url, message_type, status) VALUES (?, ?, '', ?, 'image', 'sent') RETURNING id",
    [conv, A.userId, cloudUrl('image', 'chat', 'a_chat_img', 'jpg')])).id;
  created.ids.aVoice = (await one(
    "INSERT INTO messages (conversation_id, sender_id, content, media_url, message_type, status) VALUES (?, ?, '', ?, 'voice', 'sent') RETURNING id",
    [conv, A.userId, cloudUrl('video', 'chat', 'a_voice', 'webm')])).id;
  await db.run("INSERT INTO message_reactions (message_id, user_id, reaction) VALUES (?, ?, 'paw') ON CONFLICT (message_id, user_id) DO NOTHING", [created.ids.aText, B.userId]);
  await db.run("INSERT INTO message_reactions (message_id, user_id, reaction) VALUES (?, ?, 'paw') ON CONFLICT (message_id, user_id) DO NOTHING", [created.ids.bText, A.userId]);
  await must('B logs a call to A', post('/api/chat/calls/log', B.token, { receiverPetId: A.pet1, type: 'audio', status: 'completed', duration: 9 }));

  // Pending sniff A -> C, profile views both ways
  await must('A sniffs C', post(`/api/matches/like/${C.pet}`, A.token));
  await must('B views A', post(`/api/profile/${A.pet1}/view`, B.token));
  await must('A views C', post(`/api/profile/${C.pet}/view`, A.token));

  // PawCircles
  const aCircle = await must('A creates circle', post('/api/communities', A.token, { name: `Del A Circle ${stamp}`, description: 'test' }));
  const cCircle = await must('C creates circle', post('/api/communities', C.token, { name: `Del C Circle ${stamp}`, description: 'test' }));
  created.ids.aCircle = aCircle.community.id;
  created.ids.cCircle = cCircle.community.id;
  await must('B joins A circle', post(`/api/communities/${created.ids.aCircle}/join`, B.token));
  await must('A joins C circle', post(`/api/communities/${created.ids.cCircle}/join`, A.token));
  const aCircleMsg = await must('A posts in own circle', post(`/api/communities/${created.ids.aCircle}/messages`, A.token, { content: `A circle msg ${stamp}` }));
  created.ids.aCircleMsg = aCircleMsg.message.id;
  const sharedMedia = cloudUrl('image', 'community_media', 'a_circle_media', 'jpg');
  await db.run('UPDATE community_messages SET media_url = ? WHERE id = ?', [sharedMedia, created.ids.aCircleMsg]);
  // Recorded as A's upload (what a real upload writes), so the circle route's
  // own-uploads-only rule lets B re-share it.
  await db.run("INSERT INTO media_files (user_id, url, bytes, provider, resource_type, subdir, created_at) VALUES (?, ?, 1000, 'cloudinary', 'image', 'community_media', NOW())",
    [A.userId, sharedMedia]);
  // B re-posts the same URL: still referenced after A's deletion, so it must NOT be queued.
  const bCircleMsg = await must('B posts same media + mention', post(`/api/communities/${created.ids.aCircle}/messages`, B.token,
    { content: `nice @${A.handle}`, media_url: sharedMedia }));
  created.ids.bCircleMsg = bCircleMsg.message.id;
  const aInC = await must('A posts in C circle', post(`/api/communities/${created.ids.cCircle}/messages`, A.token, { content: `A in C circle ${stamp}` }));
  created.ids.aInCMsg = aInC.message.id;
  await db.run('INSERT INTO community_photos (community_id, user_id, media_url, caption) VALUES (?, ?, ?, ?)',
    [created.ids.cCircle, A.userId, cloudUrl('image', 'community_photos', 'a_photo', 'jpg'), 'A photo']);
  const aAnn = await must('A announcement with coordinates', post(`/api/communities/${created.ids.aCircle}/announcements`, A.token,
    { title: 'Meetup', content: `meet here ${stamp}`, is_event: true, latitude: COORDS.lat, longitude: COORDS.lng }));
  created.ids.aAnnouncement = (aAnn.announcement || aAnn).id;
  const cAnn = await must('C announcement mentioning A', post(`/api/communities/${created.ids.cCircle}/announcements`, C.token,
    { title: 'Hello', content: `welcome @${A.handle}` }));
  created.ids.cAnnouncement = (cAnn.announcement || cAnn).id;
  created.ids.aEvent = (await one(
    'INSERT INTO community_events (community_id, title, location, created_by) VALUES (?, ?, ?, ?) RETURNING id',
    [created.ids.aCircle, 'A event', 'Near my house', A.userId])).id;
  created.ids.aPoll = (await one(
    `INSERT INTO community_polls (community_id, question, options_json, votes_json, created_by) VALUES (?, 'A poll', '["x","y"]', '{}', ?) RETURNING id`,
    [created.ids.aCircle, A.userId])).id;
  created.ids.cPoll = (await one(
    `INSERT INTO community_polls (community_id, question, options_json, votes_json, created_by) VALUES (?, 'C poll', '["x","y"]', '{}', ?) RETURNING id`,
    [created.ids.cCircle, C.userId])).id;
  await must('A votes in C poll', post(`/api/communities/${created.ids.cCircle}/polls/${created.ids.cPoll}/vote`, A.token, { optionIndex: 0 }));
  await db.run('INSERT INTO community_join_requests (community_id, user_id) VALUES (?, ?) ON CONFLICT (community_id, user_id) DO NOTHING', [created.ids.cCircle, A.userId]);

  // Notifications: legacy grouped rows (no pet_ids) to C
  created.ids.legacyMatch = (await one(
    `INSERT INTO notifications (user_id, category, type, title, description, target_id, action_status, metadata_json)
     VALUES (?, 'activity', 'lick', ?, '', ?, 'pending', ?) RETURNING id`,
    [C.userId, `${A.petName} and 1 other liked your post 🐾`, String(cPost.id), JSON.stringify({ names: [A.petName, 'OtherPet'] })])).id;
  // Same name on a post A never liked: must stay untouched.
  created.ids.legacyNoMatch = (await one(
    `INSERT INTO notifications (user_id, category, type, title, description, target_id, action_status, metadata_json)
     VALUES (?, 'activity', 'lick', ?, ?, ?, 'pending', ?) RETURNING id`,
    [C.userId, `${A.petName} liked your post 🐾`, `${A.petName} liked your post 🐾`, String(cPost2.id), JSON.stringify({ names: [A.petName] })])).id;

  // Payments, Spotlight, media_files, private rows
  await db.run("INSERT INTO payment_sessions (user_id, plan, amount, provider, status) VALUES (?, 'gold', 199, 'upi_manual', 'pending')", [A.userId]);
  await db.run(
    `INSERT INTO payment_sessions (user_id, plan, amount, provider, status, payment_method, upi_transaction_id, proof_url, submitted_at)
     VALUES (?, 'gold', 199, 'upi_manual', 'pending_review', 'upi', ?, ?, NOW())`,
    [A.userId, `DELTEST${stamp}`, cloudUrl('image', 'payment_proofs', 'a_proof', 'jpg')]);
  // cycle_date is unique to this run, so this can't collide with the app's own rows (UNIQUE (area, cycle_date)).
  await db.run("INSERT INTO spotlight_history (pet_id, area, score, cycle_date) VALUES (?, 'locality', 5, ?)", [A.pet1, `zz-deltest-${stamp}`]);
  // The like jobs have usually created this row already: make sure one exists either way.
  await db.run(
    `INSERT INTO spotlight_rank_tracking (pet_id, area, last_notified_rank) VALUES (?, 'city', 3)
     ON CONFLICT (pet_id, area) DO UPDATE SET last_notified_rank = EXCLUDED.last_notified_rank`, [A.pet1]);
  await db.run("INSERT INTO media_files (user_id, url, bytes, provider, resource_type, subdir, created_at) VALUES (?, ?, 1000, 'cloudinary', 'image', 'posts', NOW())",
    [A.userId, cloudUrl('image', 'posts', 'a_media_files_only', 'jpg')]);
  await db.run("INSERT INTO media_files (user_id, url, bytes, provider, resource_type, subdir, created_at) VALUES (?, ?, 1000, 'cloudinary', 'image', 'payment_proofs', NOW())",
    [A.userId, cloudUrl('image', 'payment_proofs', 'a_proof_mf', 'jpg')]);
  await db.run("INSERT INTO trusted_devices (user_id, device_token, device_info, expires_at) VALUES (?, ?, 'test', NOW() + INTERVAL '1 day') ON CONFLICT (device_token) DO NOTHING",
    [A.userId, `deltest-${stamp}`]);
  await db.run('INSERT INTO app_ratings (user_id, rating) VALUES (?, 5) ON CONFLICT (user_id) DO UPDATE SET rating = EXCLUDED.rating', [A.userId]);
  await db.run('INSERT INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT (blocker_id, blocked_id) DO NOTHING', [A.userId, ADM.userId]);
  await db.run('INSERT INTO blocked_users (blocker_id, blocked_id) VALUES (?, ?) ON CONFLICT (blocker_id, blocked_id) DO NOTHING', [ADM.userId, A.userId]);

  await settleBackground('end of fixture');
  console.log('  fixture built');
}

// B and C's own data, minus anything that legitimately changes (rows on A's
// posts, text with @A mentions, notification text, Spotlight broadcasts).
async function snapshotOthers(ids) {
  const users = [B.userId, C.userId];
  const pets = [B.pet, C.pet];
  const aPosts = [ids.aPost1, ids.aPost2];
  return JSON.stringify({
    users: await db.all('SELECT id, email, username, password_hash, deleted_at, is_admin FROM users WHERE id = ANY(?::int[]) ORDER BY id', [users]),
    pets: await db.all('SELECT id, name, avatar_url, pet_username, deleted_at FROM pets WHERE id = ANY(?::int[]) ORDER BY id', [pets]),
    posts: await n('SELECT count(*)::int AS n FROM posts WHERE pet_id = ANY(?::int[])', [pets]),
    comments: await n('SELECT count(*)::int AS n FROM comments WHERE user_id = ANY(?::int[]) AND NOT (post_id = ANY(?::int[]))', [users, aPosts]),
    likes: await n('SELECT count(*)::int AS n FROM likes WHERE user_id = ANY(?::int[]) AND NOT (post_id = ANY(?::int[]))', [users, aPosts]),
    reactions: await n('SELECT count(*)::int AS n FROM reactions WHERE user_id = ANY(?::int[]) AND NOT (post_id = ANY(?::int[]))', [users, aPosts]),
    messages: await n('SELECT count(*)::int AS n FROM messages WHERE sender_id = ANY(?::int[])', [users]),
    circleMessages: await n('SELECT count(*)::int AS n FROM community_messages WHERE sender_id = ANY(?::int[])', [users]),
    memberships: await db.all('SELECT community_id, user_id, role FROM community_members WHERE user_id = ANY(?::int[]) ORDER BY 1, 2', [users]),
    notifications: await n("SELECT count(*)::int AS n FROM notifications WHERE user_id = ANY(?::int[]) AND type NOT LIKE 'spotlight%'", [users]),
    cCircle: await one('SELECT status, frozen_at FROM communities WHERE id = ?', [ids.cCircle]),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────
async function runTests(created) {
  await buildFixture(created);
  const ids = created.ids;

  const { code } = await issueCode(A.userId, 'delete_account');
  const verified = await checkCode(db, A.userId, 'delete_account', code);
  if (verified.status !== 'OK') throw new Error(`code check failed: ${JSON.stringify(verified)}`);
  const codeId = verified.codeId;

  section('1. Injected failure mid-transaction rolls back everything');
  const aBefore = await one('SELECT email, username, deleted_at FROM users WHERE id = ?', [A.userId]);
  const notifsToABefore = await n('SELECT count(*)::int AS n FROM notifications WHERE user_id = ?', [A.userId]);
  let injected = null;
  try { await deleteUserAccount(A.userId, { codeId, _testFailAt: 'before_assertions' }); } catch (err) { injected = err; }
  check('injected failure surfaced as an error', injected?.message?.includes('Injected test failure'), injected?.message);
  const aAfterFail = await one('SELECT email, username, deleted_at FROM users WHERE id = ?', [A.userId]);
  check('A untouched (email, username, not deleted)', JSON.stringify(aAfterFail) === JSON.stringify(aBefore), JSON.stringify(aAfterFail));
  check("A's posts still there", await n('SELECT count(*)::int AS n FROM posts WHERE pet_id = ANY(?::int[])', [[A.pet1, A.pet2]]) === 2);
  check("A's chat image still has its media", !!(await one('SELECT media_url FROM messages WHERE id = ?', [ids.aImage]))?.media_url);
  check("A's circle not frozen", (await one('SELECT status FROM communities WHERE id = ?', [ids.aCircle]))?.status === 'active');
  check('notifications to A unchanged', await n('SELECT count(*)::int AS n FROM notifications WHERE user_id = ?', [A.userId]) === notifsToABefore);
  check('nothing queued for Cloudinary', await n('SELECT count(*)::int AS n FROM pending_media_deletions WHERE deleted_user_id = ?', [A.userId]) === 0);
  const codeRow = await one('SELECT consumed_at, invalidated_at FROM verification_codes WHERE id = ?', [codeId]);
  check('code NOT consumed (still valid)', codeRow && codeRow.consumed_at === null && codeRow.invalidated_at === null, JSON.stringify(codeRow));
  check('checkCode still returns OK', (await checkCode(db, A.userId, 'delete_account', code)).status === 'OK');

  section('2. Refusals');
  await expectError('user 1', deleteUserAccount(PROTECTED_USER_ID, { skipCode: true }), 'ADMIN_CANNOT_SELF_DELETE');
  await expectError('throwaway admin', deleteUserAccount(ADM.userId, { skipCode: true }), 'ADMIN_CANNOT_SELF_DELETE');
  await expectError('unknown user', deleteUserAccount(2147483000, { skipCode: true }), 'USER_NOT_FOUND');
  await expectError('no code and no skipCode', deleteUserAccount(A.userId, {}), 'CODE_REQUIRED');
  await expectError('a code that is not A\'s', deleteUserAccount(A.userId, { codeId: 2147483000 }), 'CODE_INVALID');

  const othersBefore = await snapshotOthers(ids);

  // C's reply under A's post notified B with A's POST IMAGE as thumbnail
  // (posts.js). That copy must not keep A's file alive after deletion.
  const replyNotif = await one(
    "SELECT id, avatar_url FROM notifications WHERE user_id = ? AND type = 'comment_reply' AND target_id = ?", [B.userId, String(ids.aPost1)]);
  check("precondition: B's reply notification uses A's post image as thumbnail",
    replyNotif?.avatar_url === cloudUrl('image', 'posts', 'a_post1', 'jpg'), JSON.stringify(replyNotif));

  section('3. Real deletion');
  const result = await deleteUserAccount(A.userId, { codeId });
  check('returns both pet ids', JSON.stringify([...result.petIds].sort((a, b) => a - b)) === JSON.stringify([A.pet1, A.pet2].sort((a, b) => a - b)), JSON.stringify(result.petIds));
  check('returns the owned circle', JSON.stringify(result.ownedCircleIds) === JSON.stringify([ids.aCircle]), JSON.stringify(result.ownedCircleIds));
  check('returns the A–B conversation', result.conversationIds.includes(ids.conversation), JSON.stringify(result.conversationIds));

  // User + pets scrubbed
  const u = await one('SELECT * FROM users WHERE id = ?', [A.userId]);
  const ph = `sniffedout~${A.userId}`;
  check('user: placeholders, password, auth link, admin flag', u.email === ph && u.username === ph && u.password_hash === '!deleted'
    && u.auth_user_id === null && u.is_admin === false && u.full_name === 'SniffedOut' && !!u.deleted_at, JSON.stringify({ email: u.email, username: u.username }));
  check('user: plan reset to free', u.current_plan === 'free' && u.subscription_status === 'inactive' && u.plan_expiry_date === null
    && u.boost_credits_remaining === 0 && Number(u.storage_used_bytes) === 0, `${u.current_plan}/${u.subscription_status}`);
  const pets = await db.all('SELECT * FROM pets WHERE user_id = ? ORDER BY id', [A.userId]);
  check('both pets tombstoned and scrubbed', pets.length === 2 && pets.every(p => p.deleted_at && p.name === 'SniffedOut' && p.pet_username === null
    && p.avatar_url === null && p.latitude === null && p.bio === null && p.breed_name === null), JSON.stringify(pets.map(p => p.name)));
  const oldUrl = await get(`/api/profile/${A.handle}`, B.token);
  check("A's old pet username URL (app.sniffrweb.com/<username>) -> 404, handle released",
    oldUrl.status === 404 && oldUrl.data?.error === 'NOT_FOUND', `${oldUrl.status} ${JSON.stringify(oldUrl.data)}`);

  // Own posts
  check("A's posts deleted", await n('SELECT count(*)::int AS n FROM posts WHERE id = ANY(?::int[])', [[ids.aPost1, ids.aPost2]]) === 0);
  for (const t of ['likes', 'reactions', 'shares', 'post_reports', 'comments']) {
    check(`${t} on A's posts deleted`, await n(`SELECT count(*)::int AS n FROM ${t} WHERE post_id = ANY(?::int[])`, [[ids.aPost1, ids.aPost2]]) === 0);
  }
  check("C's reply under A's post deleted", !(await one('SELECT id FROM comments WHERE id = ?', [ids.cReplyOnA])));
  check("A's share of B's post deleted", await n('SELECT count(*)::int AS n FROM shares WHERE user_id = ?', [A.userId]) === 0);

  // Kept
  check("A's comment on B's post kept (and B's reply)", !!(await one('SELECT id FROM comments WHERE id = ?', [ids.aCommentOnB]))
    && !!(await one('SELECT id FROM comments WHERE id = ?', [ids.bReplyToA])));
  check("A's likes on B's and C's posts kept", await n('SELECT count(*)::int AS n FROM likes WHERE user_id = ?', [A.userId]) === 2);
  check("A's reaction on B's post kept", await n('SELECT count(*)::int AS n FROM reactions WHERE user_id = ?', [A.userId]) === 1);
  check("A's report on B's post kept", await n('SELECT count(*)::int AS n FROM post_reports WHERE user_id = ?', [A.userId]) === 1);
  check('message reactions both ways kept', await n('SELECT count(*)::int AS n FROM message_reactions WHERE message_id = ANY(?::int[])', [[ids.aText, ids.bText]]) === 2);
  check("A's poll vote in C's poll kept",
    JSON.stringify(JSON.parse((await one('SELECT votes_json FROM community_polls WHERE id = ?', [ids.cPoll])).votes_json)).includes(String(A.userId)));
  check('call with B kept', await n('SELECT count(*)::int AS n FROM calls WHERE caller_pet_id = ? AND receiver_pet_id = ?', [B.pet, A.pet1]) === 1);
  check('past Spotlight win kept', await n('SELECT count(*)::int AS n FROM spotlight_history WHERE pet_id = ? AND cycle_date = ?', [A.pet1, `zz-deltest-${stamp}`]) === 1);
  check('match and conversation kept', !!(await one('SELECT id FROM conversations WHERE id = ?', [ids.conversation])));

  // Chats
  const aText = await one('SELECT content, media_url FROM messages WHERE id = ?', [ids.aText]);
  check("A's text message kept", aText?.content === `A says hi ${stamp}`, JSON.stringify(aText));
  check("A's image and voice messages kept with media_url NULL",
    (await db.all('SELECT media_url FROM messages WHERE id = ANY(?::int[])', [[ids.aImage, ids.aVoice]])).every(m => m.media_url === null));

  // Circles
  const aCircle = await one('SELECT status, frozen_at, frozen_reason, member_count FROM communities WHERE id = ?', [ids.aCircle]);
  check('owned circle frozen (owner_deleted)', aCircle.status === 'frozen' && !!aCircle.frozen_at && aCircle.frozen_reason === 'owner_deleted', JSON.stringify(aCircle));
  check('owner membership row kept', !!(await one("SELECT id FROM community_members WHERE community_id = ? AND user_id = ? AND role = 'Owner'", [ids.aCircle, A.userId])));
  check('owned circle member_count excludes the tombstone (B only = 1)', aCircle.member_count === 1, aCircle.member_count);
  check("A removed from C's circle", !(await one('SELECT id FROM community_members WHERE community_id = ? AND user_id = ?', [ids.cCircle, A.userId])));
  check("C's circle member_count recalculated (C only = 1)", (await one('SELECT member_count FROM communities WHERE id = ?', [ids.cCircle])).member_count === 1);
  check("A's circle message kept, media NULL", (await one('SELECT content, media_url FROM community_messages WHERE id = ?', [ids.aCircleMsg]))?.media_url === null);
  check("A's message in C's circle kept", !!(await one('SELECT id FROM community_messages WHERE id = ?', [ids.aInCMsg])));
  check("A's circle photo deleted", await n('SELECT count(*)::int AS n FROM community_photos WHERE user_id = ?', [A.userId]) === 0);
  check("A's join request deleted", await n('SELECT count(*)::int AS n FROM community_join_requests WHERE user_id = ?', [A.userId]) === 0);
  const ann = await one('SELECT latitude, longitude FROM community_announcements WHERE id = ?', [ids.aAnnouncement]);
  check("A's announcement coordinates wiped", ann && ann.latitude === null && ann.longitude === null, JSON.stringify(ann));
  check("owned circle's event location wiped", (await one('SELECT location FROM community_events WHERE id = ?', [ids.aEvent]))?.location === null);
  check("owned circle's poll kept", !!(await one('SELECT id FROM community_polls WHERE id = ?', [ids.aPoll])));

  // Notifications
  check('notifications TO A deleted', await n('SELECT count(*)::int AS n FROM notifications WHERE user_id = ?', [A.userId]) === 0);
  const fromA = await db.all('SELECT id, type, title, description, avatar_url, action_status FROM notifications WHERE sender_pet_id = ANY(?::int[])', [[A.pet1, A.pet2]]);
  check('notifications FROM A kept, avatar NULL, no old pet name',
    fromA.length > 0 && fromA.every(x => x.avatar_url === null && !`${x.title} ${x.description}`.includes(A.petName)),
    JSON.stringify(fromA.map(x => ({ type: x.type, title: x.title }))));
  const cRequest = fromA.find(x => x.type === 'match_request');
  check("C's pending sniff request from A expired", cRequest?.action_status === 'expired', JSON.stringify(cRequest));
  const bGrouped = await one("SELECT title, metadata_json FROM notifications WHERE user_id = ? AND type = 'lick' AND target_id = ?", [B.userId, String(ids.bPost)]);
  check("B's grouped like: A replaced by SniffedOut via pet id, title rebuilt",
    JSON.parse(bGrouped?.metadata_json || '{}').names?.includes('SniffedOut') && !bGrouped.title.includes(A.petName)
    && bGrouped.title.includes(C.petName), JSON.stringify(bGrouped));
  const replyAfter = replyNotif ? await one('SELECT id, avatar_url FROM notifications WHERE id = ?', [replyNotif.id]) : null;
  check("B's reply notification kept, but its copy of A's post image cleared",
    !!replyAfter && replyAfter.avatar_url === null, JSON.stringify(replyAfter));
  const legacy = await one('SELECT title, metadata_json FROM notifications WHERE id = ?', [ids.legacyMatch]);
  check('legacy grouped row (A really liked it): name replaced',
    JSON.stringify(JSON.parse(legacy.metadata_json).names) === JSON.stringify(['SniffedOut', 'OtherPet']) && legacy.title === 'SniffedOut and 1 other liked your post 🐾',
    JSON.stringify(legacy));
  const legacyNo = await one('SELECT title, metadata_json FROM notifications WHERE id = ?', [ids.legacyNoMatch]);
  check('legacy row on a post A never liked: untouched (same-name protection)',
    legacyNo.title === `${A.petName} liked your post 🐾` && JSON.parse(legacyNo.metadata_json).names[0] === A.petName, JSON.stringify(legacyNo));

  // Mentions
  const sniffed = '@SniffedOut';
  check('mention rewritten in B\'s post caption', (await one('SELECT caption FROM posts WHERE id = ?', [ids.bPost]))?.caption === `${sniffed} hello from B ${stamp}`);
  check('mention rewritten in B\'s comment', (await one('SELECT content FROM comments WHERE id = ?', [ids.bMentionComment]))?.content === `hey ${sniffed} look`);
  check('mention rewritten in B\'s chat message', (await one('SELECT content FROM messages WHERE id = ?', [ids.bText]))?.content === `B says hi ${sniffed}`);
  check('mention rewritten in B\'s circle message', (await one('SELECT content FROM community_messages WHERE id = ?', [ids.bCircleMsg]))?.content === `nice ${sniffed}`);
  check('mention rewritten in C\'s announcement', (await one('SELECT content FROM community_announcements WHERE id = ?', [ids.cAnnouncement]))?.content === `welcome ${sniffed}`);

  // Private rows
  const privateCounts = {
    swipes: await n('SELECT count(*)::int AS n FROM swipes WHERE from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [[A.pet1, A.pet2], [A.pet1, A.pet2]]),
    profile_views: await n('SELECT count(*)::int AS n FROM profile_views WHERE viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [[A.pet1, A.pet2], [A.pet1, A.pet2]]),
    spotlight_rank_tracking: await n('SELECT count(*)::int AS n FROM spotlight_rank_tracking WHERE pet_id = ANY(?::int[])', [[A.pet1, A.pet2]]),
    blocked_users: await n('SELECT count(*)::int AS n FROM blocked_users WHERE blocker_id = ? OR blocked_id = ?', [A.userId, A.userId]),
  };
  for (const t of ['trusted_devices', 'refresh_tokens', 'notification_preferences', 'app_ratings', 'verification_codes']) {
    privateCounts[t] = await n(`SELECT count(*)::int AS n FROM ${t} WHERE user_id = ?`, [A.userId]);
  }
  check('swipes, profile views, rank tracking, blocks, devices, tokens, prefs, rating, codes all deleted',
    Object.values(privateCounts).every(v => v === 0), JSON.stringify(privateCounts));

  // Payments
  const sessions = await db.all('SELECT status, user_id FROM payment_sessions WHERE user_id = ? ORDER BY id', [A.userId]);
  check("payments: 'pending' cancelled, 'pending_review' untouched, still linked to A",
    JSON.stringify(sessions.map(s => s.status)) === JSON.stringify(['cancelled', 'pending_review']), JSON.stringify(sessions));
  check("plan_history has an 'account_deleted' row", await n("SELECT count(*)::int AS n FROM plan_history WHERE user_id = ? AND action = 'account_deleted'", [A.userId]) === 1);

  // Media queue
  const queued = (await db.all('SELECT public_id, resource_type, source FROM pending_media_deletions WHERE deleted_user_id = ? ORDER BY public_id', [A.userId]));
  const expected = [
    pid('avatars', 'a_pet1'), pid('chat', 'a_chat_img'), pid('chat', 'a_voice'),
    pid('community_photos', 'a_photo'), pid('posts', 'a_media_files_only'), pid('posts', 'a_post1'),
  ].sort();
  check('queued media: exactly the 6 expected files', JSON.stringify(queued.map(q => q.public_id).sort()) === JSON.stringify(expected),
    JSON.stringify(queued));
  check('voice note queued as a video resource', queued.find(q => q.public_id === pid('chat', 'a_voice'))?.resource_type === 'video');
  check('not queued: shared circle media, wrong-folder post, other-host avatar, payment proofs',
    !queued.some(q => [pid('community_media', 'a_circle_media'), pid('community_media', 'a_post2_wrong_folder'),
      pid('payment_proofs', 'a_proof'), pid('payment_proofs', 'a_proof_mf')].includes(q.public_id)));
  check('pendingMediaCount matches the queue', result.pendingMediaCount === queued.length, `${result.pendingMediaCount} vs ${queued.length}`);
  // a_media_files_only, a_proof_mf and the shared circle photo.
  check('media_files rows kept for the purge step', await n('SELECT count(*)::int AS n FROM media_files WHERE user_id = ?', [A.userId]) === 3);

  // B and C untouched
  const othersAfter = await snapshotOthers(ids);
  check("B's and C's own data untouched", othersAfter === othersBefore, othersAfter === othersBefore ? '' : `\n    before ${othersBefore}\n    after  ${othersAfter}`);

  section('4. Second call');
  await expectError('deleting A again', deleteUserAccount(A.userId, { skipCode: true }), 'ALREADY_DELETED');
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
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
    const circles = await list('SELECT id FROM communities WHERE created_by = ANY(?::int[])', [users]);
    const outsiders = await tx.get(
      'SELECT count(*)::int AS n FROM community_members WHERE community_id = ANY(?::int[]) AND NOT (user_id = ANY(?::int[]))', [circles, users]);
    if (outsiders.n) throw new Error(`${outsiders.n} non-test member(s) joined a test circle -- leaving it for a manual look`);
    const matches = await list('SELECT id FROM matches WHERE pet1_id = ANY(?::int[]) OR pet2_id = ANY(?::int[])', [pets, pets]);
    const convs = await list('SELECT id FROM conversations WHERE match_id = ANY(?::int[])', [matches]);
    const msgs = await list('SELECT id FROM messages WHERE conversation_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [convs, users]);
    const posts = await list('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [pets]);
    const circleMsgs = await list('SELECT id FROM community_messages WHERE community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]);
    const sessions = await list('SELECT id FROM payment_sessions WHERE user_id = ANY(?::int[])', [users]);

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
      ['plan_history', 'user_id = ANY(?::int[]) OR payment_session_id = ANY(?::int[])', [users, sessions]],
      ['payment_sessions', 'id = ANY(?::int[])', [sessions]],
      ['pending_media_deletions', 'deleted_user_id = ANY(?::int[])', [users]],
      ['media_files', 'user_id = ANY(?::int[])', [users]],
      ['blocked_users', 'blocker_id = ANY(?::int[]) OR blocked_id = ANY(?::int[])', [users, users]],
      ['notification_preferences', 'user_id = ANY(?::int[])', [users]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [users]],
      ['trusted_devices', 'user_id = ANY(?::int[])', [users]],
      ['app_ratings', 'user_id = ANY(?::int[])', [users]],
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
      const ids = f.ref_table === 'users' ? users : pets;
      const row = await tx.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ANY(?::int[])`, [ids]);
      if (row.n) leftovers.push(`${f.table_name}.${f.column_name} (${row.n})`);
    }
    if (leftovers.length) throw new Error(`unexpected rows still reference the test accounts: ${leftovers.join(', ')}`);

    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} test users, ${petDel.rowCount} pets${counts.length ? `, ${counts.join(', ')}` : ''}`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Backend used for fixture requests: ${API_BASE}`);
  console.log(`Creates throwaway users del-test-${stamp}-{a,b,c,adm}@example.invalid, runs the tests, then deletes them.`);
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
  const created = { users: [], ids: {} };
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
  process.exit(failed ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
