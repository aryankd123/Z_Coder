'use client';

/**
 * The shared editor: Monaco + Yjs.
 *
 *   Y.Doc ── Y.Text('code')  <-> MonacoBinding <-> Monaco model
 *         └─ Y.Map('meta')   {language} -> Monaco language + the picker
 *   SocketIOProvider keeps the Y.Doc in step with the server over the room's socket.
 *
 * Monaco is loaded from a CDN by @monaco-editor/react, client-side only
 * (the room page imports this component with ssr: false).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import * as Y from 'yjs';
import { SocketIOProvider } from '@/lib/yjs-socket-provider';
import { MonacoBinding } from '@/lib/monaco-binding';
import { LANGUAGES, languageById } from '@/lib/languages';

const COLORS = ['#10b981', '#f59e0b', '#3b82f6', '#ec4899', '#8b5cf6', '#ef4444', '#14b8a6', '#eab308'];

/** A stable colour per user, so your cursor looks the same to everyone. */
function colorFor(userId) {
  let h = 0;
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

/**
 * @param {{
 *   socket: import('socket.io-client').Socket,
 *   roomId: string,
 *   joinCount: number,
 *   canEdit: boolean,
 *   me: { id: string, name: string },
 *   initialLanguage: string,
 *   onDocReady?: (doc: Y.Doc | null) => void,
 *   onLanguageChange?: (language: string) => void,
 * }} props
 */
export default function CodeEditor({ socket, roomId, joinCount, canEdit, me, initialLanguage, onDocReady, onLanguageChange }) {
  // One Y.Doc per room. Never destroyed in an effect cleanup: React StrictMode
  // runs effects twice in dev, and the second run must find the doc usable.
  const doc = useMemo(() => {
    void roomId;
    return new Y.Doc();
  }, [roomId]);
  const [mounted, setMounted] = useState(null); // { editor, monaco } once Monaco is ready
  const [synced, setSynced] = useState(false);
  const [language, setLanguage] = useState(initialLanguage);
  const providerRef = useRef(null);
  const joinCountRef = useRef(joinCount);
  const canEditRef = useRef(canEdit);

  // Provider + binding live exactly as long as the editor and the doc.
  useEffect(() => {
    if (!mounted) return undefined;
    const { editor, monaco } = mounted;
    const provider = new SocketIOProvider(socket, roomId, doc, { canEdit: canEditRef.current });
    provider.awareness.setLocalStateField('user', { name: me.name, color: colorFor(me.id) });
    const binding = new MonacoBinding(monaco, doc.getText('code'), editor.getModel(), editor, provider.awareness);
    const offSynced = provider.onSynced(setSynced);
    providerRef.current = provider;
    onDocReady?.(doc);

    // If room:join already happened before Monaco finished loading, sync now.
    if (joinCountRef.current > 0) provider.sync().catch(() => {});

    return () => {
      offSynced();
      binding.destroy();
      provider.destroy();
      providerRef.current = null;
      onDocReady?.(null);
    };
  }, [mounted, socket, roomId, doc, me.id, me.name, onDocReady]);

  // Every successful room:join (first connect and each reconnect) -> re-sync.
  useEffect(() => {
    joinCountRef.current = joinCount;
    if (joinCount > 0) providerRef.current?.sync().catch(() => {});
  }, [joinCount]);

  // Role changes (room:role) take effect immediately.
  useEffect(() => {
    canEditRef.current = canEdit;
    providerRef.current?.setCanEdit(canEdit);
    mounted?.editor.updateOptions({ readOnly: !canEdit });
  }, [canEdit, mounted]);

  // The language lives in the shared doc, so everyone's editor switches together.
  useEffect(() => {
    const meta = doc.getMap('meta');
    const onMeta = () => {
      const next = meta.get('language');
      if (LANGUAGES.some((l) => l.id === next)) {
        setLanguage(next);
        onLanguageChange?.(next);
      }
    };
    meta.observe(onMeta);
    return () => meta.unobserve(onMeta);
  }, [doc, onLanguageChange]);

  const lang = languageById(language);

  return (
    <section aria-label="Shared code editor" className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-lg border border-slate-800 bg-slate-900">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 px-3 py-1.5 text-sm">
        <label className="flex items-center gap-2 text-slate-400">
          Language
          <select
            value={lang.id}
            disabled={!canEdit}
            onChange={(e) => doc.getMap('meta').set('language', e.target.value)}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-0.5 text-slate-100 disabled:opacity-60"
          >
            {LANGUAGES.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
        </label>
        <span className="text-xs text-slate-500">
          {!synced ? 'Syncing…' : canEdit ? 'Editing live' : 'Read-only (viewer)'}
        </span>
      </div>
      <div className="relative min-h-0 flex-1">
        <Editor
          theme="vs-dark"
          defaultLanguage={lang.monaco}
          language={lang.monaco}
          loading={<p className="p-4 text-sm text-slate-500">Loading editor…</p>}
          onMount={(editor, monaco) => setMounted({ editor, monaco })}
          options={{
            readOnly: !canEdit,
            minimap: { enabled: false },
            fontSize: 14,
            tabSize: 4,
            scrollBeyondLastLine: false,
            automaticLayout: true,
            renderWhitespace: 'selection',
          }}
        />
      </div>
    </section>
  );
}
