// Integration test for UPI payment proofs in the PRIVATE Supabase Storage
// bucket "payment-proofs", against your running backend (`npm run dev` on
// :3001), the database in server/.env (production, no real users yet) and
// the real Supabase project (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and, for
// the anon-key checks, SUPABASE_ANON_KEY in server/.env).
//
// Throwaway users on the reserved .invalid domain: U pays (uploads a real PNG
// through POST /api/premium/checkout/:id/submit) and is then deleted, N is a
// plain user, ADM a throwaway admin. Submissions from reserved test domains
// never notify the real admins (subscriptionService.js), so user 1 gets no
// notification or email from this test.
//
// Cleanup removes the test users' objects from the bucket and the test rows
// from the database, even if a check fails. Never touches user 1.
//
//   node scripts/testPaymentProofs.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import config from '../config.js';
import { initDb, getDb, dbAdapter as db, withTransaction } from '../db/connection.js';
import { getAdminClient, getAnonClient } from '../lib/supabase.js';
import { PLAN_KEYS } from '../config/plans.js';
import { deleteUserAccount } from '../services/accountDeletion.js';
import { afterAccountDeletion } from '../services/accountDeletionFollowUp.js';
import { purgePendingMedia } from '../services/mediaPurge.js';
import { PAYMENT_PROOFS_BUCKET } from '../services/paymentProofs.js';

const API_BASE = process.env.API_BASE || 'http://localhost:3001';
const PROTECTED_USER_ID = 1;
const stamp = Date.now();
const PASSWORD = `Tt1!${crypto.randomBytes(6).toString('hex')}`;
const mk = key => ({ key, email: `proof-test-${stamp}-${key}@example.invalid`, username: `proof${key}_${stamp}` });
const U = mk('u');
const N = mk('n');
const ADM = mk('adm');
const PAID_PLAN = PLAN_KEYS.find(k => k !== 'free');
// A valid 1x1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
const bucket = () => getAdminClient().storage.from(PAYMENT_PROOFS_BUCKET);

async function call(method, urlPath, token, body) {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}
const get = (p, token) => call('GET', p, token);
const post = (p, token, body) => call('POST', p, token, body);

async function submitProof(token, sessionId, utr, bytes = PNG, type = 'image/png', name = 'proof.png') {
  const form = new FormData();
  form.append('payment_method', 'upi');
  form.append('upi_transaction_id', utr);
  form.append('media', new Blob([bytes], { type }), name);
  const res = await fetch(`${API_BASE}/api/premium/checkout/${sessionId}/submit`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function objectsUnder(userId) {
  const { data, error } = await bucket().list(String(userId), { limit: 100 });
  if (error) throw new Error(`listing bucket folder ${userId}: ${error.message}`);
  return (data || []).filter(o => o.id).map(o => `${userId}/${o.name}`);
}
async function download(objectPath) {
  const { data, error } = await bucket().download(objectPath);
  return error ? null : Buffer.from(await data.arrayBuffer());
}
const tokenTtl = signedUrl => {
  try {
    const token = new URL(signedUrl).searchParams.get('token');
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp - payload.iat;
  } catch {
    return null;
  }
};

async function createUser(spec, created, admin = false) {
  const hash = await bcrypt.hash(PASSWORD, 10);
  const row = await one(
    `INSERT INTO users (email, username, password_hash, full_name, email_verified, is_admin)
     VALUES (?, ?, ?, ?, 1, ?) RETURNING id`,
    [spec.email, spec.username, hash, `Payment Proof Test ${spec.key}`, admin]);
  spec.userId = row.id;
  created.push({ id: row.id, email: spec.email });
  const login = await post('/api/auth/login', null, { email: spec.email, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed for ${spec.key}: ${show(login)}`);
  spec.token = login.data.accessToken;
}

// Every server file outside scripts/ and node_modules: which names it
// imports from services/paymentProofs.js, and whether it calls Supabase
// Storage itself or names the bucket (comments are stripped first).
function storageUsage() {
  const usage = {};
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!['node_modules', 'scripts', 'uploads', '.git'].includes(e.name)) walk(p);
      } else if (e.name.endsWith('.js')) {
        const src = fs.readFileSync(p, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*paymentProofs\.js['"]/g)]
          .flatMap(m => m[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(Boolean));
        const direct = /['"]payment-proofs['"]|\.storage\s*\.\s*from\s*\(/.test(src);
        const otherImport = /import\s+(\*|\w+)[^;]*from\s*['"][^'"]*paymentProofs\.js['"]|import\(\s*['"][^'"]*paymentProofs\.js/.test(src);
        if (imports.length || direct || otherImport) {
          usage[path.relative(serverDir, p).replace(/\\/g, '/')] = { imports: imports.sort(), direct, otherImport };
        }
      }
    }
  })(serverDir);
  return usage;
}

async function runTests(created) {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('server/.env must have SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY for this test');
  }

  section('Bucket and code layout');
  const { data: bucketInfo, error: bucketError } = await getAdminClient().storage.getBucket(PAYMENT_PROOFS_BUCKET);
  check(`bucket "${PAYMENT_PROOFS_BUCKET}" exists and is private`, !bucketError && bucketInfo?.public === false,
    bucketError?.message || JSON.stringify({ public: bucketInfo?.public }));
  // Who may use services/paymentProofs.js, and for what:
  //   routes/premium.js            the upload route's size/type limits (constants only)
  //   services/subscriptionService the upload itself (storePaymentProof)
  //   routes/admin.js              the signed URL for admins
  const usage = storageUsage();
  const ALLOWED = {
    'routes/premium.js': ['PROOF_MAX_BYTES', 'PROOF_MIME_TYPES'],
    'services/subscriptionService.js': ['storePaymentProof'],
    'routes/admin.js': ['SIGNED_URL_TTL_SECONDS', 'signedPaymentProofUrl'],
  };
  const direct = Object.keys(usage).filter(f => usage[f].direct);
  check('only services/paymentProofs.js calls Supabase Storage or names the bucket',
    JSON.stringify(direct) === JSON.stringify(['services/paymentProofs.js']), JSON.stringify(direct));
  const importers = Object.fromEntries(Object.entries(usage).filter(([f]) => f !== 'services/paymentProofs.js')
    .map(([f, u]) => [f, u.otherImport ? ['(whole module)', ...u.imports] : u.imports]));
  check('only the upload route (limits), the upload and the admin route import it, each only what it needs',
    JSON.stringify(Object.keys(importers).sort()) === JSON.stringify(Object.keys(ALLOWED).sort())
      && Object.entries(ALLOWED).every(([f, names]) => JSON.stringify(importers[f]) === JSON.stringify([...names].sort())),
    JSON.stringify(importers));
  const proofModule = await import('../services/paymentProofs.js');
  check('paymentProofs.js offers no way to delete or list proofs (exports: upload, signed URL, constants)',
    JSON.stringify(Object.keys(proofModule).sort()) === JSON.stringify(['PAYMENT_PROOFS_BUCKET', 'PROOF_MAX_BYTES', 'PROOF_MIME_TYPES',
      'SIGNED_URL_TTL_SECONDS', 'signedPaymentProofUrl', 'storePaymentProof']), JSON.stringify(Object.keys(proofModule).sort()));
  const purgeSide = ['services/accountDeletion.js', 'services/mediaPurge.js', 'services/accountDeletionFollowUp.js', 'db/cleanup.js'];
  check('account deletion, media purge and the hourly cleanup have no access to it', !purgeSide.some(f => usage[f]), JSON.stringify(purgeSide.filter(f => usage[f])));

  section('Setup');
  await createUser(U, created);
  await createUser(N, created);
  await createUser(ADM, created, true);
  let r = await post('/api/premium/checkout', U.token, { plan: PAID_PLAN });
  if (r.status !== 200 || !r.data.sessionId) throw new Error(`U checkout: ${show(r)}`);
  U.sessionId = r.data.sessionId;
  r = await post('/api/premium/checkout', N.token, { plan: PAID_PLAN });
  if (r.status !== 200 || !r.data.sessionId) throw new Error(`N checkout: ${show(r)}`);
  N.sessionId = r.data.sessionId; // never gets a proof
  console.log(`  U #${U.userId} (session #${U.sessionId}), N #${N.userId} (session #${N.sessionId}), ADM #${ADM.userId}; plan ${PAID_PLAN}`);

  section('Upload');
  r = await submitProof(U.token, U.sessionId, `PPX${stamp}`, Buffer.from('not really a png at all, just text'));
  check('a fake PNG (wrong content) -> 400 INVALID_FILE', r.status === 400 && r.data.error === 'INVALID_FILE', show(r));
  check('...and nothing was stored for it', (await objectsUnder(U.userId)).length === 0, JSON.stringify(await objectsUnder(U.userId)));
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
  r = await submitProof(U.token, U.sessionId, `PPG${stamp}`, GIF, 'image/gif', 'proof.gif');
  check('a real GIF (the bucket takes JPEG/PNG/WebP only) -> 400 INVALID_FILE_TYPE', r.status === 400 && r.data.error === 'INVALID_FILE_TYPE', show(r));
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  r = await submitProof(U.token, U.sessionId, `PPB${stamp}`, big);
  check('a PNG over 5 MB (the bucket limit) -> 400 FILE_TOO_LARGE', r.status === 400 && r.data.error === 'FILE_TOO_LARGE', show(r));
  check('...nothing stored for either, session still pending', (await objectsUnder(U.userId)).length === 0
    && (await one('SELECT status FROM payment_sessions WHERE id = ?', [U.sessionId]))?.status === 'pending');
  r = await submitProof(U.token, U.sessionId, `PPT${stamp}`);
  check('real PNG proof -> 200', r.status === 200, show(r));
  const row = await one('SELECT status, proof_url, proof_storage_path, user_id FROM payment_sessions WHERE id = ?', [U.sessionId]);
  const pathRe = new RegExp(`^${U.userId}/${U.sessionId}-[0-9a-f]{16}\\.png$`);
  check('session: pending_review, storage PATH saved (<userId>/<sessionId>-<random>.png), no public URL',
    row?.status === 'pending_review' && pathRe.test(row?.proof_storage_path || '') && row?.proof_url === null, JSON.stringify(row));
  const proofPath = row?.proof_storage_path;
  const stored = proofPath ? await download(proofPath) : null;
  check('the object is in the bucket with the exact uploaded bytes', !!stored && stored.equals(PNG), stored ? `${stored.length} bytes` : 'missing');
  check('the user folder holds exactly that one object', JSON.stringify(await objectsUnder(U.userId)) === JSON.stringify([proofPath]));
  const quota = await one(
    'SELECT (SELECT count(*)::int FROM media_files WHERE user_id = ?) AS media_files, (SELECT storage_used_bytes FROM users WHERE id = ?) AS used',
    [U.userId, U.userId]);
  check('no quota tracking: no media_files row, storage_used_bytes still 0', quota.media_files === 0 && Number(quota.used) === 0, JSON.stringify(quota));
  if (config.CLOUDINARY_CLOUD_NAME && config.CLOUDINARY_API_KEY) {
    const { v2: cloudinary } = await import('cloudinary');
    cloudinary.config({ cloud_name: config.CLOUDINARY_CLOUD_NAME, api_key: config.CLOUDINARY_API_KEY, api_secret: config.CLOUDINARY_API_SECRET });
    const tagged = await cloudinary.api.resources_by_tag(`payproof_user_${U.userId}`, { max_results: 10 });
    check('nothing went to Cloudinary (no payproof_user_<id> file)', (tagged.resources || []).length === 0, (tagged.resources || []).length);
  }
  const adminNotes = await one(
    "SELECT count(*)::int AS n FROM notifications WHERE type = 'admin_payment_review_needed' AND target_id = ?", [String(U.sessionId)]);
  check('no admin (user 1 included) was notified about the test submission', adminNotes.n === 0, adminNotes.n);

  section('Not reachable without a signed URL');
  const base = config.SUPABASE_URL.replace(/\/+$/, '');
  for (const [label, url, headers] of [
    ['public object URL', `${base}/storage/v1/object/public/${PAYMENT_PROOFS_BUCKET}/${proofPath}`, {}],
    ['object URL without credentials', `${base}/storage/v1/object/${PAYMENT_PROOFS_BUCKET}/${proofPath}`, {}],
    ...(config.SUPABASE_ANON_KEY ? [['authenticated URL with the anon key', `${base}/storage/v1/object/authenticated/${PAYMENT_PROOFS_BUCKET}/${proofPath}`,
      { apikey: config.SUPABASE_ANON_KEY, Authorization: `Bearer ${config.SUPABASE_ANON_KEY}` }]] : []),
  ]) {
    const res = await fetch(url, { headers });
    const body = Buffer.from(await res.arrayBuffer());
    check(`${label} -> refused (${res.status})`, res.status !== 200 && !body.equals(PNG), res.status);
  }
  if (config.SUPABASE_ANON_KEY) {
    const { error } = await getAnonClient().storage.from(PAYMENT_PROOFS_BUCKET).createSignedUrl(proofPath, 60);
    check('the anon key cannot sign a URL for it', !!error, error?.message || 'signed!');
  } else {
    console.log('  SKIP  SUPABASE_ANON_KEY not set -- 2 anon-key checks not run');
  }

  section('Admin list and signed URL');
  r = await get('/api/admin/payments/pending', ADM.token);
  const listed = (r.data.payments || []).find(p => p.id === U.sessionId);
  check('pending list: has_proof true, no public URL, storage path not exposed',
    !!listed && listed.has_proof === true && listed.proof_url === null && !('proof_storage_path' in listed), JSON.stringify(listed));
  const proofUrlPath = id => `/api/admin/payments/${id}/proof-url`;
  r = await get(proofUrlPath(U.sessionId), null);
  check('logged out -> 401, no URL', r.status === 401 && !r.data.url, show(r));
  r = await get(proofUrlPath(U.sessionId), N.token);
  check('non-admin -> 403 FORBIDDEN, no URL', r.status === 403 && r.data.error === 'FORBIDDEN' && !r.data.url, show(r));
  r = await get(proofUrlPath(U.sessionId), U.token);
  check("the payer themself (not an admin) -> 403 FORBIDDEN", r.status === 403 && r.data.error === 'FORBIDDEN', show(r));
  r = await get(proofUrlPath(U.sessionId), ADM.token);
  check('admin -> 200 signed URL, expiresInSeconds 300, not legacy',
    r.status === 200 && typeof r.data.url === 'string' && r.data.url.includes(`/object/sign/${PAYMENT_PROOFS_BUCKET}/`)
      && r.data.expiresInSeconds === 300 && r.data.legacy === false, show(r));
  const signed = r.data.url;
  check('the signed token itself expires 300s after issue', tokenTtl(signed) === 300, tokenTtl(signed));
  if (signed) {
    const res = await fetch(signed);
    const body = Buffer.from(await res.arrayBuffer());
    check('the signed URL works: 200 with the exact image', res.status === 200 && body.equals(PNG), `${res.status} ${body.length} bytes`);
  }
  r = await get(proofUrlPath(N.sessionId), ADM.token);
  check('session without a proof -> 404 NO_PROOF', r.status === 404 && r.data.error === 'NO_PROOF', show(r));
  const maxId = (await one('SELECT COALESCE(MAX(id), 0) AS m FROM payment_sessions')).m;
  r = await get(proofUrlPath(maxId + 100000), ADM.token);
  check('unknown session -> 404 SESSION_NOT_FOUND', r.status === 404 && r.data.error === 'SESSION_NOT_FOUND', show(r));
  const legacyUrl = `https://res.cloudinary.com/${config.CLOUDINARY_CLOUD_NAME || 'demo'}/image/upload/v1/sniffr/payment_proofs/prooftest_${stamp}.jpg`;
  const legacyId = (await one(
    `INSERT INTO payment_sessions (user_id, plan, amount, provider, status, upi_transaction_id, proof_url, submitted_at)
     VALUES (?, ?, 1, 'upi_manual', 'rejected', ?, ?, CURRENT_TIMESTAMP) RETURNING id`,
    [N.userId, PAID_PLAN, `PPL${stamp}`, legacyUrl])).id;
  r = await get(proofUrlPath(legacyId), ADM.token);
  check('older Cloudinary proof -> 200 with its URL as is (legacy: true)', r.status === 200 && r.data.url === legacyUrl && r.data.legacy === true, show(r));

  section("Deleting U's account keeps the proof");
  const deleted = await deleteUserAccount(U.userId, { skipCode: true });
  await afterAccountDeletion(U.userId, deleted, {});
  await purgePendingMedia({ deletedUserId: U.userId, includeSweeps: true });
  const after = await one('SELECT user_id, status, proof_storage_path FROM payment_sessions WHERE id = ?', [U.sessionId]);
  check('U is SniffedOut; the session still points at U, pending_review, same path',
    !!(await one('SELECT deleted_at FROM users WHERE id = ?', [U.userId]))?.deleted_at
      && after.user_id === U.userId && after.status === 'pending_review' && after.proof_storage_path === proofPath, JSON.stringify(after));
  const kept = await download(proofPath);
  check('the object is still in the bucket after deletion, media purge and tag sweep', !!kept && kept.equals(PNG), kept ? `${kept.length} bytes` : 'missing');
  r = await get(proofUrlPath(U.sessionId), ADM.token);
  let works = false;
  if (r.status === 200) works = Buffer.from(await (await fetch(r.data.url)).arrayBuffer()).equals(PNG);
  check('admin can still view it (fresh signed URL works)', works, show(r));
  r = await get('/api/admin/payments/pending', ADM.token);
  const listedAfter = (r.data.payments || []).find(p => p.id === U.sessionId);
  check('pending list marks it account_deleted, proof still there', listedAfter?.account_deleted === true && listedAfter?.has_proof === true, JSON.stringify(listedAfter));
}

// ── Cleanup ─────────────────────────────────────────────────────────────
async function cleanup(created) {
  section('Cleanup');
  if (!created.length) {
    console.log('  nothing to clean up');
    return;
  }
  const users = created.map(u => u.id);
  // Bucket objects of the test users only (their own <userId>/ folders).
  if (config.SUPABASE_URL && config.SUPABASE_SERVICE_ROLE_KEY) {
    const paths = [];
    for (const id of users) {
      if (id === PROTECTED_USER_ID) continue;
      paths.push(...await objectsUnder(id));
    }
    if (paths.length) {
      const { error } = await bucket().remove(paths);
      if (error) throw new Error(`could not remove test objects ${paths.join(', ')}: ${error.message}`);
    }
    let left = 0;
    for (const id of users) if (id !== PROTECTED_USER_ID) left += (await objectsUnder(id)).length;
    if (left) throw new Error(`${left} test object(s) still in the bucket`);
    console.log(`  bucket: removed ${paths.length} test object(s)`);
  }

  await withTransaction(async tx => {
    for (const { id, email } of created) {
      const row = await tx.get('SELECT id, email, is_admin FROM users WHERE id = ? FOR UPDATE', [id]);
      if (!row) continue;
      if (id === PROTECTED_USER_ID || !(row.email === email || row.email === `sniffedout~${id}`)) {
        throw new Error(`Refusing to delete user #${id}: not a throwaway test account.`);
      }
      if (row.is_admin) await tx.run('UPDATE users SET is_admin = FALSE WHERE id = ? AND email = ?', [id, email]);
    }
    const queueExists = (await tx.get("SELECT to_regclass('public.pending_auth_deletions') IS NOT NULL AS ok")).ok;
    const steps = [
      ['notifications', 'user_id = ANY(?::int[])', [users]],
      ['plan_history', 'user_id = ANY(?::int[])', [users]],
      ['payment_sessions', 'user_id = ANY(?::int[])', [users]],
      ['pending_media_deletions', 'deleted_user_id = ANY(?::int[])', [users]],
      ['media_files', 'user_id = ANY(?::int[])', [users]],
      ['notification_preferences', 'user_id = ANY(?::int[])', [users]],
      ['refresh_tokens', 'user_id = ANY(?::int[])', [users]],
      ['trusted_devices', 'user_id = ANY(?::int[])', [users]],
      ['verification_codes', 'user_id = ANY(?::int[])', [users]],
      ...(queueExists ? [['pending_auth_deletions', 'deleted_user_id = ANY(?::int[])', [users]]] : []),
    ];
    const counts = [];
    for (const [table, where, params] of steps) {
      const res = await tx.run(`DELETE FROM ${table} WHERE ${where}`, params);
      if (res.rowCount) counts.push(`${res.rowCount} ${table}`);
    }
    const fks = await tx.all(
      `SELECT cl.relname AS table_name, a.attname::text AS column_name
       FROM pg_constraint con
       JOIN pg_class cl ON cl.oid = con.conrelid
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
       WHERE con.contype = 'f' AND cl.relnamespace = 'public'::regnamespace
         AND con.confrelid = 'public.users'::regclass AND cl.relname <> 'users'`);
    const leftovers = [];
    for (const f of fks) {
      const row = await tx.get(`SELECT count(*)::int AS n FROM public."${f.table_name}" WHERE "${f.column_name}" = ANY(?::int[])`, [users]);
      if (row.n) leftovers.push(`${f.table_name}.${f.column_name} (${row.n})`);
    }
    if (leftovers.length) throw new Error(`unexpected rows still reference the test accounts: ${leftovers.join(', ')}`);
    const userDel = await tx.run('DELETE FROM users WHERE id = ANY(?::int[]) AND NOT is_admin AND id <> ?', [users, PROTECTED_USER_ID]);
    console.log(`  database: deleted ${userDel.rowCount} test users${counts.length ? `, ${counts.join(', ')}` : ''}`);
  });
}

async function main() {
  const target = new URL(process.env.DATABASE_URL);
  console.log(`Database: ${target.hostname}:${target.port || 5432}${target.pathname}`);
  console.log(`Backend under test: ${API_BASE}   Bucket: ${PAYMENT_PROOFS_BUCKET}`);
  console.log(`Creates throwaway users proof-test-${stamp}-{u,n,adm}@example.invalid and one bucket object, then removes them.`);
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
      console.error(`\nCLEANUP FAILED: ${err.message}\n  Remove users ${created.map(u => `#${u.id}`).join(', ')} and their bucket folders by hand.`);
    } finally {
      await getDb().end();
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0); // the Supabase client can keep the process alive
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
