'use client';

import Link from 'next/link';
import { useAuth } from '@/lib/auth-context';

/** Features in build order. `ready` flips on as each phase ships. */
const FEATURES = [
  { title: 'Accounts', text: 'Sign up and log in. Sessions use short-lived JWTs plus rotating refresh tokens.', ready: true },
  { title: 'Rooms & live chat', text: 'Create a room, invite people with a code, chat in real time.', ready: true },
  { title: 'Shared editor', text: 'Everyone edits the same code at once, with live cursors (Yjs CRDT).', ready: true },
  { title: 'Run code', text: 'Run C++, Python and JavaScript on the server; the whole room sees the output.', ready: true },
  { title: 'Q&A board', text: 'Ask a problem, answer others, browse the public feed.', ready: false },
];

export default function HomePage() {
  const { status, user } = useAuth();

  if (status === 'loading') {
    return <p className="text-center text-slate-400">Loading…</p>;
  }

  return (
    <div className="space-y-10">
      <section className="space-y-4">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">
          {status === 'authenticated' ? `Welcome back, ${user.name}` : 'Code together, in real time.'}
        </h1>
        <p className="max-w-2xl text-slate-400">
          ZCoder is a collaborative coding platform: shared rooms with a live editor, chat, and server-side code
          execution.
        </p>
        {status === 'authenticated' && (
          <Link href="/rooms" className="inline-block rounded-md bg-emerald-500 px-4 py-2 font-medium text-slate-950 hover:bg-emerald-400">
            Go to my rooms
          </Link>
        )}
        {status === 'anonymous' && (
          <div className="flex gap-3">
            <Link href="/signup" className="rounded-md bg-emerald-500 px-4 py-2 font-medium text-slate-950 hover:bg-emerald-400">
              Create an account
            </Link>
            <Link href="/login" className="rounded-md border border-slate-700 px-4 py-2 hover:bg-slate-800">
              Log in
            </Link>
          </div>
        )}
      </section>

      <section className="grid gap-4 sm:grid-cols-2">
        {FEATURES.map((f) => (
          <div key={f.title} className="rounded-lg border border-slate-800 bg-slate-900 p-5">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{f.title}</h2>
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${
                  f.ready ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-400'
                }`}
              >
                {f.ready ? 'Live' : 'In progress'}
              </span>
            </div>
            <p className="mt-2 text-sm text-slate-400">{f.text}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
