// Integration test for frozen PawCircles (owner SniffedOut), against your
// running backend (`npm run dev` on :3001) and the database in server/.env
// (production, no real users yet). The owner's deletion runs in this process
// through deleteUserAccount (skipCode).
//
// Throwaway users: owner O, members M1 and M2, outsider X. O owns circle C1
// (messages, photos, a poll, an event, an announcement) and circle C2 (with a
// pending ownership transfer to M1). After O is deleted, checks:
//   - both circles frozen, member_count excludes O;
//   - every write over HTTP and the socket -> 403 / COMMUNITY_READ_ONLY,
//     with nothing changed in the database;
//   - members can still read everything;
//   - X can't find it, open it (invite link) or join it;
//   - M1 leaves C1 -> kept; M2 leaves -> C1 deleted, its media queued;
//   - "delete from my list" on a frozen circle = leave;
//   - C2's pending transfer goes to M1: M1 (the last live member) leaving
//     cancels it, so C2 is deleted (testOwnershipTransfer.js covers the rest).
// Media rows use fake Cloudinary URLs (nothing is uploaded). Cleanup removes
// every test row even if a check fails. Never touches user 1.
//
//   node scripts/testFrozenCircles.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { default: config } = await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { deleteUserAccount } = await import('../services/accountDeletion.js');
const { deleteAbandonedFrozenCircles } = await import('../services/frozenCircles.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `frozen-test-${stamp}-${key}@example.invalid`, username: `frz${key}_${stamp}` });
const O = mk('o');
const M1 = mk('m1');
const M2 = mk('m2');
const X = mk('x');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const fakeMedia = (folder, name) => ({
  url: `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME}/image/upload/v1700000000/sniffr/${folder}/frozentest_${stamp}_${name}.jpg`,
  publicId: `sniffr/${folder}/frozentest_${stamp}_${name}`,
});

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
const refused = r => r.status === 403 && r.data?.error === 'COMMUNITY_READ_ONLY';

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
async function uploadForm(path, token, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('media', new Blob([PNG], { type: 'image/png' }), 'frozen-test.png');
  const res = await fetch(`${API_BASE}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
  return { status: res.status, data: await res.json().catch(() => ({})) };
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
  const timer = setTimeout(() => resolve(null), ms);
  socket.once(event, payload => { clearTimeout(timer); resolve(payload); });
});

async function createUser(spec, created) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified)
     VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `Frozen Test ${spec.key.toUpperCase()}`]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
  spec.petId = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, { name: `Frz${spec.key.toUpperCase()}${stamp}`, pet_username: testPetUsername(`frz${spec.key}`), type: 'dog' }))).id;
}

// Everything in the circle that a refused write could have changed.
const circleSnapshot = async (id, pollId) => JSON.stringify({
  messages: await n('SELECT count(*)::int AS n FROM community_messages WHERE community_id = ?', [id]),
  photos: await n('SELECT count(*)::int AS n FROM community_photos WHERE community_id = ?', [id]),
  announcements: await n('SELECT count(*)::int AS n FROM community_announcements WHERE community_id = ?', [id]),
  polls: await n('SELECT count(*)::int AS n FROM community_polls WHERE community_id = ?', [id]),
  votes: (await one('SELECT votes_json FROM community_polls WHERE id = ?', [pollId]))?.votes_json,
  members: await db.all('SELECT user_id, role FROM community_members WHERE community_id = ? ORDER BY user_id', [id]),
  circle: await one('SELECT status, is_private, member_count FROM communities WHERE id = ?', [id]),
});

async function runTests(created) {
  if (!config.CLOUDINARY_CLOUD_NAME) throw new Error('server/.env must set CLOUDINARY_CLOUD_NAME (fake media URLs use it)');
  const ids = created.ids;

  section('Setup');
  for (const spec of [O, M1, M2, X]) await createUser(spec, created);
  ids.c1 = (await must('O creates C1', post('/api/communities', O.token, { name: `Frozen C1 ${stamp}`, description: 'frozen test' }))).community.id;
  ids.c2 = (await must('O creates C2', post('/api/communities', O.token, { name: `Frozen C2 ${stamp}`, description: 'frozen test' }))).community.id;
  created.circles.push(ids.c1, ids.c2);
  for (const spec of [M1, M2]) {
    await must(`${spec.key} joins C1`, post(`/api/communities/${ids.c1}/join`, spec.token));
    await must(`${spec.key} joins C2`, post(`/api/communities/${ids.c2}/join`, spec.token));
  }
  ids.oMsg = (await must('O message', post(`/api/communities/${ids.c1}/messages`, O.token, { content: `O says hi ${stamp}` }))).message.id;
  ids.m1Msg = (await must('M1 message', post(`/api/communities/${ids.c1}/messages`, M1.token, { content: `M1 says hi ${stamp}` }))).message.id;
  await must('M2 message', post(`/api/communities/${ids.c1}/messages`, M2.token, { content: `M2 says hi ${stamp}` }));
  await must('O announcement', post(`/api/communities/${ids.c1}/announcements`, O.token, { title: 'Walk', content: `Sunday walk ${stamp}` }));
  // Media rows with fake URLs (no uploads): O's go with O's deletion; M1's and
  // M2's must be queued when the circle itself is deleted.
  const oMedia = fakeMedia('community_media', 'o_msg');
  const m1Photo = fakeMedia('community_photos', 'm1_photo');
  const m2Media = fakeMedia('community_media', 'm2_msg');
  ids.mediaPublicIds = [m1Photo.publicId, m2Media.publicId];
  await db.run('INSERT INTO community_messages (community_id, sender_id, content, media_url) VALUES (?, ?, ?, ?)', [ids.c1, O.userId, 'O photo', oMedia.url]);
  ids.oMediaMsg = (await one('SELECT id FROM community_messages WHERE community_id = ? AND media_url = ?', [ids.c1, oMedia.url])).id;
  await db.run('INSERT INTO community_messages (community_id, sender_id, content, media_url) VALUES (?, ?, ?, ?)', [ids.c1, M2.userId, 'M2 photo', m2Media.url]);
  await db.run('INSERT INTO community_photos (community_id, user_id, media_url, caption) VALUES (?, ?, ?, ?)', [ids.c1, M1.userId, m1Photo.url, 'M1 album']);
  // The question goes in as a parameter: a literal '?' in the SQL text would
  // be rewritten into a placeholder by the db adapter.
  ids.poll = (await one(
    `INSERT INTO community_polls (community_id, question, options_json, votes_json, created_by)
     VALUES (?, ?, '["park","beach"]', '{}', ?) RETURNING id`, [ids.c1, 'Park or beach?', O.userId])).id;
  await db.run('INSERT INTO community_events (community_id, title, location, created_by) VALUES (?, ?, ?, ?)', [ids.c1, 'Pack walk', 'Central Park', O.userId]);
  await db.run("INSERT INTO community_message_reactions (community_message_id, user_id, reaction) VALUES (?, ?, 'paw')", [ids.oMsg, M1.userId]);
  await db.run('INSERT INTO community_ownership_transfers (community_id, from_user_id, to_user_id) VALUES (?, ?, ?)', [ids.c2, O.userId, M1.userId]);
  console.log(`  O #${O.userId}, M1 #${M1.userId}, M2 #${M2.userId}, X #${X.userId}; C1 #${ids.c1}, C2 #${ids.c2} (transfer pending to M1)`);
  // Baseline for section 5: search hides private circles from non-members as
  // well as frozen ones, so first prove X's search finds the live, public C1.
  const c1Search = encodeURIComponent(`Frozen C1 ${stamp}`);
  let r0 = await get(`/api/communities?q=${c1Search}`, X.token);
  check("before freezing: X's search finds the live, public C1", r0.status === 200 && (r0.data.communities || []).some(c => c.id === ids.c1), show(r0));

  const result = await deleteUserAccount(O.userId, { skipCode: true });
  console.log(`  O deleted (SniffedOut); frozen circles: ${result.ownedCircleIds.join(', ')}`);

  section('1. Frozen');
  const c1 = await one('SELECT status, frozen_reason, member_count FROM communities WHERE id = ?', [ids.c1]);
  check("C1 status 'frozen', reason 'owner_deleted'", c1?.status === 'frozen' && c1?.frozen_reason === 'owner_deleted', JSON.stringify(c1));
  check("C2 status 'frozen'", (await one('SELECT status FROM communities WHERE id = ?', [ids.c2]))?.status === 'frozen');
  check('C1 member_count = 2 (O not counted)', c1?.member_count === 2, c1?.member_count);

  section('2. Every HTTP write -> 403 COMMUNITY_READ_ONLY (nothing changes)');
  const before = await circleSnapshot(ids.c1, ids.poll);
  const base = `/api/communities/${ids.c1}`;
  let r = await post(`${base}/messages`, M1.token, { content: 'still here?' });
  check('send a message', refused(r), show(r));
  r = await uploadForm(`${base}/messages`, M1.token, { content: 'pic' });
  check('upload media to the chat', refused(r), show(r));
  r = await uploadForm(`${base}/photos`, M1.token, { caption: 'pic' });
  check('upload a photo', refused(r), show(r));
  r = await post(`${base}/announcements`, M1.token, { title: 'Hi', content: 'Announcement' });
  check('post an announcement', refused(r), show(r));
  r = await post(`${base}/polls/${ids.poll}/vote`, M1.token, { optionIndex: 0 });
  check('vote in a poll', refused(r), show(r));
  r = await post(`${base}/members/${M2.userId}/role`, M1.token, { role: 'Admin' });
  check('change a member role', refused(r), show(r));
  r = await post(`${base}/disable`, M1.token);
  check('disable the circle', refused(r), show(r));
  r = await post(`${base}/join`, X.token);
  check('X joins (e.g. from an invite link)', refused(r), show(r));
  r = await post(`${base}/polls`, M1.token, { question: 'New?', options: ['a', 'b'] });
  check('creating a poll writes nothing (no such route)', r.status >= 400, show(r));
  const after = await circleSnapshot(ids.c1, ids.poll);
  check('database unchanged by all the refused writes', after === before, `${before} -> ${after}`);

  section('3. Socket writes -> community_error COMMUNITY_READ_ONLY');
  const ioClient = loadSocketClient();
  if (!ioClient) {
    console.log('  SKIP  socket.io-client not found in client/node_modules -- 5 socket checks not run');
  } else {
    const socket = ioClient(API_BASE, { auth: { token: M1.token }, transports: ['websocket'], reconnection: false });
    try {
      const connected = await Promise.race([
        new Promise(res => socket.once('connect', () => res(true))),
        new Promise(res => socket.once('connect_error', () => res(false))),
        new Promise(res => setTimeout(() => res(false), 5000)),
      ]);
      if (!connected) throw new Error('socket did not connect');
      const sockBefore = JSON.stringify({
        messages: await n('SELECT count(*)::int AS n FROM community_messages WHERE community_id = ?', [ids.c1]),
        reactions: await db.all('SELECT user_id, reaction FROM community_message_reactions WHERE community_message_id = ?', [ids.oMsg]),
        m1Msg: await one('SELECT content, message_type FROM community_messages WHERE id = ?', [ids.m1Msg]),
      });

      let errEvent = waitFor(socket, 'community_error');
      const ack = await new Promise(res => {
        const t = setTimeout(() => res(null), 5000);
        socket.emit('send_community_message', { communityId: ids.c1, content: 'socket hello?' }, a => { clearTimeout(t); res(a); });
      });
      check('send_community_message -> ack refused', ack?.success === false && ack?.error === 'COMMUNITY_READ_ONLY', JSON.stringify(ack));
      let payload = await errEvent;
      check('send_community_message -> community_error', payload?.error === 'COMMUNITY_READ_ONLY' && payload?.communityId === ids.c1, JSON.stringify(payload));

      errEvent = waitFor(socket, 'community_error');
      socket.emit('react_to_community_message', { messageId: ids.oMsg, communityId: ids.c1, reaction: 'paw' });
      payload = await errEvent;
      check('react_to_community_message -> community_error', payload?.error === 'COMMUNITY_READ_ONLY', JSON.stringify(payload));

      errEvent = waitFor(socket, 'community_error');
      socket.emit('fetch_back_community_message', { messageId: ids.m1Msg });
      payload = await errEvent;
      check('fetch_back_community_message -> community_error', payload?.error === 'COMMUNITY_READ_ONLY', JSON.stringify(payload));

      const sockAfter = JSON.stringify({
        messages: await n('SELECT count(*)::int AS n FROM community_messages WHERE community_id = ?', [ids.c1]),
        reactions: await db.all('SELECT user_id, reaction FROM community_message_reactions WHERE community_message_id = ?', [ids.oMsg]),
        m1Msg: await one('SELECT content, message_type FROM community_messages WHERE id = ?', [ids.m1Msg]),
      });
      check('no message, reaction or fetch-back happened', sockAfter === sockBefore, `${sockBefore} -> ${sockAfter}`);
    } finally {
      socket.disconnect();
    }
  }

  section('4. Members can still read everything');
  r = await get(base, M1.token);
  check('GET circle: frozen, status frozen, M1 still a Member', r.status === 200 && r.data.community?.frozen === true
    && r.data.community?.status === 'frozen' && r.data.community?.userRole === 'Member', show(r));
  r = await get(`${base}/messages`, M1.token);
  const msgs = r.data.messages || [];
  check("GET messages: all there, O's shown as SniffedOut", r.status === 200 && msgs.length >= 5
    && msgs.filter(m => m.sender_id === O.userId).every(m => m.sniffed_out && m.username === 'SniffedOut'), show(r));
  const oMediaRow = msgs.find(m => m.id === ids.oMediaMsg);
  check("O's media message kept with media_url NULL", !!oMediaRow && oMediaRow.media_url === null, JSON.stringify(oMediaRow));
  r = await get(`${base}/photos`, M1.token);
  check("GET photos: M1's photo there", r.status === 200 && (r.data.photos || []).some(p => p.user_id === M1.userId), show(r));
  r = await get(`${base}/polls`, M1.token);
  check('GET polls: the poll is there', r.status === 200 && (r.data.polls || []).some(p => p.id === ids.poll), show(r));
  r = await get(`${base}/announcements`, M1.token);
  check('GET announcements: there', r.status === 200 && (r.data.announcements || []).length >= 1, show(r));
  r = await get(`${base}/events`, M1.token);
  check('GET events: there', r.status === 200 && (r.data.events || []).length >= 1, show(r));
  r = await get(`${base}/members`, M1.token);
  const owner = (r.data.members || []).find(m => m.user_id === O.userId);
  check('GET members: owner listed as SniffedOut with role Owner', r.status === 200 && owner?.sniffed_out === true
    && owner?.role === 'Owner' && owner?.pet_name === 'SniffedOut', show(r));

  section('5. Outsider X');
  check('C1 is still public (so the hiding below comes from frozen, not private)',
    (await one('SELECT is_private FROM communities WHERE id = ?', [ids.c1]))?.is_private === 0);
  const q = encodeURIComponent(`Frozen C1 ${stamp}`);
  r = await get(`/api/communities?q=${q}`, X.token);
  check("X's search doesn't find it", r.status === 200 && !(r.data.communities || []).some(c => c.id === ids.c1), show(r));
  r = await get('/api/communities?recommended=true', X.token);
  check("X's recommendations don't include it", r.status === 200 && !(r.data.communities || []).some(c => c.id === ids.c1), show(r));
  r = await get(base, X.token);
  check('X opening it (invite link) -> 404 COMMUNITY_UNAVAILABLE', r.status === 404 && r.data?.error === 'COMMUNITY_UNAVAILABLE', show(r));
  r = await get(`/api/communities?q=${q}`, M1.token);
  check("M1's search (their list) still has it, marked frozen", (r.data.communities || []).some(c => c.id === ids.c1 && c.frozen === true), show(r));

  section('6. Leaving C1');
  await deleteAbandonedFrozenCircles();
  check('hourly job leaves C1 alone while live members remain', !!(await one('SELECT id FROM communities WHERE id = ?', [ids.c1])));
  r = await post(`${base}/leave`, M1.token);
  check('M1 leaves -> 200, not deleted', r.status === 200 && r.data.deleted === false, show(r));
  const c1After = await one('SELECT member_count FROM communities WHERE id = ?', [ids.c1]);
  check('C1 still exists, member_count = 1', c1After?.member_count === 1, JSON.stringify(c1After));
  r = await post(`${base}/leave`, M2.token);
  check('M2 (last live member) leaves -> 200, deleted', r.status === 200 && r.data.deleted === true, show(r));
  const leftovers = await one(
    `SELECT (SELECT count(*) FROM communities WHERE id = ?) + (SELECT count(*) FROM community_messages WHERE community_id = ?)
          + (SELECT count(*) FROM community_photos WHERE community_id = ?) + (SELECT count(*) FROM community_polls WHERE community_id = ?)
          + (SELECT count(*) FROM community_events WHERE community_id = ?) + (SELECT count(*) FROM community_announcements WHERE community_id = ?)
          + (SELECT count(*) FROM community_members WHERE community_id = ?) AS n`,
    [ids.c1, ids.c1, ids.c1, ids.c1, ids.c1, ids.c1, ids.c1]);
  check('C1 and all its content are gone', Number(leftovers.n) === 0, leftovers.n);
  const queued = await db.all('SELECT public_id, deleted_user_id FROM pending_media_deletions WHERE public_id = ANY(?::text[])', [ids.mediaPublicIds]);
  check("M1's photo and M2's media file queued for Cloudinary deletion", queued.length === 2 && queued.every(q2 => q2.deleted_user_id === O.userId), JSON.stringify(queued));

  // M1 is the recipient of C2's pending ownership transfer. The recipient
  // leaving cancels the transfer (it could never be accepted), so it no
  // longer keeps the frozen circle alive.
  section('7. C2: "delete from my list" = leave; the transfer recipient leaving cancels it');
  const base2 = `/api/communities/${ids.c2}`;
  r = await post(`${base2}/delete-group`, M2.token);
  check('M2 "delete from my list" -> 200, left, not deleted', r.status === 200 && r.data.left === true && r.data.deleted === false, show(r));
  check("M2's membership is gone", !(await one('SELECT id FROM community_members WHERE community_id = ? AND user_id = ?', [ids.c2, M2.userId])));
  check('C2 kept while M1 (transfer recipient) is still in it', !!(await one('SELECT id FROM communities WHERE id = ?', [ids.c2])));
  r = await post(`${base2}/leave`, M1.token);
  check('M1 (recipient, last live member) leaves -> transfer cancelled, C2 deleted', r.status === 200 && r.data.deleted === true, show(r));
  check('C2 and its transfer are gone', !(await one('SELECT id FROM communities WHERE id = ?', [ids.c2]))
    && !(await one('SELECT id FROM community_ownership_transfers WHERE community_id = ?', [ids.c2])));
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
      if (!ours || row.is_admin || id === PROTECTED_USER_ID) throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
    }
    const list = async (sql, params) => (await tx.all(sql, params)).map(r => r.id);
    const pets = await list('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [users]);
    const circles = await list('SELECT id FROM communities WHERE id = ANY(?::int[]) OR created_by = ANY(?::int[])', [created.circles, users]);
    const outsiders = await tx.get(
      'SELECT count(*)::int AS n FROM community_members WHERE community_id = ANY(?::int[]) AND NOT (user_id = ANY(?::int[]))', [circles, users]);
    if (outsiders.n) throw new Error(`${outsiders.n} non-test member(s) joined a test circle -- leaving it for a manual look`);
    const posts = await list('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [pets]);
    const circleMsgs = await list('SELECT id FROM community_messages WHERE community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]);
    const steps = [
      ['community_message_reactions', 'user_id = ANY(?::int[]) OR community_message_id = ANY(?::int[])', [users, circleMsgs]],
      ['community_messages', 'id = ANY(?::int[])', [circleMsgs]],
      ['community_photos', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['community_announcements', 'community_id = ANY(?::int[]) OR sender_id = ANY(?::int[])', [circles, users]],
      ['community_events', 'community_id = ANY(?::int[]) OR created_by = ANY(?::int[])', [circles, users]],
      ['community_polls', 'community_id = ANY(?::int[]) OR created_by = ANY(?::int[])', [circles, users]],
      ['community_join_requests', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['community_ownership_transfers', 'community_id = ANY(?::int[]) OR to_user_id = ANY(?::int[]) OR from_user_id = ANY(?::int[])', [circles, users, users]],
      ['community_members', 'community_id = ANY(?::int[]) OR user_id = ANY(?::int[])', [circles, users]],
      ['communities', 'id = ANY(?::int[])', [circles]],
      ['profile_views', 'viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [pets, pets]],
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

    const petDel = await tx.run('DELETE FROM pets WHERE id = ANY(?::int[]) AND user_id = ANY(?::int[])', [pets, users]);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  deleted ${userDel.rowCount} test users, ${petDel.rowCount} pets, ${circles.length} circle(s) and their rows`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}   Backend: ${API_BASE}`);
  console.log(`Creates throwaway users frozen-test-${stamp}-{o,m1,m2,x}@example.invalid, runs the tests, then deletes them.`);
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
  const created = { users: [], circles: [], ids: {} };
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
