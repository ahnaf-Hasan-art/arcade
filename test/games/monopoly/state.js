// =========================================================
// STATE — the single shared source of truth for ROOM/GAME and
// small identity helpers that read them. Every other file
// imports its copy of ROOM/GAME/myId from here (live bindings —
// when this file reassigns them, importers see the update).
// Only network.js and main.js are allowed to call the setters.
// =========================================================
import { getPersistentId, SUPABASE_URL } from '../../shared/supabase.js';

export const myId = getPersistentId();
export let roomCode = null;
export let ROOM = null;   // { hostId, capacity, seats:[ids in turn order], started }
export let GAME = null;
export let room = null;
export let connectedIds = [];      // live presence list, updated by onPresence
export let disconnectSince = {};   // playerId -> timestamp they were first noticed missing (host-local bookkeeping)

export const SUPABASE_CONFIGURED = SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL';

export function isHost() { return !!ROOM && ROOM.hostId === myId; }
export function isMyTurn() { return GAME && GAME.order[GAME.turnIdx] === myId; } // inlined currentPlayer(GAME) to avoid importing game-engine.js here

export function setRoomCode(v) { roomCode = v; }
export function setROOM(v) { ROOM = v; }
export function setGAME(v) { GAME = v; }
export function setRoomConn(v) { room = v; }
export function setConnectedIds(v) { connectedIds = v; }
export function setDisconnectSince(v) { disconnectSince = v; }

export function freshRoom(hostId) {
  return { hostId, capacity: 4, seats: [], started: false, customPrices: {}, chat: [], cheatLog: [], disconnectTimeoutMs: 120000, restartVote: null, movementMode: 'dice', names: {} };
}

export function nameOf(id) {
  if (!id) return 'nobody';
  const custom = ROOM?.names?.[id];
  if (custom) return custom;
  const idx = GAME ? GAME.order.indexOf(id) : -1;
  return idx >= 0 ? `Player ${idx + 1}` : 'a player';
}

// Per-viewer version of nameOf() for on-screen UI (as opposed to
// shared log text): shows "You" for the viewer's own seat, otherwise
// the player's chosen name or "Player N". Works both before and after
// the game starts, since seat order is known from ROOM.seats even
// pre-game when GAME is still null.
export function seatIndexOf(id) {
  if (GAME && GAME.order && GAME.order.includes(id)) return GAME.order.indexOf(id);
  if (ROOM && ROOM.seats) return ROOM.seats.indexOf(id);
  return -1;
}
export function labelFor(id) {
  if (!id) return 'nobody';
  if (id === myId) return 'You';
  const custom = ROOM?.names?.[id];
  if (custom) return custom;
  const idx = seatIndexOf(id);
  return idx >= 0 ? `Player ${idx + 1}` : 'Player';
}
