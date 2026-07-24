// =========================================================
// SHARED SUPABASE SETUP — one project, used by every game.
// Every game on the site imports from here, so it's only
// configured in one place.
// =========================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://qfkmgmnwjkvftpggfzsx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFma21nbW53amt2ZnRwZ2dmenN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4NTAxMDYsImV4cCI6MjEwMDQyNjEwNn0.5OmQ2txSe1J-wV0w4eMYkdbrAXe2NZ4ne1gv4gh_r7A';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* No database tables are required for any of these games.
   Rooms live entirely as Supabase Realtime channels, named
   "<gamePrefix>:<ROOMCODE>", e.g. "ttt:QK7RM". The prefix
   keeps rooms for different games from colliding even if
   two people pick the same room code. */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

export function makeRoomCode(length = 5) {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

/**
 * Opens a room (a Supabase Realtime channel) for a game.
 *
 * This is deliberately low-level and game-agnostic: it does NOT
 * assign roles/teams/turns. Each game builds its own protocol on
 * top using room.on(eventName, handler) for messages it cares
 * about, and room.send(eventName, payload) to broadcast.
 *
 * Register all room.on(...) and room.onPresence(...) handlers
 * BEFORE calling room.connect(), so nothing is missed once the
 * channel goes live.
 *
 * Host model: presence entries are sorted by join time; whoever
 * joined earliest is "host" (room.amHost, kept live-updated).
 * Games that need one authoritative simulator (e.g. to referee
 * moves so two teammates can't both act on the same turn) should
 * gate that logic behind amHost(). If the host disconnects,
 * presence re-sorts and the next-earliest player automatically
 * becomes host — the game should re-broadcast its current state
 * right after such a promotion so everyone reconciles.
 *
 * @param {Object} opts
 * @param {string} opts.gamePrefix  short game id, e.g. "ttt"
 * @param {string} opts.roomCode
 * @param {string} opts.myId        stable id for this tab (crypto.randomUUID())
 */
export function openRoom({ gamePrefix, roomCode, myId }) {
  const channel = supabase.channel(`${gamePrefix}:${roomCode}`, {
    config: {
      broadcast: { self: true },
      presence: { key: myId },
    },
  });

  let hostFlag = false;

  function on(eventName, handler) {
    channel.on('broadcast', { event: eventName }, ({ payload }) => handler(payload));
  }

  /**
   * @param {(info: {ids: string[], isHost: boolean, count: number, justBecameHost: boolean}) => void} handler
   */
  function onPresence(handler) {
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const entries = Object.entries(state).map(([key, metas]) => ({
        key,
        joinedAt: metas[0]?.joinedAt ?? Infinity,
      }));
      entries.sort((a, b) => a.joinedAt - b.joinedAt);
      const ids = entries.map((e) => e.key);
      const wasHost = hostFlag;
      hostFlag = ids.length > 0 && ids[0] === myId;
      handler({ ids, isHost: hostFlag, count: ids.length, justBecameHost: hostFlag && !wasHost });
    });
  }

  function amHost() {
    return hostFlag;
  }

  function connect() {
    return new Promise((resolve) => {
      channel.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ joinedAt: Date.now() });
          resolve();
        }
      });
    });
  }

  function send(eventName, payload = {}) {
    channel.send({ type: 'broadcast', event: eventName, payload: { senderId: myId, ...payload } });
  }

  function leave() {
    channel.unsubscribe();
  }

  return { channel, myId, on, onPresence, amHost, connect, send, leave };
}
