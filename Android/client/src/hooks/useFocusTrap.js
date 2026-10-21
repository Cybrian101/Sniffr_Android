import { useEffect, useRef } from 'react';

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Section 5: "modals lack robust focus trapping" -- opt-in rather than
// forced on every Portal-rendered subtree (Portal.jsx is used by 13+ files,
// several of them full pages that layer multiple different kinds of
// floating UI through it, not all of it a true modal dialog; applying this
// blindly everywhere risked silently stealing focus from something
// mid-interaction with no way to verify the fallout without a browser).
// Attach the returned ref to the modal's outermost element. While `active`
// is true: moves focus into the modal on mount, keeps Tab/Shift+Tab cycling
// within it, and restores focus to whatever had it before on unmount/close
// -- the three things a WAI-ARIA dialog needs for keyboard users.
export default function useFocusTrap(active = true) {
  const containerRef = useRef(null);
  const previouslyFocusedRef = useRef(null);

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    previouslyFocusedRef.current = document.activeElement;

    const focusables = () => Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(el => el.offsetParent !== null); // skip hidden elements

    // Move focus in: prefer an element already marked autoFocus, else the
    // first focusable, else the container itself (tabIndex -1, set below)
    // so screen readers still announce the dialog opened.
    const toFocus = container.querySelector('[autofocus]') || focusables()[0] || container;
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    toFocus.focus();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) { e.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    container.addEventListener('keydown', onKeyDown);

    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Only restore if focus is still somewhere inside this modal (or on
      // the body) -- if the app already moved focus elsewhere on its own
      // (e.g. navigating away), don't fight that.
      const prev = previouslyFocusedRef.current;
      if (prev && typeof prev.focus === 'function' &&
          (document.activeElement === document.body || container.contains(document.activeElement))) {
        prev.focus();
      }
    };
  }, [active]);

  return containerRef;
}
