// Integration test for PawCircle membership and role checks, against your
// running backend (`npm run dev` on :3001, STORAGE_TYPE=cloud) and the
// database in server/.env (production, no real users yet).
//
// Throwaway users: owner OWN, member MEM, outsider OUT (who owns a circle of
// their own, CO, for the cross-circle checks). Checks:
//   - OUT is refused on every write over HTTP (403 NOT_A_MEMBER) and the
//     socket (community_error NOT_A_MEMBER), can't join the live room, can't
//     use another circle's poll or message through their own circle, and
//     nothing is written;
//   - MEM can post, upload, vote, reply, react and fetch back, but not
//     announce, change roles or disable (403 FORBIDDEN);
//   - OWN can announce, change roles and disable;
//   - after leaving, MEM stops getting live events and can't leave again.
// One real 1x1 image is uploaded (MEM's photo) and destroyed in cleanup.
// Cleanup removes every test row even if a check fails. Never touches user 1.
//
//   node scripts/testCircleMembership.js

import { createRequire } from 'module';

const readline = await import('readline/promises');
const crypto = await import('crypto');
const { default: bcrypt } = await import('bcryptjs');
const { default: config } = await import('../config.js');
const { initDb, getDb, dbAdapter: db, withTransaction } = await import('../db/connection.js');
const { default: cloudStorage } = await import('../storage/CloudStorage.js');
const { parseCloudinaryUrl } = await import('../services/accountDeletion.js');
const { testPetUsername } = await import('./lib/testIds.js');

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `member-test-${stamp}-${key}@example.invalid`, username: `mbr${key}_${stamp}` });
const OWN = mk('own');
const MEM = mk('mem');
const OUT = mk('out');
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
const n = async (sql, params = []) => (await db.get(sql, params)).n;
const is = (r, status, code) => r.status === status && r.data?.error === code;

async function call(method, path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const post = (path, token, body) => call('POST', path, token, body);
async function must(label, promise, ok = [200, 201]) {
  const r = await promise;
  if (!ok.includes(r.status)) throw new Error(`fixture step failed: ${label}: ${show(r)}`);
  return r.data;
}
async function uploadForm(path, token, fields = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  form.append('media', new Blob([PNG], { type: 'image/png' }), 'member-test.png');
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
// Resolves with the event payload, or null if it doesn't arrive in time.
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
async function connect(ioClient, spec) {
  const socket = ioClient(API_BASE, { auth: { token: spec.token }, transports: ['websocket'], reconnection: false });
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
     VALUES (?, ?, ?, ?, 1) RETURNING id`, [spec.email, spec.username, hash, `Member Test ${spec.key.toUpperCase()}`]);
  spec.userId = row.id;
  created.users.push({ id: row.id, email: spec.email });
  spec.token = (await must(`login ${spec.key}`, post('/api/auth/login', null, { email: spec.email, password: PASSWORD }))).accessToken;
  spec.petId = (await must(`pet ${spec.key}`, post('/api/profile', spec.token, { name: `Mbr${spec.key.toUpperCase()}${stamp}`, pet_username: testPetUsername(`mbr${spec.key}`), type: 'dog' }))).id;
}

// Everything in a circle that a refused write could have changed.
const snapshot = async (id, pollId) => JSON.stringify({
  messages: await db.all('SELECT id, content, message_type, reply_to_id FROM community_messages WHERE community_id = ? ORDER BY id', [id]),
  photos: await n('SELECT count(*)::int AS n FROM community_photos WHERE community_id = ?', [id]),
  announcements: await n('SELECT count(*)::int AS n FROM community_announcements WHERE community_id = ?', [id]),
  votes: (await one('SELECT votes_json FROM community_polls WHERE id = ?', [pollId]))?.votes_json,
  reactions: await n(`SELECT count(*)::int AS n FROM community_message_reactions r
                      JOIN community_messages m ON m.id = r.community_message_id WHERE m.community_id = ?`, [id]),
  members: await db.all('SELECT user_id, role, is_hidden FROM community_members WHERE community_id = ? ORDER BY user_id', [id]),
  circle: await one('SELECT status, is_private, member_count FROM communities WHERE id = ?', [id]),
});

async function runTests(created) {
  const ids = created.ids;
  const ioClient = loadSocketClient();
  if (!ioClient) throw new Error('socket.io-client not found in client/node_modules');

  section('Setup');
  for (const spec of [OWN, MEM, OUT]) await createUser(spec, created);
  ids.c = (await must('OWN creates C', post('/api/communities', OWN.token, { name: `Member C ${stamp}`, description: 'membership test' }))).community.id;
  ids.co = (await must('OUT creates CO', post('/api/communities', OUT.token, { name: `Member CO ${stamp}`, description: 'membership test' }))).community.id;
  created.circles.push(ids.c, ids.co);
  await must('MEM joins C', post(`/api/communities/${ids.c}/join`, MEM.token));
  ids.ownMsg = (await must('OWN message', post(`/api/communities/${ids.c}/messages`, OWN.token, { content: `OWN hi ${stamp}` }))).message.id;
  ids.memMsg = (await must('MEM message', post(`/api/communities/${ids.c}/messages`, MEM.token, { content: `MEM secret ${stamp}` }))).message.id;
  // Question passed as a parameter: a literal ? in SQL text becomes a placeholder.
  ids.poll = (await one(
    `INSERT INTO community_polls (community_id, question, options_json, votes_json, created_by)
     VALUES (?, ?, '["yes","no"]', '{}', ?) RETURNING id`, [ids.c, 'Walk today?', OWN.userId])).id;
  console.log(`  OWN #${OWN.userId}, MEM #${MEM.userId}, OUT #${OUT.userId}; C #${ids.c} (OWN's), CO #${ids.co} (OUT's)`);

  const base = `/api/communities/${ids.c}`;
  const ownSock = await connect(ioClient, OWN);
  const memSock = await connect(ioClient, MEM);
  const outSock = await connect(ioClient, OUT);
  created.sockets.push(ownSock, memSock, outSock);

  section('1. Outsider over HTTP -> 403 NOT_A_MEMBER, nothing written');
  const before = await snapshot(ids.c, ids.poll);
  let r = await post(`${base}/messages`, OUT.token, { content: 'let me in' });
  check('send a message', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await uploadForm(`${base}/messages`, OUT.token, { content: 'pic' });
  check('upload media to the chat (refused before the upload)', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await uploadForm(`${base}/photos`, OUT.token, { caption: 'pic' });
  check('upload a photo', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await post(`${base}/announcements`, OUT.token, { title: 'Hi', content: 'Announcement' });
  check('post an announcement', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await post(`${base}/polls/${ids.poll}/vote`, OUT.token, { optionIndex: 0 });
  check('vote in a poll', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await post(`${base}/members/${MEM.userId}/role`, OUT.token, { role: 'Admin' });
  check('change a member role', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await post(`${base}/disable`, OUT.token);
  check('disable the circle', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await post(`${base}/leave`, OUT.token);
  check('leave (not a member)', is(r, 403, 'NOT_A_MEMBER'), show(r));
  r = await post(`${base}/delete-group`, OUT.token);
  check('delete from list (not a member)', is(r, 403, 'NOT_A_MEMBER'), show(r));
  check('database unchanged by all the refused writes', await snapshot(ids.c, ids.poll) === before);
  r = await post(`/api/communities/${ids.co}/polls/${ids.poll}/vote`, OUT.token, { optionIndex: 1 });
  check("voting in C's poll through OUT's own circle -> 404, no vote", is(r, 404, 'NOT_FOUND')
    && (await one('SELECT votes_json FROM community_polls WHERE id = ?', [ids.poll]))?.votes_json === '{}', show(r));
  const coBefore = await n('SELECT count(*)::int AS n FROM community_messages WHERE community_id = ?', [ids.co]);
  r = await post(`/api/communities/${ids.co}/messages`, OUT.token, { content: 'quoting you', reply_to_id: ids.memMsg });
  check("replying in OUT's circle to a C message -> 400 INVALID_REPLY (no leak of its text)", is(r, 400, 'INVALID_REPLY')
    && !JSON.stringify(r.data).includes(`MEM secret ${stamp}`)
    && await n('SELECT count(*)::int AS n FROM community_messages WHERE community_id = ?', [ids.co]) === coBefore, show(r));

  section('2. Outsider over the socket -> NOT_A_MEMBER, no live events');
  let ack = await emitAck(outSock, 'join_community_chat', { communityId: ids.c });
  check('OUT join_community_chat -> refused', ack?.success === false && ack?.error === 'NOT_A_MEMBER', JSON.stringify(ack));
  ack = await emitAck(memSock, 'join_community_chat', { communityId: ids.c });
  check('MEM join_community_chat -> allowed', ack?.success === true, JSON.stringify(ack));
  await emitAck(ownSock, 'join_community_chat', { communityId: ids.c });
  const outGotMsg = waitFor(outSock, 'community_message_received', 2000, m => m?.community_id === ids.c);
  ids.ownMsg2 = (await must('OWN message 2', post(`${base}/messages`, OWN.token, { content: `OWN live ${stamp}` }))).message.id;
  check("OUT doesn't receive C's live messages", (await outGotMsg) === null);
  const socketBefore = await snapshot(ids.c, ids.poll);
  let errEvent = waitFor(outSock, 'community_error');
  ack = await emitAck(outSock, 'send_community_message', { communityId: ids.c, content: 'socket hi' });
  check('OUT send_community_message -> ack NOT_A_MEMBER', ack?.success === false && ack?.error === 'NOT_A_MEMBER', JSON.stringify(ack));
  let payload = await errEvent;
  check('OUT send_community_message -> community_error NOT_A_MEMBER', payload?.error === 'NOT_A_MEMBER' && payload?.communityId === ids.c, JSON.stringify(payload));
  errEvent = waitFor(outSock, 'community_error');
  outSock.emit('react_to_community_message', { messageId: ids.memMsg, communityId: ids.co, reaction: 'paw' });
  payload = await errEvent;
  check('OUT react (claiming its own circle) -> community_error NOT_A_MEMBER', payload?.error === 'NOT_A_MEMBER', JSON.stringify(payload));
  errEvent = waitFor(outSock, 'community_error');
  outSock.emit('fetch_back_community_message', { messageId: ids.memMsg });
  payload = await errEvent;
  check('OUT fetch_back -> community_error NOT_A_MEMBER', payload?.error === 'NOT_A_MEMBER', JSON.stringify(payload));
  const memGotTyping = waitFor(memSock, 'community_user_typing', 1500, t => t?.userId === OUT.userId);
  outSock.emit('community_typing', { communityId: ids.c, isTyping: true });
  check("OUT's typing isn't relayed into C", (await memGotTyping) === null);
  check('database unchanged by the refused socket actions', await snapshot(ids.c, ids.poll) === socketBefore);

  section('3. Member: member things yes, admin things no');
  r = await post(`${base}/messages`, MEM.token, { content: `MEM again ${stamp}` });
  check('MEM sends a message -> 201', r.status === 201, show(r));
  r = await post(`${base}/messages`, MEM.token, { content: 'replying', reply_to_id: ids.ownMsg });
  check('MEM replies to a C message -> 201 with the preview', r.status === 201 && r.data.message?.reply_to_id === ids.ownMsg, show(r));
  r = await uploadForm(`${base}/photos`, MEM.token, { caption: 'MEM photo' });
  if (r.data?.photo?.media_url) {
    const parsed = parseCloudinaryUrl(r.data.photo.media_url);
    if (parsed) created.files.push(parsed);
  }
  check('MEM uploads a photo -> 201', r.status === 201 && !!r.data.photo?.media_url, show(r));
  r = await post(`${base}/polls/${ids.poll}/vote`, MEM.token, { optionIndex: 0 });
  check('MEM votes -> 200, vote recorded', r.status === 200 && (r.data.poll?.votes?.['0'] || []).includes(MEM.userId), show(r));
  ack = await emitAck(memSock, 'send_community_message', { communityId: ids.c, content: `MEM socket ${stamp}`, replyToId: ids.ownMsg });
  check('MEM socket send -> ack success', ack?.success === true && ack?.message?.community_id === ids.c, JSON.stringify(ack));
  ack = await emitAck(memSock, 'react_to_community_message', { messageId: ids.ownMsg, reaction: 'paw' });
  check('MEM socket react -> ack success', ack?.success === true && ack?.reactions?.paw === 1, JSON.stringify(ack));
  ack = await emitAck(memSock, 'fetch_back_community_message', { messageId: ids.memMsg });
  check('MEM socket fetch back own message -> ack success', ack?.success === true
    && (await one('SELECT message_type FROM community_messages WHERE id = ?', [ids.memMsg]))?.message_type === 'system', JSON.stringify(ack));
  const adminBefore = JSON.stringify({
    announcements: await n('SELECT count(*)::int AS n FROM community_announcements WHERE community_id = ?', [ids.c]),
    members: await db.all('SELECT user_id, role FROM community_members WHERE community_id = ? ORDER BY user_id', [ids.c]),
    circle: await one('SELECT is_private, disabled_at FROM communities WHERE id = ?', [ids.c]),
  });
  r = await post(`${base}/announcements`, MEM.token, { title: 'Hi', content: 'Members cannot announce' });
  check('MEM announcement -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));
  r = await post(`${base}/members/${MEM.userId}/role`, MEM.token, { role: 'Admin' });
  check('MEM makes themself Admin -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));
  r = await post(`${base}/disable`, MEM.token);
  check('MEM disables the circle -> 403 FORBIDDEN', is(r, 403, 'FORBIDDEN'), show(r));
  const adminAfter = JSON.stringify({
    announcements: await n('SELECT count(*)::int AS n FROM community_announcements WHERE community_id = ?', [ids.c]),
    members: await db.all('SELECT user_id, role FROM community_members WHERE community_id = ? ORDER BY user_id', [ids.c]),
    circle: await one('SELECT is_private, disabled_at FROM communities WHERE id = ?', [ids.c]),
  });
  check('no announcement, role or disable change from MEM', adminAfter === adminBefore, `${adminBefore} -> ${adminAfter}`);

  section('4. Owner: admin things');
  r = await post(`${base}/announcements`, OWN.token, { title: 'Walk', content: `Sunday ${stamp}` });
  check('OWN announcement -> 201', r.status === 201, show(r));
  r = await post(`${base}/members/${MEM.userId}/role`, OWN.token, { role: 'Moderator' });
  check('OWN makes MEM Moderator -> 200, saved', r.status === 200
    && (await one('SELECT role FROM community_members WHERE community_id = ? AND user_id = ?', [ids.c, MEM.userId]))?.role === 'Moderator', show(r));
  r = await post(`${base}/disable`, OWN.token);
  const disabled = await one('SELECT is_private, disabled_at FROM communities WHERE id = ?', [ids.c]);
  check('OWN disables the circle -> 200, disabled_at set (is_private untouched: it now means join-by-approval)',
    r.status === 200 && !!disabled?.disabled_at && disabled?.is_private === 0, `${show(r)} ${JSON.stringify(disabled)}`);
  // Disabling is an archive (read-only for everyone); the rest of this test
  // writes to C, so the Owner re-enables it.
  r = await post(`${base}/enable`, OWN.token);
  check('OWN re-enables the circle -> 200, active again', r.status === 200 && r.data.community?.disabled === false, show(r));

  section('5. Leaving');
  r = await post(`${base}/leave`, MEM.token);
  check('MEM leaves -> 200', r.status === 200 && r.data.deleted === false, show(r));
  const memGotMsg = waitFor(memSock, 'community_message_received', 2000, m => m?.community_id === ids.c);
  await must('OWN message 3', post(`${base}/messages`, OWN.token, { content: `OWN after MEM left ${stamp}` }));
  check('MEM no longer receives C live messages after leaving', (await memGotMsg) === null);
  r = await post(`${base}/leave`, MEM.token);
  check('MEM leaving again -> 403 NOT_A_MEMBER', is(r, 403, 'NOT_A_MEMBER'), show(r));
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  for (const socket of created.sockets) socket.disconnect();
  for (const f of created.files) {
    try {
      const { result } = await cloudStorage.destroy(f.publicId, f.resourceType);
      console.log(`  Cloudinary ${f.publicId}: ${result}`);
    } catch (err) {
      failed++;
      console.error(`  could not remove ${f.resourceType}/${f.publicId} from Cloudinary: ${err.message}`);
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
      if (row.email !== email || row.is_admin || id === PROTECTED_USER_ID) throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
    }
    const list = async (sql, params) => (await tx.all(sql, params)).map(r => r.id);
    const pets = await list('SELECT id FROM pets WHERE user_id = ANY(?::int[])', [users]);
    const circles = await list('SELECT id FROM communities WHERE id = ANY(?::int[]) OR created_by = ANY(?::int[])', [created.circles, users]);
    const outsiders = await tx.get(
      'SELECT count(*)::int AS n FROM community_members WHERE community_id = ANY(?::int[]) AND NOT (user_id = ANY(?::int[]))', [circles, users]);
    if (outsiders.n) throw new Error(`${outsiders.n} non-test member(s) joined a test circle -- leaving it for a manual look`);
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
      ['notifications', 'user_id = ANY(?::int[]) OR sender_pet_id = ANY(?::int[])', [users, pets]],
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
  console.log(`Creates throwaway users member-test-${stamp}-{own,mem,out}@example.invalid and one tiny Cloudinary image, then removes them.`);
  if (config.STORAGE_TYPE !== 'cloud') console.log('  (STORAGE_TYPE is not cloud: the member photo goes to local storage instead)');
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
  const created = { users: [], circles: [], files: [], sockets: [], ids: {} };
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
