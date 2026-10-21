import { BLOCKED_MESSAGE, RATE_LIMIT_MESSAGE, isBlockedError, isRateLimitError } from '../utils/appToast';
// VITE_API_URL unset (dev): falls back to same-origin '/api', proxied by Vite to the backend (see vite.config.js).
// VITE_API_URL set (Vercel prod build / Capacitor APK): talks to the deployed backend directly, bypassing the dev-only proxy.
const API_ORIGIN = import.meta.env.VITE_API_URL || window.location.origin;
const BASE_URL = `${API_ORIGIN}/api`;

let accessToken = null;
let refreshPromise = null;
let onAuthFailure = null;

// The access token is short-lived; it's kept next to the (long-lived)
// refresh token so a reload can skip the refresh round-trip while it's still
// valid (see getStoredAccessToken / AuthContext).
const ACCESS_TOKEN_KEY = 'sniffr_access_token';
function persistAccessToken(token) {
  try {
    if (token) localStorage.setItem(ACCESS_TOKEN_KEY, token);
    else localStorage.removeItem(ACCESS_TOKEN_KEY);
  } catch { /* storage unavailable: memory only */ }
}
export function setAccessToken(token) { accessToken = token; persistAccessToken(token); }
export function getAccessToken() { return accessToken; }

// The stored access token if it's still valid for at least another minute
// (its exp claim), else null.
export function getStoredAccessToken() {
  try {
    const token = localStorage.getItem(ACCESS_TOKEN_KEY);
    if (!token) return null;
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload?.exp && payload.exp * 1000 - Date.now() > 60 * 1000 ? token : null;
  } catch {
    return null;
  }
}
export function setOnAuthFailure(fn) { onAuthFailure = fn; }

async function refreshTokens() {
  const refreshToken = localStorage.getItem('sniffr_refresh_token');
  if (!refreshToken) {
    const err = new Error('No refresh token');
    err.isAuthError = true;
    throw err;
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
  } catch (netErr) {
    const err = new Error('Network error during refresh');
    err.isNetworkError = true;
    throw err;
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const err = new Error(data.message || 'Refresh failed');
    err.isAuthError = true;
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  setAccessToken(data.accessToken);
  localStorage.setItem('sniffr_refresh_token', data.refreshToken);
  return data.accessToken;
}

// ── Shared, deduplicated refresh entry point ──────────────────────
// IMPORTANT: this is the ONLY place in the whole app that should ever
// call /auth/refresh. Both the automatic 401-retry logic in request()
// below AND AuthContext's startup session-restore logic call THIS
// function, which shares the same `refreshPromise` guard. If two
// refresh attempts were ever triggered independently (e.g. one from
// AuthContext's mount effect and one from a 401 on some other request
// firing around the same moment), the SECOND call to the backend would
// get rejected -- refresh tokens are single-use/rotating server-side --
// which would then trigger onAuthFailure() and silently log the user
// back out immediately after a fresh login. Routing every refresh
// through this one deduplicated function eliminates that race entirely.
export async function ensureFreshSession() {
  if (!refreshPromise) {
    refreshPromise = refreshTokens().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

async function request(url, options = {}) {
  const headers = { ...options.headers };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const deviceToken = localStorage.getItem('sniffr_device_token');
  if (deviceToken) headers['x-device-token'] = deviceToken;
  if (!(options.body instanceof FormData)) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
  }

  let res;
  try {
    res = await fetch(`${BASE_URL}${url}`, { ...options, headers });
  } catch (netErr) {
    const err = new Error('Network request failed');
    err.isNetworkError = true;
    throw err;
  }

  // Auto-refresh on token expiry
  if (res.status === 401) {
    const data = await res.json().catch(() => ({}));
    // Only an actually-expired/invalid ACCESS token should trigger a
    // refresh-and-retry. This used to also match on bare `res.status === 401`
    // (redundant since we're already inside that check), which meant EVERY
    // 401 -- including a wrong-password login attempt -- fell into this
    // branch. With no refresh token yet during a login attempt, that threw
    // "No refresh token" and silently replaced the real "wrong credentials"
    // error from the server before it ever reached the UI.
    // M19: NO_TOKEN included on purpose -- AuthContext's offline-startup
    // fallback (a network error during the initial /auth/refresh leaves the
    // in-memory access token empty, but restores the cached user from
    // localStorage so the app still looks logged in) means the very next
    // real request after connectivity returns goes out with no
    // Authorization header at all, getting NO_TOKEN back, not
    // TOKEN_EXPIRED/INVALID_TOKEN. Previously that fell straight to the
    // "any other 401" branch below and force-logged the user out through
    // onAuthFailure -- even though their refresh token was still perfectly
    // valid. Attempting a refresh here is the correct response either way:
    // if the refresh token really is gone/invalid too, ensureFreshSession
    // throws isAuthError and the catch below still logs out correctly.
    if (data.error === 'TOKEN_EXPIRED' || data.error === 'INVALID_TOKEN' || data.error === 'NO_TOKEN') {
      try {
        await ensureFreshSession();
        headers['Authorization'] = `Bearer ${accessToken}`;
        res = await fetch(`${BASE_URL}${url}`, { ...options, headers });
      } catch (err) {
        if (err.isAuthError && onAuthFailure) {
          onAuthFailure();
        }
        throw err;
      }
    } else {
      // Any other 401 (e.g. bad login credentials) -- preserve the
      // server's error code so callers like AuthPage can tell "wrong
      // password" apart from "your session died", and don't treat a
      // failed login attempt as a reason to log the user out.
      const err = new Error(data.message || 'Unauthorized');
      if (data.error) err.code = data.error;
      if (onAuthFailure && data.error !== 'NOT_FOUND' && data.error !== 'BAD_PASSWORD') onAuthFailure();
      throw err;
    }
  }

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({ message: 'Request failed' }));
    const error = new Error(errBody.message || errBody.error || 'Request failed');
    // Preserve structured error data (e.g., validation errors array)
    if (errBody.errors) error.errors = errBody.errors;
    if (errBody.error) error.code = errBody.error;
    // Blocked users and rate limits read the same everywhere: any screen that
    // shows err.message (or uses utils/appToast.js) gets the friendly text.
    // Callers that need details still have err.code and err.body.
    if (res.status === 429 && !error.code) error.code = 'RATE_LIMIT';
    if (isBlockedError(error)) error.message = BLOCKED_MESSAGE;
    else if (isRateLimitError(error)) error.message = RATE_LIMIT_MESSAGE;
    // M11: a 429's cooldown/retry timestamp only ever lived in err.body --
    // EmailVerifyBanner.jsx (and the PawPrint cooldown UI) reads it straight
    // off `err`, so without this it always saw `undefined` and never
    // started its countdown, regardless of which 429 shape the server sent
    // (the per-account COOLDOWN response uses `cooldownUntil`; the generic
    // per-IP RATE_LIMIT response uses `retryAfter` seconds instead).
    if (errBody.cooldownUntil !== undefined) error.cooldownUntil = errBody.cooldownUntil;
    if (errBody.retryAfter !== undefined) error.retryAfter = errBody.retryAfter;
    if (errBody.waitSeconds !== undefined) error.waitSeconds = errBody.waitSeconds;
    // The whole body, for callers that need extra fields (attemptsRemaining,
    // retryAfterSeconds...). Not `data`: existing callers read err.data.
    error.body = errBody;
    // Anything aimed at a deleted ("SniffedOut") account: unless the calling
    // screen handles it itself (isSniffedOutError marks it), the app-wide
    // SniffedOutToast shows a friendly message. Deferred so the caller's
    // catch runs first.
    // The account has no pet yet and this action needs one: the app-wide
    // NoPetPrompt asks them to create it (components/NoPetPrompt.jsx).
    if (error.code === 'NO_PET') {
      setTimeout(() => window.dispatchEvent(new CustomEvent('sniffr:no-pet')), 0);
    }
    if (error.code === 'SNIFFED_OUT') {
      setTimeout(() => {
        if (!error.handled) window.dispatchEvent(new CustomEvent('sniffr:sniffed-out', { detail: { message: errBody.message } }));
      }, 0);
    }
    // QUOTA_EXCEEDED specifically (see utils/premiumErrors.js's
    // quotaUpsellCopy) needs these to show concrete "X of Y used" copy.
    if (errBody.usedBytes !== undefined) error.usedBytes = errBody.usedBytes;
    if (errBody.quotaBytes !== undefined) error.quotaBytes = errBody.quotaBytes;
    throw error;
  }
  return res.json();
}

const api = {
  get: (url) => request(url),
  post: (url, body) => request(url, {
    method: 'POST',
    body: body instanceof FormData ? body : JSON.stringify(body)
  }),
  put: (url, body) => request(url, {
    method: 'PUT',
    body: body instanceof FormData ? body : JSON.stringify(body)
  }),
  patch: (url, body) => request(url, {
    method: 'PATCH',
    body: JSON.stringify(body)
  }),
  delete: (url) => request(url, { method: 'DELETE' }),

  // File upload helper
  upload: (url, file, fields = {}) => {
    const form = new FormData();
    form.append('media', file);
    Object.entries(fields).forEach(([k, v]) => form.append(k, v));
    return request(url, { method: 'POST', body: form });
  }
};

export default api;

// TEMPORARY (5A.2 verification only) -- exposes the real api object, with
// its real in-memory accessToken and ensureFreshSession() refresh flow
// unchanged, so it can be called from the devtools console against a live
// logged-in session for manual testing. Dev-build only (import.meta.env.DEV
// is false in a production build, so this never ships). Safe to delete this
// block once 5A.2 is confirmed -- nothing else in the app reads
// window.__sniffrDebugApi.
if (import.meta.env.DEV) {
  window.__sniffrDebugApi = api;
}