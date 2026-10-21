// Integration test for the older bug list's fixes, against your running
// backend (`npm run dev` on :3001) and the database in server/.env
// (production, no real users yet):
//   - comments: the same text from the same user on the same post within
//     COMMENT_DEDUPE_SECONDS returns the existing comment (200) instead of a
//     copy, also for two identical requests sent at once; different text, a
//     reply, or the same text after the window still create one;
//   - Report History: GET /api/posts/reports returns your reports with the
//     fields the Settings modal reads;
//   - PawCircle event announcements keep their place name (when the
//     location_name column exists) and coordinates;
//   - BLOCKED and rate-limit answers carry the codes the app's friendly
//     messages key on (client/src/utils/appToast.js);
//   - no sniffr.app address or personal email is left in client/server code.
// Throwaway users (reserved .invalid domain): A posts and owns circle C, B
// comments and reports, N gets blocked. The event is placed in the middle of
// the Atlantic so no real user is "nearby". Never touches user 1.
//
//   node scripts/testOlderBugFixes.js

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { COMMENT_DEDUPE_SECONDS } = await import('../models/PostRepository.js');
const { testPetUsername } = await import('./lib/testIds.js');
const { friendlyErrorMessage, BLOCKED_MESSAGE, RATE_LIMIT_MESSAGE } = await import('../../client/src/utils/appToast.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `older-test-${stamp}-${key}@example.invalid`, username: `old${key}_${stamp}` });
const A = mk('a');
const B = mk('b');
const N = mk('n');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

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

async function call(method, p, token, body) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const get = (p, t) => call('GET', p, t);
const post = (p, t, b) => call('POST', p, t, b);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// For a setup step on a route this test itself rate-limits (POST
// /api/profile/block): a re-run within a minute finds the limiter still
// full, so wait out its Retry-After once and try again.
async function mustAfterLimit(label, send) {
  let r = await send();
  if (r.status === 429) {
    const wait = (Number(r.data?.retryAfter) || 60) + 1;
    console.log(`  (${label}: rate limited from a previous run -- waiting ${wait}s)`);
    await sleep(wait * 1000);
    r = await send();
  }
  if (r.status !== 200 && r.status !== 201) throw new Error(`fixture step failed: ${label}: ${show(r)}`);
  return r.data;
}
async function must(label, promise, ok = [200, 201]) {
  const r = await promise;
  if (!ok.includes(r.status)) throw new Error(`fixture step failed: ${label}: ${show(r)}`);
  return r.data;
}

async function createUser(spec, created) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `Older Test ${spec.key.toUpperCase()}`]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
  spec.petId = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, {
    name: `Old${spec.key.toUpperCase()}${stamp}`, pet_username: testPetUsername(`old${spec.key}`), type: 'dog',
  }))).id;
}

// Every source file under dir (no dependencies, builds, native projects).
function sourceFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'dist', 'android', 'ios', 'uploads', '.git'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (/\.(jsx?|mjs|html|json|sql|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

async function runTests(created) {
  section('Old addresses (client + server code)');
  const oldDomain = /sniffr\.app/gi;
  const personal = ['sherin13', '2005@gmail', 'com'].join('.');
  const self = path.resolve(fileURLToPath(import.meta.url));
  const hits = [];
  for (const f of [...sourceFiles(path.join(repoRoot, 'client')), ...sourceFiles(path.join(repoRoot, 'server'))]) {
    if (path.resolve(f) === self) continue; // this file names them
    const text = fs.readFileSync(f, 'utf8');
    // com.sniffr.app is the Android package id (must never change).
    const stripped = text.replace(/com\.sniffr\.app/g, '');
    if (oldDomain.test(stripped)) hits.push(`${path.relative(repoRoot, f)} (sniffr.app)`);
    oldDomain.lastIndex = 0;
    if (stripped.includes(personal)) hits.push(`${path.relative(repoRoot, f)} (personal email)`);
  }
  check('no sniffr.app address or personal email left in client/ or server/', hits.length === 0, hits.join(', '));

  section('Setup');
  for (const spec of [A, B, N]) await createUser(spec, created);
  const aPost = (await must('A posts', post('/api/posts', A.token, { caption: `A's post ${stamp}` }))).id;
  console.log(`  A #${A.userId}, B #${B.userId}, N #${N.userId}; post #${aPost}`);

  section(`Comments: duplicates within ${COMMENT_DEDUPE_SECONDS}s`);
  // Top-level comments only: the reply below reuses the same text on purpose
  // (a reply is a different comment), and is checked on its own.
  const countComments = (content, userId = B.userId) => one(
    'SELECT count(*)::int AS n FROM comments WHERE post_id = ? AND user_id = ? AND content = ? AND parent_comment_id IS NULL',
    [aPost, userId, content]).then(x => x.n);
  const text = `Good dog ${stamp}`;
  let r = await post(`/api/posts/${aPost}/comment`, B.token, { content: text });
  const first = r.data;
  check('first comment -> 201', r.status === 201 && first?.id && first.content === text, show(r));
  r = await post(`/api/posts/${aPost}/comment`, B.token, { content: `  ${text}  ` });
  check('the same text again (double tap) -> 200 with the SAME comment', r.status === 200 && r.data?.id === first?.id, show(r));
  check('...one row in the database', await countComments(text) === 1);
  const notifs = await one("SELECT count(*)::int AS n FROM notifications WHERE user_id = ? AND type ILIKE '%comment%'", [A.userId]);
  check('...and the post owner got one comment notification, not two', notifs.n <= 1, JSON.stringify(notifs));

  r = await post(`/api/posts/${aPost}/comment`, B.token, { content: `${text}!` });
  check('different text -> 201, a new comment', r.status === 201 && r.data?.id !== first?.id, show(r));
  r = await post(`/api/posts/${aPost}/comment`, B.token, { content: text, parentCommentId: first?.id });
  check('the same text as a REPLY -> 201, a new comment', r.status === 201 && r.data?.id !== first?.id && r.data?.parent_comment_id === first?.id, show(r));

  const racing = `Two taps at once ${stamp}`;
  const [r1, r2] = await Promise.all([
    post(`/api/posts/${aPost}/comment`, B.token, { content: racing }),
    post(`/api/posts/${aPost}/comment`, B.token, { content: racing }),
  ]);
  check('two identical requests at once -> one 201 and one 200, same comment',
    [r1.status, r2.status].sort().join() === '200,201' && r1.data?.id === r2.data?.id, `${show(r1)} | ${show(r2)}`);
  check('...one row in the database', await countComments(racing) === 1);

  r = await post(`/api/posts/${aPost}/comment`, A.token, { content: text });
  check('someone else posting the same text -> 201, their own comment', r.status === 201 && r.data?.id !== first?.id && await countComments(text, A.userId) === 1, show(r));

  await db.run(`UPDATE comments SET created_at = NOW() - make_interval(secs => ?) WHERE id = ?`, [COMMENT_DEDUPE_SECONDS + 1, first?.id]);
  r = await post(`/api/posts/${aPost}/comment`, B.token, { content: text });
  const afterWindow = await countComments(text);
  check(`the same text after ${COMMENT_DEDUPE_SECONDS}s -> 201, a new comment (2 top-level rows)`,
    r.status === 201 && r.data?.id !== first?.id && afterWindow === 2, `${show(r)} first #${first?.id}, top-level rows ${afterWindow}`);

  section('Report History (GET /api/posts/reports)');
  await must("B reports A's post", post(`/api/posts/${aPost}/report`, B.token, { reason: 'Spam' }));
  r = await get('/api/posts/reports', B.token);
  const rep = (r.data.reports || []).find(x => x.post_id === aPost);
  check('-> 200 with the report', r.status === 200 && !!rep, show(r));
  check('...carrying what the modal shows (id, reason, status, created_at, caption, pet name)',
    rep && rep.id && rep.reason === 'Spam' && rep.status === 'Pending' && !Number.isNaN(new Date(rep.created_at).getTime())
      && rep.caption === `A's post ${stamp}` && (rep.pet_username || rep.pet_name), JSON.stringify(rep));
  r = await get('/api/posts/reports', B.token);
  check('...and again on the next open (it comes from the server, not this device)', r.status === 200 && (r.data.reports || []).some(x => x.post_id === aPost), show(r));

  section('Event announcements: location');
  const C = (await must('A creates C', post('/api/communities', A.token, { name: `Older C ${stamp}`, description: 'older fixes test' }))).community.id;
  created.circles.push(C);
  const hasColumn = !!(await one(
    "SELECT 1 AS ok FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'community_announcements' AND column_name = 'location_name'"));
  // Mid-Atlantic: no pet lives within 20 km, so nobody real is notified.
  const place = 'Test Point, Atlantic Ocean';
  r = await post(`/api/communities/${C}/announcements`, A.token, {
    title: `Pack walk ${stamp}`, content: 'Bring water', is_event: 1, latitude: 0.5, longitude: -30.5, location_name: place,
  });
  const ann = r.data.announcement;
  check('an event announcement -> 201 with its coordinates', r.status === 201 && ann?.is_event === 1
    && Number(ann?.latitude) === 0.5 && Number(ann?.longitude) === -30.5, show(r));
  if (hasColumn) {
    check('...and its place name (location_name column present)', ann?.location_name === place, show(r));
  } else {
    console.log('  (location_name column not added yet: db/sql/2026-10-02_announcement_location_name.sql -- name check skipped)');
    check('...still created without the location_name column', r.status === 201);
  }
  r = await post(`/api/communities/${C}/announcements`, A.token, { title: `Plain ${stamp}`, content: 'No event', location_name: place });
  check('a non-event announcement ignores coordinates and place', r.status === 201 && r.data.announcement?.is_event === 0
    && r.data.announcement?.latitude == null && !r.data.announcement?.location_name, show(r));
  r = await get(`/api/communities/${C}/announcements`, A.token);
  const listed = (r.data.announcements || []).find(x => x.id === ann?.id);
  check('the list returns the event with what the card renders', !!listed && listed.latitude != null && listed.longitude != null
    && (!hasColumn || listed.location_name === place), JSON.stringify(listed));

  section('Friendly errors: BLOCKED and rate limits');
  await mustAfterLimit('A blocks N', () => post('/api/profile/block', A.token, { blockedUserId: N.userId }));
  r = await post('/api/chat/conversations', N.token, { recipientPetId: A.petId });
  check('N starting a chat with A -> 403 BLOCKED', is(r, 403, 'BLOCKED'), show(r));
  check(`...which the app shows as "${BLOCKED_MESSAGE}"`, friendlyErrorMessage({ code: r.data?.error, message: r.data?.message }) === BLOCKED_MESSAGE);
  r = await post(`/api/matches/like/${A.petId}`, N.token);
  check('N sniffing A -> 403 BLOCKED (same message)', is(r, 403, 'BLOCKED'), show(r));
  // The POST limiter allows 10 a minute per route; blocking is idempotent.
  let limited = null;
  for (let i = 0; i < 12 && !limited; i++) {
    const res = await post('/api/profile/block', A.token, { blockedUserId: N.userId });
    if (res.status === 429) limited = res;
  }
  check('the 11th POST within a minute -> 429 RATE_LIMIT', limited && is(limited, 429, 'RATE_LIMIT'), limited ? show(limited) : 'never limited');
  check(`...which the app shows as "${RATE_LIMIT_MESSAGE}"`, friendlyErrorMessage({ code: 'RATE_LIMIT' }) === RATE_LIMIT_MESSAGE
    && friendlyErrorMessage({ code: 'RATE_LIMITED' }) === RATE_LIMIT_MESSAGE);
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
      if (id === PROTECTED_USER_ID || row.is_admin || row.email !== email) {
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
      ['community_announcements', 'community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]],
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
      ['blocked_users', 'blocker_id = ANY(?::int[]) OR blocked_id = ANY(?::int[])', [users, users]],
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
  console.log(`Creates throwaway users older-test-${stamp}-{a,b,n}@example.invalid, then removes them.`);
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
  const created = { users: [], circles: [] };
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
