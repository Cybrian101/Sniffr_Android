// End-of-account helpers shared by the delete-account modal, the
// account_deleted socket event and the app-level "account deleted" notice.

// Fired once the signed-in account has been deleted (on this device or
// another); AccountDeletedNotice shows the final message.
export const ACCOUNT_DELETED_EVENT = 'sniffr:account-deleted';

// Removes every key this app stores (all start with "sniffr_") from both
// localStorage and sessionStorage. Safe to call more than once.
export function clearSniffrStorage() {
  for (const storage of [window.localStorage, window.sessionStorage]) {
    try {
      const keys = [];
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && key.startsWith('sniffr_')) keys.push(key);
      }
      keys.forEach(key => storage.removeItem(key));
    } catch {
      // Storage can be unavailable (private mode, blocked site data).
    }
  }
}
