'use client';

/**
 * /problems: the Q&A board. Public feed or my problems (tabs), cursor
 * "Load more", and a form to ask a new problem.
 * All text is rendered as plain text (React escapes it): no HTML, no XSS.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import RequireAuth from '@/components/RequireAuth';
import FormField from '@/components/FormField';
import { api } from '@/lib/api';

function AskForm({ onCancel }) {
  const router = useRouter();
  const [form, setForm] = useState({ title: '', body: '', tags: '', platform: '', isPublic: true });
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    try {
      const tags = form.tags.split(',').map((t) => t.trim()).filter(Boolean);
      const { problem } = await api('/problems', { method: 'POST', body: { ...form, tags } });
      router.push(`/problems/${problem.id}`);
    } catch (err) {
      const byField = {};
      for (const d of err.details ?? []) byField[d.path.split('.')[0]] = d.message;
      setErrors(Object.keys(byField).length ? byField : { form: err.message });
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 rounded-lg border border-slate-800 bg-slate-900 p-5">
      <h2 className="text-lg font-semibold">Ask a problem</h2>
      {errors.form && <p className="text-sm text-rose-300">{errors.form}</p>}
      <FormField id="p-title" label="Title" required maxLength={150} value={form.title} error={errors.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
      <div className="space-y-1">
        <label htmlFor="p-body" className="block text-sm font-medium text-slate-300">
          Details
        </label>
        <textarea
          id="p-body"
          required
          rows={6}
          maxLength={10000}
          value={form.body}
          aria-invalid={Boolean(errors.body)}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
        />
        {errors.body && <p className="text-sm text-rose-400">{errors.body}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormField id="p-tags" label="Tags (comma-separated, max 5)" placeholder="dp, graphs" value={form.tags} error={errors.tags} onChange={(e) => setForm({ ...form, tags: e.target.value })} />
        <FormField id="p-platform" label="Platform (optional)" placeholder="LeetCode" maxLength={40} value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} />
      </div>
      <label className="flex items-center gap-2 text-sm text-slate-300">
        <input type="checkbox" checked={form.isPublic} onChange={(e) => setForm({ ...form, isPublic: e.target.checked })} />
        Public (uncheck to keep it as a private note)
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy} className="rounded-md bg-emerald-500 px-4 py-2 font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
          {busy ? 'Posting…' : 'Post'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-md border border-slate-700 px-4 py-2 hover:bg-slate-800">
          Cancel
        </button>
      </div>
    </form>
  );
}

function Feed({ scope }) {
  const [problems, setProblems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [state, setState] = useState('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api(`/problems?scope=${scope}`)
      .then((page) => {
        if (cancelled) return;
        setProblems(page.problems);
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
  }, [scope]);

  async function loadMore() {
    try {
      const page = await api(`/problems?scope=${scope}&before=${cursor}`);
      setProblems((p) => [...p, ...page.problems]);
      setCursor(page.nextCursor);
    } catch (err) {
      setError(err.message);
    }
  }

  if (state === 'loading') return <p className="text-slate-400">Loading…</p>;
  if (state === 'error') return <p className="text-rose-300">Could not load problems: {error}</p>;
  if (problems.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-slate-400">
        {scope === 'mine' ? "You haven't asked anything yet." : 'No problems yet. Be the first to ask one.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <ul className="space-y-3">
        {problems.map((p) => (
          <li key={p.id}>
            <Link href={`/problems/${p.id}`} className="block rounded-lg border border-slate-800 bg-slate-900 p-4 hover:border-emerald-600">
              <div className="flex items-start justify-between gap-3">
                <h3 className="font-medium">{p.title}</h3>
                <span className="shrink-0 text-xs text-slate-400">
                  {p.answerCount} answer{p.answerCount === 1 ? '' : 's'}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-sm text-slate-400">{p.body}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span>{p.authorName}</span>
                <span>· {new Date(p.createdAt).toLocaleDateString()}</span>
                {p.platform && <span>· {p.platform}</span>}
                {!p.isPublic && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">private</span>}
                {p.tags.map((t) => (
                  <span key={t} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">
                    {t}
                  </span>
                ))}
              </div>
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

export default function ProblemsPage() {
  const [scope, setScope] = useState('public');
  const [asking, setAsking] = useState(false);
  return (
    <RequireAuth>
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-3xl font-bold tracking-tight">Problems</h1>
          {!asking && (
            <button type="button" onClick={() => setAsking(true)} className="rounded-md bg-emerald-500 px-4 py-2 font-medium text-slate-950 hover:bg-emerald-400">
              Ask a problem
            </button>
          )}
        </div>
        {asking && <AskForm onCancel={() => setAsking(false)} />}
        <div className="flex gap-2 text-sm" role="tablist">
          {[
            ['public', 'Public feed'],
            ['mine', 'My problems'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={scope === key}
              onClick={() => setScope(key)}
              className={`rounded-md px-3 py-1.5 ${scope === key ? 'bg-slate-800 text-slate-100' : 'text-slate-400 hover:bg-slate-900'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <Feed key={scope} scope={scope} />
      </div>
    </RequireAuth>
  );
}
