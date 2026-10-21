import db, { withTransaction } from '../db/connection.js';
import BaseRepository from './BaseRepository.js';
import { hasCurrentAccess } from '../services/subscriptionService.js';
import { sqlUsername, sqlFullName, sqlPetName, sqlHidden, sqlGone, SNIFFED_OUT, LIVE_MEMBER_COUNT_SQL } from '../utils/sniffedOut.js';

// community_announcements.location_name (db/sql/2026-10-02_announcement_location_name.sql)
// is written only once the column exists, so the backend can be deployed
// before that SQL is run. Once seen, it's remembered; until then it's
// re-checked on each event announcement.
let announcementLocationNameColumn = false;
async function hasAnnouncementLocationName() {
  if (announcementLocationNameColumn) return true;
  const row = await db.get(
    `SELECT 1 AS ok FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'community_announcements' AND column_name = 'location_name'`);
  announcementLocationNameColumn = !!row;
  return announcementLocationNameColumn;
}

// PawCircle message sender (users `u`, pets `p`): a SniffedOut sender keeps
// their text but shows as "SniffedOut" with no avatar.
const MESSAGE_SENDER_COLUMNS = `
  ${sqlUsername('u')} AS username, ${sqlFullName('u')} AS full_name, ${sqlGone('u')} AS sniffed_out,
  ${sqlPetName('p', 'u')} as pet_name, ${sqlHidden('p.avatar_url', 'p', 'u')} as sender_avatar`;

// Reply preview (community_messages `reply`), same rule for its sender.
const MESSAGE_REPLY_COLUMNS = `
  reply.content as reply_content,
  reply.sender_id as reply_sender_id,
  reply.message_type as reply_message_type,
  (SELECT CASE WHEN ru.deleted_at IS NOT NULL THEN '${SNIFFED_OUT}' ELSE ru.username END FROM users ru WHERE ru.id = reply.sender_id) as reply_sender_username,
  (SELECT ru.deleted_at IS NOT NULL FROM users ru WHERE ru.id = reply.sender_id) as reply_sender_sniffed_out`;

class CommunityRepository extends BaseRepository {
  constructor() {
    super('communities');
  }

  // Readable URL for a PawCircle (/community/claude-qa-pack instead of
  // /community/312) -- generated once at creation (see routes/communities.js
  // POST /) and never touched again, so an existing link stays valid even if
  // the circle is later renamed. Same collapsing rule the backfill migration
  // (db/sql/2026-10-13_community_slug.sql) used for existing rows, so both
  // produce identical slugs for the same name.
  async generateUniqueSlug(name) {
    const base = (name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-+|-+$)/g, '') || 'circle';
    let candidate = base;
    let suffix = 2;
    while (await db.get('SELECT 1 FROM communities WHERE slug = ?', [candidate])) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    return candidate;
  }

  async findBySlug(slug) {
    return db.get('SELECT id FROM communities WHERE slug = ?', [slug]);
  }

  async getRecommendedForPet(pet, userId) {
    // Exclude circles the user is already in (as a joined member OR as the
    // creator/owner, who is always a member too) -- otherwise a circle you
    // created or already joined kept showing back up under "Recommended",
    // which is both pointless (you can't "discover" what you already have)
    // and was flagged as confusing by the owner.
    const list = await db.all(`
      SELECT c.*,
        (SELECT COUNT(*) FROM community_members WHERE community_id = c.id AND joined_at >= NOW() - INTERVAL '7 days') as recent_growth
      FROM communities c
      WHERE c.is_private = 0 AND c.status <> 'frozen' AND c.disabled_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM community_members cm WHERE cm.community_id = c.id AND cm.user_id = $1
        )
    `, [userId]);

    if (list.length === 0) return [];

    const scored = list.map(comm => {
      let score = 0;
      score += Math.min(100, comm.member_count || 0);
      score += Number(comm.recent_growth || 0) * 5;

      const ageDays = (Date.now() - new Date(comm.created_at).getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays <= 15) {
        score += 50;
      }

      if (pet) {
        if (pet.type && comm.pet_type && (comm.pet_type.toLowerCase() === pet.type.toLowerCase() || comm.pet_type.toLowerCase() === 'all')) {
          score += 20;
        }
        if (pet.breed_name && comm.breed && comm.breed.toLowerCase() === pet.breed_name.toLowerCase()) {
          score += 30;
        }
        if (pet.city && comm.city && comm.city.toLowerCase() === pet.city.toLowerCase()) {
          score += 25;
        }
      }

      return { ...comm, score };
    });

    scored.sort((a, b) => b.score - a.score);

    const rotationHours = 6;
    const intervalIndex = Math.floor(Date.now() / (1000 * 60 * 60 * rotationHours));
    const offset = intervalIndex % scored.length;

    const rotated = [...scored.slice(offset), ...scored.slice(0, offset)];

    return rotated;
  }

  // Members always get their own circles back, private, frozen or disabled
  // -- their "my circles" list is built from these results. Non-members find
  // active, non-disabled circles: public ones by any field and filter;
  // private ones too (shown with a Private badge and only their public
  // info), but matched on name and description only and never through the
  // category/breed/pet type/city/tags filters, so a search can't reveal a
  // private circle's hidden details.
  async search({ q = '', category, breed, pet_type, city, tags, userId = null }) {
    const term = q ? `%${q}%` : null;
    const fieldConds = [];
    const fieldParams = [];
    if (term) {
      fieldConds.push('(name LIKE ? OR description LIKE ? OR city LIKE ? OR breed LIKE ? OR tags LIKE ?)');
      fieldParams.push(term, term, term, term, term);
    }
    if (category && category !== 'All') {
      fieldConds.push('category = ?');
      fieldParams.push(category);
    }
    if (breed) {
      fieldConds.push('breed = ?');
      fieldParams.push(breed);
    }
    if (pet_type && pet_type !== 'All') {
      fieldConds.push("(pet_type = ? OR pet_type = 'All')");
      fieldParams.push(pet_type);
    }
    if (city) {
      fieldConds.push('city LIKE ?');
      fieldParams.push(`%${city}%`);
    }
    if (tags) {
      fieldConds.push('tags LIKE ?');
      fieldParams.push(`%${tags}%`);
    }
    const fieldMatch = fieldConds.length ? fieldConds.join(' AND ') : 'TRUE';
    const attributeFilters = fieldConds.length - (term ? 1 : 0);

    const isMember = 'EXISTS (SELECT 1 FROM community_members m WHERE m.community_id = communities.id AND m.user_id = ?)';
    const branches = [`(${isMember} AND ${fieldMatch})`, `(is_private = 0 AND status <> 'frozen' AND disabled_at IS NULL AND ${fieldMatch})`];
    const params = [userId, ...fieldParams, ...fieldParams];
    if (!attributeFilters) {
      branches.push(`(is_private = 1 AND status <> 'frozen' AND disabled_at IS NULL${term ? ' AND (name LIKE ? OR description LIKE ?)' : ''})`);
      if (term) params.push(term, term);
    }
    return db.all(`SELECT * FROM communities WHERE ${branches.join(' OR ')} ORDER BY member_count DESC`, params);
  }

  // joinStatus: 'Joined' (member), 'Join' (public circle), and for a private
  // circle 'Requested' (pending, unexpired request) or 'Request to Join'.
  // A non-member of a PRIVATE circle gets only its public info (name,
  // cover/icon, description, member count) plus the request state -- never
  // rules, city, tags, creator or activity.
  async getDetailsWithStatus(communityId, userId) {
    const community = await this.findById(communityId);
    if (!community) return null;

    const membership = await db.get(
      'SELECT role, verified_badge, cleared_at, is_hidden FROM community_members WHERE community_id = ? AND user_id = ?',
      [communityId, userId]
    );

    if (!membership && community.is_private) {
      const request = await db.get(
        `SELECT (status = 'pending' AND expires_at > NOW()) AS active, expires_at,
                CASE WHEN status = 'declined' AND decided_at > NOW() - INTERVAL '24 hours'
                     THEN decided_at + INTERVAL '24 hours' END AS cooldown_until
         FROM community_join_requests WHERE community_id = ? AND user_id = ?`,
        [communityId, userId]
      );
      return {
        id: community.id,
        slug: community.slug,
        name: community.name,
        description: community.description,
        cover_image: community.cover_image,
        icon_image: community.icon_image,
        member_count: community.member_count,
        is_private: 1,
        locked: true,
        frozen: community.status === 'frozen',
        disabled: !!community.disabled_at,
        joinStatus: request?.active ? 'Requested' : 'Request to Join',
        requestExpiresAt: request?.active ? request.expires_at : null,
        requestCooldownUntil: request?.cooldown_until || null,
        userRole: null,
        userBadge: null,
        clearedAt: null,
        isHiddenFromList: false,
      };
    }

    const joinStatus = membership ? 'Joined' : 'Join';

    let isHiddenFromList = false;
    if (membership && membership.is_hidden === 1 && membership.cleared_at) {
      const hasNewMsg = await db.get(
        `SELECT 1 FROM community_messages WHERE community_id = ? AND created_at > ? LIMIT 1`,
        [communityId, membership.cleared_at]
      );
      const hasNewAnn = await db.get(
        `SELECT 1 FROM community_announcements WHERE community_id = ? AND created_at > ? LIMIT 1`,
        [communityId, membership.cleared_at]
      );

      if (!hasNewMsg && !hasNewAnn) {
        isHiddenFromList = true;
      } else {
        await db.run(
          `UPDATE community_members SET is_hidden = 0 WHERE community_id = ? AND user_id = ?`,
          [communityId, userId]
        );
      }
    }

    const activeRow = await db.get(
      `SELECT COUNT(*) as count FROM community_members WHERE community_id = ? AND last_active_at >= NOW() - INTERVAL '1 day'`,
      [communityId]
    );
    const activeMembersCount = activeRow?.count ? Number(activeRow.count) : Math.max(1, Math.floor(community.member_count * 0.4));

    // "Last Activity" on the PawCircle list (PawCircleTab.jsx) -- community
    // rows themselves carry no last-message data, so without this it always
    // read "No messages yet" regardless of how active the circle actually was.
    const lastMsg = await db.get(
      `SELECT content, message_type, created_at FROM community_messages WHERE community_id = ? ORDER BY created_at DESC LIMIT 1`,
      [communityId]
    );

    // invite_code is stripped for non-members -- it was previously returned
    // to any authenticated user who knew/guessed the community's ID, member
    // or not.
    const { invite_code, ...safeCommunity } = community;

    return {
      ...safeCommunity,
      ...(membership ? { invite_code } : {}),
      locked: false,
      frozen: community.status === 'frozen',
      disabled: !!community.disabled_at,
      joinStatus,
      userRole: membership?.role || null,
      userBadge: membership?.verified_badge || null,
      activeMembersCount,
      clearedAt: membership?.cleared_at || null,
      isHiddenFromList,
      last_message: lastMsg?.content || null,
      last_message_type: lastMsg?.message_type || null,
      last_message_at: lastMsg?.created_at || null,
    };
  }

  // Full, unpaginated member list -- used internally wherever EVERY member
  // needs to be reached (e.g. announcement fan-out notifications). Do not
  // use this for a client-facing list endpoint; see getMembersPaginated.
  async getMembers(communityId) {
    const members = await db.all(
      `SELECT cm.*, ${sqlUsername('u')} AS username, ${sqlFullName('u')} AS full_name, ${sqlGone('u')} AS sniffed_out,
              u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date,
              p.id as pet_id, ${sqlPetName('p', 'u')} as pet_name, ${sqlHidden('p.avatar_url', 'p', 'u')} as pet_avatar,
              ${sqlHidden('p.breed_name', 'p', 'u')} as breed_name, ${sqlHidden('p.bio', 'p', 'u')} as bio
       FROM community_members cm
       JOIN users u ON cm.user_id = u.id
       LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
       WHERE cm.community_id = ?
       ORDER BY
         CASE cm.role
           WHEN 'Owner' THEN 1
           WHEN 'Admin' THEN 2
           WHEN 'Moderator' THEN 3
           ELSE 4
         END, cm.joined_at ASC`,
      [communityId]
    );
    members.forEach(m => { m.is_premium = !m.sniffed_out && !!(hasCurrentAccess(m) && m.premium_badge_enabled); });
    return members;
  }

  async getMembersPaginated(communityId, page = 1, limit = 50) {
    const offset = (page - 1) * limit;
    const members = await db.all(
      `SELECT cm.*, ${sqlUsername('u')} AS username, ${sqlFullName('u')} AS full_name, ${sqlGone('u')} AS sniffed_out,
              u.subscription_status, u.premium_badge_enabled, u.plan_expiry_date,
              p.id as pet_id, ${sqlPetName('p', 'u')} as pet_name, ${sqlHidden('p.avatar_url', 'p', 'u')} as pet_avatar,
              ${sqlHidden('p.breed_name', 'p', 'u')} as breed_name, ${sqlHidden('p.bio', 'p', 'u')} as bio
       FROM community_members cm
       JOIN users u ON cm.user_id = u.id
       LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
       WHERE cm.community_id = ?
       ORDER BY
         CASE cm.role
           WHEN 'Owner' THEN 1
           WHEN 'Admin' THEN 2
           WHEN 'Moderator' THEN 3
           ELSE 4
         END, cm.joined_at ASC
       LIMIT ? OFFSET ?`,
      [communityId, limit, offset]
    );
    members.forEach(m => { m.is_premium = !m.sniffed_out && !!(hasCurrentAccess(m) && m.premium_badge_enabled); });
    const totalRow = await db.get('SELECT COUNT(*) as count FROM community_members WHERE community_id = ?', [communityId]);
    const total = totalRow ? Number(totalRow.count) : 0;
    return { members, total, page, hasMore: offset + limit < total };
  }

  // highlightId: a notification's target_id can point at an announcement
  // older than the default window -- without ensuring it's included, a
  // notification's deep-link landed on a tab that silently didn't contain
  // the announcement it was about. LIMIT was also raised from 3 to 20,
  // since 3 made this trivial to hit even without an old notification.
  async getAnnouncements(communityId, highlightId = null) {
    const rows = await db.all(
      `SELECT ca.*, ${sqlUsername('u')} AS username, ${sqlFullName('u')} AS full_name, ${sqlGone('u')} AS sniffed_out,
              ${sqlHidden('p.avatar_url', 'p', 'u')} as sender_avatar
       FROM community_announcements ca
       JOIN users u ON ca.sender_id = u.id
       LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
       WHERE ca.community_id = ?
       ORDER BY ca.created_at DESC
       LIMIT 20`,
      [communityId]
    );
    if (highlightId && !rows.some(r => r.id === Number(highlightId))) {
      const extra = await db.get(
        `SELECT ca.*, ${sqlUsername('u')} AS username, ${sqlFullName('u')} AS full_name, ${sqlGone('u')} AS sniffed_out,
              ${sqlHidden('p.avatar_url', 'p', 'u')} as sender_avatar
         FROM community_announcements ca
         JOIN users u ON ca.sender_id = u.id
         LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
         WHERE ca.id = ? AND ca.community_id = ?`,
        [highlightId, communityId]
      );
      if (extra) rows.push(extra);
    }
    return rows;
  }

  async getMessages(communityId, userId = null, limit = 50) {
    let clearedAt = null;
    if (userId) {
      const mem = await db.get(
        'SELECT cleared_at FROM community_members WHERE community_id = ? AND user_id = ?',
        [communityId, userId]
      );
      clearedAt = mem?.cleared_at || null;
    }

    const selectCols = `
      cm.*, ${MESSAGE_SENDER_COLUMNS},
      ${MESSAGE_REPLY_COLUMNS},
      (
        SELECT COALESCE(json_object_agg(r.reaction, r.cnt), '{}'::json)
        FROM (
          SELECT reaction, COUNT(*)::int as cnt
          FROM community_message_reactions
          WHERE community_message_id = cm.id
          GROUP BY reaction
        ) r
      ) as reactions
    `;
    const joins = `
      JOIN users u ON cm.sender_id = u.id
      LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
      LEFT JOIN community_messages reply ON cm.reply_to_id = reply.id
    `;

    // H8: ORDER BY ASC + LIMIT (no OFFSET) always returned the OLDEST
    // `limit` messages -- in a circle with more than `limit` messages ever
    // sent, newer ones could never appear, reload or not. Fetch the most
    // recent `limit` instead (DESC + LIMIT), then reverse back to
    // chronological order for display -- the same pattern
    // MessageRepository.getMessages already uses for 1:1 chat.
    if (clearedAt) {
      const rows = await db.all(
        `SELECT ${selectCols} FROM community_messages cm ${joins}
         WHERE cm.community_id = ? AND cm.created_at > ?
         ORDER BY cm.created_at DESC
         LIMIT ?`,
        [communityId, clearedAt, limit]
      );
      return rows.reverse();
    }

    const rows = await db.all(
      `SELECT ${selectCols} FROM community_messages cm ${joins}
       WHERE cm.community_id = ?
       ORDER BY cm.created_at DESC
       LIMIT ?`,
      [communityId, limit]
    );
    return rows.reverse();
  }

  async fetchBackMessage(messageId, userId) {
    const msg = await db.get('SELECT * FROM community_messages WHERE id = ?', [messageId]);
    if (!msg || msg.sender_id !== userId) return null;

    await db.run("UPDATE community_messages SET content = '🐾 This message was fetched back.', message_type = 'system', media_url = NULL WHERE id = ?", [messageId]);
    return db.get(
      `SELECT cm.*, ${MESSAGE_SENDER_COLUMNS}
       FROM community_messages cm
       JOIN users u ON cm.sender_id = u.id
       LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
       WHERE cm.id = ?`,
      [messageId]
    );
  }

  async deleteGroupForUser(communityId, userId) {
    await db.run(
      `UPDATE community_members 
       SET cleared_at = CURRENT_TIMESTAMP, is_hidden = 1 
       WHERE community_id = ? AND user_id = ?`,
      [communityId, userId]
    );
    return { success: true };
  }

  async getPhotos(communityId) {
    return db.all(
      `SELECT cp.*, ${sqlUsername('u')} AS username, ${sqlGone('u')} AS sniffed_out, ${sqlHidden('p.avatar_url', 'p', 'u')} as sender_avatar
       FROM community_photos cp
       JOIN users u ON cp.user_id = u.id
       LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
       WHERE cp.community_id = ?
       ORDER BY cp.created_at DESC`,
      [communityId]
    );
  }

  async addPhoto({ community_id, user_id, media_url, caption = '' }) {
    const result = await db.run(
      'INSERT INTO community_photos (community_id, user_id, media_url, caption) VALUES (?, ?, ?, ?) RETURNING id',
      [community_id, user_id, media_url, caption]
    );
    return db.get(
      `SELECT cp.*, ${sqlUsername('u')} AS username, ${sqlGone('u')} AS sniffed_out, ${sqlHidden('p.avatar_url', 'p', 'u')} as sender_avatar
       FROM community_photos cp
       JOIN users u ON cp.user_id = u.id
       LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
       WHERE cp.id = ?`,
      [result.rows[0].id]
    );
  }

  async getEvents(communityId) {
    return db.all(
      `SELECT ce.*, ${sqlUsername('u')} as creator_name, ${sqlGone('u')} as creator_sniffed_out
       FROM community_events ce
       LEFT JOIN users u ON ce.created_by = u.id
       WHERE ce.community_id = ?
       ORDER BY ce.event_date ASC`,
      [communityId]
    );
  }

  async getPolls(communityId) {
    const rows = await db.all(
      `SELECT cp.*, ${sqlUsername('u')} as creator_name, ${sqlGone('u')} as creator_sniffed_out
       FROM community_polls cp
       LEFT JOIN users u ON cp.created_by = u.id
       WHERE cp.community_id = ?
       ORDER BY cp.created_at DESC`,
      [communityId]
    );
    return rows.map(poll => ({
      ...poll,
      options: JSON.parse(poll.options_json || '[]'),
      votes: JSON.parse(poll.votes_json || '{}')
    }));
  }

  async join(communityId, userId, role = 'Member') {
    await db.run(
      'INSERT INTO community_members (community_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (community_id, user_id) DO NOTHING',
      [communityId, userId, role]
    );
    await this.recountMembers(communityId);
    return this.getDetailsWithStatus(communityId, userId);
  }

  async isMember(communityId, userId) {
    const id = parseInt(communityId, 10);
    if (!Number.isInteger(id) || !userId) return false;
    return !!(await db.get('SELECT 1 FROM community_members WHERE community_id = ? AND user_id = ?', [id, userId]));
  }

  // A reply target must be a message in the same circle.
  async isMessageInCommunity(messageId, communityId) {
    const msgId = parseInt(messageId, 10);
    const id = parseInt(communityId, 10);
    if (!Number.isInteger(msgId) || !Number.isInteger(id)) return false;
    return !!(await db.get('SELECT 1 FROM community_messages WHERE id = ? AND community_id = ?', [msgId, id]));
  }

  // member_count counts live members only -- a SniffedOut owner still listed
  // on a frozen circle doesn't count (same rule as the account deletion).
  async recountMembers(communityId, q = db) {
    await q.run(`UPDATE communities SET member_count = (${LIVE_MEMBER_COUNT_SQL}) WHERE id = ?`, [communityId, communityId]);
  }

  async addMessage({ community_id, sender_id, content, media_url = null, message_type = 'text', reply_to_id = null }) {
    const result = await db.run(
      'INSERT INTO community_messages (community_id, sender_id, content, media_url, message_type, reply_to_id) VALUES (?, ?, ?, ?, ?, ?) RETURNING id',
      [community_id, sender_id, content, media_url, message_type, reply_to_id]
    );
    await db.run('UPDATE community_members SET is_hidden = 0 WHERE community_id = ?', [community_id]);

    return db.get(
      `SELECT cm.*, ${MESSAGE_SENDER_COLUMNS},
        ${MESSAGE_REPLY_COLUMNS}
       FROM community_messages cm
       JOIN users u ON cm.sender_id = u.id
       LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
       LEFT JOIN community_messages reply ON cm.reply_to_id = reply.id
       WHERE cm.id = ?`,
      [result.rows[0].id]
    );
  }

  async addAnnouncement({ community_id, sender_id, title, content, latitude = null, longitude = null, is_event = 0, location_name = null }) {
    const result = location_name && await hasAnnouncementLocationName()
      ? await db.run(
        'INSERT INTO community_announcements (community_id, sender_id, title, content, latitude, longitude, is_event, location_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
        [community_id, sender_id, title, content, latitude, longitude, is_event, location_name]
      )
      : await db.run(
        'INSERT INTO community_announcements (community_id, sender_id, title, content, latitude, longitude, is_event) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id',
        [community_id, sender_id, title, content, latitude, longitude, is_event]
      );
    await db.run('UPDATE community_members SET is_hidden = 0 WHERE community_id = ?', [community_id]);

    return db.get(
      `SELECT ca.*, ${sqlUsername('u')} AS username, ${sqlFullName('u')} AS full_name, ${sqlGone('u')} AS sniffed_out,
              ${sqlHidden('p.avatar_url', 'p', 'u')} as sender_avatar
       FROM community_announcements ca
       JOIN users u ON ca.sender_id = u.id
       LEFT JOIN pets p ON p.id = COALESCE(u.active_pet_id, (SELECT id FROM pets WHERE user_id = u.id ORDER BY id ASC LIMIT 1))
       WHERE ca.id = ?`,
      [result.rows[0].id]
    );
  }

  async getNearbyNonMembers(communityId, lat, lng, radiusKm = 20) {
    // All users with a saved pet location, excluding current members of this community
    const rows = await db.all(
      `SELECT DISTINCT u.id as user_id, p.latitude, p.longitude
       FROM users u
       JOIN pets p ON p.user_id = u.id
       WHERE p.latitude IS NOT NULL AND p.longitude IS NOT NULL
         AND p.deleted_at IS NULL AND u.deleted_at IS NULL
         AND u.id NOT IN (SELECT user_id FROM community_members WHERE community_id = ?)`,
      [communityId]
    );

    const R = 6371;
    const toRad = (d) => (d * Math.PI) / 180;
    const seen = new Set();
    const nearby = [];
    for (const r of rows) {
      if (seen.has(r.user_id)) continue;
      const dLat = toRad(r.latitude - lat);
      const dLon = toRad(r.longitude - lng);
      const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(r.latitude)) * Math.sin(dLon / 2) ** 2;
      const dist = R * 2 * Math.asin(Math.sqrt(a));
      if (dist <= radiusKm) {
        seen.add(r.user_id);
        nearby.push({ user_id: r.user_id, distance: dist });
      }
    }
    return nearby;
  }

  async createPoll({ community_id, question, options, created_by }) {
    const result = await db.run(
      'INSERT INTO community_polls (community_id, question, options_json, votes_json, created_by) VALUES (?, ?, ?, ?, ?) RETURNING id',
      [community_id, question, JSON.stringify(options), JSON.stringify({}), created_by]
    );
    const polls = await this.getPolls(community_id);
    return polls.find(p => p.id === result.rows[0].id);
  }

  // M23: this used to be SELECT, modify in JS, UPDATE -- three separate
  // round trips with no locking, so two concurrent votes (even from two
  // different users) could both read the same votes_json, each compute
  // their own update from that same stale snapshot, and whichever UPDATE
  // landed last silently won, discarding the other vote entirely. Wrapping
  // the read in `SELECT ... FOR UPDATE` inside one transaction serializes
  // concurrent voters on the same poll row -- the second voter's SELECT
  // blocks until the first's UPDATE commits, then reads the already-updated
  // votes_json, so no vote is ever lost. It also never validated optionIndex
  // against the poll's own options array, so a client could record a vote
  // for an option index that doesn't exist.
  async votePoll(communityId, pollId, userId, optionIndex) {
    return withTransaction(async tx => {
      const poll = await tx.get('SELECT * FROM community_polls WHERE id = ? FOR UPDATE', [pollId]);
      // The route only verifies the caller is a member of :id (communityId)
      // -- without this check, that membership check said nothing about
      // whether the poll being voted on actually belongs to THAT community,
      // letting any member of any PawCircle vote on any poll by guessing IDs.
      // null (not a throw) so the route can answer a clean 404.
      if (!poll || poll.community_id !== communityId) return null;

      const options = JSON.parse(poll.options_json || '[]');
      const index = Number(optionIndex);
      if (!Number.isInteger(index) || index < 0 || index >= options.length) {
        const err = new Error('Invalid poll option index');
        err.code = 'INVALID_OPTION';
        throw err;
      }

      const votes = JSON.parse(poll.votes_json || '{}');
      Object.keys(votes).forEach(idx => {
        votes[idx] = (votes[idx] || []).filter(id => id !== userId);
      });
      if (!votes[String(index)]) votes[String(index)] = [];
      votes[String(index)].push(userId);

      await tx.run('UPDATE community_polls SET votes_json = ? WHERE id = ?', [JSON.stringify(votes), pollId]);
      return { ...poll, options, votes };
    });
  }
}

export default new CommunityRepository();