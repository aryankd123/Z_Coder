'use client';

/**
 * The room's shared console.
 *
 *   Run   -> POST /api/executions { roomId, language, source (from the Y.Doc), stdin }
 *            -> 202 { execution: queued }
 *   Live  -> socket 'execution:update' for EVERY run in the room, so all
 *            members watch queued -> running -> finished together.
 *   Fallback: the runner also polls GET /api/executions/:id until finished,
 *            in case the socket was reconnecting when the result went out.
 *
 * Code runs on the server (Judge0, or the dev-only local runner). No API key
 * is ever in the browser; v1 shipped its RapidAPI key in the bundle.
 */
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { languageById } from '@/lib/languages';

const VERDICTS = {
  OK: { label: 'OK', cls: 'bg-emerald-500/15 text-emerald-300' },
  COMPILE_ERROR: { label: 'Compile error', cls: 'bg-amber-500/15 text-amber-300' },
  RUNTIME_ERROR: { label: 'Runtime error', cls: 'bg-rose-500/15 text-rose-300' },
  TIME_LIMIT: { label: 'Time limit', cls: 'bg-orange-500/15 text-orange-300' },
  MEMORY_LIMIT: { label: 'Memory limit', cls: 'bg-orange-500/15 text-orange-300' },
  INTERNAL_ERROR: { label: 'Runner error', cls: 'bg-slate-700 text-slate-200' },
};

const RUN_ERRORS = {
  RATE_LIMITED: 'You are running code too often. Wait a minute.',
  QUEUE_FULL: 'The runner is busy. Try again in a moment.',
  ROOM_FORBIDDEN: 'Viewers cannot run code in this room.',
  VALIDATION_FAILED: 'The code or input is too large (64 KB max each) or empty.',
};

/** Newer run wins; for the same run, a later status wins (never go back from finished). */
const ORDER = { queued: 0, running: 1, finished: 2 };
function pick(current, incoming) {
  if (!current || incoming.id > current.id) return incoming;
  if (incoming.id === current.id && ORDER[incoming.status] >= ORDER[current.status]) return incoming;
  return current;
}

/**
 * @param {{ roomId: string, socket: import('socket.io-client').Socket, canRun: boolean,
 *   language: string, getSource: () => string }} props
 */
export default function RunPanel({ roomId, socket, canRun, language, getSource }) {
  const [stdin, setStdin] = useState('');
  const [run, setRun] = useState(null);
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // The tab the user picked, remembered per run; otherwise the default for that run.
  const [tabChoice, setTabChoice] = useState({ runId: null, tab: null });
  const pollGeneration = useRef(0);

  // The room's latest run, so a newcomer sees the console as everyone else does.
  useEffect(() => {
    let cancelled = false;
    api(`/rooms/${roomId}/executions?limit=1`)
      .then((page) => {
        if (!cancelled && page.executions[0]) setRun((r) => pick(r, page.executions[0]));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Live updates for every run in this room.
  useEffect(() => {
    const onUpdate = (e) => {
      if (e?.roomId === roomId) setRun((r) => pick(r, e));
    };
    socket.on('execution:update', onUpdate);
    return () => socket.off('execution:update', onUpdate);
  }, [socket, roomId]);

  // Bumping the generation cancels any poll loop in flight (new run or unmount).
  useEffect(
    () => () => {
      pollGeneration.current += 1;
    },
    [],
  );

  /** Polling fallback: ask for the run every 1.5 s until it's finished (max ~90 s). */
  async function pollUntilFinished(id) {
    const generation = ++pollGeneration.current;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await new Promise((r) => setTimeout(r, 1500));
      if (generation !== pollGeneration.current) return;
      try {
        const { execution } = await api(`/executions/${id}`);
        setRun((r) => pick(r, execution));
        if (execution.status === 'finished') return;
      } catch {
        return; // the socket may still deliver it
      }
    }
  }

  async function submit() {
    setError('');
    setSubmitting(true);
    try {
      const { execution } = await api('/executions', {
        method: 'POST',
        body: { roomId, language, source: getSource(), stdin },
      });
      setRun((r) => pick(r, execution));
      pollUntilFinished(execution.id);
    } catch (err) {
      setError(RUN_ERRORS[err.code] ?? err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const verdict = run?.verdict ? VERDICTS[run.verdict] : null;
  const outputs = { stdout: run?.stdout ?? '', stderr: run?.stderr ?? '', compile: run?.compileOutput ?? '' };
  // Default to where the problem is: the compiler's output for a compile
  // error, stderr when there's only stderr, otherwise stdout.
  const defaultTab = run?.verdict === 'COMPILE_ERROR' ? 'compile' : outputs.stderr && !outputs.stdout ? 'stderr' : 'stdout';
  const tab = tabChoice.runId === run?.id && tabChoice.tab ? tabChoice.tab : defaultTab;

  return (
    <section aria-label="Run code" className="flex h-64 shrink-0 flex-col rounded-lg border border-slate-800 bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 px-3 py-1.5 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            onClick={submit}
            disabled={!canRun || submitting}
            title={canRun ? `Run as ${languageById(language).label}` : 'Viewers cannot run code'}
            className="rounded-md bg-emerald-500 px-3 py-1 font-medium text-slate-950 hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? 'Sending…' : '▶ Run'}
          </button>
          {run && (
            <span className="truncate text-xs text-slate-400" aria-live="polite">
              {run.userName || 'Someone'} · {languageById(run.language).label} ·{' '}
              {run.status === 'finished' ? (
                <>
                  <span className={`rounded px-1.5 py-0.5 ${verdict?.cls ?? ''}`}>{verdict?.label ?? run.verdict}</span>
                  {run.timeMs !== null && ` · ${run.timeMs} ms`}
                </>
              ) : (
                <span className="text-amber-300">{run.status === 'queued' ? 'Queued…' : 'Running…'}</span>
              )}
            </span>
          )}
        </div>
        <div className="flex gap-1 text-xs" role="tablist">
          {[
            ['stdout', 'Output'],
            ['stderr', 'Errors'],
            ['compile', 'Compiler'],
          ].map(([key, label]) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTabChoice({ runId: run?.id ?? null, tab: key })}
              className={`rounded px-2 py-0.5 ${tab === key ? 'bg-slate-700 text-slate-100' : 'text-slate-400 hover:bg-slate-800'}`}
            >
              {label}
              {outputs[key] && key !== 'stdout' ? ' •' : ''}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="px-3 pt-1 text-xs text-rose-300">{error}</p>}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-2 p-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <label className="flex min-h-0 flex-col text-xs text-slate-400">
          Input (stdin)
          <textarea
            value={stdin}
            onChange={(e) => setStdin(e.target.value)}
            spellCheck={false}
            className="mt-1 min-h-0 flex-1 resize-none rounded border border-slate-700 bg-slate-950 p-2 font-mono text-xs text-slate-100 outline-none focus:border-emerald-500"
          />
        </label>
        <pre className="min-h-0 overflow-auto whitespace-pre-wrap break-words rounded border border-slate-800 bg-slate-950 p-2 font-mono text-xs text-slate-200">
          {run ? outputs[tab] || <span className="text-slate-500">(empty)</span> : <span className="text-slate-500">Run the code to see its output here. Everyone in the room sees each run.</span>}
        </pre>
      </div>
    </section>
  );
}
