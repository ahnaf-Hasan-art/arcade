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
 * Deliberately low-level and game-agnostic: it does NOT decide
 * who's in charge of anything. It just gives you:
 *   - on(eventName, handler)      subscribe to a broadcast event
 *   - send(eventName, payload)    broadcast an event (senderId auto-attached)
 *   - onPresence(handler)         connected player ids, sorted by join time
 *   - connect()                   subscribe + start presence tracking
 *
 * IMPORTANT: call on(...)/onPresence(...) BEFORE connect(), so
 * nothing sent right after connecting gets missed.
 *
 * Games that need one authoritative "referee" (e.g. so two
 * teammates can't both act on the same turn) should track that
 * explicitly in their OWN state (e.g. a `hostId` field set once
 * at room creation), rather than re-deriving "who's in charge"
 * from presence data on every message. Presence is great for
 * "is everyone still connected" but its ordering can briefly
 * disagree across clients right after a join/leave, which is
 * exactly the wrong moment to be silently gating message
 * handling on it. Use onPresence() only to notice when the
 * current authoritative player has disconnected, and hand off
 * explicitly at that point.
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

  function on(eventName, handler) {
    channel.on('broadcast', { event: eventName }, ({ payload }) => handler(payload));
  }

  /**
   * @param {(info: {ids: string[], count: number}) => void} handler
   *   ids is every currently-connected player's id, sorted by join time (oldest first).
   */
  function onPresence(handler) {
    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      const entries = Object.entries(state).map(([key, metas]) => ({
        key,
        joinedAt: metas[0]?.joinedAt ?? Infinity,
      }));
      entries.sort((a, b) => a.joinedAt - b.joinedAt);
      handler({ ids: entries.map((e) => e.key), count: entries.length });
    });
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

  return { channel, myId, on, onPresence, connect, send, leave };
}
