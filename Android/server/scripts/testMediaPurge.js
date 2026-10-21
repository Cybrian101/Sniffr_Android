// Integration test for the Cloudinary media purge after account deletion,
// against your running backend (`npm run dev` on :3001, STORAGE_TYPE=cloud),
// the database in server/.env (production, no real users yet) and the real
// Cloudinary account from server/.env.
//
// Throwaway users:
//   A  uploads real files (pet avatar, post image, chat image, circle photo),
//      then is deleted through the real endpoints -> everything purged;
//   B  uploads a post image that must stay untouched, and re-uses one of C's
//      images in a circle message;
//   C  has an image whose post row is gone (only its media_files row from the
//      upload quota tracking is left), a TRUE orphan (uploaded straight to
//      Cloudinary with C's tag: no media_files row, no DB reference) and the
//      image B re-uses. Deleting C must purge the first via media_files; the
//      final tag sweep must destroy the true orphan and keep B's copy.
// Also checks queue edge cases: a bogus public_id (not found = success), a
// forced failure (attempts/last_error, gives up after 10), a payment proof
// (always refused) and a tag sweep for a live user (refused).
// Cleanup destroys every file the test uploaded and deletes the test users,
// even if a check fails. Never touches user 1 or real payment proofs.
//
//   node scripts/testMediaPurge.js

process.env.SNIFFR_TEST_HOOKS = '1'; // enables the forced-failure prefix in THIS process only

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { default: config } = await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { default: cloudStorage } = await import('../storage/CloudStorage.js');
const { v2: cloudinary } = await import('cloudinary');
const { issueCode } = await import('../services/verificationCodes.js');
const { parseCloudinaryUrl } = await import('../services/accountDeletion.js');
const { purgePendingMedia, MAX_ATTEMPTS } = await import('../services/mediaPurge.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `purge-test-${stamp}-${key}@example.invalid`, username: `purge${key}_${stamp}` });
const A = mk('a');
const B = mk('b');
const C = mk('c');
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

async function call(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const post = (path, token, body) => call('POST', path, token, body);

async function uploadForm(path, token, fileField, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append(fileField, new Blob([PNG], { type: 'image/png' }), 'purge-test.png');
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

// Every Cloudinary file the test creates, so cleanup can always remove it.
const uploaded = [];
function track(url, label) {
  const parsed = parseCloudinaryUrl(url);
  if (!parsed) throw new Error(`${label}: not a Cloudinary URL for our cloud: ${url}`);
  const file = { ...parsed, url, label };
  uploaded.push(file);
  return file;
}

async function cloudLookup(file) {
  try {
    const r = await cloudinary.api.resource(file.publicId, { resource_type: file.resourceType });
    return { exists: true, tags: r.tags || [] };
  } catch (err) {
    const code = err?.error?.http_code ?? err?.http_code;
    if (code === 404) return { exists: false, tags: [] };
    throw err;
  }
}

async function createUser(spec, created) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `Purge Test ${spec.key}`]);
  spec.userId = row.id;
  created.push({ id: row.id, email: spec.email });
  const login = await post('/api/auth/login', null, { email: spec.email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed for ${spec.key}: ${show(login)}`);
  spec.token = login.data.accessToken;
}

async function deleteViaEndpoint(spec) {
  const r1 = await post('/api/account/delete/request-code', spec.token);
  if (r1.status !== 200) throw new Error(`request-code failed for ${spec.key}: ${show(r1)}`);
  const { code } = await issueCode(spec.userId, 'delete_account'); // the emailed code can't be read
  return post('/api/account/delete/confirm', spec.token, { code, confirmation: 'DELETE ACCOUNT' });
}

async function queueRow(publicId, userId, resourceType = 'image', source = 'posts') {
  return (await one(
    `INSERT INTO pending_media_deletions (public_id, resource_type, source, deleted_user_id)
     VALUES (?, ?, ?, ?) RETURNING id`, [publicId, resourceType, source, userId])).id;
}
const queueState = id => one('SELECT attempts, last_error, last_attempt_at FROM pending_media_deletions WHERE id = ?', [id]);

async function runTests(created) {
  if (config.STORAGE_TYPE !== 'cloud' || !config.CLOUDINARY_CLOUD_NAME) {
    throw new Error('server/.env must have STORAGE_TYPE=cloud and CLOUDINARY_* set for this test');
  }

  section('Setup: real uploads through the API');
  await createUser(A, created);
  await createUser(B, created);
  await createUser(C, created);

  let r = await uploadForm('/api/profile', A.token, 'avatar', { name: `PurgeA${stamp}`, pet_username: testPetUsername('purgea'), type: 'dog' });
  if (r.status !== 201) throw new Error(`A pet with avatar: ${show(r)}`);
  const aAvatar = track(r.data.avatar_url, 'A pet avatar');
  r = await uploadForm('/api/posts', A.token, 'media', { caption: `purge test ${stamp}` });
  if (r.status !== 201) throw new Error(`A post image: ${show(r)}`);
  const aPost = track(r.data.media_url, 'A post image');

  r = await post('/api/profile', B.token, { name: `PurgeB${stamp}`, pet_username: testPetUsername('purgeb'), type: 'dog' });
  if (r.status !== 201) throw new Error(`B pet: ${show(r)}`);
  B.pet = r.data.id;
  r = await post('/api/chat/conversations', A.token, { recipientPetId: B.pet });
  const conversationId = r.data.conversation?.id;
  if (!conversationId) throw new Error(`A–B conversation: ${show(r)}`);
  r = await uploadForm('/api/chat/messages', A.token, 'media', { conversationId, content: '' });
  if (r.status !== 201) throw new Error(`A chat image: ${show(r)}`);
  const aChat = track(r.data.media_url, 'A chat image');

  r = await post('/api/communities', A.token, { name: `Purge A Circle ${stamp}`, description: 'test' });
  if (r.status !== 201) throw new Error(`A circle: ${show(r)}`);
  r = await uploadForm(`/api/communities/${r.data.community.id}/photos`, A.token, 'media', { caption: 'purge test' });
  if (r.status !== 201) throw new Error(`A circle photo: ${show(r)}`);
  const aPhoto = track(r.data.photo.media_url, 'A circle photo');
  const aFiles = [aAvatar, aPost, aChat, aPhoto];

  r = await uploadForm('/api/posts', B.token, 'media', { caption: `B keeps this ${stamp}` });
  if (r.status !== 201) throw new Error(`B post image: ${show(r)}`);
  const bPost = track(r.data.media_url, 'B post image');

  r = await post('/api/profile', C.token, { name: `PurgeC${stamp}`, pet_username: testPetUsername('purgec'), type: 'dog' });
  if (r.status !== 201) throw new Error(`C pet: ${show(r)}`);
  r = await uploadForm('/api/posts', C.token, 'media', { caption: 'C orphan' });
  if (r.status !== 201) throw new Error(`C orphan upload: ${show(r)}`);
  const cPostless = track(r.data.media_url, 'C image whose post is gone');
  await db.run('DELETE FROM posts WHERE id = ?', [r.data.id]); // only the upload's media_files row is left
  // A TRUE orphan, as a crash between the Cloudinary upload and the database
  // write would leave it: uploaded through the SDK (same folder option as
  // storage/CloudStorage.js) with C's owner tag, but no media_files row and
  // no DB reference. Only the final tag sweep can find it.
  const raw = await cloudinary.uploader.upload(`data:image/png;base64,${PNG.toString('base64')}`, {
    folder: 'sniffr/posts', tags: [`user_${C.userId}`], resource_type: 'image',
  });
  const cOrphan = track(raw.secure_url, 'C true orphan (SDK upload)');
  r = await uploadForm('/api/posts', C.token, 'media', { caption: 'C shared' });
  if (r.status !== 201) throw new Error(`C shared upload: ${show(r)}`);
  const cShared = track(r.data.media_url, 'C image B re-uses');
  r = await post('/api/communities', C.token, { name: `Purge C Circle ${stamp}`, description: 'test' });
  const cCircle = r.data.community?.id;
  if (!cCircle) throw new Error(`C circle: ${show(r)}`);
  r = await post(`/api/communities/${cCircle}/join`, B.token);
  if (r.status !== 200) throw new Error(`B joins C circle: ${show(r)}`);
  r = await post(`/api/communities/${cCircle}/messages`, B.token, { content: 'look', media_url: cShared.url });
  if (r.status !== 201) throw new Error(`B re-uses C's image: ${show(r)}`);

  section('Uploads exist on Cloudinary with owner tags');
  for (const f of aFiles) {
    const s = await cloudLookup(f);
    check(`${f.label} exists, tagged user_${A.userId}`, s.exists && s.tags.includes(`user_${A.userId}`), JSON.stringify(s));
  }
  let s = await cloudLookup(bPost);
  check(`B post image exists, tagged user_${B.userId}`, s.exists && s.tags.includes(`user_${B.userId}`), JSON.stringify(s));
  for (const f of [cPostless, cOrphan, cShared]) {
    s = await cloudLookup(f);
    check(`${f.label} exists, tagged user_${C.userId}`, s.exists && s.tags.includes(`user_${C.userId}`), JSON.stringify(s));
  }
  const mediaRows = f => one('SELECT count(*)::int AS n FROM media_files WHERE url = ?', [f.url]).then(x => x.n);
  check("the post-less image still has its media_files row (quota tracking)", await mediaRows(cPostless) === 1);
  check('the true orphan has no media_files row', await mediaRows(cOrphan) === 0);

  section('Delete A through the real endpoints');
  r = await deleteViaEndpoint(A);
  check("confirm -> 200, mediaCleanup 'complete'", r.status === 200 && r.data.success === true && r.data.mediaCleanup === 'complete', show(r));
  for (const f of aFiles) {
    s = await cloudLookup(f);
    check(`${f.label} is gone from Cloudinary`, !s.exists, JSON.stringify(s));
  }
  const aLeft = await one("SELECT count(*)::int AS n FROM pending_media_deletions WHERE deleted_user_id = ? AND source <> 'tag_sweep'", [A.userId]);
  check("no file rows left in the queue for A", aLeft.n === 0, aLeft.n);
  const aSweep = await one("SELECT id FROM pending_media_deletions WHERE deleted_user_id = ? AND source = 'tag_sweep'", [A.userId]);
  check("a final tag sweep is queued for A", !!aSweep);
  s = await cloudLookup(bPost);
  check("B's post image is untouched", s.exists, JSON.stringify(s));

  section('Queue edge cases');
  const bogus = await queueRow(`sniffr/posts/purgetest_${stamp}_bogus`, A.userId);
  await purgePendingMedia({ deletedUserId: A.userId });
  check('bogus public_id: "not found" counts as success (row removed)', !(await queueState(bogus)));

  const forced = await queueRow(`sniffr/__purge_test_fail__/${stamp}`, A.userId);
  await purgePendingMedia({ deletedUserId: A.userId });
  let q = await queueState(forced);
  check('forced failure: attempts 1, last_error and last_attempt_at recorded',
    q?.attempts === 1 && /Injected purge failure/.test(q?.last_error || '') && !!q?.last_attempt_at, JSON.stringify(q));
  await purgePendingMedia({ deletedUserId: A.userId });
  q = await queueState(forced);
  check('retry: attempts 2', q?.attempts === 2, JSON.stringify(q));
  await db.run('UPDATE pending_media_deletions SET attempts = ? WHERE id = ?', [MAX_ATTEMPTS - 1, forced]);
  await purgePendingMedia({ deletedUserId: A.userId });
  q = await queueState(forced);
  check(`attempt ${MAX_ATTEMPTS}: gives up (attempts = ${MAX_ATTEMPTS})`, q?.attempts === MAX_ATTEMPTS, JSON.stringify(q));
  await purgePendingMedia({ deletedUserId: A.userId });
  q = await queueState(forced);
  check('after giving up it is never retried', q?.attempts === MAX_ATTEMPTS, JSON.stringify(q));

  const proof = await queueRow(`sniffr/payment_proofs/purgetest_${stamp}`, A.userId);
  await purgePendingMedia({ deletedUserId: A.userId });
  q = await queueState(proof);
  check('payment proof row is refused, never destroyed', q?.attempts === MAX_ATTEMPTS && /payment proofs/.test(q?.last_error || ''), JSON.stringify(q));

  const liveSweep = await queueRow(`tag:user_${B.userId}`, B.userId, 'image', 'tag_sweep');
  await purgePendingMedia({ deletedUserId: B.userId, includeSweeps: true });
  q = await queueState(liveSweep);
  check('tag sweep for a LIVE user is refused', q?.attempts === MAX_ATTEMPTS && /deleted accounts/.test(q?.last_error || ''), JSON.stringify(q));
  s = await cloudLookup(bPost);
  check("...and B's image is still there", s.exists, JSON.stringify(s));

  await purgePendingMedia({ deletedUserId: A.userId, includeSweeps: true });
  check("A's tag sweep ran and left the queue", !(await queueState(aSweep.id)));

  section('Delete C, then the final tag sweep');
  r = await deleteViaEndpoint(C);
  check("C deleted (mediaCleanup 'complete': the re-used image was not queued)",
    r.status === 200 && r.data.mediaCleanup === 'complete', show(r));
  s = await cloudLookup(cShared);
  check('the image B re-uses survives the deletion', s.exists, JSON.stringify(s));
  s = await cloudLookup(cPostless);
  check('the post-less image was purged by the deletion (found via media_files)', !s.exists, JSON.stringify(s));
  check('...and its media_files row was released', await mediaRows(cPostless) === 0);
  s = await cloudLookup(cOrphan);
  check('the true orphan (no DB row at all) is still there before the sweep', s.exists, JSON.stringify(s));
  await purgePendingMedia({ deletedUserId: C.userId, includeSweeps: true });
  s = await cloudLookup(cOrphan);
  check('tag sweep destroyed the true orphan', !s.exists, JSON.stringify(s));
  s = await cloudLookup(cShared);
  check('tag sweep kept the image B still uses', s.exists, JSON.stringify(s));
  check("C's tag sweep left the queue", !(await one("SELECT id FROM pending_media_deletions WHERE deleted_user_id = ? AND source = 'tag_sweep'", [C.userId])));
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  let removed = 0;
  for (const f of uploaded) {
    try {
      const { result } = await cloudStorage.destroy(f.publicId, f.resourceType);
      if (result === 'ok') removed++;
    } catch (err) {
      failed++;
      console.error(`  could not remove ${f.resourceType}/${f.publicId} from Cloudinary: ${err.message}`);
    }
  }
  console.log(`  Cloudinary: removed ${removed} leftover test file(s) of ${uploaded.length}`);
  if (!created.length) return;

  await withTransaction(async tx => {
    const users = created.map(u => u.id);
    for (const { id, email } of created) {
      const row = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!row) continue;
      if (id === PROTECTED_USER_ID || row.is_admin || !(row.email === email || row.email === `sniffedout~${id}`)) {
        throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
      }
    }
    const list = async (sql, params) => (await tx.all(sql, params)).map(r => r.id);
    const pets = await list('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [users]);
    const circles = await list('SELECT id FROM communities WHERE created_by = ANY(?::int[])', [users]);
    const matches = await list('SELECT id FROM matches WHERE pet1_id = ANY(?::int[]) OR pet2_id = ANY(?::int[])', [pets, pets]);
    const convs = await list('SELECT id FROM conversations WHERE match_id = ANY(?::int[])', [matches]);
    const posts = await list('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [pets]);
    const steps = [
      ['community_messages', 'community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]],
      ['community_photos', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['community_announcements', 'community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]],
      ['community_join_requests', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['community_members', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['communities', 'id = ANY(?::int[])', [circles]],
      ['messages', 'conversation_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [convs, users]],
      ['conversations', 'id = ANY(?::int[])', [convs]],
      ['matches', 'id = ANY(?::int[])', [matches]],
      ['swipes', 'from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [pets, pets]],
      ['spotlight_history', 'pet_id = ANY(?::int[])', [pets]],
      ['spotlight_rank_tracking', 'pet_id = ANY(?::int[])', [pets]],
      ['likes', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['comments', 'post_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [posts, users]],
      ['posts', 'id = ANY(?::int[])', [posts]],
      ['notifications', 'user_id = ANY(?::int[]) OR sender_pet_id = ANY(?::int[])', [users, pets]],
      ['plan_history', 'user_id = ANY(?::int[])', [users]],
      ['payment_sessions', 'user_id = ANY(?::int[])', [users]],
      ['pending_media_deletions', 'deleted_user_id = ANY(?::int[])', [users]],
      ['media_files', 'user_id = ANY(?::int[])', [users]],
      ['notification_preferences', 'user_id = ANY(?::int[])', [users]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [users]],
      ['verification_codes', 'user_id = ANY(?::int[])', [users]],
    ];
    for (const [table, where, params] of steps) await tx.run(`DELETE FROM ${table} WHERE ${where}`, params);
    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  database: deleted ${userDel.rowCount} test users, ${petDel.rowCount} pets and their rows`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Cloudinary cloud: ${config.CLOUDINARY_CLOUD_NAME || '(not set)'}   Backend: ${API_BASE}`);
  console.log(`Creates throwaway users purge-test-${stamp}-{a,b,c}@example.invalid and real Cloudinary files, then removes them.`);
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
  const created = [];
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
      console.error(`\nCLEANUP FAILED (rolled back): ${err.message}\n  Remove users ${created.map(u => `#${u.id}`).join(', ')} by hand.`);
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
