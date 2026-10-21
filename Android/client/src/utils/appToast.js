// App-wide error toast (components/AppToast.jsx), for user actions that
// fail on screens without their own message area: sending, posting,
// joining, saving, uploading... Background and polling errors stay silent.

export const APP_TOAST_EVENT = 'sniffr:toast';

export const BLOCKED_MESSAGE = "You can't interact with this user";
export const RATE_LIMIT_MESSAGE = 'Slow down a little, try again in a moment';

export const isBlockedError = err => err?.code === 'BLOCKED';
export const isRateLimitError = err =>
  err?.code === 'RATE_LIMIT' || err?.code === 'RATE_LIMITED' || err?.status === 429;

// The friendly text for an error: api.js already rewrites BLOCKED and rate
// limits to the messages above, this also covers network failures.
export function friendlyErrorMessage(err, fallback = 'Something went wrong. Please try again.') {
  if (isBlockedError(err)) return BLOCKED_MESSAGE;
  if (isRateLimitError(err)) return RATE_LIMIT_MESSAGE;
  if (err?.isNetworkError) return "Can't reach Sniffr right now. Check your connection and try again.";
  return err?.message || fallback;
}

export function showAppToast(message, icon = 'error') {
  window.dispatchEvent(new CustomEvent(APP_TOAST_EVENT, { detail: { message, icon } }));
}

// For a user action's catch block: shows why it failed, unless the app
// already explains it elsewhere (NO_PET opens the create-pet prompt,
// SNIFFED_OUT has its own toast) or the screen marked it handled.
export function notifyActionError(err, fallback) {
  console.error(err);
  if (!err || err.handled || err.code === 'NO_PET' || err.code === 'SNIFFED_OUT') return;
  err.handled = true;
  const icon = isBlockedError(err) ? 'block' : isRateLimitError(err) ? 'hourglass_top' : 'error';
  showAppToast(friendlyErrorMessage(err, fallback), icon);
}
