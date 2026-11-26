/**
 * The browser only ever talks to THIS origin. Requests to /api/* are proxied
 * by the Next.js server to the Express API.
 *
 * Why proxy instead of calling the API directly?
 *   In production the web app (Vercel) and the API (Render) are different
 *   sites. A refresh-token cookie set by the API would be a THIRD-PARTY
 *   cookie, which Safari and Firefox block by default. Through this rewrite
 *   the browser sees /api/... on its own origin, so the cookie is first-party.
 *   CORS also disappears for REST calls, because they're same-origin.
 *
 * API_ORIGIN is server-only (no NEXT_PUBLIC_ prefix), so it never ships to
 * the browser. WebSockets can't go through this rewrite on Vercel; the socket
 * uses NEXT_PUBLIC_SOCKET_URL instead.
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

/**
 * Security headers on every page. Deliberately conservative: no
 * Content-Security-Policy yet, because Monaco loads from the jsDelivr CDN and
 * creates web workers, and a CSP that breaks the editor is worse than none.
 * A CSP is a planned follow-up.
 */
const SECURITY_HEADERS = [
  { key: 'X-Content-Type-Options', value: 'nosniff' }, // no MIME sniffing
  { key: 'X-Frame-Options', value: 'DENY' }, // no clickjacking via iframes
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' }, // room URLs don't leak to other sites
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Next 16 writes an AGENTS.md on every `next dev`; this repo doesn't use
  // one, so turn the generator off.
  agentRules: false,
  async headers() {
    return [{ source: '/:path*', headers: SECURITY_HEADERS }];
  },
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
