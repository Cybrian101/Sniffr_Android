import { io } from 'socket.io-client';
import { getAccessToken, ensureFreshSession } from './api';

let socket = null;
// Dedupe: a flaky connection can fire several connect_error events in a
// row while one refresh is already in flight (ensureFreshSession itself
// also dedupes against any REST-triggered refresh, see api.js).
let refreshingForSocket = false;

export function connectSocket() {
  if (socket?.connected) return socket;
  // Same VITE_API_URL fallback as api.js, so the socket always targets the same backend as REST calls.
  const socketUrl = import.meta.env.VITE_API_URL || window.location.origin;
  socket = io(socketUrl, {
    // H7: a plain object here is captured ONCE, at this connectSocket() call,
    // and socket.io-client reuses that same object on every automatic
    // reconnection attempt afterward -- so a reconnect happening after the
    // access token's ~15min expiry kept sending the now-stale token and got
    // rejected. A function is re-invoked before EVERY (re)connection
    // attempt, so it always sends whatever getAccessToken() currently holds.
    auth: (cb) => cb({ token: getAccessToken() }),
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionAttempts: 10
  });

  // The server's authenticateSocket (middleware/auth.js) rejects an
  // expired/invalid token with next(new Error('Invalid token')) -- refresh
  // the access token proactively so the NEXT automatic reconnection attempt
  // (which reads getAccessToken() fresh, per the function above) has a
  // valid one instead of failing the same way every retry until the whole
  // reconnection budget (reconnectionAttempts: 10) is exhausted.
  socket.on('connect_error', async (err) => {
    if (err?.message !== 'Invalid token' || refreshingForSocket) return;
    refreshingForSocket = true;
    try {
      await ensureFreshSession();
    } catch {
      // No valid refresh token either -- nothing more a socket reconnect can
      // do; the next REST call will surface the real "logged out" state
      // through the normal 401 -> onAuthFailure path.
    } finally {
      refreshingForSocket = false;
    }
  });

  return socket;
}

export function getSocket() { return socket; }

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners('connect_error');
    socket.disconnect();
    socket = null;
  }
}
