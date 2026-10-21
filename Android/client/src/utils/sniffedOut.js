// Deleted ("SniffedOut") accounts stay visible where other people still need
// them -- chats, comments, matches -- as "SniffedOut", with no avatar and no
// profile to open. The server marks them with sniffed_out / other_sniffed_out
// / read_only flags and refuses actions on them with 403 SNIFFED_OUT.

export const SNIFFED_OUT_NAME = 'SniffedOut';
export const SNIFFED_OUT_MESSAGE = 'This user deleted their account.';

// A 1:1 conversation whose other side is SniffedOut: history stays, no new
// messages, calls, reactions or meetups.
export const isReadOnlyConversation = conv => !!(conv && (conv.read_only || conv.other_sniffed_out));

const MEDIA_MESSAGE_TYPES = new Set(['image', 'video', 'voice', 'file']);

// A media message whose file was removed (the sender deleted their account).
export const isMediaMissing = msg => !!msg && MEDIA_MESSAGE_TYPES.has(msg.message_type) && !msg.media_url;

// An API error (api.js sets err.code) or socket ack/payload refused because
// the other side is SniffedOut. Checking an API error with this also marks
// it handled, so the app-wide toast (SniffedOutToast) doesn't show a second
// message for something this screen already explains.
export const isSniffedOutError = errOrAck => {
  const yes = (errOrAck?.code || errOrAck?.error) === 'SNIFFED_OUT';
  if (yes && errOrAck instanceof Error) errOrAck.handled = true;
  return yes;
};

// Fired by api.js for every SNIFFED_OUT error that no screen handled itself.
export const SNIFFED_OUT_EVENT = 'sniffr:sniffed-out';

// ── Frozen PawCircles ───────────────────────────────────────────────────
// A circle whose owner deleted their account: members can read and leave,
// nothing else. The server refuses writes with 403 COMMUNITY_READ_ONLY.
export const COMMUNITY_READ_ONLY_MESSAGE = "This PawCircle's owner deleted their account. It's now read-only.";
export const isCommunityFrozen = community => !!(community && (community.frozen || community.status === 'frozen'));
// The owner disabled (archived) the circle: read-only like a frozen one, until re-enabled.
export const COMMUNITY_DISABLED_MESSAGE = 'This PawCircle has been disabled by its owner.';
export const isCommunityReadOnlyError = errOrAck => (errOrAck?.code || errOrAck?.error) === 'COMMUNITY_READ_ONLY';
