'use client';

/**
 * useRoom(roomId): everything the room page shows, except the shared editor.
 *
 * Two sources, merged into one state:
 *   - REST  GET /api/rooms/:id/session  -> room, members, last 50 messages
 *           GET /api/rooms/:id/messages -> older pages ("Load older")
 *   - Socket room:join (ack = role + presence), chat:new, presence:state,
 *            room:role, room:kicked
 *
 * Sending chat (optimistic, idempotent):
 *   1. Generate clientMsgId ONCE and show the message as "sending".
 *   2. emit chat:send with an ack. If the ack times out (flaky network), retry
 *      with the SAME clientMsgId. The server's unique index stores it once.
 *   3. On ack, swap the pending message for the stored one.
 *
 * Reconnects: after the first connect, every later connect re-joins the room
 * and re-fetches the newest page, merging by message id, so messages sent
 * while we were offline appear and nothing is duplicated.
 */
import { useCallback, useEffect, useReducer, useRef } from 'react';
import { api } from './api';
import { ensureConnected, getSocket, request } from './socket';

const initialState = {
  status: 'loading', // loading | ready | error | gone
  error: null,
  room: null,
  myRole: null,
  messages: [], // stored messages (by id) followed by pending/failed ones
  hasMore: false,
  cursor: null,
  loadingOlder: false,
  online: [], // [{ userId, name, role, tabs }]
  connection: 'connecting', // connecting | connected | reconnecting
  joinCount: 0, // bumps on every successful room:join; the editor re-syncs Yjs on each
};

/** ObjectIds are fixed-length hex starting with a timestamp, so string order = time order. */
function mergeMessages(current, incoming) {
  const byId = new Map();
  const pending = [];
  for (const m of [...current, ...incoming]) {
    if (m.id) byId.set(m.id, m);
    else pending.push(m);
  }
  const stored = [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const storedClientIds = new Set(stored.map((m) => `${m.senderId}:${m.clientMsgId}`));
  return [...stored, ...pending.filter((p) => !storedClientIds.has(`${p.senderId}:${p.clientMsgId}`))];
}

function reducer(state, action) {
  switch (action.type) {
    case 'session':
      return {
        ...state,
        status: 'ready',
        room: action.room,
        myRole: state.myRole ?? action.room.myRole,
        messages: mergeMessages(state.messages, action.messages),
        hasMore: action.hasMore,
        cursor: action.cursor,
      };
    case 'failed':
      return { ...state, status: 'error', error: action.error };
    case 'gone':
      return { ...state, status: 'gone', error: action.error };
    case 'connection':
      return { ...state, connection: action.connection };
    case 'joined':
      return { ...state, myRole: action.role, online: action.presence, joinCount: state.joinCount + 1 };
    case 'presence':
      return { ...state, online: action.online };
    case 'role':
      return { ...state, myRole: action.role };
    case 'messages':
      return { ...state, messages: mergeMessages(state.messages, action.messages) };
    case 'pending':
      return { ...state, messages: [...state.messages, action.message] };
    case 'acked':
      return {
        ...state,
        messages: mergeMessages(
          state.messages.filter((m) => m.id || m.clientMsgId !== action.clientMsgId),
          [action.message],
        ),
      };
    case 'send-failed':
      return {
        ...state,
        messages: state.messages.map((m) =>
          !m.id && m.clientMsgId === action.clientMsgId ? { ...m, status: 'failed', error: action.error } : m,
        ),
      };
    case 'older-loading':
      return { ...state, loadingOlder: true };
    case 'older':
      return {
        ...state,
        loadingOlder: false,
        messages: mergeMessages(state.messages, action.messages),
        hasMore: action.hasMore,
        cursor: action.cursor,
      };
    default:
      return state;
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {string} roomId
 * @param {{ id: string, name: string }} me the logged-in user
 */
export function useRoom(roomId, me) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const connectedOnce = useRef(false);

  // REST: the session snapshot.
  useEffect(() => {
    let cancelled = false;
    api(`/rooms/${roomId}/session`)
      .then((s) => {
        if (cancelled) return;
        dispatch({ type: 'session', room: s.room, messages: s.messages, hasMore: s.hasMoreMessages, cursor: s.nextCursor });
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.code === 'ROOM_NOT_FOUND') dispatch({ type: 'gone', error: "This room doesn't exist, or you're not a member." });
        else dispatch({ type: 'failed', error: err.message });
      });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  // Socket: join, listen, re-join on reconnect, leave on unmount.
  useEffect(() => {
    const socket = ensureConnected();
    connectedOnce.current = false;
    const mine = (payload) => payload?.roomId === roomId;

    async function join() {
      try {
        const res = await request('room:join', { roomId });
        if (res.ok) {
          dispatch({ type: 'joined', role: res.data.role, presence: res.data.presence });
        } else if (res.error.code === 'ROOM_NOT_FOUND') {
          dispatch({ type: 'gone', error: "You're no longer a member of this room." });
        }
      } catch {
        // Timed out: the next reconnect will join again.
      }
    }

    async function resync() {
      try {
        const page = await api(`/rooms/${roomId}/messages`);
        dispatch({ type: 'messages', messages: page.messages });
      } catch {
        // Not fatal; the user can reload.
      }
    }

    function onConnect() {
      dispatch({ type: 'connection', connection: 'connected' });
      join();
      if (connectedOnce.current) resync();
      connectedOnce.current = true;
    }
    const onDisconnect = () => dispatch({ type: 'connection', connection: 'reconnecting' });
    const onChat = (m) => mine(m) && dispatch({ type: 'messages', messages: [m] });
    const onPresence = (p) => mine(p) && dispatch({ type: 'presence', online: p.online });
    const onRole = (p) => mine(p) && dispatch({ type: 'role', role: p.role });
    const onKicked = (p) => mine(p) && dispatch({ type: 'gone', error: 'You were removed from this room.' });

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('chat:new', onChat);
    socket.on('presence:state', onPresence);
    socket.on('room:role', onRole);
    socket.on('room:kicked', onKicked);
    if (socket.connected) onConnect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('chat:new', onChat);
      socket.off('presence:state', onPresence);
      socket.off('room:role', onRole);
      socket.off('room:kicked', onKicked);
      if (socket.connected) socket.emit('room:leave', { roomId });
    };
  }, [roomId]);

  const sendMessage = useCallback(
    async (body) => {
      const clientMsgId = crypto.randomUUID();
      dispatch({
        type: 'pending',
        message: { clientMsgId, body, senderId: me.id, senderName: me.name, createdAt: new Date().toISOString(), status: 'sending' },
      });
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const res = await request('chat:send', { roomId, body, clientMsgId });
          if (res.ok) dispatch({ type: 'acked', clientMsgId, message: res.data.message });
          else dispatch({ type: 'send-failed', clientMsgId, error: res.error.message });
          return;
        } catch {
          await wait(1000 * (attempt + 1)); // no ack: retry with the SAME clientMsgId
        }
      }
      dispatch({ type: 'send-failed', clientMsgId, error: 'Not sent (no connection)' });
    },
    [roomId, me.id, me.name],
  );

  const loadOlder = useCallback(async () => {
    if (!state.cursor || state.loadingOlder) return;
    dispatch({ type: 'older-loading' });
    try {
      const page = await api(`/rooms/${roomId}/messages?before=${state.cursor}`);
      dispatch({ type: 'older', messages: page.messages, hasMore: page.hasMore, cursor: page.nextCursor });
    } catch {
      dispatch({ type: 'older', messages: [], hasMore: state.hasMore, cursor: state.cursor });
    }
  }, [roomId, state.cursor, state.loadingOlder, state.hasMore]);

  return { ...state, sendMessage, loadOlder, socket: getSocket() };
}
