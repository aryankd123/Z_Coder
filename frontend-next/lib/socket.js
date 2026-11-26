/**
 * One Socket.IO connection per tab, shared by every room hook.
 *
 * Why it connects straight to the API (NEXT_PUBLIC_SOCKET_URL) instead of
 * going through the /api rewrite: Vercel's proxy can't carry WebSockets. So
 * the socket authenticates with the access token in the handshake
 * (`auth: { token }`), not with a cookie.
 *
 * Token lifecycle on a long-lived socket:
 *   - `auth` is a function, so EVERY (re)connect sends the current token.
 *   - About a minute before the token expires, we refresh it. api.js then
 *     notifies us and we send `auth:renew` so the server pushes back its
 *     disconnect timer. No reconnect, no flicker.
 *   - If the server rejects the handshake (AUTH_EXPIRED / AUTH_INVALID) or
 *     disconnects us for expiry, we refresh once and reconnect. If the
 *     refresh fails, the session is over and api.js logs the UI out.
 */
import { io } from 'socket.io-client';
import { getAccessToken, onAccessTokenChange, refreshSession } from './api';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL ?? 'http://localhost:4000';
const RENEW_BEFORE_EXPIRY_MS = 60_000;

let socket = null;
let renewTimer = null;
let authRetry = false;

/** Read `exp` from a JWT WITHOUT verifying it (the server verifies; we only need the time). */
function expiryOf(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** Refresh the access token shortly before it expires, while the socket is up. */
function scheduleRenew(token) {
  clearTimeout(renewTimer);
  const exp = token && expiryOf(token);
  if (!exp) return;
  const delay = Math.max(5_000, exp - Date.now() - RENEW_BEFORE_EXPIRY_MS);
  renewTimer = setTimeout(() => {
    if (socket?.connected) refreshSession().catch(() => {}); // listener below sends auth:renew
  }, delay);
}

async function reconnectWithFreshToken() {
  if (authRetry) return; // one retry per failure, never a loop
  authRetry = true;
  try {
    await refreshSession();
    socket.connect();
  } catch {
    // Refresh failed: api.js already told AuthProvider the session is gone.
  }
}

/** @returns {import('socket.io-client').Socket} */
export function getSocket() {
  if (socket) return socket;

  socket = io(SOCKET_URL, {
    autoConnect: false,
    transports: ['websocket', 'polling'],
    auth: (cb) => {
      const token = getAccessToken();
      if (token) return cb({ token });
      refreshSession()
        .then((data) => cb({ token: data.accessToken }))
        .catch(() => cb({}));
    },
  });

  socket.on('connect', () => {
    authRetry = false;
    scheduleRenew(getAccessToken());
  });

  socket.on('connect_error', (err) => {
    const code = err?.data?.code;
    if (code === 'AUTH_EXPIRED' || code === 'AUTH_INVALID' || code === 'AUTH_MISSING') reconnectWithFreshToken();
  });

  socket.on('disconnect', (reason) => {
    clearTimeout(renewTimer);
    // The server cut us off (token expiry). The client won't auto-reconnect
    // after a server-side disconnect, so do it ourselves with a fresh token.
    if (reason === 'io server disconnect') reconnectWithFreshToken();
  });

  onAccessTokenChange((token) => {
    if (!token) {
      socket.disconnect(); // logged out
      return;
    }
    if (socket.connected) {
      socket.emit('auth:renew', { token }, () => {});
      scheduleRenew(token);
    }
  });

  return socket;
}

/** Connect if not already connected or connecting. */
export function ensureConnected() {
  const s = getSocket();
  if (!s.connected && !s.active) s.connect();
  return s;
}

/**
 * emit with an ack and a timeout. Resolves with the server's
 * { ok, data } / { ok: false, error } reply; rejects on timeout.
 */
export function request(event, payload, timeoutMs = 8000) {
  return getSocket().timeout(timeoutMs).emitWithAck(event, payload);
}
