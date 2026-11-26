'use client';

/**
 * Room chat: history with a "Load older" button at the top (cursor
 * pagination), live messages, and a composer. Messages render as plain text:
 * React escapes them, so a message can't inject HTML or script.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const MAX_LENGTH = 2000;

function time(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function ChatPanel({ messages, hasMore, loadingOlder, onLoadOlder, onSend, meId, disabled }) {
  const [draft, setDraft] = useState('');
  const listRef = useRef(null);
  const stickToBottom = useRef(true);
  const prevHeight = useRef(0);
  const prevFirstKey = useRef(null);

  // Keep the view pinned to the newest message unless the user scrolled up.
  // When older messages are prepended, keep the visible message in place.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const firstKey = messages[0]?.id ?? messages[0]?.clientMsgId ?? null;
    if (prevFirstKey.current && firstKey !== prevFirstKey.current && !stickToBottom.current) {
      el.scrollTop += el.scrollHeight - prevHeight.current; // prepended: preserve position
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevFirstKey.current = firstKey;
    prevHeight.current = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return undefined;
    const onScroll = () => {
      stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  function submit(e) {
    e.preventDefault();
    const body = draft.trim();
    if (!body) return;
    stickToBottom.current = true;
    onSend(body);
    setDraft('');
  }

  return (
    <section aria-label="Chat" className="flex min-h-0 flex-1 flex-col rounded-lg border border-slate-800 bg-slate-900">
      <h2 className="border-b border-slate-800 px-3 py-2 text-sm font-semibold text-slate-300">Chat</h2>
      <div ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-3 py-2" aria-live="polite">
        {hasMore && (
          <div className="text-center">
            <button
              type="button"
              onClick={() => {
                stickToBottom.current = false;
                onLoadOlder();
              }}
              disabled={loadingOlder}
              className="rounded border border-slate-700 px-2 py-0.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {loadingOlder ? 'Loading…' : 'Load older'}
            </button>
          </div>
        )}
        {messages.length === 0 && <p className="py-6 text-center text-sm text-slate-500">No messages yet. Say hi!</p>}
        {messages.map((m) => {
          const own = m.senderId === meId;
          return (
            <div key={m.id ?? `pending-${m.clientMsgId}`} className={`text-sm ${own ? 'text-right' : ''}`}>
              <div className="text-xs text-slate-500">
                {own ? 'You' : m.senderName} · {time(m.createdAt)}
                {m.status === 'sending' && ' · sending…'}
              </div>
              <div
                className={`inline-block max-w-full whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 text-left ${
                  own ? 'bg-emerald-600/20 text-emerald-50' : 'bg-slate-800'
                } ${m.status === 'failed' ? 'border border-rose-500/60' : ''}`}
              >
                {m.body}
              </div>
              {m.status === 'failed' && <div className="text-xs text-rose-300">{m.error}</div>}
            </div>
          );
        })}
      </div>
      <form onSubmit={submit} className="flex gap-2 border-t border-slate-800 p-2">
        <label htmlFor="chat-input" className="sr-only">
          Message
        </label>
        <input
          id="chat-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={MAX_LENGTH}
          placeholder={disabled ? 'Connecting…' : 'Message the room'}
          disabled={disabled}
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 text-sm outline-none focus:border-emerald-500"
        />
        <button
          type="submit"
          disabled={disabled || !draft.trim()}
          className="rounded-md bg-emerald-500 px-3 py-1.5 text-sm font-medium text-slate-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          Send
        </button>
      </form>
    </section>
  );
}
