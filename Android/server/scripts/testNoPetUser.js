// Integration test for accounts WITHOUT a pet ("I'll do this later" during
// signup), against your running backend (`npm run dev` on :3001) and the
// database in server/.env (production, no real users yet).
//
// Throwaway users (reserved .invalid domain):
//   U  no pet: reads and account endpoints work; every action that acts as a
//      pet answers 403 NO_PET (never a 500) and writes nothing; the call
//      socket refuses with code NO_PET. Then U creates a pet and the same
//      actions work, without logging in again.
//   H  has a pet, a post, a public and a private PawCircle (targets for U).
//   V  no pet: deletes their account through the real endpoints.
// Cleanup removes every test row even if a check fails. Never touches user 1.
//
//   node scripts/testNoPetUser.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { issueCode } = await import('../services/verificationCodes.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const FAR = { lat: -54.2800, lng: -36.5000 }; // South Georgia: no real user nearby
const mk = key => ({ key, email: `nopet-test-${stamp}-${key}@example.invalid`, username: `nopet${key}_${stamp}` });
const U = mk('u');
const H = mk('h');
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
const n = async (sql, params = []) => (await db.get(sql, params)).n;
const serverErrors = [];

async function call(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const out = { status: res.status, data: await res.json().catch(() => ({})) };
  if (out.status >= 500) serverErrors.push(`${method} ${path} -> ${out.status}`);
  return out;
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
const waitFor = (socket, event, ms = 5000) => new Promise(resolve => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  function handler(payload) { clearTimeout(timer); socket.off(event, handler); resolve(payload); }
  socket.on(event, handler);
});

async function createUser(spec, created) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `No Pet Test ${spec.key.toUpperCase()}`]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
}
const createPet = (spec, prefix) => must(`${spec.key} creates a pet`, post('/api/profile', spec.token, {
  name: `NoPet${spec.key.toUpperCase()}${stamp}`, pet_username: testPetUsername(prefix), type: 'dog',
  latitude: FAR.lat, longitude: FAR.lng, location_text: 'No-pet test',
}));

// Everything U could have written while refused.
const writesBy = async userId => JSON.stringify({
  posts: await n('SELECT count(*)::int AS n FROM posts p JOIN pets pt ON pt.id = p.pet_id WHERE pt.user_id = ?', [userId]),
  likes: await n('SELECT count(*)::int AS n FROM likes WHERE user_id = ?', [userId]),
  comments: await n('SELECT count(*)::int AS n FROM comments WHERE user_id = ?', [userId]),
  reactions: await n('SELECT count(*)::int AS n FROM reactions WHERE user_id = ?', [userId]),
  shares: await n('SELECT count(*)::int AS n FROM shares WHERE user_id = ?', [userId]),
  circles: await n('SELECT count(*)::int AS n FROM communities WHERE created_by = ?', [userId]),
  memberships: await n('SELECT count(*)::int AS n FROM community_members WHERE user_id = ?', [userId]),
  requests: await n('SELECT count(*)::int AS n FROM community_join_requests WHERE user_id = ?', [userId]),
  pets: await n('SELECT count(*)::int AS n FROM pets WHERE user_id = ?', [userId]),
});

async function runTests(created) {
  const ioClient = loadSocketClient();
  if (!ioClient) throw new Error('socket.io-client not found in client/node_modules');

  section('Setup');
  await createUser(U, created);
  await createUser(H, created);
  await createUser(V, created);
  H.petId = (await createPet(H, 'nopeth')).id;
  H.postId = (await must('H posts', post('/api/posts', H.token, { caption: `H's post ${stamp}` }))).id;
  const pubCircle = (await must('H public circle', post('/api/communities', H.token, { name: `NoPet Pub ${stamp}`, description: 'no-pet test' }))).community.id;
  const privCircle = (await must('H private circle', post('/api/communities', H.token, { name: `NoPet Priv ${stamp}`, description: 'no-pet test', is_private: 1 }))).community.id;
  created.circles.push(pubCircle, privCircle);
  console.log(`  U #${U.userId} (no pet), H #${H.userId} (pet #${H.petId}, post #${H.postId}), V #${V.userId}; circles #${pubCircle}, #${privCircle}`);

  section('Without a pet: account and reading work');
  let r = await get('/api/auth/me', U.token);
  check('GET /auth/me -> 200, pet null', r.status === 200 && r.data.user?.id === U.userId && !r.data.pet, show(r));
  r = await get('/api/profile', U.token);
  check('GET /profile (the Me page) -> 200 { pet: null }', r.status === 200 && r.data.pet === null, show(r));
  const reads = [
    ['/api/profile/my-pets', d => Array.isArray(d.pets) && d.pets.length === 0],
    ['/api/posts?limit=5', d => Array.isArray(d.posts)],
    ['/api/notifications', d => Array.isArray(d.notifications)],
    ['/api/notifications/preferences', d => !!d],
    ['/api/matches', d => Array.isArray(d.matches) && d.matches.length === 0],
    ['/api/matches/activity', d => Array.isArray(d.requested)],
    ['/api/chat/conversations', d => Array.isArray(d.conversations)],
    ['/api/chat/calls/history', d => Array.isArray(d.history) && d.history.length === 0],
    [`/api/chat/nearby?lat=${FAR.lat}&lng=${FAR.lng}`, d => Array.isArray(d.pets)],
    ['/api/chat/search?q=nopet', d => Array.isArray(d.results)],
    [`/api/spotlight?lat=${FAR.lat}&lng=${FAR.lng}`, d => !!d],
    ['/api/communities', d => Array.isArray(d.communities)],
    [`/api/profile/${H.petId}`, d => d.pet?.id === H.petId],
    [`/api/posts/${H.postId}/comments`, d => !!d],
  ];
  for (const [path, ok] of reads) {
    r = await get(path, U.token);
    check(`GET ${path.split('?')[0]} -> 200`, r.status === 200 && ok(r.data), show(r));
  }

  section('Without a pet: every pet action -> 403 NO_PET, nothing written');
  const before = await writesBy(U.userId);
  const actions = [
    ['POST', '/api/posts', { caption: 'no pet post' }],
    ['POST', `/api/posts/${H.postId}/like`],
    ['POST', `/api/posts/${H.postId}/share`],
    ['POST', `/api/posts/${H.postId}/comment`, { content: 'no pet comment' }],
    ['POST', `/api/posts/${H.postId}/react`, { reaction: 'paw' }],
    ['GET', `/api/matches/discover?lat=${FAR.lat}&lng=${FAR.lng}&radius=25`],
    ['POST', `/api/matches/like/${H.petId}`],
    ['POST', `/api/matches/undo/${H.petId}`],
    ['POST', `/api/matches/decline/${H.petId}`],
    ['POST', `/api/matches/pending/${H.petId}/respond`, { action: 'accept' }],
    ['POST', '/api/notifications/match-request/1/respond', { action: 'accept' }],
    ['POST', '/api/chat/conversations', { recipientPetId: H.petId }],
    ['POST', '/api/chat/messages', { conversationId: 1, content: 'hi' }],
    ['POST', '/api/chat/share', { postId: H.postId, recipientPetIds: [H.petId] }],
    ['POST', '/api/chat/calls/log', { receiverPetId: H.petId, type: 'audio', status: 'completed', duration: 1 }],
    ['POST', '/api/chat/meetup/1', { status: 'accepted' }],
    ['POST', '/api/profile/location', { latitude: FAR.lat, longitude: FAR.lng }],
    ['PUT', '/api/profile', { name: 'Nope' }],
    ['PATCH', '/api/profile/pawsitive', { score: 80 }],
    ['POST', '/api/communities', { name: `NoPet U circle ${stamp}`, description: 'x' }],
    ['POST', `/api/communities/${pubCircle}/join`],
    ['POST', `/api/communities/${privCircle}/join-request`],
  ];
  for (const [method, path, body] of actions) {
    r = await call(method, path, U.token, body);
    check(`${method} ${path.split('?')[0]} -> 403 NO_PET`, r.status === 403 && r.data.error === 'NO_PET' && /pet's profile first/.test(r.data.message || ''), show(r));
  }
  check('nothing was written for U', (await writesBy(U.userId)) === before, `${before} -> ${await writesBy(U.userId)}`);

  const uSock = ioClient(API_BASE, { auth: { token: U.token }, transports: ['websocket'], reconnection: false });
  created.sockets.push(uSock);
  const connected = await Promise.race([
    new Promise(res => uSock.once('connect', () => res(true))),
    new Promise(res => uSock.once('connect_error', () => res(false))),
    new Promise(res => setTimeout(() => res(false), 5000)),
  ]);
  check("U's socket connects without a pet", connected);
  const callError = waitFor(uSock, 'call_error');
  uSock.emit('call_initiate', { to: H.userId, type: 'audio' });
  const ce = await callError;
  check('socket call_initiate -> call_error code NO_PET', ce?.code === 'NO_PET', JSON.stringify(ce));

  section('After creating a pet, the same actions work (same session)');
  const uPet = await createPet(U, 'nopetu');
  check('creating the pet -> 201', !!uPet?.id, JSON.stringify(uPet).slice(0, 200));
  r = await get('/api/auth/me', U.token);
  check('GET /auth/me now has the pet', r.data.pet?.id === uPet.id, show(r));
  r = await get('/api/profile', U.token);
  check('GET /profile now has the pet', r.data.pet?.id === uPet.id, show(r));
  r = await post(`/api/posts/${H.postId}/like`, U.token);
  check('like -> 200', r.status === 200 && r.data.liked === true, show(r));
  r = await post(`/api/posts/${H.postId}/comment`, U.token, { content: `now with a pet ${stamp}` });
  check('comment -> 2xx', r.status === 200 || r.status === 201, show(r));
  r = await post(`/api/posts/${H.postId}/react`, U.token, { reaction: 'paw' });
  check('react -> 200', r.status === 200, show(r));
  r = await post(`/api/posts/${H.postId}/share`, U.token);
  check('share -> 200', r.status === 200, show(r));
  r = await post('/api/posts', U.token, { caption: `U's first post ${stamp}` });
  check('post -> 201', r.status === 201, show(r));
  r = await get(`/api/matches/discover?lat=${FAR.lat}&lng=${FAR.lng}&radius=25`, U.token);
  check('Meet discover -> 200', r.status === 200 && Array.isArray(r.data.pets), show(r));
  r = await post('/api/profile/location', U.token, { latitude: FAR.lat, longitude: FAR.lng });
  check('location update -> 200', r.status === 200, show(r));
  r = await call('PATCH', '/api/profile/pawsitive', U.token, { score: 80 });
  check('Pawsitive score -> 200', r.status === 200, show(r));
  r = await post(`/api/communities/${pubCircle}/join`, U.token);
  check('join a public PawCircle -> 200', r.status === 200 && r.data.community?.joinStatus === 'Joined', show(r));
  r = await post(`/api/communities/${privCircle}/join-request`, U.token);
  check('request a private PawCircle -> 201', r.status === 201, show(r));

  section('Deleting an account that never had a pet (V)');
  check('V has no pet', (await n('SELECT count(*)::int AS n FROM pets WHERE user_id = ?', [V.userId])) === 0);
  r = await post('/api/account/delete/request-code', V.token);
  check('request-code -> 200', r.status === 200, show(r));
  const code = await issueCode(V.userId, 'delete_account');
  r = await post('/api/account/delete/confirm', V.token, { code: code.code, confirmation: 'DELETE ACCOUNT' });
  check("confirm -> 200 { success, mediaCleanup: 'complete' }", r.status === 200 && r.data.success === true && r.data.mediaCleanup === 'complete', show(r));
  const v = await one('SELECT email, deleted_at FROM users WHERE id = ?', [V.userId]);
  check('V is tombstoned', !!v?.deleted_at && v.email === `sniffedout~${V.userId}`, JSON.stringify(v));

  check('no request in this test got a 5xx', serverErrors.length === 0, serverErrors.join('; '));
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
    const posts = await list('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [pets]);
    const circleMsgs = await list('SELECT id FROM community_messages WHERE community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]);
    const matches = await list('SELECT id FROM matches WHERE pet1_id = ANY(?::int[]) OR pet2_id = ANY(?::int[])', [pets, pets]);
    const convs = await list('SELECT id FROM conversations WHERE match_id = ANY(?::int[])', [matches]);
    const queueExists = (await tx.get("SELECT to_regclass('public.pending_auth_deletions') IS NOT NULL AS ok")).ok;
    const steps = [
      ['community_message_reactions', 'user_id = ANY(?::int[]) OR community_message_id = ANY(?::int[])', [users, circleMsgs]],
      ['community_messages', 'id = ANY(?::int[])', [circleMsgs]],
      ['community_join_requests', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[]) OR decided_by = ANY(?::int[])', [circles, users, users]],
      ['community_ownership_transfers', 'community_id = ANY(?::int[]) OR to_user_id = ANY(?::int[]) OR from_user_id = ANY(?::int[])', [circles, users, users]],
      ['community_members', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['communities', 'id = ANY(?::int[])', [circles]],
      ['messages', 'conversation_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [convs, users]],
      ['conversations', 'id = ANY(?::int[])', [convs]],
      ['matches', 'id = ANY(?::int[])', [matches]],
      ['swipes', 'from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [pets, pets]],
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
  console.log(`Creates throwaway users nopet-test-${stamp}-{u,h,v}@example.invalid, then removes them.`);
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
