import { Capacitor } from '@capacitor/core';

// True inside the Android app (Capacitor), false in a browser.
export function isNativeApp() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

// N2: share/invite links must be a real, publicly-reachable web URL --
// `window.location.origin` is a browser-only concept. In a normal browser
// it's correct (same origin the user is actually on), but inside the
// Capacitor Android app it resolves to the WebView's internal origin
// (https://localhost or capacitor://localhost), which nobody else can ever
// open. VITE_WEB_URL (set in client/.env.capacitor for the Android build;
// left blank for a normal web build, where window.location.origin is
// already correct) is the one place this is configured.
export function publicWebOrigin() {
  const configured = import.meta.env.VITE_WEB_URL;
  if (configured) return configured.replace(/\/$/, '');
  if (!isNativeApp()) return window.location.origin;
  // Last-resort fallback if VITE_WEB_URL wasn't set for a native build --
  // matches the production domain already referenced elsewhere in this
  // app (App.jsx's top-level pet-profile route, server's CORS allowlist).
  return 'https://app.sniffrweb.com';
}

// What to tell the user when location access was refused: the app's
// permission lives in the phone's settings, a website's in the browser's.
export function locationDeniedMessage() {
  return isNativeApp()
    ? "Allow location for Sniffr in your phone's Settings → Apps → Sniffr → Permissions."
    : 'Location permission was not granted. Allow location for this site in your browser settings and try again.';
}
