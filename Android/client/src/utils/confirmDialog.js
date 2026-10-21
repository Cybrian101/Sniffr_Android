// In-app replacement for window.confirm() (components/ConfirmDialogHost.jsx,
// mounted once in App.jsx). Never use window.confirm/alert/prompt directly --
// they're unstyled, block the whole tab, and can't be skinned to match the
// app.

export const CONFIRM_DIALOG_EVENT = 'sniffr:confirm-dialog';

// Resolves true if the user confirmed, false if they cancelled or dismissed.
export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false, icon = 'help' }) {
  return new Promise((resolve) => {
    window.dispatchEvent(new CustomEvent(CONFIRM_DIALOG_EVENT, {
      detail: { title, message, confirmLabel, cancelLabel, danger, icon, resolve }
    }));
  });
}
