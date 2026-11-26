'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth-context';

export default function Navbar() {
  const { status, user, logout } = useAuth();
  const router = useRouter();

  async function handleLogout() {
    await logout();
    router.replace('/login');
  }

  return (
    <header className="border-b border-slate-800 bg-slate-900/70 backdrop-blur">
      <nav className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          <span className="text-emerald-400">Z</span>Coder
        </Link>

        <div className="flex items-center gap-3 text-sm">
          {status === 'authenticated' && (
            <>
              <Link href="/rooms" className="rounded-md px-3 py-1.5 hover:bg-slate-800">
                Rooms
              </Link>
              <Link href="/problems" className="rounded-md px-3 py-1.5 hover:bg-slate-800">
                Problems
              </Link>
              <Link href="/profile" className="hidden text-slate-400 hover:text-slate-200 sm:inline">
                {user.name}
              </Link>
              <button
                type="button"
                onClick={handleLogout}
                className="rounded-md border border-slate-700 px-3 py-1.5 hover:bg-slate-800"
              >
                Log out
              </button>
            </>
          )}
          {status === 'anonymous' && (
            <>
              <Link href="/login" className="rounded-md px-3 py-1.5 hover:bg-slate-800">
                Log in
              </Link>
              <Link href="/signup" className="rounded-md bg-emerald-500 px-3 py-1.5 font-medium text-slate-950 hover:bg-emerald-400">
                Sign up
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
