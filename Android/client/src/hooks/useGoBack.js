import { useNavigate, useLocation } from 'react-router-dom';

// Plain `navigate(-1)` assumes there's always a previous entry in THIS
// app's history, which is false for a page reached as the first screen of
// the session -- a shared pet-profile link (/kitty), a /privacy or /terms
// link from outside the app, a PWA/deep-link launch, etc. In that case
// history.go(-1) just does nothing and the back button looks dead.
//
// react-router only ever gives the very first entry of a session the key
// 'default'; every entry it pushes or replaces itself gets a real key --
// so checking location.key doubles as "is there anywhere in OUR history to
// go back to."
export default function useGoBack(fallback = '/') {
  const navigate = useNavigate();
  const location = useLocation();

  return () => {
    if (location.key === 'default') {
      navigate(fallback, { replace: true });
    } else {
      navigate(-1);
    }
  };
}
