// Single source of truth for every plan tier's price, limits, and perks.
// Every premium check in the app must read from here -- never hardcode a
// limit or compare a plan string directly anywhere else. Adding a 5th tier
// later means adding one entry here (plus one `ALTER TYPE plan_tier_enum
// ADD VALUE '...'` on the DB) -- no route/service/component needs to change.

export const PLANS = {
  free: {
    key: 'free',
    label: 'Sniffr Free',
    priceInr: 0,
    durationMonths: null,
    maxCommunitiesJoined: 3,
    maxCommunitiesCreated: 5,
    maxPets: 2,
    canUndoLike: false,
    canUseSuperSniff: false,
    hasEarlyAccess: false,
    hasPremiumBadge: false,
    boostCreditsPerCycle: 0,
    adFrequency: { meetSwipeInterval: 3, tier: 'frequent' },
  },
  plus: {
    key: 'plus',
    label: 'Sniffr Plus',
    priceInr: 99,
    durationMonths: 1,
    maxCommunitiesJoined: Infinity,
    maxCommunitiesCreated: Infinity,
    maxPets: Infinity,
    canUndoLike: true,
    canUseSuperSniff: true,
    hasEarlyAccess: false,
    hasPremiumBadge: true,
    boostCreditsPerCycle: 1,
    adFrequency: { meetSwipeInterval: 6, tier: 'reduced' },
  },
  gold: {
    key: 'gold',
    label: 'Sniffr Gold',
    priceInr: 199,
    durationMonths: 3,
    maxCommunitiesJoined: Infinity,
    maxCommunitiesCreated: Infinity,
    maxPets: Infinity,
    canUndoLike: true,
    canUseSuperSniff: true,
    hasEarlyAccess: true,
    hasPremiumBadge: true,
    boostCreditsPerCycle: 2,
    adFrequency: { meetSwipeInterval: 15, tier: 'minimal' },
  },
  platinum: {
    key: 'platinum',
    label: 'Sniffr Platinum',
    priceInr: 799,
    durationMonths: 12,
    maxCommunitiesJoined: Infinity,
    maxCommunitiesCreated: Infinity,
    maxPets: Infinity,
    canUndoLike: true,
    canUseSuperSniff: true,
    hasEarlyAccess: true,
    hasPremiumBadge: true,
    boostCreditsPerCycle: 6,
    // "extremely rare, never fully zero" -- a very wide swipe interval
    // rather than 0/Infinity, so the ad hook point still fires occasionally.
    adFrequency: { meetSwipeInterval: 40, tier: 'rare' },
  },
};

export const PLAN_KEYS = Object.keys(PLANS);
export const PAID_PLAN_KEYS = PLAN_KEYS.filter(k => k !== 'free');

export const LAUNCH_OFFER_PLAN = 'gold';
export const LAUNCH_OFFER_USER_LIMIT = 100;

export function getPlan(key) {
  return PLANS[key] || PLANS.free;
}

export function isValidPlanKey(key) {
  return Object.prototype.hasOwnProperty.call(PLANS, key);
}
