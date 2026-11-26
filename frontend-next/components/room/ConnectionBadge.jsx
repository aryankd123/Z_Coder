const STYLES = {
  connected: { dot: 'bg-emerald-400', text: 'Live' },
  connecting: { dot: 'bg-amber-400 animate-pulse', text: 'Connecting…' },
  reconnecting: { dot: 'bg-amber-400 animate-pulse', text: 'Reconnecting…' },
};

/** Socket connection state, so users know whether their edits and messages are live. */
export default function ConnectionBadge({ connection }) {
  const s = STYLES[connection] ?? STYLES.connecting;
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-slate-700 px-2.5 py-1 text-xs text-slate-300" role="status">
      <span className={`h-2 w-2 rounded-full ${s.dot}`} aria-hidden="true" />
      {s.text}
    </span>
  );
}
