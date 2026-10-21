import { withTransaction } from '../db/connection.js';
import config from '../config.js';
import { SNIFFED_OUT } from '../utils/sniffedOut.js';
import { buildGroupedActivityTitle } from '../models/NotificationRepository.js';

// Account deletion ("SniffedOut"). One transaction turns the account and all
// its pets into anonymous tombstones: personal data scrubbed, own posts and
// private rows deleted, everything other people still need (chats, comments,
// likes, matches, calls, circle history) kept and shown as "SniffedOut".
// Any error rolls back everything -- including consuming the email code, so
// the user can simply retry.
//
// Nothing happens after COMMIT here: disconnecting sockets and purging the
// queued Cloudinary media are separate steps (see the deletion routes and
// the media purge job).

export class AccountDeletionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MEDIA_MESSAGE_TYPES = ['image', 'video', 'voice', 'file'];
// Cloudinary folder (under sniffr/) each kind of owned media must live in.
// payment_proofs is deliberately absent: proofs are kept for finance.
const MEDIA_FOLDERS = ['posts', 'avatars', 'chat', 'community_media', 'community_photos'];
// Columns that may still point at a file after the deletion; a queued file
// referenced by any of them is left alone.
const SURVIVING_MEDIA_REFERENCES = [
  ['posts', 'media_url'], ['pets', 'avatar_url'], ['messages', 'media_url'],
  ['community_messages', 'media_url'], ['community_photos', 'media_url'],
  ['communities', 'cover_image'], ['notifications', 'avatar_url'], ['payment_sessions', 'proof_url'],
];
const TABLES = [
  'users', 'pets', 'posts', 'likes', 'reactions', 'shares', 'post_reports', 'comments',
  'notifications', 'messages', 'conversations', 'matches', 'swipes', 'profile_views',
  'spotlight_rank_tracking', 'blocked_users', 'trusted_devices', 'refresh_tokens',
  'notification_preferences', 'app_ratings', 'verification_codes', 'communities',
  'community_members', 'community_messages', 'community_photos', 'community_join_requests',
  'community_announcements', 'community_events', 'payment_sessions', 'plan_history',
  'media_files', 'pending_media_deletions', 'pending_auth_deletions', 'community_ownership_transfers',
];

// Test-only failure injection: honoured only when a test process opts in
// and never in production.
const TEST_HOOKS_ENABLED = process.env.SNIFFR_TEST_HOOKS === '1' && config.NODE_ENV !== 'production';

/**
 * Deletes (tombstones) an account.
 *
 * options.codeId    id of the delete_account verification code already checked
 *                   by checkCode(); consumed here, inside the transaction.
 * options.skipCode  internal only (future admin CLI for users who can't reach
 *                   their email) -- never set from a request.
 *
 * Returns { petIds, ownedCircleIds, conversationIds, pendingMediaCount,
 * authUserId } (authUserId: the Supabase identity queued for deletion, or null).
 * Throws AccountDeletionError with code USER_NOT_FOUND, ALREADY_DELETED,
 * ADMIN_CANNOT_SELF_DELETE, CODE_REQUIRED, CODE_INVALID, SETUP_INCOMPLETE or
 * ASSERTION_FAILED.
 */
export async function deleteUserAccount(userId, options = {}) {
  const { codeId = null, skipCode = false, _testFailAt = null } = options;
  if (_testFailAt && !TEST_HOOKS_ENABLED) {
    throw new AccountDeletionError('TEST_HOOKS_DISABLED', 'Test failure injection is disabled.');
  }
  if (!skipCode && !codeId) throw new AccountDeletionError('CODE_REQUIRED', 'A verified code is required.');

  return withTransaction(async tx => {
    await tx.run("SET LOCAL lock_timeout = '10s'");

    // ── Lock and validate ─────────────────────────────────────────────
    const user = await tx.get('SELECT * FROM users WHERE id = ? FOR UPDATE', [userId]);
    if (!user) throw new AccountDeletionError('USER_NOT_FOUND', 'Account not found.');
    if (user.deleted_at) throw new AccountDeletionError('ALREADY_DELETED', 'This account has already been deleted.');
    if (user.is_admin) throw new AccountDeletionError('ADMIN_CANNOT_SELF_DELETE', 'Admin accounts cannot be deleted this way.');

    if (!skipCode) {
      const consumed = await tx.run(
        `UPDATE verification_codes SET consumed_at = NOW()
         WHERE id = ? AND user_id = ? AND purpose = 'delete_account'
           AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > NOW()`,
        [codeId, userId]
      );
      if (consumed.rowCount !== 1) throw new AccountDeletionError('CODE_INVALID', 'The verification code is no longer valid.');
    }

    const present = new Set((await tx.all(
      "SELECT t FROM unnest(?::text[]) AS t WHERE to_regclass('public.' || t) IS NOT NULL", [TABLES]
    )).map(r => r.t));
    const has = table => present.has(table);
    const ids = rows => rows.map(r => r.id);

    // ── Supabase Auth identity (email/password accounts) ───────────────
    // Captured and unlinked here, inside the transaction; the identity itself
    // is deleted after COMMIT through a retry queue (services/
    // authIdentityPurge.js), since Supabase isn't part of this transaction.
    // Without the queue table the identity could be orphaned (and the email
    // could never sign up again), so the deletion refuses instead.
    const authUserId = user.auth_user_id || null;
    if (authUserId) {
      if (!has('pending_auth_deletions')) {
        throw new AccountDeletionError('SETUP_INCOMPLETE',
          'pending_auth_deletions is missing -- run server/db/sql/2026-10-01_pending_auth_deletions.sql.');
      }
      await tx.run(
        'INSERT INTO pending_auth_deletions (auth_user_id, deleted_user_id) VALUES (?::uuid, ?) ON CONFLICT (auth_user_id) DO NOTHING',
        [authUserId, userId]);
      await tx.run('UPDATE users SET auth_user_id = NULL WHERE id = ?', [userId]);
    }

    const pets = await tx.all('SELECT id, name, pet_username FROM pets WHERE user_id = ? ORDER BY id FOR UPDATE', [userId]);
    const petIds = ids(pets);
    const petNameById = new Map(pets.map(p => [p.id, p.name]));
    const postIds = has('posts') ? ids(await tx.all('SELECT id FROM posts WHERE pet_id = ANY(?::int[])', [petIds])) : [];
    const ownedCircleIds = has('communities')
      ? ids(await tx.all('SELECT id FROM communities WHERE created_by = ? ORDER BY id FOR UPDATE', [userId])) : [];
    const joinedCircleIds = has('community_members')
      ? (await tx.all(
        'SELECT DISTINCT community_id AS id FROM community_members WHERE user_id = ? AND NOT (community_id = ANY(?::int[]))',
        [userId, ownedCircleIds])).map(r => r.id)
      : [];
    const conversationIds = has('conversations') && has('matches')
      ? ids(await tx.all(
        `SELECT c.id FROM conversations c JOIN matches m ON m.id = c.match_id
         WHERE m.pet1_id = ANY(?::int[]) OR m.pet2_id = ANY(?::int[])`, [petIds, petIds]))
      : [];

    // ── 1. Collect media BEFORE anything is deleted or nulled ─────────
    const media = await collectMediaCandidates(tx, has, { userId, petIds, postIds });

    // ── 2. Own posts, with everything on them ─────────────────────────
    for (const table of ['likes', 'reactions', 'shares', 'post_reports', 'comments']) {
      if (has(table)) await tx.run(`DELETE FROM ${table} WHERE post_id = ANY(?::int[])`, [postIds]);
    }
    if (has('posts')) await tx.run('DELETE FROM posts WHERE id = ANY(?::int[])', [postIds]);
    // Their shares of other people's posts.
    if (has('shares')) await tx.run('DELETE FROM shares WHERE user_id = ?', [userId]);

    // ── 3. Notifications ──────────────────────────────────────────────
    if (has('notifications')) {
      await tx.run('DELETE FROM notifications WHERE user_id = ?', [userId]);
      await rewriteNotificationsFromPets(tx, has, { userId, petIds, petNameById });
    }

    // ── 4. @mentions of their handles in everything that survives ─────
    const handles = [...new Set([user.username, ...pets.map(p => (p.pet_username || '').replace(/^@/, ''))])]
      .filter(h => /^[A-Za-z0-9_]+$/.test(h || ''));
    await rewriteMentions(tx, has, handles);

    // ── 5. Chats: keep the text, drop their media ─────────────────────
    if (has('messages')) {
      await tx.run(
        'UPDATE messages SET media_url = NULL WHERE sender_id = ? AND message_type = ANY(?::text[]) AND media_url IS NOT NULL',
        [userId, MEDIA_MESSAGE_TYPES]);
    }

    // ── 6. PawCircles ─────────────────────────────────────────────────
    if (has('community_messages')) {
      await tx.run('UPDATE community_messages SET media_url = NULL WHERE sender_id = ? AND media_url IS NOT NULL', [userId]);
    }
    if (has('community_photos')) await tx.run('DELETE FROM community_photos WHERE user_id = ?', [userId]);
    if (has('community_join_requests')) await tx.run('DELETE FROM community_join_requests WHERE user_id = ?', [userId]);
    // A pending ownership transfer TO this user can never be accepted now:
    // cancelled (the owner is told afterwards, accountDeletionFollowUp.js).
    // One FROM them (their own circles) stays: the recipient can still accept
    // it and reactivate the frozen circle.
    const cancelledTransfers = has('community_ownership_transfers')
      ? await tx.all(
        `UPDATE community_ownership_transfers SET status = 'cancelled', responded_at = NOW()
         WHERE to_user_id = ? AND status = 'pending' RETURNING id, community_id, from_user_id, to_user_id`, [userId])
      : [];
    if (has('community_members')) {
      // Owner rows stay (shown as "SniffedOut (Owner)"); memberships elsewhere go.
      await tx.run('DELETE FROM community_members WHERE user_id = ? AND NOT (community_id = ANY(?::int[]))', [userId, ownedCircleIds]);
    }
    if (has('communities')) {
      await tx.run(
        "UPDATE communities SET status = 'frozen', frozen_at = NOW(), frozen_reason = 'owner_deleted' WHERE id = ANY(?::int[])",
        [ownedCircleIds]);
    }
    if (has('community_join_requests')) {
      // A frozen circle takes no new members: pending requests to join the
      // owner's circles are cancelled (same rule as services/circleJoinRequests.js).
      await tx.run(
        "UPDATE community_join_requests SET status = 'cancelled', decided_at = NOW() WHERE community_id = ANY(?::int[]) AND status = 'pending'",
        [ownedCircleIds]);
    }
    if (has('community_announcements')) {
      await tx.run('UPDATE community_announcements SET latitude = NULL, longitude = NULL WHERE sender_id = ?', [userId]);
    }
    if (has('community_events')) {
      await tx.run('UPDATE community_events SET location = NULL WHERE community_id = ANY(?::int[])', [ownedCircleIds]);
    }

    // ── 7. Private rows ───────────────────────────────────────────────
    if (has('swipes')) await tx.run('DELETE FROM swipes WHERE from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [petIds, petIds]);
    if (has('profile_views')) {
      await tx.run('DELETE FROM profile_views WHERE viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [petIds, petIds]);
    }
    if (has('spotlight_rank_tracking')) await tx.run('DELETE FROM spotlight_rank_tracking WHERE pet_id = ANY(?::int[])', [petIds]);
    if (has('blocked_users')) await tx.run('DELETE FROM blocked_users WHERE blocker_id = ? OR blocked_id = ?', [userId, userId]);
    for (const table of ['trusted_devices', 'refresh_tokens', 'notification_preferences', 'app_ratings', 'verification_codes']) {
      if (has(table)) await tx.run(`DELETE FROM ${table} WHERE user_id = ?`, [userId]);
    }

    // ── 8. Payments: kept and still linked to the tombstone ───────────
    if (has('payment_sessions')) {
      await tx.run("UPDATE payment_sessions SET status = 'cancelled' WHERE user_id = ? AND status = 'pending'", [userId]);
    }
    if (has('plan_history')) {
      await tx.run(
        `INSERT INTO plan_history (user_id, plan, source, action)
         SELECT id, current_plan, plan_source, 'account_deleted' FROM users
         WHERE id = ? AND subscription_status IN ('active', 'cancelled')
           AND plan_expiry_date > NOW() AND current_plan <> 'free'`,
        [userId]);
    }

    // ── 9. Scrub pets and user ────────────────────────────────────────
    await tx.run(
      `UPDATE pets SET
         name = '${SNIFFED_OUT}', pet_username = NULL, type = NULL, gender = NULL, age = NULL,
         breed_type = NULL, breed_name = NULL, avatar_url = NULL, bio = NULL,
         vaccinated = 0, pet_kyc = 0, pawsitive_score = NULL,
         latitude = NULL, longitude = NULL, location_text = NULL,
         country = NULL, state = NULL, city = NULL, area = NULL,
         last_updated_location_timestamp = NULL, deleted_at = NOW()
       WHERE user_id = ?`,
      [userId]);
    await tx.run(
      `UPDATE users SET
         email = 'sniffedout~' || id, username = 'sniffedout~' || id,
         password_hash = '!deleted', full_name = '${SNIFFED_OUT}', auth_user_id = NULL,
         last_active_at = NULL, reset_token = NULL, reset_token_expires_at = NULL,
         email_verified = 0, email_verify_token = NULL, email_verify_expires_at = NULL,
         pawprint_2fa_enabled = 0, paw_code = NULL, paw_code_expires_at = NULL,
         pawprint_verify_token_hash = NULL, pawprint_verify_expires_at = NULL,
         super_sniff_enabled = 0,
         current_plan = 'free', plan_source = 'none', subscription_status = 'inactive',
         plan_start_date = NULL, plan_expiry_date = NULL, auto_renew = 0,
         premium_badge_enabled = 0, is_founding_member = 0,
         boost_credits_remaining = 0, boost_credits_refreshed_at = NULL,
         storage_used_bytes = 0, storage_quota_override_bytes = NULL,
         is_admin = FALSE, deleted_at = NOW()
       WHERE id = ? AND deleted_at IS NULL`,
      [userId]);

    // Member counts exclude tombstones (the frozen owner row included).
    const affectedCircleIds = [...ownedCircleIds, ...joinedCircleIds];
    if (has('communities') && has('community_members')) {
      await tx.run(
        `UPDATE communities c SET member_count = (
           SELECT COUNT(*) FROM community_members m JOIN users u ON u.id = m.user_id
           WHERE m.community_id = c.id AND u.deleted_at IS NULL)
         WHERE c.id = ANY(?::int[])`,
        [affectedCircleIds]);
    }

    // ── 10. Queue media that nothing surviving still points at ────────
    // Notifications copy media as their thumbnail -- e.g. a reply under one of
    // their posts notifies the other commenter with the POST's image
    // (posts.js). Those copies belong to content being deleted, so clear
    // them first; otherwise they'd keep the user's files alive forever. Real
    // reuse elsewhere (someone re-posting the same URL) still blocks the purge.
    if (has('notifications') && media.length) {
      await tx.run('UPDATE notifications SET avatar_url = NULL WHERE avatar_url = ANY(?::text[])', [media.flatMap(m => m.urls)]);
    }
    const pendingMediaCount = await queueMedia(tx, has, media, userId);

    if (_testFailAt === 'before_assertions') throw new Error('Injected test failure (before_assertions)');

    // ── 11. Assertions ────────────────────────────────────────────────
    await assertDeleted(tx, has, { userId, petIds, ownedCircleIds });

    return { petIds, ownedCircleIds, conversationIds, pendingMediaCount, authUserId, cancelledTransfers };
  });
}

// ── Media ───────────────────────────────────────────────────────────────

// Parses one of our Cloudinary delivery URLs into its public_id and type.
// Returns null for anything else (other hosts, other clouds, local paths).
export function parseCloudinaryUrl(url, cloudName = config.CLOUDINARY_CLOUD_NAME) {
  if (!cloudName || typeof url !== 'string') return null;
  const m = url.match(/^https?:\/\/res\.cloudinary\.com\/([^/]+)\/(image|video|raw)\/upload\/(?:v\d+\/)?([^?#]+)$/);
  if (!m || m[1] !== cloudName) return null;
  const resourceType = m[2];
  let path;
  try { path = decodeURIComponent(m[3]); } catch { return null; }
  // Image/video public ids exclude the file extension; raw ones include it.
  const publicId = resourceType === 'raw' ? path : path.replace(/\.[^./]+$/, '');
  return { publicId, resourceType };
}

const inFolder = (publicId, folder) => publicId.startsWith(`sniffr/${folder}/`);

async function collectMediaCandidates(tx, has, { userId, petIds, postIds }) {
  const found = new Map(); // `${resourceType}:${publicId}` -> candidate
  const add = (url, folder, source) => {
    const parsed = parseCloudinaryUrl(url);
    if (!parsed || !inFolder(parsed.publicId, folder)) return;
    const key = `${parsed.resourceType}:${parsed.publicId}`;
    if (!found.has(key)) found.set(key, { ...parsed, source, urls: [] });
    const candidate = found.get(key);
    if (!candidate.urls.includes(url)) candidate.urls.push(url); // exact URLs, to clear copies of them
  };
  const sources = [
    ['posts', 'posts', 'SELECT media_url AS url FROM posts WHERE id = ANY(?::int[])', [postIds]],
    ['pets', 'avatars', 'SELECT avatar_url AS url FROM pets WHERE id = ANY(?::int[])', [petIds]],
    ['messages', 'chat', 'SELECT media_url AS url FROM messages WHERE sender_id = ? AND message_type = ANY(?::text[])', [userId, MEDIA_MESSAGE_TYPES]],
    ['community_messages', 'community_media', 'SELECT media_url AS url FROM community_messages WHERE sender_id = ?', [userId]],
    ['community_photos', 'community_photos', 'SELECT media_url AS url FROM community_photos WHERE user_id = ?', [userId]],
  ];
  for (const [table, folder, sql, params] of sources) {
    if (!has(table)) continue;
    for (const row of await tx.all(sql, params)) add(row.url, folder, folder);
  }
  // media_files is incomplete, so it only adds to the per-table reads.
  if (has('media_files')) {
    const rows = await tx.all(
      "SELECT url FROM media_files WHERE user_id = ? AND (subdir IS NULL OR subdir <> 'payment_proofs')", [userId]);
    for (const row of rows) {
      const parsed = parseCloudinaryUrl(row.url);
      const folder = parsed && MEDIA_FOLDERS.find(f => inFolder(parsed.publicId, f));
      if (folder) add(row.url, folder, 'media_files');
    }
  }
  return [...found.values()];
}

// Which of these public_ids are still used by any row that survives
// (someone else's post, message, avatar, a payment proof...). Shared with the
// media purge's final tag sweep.
export async function findStillReferenced(q, publicIds, has = () => true) {
  if (!publicIds.length) return new Set();
  const refChecks = SURVIVING_MEDIA_REFERENCES
    .filter(([table]) => has(table))
    .map(([table, column]) => `EXISTS (SELECT 1 FROM ${table} WHERE position(pid IN ${column}) > 0)`);
  if (!refChecks.length) return new Set();
  const rows = await q.all(`SELECT pid FROM unnest(?::text[]) AS pid WHERE ${refChecks.join(' OR ')}`, [publicIds]);
  return new Set(rows.map(r => r.pid));
}

async function queueMedia(tx, has, candidates, userId) {
  if (!candidates.length || !has('pending_media_deletions')) return 0;
  const stillUsed = await findStillReferenced(tx, candidates.map(c => c.publicId), has);
  const queue = candidates.filter(c => !stillUsed.has(c.publicId));
  if (!queue.length) return 0;
  const result = await tx.run(
    `INSERT INTO pending_media_deletions (public_id, resource_type, source, deleted_user_id)
     SELECT * FROM unnest(?::text[], ?::text[], ?::text[], ?::int[])
     ON CONFLICT (public_id, resource_type) DO NOTHING`,
    [queue.map(c => c.publicId), queue.map(c => c.resourceType), queue.map(c => c.source), queue.map(() => userId)]
  );
  return result.rowCount;
}

// Queues the Cloudinary files behind these URLs (ours, in an owned-media
// folder) unless a surviving row still uses them -- same rules as the
// account deletion. Used when a whole frozen PawCircle is deleted; call it
// after the rows are gone, inside the same transaction.
export async function queueMediaUrls(tx, urls, deletedUserId) {
  const found = new Map();
  for (const url of urls) {
    const parsed = parseCloudinaryUrl(url);
    const folder = parsed && MEDIA_FOLDERS.find(f => inFolder(parsed.publicId, f));
    if (!folder) continue;
    const key = `${parsed.resourceType}:${parsed.publicId}`;
    if (!found.has(key)) found.set(key, { ...parsed, source: folder, urls: [] });
    found.get(key).urls.push(url);
  }
  return queueMedia(tx, () => true, [...found.values()], deletedUserId);
}

// ── Notifications from their pets to other people ──────────────────────

function wholeWord(text) {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'g');
}

async function rewriteNotificationsFromPets(tx, has, { userId, petIds, petNameById }) {
  const petSet = new Set(petIds);
  const likedPosts = has('likes')
    ? new Set((await tx.all('SELECT post_id FROM likes WHERE user_id = ?', [userId])).map(r => String(r.post_id))) : new Set();
  const commentedPosts = has('comments')
    ? new Set((await tx.all('SELECT post_id FROM comments WHERE user_id = ?', [userId])).map(r => String(r.post_id))) : new Set();

  const rows = await tx.all(
    `SELECT id, type, action_status, target_id, sender_pet_id, metadata_json, title, description
     FROM notifications
     WHERE user_id <> ?
       AND (sender_pet_id = ANY(?::int[])
            OR (type = 'lick' AND target_id = ANY(?::text[]))
            OR (type = 'comment' AND target_id = ANY(?::text[])))`,
    [userId, petIds, [...likedPosts], [...commentedPosts]]
  );

  for (const n of rows) {
    const fromTheirPet = n.sender_pet_id != null && petSet.has(n.sender_pet_id);
    let title = n.title;
    let description = n.description;
    let metadataJson = n.metadata_json;
    let changed = fromTheirPet;

    let meta = null;
    try { meta = n.metadata_json ? JSON.parse(n.metadata_json) : null; } catch { meta = null; }
    const grouped = (n.type === 'lick' || n.type === 'comment') && Array.isArray(meta?.names);

    if (grouped) {
      // By pet id where stored; for older rows (no pet id) only by name, and
      // only when they really liked/commented on that post.
      const actedOnTarget = n.type === 'lick' ? likedPosts.has(n.target_id) : commentedPosts.has(n.target_id);
      const petNames = new Set(petNameById.values());
      const petIdsMeta = Array.isArray(meta.pet_ids) ? meta.pet_ids : [];
      const names = meta.names.map((name, i) => {
        const pid = petIdsMeta[i] ?? null;
        const theirs = pid != null ? petSet.has(pid) : (actedOnTarget && petNames.has(name));
        return theirs ? SNIFFED_OUT : name;
      });
      if (names.some((name, i) => name !== meta.names[i])) {
        changed = true;
        const oldTitle = title;
        title = buildGroupedActivityTitle(n.type, names);
        if (description === oldTitle) {
          description = title;
        } else if (description) {
          // Single-actor rows keep a detail line such as `Rex commented: "..."`.
          for (const replaced of new Set(meta.names.filter((name, i) => names[i] !== name))) {
            description = description.replace(wholeWord(replaced), SNIFFED_OUT);
          }
        }
        metadataJson = JSON.stringify({ ...meta, names });
      } else if (fromTheirPet) {
        // Their pet sent it but couldn't be matched in the name list (e.g.
        // an old row after an unlike): fall back to the sender's name.
        const name = petNameById.get(n.sender_pet_id);
        if (name && name !== SNIFFED_OUT) {
          if (title) title = title.replace(wholeWord(name), SNIFFED_OUT);
          if (description) description = description.replace(wholeWord(name), SNIFFED_OUT);
        }
      }
    } else if (fromTheirPet) {
      const name = petNameById.get(n.sender_pet_id);
      if (name && name !== SNIFFED_OUT) {
        if (title) title = title.replace(wholeWord(name), SNIFFED_OUT);
        if (description) description = description.replace(wholeWord(name), SNIFFED_OUT);
      }
    }
    if (!changed) continue;

    const expire = fromTheirPet && n.type === 'match_request' && n.action_status === 'pending';
    await tx.run(
      `UPDATE notifications SET title = ?, description = ?, metadata_json = ?,
         avatar_url = CASE WHEN ?::boolean THEN NULL ELSE avatar_url END,
         action_status = CASE WHEN ?::boolean THEN 'expired' ELSE action_status END
       WHERE id = ?`,
      [title, description, metadataJson, fromTheirPet, expire, n.id]
    );
  }
}

// ── @mentions ───────────────────────────────────────────────────────────

const MENTION_COLUMNS = [
  ['posts', 'caption'], ['comments', 'content'], ['messages', 'content'],
  ['community_messages', 'content'], ['community_announcements', 'title'], ['community_announcements', 'content'],
];

async function rewriteMentions(tx, has, handles) {
  for (const handle of handles) {
    // Handles are [A-Za-z0-9_] only (checked by the caller), so they're safe
    // inside the pattern. The pattern is passed as a parameter: the query
    // adapter turns every literal "?" in SQL into a placeholder.
    const pattern = `@${handle}(?![A-Za-z0-9_])`;
    for (const [table, column] of MENTION_COLUMNS) {
      if (!has(table)) continue;
      await tx.run(
        `UPDATE ${table} SET ${column} = regexp_replace(${column}, ?, '@${SNIFFED_OUT}', 'gi') WHERE ${column} ~* ?`,
        [pattern, pattern]
      );
    }
  }
}

// ── Assertions ──────────────────────────────────────────────────────────

async function assertDeleted(tx, has, { userId, petIds, ownedCircleIds }) {
  const fail = message => { throw new AccountDeletionError('ASSERTION_FAILED', message); };
  const count = async (sql, params) => (await tx.get(sql, params)).n;

  const u = await tx.get('SELECT * FROM users WHERE id = ?', [userId]);
  const placeholder = `sniffedout~${userId}`;
  if (!u?.deleted_at || u.email !== placeholder || u.username !== placeholder || u.password_hash !== '!deleted'
    || u.auth_user_id !== null || u.is_admin) {
    fail('user row was not fully scrubbed');
  }
  if (await count('SELECT count(*)::int AS n FROM pets WHERE user_id = ? AND deleted_at IS NULL', [userId])) fail('live pets remain');

  const zero = [
    ['posts', 'SELECT count(*)::int AS n FROM posts WHERE pet_id = ANY(?::int[])', [petIds]],
    ['notifications', 'SELECT count(*)::int AS n FROM notifications WHERE user_id = ?', [userId]],
    ['notifications', 'SELECT count(*)::int AS n FROM notifications WHERE sender_pet_id = ANY(?::int[]) AND avatar_url IS NOT NULL', [petIds]],
    ['shares', 'SELECT count(*)::int AS n FROM shares WHERE user_id = ?', [userId]],
    ['swipes', 'SELECT count(*)::int AS n FROM swipes WHERE from_pet_id = ANY(?::int[]) OR to_pet_id = ANY(?::int[])', [petIds, petIds]],
    ['profile_views', 'SELECT count(*)::int AS n FROM profile_views WHERE viewer_pet_id = ANY(?::int[]) OR viewed_pet_id = ANY(?::int[])', [petIds, petIds]],
    ['spotlight_rank_tracking', 'SELECT count(*)::int AS n FROM spotlight_rank_tracking WHERE pet_id = ANY(?::int[])', [petIds]],
    ['blocked_users', 'SELECT count(*)::int AS n FROM blocked_users WHERE blocker_id = ? OR blocked_id = ?', [userId, userId]],
    ['trusted_devices', 'SELECT count(*)::int AS n FROM trusted_devices WHERE user_id = ?', [userId]],
    ['refresh_tokens', 'SELECT count(*)::int AS n FROM refresh_tokens WHERE user_id = ?', [userId]],
    ['notification_preferences', 'SELECT count(*)::int AS n FROM notification_preferences WHERE user_id = ?', [userId]],
    ['app_ratings', 'SELECT count(*)::int AS n FROM app_ratings WHERE user_id = ?', [userId]],
    ['verification_codes', 'SELECT count(*)::int AS n FROM verification_codes WHERE user_id = ?', [userId]],
    ['messages', 'SELECT count(*)::int AS n FROM messages WHERE sender_id = ? AND message_type = ANY(?::text[]) AND media_url IS NOT NULL', [userId, MEDIA_MESSAGE_TYPES]],
    ['community_messages', 'SELECT count(*)::int AS n FROM community_messages WHERE sender_id = ? AND media_url IS NOT NULL', [userId]],
    ['community_photos', 'SELECT count(*)::int AS n FROM community_photos WHERE user_id = ?', [userId]],
    ['community_join_requests', 'SELECT count(*)::int AS n FROM community_join_requests WHERE user_id = ?', [userId]],
    ['community_members', 'SELECT count(*)::int AS n FROM community_members WHERE user_id = ? AND NOT (community_id = ANY(?::int[]))', [userId, ownedCircleIds]],
    ['communities', "SELECT count(*)::int AS n FROM communities WHERE id = ANY(?::int[]) AND status <> 'frozen'", [ownedCircleIds]],
    ['payment_sessions', "SELECT count(*)::int AS n FROM payment_sessions WHERE user_id = ? AND status = 'pending'", [userId]],
  ];
  for (const [table, sql, params] of zero) {
    if (has(table) && await count(sql, params)) fail(`${table}: rows remain that should have been removed or changed`);
  }
}
