'use client';

/**
 * Minimal protected page: proves the whole chain works end to end.
 *   RequireAuth -> api('/users/me') -> Next rewrite -> Express -> requireAuth -> MongoDB
 * If the access token has expired, api() refreshes once and retries.
 */
import { useEffect, useState } from 'react';
import RequireAuth from '@/components/RequireAuth';
import { api } from '@/lib/api';

function Profile() {
  const [state, setState] = useState({ loading: true, user: null, error: '' });

  useEffect(() => {
    api('/users/me')
      .then(({ user }) => setState({ loading: false, user, error: '' }))
      .catch((err) => setState({ loading: false, user: null, error: `${err.code}: ${err.message}` }));
  }, []);

  if (state.loading) return <p className="text-slate-400">Loading profile…</p>;
  if (state.error) return <p className="text-rose-300">Could not load profile ({state.error})</p>;

  const { user } = state;
  return (
    <div className="max-w-md space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-6">
      <h1 className="text-2xl font-semibold">{user.name}</h1>
      <dl className="grid grid-cols-3 gap-y-2 text-sm">
        <dt className="text-slate-400">Email</dt>
        <dd className="col-span-2">{user.email}</dd>
        <dt className="text-slate-400">Favourite language</dt>
        <dd className="col-span-2">{user.favLang ?? '-'}</dd>
        <dt className="text-slate-400">Member since</dt>
        <dd className="col-span-2">{new Date(user.createdAt).toLocaleDateString()}</dd>
      </dl>
    </div>
  );
}

export default function ProfilePage() {
  return (
    <RequireAuth>
      <Profile />
    </RequireAuth>
  );
}
