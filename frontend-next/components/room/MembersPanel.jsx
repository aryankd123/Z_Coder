/**
 * Members with live presence. `members` comes from the REST session; `online`
 * from the socket's presence:state (one entry per user, however many tabs).
 */
export default function MembersPanel({ members, online, meId }) {
  const onlineById = new Map(online.map((u) => [u.userId, u]));
  // Someone who joined after this page loaded isn't in the REST snapshot yet,
  // but presence knows them.
  const known = new Set(members.map((m) => m.userId));
  const all = [...members, ...online.filter((u) => !known.has(u.userId))];
  // Online first, then by name.
  const sorted = all.sort(
    (a, b) => Number(onlineById.has(b.userId)) - Number(onlineById.has(a.userId)) || a.name.localeCompare(b.name),
  );

  return (
    <section aria-label="Members" className="rounded-lg border border-slate-800 bg-slate-900 p-3">
      <h2 className="mb-2 text-sm font-semibold text-slate-300">
        Members <span className="font-normal text-slate-500">({onlineById.size} online)</span>
      </h2>
      <ul className="space-y-1 text-sm">
        {sorted.map((m) => {
          const live = onlineById.get(m.userId);
          return (
            <li key={m.userId} className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={`h-2 w-2 shrink-0 rounded-full ${live ? 'bg-emerald-400' : 'bg-slate-600'}`}
                  aria-label={live ? 'online' : 'offline'}
                />
                <span className="truncate">
                  {m.name}
                  {m.userId === meId && <span className="text-slate-500"> (you)</span>}
                </span>
              </span>
              <span className="shrink-0 text-xs text-slate-500">
                {live?.role ?? m.role}
                {live?.tabs > 1 && ` · ${live.tabs} tabs`}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
