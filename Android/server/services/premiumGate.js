import db from '../db/connection.js';
import { getPlan } from '../config/plans.js';
import { getUserWithFreshPlanState, serializePremiumState } from './subscriptionService.js';

// The one place every gate check resolves "what plan is this user actually
// on right now" -- reuses the same lazy-expiry logic as everything else,
// so a gate check can never see a stale/expired plan as still active.
async function getEffectivePlan(userId, io = null) {
  const user = await getUserWithFreshPlanState(userId, io);
  if (!user) return { plan: getPlan('free'), state: null };
  const state = serializePremiumState(user);
  return { plan: getPlan(state.currentPlan), state };
}

export async function canAddPet(userId, io = null) {
  const { plan, state } = await getEffectivePlan(userId, io);
  const row = await db.get('SELECT COUNT(*) as count FROM pets WHERE user_id = ?', [userId]);
  const current = Number(row?.count || 0);
  const allowed = current < plan.maxPets;
  return { allowed, reason: allowed ? null : 'PET_LIMIT_REACHED', limit: plan.maxPets, current, plan: state?.currentPlan || 'free' };
}

export async function canJoinCommunity(userId, io = null) {
  const { plan, state } = await getEffectivePlan(userId, io);
  // Counts every membership that isn't ownership, deliberately excluding
  // only communities the user owns/created -- otherwise the two
  // independently-stated limits (3 joined vs 5 created) would bleed into
  // each other, since creating a community also makes you its member.
  // M22: this used to be `role = 'Member'` exactly, which looked
  // equivalent but wasn't -- promoting a joined member to Admin/Moderator
  // changes their role away from 'Member' without them leaving the circle,
  // so that still-live membership silently stopped counting against the
  // join limit, freeing a slot a free-plan user could then spend joining
  // an ADDITIONAL circle while still sitting in the original one. Role
  // changes (Member <-> Admin/Moderator) must never affect this count,
  // only actually leaving (row deleted) or becoming Owner (ownership
  // transfer) should.
  const row = await db.get("SELECT COUNT(*) as count FROM community_members WHERE user_id = ? AND role != 'Owner'", [userId]);
  const current = Number(row?.count || 0);
  const allowed = current < plan.maxCommunitiesJoined;
  return { allowed, reason: allowed ? null : 'COMMUNITY_JOIN_LIMIT_REACHED', limit: plan.maxCommunitiesJoined, current, plan: state?.currentPlan || 'free' };
}

export async function canCreateCommunity(userId, io = null) {
  const { plan, state } = await getEffectivePlan(userId, io);
  const row = await db.get("SELECT COUNT(*) as count FROM community_members WHERE user_id = ? AND role = 'Owner'", [userId]);
  const current = Number(row?.count || 0);
  const allowed = current < plan.maxCommunitiesCreated;
  return { allowed, reason: allowed ? null : 'COMMUNITY_CREATE_LIMIT_REACHED', limit: plan.maxCommunitiesCreated, current, plan: state?.currentPlan || 'free' };
}

export async function canUndoLike(userId, io = null) {
  const { plan, state } = await getEffectivePlan(userId, io);
  return { allowed: !!plan.canUndoLike, reason: plan.canUndoLike ? null : 'UNDO_LIKE_PREMIUM_ONLY', plan: state?.currentPlan || 'free' };
}

export async function canUseSuperSniff(userId, io = null) {
  const { plan, state } = await getEffectivePlan(userId, io);
  return { allowed: !!plan.canUseSuperSniff, reason: plan.canUseSuperSniff ? null : 'SUPER_SNIFF_PREMIUM_ONLY', plan: state?.currentPlan || 'free' };
}

export async function hasEarlyAccess(userId, io = null) {
  const { plan } = await getEffectivePlan(userId, io);
  return !!plan.hasEarlyAccess;
}

export async function getAdFrequency(userId, io = null) {
  const { plan } = await getEffectivePlan(userId, io);
  return plan.adFrequency;
}

export async function getSpotlightBoostBalance(userId, io = null) {
  const { state } = await getEffectivePlan(userId, io);
  return state ? state.boostCreditsRemaining : 0;
}

// How long a single spent Spotlight Boost credit keeps a pet pinned above
// the ordinary leaderboard (see SpotlightRepository.getTopPets's boosted-
// first sort). Not specified anywhere in the product copy/docs this repo
// has -- 30 minutes is a reasonable, clearly-named default for "a single
// use" of a boost; tune here if the real intent differs.
const SPOTLIGHT_BOOST_DURATION_MS = 30 * 60 * 1000;

// Atomic decrement -- WHERE boost_credits_remaining > 0 means a client can
// never race this into a negative balance.
export async function consumeBoostCredit(userId, io = null) {
  const balance = await getSpotlightBoostBalance(userId, io);
  if (balance <= 0) return { success: false, remaining: 0 };

  // M15: a spent credit previously only decremented this counter -- nothing
  // recorded that a boost was actually ACTIVE, so SpotlightRepository had
  // no signal to rank against. spotlight_boost_until is that signal now.
  const boostUntil = new Date(Date.now() + SPOTLIGHT_BOOST_DURATION_MS).toISOString();
  const result = await db.run(
    `UPDATE users SET boost_credits_remaining = boost_credits_remaining - 1, spotlight_boost_until = ?
     WHERE id = ? AND boost_credits_remaining > 0
     RETURNING boost_credits_remaining, spotlight_boost_until`,
    [boostUntil, userId]
  );
  if (!result.rows.length) return { success: false, remaining: 0 };

  const remaining = result.rows[0].boost_credits_remaining;
  const spotlightBoostUntil = result.rows[0].spotlight_boost_until;
  if (io) io.to(`user_${userId}`).emit('boost_credits_updated', { remaining, spotlightBoostUntil });
  return { success: true, remaining, spotlightBoostUntil };
}
