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
 * uses NEXT_PUBLIC_SOCKET_URL instead (from Phase 2).
 */
const API_ORIGIN = process.env.API_ORIGIN ?? 'http://localhost:4000';

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
