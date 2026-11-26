'use client';

/**
 * /rooms: my rooms (most recently active first), create a room, join by code.
 * Everything goes through lib/api.js; the server decides what "my rooms" means.
 */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import RequireAuth from '@/components/RequireAuth';
import FormField from '@/components/FormField';
import { api } from '@/lib/api';
import { LANGUAGES, languageById } from '@/lib/languages';

const JOIN_ERRORS = {
  ROOM_NOT_FOUND: 'No room has that code.',
  ROOM_PASSWORD_REQUIRED: 'This room needs a password.',
  ROOM_PASSWORD_INVALID: 'Wrong room password.',
  ROOM_FULL: 'That room is full (20 members).',
  RATE_LIMITED: 'Too many failed attempts. Try again in a few minutes.',
};

const box = 'space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5';
const primary =
  'w-full rounded-md bg-emerald-500 py-2 font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50';

function CreateRoom() {
  const router = useRouter();
  const [form, setForm] = useState({ name: '', language: 'cpp', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { room } = await api('/rooms', { method: 'POST', body: form });
      router.push(`/rooms/${room.id}`);
    } catch (err) {
      setError(err.details?.[0] ? `${err.details[0].path}: ${err.details[0].message}` : err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={box}>
      <h2 className="text-lg font-semibold">Create a room</h2>
      {error && <p className="text-sm text-rose-300">{error}</p>}
      <FormField id="room-name" label="Name" required maxLength={60} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      <div className="space-y-1">
        <label htmlFor="room-lang" className="block text-sm font-medium text-slate-300">
          Language
        </label>
        <select
          id="room-lang"
          value={form.language}
          onChange={(e) => setForm({ ...form, language: e.target.value })}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2"
        >
          {LANGUAGES.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <FormField
        id="room-password"
        label="Password (optional)"
        type="password"
        autoComplete="new-password"
        value={form.password}
        onChange={(e) => setForm({ ...form, password: e.target.value })}
      />
      <button type="submit" disabled={busy || !form.name.trim()} className={primary}>
        {busy ? 'Creating…' : 'Create room'}
      </button>
    </form>
  );
}

function JoinRoom() {
  const router = useRouter();
  const [form, setForm] = useState({ inviteCode: '', password: '' });
  const [needsPassword, setNeedsPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { room } = await api('/rooms/join', { method: 'POST', body: form });
      router.push(`/rooms/${room.id}`);
    } catch (err) {
      if (err.code === 'ROOM_PASSWORD_REQUIRED' || err.code === 'ROOM_PASSWORD_INVALID') setNeedsPassword(true);
      setError(JOIN_ERRORS[err.code] ?? err.message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={box}>
      <h2 className="text-lg font-semibold">Join with a code</h2>
      {error && <p className="text-sm text-rose-300">{error}</p>}
      <FormField
        id="invite-code"
        label="Room code"
        required
        placeholder="K7QH2MXA"
        autoComplete="off"
        className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono uppercase tracking-widest outline-none focus:border-emerald-500"
        value={form.inviteCode}
        onChange={(e) => setForm({ ...form, inviteCode: e.target.value })}
      />
      {needsPassword && (
        <FormField
          id="join-password"
          label="Room password"
          type="password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      )}
      <button type="submit" disabled={busy || form.inviteCode.trim().length < 6} className={primary}>
        {busy ? 'Joining…' : 'Join room'}
      </button>
    </form>
  );
}

function MyRooms() {
  const [rooms, setRooms] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [state, setState] = useState('loading'); // loading | ready | error
  const [error, setError] = useState('');

  // First page on mount.
  useEffect(() => {
    let cancelled = false;
    api('/rooms')
      .then((page) => {
        if (cancelled) return;
        setRooms(page.rooms);
        setCursor(page.nextCursor);
        setState('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message);
        setState('error');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Next page on "Load more".
  const loadMore = useCallback(async () => {
    try {
      const page = await api(`/rooms?before=${encodeURIComponent(cursor)}`);
      setRooms((r) => [...r, ...page.rooms]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err.message);
    }
  }, [cursor]);

  if (state === 'loading') return <p className="text-slate-400">Loading your rooms…</p>;
  if (state === 'error') return <p className="text-rose-300">Could not load rooms: {error}</p>;
  if (rooms.length === 0) {
    return <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-slate-400">No rooms yet. Create one, or join with a code from a friend.</p>;
  }

  return (
    <div className="space-y-3">
      <ul className="grid gap-3 sm:grid-cols-2">
        {rooms.map((r) => (
          <li key={r.id}>
            <Link href={`/rooms/${r.id}`} className="block rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-emerald-600">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">{r.name}</span>
                <span className="shrink-0 rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{r.myRole}</span>
              </div>
              <p className="mt-1 text-sm text-slate-400">
                {languageById(r.language).label} · {r.memberCount} member{r.memberCount === 1 ? '' : 's'} · code{' '}
                <span className="font-mono">{r.inviteCode}</span>
              </p>
              <p className="mt-1 text-xs text-slate-500">Active {new Date(r.lastActiveAt).toLocaleString()}</p>
            </Link>
          </li>
        ))}
      </ul>
      {cursor && (
        <button type="button" onClick={loadMore} className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800">
          Load more
        </button>
      )}
    </div>
  );
}

export default function RoomsPage() {
  return (
    <RequireAuth>
      <div className="space-y-8">
        <h1 className="text-3xl font-bold tracking-tight">Rooms</h1>
        <div className="grid gap-4 md:grid-cols-2">
          <CreateRoom />
          <JoinRoom />
        </div>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">My rooms</h2>
          <MyRooms />
        </section>
      </div>
    </RequireAuth>
  );
}
