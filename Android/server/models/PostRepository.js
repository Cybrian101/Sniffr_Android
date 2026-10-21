import BaseRepository from './BaseRepository.js';
import db, { withTransaction } from '../db/connection.js';

// A comment identical to one the same user just posted on the same post
// (double tap, flaky network retry) returns that comment instead of a copy.
export const COMMENT_DEDUPE_SECONDS = 10;
// M18: how many distinct reports queue a post for review (moderation_status),
// without auto-hiding it (see reportPost below).
const REPORT_REVIEW_THRESHOLD = 5;
import { hasCurrentAccess } from '../services/subscriptionService.js';
import { sqlUsername, sqlFullName, sqlPetName, sqlHidden, sqlGone } from '../utils/sniffedOut.js';
import { notBlockedSql, blockParams } from '../services/blocks.js';
import { queueMediaUrls } from '../services/accountDeletion.js';

// Comment author (users `u`): a SniffedOut author's comment stays, shown as
// "SniffedOut" with no avatar.
const COMMENT_AUTHOR_COLUMNS = `
  ${sqlUsername('u')} AS username, ${sqlFullName('u')} AS full_name, ${sqlGone('u')} AS sniffed_out,
  ${sqlHidden(`COALESCE((SELECT avatar_url FROM pets WHERE id = u.active_pet_id), (SELECT avatar_url FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))`, 'u')} as avatar_url`;

function attachPostPremium(post) {
  post.is_premium = !post.sniffed_out && !!(hasCurrentAccess({
    subscription_status: post.owner_subscription_status,
    plan_expiry_date: post.owner_plan_expiry_date,
  }) && post.owner_premium_badge_enabled);
  return post;
}

class PostRepository extends BaseRepository {
  constructor() { super('posts'); }

  async getFeed(page = 1, limit = 10, userId = null) {
    const offset = (page - 1) * limit;
    // Over-fetch by one row to detect "is there a next page" instead of a
    // separate SELECT COUNT(*) FROM posts -- at scale that count is a full
    // table scan repeated on every single page request (10x more query work
    // than the actual feed page itself), and the value was never even
    // consumed by any caller (frontend never reads `total`). Fetching
    // limit+1 costs nothing extra over the existing query plan and slicing
    // the spare row off before returning gives the same hasMore signal.
    //
    // is_liked is cast to ::int (like every other COUNT(*) here) -- without
    // it, Postgres returns a BIGINT, which the pg driver hands back as a
    // STRING ("0"/"1") to avoid precision loss. "0" is truthy in JS, so
    // every post rendered as already-liked and toggling it decremented the
    // count instead of incrementing -- this was the actual bug, not a
    // frontend issue. userId is now a bound parameter instead of being
    // string-interpolated into the query text.
    const isLikedClause = userId
      ? `(SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?)::int as is_liked,`
      : '0 as is_liked,';
    // Never posts of someone in a blocked pair with the viewer (services/blocks.js).
    const blockClause = userId ? `AND ${notBlockedSql('u.id')}` : '';
    const params = userId ? [userId, ...blockParams(userId), limit + 1, offset] : [limit + 1, offset];
    const rows = await db.all(`
      SELECT p.*, pet.name as pet_name, pet.pet_username, pet.avatar_url as pet_avatar,
        pet.breed_name, pet.age as pet_age, pet.location_text, pet.type as pet_type, pet.id as author_pet_id, pet.user_id as owner_user_id,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id)::int as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id)::int as comment_count,
        (SELECT COUNT(*) FROM shares WHERE post_id = p.id)::int as share_count,
        (
          SELECT COALESCE(json_object_agg(r.reaction, r.cnt), '{}'::json)
          FROM (
            SELECT reaction, COUNT(*)::int as cnt
            FROM reactions
            WHERE post_id = p.id
            GROUP BY reaction
          ) r
        ) as reactions,
        ${isLikedClause}
        u.username as owner_username, u.subscription_status as owner_subscription_status,
        u.premium_badge_enabled as owner_premium_badge_enabled, u.plan_expiry_date as owner_plan_expiry_date
      FROM posts p
      JOIN pets pet ON p.pet_id = pet.id
      JOIN users u ON pet.user_id = u.id
      WHERE p.is_flagged = 0
        AND pet.deleted_at IS NULL AND u.deleted_at IS NULL
        ${blockClause}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `, params);
    const hasMore = rows.length > limit;
    const posts = hasMore ? rows.slice(0, limit) : rows;
    posts.forEach(attachPostPremium);
    return { posts, hasMore };
  }

  // Single post view (e.g. a shared post card). A SniffedOut author shows as
  // "SniffedOut" with no avatar or profile details.
  async findById(postId, userId = null) {
    const isLikedClause = userId
      ? `(SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?)::int as is_liked,`
      : '0 as is_liked,';
    const params = userId ? [userId, postId] : [postId];
    const post = await db.get(`
      SELECT p.*, ${sqlPetName('pet', 'u')} as pet_name, ${sqlHidden('pet.pet_username', 'pet', 'u')} as pet_username,
        ${sqlHidden('pet.avatar_url', 'pet', 'u')} as pet_avatar, ${sqlHidden('pet.breed_name', 'pet', 'u')} as breed_name,
        ${sqlHidden('pet.age', 'pet', 'u')} as pet_age, ${sqlHidden('pet.location_text', 'pet', 'u')} as location_text,
        pet.type as pet_type, pet.id as author_pet_id, ${sqlGone('pet', 'u')} as sniffed_out,
        pet.user_id as owner_user_id,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id)::int as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id)::int as comment_count,
        (SELECT COUNT(*) FROM shares WHERE post_id = p.id)::int as share_count,
        (
          SELECT COALESCE(json_object_agg(r.reaction, r.cnt), '{}'::json)
          FROM (
            SELECT reaction, COUNT(*)::int as cnt
            FROM reactions
            WHERE post_id = p.id
            GROUP BY reaction
          ) r
        ) as reactions,
        ${isLikedClause}
        ${sqlUsername('u')} as owner_username, u.subscription_status as owner_subscription_status,
        u.premium_badge_enabled as owner_premium_badge_enabled, u.plan_expiry_date as owner_plan_expiry_date
      FROM posts p
      JOIN pets pet ON p.pet_id = pet.id
      JOIN users u ON pet.user_id = u.id
      WHERE p.id = ?
    `, params);
    return post ? attachPostPremium(post) : post;
  }

  async getNewPosts(afterTimestamp, userId = null) {
    const isLikedClause = userId
      ? `(SELECT COUNT(*) FROM likes WHERE post_id = p.id AND user_id = ?)::int as is_liked,`
      : '0 as is_liked,';
    const blockClause = userId ? `AND ${notBlockedSql('u.id')}` : '';
    const params = userId ? [userId, afterTimestamp, ...blockParams(userId)] : [afterTimestamp];
    const posts = await db.all(`
      SELECT p.*, pet.name as pet_name, pet.pet_username, pet.avatar_url as pet_avatar,
        pet.breed_name, pet.age as pet_age, pet.location_text, pet.type as pet_type, pet.id as author_pet_id, pet.user_id as owner_user_id,
        (SELECT COUNT(*) FROM likes WHERE post_id = p.id)::int as like_count,
        (SELECT COUNT(*) FROM comments WHERE post_id = p.id)::int as comment_count,
        (SELECT COUNT(*) FROM shares WHERE post_id = p.id)::int as share_count,
        (
          SELECT COALESCE(json_object_agg(r.reaction, r.cnt), '{}'::json)
          FROM (
            SELECT reaction, COUNT(*)::int as cnt
            FROM reactions
            WHERE post_id = p.id
            GROUP BY reaction
          ) r
        ) as reactions,
        ${isLikedClause}
        u.username as owner_username, u.subscription_status as owner_subscription_status,
        u.premium_badge_enabled as owner_premium_badge_enabled, u.plan_expiry_date as owner_plan_expiry_date
      FROM posts p
      JOIN pets pet ON p.pet_id = pet.id
      JOIN users u ON pet.user_id = u.id
      WHERE p.is_flagged = 0 AND p.created_at > ?
        AND pet.deleted_at IS NULL AND u.deleted_at IS NULL
        ${blockClause}
      ORDER BY p.created_at DESC
    `, params);
    posts.forEach(attachPostPremium);
    return { posts };
  }

  async getByPetId(petId, page = 1, limit = 20) {
    const offset = (page - 1) * limit;
    return db.all(`
      SELECT p.*,
      (SELECT COUNT(*) FROM likes WHERE post_id = p.id)::int as like_count,
      (SELECT COUNT(*) FROM comments WHERE post_id = p.id)::int as comment_count,
      (SELECT COUNT(*) FROM shares WHERE post_id = p.id)::int as share_count
      FROM posts p WHERE p.pet_id = ? AND p.is_flagged = 0 ORDER BY p.created_at DESC LIMIT ? OFFSET ?
    `, [petId, limit, offset]);
  }

  // Single atomic statement instead of a SELECT-then-INSERT/DELETE: two
  // near-simultaneous toggles for the same (post, user) -- e.g. a
  // double-tap gesture racing a button click, a flaky network retry, the
  // same account open in two tabs -- used to be able to interleave (both
  // read "not liked", both branch the same way) and leave the row in the
  // wrong final state. Deleting first and only inserting when nothing was
  // deleted keeps the whole toggle inside one statement, so Postgres
  // serializes concurrent callers on the same row via the unique index
  // instead of leaving a gap between the check and the write.
  async toggleLike(postId, userId) {
    const row = await db.get(
      `WITH deleted AS (
         DELETE FROM likes WHERE post_id = ? AND user_id = ? RETURNING 1
       ), inserted AS (
         INSERT INTO likes (post_id, user_id)
         SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM deleted)
         RETURNING 1
       )
       SELECT EXISTS(SELECT 1 FROM inserted) AS liked`,
      [postId, userId, postId, userId]
    );
    return { liked: !!row.liked };
  }

  async getLikeCount(postId) {
    const row = await db.get('SELECT COUNT(*) as count FROM likes WHERE post_id = ?', [postId]);
    return Number(row.count);
  }

  // Returns a flat list (top-level comments and replies interleaved by
  // created_at) rather than a nested tree. Each row's `parent_comment_id`
  // is enough for the client to group replies under their parent -- this
  // matches how the rest of the repo works (flat rows + simple JOINs,
  // no server-built nested structures) and keeps pagination trivial since
  // replies are just more rows, not a second query per parent.
  // M7: fetches one extra row beyond `limit` so the caller can tell whether
  // a next page exists (hasMore) without a separate COUNT query -- the
  // extra row itself is trimmed off before returning.
  async getComments(postId, page = 1, limit = 20, viewerId = null) {
    const offset = (page - 1) * limit;
    // Hide comments by anyone in a blocked pair with the viewer.
    const blockClause = viewerId ? `AND ${notBlockedSql('c.user_id')}` : '';
    const rows = await db.all(`
      SELECT c.*, ${COMMENT_AUTHOR_COLUMNS}, u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date
      FROM comments c JOIN users u ON c.user_id = u.id
      WHERE c.post_id = ? ${blockClause} ORDER BY c.created_at ASC LIMIT ? OFFSET ?
    `, viewerId ? [postId, ...blockParams(viewerId), limit + 1, offset] : [postId, limit + 1, offset]);
    const hasMore = rows.length > limit;
    const comments = hasMore ? rows.slice(0, limit) : rows;
    comments.forEach(c => { c.is_premium = !c.sniffed_out && !!(hasCurrentAccess(c) && c.premium_badge_enabled); });
    return { comments, hasMore };
  }

  // Returns { comment, duplicate }. A per-(user, post) transaction lock makes
  // the duplicate check race-free: two identical requests arriving together
  // still create one comment.
  async addComment(postId, userId, content, parentCommentId = null) {
    // Threads are flattened to one level (like Instagram): replying to a
    // reply still attaches to that reply's top-level ancestor, so a
    // thread never nests more than one level deep. The client already
    // does this when it sends parentCommentId, but resolve it here too
    // so the invariant holds even if a client ever sends a reply's id.
    // M17: must belong to the SAME post -- without this check, a client
    // could pass any comment id at all (including one on a totally
    // different post) and have the reply silently attach there instead,
    // since nothing downstream re-validates post_id once resolvedParentId
    // is set.
    let resolvedParentId = parentCommentId;
    if (resolvedParentId) {
      const parent = await db.get('SELECT id, post_id, parent_comment_id FROM comments WHERE id = ? AND post_id = ?', [resolvedParentId, postId]);
      if (!parent) {
        resolvedParentId = null;
      } else if (parent.parent_comment_id) {
        resolvedParentId = parent.parent_comment_id;
      }
    }

    // The window is measured on the database clock only: created_at is set by
    // the database (DEFAULT CURRENT_TIMESTAMP) and compared with
    // clock_timestamp() -- not NOW(), which is this transaction's start and
    // would stretch the window by however long the lock wait took.
    const { id, duplicate } = await withTransaction(async tx => {
      await tx.get('SELECT pg_advisory_xact_lock(?::int, ?::int)', [userId, postId]);
      const recent = await tx.get(
        `SELECT id FROM comments
         WHERE post_id = ? AND user_id = ? AND content = ? AND parent_comment_id IS NOT DISTINCT FROM ?::int
           AND created_at > clock_timestamp() - make_interval(secs => ?)
         ORDER BY id DESC LIMIT 1`,
        [postId, userId, content, resolvedParentId, COMMENT_DEDUPE_SECONDS]);
      if (recent) return { id: recent.id, duplicate: true };
      const result = await tx.run(
        'INSERT INTO comments (post_id, user_id, content, parent_comment_id) VALUES (?, ?, ?, ?) RETURNING id',
        [postId, userId, content, resolvedParentId]
      );
      return { id: result.rows[0].id, duplicate: false };
    });
    const comment = await db.get(
      `SELECT c.*, ${COMMENT_AUTHOR_COLUMNS}, u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date
       FROM comments c JOIN users u ON c.user_id = u.id WHERE c.id = ?`,
      [id]
    );
    comment.is_premium = !comment.sniffed_out && !!(hasCurrentAccess(comment) && comment.premium_badge_enabled);
    return { comment, duplicate };
  }

  async sharePost(postId, userId) {
    await db.run('INSERT INTO shares (post_id, user_id) VALUES (?, ?)', [postId, userId]);
    const row = await db.get('SELECT COUNT(*) as count FROM shares WHERE post_id = ?', [postId]);
    return Number(row.count);
  }

  // M18/L5:
  //  - Self-reporting is blocked -- the post's own owner can't report it.
  //  - The old check-then-insert (SELECT, then INSERT if nothing found) let
  //    two concurrent requests from the same user both pass the check and
  //    both insert, double-counting one person's report. Now one atomic
  //    `INSERT ... ON CONFLICT DO NOTHING` (backed by the new
  //    post_reports(post_id, user_id) unique constraint -- see
  //    db/sql/2026-10-10_post_reports_unique.sql); the counter only
  //    increments when a row was actually, newly inserted.
  //  - Reaching the threshold no longer auto-hides the post from feeds
  //    (is_flagged stays 0) -- it only marks moderation_status so it's
  //    queued for a human review instead of unilaterally disappearing.
  async reportPost(postId, userId, reason) {
    const post = await db.get('SELECT pet_id FROM posts WHERE id = ?', [postId]);
    if (!post) return { success: false, reason: 'POST_NOT_FOUND' };
    const pet = await db.get('SELECT user_id FROM pets WHERE id = ?', [post.pet_id]);
    if (pet && pet.user_id === userId) return { success: false, reason: 'CANNOT_REPORT_OWN_POST' };

    const inserted = await db.get(
      'INSERT INTO post_reports (post_id, user_id, reason) VALUES (?, ?, ?) ON CONFLICT (post_id, user_id) DO NOTHING RETURNING id',
      [postId, userId, reason]
    );
    if (inserted) {
      const row = await db.get(
        'UPDATE posts SET reported_count = reported_count + 1 WHERE id = ? RETURNING reported_count',
        [postId]
      );
      if (row.reported_count >= REPORT_REVIEW_THRESHOLD && row.reported_count - 1 < REPORT_REVIEW_THRESHOLD) {
        await db.run("UPDATE posts SET moderation_status = 'pending_review' WHERE id = ?", [postId]);
      }
    }
    return { success: true, alreadyReported: !inserted };
  }

  async toggleReaction(postId, userId, reaction) {
    const existing = await db.get('SELECT id, reaction FROM reactions WHERE post_id = ? AND user_id = ?', [postId, userId]);
    if (existing) {
      if (existing.reaction === reaction) {
        await db.run('DELETE FROM reactions WHERE post_id = ? AND user_id = ?', [postId, userId]);
        return { removed: true, reaction };
      } else {
        await db.run('UPDATE reactions SET reaction = ? WHERE post_id = ? AND user_id = ?', [reaction, postId, userId]);
        return { updated: true, reaction };
      }
    }
    await db.run('INSERT INTO reactions (post_id, user_id, reaction) VALUES (?, ?, ?)', [postId, userId, reaction]);
    return { added: true, reaction };
  }

  async getReactionCounts(postId) {
    return db.all('SELECT reaction, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY reaction', [postId]);
  }

  async getPostReactions(postId) {
    const rows = await db.all('SELECT reaction, COUNT(*) as count FROM reactions WHERE post_id = ? GROUP BY reaction', [postId]);
    const result = {};
    rows.forEach(r => { result[r.reaction] = Number(r.count); });
    return result;
  }

  async getUserReaction(postId, userId) {
    const row = await db.get('SELECT reaction FROM reactions WHERE post_id = ? AND user_id = ?', [postId, userId]);
    return row ? row.reaction : null;
  }

  // M16: `reactions` is keyed per account (user_id), one row per reacting
  // user -- the old plain `JOIN pets p ON r.user_id = p.user_id` fanned that
  // out to one row per PET a multi-pet user owns, so the same person showed
  // up repeatedly in the list. LEFT JOIN LATERAL picks exactly one pet per
  // user (their active one if it's really theirs, else their earliest), same
  // "one representative pet per account" idea COMMENT_AUTHOR_COLUMNS already
  // uses via a COALESCE subquery -- this needs the row itself (for
  // sqlPetName/sqlHidden's p.* references), so a lateral join instead.
  async getReactionUsers(postId, viewerId = null) {
    const blockClause = viewerId ? `AND ${notBlockedSql('r.user_id')}` : '';
    return db.all(`
      SELECT r.reaction, r.user_id, ${sqlPetName('p', 'u')} as pet_name, ${sqlHidden('p.avatar_url', 'p', 'u')} as pet_avatar,
        ${sqlHidden('p.pet_username', 'p', 'u')} as pet_username, ${sqlGone('p', 'u')} as sniffed_out
      FROM reactions r
      LEFT JOIN users u ON u.id = r.user_id
      LEFT JOIN LATERAL (
        SELECT * FROM pets WHERE user_id = r.user_id
        ORDER BY (id = u.active_pet_id) DESC, id ASC
        LIMIT 1
      ) p ON true
      WHERE r.post_id = ? ${blockClause}
    `, viewerId ? [postId, ...blockParams(viewerId)] : [postId]);
  }

  // Update a post's caption. Ownership is verified by the calling route
  // BEFORE this is called -- this method itself just performs the update.
  async updateCaption(postId, caption) {
    await db.run('UPDATE posts SET caption = ? WHERE id = ?', [caption, postId]);
    return this.findById(postId);
  }

  // M8: deleting a post used to just drop the row -- its Cloudinary file
  // stayed stored (and the owner's storage_used_bytes stayed consumed)
  // forever. Now mirrors the exact pattern already used for frozen-circle
  // deletion (services/frozenCircles.js's deleteCircle): inside one
  // transaction, delete the row, then queue the media URL via the same
  // services/accountDeletion.js helper (queueMediaUrls) that skips the
  // queue entirely if any other surviving row -- another post, a message, a
  // pet avatar, etc. -- still points at the same file (SURVIVING_MEDIA_REFERENCES
  // already includes 'posts'). The actual Cloudinary destroy + quota
  // release happens on the existing hourly purge job (services/mediaPurge.js),
  // same as every other queued deletion in this codebase -- not a new,
  // separate "delete now" path.
  async deletePost(postId, userId) {
    return withTransaction(async tx => {
      const post = await tx.get('SELECT * FROM posts WHERE id = ?', [postId]);
      if (!post) return null;

      const pet = await tx.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [post.pet_id, userId]);
      if (!pet) return { forbidden: true };

      // likes/comments/reactions/shares/post_reports all have
      // ON DELETE CASCADE on post_id -- deleting the post row alone removes
      // all of them atomically in one statement.
      await tx.run('DELETE FROM posts WHERE id = ?', [postId]);

      if (post.media_url) await queueMediaUrls(tx, [post.media_url], userId);

      return { success: true, pet_id: post.pet_id };
    });
  }

  async deleteComment(commentId, userId) {
    const comment = await db.get('SELECT * FROM comments WHERE id = ?', [commentId]);
    if (!comment) return null;
    if (comment.user_id !== userId) return { forbidden: true };

    // No FK cascade exists on parent_comment_id (see migrations.js) -- a
    // deleted top-level comment must take its own replies with it, or
    // they'd linger in the table pointing at a parent that no longer
    // exists (invisible to the client, but permanently orphaned in the DB).
    await db.run('DELETE FROM comments WHERE parent_comment_id = ?', [commentId]);
    await db.run('DELETE FROM comments WHERE id = ?', [commentId]);

    return { success: true, post_id: comment.post_id, parent_comment_id: comment.parent_comment_id };
  }
}

export default new PostRepository();