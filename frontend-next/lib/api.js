/**
 * The ONLY way the frontend talks to the REST API.
 *
 * Where the tokens live, and why:
 *   - The ACCESS token lives in a module variable (memory). It isn't in
 *     localStorage or sessionStorage, so injected script can't read it from
 *     storage, and it vanishes when the tab closes.
 *   - The REFRESH token lives in an httpOnly cookie that JavaScript can't
 *     read at all. The browser attaches it automatically, and only to
 *     /api/auth/* requests (the cookie's Path).
 *   - On page load there is no access token, so AuthProvider calls
 *     refreshSession() once, and the cookie gets us a new access token.
 *
 * When a call fails with 401 because the access token expired, api() refreshes
 * ONCE and retries ONCE. If the refresh also fails, the session is over and
 * we tell AuthProvider (onAuthLost) to show the logged-out UI.
 */

let accessToken = null;
let refreshInFlight = null;
let onAuthLost = () => {};
/** @type {Set<(token: string | null) => void>} */
const tokenListeners = new Set();

/** Every change to the access token goes through here, so listeners (the socket) hear about it. */
function setAccessToken(token) {
  accessToken = token;
  for (const listener of tokenListeners) listener(token);
}

/**
 * Subscribe to access-token changes. The socket uses this to send the new
 * token to the server (auth:renew) so a long-lived socket isn't cut off when
 * the old token expires.
 * @param {(token: string | null) => void} listener
 * @returns {() => void} unsubscribe
 */
export function onAccessTokenChange(listener) {
  tokenListeners.add(listener);
  return () => tokenListeners.delete(listener);
}

/** Typed error carrying the API's { error: { code, message, details } }. */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status (0 = network failure)
   * @param {string} code stable error code from the API, e.g. INVALID_CREDENTIALS
   * @param {string} message human-readable message
   * @param {unknown} [details] e.g. validation issues
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** AuthProvider registers a callback for "the session is gone". */
export function setAuthLostHandler(fn) {
  onAuthLost = fn;
}

/** Turn a fetch Response into data, or throw ApiError. */
async function parse(res) {
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    // Not JSON, e.g. the Next.js proxy's plain-text 500 when the API is down.
  }
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(
      res.status,
      e?.code ?? (res.status >= 500 ? 'SERVER_UNAVAILABLE' : 'HTTP_ERROR'),
      e?.message ?? 'The server is unavailable, try again shortly',
      e?.details,
    );
  }
  return data;
}

/** One HTTP request to /api{path}, with no retry logic. */
async function request(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Could not reach the server');
  }
  return parse(res);
}

/**
 * Get a new access token using the refresh cookie.
 *
 * Two layers of "only one refresh at a time" matter here, because refresh
 * tokens are single-use (rotation) and the server treats a second use of
 * the same token as theft (it revokes the session):
 *   1. Within this tab: concurrent callers share one in-flight promise.
 *      (React StrictMode runs effects twice in dev, which would otherwise
 *      fire two refreshes.)
 *   2. Across tabs: the Web Locks API (navigator.locks) runs refreshes
 *      from different tabs one after another. Tab B's request starts only
 *      after tab A got its response, so tab B sends the NEW cookie.
 *
 * @returns {Promise<{ user: object, accessToken: string }>}
 */
export function refreshSession() {
  refreshInFlight ??= (async () => {
    const run = () => request('/auth/refresh', { method: 'POST' });
    try {
      const data = globalThis.navigator?.locks
        ? await navigator.locks.request('zcoder-auth-refresh', run)
        : await run();
      setAccessToken(data.accessToken);
      return data;
    } catch (err) {
      setAccessToken(null);
      throw err;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

const RETRYABLE_AUTH_CODES = new Set(['AUTH_EXPIRED', 'AUTH_MISSING', 'AUTH_INVALID']);

/**
 * Authenticated API call with one automatic refresh-and-retry.
 * @param {string} path e.g. '/users/me'
 * @param {{ method?: string, body?: unknown }} [options]
 */
export async function api(path, options = {}) {
  try {
    return await request(path, { ...options, token: accessToken });
  } catch (err) {
    if (!(err instanceof ApiError) || err.status !== 401 || !RETRYABLE_AUTH_CODES.has(err.code)) throw err;
    try {
      await refreshSession();
    } catch (refreshErr) {
      if (refreshErr instanceof ApiError && refreshErr.status === 401) onAuthLost();
      throw refreshErr;
    }
    return request(path, { ...options, token: accessToken });
  }
}

/** Endpoints that create or end a session. They store or clear the access token. */
export const authApi = {
  async signup(input) {
    const data = await request('/auth/signup', { method: 'POST', body: input });
    setAccessToken(data.accessToken);
    return data;
  },
  async login(input) {
    const data = await request('/auth/login', { method: 'POST', body: input });
    setAccessToken(data.accessToken);
    return data;
  },
  async logout() {
    try {
      await request('/auth/logout', { method: 'POST' });
    } finally {
      setAccessToken(null);
    }
  },
};

/** For the Socket.IO handshake (Phase 2): the current in-memory access token. */
export function getAccessToken() {
  return accessToken;
}
