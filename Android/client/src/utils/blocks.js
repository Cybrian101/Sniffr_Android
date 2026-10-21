import api from '../services/api';
import { confirmDialog } from './confirmDialog';

// Blocking is per account and two-way (server/services/blocks.js): once
// either person blocks the other, neither can message, call, sniff, react,
// comment or mention, and neither sees the other's posts or profile. Only
// the blocker can unblock. The server enforces all of it; screens only
// reflect the state, and listen for BLOCK_EVENT to update in place.

export const BLOCK_EVENT = 'sniffr:block-changed';

// detail: { userId, blockedByMe }. Also fired for the server's block_updated
// socket event (the same account blocking/unblocking on another device).
export function announceBlockChange(userId, blockedByMe) {
  window.dispatchEvent(new CustomEvent(BLOCK_EVENT, { detail: { userId: Number(userId), blockedByMe: !!blockedByMe } }));
}

export async function setBlocked(userId, block) {
  await api.post(block ? '/profile/block' : '/profile/unblock', { blockedUserId: userId });
  announceBlockChange(userId, block);
}

// Asks first (in-app dialog, not window.confirm); resolves true if the user
// was blocked.
export async function confirmAndBlock(userId, name) {
  const who = name || 'this user';
  const ok = await confirmDialog({
    title: `Block ${who}?`,
    message: "They won't be able to message or call you, sniff you, see your posts or profile, or interact with you. You can unblock them anytime in Settings.",
    confirmLabel: 'Block',
    icon: 'block',
    danger: true,
  });
  if (!ok) return false;
  await setBlocked(userId, true);
  return true;
}

// The accounts you blocked: [{ user_id, pet_id, pet_name, pet_username, pet_avatar, blocked_at }].
export async function fetchBlockedAccounts() {
  const data = await api.get('/profile/blocked');
  return data.blocked || [];
}
