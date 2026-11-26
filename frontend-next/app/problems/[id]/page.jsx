'use client';

/**
 * /problems/[id]: one problem, its answers (newest first, "Load older"),
 * and a form to answer. Plain text only (React escapes it).
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import RequireAuth from '@/components/RequireAuth';
import { api } from '@/lib/api';

function Problem({ id }) {
  const [data, setData] = useState({ state: 'loading', problem: null, answers: [], cursor: null, error: '' });
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');

  useEffect(() => {
    let cancelled = false;
    api(`/problems/${id}`)
      .then((r) => !cancelled && setData({ state: 'ready', problem: r.problem, answers: r.answers, cursor: r.nextCursor, error: '' }))
      .catch((err) => !cancelled && setData((d) => ({ ...d, state: 'error', error: err.code === 'PROBLEM_NOT_FOUND' ? 'This problem does not exist, or it is private.' : err.message })));
    return () => {
      cancelled = true;
    };
  }, [id]);

  async function loadOlder() {
    try {
      const r = await api(`/problems/${id}/answers?before=${data.cursor}`);
      setData((d) => ({ ...d, answers: [...d.answers, ...r.answers], cursor: r.nextCursor }));
    } catch (err) {
      setPostError(err.message);
    }
  }

  async function answer(e) {
    e.preventDefault();
    if (!draft.trim()) return;
    setPosting(true);
    setPostError('');
    try {
      const { answer: created } = await api(`/problems/${id}/answers`, { method: 'POST', body: { body: draft } });
      setData((d) => ({ ...d, answers: [created, ...d.answers], problem: { ...d.problem, answerCount: d.problem.answerCount + 1 } }));
      setDraft('');
    } catch (err) {
      setPostError(err.message);
    } finally {
      setPosting(false);
    }
  }

  if (data.state === 'loading') return <p className="text-slate-400">Loading…</p>;
  if (data.state === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-rose-300">{data.error}</p>
        <Link href="/problems" className="text-emerald-400 hover:underline">
          Back to problems
        </Link>
      </div>
    );
  }

  const p = data.problem;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/problems" className="text-sm text-slate-400 hover:text-slate-200">
        ← Problems
      </Link>
      <article className="space-y-3 rounded-lg border border-slate-800 bg-slate-900 p-5">
        <h1 className="text-2xl font-semibold">{p.title}</h1>
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
          <span>{p.authorName}</span>
          <span>· {new Date(p.createdAt).toLocaleString()}</span>
          {p.platform && <span>· {p.platform}</span>}
          {!p.isPublic && <span className="rounded bg-slate-800 px-1.5 py-0.5 text-slate-300">private</span>}
          {p.tags.map((t) => (
            <span key={t} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-emerald-300">
              {t}
            </span>
          ))}
        </div>
        <p className="whitespace-pre-wrap break-words font-mono text-sm text-slate-200">{p.body}</p>
      </article>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">
          {p.answerCount} answer{p.answerCount === 1 ? '' : 's'}
        </h2>
        <form onSubmit={answer} className="space-y-2">
          <label htmlFor="answer" className="sr-only">
            Your answer
          </label>
          <textarea
            id="answer"
            rows={4}
            maxLength={10000}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Write an answer…"
            className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-sm outline-none focus:border-emerald-500"
          />
          {postError && <p className="text-sm text-rose-300">{postError}</p>}
          <button type="submit" disabled={posting || !draft.trim()} className="rounded-md bg-emerald-500 px-4 py-2 font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50">
            {posting ? 'Posting…' : 'Post answer'}
          </button>
        </form>
        {data.answers.length === 0 && <p className="text-sm text-slate-500">No answers yet.</p>}
        <ul className="space-y-3">
          {data.answers.map((a) => (
            <li key={a.id} className="rounded-lg border border-slate-800 bg-slate-900 p-4">
              <div className="text-xs text-slate-500">
                {a.authorName} · {new Date(a.createdAt).toLocaleString()}
              </div>
              <p className="mt-1 whitespace-pre-wrap break-words font-mono text-sm text-slate-200">{a.body}</p>
            </li>
          ))}
        </ul>
        {data.cursor && (
          <button type="button" onClick={loadOlder} className="rounded-md border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800">
            Load older answers
          </button>
        )}
      </section>
    </div>
  );
}

export default function ProblemPage() {
  const { id } = useParams();
  return (
    <RequireAuth>
      <Problem id={id} />
    </RequireAuth>
  );
}
