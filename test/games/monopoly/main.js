// =========================================================
// MAIN — DOM element lookups, all button/input event wiring,
// small UI-only state (modals, timers), and the app boot
// sequence. Edit this file for: what a button/input does,
// adding a new modal or panel toggle.
// =========================================================
import { makeRoomCode } from '../../shared/supabase.js';
import {
  room, myId, isHost, ROOM, GAME, roomCode, SUPABASE_CONFIGURED, freshRoom,
  setROOM, setGAME, setRoomCode,
} from './state.js';
import { setupRoom } from './network.js';
import { SPACES } from './board-data.js';
import {
  renderLobby, renderGame, renderRestartUI, renderTradeSides, sendTradeOffer,
  renderSettingsList, renderExpandedLog, renderChat, renderAuctionUI, renderCheatLog,
  populateTradeTargets, openPropertyInfoModal,
} from './render.js';

export const screenHome = document.getElementById('screen-home');
export const screenLobby = document.getElementById('screen-lobby');
export const gameShell = document.getElementById('game-shell');
export const homeErr = document.getElementById('home-err');

// createRoom() and joinRoom() open the Supabase-backed room connection
// (via network.js's setupRoom()) and switch the screen into the lobby.
export async function createRoom() {
  homeErr.textContent = '';
  if (!SUPABASE_CONFIGURED) { homeErr.textContent = 'Multiplayer isn’t connected yet.'; return; }
  setRoomCode(makeRoomCode());
  setROOM(freshRoom(myId));
  ROOM.disconnectTimeoutMs = Number(document.getElementById('disconnect-timeout-select').value) || 0;
  setGAME(null);
  await setupRoom();
  showHomeOrLobby('screen-lobby');
  renderLobby();
}

export async function joinRoom(code) {
  homeErr.textContent = '';
  if (!code) { homeErr.textContent = 'Enter a room code.'; return; }
  if (!SUPABASE_CONFIGURED) { homeErr.textContent = 'Multiplayer isn’t connected yet.'; return; }
  setRoomCode(code);
  setROOM(null); setGAME(null);
  await setupRoom();
  showHomeOrLobby('screen-lobby');
  document.getElementById('lobby-msg').textContent = 'Connecting...';
  room.send('request_sync', {});
}

document.getElementById('btn-create').onclick = createRoom;
document.getElementById('btn-join-open').onclick = () => document.getElementById('join-form').classList.remove('hidden');
document.getElementById('btn-join').onclick = () => joinRoom(document.getElementById('join-code').value.trim().toUpperCase());
document.getElementById('btn-copy-link').onclick = copyShareLink;
document.getElementById('btn-join-seat').onclick = () => room?.send('join_seat', {});
document.getElementById('btn-start').onclick = () => room?.send('start_game', {});

// Name field auto-saves as you type (debounced) — no separate Save
// button. blur/Enter also flushes immediately so it's never left
// hanging right before you navigate away.
export let nameSaveTimer = null;
export function saveMyName() {
  clearTimeout(nameSaveTimer);
  const input = document.getElementById('name-input');
  const name = input.value.trim().slice(0, 20);
  room?.send('set_name', { name });
}
document.getElementById('name-input').addEventListener('input', () => {
  clearTimeout(nameSaveTimer);
  nameSaveTimer = setTimeout(saveMyName, 500);
});
document.getElementById('name-input').addEventListener('blur', saveMyName);
document.getElementById('name-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveMyName(); });

export const seatSelectEl = document.getElementById('seat-count-select');
[2,3,4,5,6].forEach(n => {
  const b = document.createElement('button');
  b.className = 'seat-btn';
  b.textContent = n + ' players';
  b.onclick = () => { if (isHost()) room.send('set_capacity', { capacity: n }); };
  b.dataset.n = n;
  seatSelectEl.appendChild(b);
});

document.getElementById('mode-btn-dice').onclick = () => { if (isHost()) room.send('set_movement_mode', { mode: 'dice' }); };
document.getElementById('mode-btn-cards').onclick = () => { if (isHost()) room.send('set_movement_mode', { mode: 'cards' }); };

export let showingRestartConfirm = false;
document.getElementById('btn-restart').onclick = () => { showingRestartConfirm = true; renderRestartUI(); };
document.getElementById('btn-restart-confirm-no').onclick = () => { showingRestartConfirm = false; renderRestartUI(); };
document.getElementById('btn-restart-confirm-yes').onclick = () => {
  showingRestartConfirm = false;
  room.send('restart_propose', {});
};

document.getElementById('btn-open-trade').onclick = () => {
  document.getElementById('trade-modal-overlay').classList.remove('hidden');
  populateTradeTargets();
  renderTradeSides();
};
export function closeTradeModal() {
  document.getElementById('trade-modal-overlay').classList.add('hidden');
}
document.getElementById('btn-close-trade').onclick = closeTradeModal;
document.getElementById('btn-cancel-trade-form').onclick = closeTradeModal;
document.getElementById('trade-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'trade-modal-overlay') closeTradeModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeTradeModal();
});
document.getElementById('trade-target').onchange = renderTradeSides;
document.getElementById('btn-send-trade').onclick = sendTradeOffer;

// ---- settings modal ----
document.getElementById('btn-open-settings').onclick = () => {
  document.getElementById('settings-modal-overlay').classList.remove('hidden');
  renderSettingsList();
};
export function closeSettingsModal() {
  document.getElementById('settings-modal-overlay').classList.add('hidden');
}
document.getElementById('btn-close-settings').onclick = closeSettingsModal;
document.getElementById('settings-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal-overlay') closeSettingsModal();
});

// Each price field auto-saves itself (debounced) as soon as it
// changes — no batch Save button. See buildSettingsRow() below,
// which wires the 'input' listener per-field via scheduleAutoSavePrice.
export let priceAutoSaveTimers = {};
export function scheduleAutoSavePrice(idx, inputEl, tickEl) {
  clearTimeout(priceAutoSaveTimers[idx]);
  priceAutoSaveTimers[idx] = setTimeout(() => {
    if (!isHost() || !ROOM || ROOM.started) return;
    const p = Math.max(0, Math.min(9999, Number(inputEl.value) || 0));
    room.send('update_prices', { prices: { [idx]: p } });
    if (tickEl) {
      tickEl.classList.add('show');
      clearTimeout(tickEl._hideTimer);
      tickEl._hideTimer = setTimeout(() => tickEl.classList.remove('show'), 1200);
    }
  }, 500);
}

document.getElementById('btn-reset-settings').onclick = () => {
  if (!isHost()) return;
  room.send('reset_prices', {});
  renderSettingsList();
};

// ---- property info modal (click a board cell) ----
// Wired once at load, since the board cells are static markup (not
// re-created per render). Colored properties, stations, and utilities
// get a click handler; GO/Chance/Chest/tax/corner cells stay inert.
document.querySelectorAll('#board .cell[data-idx]').forEach(cellEl => {
  const idx = Number(cellEl.dataset.idx);
  const space = SPACES[idx];
  if (!space || (space.type !== 'property' && space.type !== 'rail' && space.type !== 'util')) return;
  cellEl.classList.add('clickable-cell');
  cellEl.addEventListener('click', () => openPropertyInfoModal(idx));
});

export function closePropertyInfoModal() {
  document.getElementById('property-info-modal-overlay').classList.add('hidden');
}
document.getElementById('btn-close-property-info').onclick = closePropertyInfoModal;
document.getElementById('property-info-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'property-info-modal-overlay') closePropertyInfoModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!document.getElementById('property-info-modal-overlay').classList.contains('hidden')) closePropertyInfoModal();
});

// ---- expanded log / chat panel ----

export let activityModalMode = null;
let unreadChatCount = 0;
let lastKnownChatTs = null;
let chatHasInitialized = false;

export function updateChatUnreadBadge() {
  const badge = document.getElementById('chat-unread-badge');
  if (!badge) return;
  if (unreadChatCount > 0) {
    badge.textContent = unreadChatCount > 99 ? '99+' : String(unreadChatCount);
    badge.classList.remove('hidden');
  } else {
    badge.textContent = '';
    badge.classList.add('hidden');
  }
}

export function clearUnreadChat() {
  unreadChatCount = 0;
  const latest = (ROOM?.chat || []).at(-1);
  lastKnownChatTs = latest?.ts ?? lastKnownChatTs;
  updateChatUnreadBadge();
}

export function processChatUpdates(nextRoom) {
  const messages = nextRoom?.chat || [];
  const latestTs = messages.length ? Number(messages[messages.length - 1].ts || 0) : null;
  if (!chatHasInitialized) {
    chatHasInitialized = true;
    lastKnownChatTs = latestTs;
    updateChatUnreadBadge();
    return;
  }
  if (latestTs != null && (lastKnownChatTs == null || latestTs > lastKnownChatTs)) {
    const incoming = messages.filter(m => Number(m.ts || 0) > Number(lastKnownChatTs || 0) && m.senderId !== myId);
    if (activityModalMode !== 'chat') unreadChatCount += incoming.length;
    lastKnownChatTs = latestTs;
    updateChatUnreadBadge();
  }
}

export function openActivityModal(mode) {
  activityModalMode = mode;
  const overlay = document.getElementById('activity-modal-overlay');
  const title = document.getElementById('activity-modal-title');
  const log = document.getElementById('expanded-log-box');
  const chat = document.getElementById('expanded-chat-wrap');
  title.textContent = mode === 'chat' ? 'Chat' : 'Game Log';
  log.classList.toggle('hidden', mode !== 'log');
  chat.classList.toggle('hidden', mode !== 'chat');
  overlay.classList.remove('hidden');
  if (mode === 'log') renderExpandedLog();
  else { clearUnreadChat(); renderChat(); setTimeout(() => document.getElementById('expanded-chat-input')?.focus(), 0); }
}

export function closeActivityModal() {
  activityModalMode = null;
  document.getElementById('activity-modal-overlay').classList.add('hidden');
}

document.getElementById('btn-open-log').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openActivityModal('log'); });
document.getElementById('chat-toggle').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openActivityModal('chat'); });
document.getElementById('btn-close-activity').onclick = closeActivityModal;
document.getElementById('activity-modal-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'activity-modal-overlay') closeActivityModal();
});
document.getElementById('expanded-chat-send').onclick = sendChatMessage;
document.getElementById('expanded-chat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChatMessage();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activityModalMode) closeActivityModal();
});

export function sendChatMessage() {
  const input = document.getElementById('expanded-chat-input');
  const text = input.value.trim();
  if (!text || !room) return;
  room.send('send_chat', { text });
  input.value = '';
}

// ---- cheat panel: its own small anchored window, separate from the
// chat/log modal, with its own log feed (ROOM.cheatLog). ----
export let cheatPanelOpen = false;
export function toggleCheatPanel(forceOpen) {
  cheatPanelOpen = typeof forceOpen === 'boolean' ? forceOpen : !cheatPanelOpen;
  document.getElementById('cheat-body').classList.toggle('hidden', !cheatPanelOpen);
  if (cheatPanelOpen) {
    renderCheatLog();
    setTimeout(() => document.getElementById('cheat-input')?.focus(), 0);
  }
}
export function sendCheatCommand() {
  const input = document.getElementById('cheat-input');
  const text = input.value.trim();
  if (!text || !room) return;
  room.send('cheat_command', { command: text });
  input.value = '';
}

document.getElementById('cheat-toggle').addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleCheatPanel(); });
document.getElementById('cheat-send').onclick = sendCheatCommand;
document.getElementById('cheat-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendCheatCommand();
});
document.addEventListener('click', (e) => {
  if (!cheatPanelOpen) return;
  if (!document.getElementById('cheat-panel').contains(e.target)) toggleCheatPanel(false);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cheatPanelOpen) toggleCheatPanel(false);
});

export function showHomeOrLobby(id) {
  screenHome.classList.add('hidden');
  screenLobby.classList.add('hidden');
  gameShell.classList.remove('active');
  document.getElementById(id).classList.remove('hidden');
}

export function copyShareLink() {
  const el = document.getElementById('share-link');
  el.select();
  navigator.clipboard?.writeText(el.value).catch(() => {});
}

export const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) joinRoom(urlRoom.toUpperCase());

setInterval(() => { if (GAME?.phase === 'auction') renderAuctionUI(); }, 1000);

// Re-render tokens on resize since positions are computed from live cell rects.
window.addEventListener('resize', () => { if (GAME && ROOM?.started) renderGame(); });
