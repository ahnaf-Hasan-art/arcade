// =========================================================
// SHARED SUPABASE SETUP — one project, used by every game.
// Fill these in once you have a Supabase project; every
// game on the site imports from here, so you only set it
// up in one place.
// =========================================================
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

export const SUPABASE_URL = 'https://qfkmgmnwjkvftpggfzsx.supabase.co';
export const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFma21nbW53amt2ZnRwZ2dmenN4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4NTAxMDYsImV4cCI6MjEwMDQyNjEwNn0.5OmQ2txSe1J-wV0w4eMYkdbrAXe2NZ4ne1gv4gh_r7A';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* No database tables are required for any of these games.
   Rooms live entirely as Supabase Realtime channels, named
   "<gamePrefix>:<ROOMCODE>", e.g. "ttt:QK7RM".
   The prefix keeps rooms for different games from colliding
   even if two people happen to pick the same room code. */

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I ambiguity

export function makeRoomCode(length = 5) {
  let s = '';
  for (let i = 0; i < length; i++) {
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return s;
}

/**
 * Connects to a 2-player room for a given game.
 *
 * @param {Object} opts
 * @param {string} opts.gamePrefix   short game id, e.g. "ttt"
 * @param {string} opts.roomCode     the room code (created or joined)
 * @param {string} opts.myId         a stable id for this browser tab (crypto.randomUUID())
 * @param {(roleInfo: {role: 'p1'|'p2', opponentPresent: boolean}) => void} opts.onRoleChange
 *        called whenever presence changes; tells you your role and whether
 *        the other seat is filled. Role is assigned by join order (first = p1).
 * @param {(payload: any) => void} opts.onMessage
 *        called for every broadcast event of type "move" from ANY peer
 *        (including yourself, since self:true — filter by senderId if needed).
 *
 * @returns {Promise<{channel, send, leave}>}
 *   send(payload) broadcasts a "move" event to the room.
 *   leave() unsubscribes cleanly.
 */
export async function connectRoom({ gamePrefix, roomCode, myId, onRoleChange, onMessage }) {
  const channel = supabase.channel(`${gamePrefix}:${roomCode}`, {
    config: {
      broadcast: { self: true },
      presence: { key: myId },
    },
  });

  function computeRole() {
    const state = channel.presenceState();
    // Flatten to [{key, joinedAt}] and sort by join order for a stable role assignment.
    const entries = Object.entries(state).map(([key, metas]) => ({
      key,
      joinedAt: metas[0]?.joinedAt ?? 0,
    }));
    entries.sort((a, b) => a.joinedAt - b.joinedAt);

    const myIndex = entries.findIndex((e) => e.key === myId);
    const role = myIndex === 0 ? 'p1' : 'p2';
    const opponentPresent = entries.length >= 2;
    onRoleChange({ role, opponentPresent });
  }

  channel.on('presence', { event: 'sync' }, computeRole);
  channel.on('broadcast', { event: 'move' }, ({ payload }) => onMessage(payload));

  await channel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      await channel.track({ joinedAt: Date.now() });
    }
  });

  function send(payload) {
    channel.send({ type: 'broadcast', event: 'move', payload: { senderId: myId, ...payload } });
  }

  function leave() {
    channel.unsubscribe();
  }

  return { channel, send, leave };
}
