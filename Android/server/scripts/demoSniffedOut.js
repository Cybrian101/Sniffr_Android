// Demo data for checking the SniffedOut screens in the browser, against your
// running backend (`npm run dev` on :3001, STORAGE_TYPE=cloud), the database
// in server/.env (production, no real users yet) and the real Cloudinary
// account from server/.env.
//
//   node scripts/demoSniffedOut.js setup
//     Creates throwaway users A (you log in as A; email + password printed)
//     and B, both with pets, and builds: a match + 1:1 chat with texts both
//     ways, replies, real image uploads from both, a voice note, a file, a
//     meetup invite and a profile card from B, shared post cards both ways,
//     a call; B comments on and likes A's post (-> notifications to A); a
//     PawCircle owned by B with A as a member, messages and photos from both;
//     a Spotlight history win for B's pet. Then deletes B through
//     deleteUserAccount (skipCode) and purges B's Cloudinary files, so B is a
//     real SniffedOut. Everything created is recorded in
//     scripts/.demo-sniffedout.json (gitignored).
//
//   node scripts/demoSniffedOut.js teardown
//     Destroys every Cloudinary file the setup uploaded and hard-deletes the
//     demo users and everything attached to them, then removes the ids file.
//
//   node scripts/demoSniffedOut.js extend
//     Adds data for the remaining SniffedOut screens to an existing demo,
//     without touching anything already there. B is already deleted, so
//     these are inserted the way the deletion leaves them: an expired Meet
//     request and a profile-view notification from SniffedOut, a reply
//     notification pointing at B's deleted post, and a new post by A that
//     mentions @SniffedOut. Runs once per demo.
//
//   node scripts/demoSniffedOut.js reset-password
//     Sets a new random password for demo user A (from the ids file) and
//     prints the email and password once. Nothing else changes.
//
// Never touches user 1, admins, or any account the ids file doesn't list --
// except one approved step: teardown removes user 1's membership and messages
// in the demo circle (see deleteDemoRows).

const readline = await import('readline/promises');
const crypto = await import('crypto');
const fs = await import('fs');
const path = await import('path');
const { fileURLToPath } = await import('url');
const { default: bcrypt } = await import('bcryptjs');
const { default: config } = await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { default: cloudStorage } = await import('../storage/CloudStorage.js');
const { deleteUserAccount, parseCloudinaryUrl } = await import('../services/accountDeletion.js');
const { purgeAfterDeletion, purgePendingMedia } = await import('../services/mediaPurge.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const STATE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.demo-sniffedout.json');
const COORDS = { lat: -54.2800, lng: -36.5000 };
// A valid 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const section = title => console.log(`\n── ${title}`);
const show = r => `${r.status} ${JSON.stringify(r.data).slice(0, 300)}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const one = (sql, params = []) => db.get(sql, params);

// ── State file ──────────────────────────────────────────────────────────
function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
}
// Written after every step, so a setup that stops half-way can still be torn down.
function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── HTTP helpers ────────────────────────────────────────────────────────
async function call(method, urlPath, token, body) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
async function must(label, promise, okStatuses = [200, 201]) {
  const r = await promise;
  if (!okStatuses.includes(r.status)) throw new Error(`${label}: ${show(r)}`);
  return r.data;
}
const get = (urlPath, token) => call('GET', urlPath, token);
const post = (urlPath, token, body) => call('POST', urlPath, token, body);

async function uploadForm(urlPath, token, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('media', new Blob([PNG], { type: 'image/png' }), 'sniffedout-demo.png');
  const res = await fetch(`${API_BASE}${urlPath}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function confirmProduction(what) {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Cloudinary cloud: ${config.CLOUDINARY_CLOUD_NAME || '(not set)'}   Backend: ${API_BASE}`);
  console.log(what);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "production" to continue: ');
  rl.close();
  return answer.trim() === 'production';
}

// ── Setup ───────────────────────────────────────────────────────────────
async function setup() {
  if (loadState()) {
    console.error(`${path.basename(STATE_FILE)} already exists: a demo is still set up. Run "node scripts/demoSniffedOut.js teardown" first.`);
    process.exitCode = 1;
    return;
  }
  if (config.STORAGE_TYPE !== 'cloud' || !config.CLOUDINARY_CLOUD_NAME) {
    console.error('server/.env must have STORAGE_TYPE=cloud and CLOUDINARY_* set for the demo.');
    process.exitCode = 1;
    return;
  }
  const stamp = Date.now();
  const password = `Demo-${crypto.randomBytes(4).toString('hex')}!7`;
  const mk = (key, petName) => ({
    key, email: `demo-sniffedout-${stamp}-${key}@example.invalid`, username: `demo${key}_${stamp}`,
    petName, handle: testPetUsername(petName),
  });
  const A = mk('a', 'Biscuit');
  const B = mk('b', 'Mochi');
  if (!(await confirmProduction(`Creates throwaway users ${A.email} and ${B.email}, real Cloudinary files, then deletes B.`))) {
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
  const state = { stamp, createdAt: new Date().toISOString(), users: [], files: [], ids: {} };
  saveState(state);
  const track = (url, label) => {
    const parsed = parseCloudinaryUrl(url);
    if (!parsed) throw new Error(`${label}: not a Cloudinary URL for our cloud: ${url}`);
    state.files.push({ publicId: parsed.publicId, resourceType: parsed.resourceType, label });
    saveState(state);
  };
  const ids = state.ids;
  const setId = (key, value) => { ids[key] = value; saveState(state); return value; };

  try {
    section('Users and pets');
    const hash = await bcrypt.hash(password, 10);
    for (const spec of [A, B]) {
      const row = await one(
        `INSERT INTO users (email, username, password_hash, full_name, email_verified)
         VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `Demo ${spec.key.toUpperCase()}`]);
      spec.userId = row.id;
      state.users.push({ key: spec.key, id: row.id, email: spec.email });
      saveState(state);
      spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password }))).accessToken;
      spec.pet = (await must(`${spec.key} pet`, post('/api/profile', spec.token, {
        name: spec.petName, pet_username: spec.handle, type: 'dog',
        latitude: COORDS.lat, longitude: COORDS.lng, location_text: 'SniffedOut demo',
      }))).id;
      setId(`${spec.key}Pet`, spec.pet);
      console.log(`  ${spec.key.toUpperCase()}: user #${spec.userId}, pet #${spec.pet} ${spec.petName} (@${spec.handle})`);
    }

    section('Posts, comment and like');
    const aPost = setId('aPost', (await must('A post', post('/api/posts', A.token, { caption: `${A.petName}'s first walk of the day 🐾` }))).id);
    const bPost = setId('bPost', (await must('B post', post('/api/posts', B.token, { caption: `${B.petName} found the best stick ever` }))).id);
    setId('bComment', (await must('B comments on A post', post(`/api/posts/${aPost}/comment`, B.token, { content: 'So cute! See you at the park?' }))).id);
    await must('B likes A post', post(`/api/posts/${aPost}/like`, B.token));
    console.log(`  A post #${aPost} (B commented + liked), B post #${bPost}`);

    section('Match and 1:1 chat');
    await must('B sniffs A', post(`/api/matches/like/${A.pet}`, B.token));
    await must('A accepts B', post(`/api/matches/pending/${B.pet}/respond`, A.token, { action: 'accept' }));
    const convs = await must('A conversations', get('/api/chat/conversations', A.token));
    const conv = setId('conversation', convs.conversations.find(c => c.partner_pet_id === B.pet)?.id);
    if (!conv) throw new Error('no A–B conversation after the match');
    const text = (label, spec, content) => must(label, post('/api/chat/messages', spec.token, { conversationId: conv, content }));
    const insertMessage = async (senderId, type, content, mediaUrl = null, replyToId = null) => (await one(
      `INSERT INTO messages (conversation_id, sender_id, content, media_url, message_type, status, reply_to_id)
       VALUES (?, ?, ?, ?, ?, 'sent', ?) RETURNING id`, [conv, senderId, content, mediaUrl, type, replyToId])).id;

    const aHi = setId('aText', (await text('A text', A, `Hi ${B.petName}! Park later?`)).id);
    setId('bText', (await text('B text', B, 'Yes!! 🐶')).id);
    let r = await uploadForm('/api/chat/messages', B.token, { conversationId: conv, content: 'Look at this stick' });
    if (r.status !== 201) throw new Error(`B chat image: ${show(r)}`);
    track(r.data.media_url, 'B chat image');
    const bImage = setId('bImage', r.data.id);
    r = await uploadForm('/api/chat/messages', A.token, { conversationId: conv, content: 'Mine is bigger' });
    if (r.status !== 201) throw new Error(`A chat image: ${show(r)}`);
    track(r.data.media_url, 'A chat image');
    setId('aImage', r.data.id);
    // Not real files: the deletion nulls every media URL B sent, whatever the host.
    setId('bVoice', await insertMessage(B.userId, 'voice', '', 'https://example.invalid/sniffedout-demo-voice.webm'));
    setId('bFile', await insertMessage(B.userId, 'file', 'vaccination-card.pdf', 'https://example.invalid/sniffedout-demo-file.pdf'));
    setId('aReplyToBImage', await insertMessage(A.userId, 'text', 'Haha that stick 😂', null, bImage));
    setId('bReplyToAText', await insertMessage(B.userId, 'text', 'How about 5pm?', null, aHi));
    await must('B shares own post', post('/api/chat/share', B.token, { postId: bPost, recipientPetId: A.pet }));
    await must('A shares own post', post('/api/chat/share', A.token, { postId: aPost, recipientPetId: B.pet }));
    setId('bPetCard', await insertMessage(B.userId, 'pet_profile', '🐶 Profile shared', String(B.pet)));
    setId('bMeetup', await insertMessage(B.userId, 'meetup',
      JSON.stringify({ location: 'Central Dog Park', date_time: 'Sat • 5:00 PM', note: 'Bring the ball!', status: 'pending' })));
    await must('B calls A', post('/api/chat/calls/log', B.token, { receiverPetId: A.pet, type: 'audio', status: 'completed', duration: 42 }));
    console.log(`  conversation #${conv}: texts, 2 replies, 2 images, voice, file, 2 shared posts, profile card, meetup, call`);

    section('PawCircle owned by B');
    const circle = setId('circle', (await must('B creates circle', post('/api/communities', B.token,
      { name: `Mochi's Pack ${stamp}`, description: 'SniffedOut demo circle' }))).community.id);
    await must('A joins circle', post(`/api/communities/${circle}/join`, A.token));
    await must('B circle text', post(`/api/communities/${circle}/messages`, B.token, { content: 'Welcome to the pack!' }));
    await must('A circle text', post(`/api/communities/${circle}/messages`, A.token, { content: 'Thanks for having us 🐾' }));
    r = await uploadForm(`/api/communities/${circle}/messages`, B.token, { content: 'Pack photo' });
    if (r.status !== 201) throw new Error(`B circle media message: ${show(r)}`);
    track(r.data.message.media_url, 'B circle message image');
    r = await uploadForm(`/api/communities/${circle}/photos`, B.token, { caption: 'B album photo' });
    if (r.status !== 201) throw new Error(`B circle photo: ${show(r)}`);
    track(r.data.photo.media_url, 'B circle photo');
    r = await uploadForm(`/api/communities/${circle}/photos`, A.token, { caption: 'A album photo' });
    if (r.status !== 201) throw new Error(`A circle photo: ${show(r)}`);
    track(r.data.photo.media_url, 'A circle photo');
    console.log(`  circle #${circle}: A is a member; texts from both, image message + photo from B, photo from A`);

    section('Spotlight history win for B');
    // UNIQUE (area, cycle_date): walk back from an old date to a free slot.
    let cycleDate = new Date('2026-01-01T00:00:00Z');
    while (await one("SELECT id FROM spotlight_history WHERE area = 'locality' AND cycle_date = ?", [cycleDate.toISOString().slice(0, 10)])) {
      cycleDate = new Date(cycleDate.getTime() - 86400000);
    }
    const cycle = cycleDate.toISOString().slice(0, 10);
    setId('spotlightHistory', (await one(
      "INSERT INTO spotlight_history (pet_id, area, score, cycle_date) VALUES (?, 'locality', 12, ?) RETURNING id", [B.pet, cycle])).id);
    console.log(`  locality champion on ${cycle}`);

    await settleBackground([A.userId, B.userId], [A.pet, B.pet]);
    const notes = await one('SELECT count(*)::int AS n FROM notifications WHERE user_id = ? AND sender_pet_id = ?', [A.userId, B.pet]);
    console.log(`  ${notes.n} notification(s) from B to A (sniff, comment, like, ...)`);

    section('Delete B (deleteUserAccount, skipCode)');
    const result = await deleteUserAccount(B.userId, { skipCode: true });
    console.log(`  B is SniffedOut: ${result.conversationIds.length} chat(s) read-only, ${result.ownedCircleIds.length} circle(s) frozen, ${result.pendingMediaCount} file(s) queued`);
    const cleanup = await purgeAfterDeletion(B.userId);
    await purgePendingMedia({ deletedUserId: B.userId, includeSweeps: true }); // the final user_<id> tag sweep, now instead of hourly
    const left = await one('SELECT count(*)::int AS n FROM pending_media_deletions WHERE deleted_user_id = ?', [B.userId]);
    console.log(`  Cloudinary purge: ${cleanup}${left.n ? ` (${left.n} queue row(s) left)` : ''}`);
  } catch (err) {
    console.error(`\nSetup stopped: ${err.stack || err.message}`);
    console.error('Everything created so far is recorded; run "node scripts/demoSniffedOut.js teardown" to remove it.');
    process.exitCode = 1;
    return;
  } finally {
    await getDb().end();
  }

  console.log(`
Demo ready. Log in as A:
  email:    ${A.email}
  password: ${password}
Ids saved to ${path.relative(process.cwd(), STATE_FILE)} -- run "node scripts/demoSniffedOut.js teardown" when done.`);
}

// Likes and matches start background Spotlight / notification jobs in the
// server. Wait until they stop writing before deleting B.
async function settleBackground(users, pets, quietMs = 4000, maxMs = 60000) {
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
    if (now !== last) { last = now; stableSince = Date.now(); } else if (Date.now() - stableSince >= quietMs) return;
    await sleep(500);
  }
  console.log(`  background jobs still writing after ${maxMs / 1000}s -- continuing`);
}

// ── Teardown ────────────────────────────────────────────────────────────
async function teardown() {
  const state = loadState();
  if (!state) {
    console.log(`No ${path.basename(STATE_FILE)} -- nothing to tear down.`);
    return;
  }
  const who = state.users.map(u => `#${u.id} ${u.email}`).join(', ') || '(no users)';
  if (!(await confirmProduction(`Removes the demo from ${state.createdAt}: users ${who} and ${state.files.length} Cloudinary file(s).`))) {
    console.log('Aborted -- nothing was done.');
    return;
  }

  await initDb();
  let ok = true;
  try {
    section('Cloudinary');
    for (const f of state.files) {
      if (f.publicId.startsWith('sniffr/payment_proofs/')) continue; // never, whatever the file says
      try {
        const { result } = await cloudStorage.destroy(f.publicId, f.resourceType);
        console.log(`  ${f.label}: ${result === 'ok' ? 'removed' : result === 'not found' ? 'already gone' : result}`);
      } catch (err) {
        ok = false;
        console.error(`  ${f.label}: could not remove ${f.resourceType}/${f.publicId}: ${err.message}`);
      }
    }

    section('Database');
    if (state.users.length) await deleteDemoRows(state);
    else console.log('  no users were created');
  } catch (err) {
    ok = false;
    console.error(`\nTEARDOWN FAILED (database rolled back): ${err.message}`);
  } finally {
    await getDb().end();
  }

  if (ok) {
    fs.unlinkSync(STATE_FILE);
    console.log(`\nDemo removed; ${path.basename(STATE_FILE)} deleted.`);
  } else {
    console.error(`\nSomething was left behind; ${path.basename(STATE_FILE)} kept so you can run teardown again.`);
    process.exitCode = 1;
  }
}

async function deleteDemoRows(state) {
  await withTransaction(async tx => {
    const users = state.users.map(u => u.id);
    for (const { id, email } of state.users) {
      const row = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!row) continue;
      const ours = row.email === email || row.email === `sniffedout~${id}`;
      if (!ours || row.is_admin || id === PROTECTED_USER_ID) throw new Error(`Refusing to delete user #${id}: not a demo account.`);
    }
    const list = async (sql, params) => (await tx.all(sql, params)).map(r => r.id);
    const pets = await list('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [users]);
    const circles = await list('SELECT id FROM communities WHERE created_by = ANY(?::int[])', [users]);

    // ONE-TIME EXCEPTION, explicitly approved by the owner (2026-09-30): user 1
    // joined the demo circle and posted in it from the browser. Remove exactly
    // user 1's membership and user 1's messages in the demo circle(s) -- nothing
    // else of user 1 -- so the demo can be torn down. Reactions ON those
    // messages go too (they would block the delete); they aren't user 1's rows.
    const u1Msgs = await list(
      'SELECT id FROM community_messages WHERE sender_id = ? AND community_id = ANY(?::int[])', [PROTECTED_USER_ID, circles]);
    const u1Reactions = await tx.run('DELETE FROM community_message_reactions WHERE community_message_id = ANY(?::int[])', [u1Msgs]);
    const u1MsgDel = await tx.run(
      'DELETE FROM community_messages WHERE id = ANY(?::int[]) AND sender_id = ? AND community_id = ANY(?::int[])', [u1Msgs, PROTECTED_USER_ID, circles]);
    const u1MemberDel = await tx.run(
      'DELETE FROM community_members WHERE user_id = ? AND community_id = ANY(?::int[])', [PROTECTED_USER_ID, circles]);
    if (u1MsgDel.rowCount || u1MemberDel.rowCount) {
      console.log(`  user 1 in demo circle(s): removed ${u1MemberDel.rowCount} membership(s), ${u1MsgDel.rowCount} message(s)` +
        (u1Reactions.rowCount ? `, ${u1Reactions.rowCount} reaction(s) on them` : ''));
    }

    const outsiders = await tx.get(
      'SELECT count(*)::int AS n FROM community_members WHERE community_id = ANY(?::int[]) AND NOT (user_id = ANY(?::int[]))', [circles, users]);
    if (outsiders.n) throw new Error(`${outsiders.n} non-demo member(s) joined the demo circle -- leaving it for a manual look`);
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

    // Anything else still pointing at the demo users/pets would block the
    // delete below (or be a table this list doesn't know): stop and roll back.
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
    if (leftovers.length) throw new Error(`unexpected rows still reference the demo accounts: ${leftovers.join(', ')}`);

    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} demo users, ${petDel.rowCount} pets${counts.length ? `, ${counts.join(', ')}` : ''}`);
  });
}

// ── Extend an existing demo ─────────────────────────────────────────────
async function extend() {
  const state = loadState();
  const a = state?.users.find(u => u.key === 'a');
  const b = state?.users.find(u => u.key === 'b');
  if (!a || !b || !state.ids?.aPet || !state.ids?.bPet || !state.ids?.bPost) {
    console.error(`No complete demo in ${path.basename(STATE_FILE)} -- run setup first.`);
    process.exitCode = 1;
    return;
  }
  if (state.ids.extended) {
    console.log('This demo was already extended -- nothing to do.');
    return;
  }
  if (!(await confirmProduction(`Adds notifications and a post for demo user A (#${a.id}) about SniffedOut B (#${b.id}).`))) {
    console.log('Aborted -- nothing was done.');
    return;
  }

  await initDb();
  try {
    const aRow = await one('SELECT id, email, is_admin, deleted_at FROM users WHERE id = ?', [a.id]);
    const bRow = await one('SELECT id, deleted_at FROM users WHERE id = ?', [b.id]);
    if (!aRow || aRow.email !== a.email || aRow.is_admin || a.id === PROTECTED_USER_ID || aRow.deleted_at) {
      throw new Error(`user #${a.id} is not the demo's live user A`);
    }
    if (!bRow?.deleted_at) throw new Error(`user #${b.id} (B) is not SniffedOut -- the demo looks incomplete`);

    const added = {};
    const notify = async (key, fields) => {
      added[key] = (await one(
        `INSERT INTO notifications (user_id, category, type, title, description, avatar_url, target_id, sender_pet_id, action_status, metadata_json)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?) RETURNING id`,
        [a.id, fields.category, fields.type, fields.title, fields.description, fields.targetId, state.ids.bPet,
          fields.actionStatus || 'pending', JSON.stringify(fields.metadata || {})])).id;
    };
    // What the deletion turns a pending sniff from B into.
    await notify('expiredRequest', {
      category: 'matches', type: 'match_request', title: '🥰 SniffedOut sent you a Meet request!',
      description: 'SniffedOut wants to be pack friends.', targetId: String(state.ids.bPet), actionStatus: 'expired',
    });
    await notify('profileView', {
      category: 'activity', type: 'profile_view', title: '👀 SniffedOut viewed your profile!',
      description: 'SniffedOut checked out your profile on Sniffr.', targetId: String(state.ids.bPet),
    });
    // B replied to A's comment on B's own post, then deleted their account
    // (which deleted that post).
    await notify('deletedPostReply', {
      category: 'activity', type: 'comment', title: 'SniffedOut replied to your comment 💬',
      description: 'SniffedOut: "Same time tomorrow?"', targetId: String(state.ids.bPost),
    });
    // A mention of B's handle reads "@SniffedOut" after the deletion.
    added.mentionPost = (await one(
      'INSERT INTO posts (pet_id, caption) VALUES (?, ?) RETURNING id',
      [state.ids.aPet, 'Beach day! Thanks for the zoomies @SniffedOut 🐾'])).id;

    state.ids.extended = added;
    saveState(state);
    console.log(`  added notifications #${added.expiredRequest} (expired Meet request), #${added.profileView} (profile view),`);
    console.log(`  #${added.deletedPostReply} (reply on B's deleted post #${state.ids.bPost}), and A's post #${added.mentionPost} mentioning @SniffedOut.`);
    console.log('Done. Teardown removes these with the rest of the demo.');
  } catch (err) {
    console.error(`Extend stopped: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await getDb().end();
  }
}

// ── Reset A's password ──────────────────────────────────────────────────
async function resetPassword() {
  const state = loadState();
  const a = state?.users.find(u => u.key === 'a');
  if (!a) {
    console.error(`No demo user A in ${path.basename(STATE_FILE)} -- run setup first.`);
    process.exitCode = 1;
    return;
  }
  if (!(await confirmProduction(`Sets a new password for demo user A only: #${a.id} ${a.email}.`))) {
    console.log('Aborted -- nothing was done.');
    return;
  }

  await initDb();
  try {
    const row = await one('SELECT id, email, is_admin, deleted_at FROM users WHERE id = ?', [a.id]);
    const problem = !row ? 'no such user'
      : a.id === PROTECTED_USER_ID ? 'that is user 1'
      : row.is_admin ? 'that user is an admin'
      : row.email !== a.email ? `its email is now ${row.email}, not the demo's ${a.email}`
      : row.deleted_at ? 'that account is deleted'
      : null;
    if (problem) {
      console.error(`Refusing to change user #${a.id}: ${problem}.`);
      process.exitCode = 1;
      return;
    }
    const password = `Demo-${crypto.randomBytes(4).toString('hex')}!7`;
    const hash = await bcrypt.hash(password, 10);
    // The same guards again in the UPDATE itself, so only this exact row can change.
    const result = await db.run(
      'UPDATE users SET password_hash = ? WHERE id = ? AND email = ? AND NOT is_admin AND id <> ? AND deleted_at IS NULL',
      [hash, a.id, a.email, PROTECTED_USER_ID]);
    if (result.rowCount !== 1) {
      console.error(`Password not changed (${result.rowCount} rows matched).`);
      process.exitCode = 1;
      return;
    }
    console.log(`
New password set for demo user A:
  email:    ${a.email}
  password: ${password}`);
  } finally {
    await getDb().end();
  }
}

const command = process.argv[2];
const commands = { setup, teardown, extend, 'reset-password': resetPassword };
const run = commands[command] || null;
if (!run) {
  console.log('Usage: node scripts/demoSniffedOut.js setup | teardown | extend | reset-password');
  process.exit(1);
}
run().then(() => process.exit(process.exitCode || 0)).catch(err => {
  console.error(err);
  process.exit(1);
});
