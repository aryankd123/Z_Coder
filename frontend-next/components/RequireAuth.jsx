'use client';

/**
 * Client-side guard for pages that need a logged-in user.
 *
 * This is UX, not security. It saves the user from seeing a page that
 * would only show errors. The real protection is on the server: every
 * protected API route runs requireAuth, so an attacker who bypasses this
 * component still gets 401s.
 */
import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export default function RequireAuth({ children }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'anonymous') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status !== 'authenticated') {
    return <p className="p-8 text-center text-slate-400">Loading…</p>;
  }
  return children;
}
