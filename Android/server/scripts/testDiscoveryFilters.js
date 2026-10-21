// Integration test: deleted (tombstoned) pets disappear from every discovery
// surface. Talks to the LOCAL backend over HTTP (start it first with
// `npm run dev`), which uses the same database as this script -- currently
// production, no real users yet.
//
// Creates TWO throwaway users (A and B), each with one pet at nearby,
// remote coordinates. Confirms B's pet shows up for A everywhere, sets
// deleted_at on B's pet and B's user, then confirms B is gone everywhere.
// Cleanup deletes both users and everything the test created, even if a
// check fails. Never touches user 1 or any admin account.
//
//   node scripts/testDiscoveryFilters.js
import readline from 'readline/promises';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import '../config.js';
import { initDb, getDb, dbAdapter as db, withTransaction } from '../db/connection.js';
import CommunityRepo from '../models/CommunityRepository.js';
import { testPetUsername } from './lib/testIds.js';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
// Remote coordinates (South Georgia), ~0.6 km apart, far from any real pet.
const A = {
  email: `disc-test-${stamp}-a@example.invalid`, username: `dta_${stamp}`,
  petName: `DiscA${stamp}`, handle: testPetUsername('dta'), lat: -54.2800, lng: -36.5000,
};
const B = {
  email: `disc-test-${stamp}-b@example.invalid`, username: `dtb_${stamp}`,
  petName: `Zqdisc${stamp}`, handle: testPetUsername('dtb'), lat: -54.2850, lng: -36.5050,
};
const TEST_EMAILS = [A.email, B.email];

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

async function call(method, path, { token, body } = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const hasPet = (list, petId) => Array.isArray(list) && list.some(p => p.id === petId || p.pet_id === petId);
const hasPost = (list, postId) => Array.isArray(list) && list.some(p => p.id === postId);
const spotlightPets = data => [...(data.top3 || []), ...(data.ranks4To10 || []), ...(data.ranks11To20 || [])];

async function assertTestUser(userId) {
  const u = await db.get('SELECT id, email, is_admin FROM users WHERE id = ?', [userId]);
  if (!u || u.id === PROTECTED_USER_ID || u.is_admin || !TEST_EMAILS.includes(u.email)) {
    throw new Error(`Refusing to touch user #${userId}: not a throwaway test account.`);
  }
}

async function createUser(spec) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await db.get(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`,
    [spec.email, spec.username, hash, 'Discovery Filter Test']
  );
  return row.id;
}

async function setUp(spec, created) {
  spec.userId = await createUser(spec);
  created.userIds.push(spec.userId);
  const login = await call('POST', '/api/auth/login', { body: { email: spec.email, password: PASSWORD } });
  check(`user ${spec === A ? 'A' : 'B'} logs in`, login.status === 200 && !!login.data.accessToken, show(login));
  spec.token = login.data.accessToken;
  const pet = await call('POST', '/api/profile', {
    token: spec.token,
    body: { name: spec.petName, pet_username: spec.handle, type: 'dog', latitude: spec.lat, longitude: spec.lng, location_text: 'Discovery test' },
  });
  check(`user ${spec === A ? 'A' : 'B'} creates a pet`, pet.status === 201 && !!pet.data.id, show(pet));
  spec.petId = pet.data.id;
}

async function mentionNotificationsForB() {
  const row = await db.get("SELECT count(*)::int AS n FROM notifications WHERE user_id = ? AND type = 'mention'", [B.userId]);
  return row.n;
}

async function runTests(created) {
  section('Setup');
  await setUp(A, created);
  await setUp(B, created);
  if (!A.petId || !B.petId) throw new Error('setup failed -- cannot continue');

  const geo = `lat=${A.lat}&lng=${A.lng}`;
  const discover = () => call('GET', `/api/matches/discover?${geo}&radius=15`, { token: A.token });
  const nearby = () => call('GET', `/api/chat/nearby?${geo}&radius=25`, { token: A.token });
  const search = q => call('GET', `/api/chat/search?q=${encodeURIComponent(q)}`, { token: A.token });
  const spotlight = area => call('GET', `/api/spotlight?area=${area}&${geo}`, { token: A.token });
  const activity = () => call('GET', '/api/matches/activity', { token: A.token });
  const feed = () => call('GET', '/api/posts?limit=50', { token: A.token });
  const newPosts = after => call('POST', '/api/posts/incremental', { token: A.token, body: { after } });
  const nonMembers = () => CommunityRepo.getNearbyNonMembers(-1, A.lat, A.lng, 20);

  section('Before: B is discoverable by A');
  let r = await discover();
  check('Meet discover shows B', hasPet(r.data.pets, B.petId), show(r));
  r = await nearby();
  check('Chat "Nearby Pets" shows B', hasPet(r.data.pets, B.petId), show(r));
  r = await search(B.petName);
  check('search by pet name finds B', hasPet(r.data.results, B.petId), show(r));
  r = await search(B.handle);
  check('search by pet handle (@ autocomplete) finds B', hasPet(r.data.results, B.petId), show(r));
  r = await search(B.username);
  check('search by owner username finds B', hasPet(r.data.results, B.petId), show(r));
  r = await spotlight('city');
  check('Spotlight (city) ranks B', hasPet(spotlightPets(r.data), B.petId), show(r));

  const beforePost = new Date(Date.now() - 60 * 1000).toISOString();
  const post = await call('POST', '/api/posts', { token: B.token, body: { caption: `discovery test post ${stamp}` } });
  check('B creates a post', post.status === 201 && !!post.data.id, show(post));
  const postId = post.data.id;
  r = await feed();
  check("home feed shows B's post", hasPost(r.data.posts, postId), show(r));
  r = await newPosts(beforePost);
  check("incremental feed refresh shows B's post", hasPost(r.data.posts, postId), show(r));

  r = await call('POST', '/api/posts', { token: A.token, body: { caption: `hello @${B.handle}` } });
  check('A posts a caption mentioning @B', r.status === 201, show(r));
  const mentionsBefore = await mentionNotificationsForB();
  check('B receives the mention notification', mentionsBefore === 1, mentionsBefore);

  const nm = await nonMembers();
  check('PawCircle "nearby non-members" includes B', nm.some(x => x.user_id === B.userId), JSON.stringify(nm));

  r = await call('POST', `/api/matches/like/${A.petId}`, { token: B.token });
  check('B sends A a sniff request', r.status === 200 && r.data.pending === true, show(r));
  r = await activity();
  check("A's Meet \"Pending\" list shows B", hasPet(r.data.pending, B.petId), show(r));

  section("Tombstone B (deleted_at on B's pet and user)");
  await assertTestUser(B.userId);
  await db.run('UPDATE pets SET deleted_at = NOW() WHERE id = ? AND user_id = ?', [B.petId, B.userId]);
  await db.run('UPDATE users SET deleted_at = NOW() WHERE id = ?', [B.userId]);

  section('After: B is gone everywhere');
  r = await activity();
  check("A's Meet \"Pending\" list no longer shows B", r.status === 200 && !hasPet(r.data.pending, B.petId), show(r));
  // Remove B's live request so it can't be what hides B from discover.
  await db.run('DELETE FROM swipes WHERE from_pet_id = ? AND to_pet_id = ?', [B.petId, A.petId]);
  r = await discover();
  check('Meet discover no longer shows B', r.status === 200 && !hasPet(r.data.pets, B.petId), show(r));
  r = await nearby();
  check('Chat "Nearby Pets" no longer shows B', r.status === 200 && !hasPet(r.data.pets, B.petId), show(r));
  r = await search(B.petName);
  check('search by pet name no longer finds B', r.status === 200 && !hasPet(r.data.results, B.petId), show(r));
  r = await search(B.handle);
  check('search by pet handle no longer finds B', r.status === 200 && !hasPet(r.data.results, B.petId), show(r));
  r = await search(B.username);
  check('search by owner username no longer finds B', r.status === 200 && !hasPet(r.data.results, B.petId), show(r));
  r = await spotlight('city');
  check("Spotlight (city, today's cached board) no longer ranks B",
    r.status === 200 && !hasPet(spotlightPets(r.data), B.petId), show(r));
  r = await spotlight('country');
  check('Spotlight (country, freshly calculated) does not rank B',
    r.status === 200 && !hasPet(spotlightPets(r.data), B.petId), show(r));
  r = await feed();
  check("home feed no longer shows B's post", r.status === 200 && !hasPost(r.data.posts, postId), show(r));
  r = await newPosts(beforePost);
  check("incremental feed refresh no longer shows B's post", r.status === 200 && !hasPost(r.data.posts, postId), show(r));

  r = await call('POST', '/api/posts', { token: A.token, body: { caption: `hello again @${B.handle}` } });
  check('A posts another caption mentioning @B', r.status === 201, show(r));
  const mentionsAfter = await mentionNotificationsForB();
  check('deleted B gets no new mention notification', mentionsAfter === mentionsBefore, mentionsAfter);

  const nmAfter = await nonMembers();
  check('PawCircle "nearby non-members" no longer includes B', !nmAfter.some(x => x.user_id === B.userId), JSON.stringify(nmAfter));
}

// Deletes everything the test created for its throwaway users, in one
// transaction. Refuses if any user isn't one of this run's test accounts,
// and rolls back if anything else still points at them.
async function cleanup(created) {
  section('Cleanup');
  const userIds = created.userIds;
  if (!userIds.length) {
    console.log('  nothing to clean up');
    return;
  }
  await withTransaction(async tx => {
    for (const id of userIds) {
      const u = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (u && (u.id === PROTECTED_USER_ID || u.is_admin || !TEST_EMAILS.includes(u.email))) {
        throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
      }
    }
    const petIds = (await tx.all('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [userIds])).map(r => r.id);
    const postIds = (await tx.all('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [petIds])).map(r => r.id);

    const steps = [
      ['likes', 'post_id = ANY(?::int[])', [postIds]],
      ['comments', 'post_id = ANY(?::int[])', [postIds]],
      ['reactions', 'post_id = ANY(?::int[])', [postIds]],
      ['shares', 'post_id = ANY(?::int[])', [postIds]],
      ['post_reports', 'post_id = ANY(?::int[])', [postIds]],
      ['posts', 'id = ANY(?::int[])', [postIds]],
      ['swipes', 'from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [petIds, petIds]],
      ['profile_views', 'viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [petIds, petIds]],
      ['spotlight_rank_tracking', 'pet_id = ANY(?::int[])', [petIds]],
      ['spotlight_history', 'pet_id = ANY(?::int[])', [petIds]],
      ['notifications', 'user_id = ANY(?::int[]) OR sender_pet_id = ANY(?::int[])', [userIds, petIds]],
      ['notification_preferences', 'user_id = ANY(?::int[])', [userIds]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [userIds]],
      ['trusted_devices', 'user_id = ANY(?::int[])', [userIds]],
    ];
    const counts = [];
    for (const [table, where, params] of steps) {
      const res = await tx.run(`DELETE FROM ${table} WHERE ${where}`, params);
      if (res.rowCount) counts.push(`${res.rowCount} ${table}`);
    }

    // Anything else still pointing at these users/pets wasn't expected.
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
      const ids = f.ref_table === 'users' ? userIds : petIds;
      const row = await tx.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ANY(?::int[])`, [ids]);
      if (row.n) leftovers.push(`${f.table_name}.${f.column_name} (${row.n})`);
    }
    if (leftovers.length) throw new Error(`unexpected rows still reference the test accounts: ${leftovers.join(', ')}`);

    const pets = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [petIds, userIds]);
    const users = await tx.run(
      'DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [userIds, PROTECTED_USER_ID]);
    if (users.rowCount !== userIds.length) throw new Error(`expected to delete ${userIds.length} users, deleted ${users.rowCount}`);
    console.log(`  deleted ${users.rowCount} test users, ${pets.rowCount} pets${counts.length ? `, ${counts.join(', ')}` : ''}`);
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
  const created = { userIds: [] };
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
  process.exitCode = failed ? 1 : 0;
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
