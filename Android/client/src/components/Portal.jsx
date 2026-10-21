import { createPortal } from 'react-dom';
import useFocusTrap from '../hooks/useFocusTrap';

// Renders children into #modal-root (a sibling of #root, declared in index.html)
// instead of wherever the calling component happens to sit in the page tree.
//
// Why this exists: a "position: fixed" element's containing block is the
// viewport ONLY if every ancestor has a computed transform/filter/
// backdrop-filter/perspective/will-change/contain of `none`/`auto`. Sniffr's
// pages are full of entrance/hover animations that legitimately use those
// properties, so any modal rendered inline as a descendant of a page is one
// future animation tweak away from silently losing real-viewport positioning
// (exactly what happened with `.page-enter` and `.message-enter-animate`).
// Portaling to a DOM node outside #root removes the possibility entirely,
// regardless of what any current or future ancestor's CSS does.
//
// trapFocus (section 5: "modals lack robust focus trapping") is opt-in, not
// automatic -- Portal is used by 13+ files, several of them full pages
// layering multiple different kinds of floating UI through it (not all of
// it a true modal dialog), so forcing focus-stealing behavior on every
// single usage risked breaking something no browser was available here to
// verify. Pass trapFocus on an actual modal dialog to wrap it in a
// keyboard focus trap (see hooks/useFocusTrap.js).
export default function Portal({ children, trapFocus = false }) {
  const root = document.getElementById('modal-root') || document.body;
  const trapRef = useFocusTrap(trapFocus);
  if (!trapFocus) return createPortal(children, root);
  return createPortal(<div ref={trapRef}>{children}</div>, root);
}
