'use client';

/**
 * /rooms/[roomId]: the collaborative room.
 *
 * In Next 16, client components read route params with useParams() (server
 * components get `params` as a Promise instead).
 */
import { useCallback, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import RequireAuth from '@/components/RequireAuth';
import ChatPanel from '@/components/room/ChatPanel';
import MembersPanel from '@/components/room/MembersPanel';
import ConnectionBadge from '@/components/room/ConnectionBadge';
import RunPanel from '@/components/room/RunPanel';
import { useAuth } from '@/lib/auth-context';
import { useRoom } from '@/lib/use-room';

// Monaco touches `window`, so the editor only ever renders in the browser.
const CodeEditor = dynamic(() => import('@/components/room/CodeEditor'), {
  ssr: false,
  loading: () => <p className="p-4 text-sm text-slate-500">Loading editor…</p>,
});

function InviteCode({ code }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard blocked; the code is visible anyway.
    }
  }
  return (
    <button type="button" onClick={copy} className="rounded-md border border-slate-700 px-2.5 py-1 text-xs hover:bg-slate-800" title="Copy invite code">
      Code <span className="font-mono tracking-widest text-emerald-300">{code}</span> {copied ? '✓' : ''}
    </button>
  );
}

function Room({ roomId }) {
  const { user } = useAuth();
  const room = useRoom(roomId, user);
  // The editor hands us its Y.Doc and language; Run sends exactly what everyone sees.
  const docRef = useRef(null);
  const [liveLanguage, setLiveLanguage] = useState(null);
  const onDocReady = useCallback((doc) => {
    docRef.current = doc;
  }, []);
  const getSource = useCallback(() => docRef.current?.getText('code').toString() ?? '', []);

  if (room.status === 'loading') return <p className="text-slate-400">Opening room…</p>;
  if (room.status === 'gone' || room.status === 'error') {
    return (
      <div className="space-y-3">
        <p className="text-rose-300">{room.error}</p>
        <Link href="/rooms" className="text-emerald-400 hover:underline">
          Back to my rooms
        </Link>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-[520px] flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-3">
          <Link href="/rooms" className="text-sm text-slate-400 hover:text-slate-200">
            ← Rooms
          </Link>
          <h1 className="truncate text-xl font-semibold">{room.room.name}</h1>
          <span className="rounded bg-slate-800 px-2 py-0.5 text-xs text-slate-300">{room.myRole}</span>
        </div>
        <div className="flex items-center gap-2">
          <InviteCode code={room.room.inviteCode} />
          <ConnectionBadge connection={room.connection} />
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[1fr_320px]">
        <div className="flex min-h-0 flex-col gap-3">
          <CodeEditor
            socket={room.socket}
            roomId={roomId}
            joinCount={room.joinCount}
            canEdit={room.myRole === 'editor' || room.myRole === 'owner'}
            me={user}
            initialLanguage={room.room.language}
            onDocReady={onDocReady}
            onLanguageChange={setLiveLanguage}
          />
          <RunPanel
            roomId={roomId}
            socket={room.socket}
            canRun={room.myRole === 'editor' || room.myRole === 'owner'}
            language={liveLanguage ?? room.room.language}
            getSource={getSource}
          />
        </div>
        <aside className="flex min-h-0 flex-col gap-3">
          <MembersPanel members={room.room.members} online={room.online} meId={user.id} />
          <ChatPanel
            messages={room.messages}
            hasMore={room.hasMore}
            loadingOlder={room.loadingOlder}
            onLoadOlder={room.loadOlder}
            onSend={room.sendMessage}
            meId={user.id}
            disabled={room.connection !== 'connected'}
          />
        </aside>
      </div>
    </div>
  );
}

export default function RoomPage() {
  const { roomId } = useParams();
  return (
    <RequireAuth>
      <Room roomId={roomId} />
    </RequireAuth>
  );
}
