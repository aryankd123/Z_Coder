/**
 * Only allow redirects to paths on THIS site.
 *
 * /login?next=... is user-controlled. Without this check,
 * /login?next=https://evil.example would send a freshly logged-in user to an
 * attacker's look-alike page (an "open redirect"). "//evil.example" is also
 * rejected: browsers treat it as protocol-relative, i.e. another site.
 *
 * @param {string | null} next
 * @param {string} [fallback]
 */
export function safeRedirect(next, fallback = '/') {
  if (typeof next !== 'string') return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  return next;
}
