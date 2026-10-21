// Lets a screen with its own local "sub-view" state (e.g. ChatPage's open
// conversation, which is just React state and never changes the URL) take
// the hardware back button first, before useAndroidBackButton's normal
// history-based handling runs. Closing that sub-view back to its own list
// is the correct "rollback" there, not browser history -- there's no route
// change for real history to undo.
let handler = null;

export function setBackOverride(fn) {
  handler = fn;
}

export function clearBackOverride(fn) {
  if (handler === fn) handler = null;
}

// Returns true if an override claimed and handled this back press.
export function consumeBackOverride() {
  if (!handler) return false;
  return handler() === true;
}
