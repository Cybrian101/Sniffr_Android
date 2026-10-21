import { Router } from 'express';
import multer from 'multer';
import { authenticateAccess } from '../middleware/auth.js';
import { rateLimiter } from '../middleware/rateLimiter.js';
import PostRepo from '../models/PostRepository.js';
import PetRepo from '../models/PetRepository.js';
import { uploadWithQuota } from '../services/mediaService.js';
import config from '../config.js';
import db from '../db/connection.js';
import { sendRealtimeNotification } from '../socket/notifications.js';
import { checkSpotlightAchievementsForPet } from '../services/spotlightAchievements.js';
import { sendServerError } from '../utils/errors.js';
import { requirePet } from '../middleware/requirePet.js';
import { isPostAuthorSniffedOut, SNIFFED_OUT_BODY } from '../utils/sniffedOut.js';
import { toPublicPet } from '../utils/publicPet.js';
import { isBlockedPair, blockedPairRooms, BLOCKED_BODY } from '../services/blocks.js';

// Liking, commenting on, reacting to, sharing or reporting a post whose
// author has been SniffedOut is refused. (A real deletion removes their
// posts anyway; this covers anything still in flight.)
async function refuseSniffedOutAuthor(req, res, next) {
  try {
    const postId = parseInt(req.params.id, 10);
    if (!isNaN(postId) && await isPostAuthorSniffedOut(postId)) return res.status(403).json(SNIFFED_OUT_BODY);
  } catch (err) {
    return sendServerError(res, err);
  }
  next();
}

// Viewing, liking, reacting to, commenting on or sharing a post whose author
// is in a blocked pair with you is refused (services/blocks.js).
async function refuseBlockedAuthor(req, res, next) {
  try {
    const postId = parseInt(req.params.id, 10);
    if (!isNaN(postId)) {
      const owner = await db.get('SELECT pet.user_id FROM posts p JOIN pets pet ON p.pet_id = pet.id WHERE p.id = ?', [postId]);
      if (owner && await isBlockedPair(req.user.id, owner.user_id)) return res.status(403).json(BLOCKED_BODY);
    }
  } catch (err) {
    return sendServerError(res, err);
  }
  next();
}

const router = Router();
router.use(authenticateAccess);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // M9: see routes/profile.js's identical comment -- a bare `cb(null,
    // false)` makes multer silently drop the file (no error), which used to
    // mean an unsupported upload (e.g. HEIC/HEIF) either silently produced
    // a post with no media at all, or hit the new MEDIA_REQUIRED check
    // below with a confusing message that didn't say WHY the file didn't
    // attach. receiveMedia below turns this into one clear 400.
    const allowed = [...config.ALLOWED_IMAGE_TYPES, ...config.ALLOWED_VIDEO_TYPES];
    if (allowed.includes(file.mimetype)) return cb(null, true);
    req.mediaTypeRejected = true;
    cb(null, false);
  }
});

// Wraps upload.single('media'): see routes/profile.js's receiveAvatar.
function receiveMedia(req, res, next) {
  upload.single('media')(req, res, err => {
    if (err?.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'FILE_TOO_LARGE', message: `The file must be ${Math.round(config.MAX_FILE_SIZE / (1024 * 1024))} MB or smaller.` });
    }
    if (err) return next(err);
    if (req.mediaTypeRejected) {
      return res.status(400).json({ error: 'INVALID_FILE_TYPE', message: 'Posts support JPG, PNG, WEBP, GIF photos or MP4/WEBM videos. HEIC/HEIF photos are not supported yet -- please convert or pick a different photo.' });
    }
    next();
  });
}

// ── Helper: parse @mentions out of any text (caption OR comment) and
// notify each mentioned pet's owner (skipping the author themselves).
// Reused by both post creation and comment creation below, so mentioning
// someone works the same way no matter where you do it.
async function notifyMentionedPets({ text, authorPet, targetId, io, sourceLabel }) {
  if (!text || !io) return;
  const usernames = [...new Set((text.match(/@([a-zA-Z0-9_]+)/g) || []).map(m => m.slice(1).toLowerCase()))];
  if (usernames.length === 0) return;

  for (const uname of usernames) {
    try {
      const mentionedPet = await db.get(
        // Live pets only: a deleted pet can't be mentioned, and a pet that
        // later takes a freed handle never inherits the old owner's mentions.
        "SELECT * FROM pets WHERE LOWER(REPLACE(pet_username, '@', '')) = ? AND deleted_at IS NULL",
        [uname]
      );
      if (!mentionedPet) continue;
      if (mentionedPet.user_id === authorPet.user_id) continue; // never notify yourself
      // A blocked pair can't mention each other: no notification (and the
      // mentioned user never sees the author's posts or comments anyway).
      if (await isBlockedPair(authorPet.user_id, mentionedPet.user_id)) continue;

      await sendRealtimeNotification(io, mentionedPet.user_id, {
        category: 'activity',
        type: 'mention',
        title: `${authorPet.name} tagged you in a ${sourceLabel} 🐾`,
        description: `${authorPet.name} mentioned you: "${text.length > 80 ? text.slice(0, 80) + '...' : text}"`,
        avatarUrl: authorPet.avatar_url || null,
        targetId: String(targetId),
        senderPetId: authorPet.id,
      });
    } catch (err) {
      console.error(`[notifyMentionedPets] Failed to notify @${uname}:`, err.message);
    }
  }
}

router.get('/', rateLimiter(config.RATE_LIMIT.GET), async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);
    const result = await PostRepo.getFeed(page, limit, req.user.id);
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
});

const incrementalHandler = async (req, res) => {
  try {
    const after = req.body.after || req.query.after;
    if (!after) return res.status(400).json({ error: 'MISSING_AFTER_TIMESTAMP' });
    const result = await PostRepo.getNewPosts(after, req.user.id);
    res.json(result);
  } catch (err) {
    sendServerError(res, err);
  }
};

// M2: HomePage.jsx's pull-to-refresh calls this with GET (it's a read, and
// the `after` timestamp fits fine in a query string) -- only POST was ever
// registered, so every pull-to-refresh hit a 500 (no matching route) and
// could leave the feed's "newest seen" cursor stuck, skipping content on
// the next real refresh. POST is kept too: testDiscoveryFilters.js and any
// other caller already using it via POST keep working unchanged.
router.get('/incremental', rateLimiter(config.RATE_LIMIT.GET), incrementalHandler);
router.get('/:id/incremental', rateLimiter(config.RATE_LIMIT.GET), incrementalHandler);
router.post('/incremental', rateLimiter(config.RATE_LIMIT.GET), incrementalHandler);
router.post('/:id/incremental', rateLimiter(config.RATE_LIMIT.GET), incrementalHandler);

router.post('/', requirePet, rateLimiter(config.RATE_LIMIT.POST), receiveMedia, async (req, res) => {
  try {
    const pet = req.pet; // requirePet

    // M9: every post is meant to carry a photo/video -- CreatePostModal.jsx
    // already refuses to submit without one, but nothing server-side
    // enforced the same rule, so a direct API call (or a future client bug)
    // could create a caption-only post the UI never intended to allow.
    if (!req.file) {
      return res.status(400).json({ error: 'MEDIA_REQUIRED', message: 'A photo or video is required to create a post.' });
    }

    let mediaUrl = null;
    let mediaType = 'image';
    if (req.file) {
      const uploaded = await uploadWithQuota(req.user.id, req.file, 'posts');
      mediaUrl = uploaded.url;
      mediaType = req.file.mimetype.startsWith('video') ? 'video' : 'image';
    }

    const caption = req.body.caption || '';
    const post = await PostRepo.create({
      pet_id: pet.id, caption, media_url: mediaUrl, media_type: mediaType
    });

    const postWithAuthor = {
      ...post,
      pet_name: pet.name,
      pet_username: pet.pet_username,
      pet_avatar: pet.avatar_url,
      breed_name: pet.breed_name,
      location_text: pet.location_text,
      pet_type: pet.type,
      author_pet_id: pet.id,
      owner_user_id: pet.user_id,
      like_count: 0,
      comment_count: 0,
      share_count: 0,
      is_liked: 0,
      is_premium: pet.is_premium
    };

    const io = req.app.get('io');
    if (io) {
      // Not to people in a blocked pair with the author.
      io.except(await blockedPairRooms(req.user.id)).emit('new_post', postWithAuthor);
      const updatedPet = await PetRepo.findById(pet.id);
      io.emit('profile_updated', { pet_id: pet.id, pet: toPublicPet(updatedPet) }); // to everyone: no coordinates

      await notifyMentionedPets({ text: caption, authorPet: pet, targetId: post.id, io, sourceLabel: 'post' });
    }

    res.status(201).json(postWithAuthor);
  } catch (err) {
    sendServerError(res, err);
  }
});

// ── PUT /api/posts/:id — Edit a post's caption ──────────────────
router.put('/:id', async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    if (isNaN(postId)) return res.status(400).json({ error: 'INVALID_ID' });

    const { caption } = req.body;
    if (caption === undefined || caption === null) {
      return res.status(400).json({ error: 'MISSING_CAPTION', message: 'Caption is required' });
    }

    const post = await db.get('SELECT * FROM posts WHERE id = ?', [postId]);
    if (!post) return res.status(404).json({ error: 'POST_NOT_FOUND' });

    const pet = await db.get('SELECT * FROM pets WHERE id = ? AND user_id = ?', [post.pet_id, req.user.id]);
    if (!pet) return res.status(403).json({ error: 'FORBIDDEN', message: 'You can only edit your own posts.' });

    const updated = await PostRepo.updateCaption(postId, caption.trim());

    const io = req.app.get('io');
    if (io) {
      io.emit('post_updated', { post_id: postId, caption: updated.caption });
    }

    res.json({ success: true, post: updated });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/like', requirePet, refuseSniffedOutAuthor, refuseBlockedAuthor, async (req, res) => {
  try {
    const postId = parseInt(req.params.id);
    const result = await PostRepo.toggleLike(postId, req.user.id);
    const count = await PostRepo.getLikeCount(postId);

    // H14: used to be an unconditional SpotlightRepo.clearCache() here --
    // wiping EVERY area/location's cached leaderboard, platform-wide, for
    // one post's like. Each cache bucket now expires on its own
    // (SPOTLIGHT_CACHE_TTL, see SpotlightRepository.getTopPets), which
    // keeps rankings reasonably fresh without forcing a full recomputation
    // of every region on Earth on every single like.

    const io = req.app.get('io');
    if (io) {
      io.emit('post_liked', { post_id: postId, liked: result.liked, like_count: count });
      io.emit('spotlight_updated');
    }

    if (result.liked && io) {
      const post = await PostRepo.findById(postId);
      if (post && post.author_pet_id) {
        const ownerPet = await PetRepo.findById(post.author_pet_id);
        
        // Check immediately if this new like pushed the post owner's
        // pet into a better Spotlight rank, instead of waiting for
        // someone to happen to visit the Spotlight page later.
        checkSpotlightAchievementsForPet(io, post.author_pet_id).catch(() => {});

        if (ownerPet && ownerPet.user_id !== req.user.id) {
        
          const likerPet = await PetRepo.findByUserId(req.user.id);
          if (!likerPet) {
            console.warn(`[posts:like] No active pet found for liking user_id=${req.user.id} -- notification will show a generic name.`);
          }
          const likerName = likerPet?.name || 'Someone';
          await sendRealtimeNotification(io, ownerPet.user_id, {
            category: 'activity',
            type: 'lick',
            title: `${likerName} liked your post 🐾`,
            description: `${likerName} liked your post.`,
            avatarUrl: post.media_url || likerPet?.avatar_url || null,
            targetId: String(postId),
            senderPetId: likerPet?.id || null,
            actorName: likerName,
          });
        }
      }
    }

    res.json({ ...result, likeCount: count });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/share', requirePet, refuseSniffedOutAuthor, refuseBlockedAuthor, async (req, res) => {
  try {
    const count = await PostRepo.sharePost(parseInt(req.params.id), req.user.id);

    const io = req.app.get('io');
    if (io) {
      io.emit('post_shared', { post_id: parseInt(req.params.id), share_count: count });
    }

    res.json({ success: true, share_count: count });
  } catch (err) {
    sendServerError(res, err);
  }
});

// GET /api/posts/reports -- the reports YOU filed (posts and PawCircles).
// post_reports has no status column: nothing reviews or resolves reports
// yet, so every report is 'Pending'. (A status column would only make sense
// with a moderation workflow that changes it; until then it'd stay unused.)
router.get('/reports', async (req, res) => {
  try {
    const reports = await db.all(`
      SELECT pr.id, pr.post_id, pr.reason, pr.created_at, 'Pending' AS status,
             p.caption, p.media_url, pet.name as pet_name, pet.pet_username
      FROM post_reports pr
      LEFT JOIN posts p ON pr.post_id = p.id
      LEFT JOIN pets pet ON p.pet_id = pet.id
      WHERE pr.user_id = ?
      ORDER BY pr.created_at DESC
    `, [req.user.id]) || [];
    res.json({ reports });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/report', refuseSniffedOutAuthor, async (req, res) => {
  try {
    const { reason } = req.body;
    const result = await PostRepo.reportPost(parseInt(req.params.id), req.user.id, reason || 'Other');
    if (!result.success) {
      if (result.reason === 'POST_NOT_FOUND') return res.status(404).json({ error: 'POST_NOT_FOUND' });
      if (result.reason === 'CANNOT_REPORT_OWN_POST') {
        return res.status(400).json({ error: 'CANNOT_REPORT_OWN_POST', message: "You can't report your own post." });
      }
    }
    res.json({ success: true, message: result.alreadyReported ? "You've already reported this post." : 'Post reported successfully' });
  } catch (err) {
    sendServerError(res, err);
  }
});

// M7: the gallery grid on a pet's profile previously only ever saw the
// first page PostRepo.getByPetId's own default (20) returned -- the
// profile route (GET /api/profile[/:id]) calls getByPetId with no
// page/limit at all, so there was no way for the client to ask for more.
// This is a separate, dedicated, paginated endpoint rather than adding
// page/limit to the profile route itself, so a plain profile load stays
// one cheap query and pagination only costs anything when actually used.
router.get('/pet/:petId', async (req, res) => {
  try {
    const petId = parseInt(req.params.petId, 10);
    if (!Number.isInteger(petId)) return res.status(400).json({ error: 'INVALID_PET_ID' });
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    // Fetch one extra row to know if another page exists, without a
    // separate COUNT query -- same trick as getComments above.
    const rows = await PostRepo.getByPetId(petId, page, limit + 1);
    const hasMore = rows.length > limit;
    res.json({ posts: hasMore ? rows.slice(0, limit) : rows, hasMore, page });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/comments', refuseBlockedAuthor, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const { comments, hasMore } = await PostRepo.getComments(parseInt(req.params.id), page, 20, req.user.id);
    res.json({ comments, hasMore, page });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/comment', requirePet, rateLimiter(config.RATE_LIMIT.POST), refuseSniffedOutAuthor, refuseBlockedAuthor, async (req, res) => {
  try {
    if (!req.body.content?.trim()) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Comment cannot be empty' });
    const postId = parseInt(req.params.id);
    const trimmedContent = req.body.content.trim();
    const parentCommentId = req.body.parentCommentId ? parseInt(req.body.parentCommentId) : null;
    // No replying to a comment by someone in a blocked pair with you (nor to
    // its thread's top-level comment, which a reply is attached to).
    if (parentCommentId) {
      const parent = await db.get('SELECT user_id, parent_comment_id FROM comments WHERE id = ?', [parentCommentId]);
      const top = parent?.parent_comment_id ? await db.get('SELECT user_id FROM comments WHERE id = ?', [parent.parent_comment_id]) : null;
      for (const c of [parent, top]) {
        if (c && await isBlockedPair(req.user.id, c.user_id)) return res.status(403).json(BLOCKED_BODY);
      }
    }
    const { comment, duplicate } = await PostRepo.addComment(postId, req.user.id, trimmedContent, parentCommentId);
    // The same comment again within seconds (double tap, retry): hand back
    // the one already saved -- no copy, no second broadcast or notification.
    if (duplicate) return res.status(200).json(comment);

    const io = req.app.get('io');
    if (io) {
      // Not to people in a blocked pair with the commenter (they don't see
      // this user's comments at all).
      io.except(await blockedPairRooms(req.user.id)).emit('post_commented', { post_id: postId, comment });
    }

    if (io) {
      const post = await PostRepo.findById(postId);
      if (post && post.author_pet_id) {
        const ownerPet = await PetRepo.findById(post.author_pet_id);
        const commenterPet = await PetRepo.findByUserId(req.user.id);
        if (!commenterPet) {
          console.warn(`[posts:comment] No active pet found for commenting user_id=${req.user.id} -- notification will show a generic name.`);
        }

        // Notify the post owner about the new comment (skip if commenting on your own post)
        if (ownerPet && ownerPet.user_id !== req.user.id) {
          const commenterName = commenterPet?.name || 'Someone';
          const preview = trimmedContent.length > 80 ? `${trimmedContent.slice(0, 80)}...` : trimmedContent;
          await sendRealtimeNotification(io, ownerPet.user_id, {
            category: 'activity',
            type: 'comment',
            title: `${commenterName} commented on your post 💬`,
            description: `${commenterName} commented: "${preview}"`,
            avatarUrl: post.media_url || commenterPet?.avatar_url || null,
            targetId: String(postId),
            senderPetId: commenterPet?.id || null,
            actorName: commenterName,
          });
        }

        // ── Real "You were tagged" notification for @mentions INSIDE the comment itself ──
        // This is separate from the "new comment" notification above: if you write
        // "so cute @scooby_do" in a comment, Scooby's owner gets notified about being
        // mentioned specifically, even if they're not the post owner.
        if (commenterPet) {
          await notifyMentionedPets({ text: trimmedContent, authorPet: commenterPet, targetId: postId, io, sourceLabel: 'comment' });
        }

        // ── Notify the ORIGINAL comment's author when someone replies ──
        // Independent of the "commented on your post" notification above
        // (which goes to the post owner) -- this goes to whoever actually
        // wrote the comment being replied to, skipping self-replies.
        // comment.parent_comment_id reflects PostRepo.addComment's
        // flattening, so this is always the top-level comment's author.
        if (comment.parent_comment_id) {
          const parentComment = await db.get('SELECT user_id FROM comments WHERE id = ?', [comment.parent_comment_id]);
          if (parentComment && parentComment.user_id !== req.user.id) {
            const replierName = commenterPet?.name || 'Someone';
            const preview = trimmedContent.length > 80 ? `${trimmedContent.slice(0, 80)}...` : trimmedContent;
            await sendRealtimeNotification(io, parentComment.user_id, {
              category: 'activity',
              type: 'comment_reply',
              title: `${replierName} replied to your comment 💬`,
              description: `${replierName} replied: "${preview}"`,
              avatarUrl: post.media_url || commenterPet?.avatar_url || null,
              targetId: String(postId),
              senderPetId: commenterPet?.id || null,
              actorName: replierName,
            });
          }
        }
      }
    }

    res.status(201).json(comment);
  } catch (err) {
    sendServerError(res, err);
  }
});

// Only the comment's own author can delete it -- enforced server-side in
// PostRepo.deleteComment (mirrors PostRepo.deletePost's forbidden check),
// never trusted from the client.
router.delete('/:postId/comment/:commentId', async (req, res) => {
  try {
    const commentId = parseInt(req.params.commentId, 10);
    const result = await PostRepo.deleteComment(commentId, req.user.id);
    if (!result) return res.status(404).json({ error: 'COMMENT_NOT_FOUND' });
    if (result.forbidden) return res.status(403).json({ error: 'FORBIDDEN', message: 'You can only delete your own comments.' });

    const io = req.app.get('io');
    if (io) {
      io.emit('comment_deleted', { post_id: result.post_id, comment_id: commentId, parent_comment_id: result.parent_comment_id });
    }

    res.json({ success: true });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.post('/:id/react', requirePet, refuseSniffedOutAuthor, refuseBlockedAuthor, async (req, res) => {
  try {
    const { reaction } = req.body;
    const validReactions = ['paw', 'bone', 'fish', 'sleep', 'love'];
    if (!validReactions.includes(reaction)) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Invalid reaction type' });
    }

    const result = await PostRepo.toggleReaction(parseInt(req.params.id), req.user.id, reaction);
    const reactions = await PostRepo.getPostReactions(parseInt(req.params.id));

    const io = req.app.get('io');
    if (io) {
      io.emit('post_reacted', { post_id: parseInt(req.params.id), reactions, result });
    }

    res.json({ success: true, ...result, reactions });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id/reactions', refuseBlockedAuthor, async (req, res) => {
  try {
    const list = await PostRepo.getReactionUsers(parseInt(req.params.id), req.user.id);
    res.json({ reactions: list });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const postId = parseInt(req.params.id, 10);
    const result = await PostRepo.deletePost(postId, req.user.id);
    if (!result) return res.status(404).json({ error: 'POST_NOT_FOUND' });
    if (result.forbidden) return res.status(403).json({ error: 'FORBIDDEN', message: 'You can only delete your own posts.' });

    // H14: see the identical note on POST /:id/like -- the global
    // clearCache() this used to call is gone; each cache bucket now
    // expires on its own (SPOTLIGHT_CACHE_TTL).

    const io = req.app.get('io');
    if (io) {
      io.emit('post_deleted', { post_id: postId, pet_id: result.pet_id });
      const updatedPet = await PetRepo.findById(result.pet_id);
      if (updatedPet) {
        io.emit('profile_updated', { pet_id: result.pet_id, pet: toPublicPet(updatedPet) });
      }
      io.emit('spotlight_updated');
    }

    res.json({ success: true, message: 'Memory deleted permanently.' });
  } catch (err) {
    sendServerError(res, err);
  }
});

router.get('/:id', refuseBlockedAuthor, async (req, res) => {
  try {
    const post = await PostRepo.findById(parseInt(req.params.id), req.user.id);
    if (!post) return res.status(404).json({ error: 'POST_NOT_FOUND', message: 'Post not found' });
    // getFeed/getNewPosts already hide flagged posts -- this direct-fetch
    // route didn't, so a post auto-flagged after enough reports remained
    // fully viewable/likeable/commentable via its own URL even though it
    // had disappeared from the feed. The owner can still see their own
    // flagged post (e.g. to know it was flagged).
    if (post.is_flagged && post.owner_user_id !== req.user.id) {
      return res.status(404).json({ error: 'POST_NOT_FOUND', message: 'Post not found' });
    }
    res.json({ post });
  } catch (err) {
    sendServerError(res, err);
  }
});

export default router;