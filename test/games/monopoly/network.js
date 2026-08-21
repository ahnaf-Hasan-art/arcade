// =========================================================
// NETWORK — host-authoritative Supabase Realtime wiring. Every
// room.on(...) handler here runs ONLY on the host; it validates
// the action, calls into game-engine.js to mutate GAME, then
// broadcastSync()s the result to everyone (including itself).
// Edit this file for: what actions are allowed/valid, adding a
// new player action, reconnect/timeout behavior.
// =========================================================
import { openRoom, makeRoomCode } from '../../shared/supabase.js';
import {
  ROOM, GAME, room, myId, roomCode, connectedIds, disconnectSince,
  isHost, freshRoom, nameOf,
  setROOM, setGAME, setRoomConn, setConnectedIds, setDisconnectSince, setRoomCode,
} from './state.js';
import { SPACES, GROUPS, GROUP_HOUSE_COST, CHANCE_GOOJF_IDX, CHEST_GOOJF_IDX, priceOf } from './board-data.js';
import {
  freshGame, currentPlayer, doRoll, doEndTurn, checkWin, pushLog,
  playTrickCard, tryResolvePitAssignment, dealNewHand, startNewTrick, continuePit, finishTrickCycle,
  startAuction, auctionActivePlayers, advanceAuctionTurn, resolveAuctionIfDone, AUCTION_TURN_MS, AUCTION_RAISE_STEPS,
  payAmount, computeNetWorth, mortgageValueOf, unmortgageCostOf, houseSaleValueOf,
  canSellOneDown, applySellToBank, canBuildOneMore, applyBuildToBank,
  houseGroupComplete, houseGroupUnmortgaged,
  isTradeable, canExecuteTrade, executeTrade, tradeSummary, executeCheat, cardSuit, cardLabel,
  forceBankruptcy, resumeAfterDebt,
} from './game-engine.js';
import { processChatUpdates } from './main.js';
import { renderFromState } from './render.js';

// createRoom() and joinRoom() are exported from main.js (they switch
// screens / touch DOM elements that main.js owns) — they call this
// setupRoom() to open the Supabase-backed room connection and register
// every room.on(...) handler below.
export async function setupRoom() {
  setRoomConn(openRoom({ gamePrefix: 'monopoly', roomCode, myId }));

  room.on('set_capacity', (payload) => {
    if (!isHost() || ROOM.started) return;
    const maxCap = ROOM.movementMode === 'cards' ? 4 : 6;
    const cap = Math.max(2, Math.min(maxCap, payload.capacity | 0));
    setROOM({ ...ROOM, capacity: cap, seats: ROOM.seats.slice(0, cap) });
    broadcastSync();
  });

  room.on('set_movement_mode', (payload) => {
    if (!isHost() || ROOM.started) return;
    const mode = payload.mode === 'cards' ? 'cards' : 'dice';
    const cap = mode === 'cards' ? Math.min(4, ROOM.capacity) : ROOM.capacity;
    setROOM({ ...ROOM, movementMode: mode, capacity: cap, seats: ROOM.seats.slice(0, cap) });
    broadcastSync();
  });

  room.on('update_prices', (payload) => {
    if (!isHost() || ROOM.started) return;
    const clean = {};
    for (const [idxStr, price] of Object.entries(payload.prices || {})) {
      const idx = Number(idxStr);
      const space = SPACES[idx];
      if (!space || (space.type !== 'property' && space.type !== 'rail' && space.type !== 'util')) continue;
      const p = Math.max(0, Math.min(9999, Number(price) | 0));
      clean[idx] = p;
    }
    setROOM({ ...ROOM, customPrices: { ...ROOM.customPrices, ...clean } });
    broadcastSync();
  });

  room.on('reset_prices', () => {
    if (!isHost() || ROOM.started) return;
    setROOM({ ...ROOM, customPrices: {} });
    broadcastSync();
  });

  room.on('set_name', (payload) => {
    if (!isHost() || !ROOM) return;
    const name = String(payload.name || '').trim().slice(0, 20);
    const names = { ...(ROOM.names || {}) };
    if (name) names[payload.senderId] = name;
    else delete names[payload.senderId];
    setROOM({ ...ROOM, names });
    broadcastSync();
  });

  room.on('send_chat', (payload) => {
    if (!isHost() || !ROOM) return;
    const text = String(payload.text || '').slice(0, 240).trim();
    if (!text) return;
    setROOM({ ...ROOM, chat: [...ROOM.chat, { senderId: payload.senderId, text, ts: Date.now() }].slice(-60) });
    broadcastSync();
  });

  room.on('cheat_command', (payload) => {
    if (!isHost() || !ROOM || !GAME) return;
    const command = String(payload.command || '').slice(0, 80).trim();
    if (!command) return;
    const { ok, text } = executeCheat(GAME, payload.senderId, command);
    setROOM({ ...ROOM, cheatLog: [...(ROOM.cheatLog || []), { senderId: payload.senderId, command, result: text, ok, ts: Date.now() }].slice(-40) });
    if (ok) pushLog(GAME, `[CHEAT] ${nameOf(payload.senderId)}: ${text}`);
    broadcastSync();
  });

  room.on('join_seat', (payload) => {
    if (!isHost() || ROOM.started) return;
    if (ROOM.seats.includes(payload.senderId)) return;
    if (ROOM.seats.length < ROOM.capacity) {
      setROOM({ ...ROOM, seats: [...ROOM.seats, payload.senderId] });
    } else {
      // Full — but if one seat's occupant is currently disconnected,
      // let a new arrival take it rather than being turned away.
      const ghostIdx = ROOM.seats.findIndex(id => !connectedIds.includes(id));
      if (ghostIdx === -1) return;
      const newSeats = ROOM.seats.slice();
      newSeats[ghostIdx] = payload.senderId;
      setROOM({ ...ROOM, seats: newSeats });
    }
    broadcastSync();
  });

  // Mid-game reconnection: a spectator (not in ROOM.seats) can claim a
  // seat that's CURRENTLY disconnected — never an active player's seat.
  // Rewrites every player-keyed field in GAME/ROOM from oldId to newId
  // so the reconnected player resumes exactly where they left off
  // (same cash, position, properties, jail status, pending trades,
  // and — in Cards mode — their hand and any in-progress trick/pit).
  room.on('claim_seat', (payload) => {
    if (!isHost() || !ROOM || !ROOM.started || !GAME) return;
    const oldId = payload.oldId, newId = payload.senderId;
    if (!ROOM.seats.includes(oldId)) return;
    if (connectedIds.includes(oldId)) return; // still connected — can't be claimed
    if (ROOM.seats.includes(newId)) return;   // claimer already seated
    migratePlayerId(oldId, newId);
    pushLog(GAME, 'A player reconnected.');
    broadcastSync();
  });

  room.on('start_game', () => {
    if (!isHost() || ROOM.started) return;
    if (ROOM.seats.length < 2) return;
    if (ROOM.movementMode === 'cards' && ROOM.seats.length > 4) return; // Cards mode: 2-4 players only
    setROOM({ ...ROOM, started: true });
    setGAME(freshGame(ROOM.seats));
    if (ROOM.movementMode === 'cards') {
      dealNewHand(GAME);
      startNewTrick(GAME, GAME.order[0]);
    }
    broadcastSync();
  });

  room.on('roll', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'roll' || ROOM.movementMode === 'cards') return;
    if (currentPlayer(GAME) !== payload.senderId) return;
    doRoll(GAME, payload.senderId);
    broadcastSync();
  });

  room.on('play_trick_card', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'card_trick_play' || ROOM.movementMode !== 'cards') return;
    const ok = playTrickCard(GAME, payload.senderId, payload.cardIdx);
    if (!ok) return;
    broadcastSync();
  });

  room.on('card_pit_assign', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'card_pit_assign' || !GAME.pit) return;
    if (GAME.pit.winnerId !== payload.senderId) return;
    tryResolvePitAssignment(GAME, payload.senderId, payload.assignments || {});
    broadcastSync();
  });

  room.on('buy_yes', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'buy') return;
    if (currentPlayer(GAME) !== payload.senderId) return;
    const space = SPACES[GAME.pendingBuySpace];
    const price = priceOf(GAME.pendingBuySpace);
    if (GAME.cash[payload.senderId] >= price) {
      GAME.cash[payload.senderId] -= price;
      GAME.owner[GAME.pendingBuySpace] = payload.senderId;
      pushLog(GAME, `${nameOf(payload.senderId)} bought ${space.name} for Tk${price}.`);
    }
    GAME.pendingBuySpace = null;
    GAME.phase = 'resolve';
    if (ROOM.movementMode === 'cards') { continuePit(GAME); finishTrickCycle(GAME); }
    broadcastSync();
  });

  room.on('buy_no', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'buy') return;
    if (currentPlayer(GAME) !== payload.senderId) return;
    pushLog(GAME, `${nameOf(payload.senderId)} declined to buy ${SPACES[GAME.pendingBuySpace].name}.`);
    startAuction(GAME, GAME.pendingBuySpace);
    broadcastSync();
  });

  room.on('auction_raise', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'auction' || !GAME.auction) return;
    const bidderId = payload.senderId;
    if (GAME.auction.order[GAME.auction.turnIdx] !== bidderId) return; // not their turn
    if (GAME.auction.passed[bidderId]) return;
    const step = payload.amount;
    if (!AUCTION_RAISE_STEPS.includes(step)) return; // only the three fixed buttons are valid
    const newBid = GAME.auction.bid + step;
    if (newBid > GAME.cash[bidderId]) return; // can't afford this raise
    GAME.auction.bid = newBid;
    GAME.auction.highestBidderId = bidderId;
    pushLog(GAME, `${nameOf(bidderId)} raises to Tk${newBid} for ${SPACES[GAME.auction.spaceIdx].name}.`);
    advanceAuctionTurn(GAME);
    GAME.auction.deadline = Date.now() + AUCTION_TURN_MS;
    broadcastSync();
  });

  room.on('auction_pass', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'auction' || !GAME.auction) return;
    const id = payload.senderId;
    if (GAME.auction.order[GAME.auction.turnIdx] !== id) return; // not their turn
    if (GAME.auction.passed[id]) return;
    GAME.auction.passed[id] = true;
    pushLog(GAME, `${nameOf(id)} passes on ${SPACES[GAME.auction.spaceIdx].name}.`);
    if (auctionActivePlayers(GAME).length > 1) {
      advanceAuctionTurn(GAME);
      GAME.auction.deadline = Date.now() + AUCTION_TURN_MS;
    } else {
      resolveAuctionIfDone(GAME);
    }
    broadcastSync();
  });

  room.on('pay_tax_flat', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'tax_choice') return;
    if (currentPlayer(GAME) !== payload.senderId) return;
    const space = SPACES[GAME.pendingTaxSpace];
    GAME.pendingTaxSpace = null;
    const ok = payAmount(GAME, payload.senderId, 'bank', space.amount, 'tax');
    if (ok) {
      pushLog(GAME, `${nameOf(payload.senderId)} paid the flat Tk${space.amount} income tax.`);
      GAME.phase = 'resolve';
      checkWin(GAME);
      if (ROOM.movementMode === 'cards') { continuePit(GAME); finishTrickCycle(GAME); }
    } // else: paused in 'debt' phase — raise cash or declare bankruptcy
    broadcastSync();
  });

  room.on('pay_tax_percent', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'tax_choice') return;
    if (currentPlayer(GAME) !== payload.senderId) return;
    const amount = Math.ceil(computeNetWorth(GAME, payload.senderId) * 0.1);
    GAME.pendingTaxSpace = null;
    const ok = payAmount(GAME, payload.senderId, 'bank', amount, 'tax');
    if (ok) {
      pushLog(GAME, `${nameOf(payload.senderId)} paid Tk${amount} income tax (10% of net worth).`);
      GAME.phase = 'resolve';
      checkWin(GAME);
      if (ROOM.movementMode === 'cards') { continuePit(GAME); finishTrickCycle(GAME); }
    } // else: paused in 'debt' phase — raise cash or declare bankruptcy
    broadcastSync();
  });

  room.on('mortgage_property', (payload) => {
    if (!isHost() || !GAME) return;
    const idx = payload.spaceIdx;
    const space = SPACES[idx];
    if (!space || GAME.owner[idx] !== payload.senderId) return;
    if (GAME.mortgaged[idx]) return;
    if (space.type === 'property' && (GAME.houses[idx] || 0) > 0) return; // sell houses first
    GAME.mortgaged[idx] = true;
    const value = mortgageValueOf(idx);
    GAME.cash[payload.senderId] += value;
    pushLog(GAME, `${nameOf(payload.senderId)} mortgaged ${space.name} for Tk${value}.`);
    broadcastSync();
  });

  room.on('unmortgage_property', (payload) => {
    if (!isHost() || !GAME) return;
    const idx = payload.spaceIdx;
    const space = SPACES[idx];
    if (!space || GAME.owner[idx] !== payload.senderId || !GAME.mortgaged[idx]) return;
    const cost = unmortgageCostOf(idx);
    if (GAME.cash[payload.senderId] < cost) return;
    GAME.cash[payload.senderId] -= cost;
    GAME.mortgaged[idx] = false;
    pushLog(GAME, `${nameOf(payload.senderId)} paid off the mortgage on ${space.name} for Tk${cost}.`);
    broadcastSync();
  });

  // 'raise money' phase: the debtor can mortgage properties / sell
  // houses (those actions already work regardless of turn/phase) and
  // then either pay off the debt once they can afford it, or give up.
  room.on('settle_debt', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'debt' || !GAME.debt) return;
    if (GAME.debt.playerId !== payload.senderId) return;
    const { playerId, toId, amount, context } = GAME.debt;
    if (GAME.cash[playerId] < amount) return; // still can't afford it
    GAME.cash[playerId] -= amount;
    if (toId !== 'bank') GAME.cash[toId] += amount;
    pushLog(GAME, `${nameOf(playerId)} raised the cash and paid off the Tk${amount} debt.`);
    GAME.debt = null;
    resumeAfterDebt(GAME, context, playerId, false);
    checkWin(GAME);
    broadcastSync();
  });

  room.on('declare_bankruptcy', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'debt' || !GAME.debt) return;
    if (GAME.debt.playerId !== payload.senderId) return;
    const { playerId, toId, context } = GAME.debt;
    GAME.debt = null;
    forceBankruptcy(GAME, playerId, toId);
    resumeAfterDebt(GAME, context, playerId, true);
    broadcastSync();
  });

  room.on('sell_house', (payload) => {
    if (!isHost() || !GAME) return;
    const idx = payload.spaceIdx;
    const space = SPACES[idx];
    if (!space || space.type !== 'property' || GAME.owner[idx] !== payload.senderId) return;
    const current = GAME.houses[idx] || 0;
    if (current <= 0) return;
    // Even-selling rule: sell from whichever property in the group
    // currently has the most houses first (mirror of even-building).
    const groupMax = Math.max(...GROUPS[space.group].map(i => GAME.houses[i] || 0));
    if (current < groupMax) return;
    if (!canSellOneDown(GAME, current)) return; // not enough houses in the bank to break a hotel back down
    applySellToBank(GAME, current);
    const refund = houseSaleValueOf(space.group);
    GAME.houses[idx] = current - 1;
    GAME.cash[payload.senderId] += refund;
    pushLog(GAME, `${nameOf(payload.senderId)} sold a house on ${space.name} for Tk${refund}.`);
    broadcastSync();
  });

  // Official rule: you may build houses/hotels at any time between any
  // player's dice rolls, not just on your own turn — so this is only
  // gated by ownership/monopoly/bank-supply, not by whose turn it is.
  room.on('build_house', (payload) => {
    if (!isHost() || !GAME || GAME.phase === 'gameover' || GAME.phase === 'auction') return;
    const idx = payload.spaceIdx;
    const space = SPACES[idx];
    if (!space || space.type !== 'property') return;
    if (GAME.owner[idx] !== payload.senderId) return;
    if (!houseGroupComplete(GAME, payload.senderId, space.group)) return;
    if (!houseGroupUnmortgaged(GAME, space.group)) return;
    const current = GAME.houses[idx] || 0;
    if (current >= 5) return;
    const groupMin = Math.min(...GROUPS[space.group].map(i => GAME.houses[i] || 0));
    if (current > groupMin) return; // even-building rule
    if (!canBuildOneMore(GAME, current)) return; // bank is out of houses/hotels
    const cost = GROUP_HOUSE_COST[space.group];
    if (GAME.cash[payload.senderId] < cost) return;
    GAME.cash[payload.senderId] -= cost;
    applyBuildToBank(GAME, current);
    GAME.houses[idx] = current + 1;
    pushLog(GAME, `${nameOf(payload.senderId)} built on ${space.name} (now ${GAME.houses[idx] >= 5 ? 'hotel' : GAME.houses[idx] + ' house(s)'}).`);
    broadcastSync();
  });

  room.on('pay_jail_fine', (payload) => {
    if (!isHost() || !GAME) return;
    if (ROOM.movementMode === 'cards') {
      if (GAME.phase === 'gameover') return; // otherwise payable any time — no personal "turn" in trick mode
    } else {
      if (GAME.phase !== 'roll' || currentPlayer(GAME) !== payload.senderId) return;
    }
    if (!GAME.jail[payload.senderId].in) return;
    if (GAME.cash[payload.senderId] < 50) return;
    GAME.cash[payload.senderId] -= 50;
    GAME.jail[payload.senderId] = { in:false, turns:0 };
    pushLog(GAME, `${nameOf(payload.senderId)} paid Tk50 bail.`);
    broadcastSync();
  });

  room.on('use_jail_card', (payload) => {
    if (!isHost() || !GAME) return;
    if (ROOM.movementMode === 'cards') {
      if (GAME.phase === 'gameover') return; // otherwise usable any time — no personal "turn" in trick mode
    } else {
      if (GAME.phase !== 'roll' || currentPlayer(GAME) !== payload.senderId) return;
    }
    const held = GAME.jailCardsHeld[payload.senderId];
    if (!GAME.jail[payload.senderId].in || !held || held.length === 0) return;
    const deckName = held.shift(); // return the card to the bottom of whichever deck it came from
    (deckName === 'chance' ? GAME.chancePile : GAME.chestPile).push(deckName === 'chance' ? CHANCE_GOOJF_IDX : CHEST_GOOJF_IDX);
    GAME.jail[payload.senderId] = { in:false, turns:0 };
    pushLog(GAME, `${nameOf(payload.senderId)} used a Get Out of Jail Free card (${deckName === 'chance' ? 'Chance' : 'Community Chest'}).`);
    broadcastSync();
  });

  room.on('end_turn', (payload) => {
    if (!isHost() || !GAME || GAME.phase !== 'resolve') return;
    if (currentPlayer(GAME) !== payload.senderId) return;
    doEndTurn(GAME);
    broadcastSync();
  });

  room.on('propose_trade', (payload) => {
    if (!isHost() || !GAME) return;
    const fromId = payload.senderId, toId = payload.toId;
    if (!GAME.order.includes(toId) || toId === fromId) return;
    if (GAME.bankrupt[fromId] || GAME.bankrupt[toId]) return;
    const trade = {
      id: GAME.nextTradeId++,
      fromId, toId,
      offerCash: Math.max(0, payload.offerCash | 0),
      offerProps: (payload.offerProps || []).filter(idx => isTradeable(GAME, idx, fromId)),
      offerJail: !!payload.offerJail,
      reqCash: Math.max(0, payload.reqCash | 0),
      reqProps: (payload.reqProps || []).filter(idx => isTradeable(GAME, idx, toId)),
      reqJail: !!payload.reqJail,
    };
    GAME.trades.push(trade);
    pushLog(GAME, `${nameOf(fromId)} proposed a trade to ${nameOf(toId)}.`);
    broadcastSync();
  });

  room.on('respond_trade', (payload) => {
    if (!isHost() || !GAME) return;
    const trade = GAME.trades.find(t => t.id === payload.tradeId);
    if (!trade || trade.toId !== payload.senderId) return;
    GAME.trades = GAME.trades.filter(t => t.id !== payload.tradeId);
    if (payload.accept) {
      if (canExecuteTrade(GAME, trade)) {
        executeTrade(GAME, trade);
        pushLog(GAME, `Trade accepted: ${tradeSummary(trade)}.`);
      } else {
        pushLog(GAME, `Trade between ${nameOf(trade.fromId)} and ${nameOf(trade.toId)} fell through (conditions changed).`);
      }
    } else {
      pushLog(GAME, `${nameOf(trade.toId)} declined a trade from ${nameOf(trade.fromId)}.`);
    }
    broadcastSync();
  });

  room.on('cancel_trade', (payload) => {
    if (!isHost() || !GAME) return;
    const trade = GAME.trades.find(t => t.id === payload.tradeId);
    if (!trade || trade.fromId !== payload.senderId) return;
    GAME.trades = GAME.trades.filter(t => t.id !== payload.tradeId);
    pushLog(GAME, `${nameOf(trade.fromId)} withdrew a trade offer.`);
    broadcastSync();
  });

  // ---- restart vote: host proposes, every seated player must agree ----
  room.on('restart_propose', (payload) => {
    if (!isHost() || !ROOM || !ROOM.started || ROOM.restartVote) return;
    const votes = {};
    ROOM.seats.forEach(id => { votes[id] = id === payload.senderId ? true : null; });
    setROOM({ ...ROOM, restartVote: { initiatorId: payload.senderId, votes } });
    broadcastSync();
  });

  room.on('restart_vote', (payload) => {
    if (!isHost() || !ROOM || !ROOM.restartVote) return;
    if (!(payload.senderId in ROOM.restartVote.votes)) return;
    const votes = { ...ROOM.restartVote.votes, [payload.senderId]: payload.vote };

    if (payload.vote === false) {
      setROOM({ ...ROOM, restartVote: null });
      broadcastSync();
      return;
    }

    setROOM({ ...ROOM, restartVote: { ...ROOM.restartVote, votes } });
    const allYes = Object.values(votes).every(v => v === true);
    if (allYes) {
      setGAME(freshGame(ROOM.seats));
      // Cards mode needs a fresh deal + a first trick started right
      // away, same as start_game does — restart used to skip this
      // entirely, leaving GAME.hands empty and the game stuck in the
      // dice-mode 'roll' phase, which Cards mode never resolves.
      if (ROOM.movementMode === 'cards') {
        dealNewHand(GAME);
        startNewTrick(GAME, GAME.order[0]);
      }
      setROOM({ ...ROOM, restartVote: null });
    }
    broadcastSync();
  });

  room.on('restart_cancel', (payload) => {
    if (!isHost() || !ROOM?.restartVote || ROOM.restartVote.initiatorId !== payload.senderId) return;
    setROOM({ ...ROOM, restartVote: null });
    broadcastSync();
  });

  room.on('request_sync', () => { if (isHost()) broadcastSync(); });

  room.on('sync', (payload) => {
    processChatUpdates(payload.room);
    setROOM(payload.room);
    setGAME(payload.game);
    renderFromState();
  });

  room.onPresence(({ ids }) => {
    setConnectedIds(ids);
    if (!ROOM || ids.length === 0) return;
    if (!ids.includes(ROOM.hostId) && ids[0] === myId) { setROOM({ ...ROOM, hostId: myId }); broadcastSync(); }

    // Track who's currently missing, for the idle-turn auto-skip below.
    // (Purely local bookkeeping on each client — not synced — so a
    // freshly-promoted host simply starts timing from the moment it
    // notices someone's gone, rather than trying to inherit an exact
    // "how long have they been gone" figure from the previous host.)
    const allKnownPlayers = ROOM.started ? GAME?.order : ROOM.seats;
    (allKnownPlayers || []).forEach(id => {
      if (ids.includes(id)) delete disconnectSince[id];
      else if (!(id in disconnectSince)) disconnectSince[id] = Date.now();
    });
  });

  await room.connect();
  document.getElementById('share-link').value = `${location.origin}${location.pathname}?room=${roomCode}`;
  document.getElementById('lobby-code').textContent = roomCode;
}

export function migratePlayerId(oldId, newId) {
  if (!ROOM || !GAME || oldId === newId) return;
  if (ROOM.hostId === oldId) ROOM.hostId = newId;
  ROOM.seats = ROOM.seats.map(id => (id === oldId ? newId : id));
  GAME.order = GAME.order.map(id => (id === oldId ? newId : id));
  for (const map of [GAME.cash, GAME.pos, GAME.jail, GAME.jailCardsHeld, GAME.bankrupt]) {
    if (map && oldId in map) { map[newId] = map[oldId]; delete map[oldId]; }
  }
  if (GAME.debt && GAME.debt.playerId === oldId) GAME.debt.playerId = newId;
  if (GAME.debt && GAME.debt.toId === oldId) GAME.debt.toId = newId;
  if (GAME.multiPayQueue) {
    GAME.multiPayQueue.forEach(p => {
      if (p.fromId === oldId) p.fromId = newId;
      if (p.toId === oldId) p.toId = newId;
    });
  }
  for (const idx of Object.keys(GAME.owner)) {
    if (GAME.owner[idx] === oldId) GAME.owner[idx] = newId;
  }
  (GAME.trades || []).forEach(t => {
    if (t.fromId === oldId) t.fromId = newId;
    if (t.toId === oldId) t.toId = newId;
  });
  if (GAME.auction) {
    GAME.auction.order = GAME.auction.order.map(id => (id === oldId ? newId : id));
    if (oldId in GAME.auction.passed) { GAME.auction.passed[newId] = GAME.auction.passed[oldId]; delete GAME.auction.passed[oldId]; }
    if (GAME.auction.highestBidderId === oldId) GAME.auction.highestBidderId = newId;
  }
  if (ROOM.names && oldId in ROOM.names) { ROOM.names[newId] = ROOM.names[oldId]; delete ROOM.names[oldId]; }

  // Cards mode (see CARDS MODE section above): hands, the trick in
  // progress, a pit-assignment in progress, and the movement queue are
  // all keyed by player id too — migratePlayerId used to skip these
  // entirely, so a player who claimed a disconnected seat mid-game
  // ended up with an empty hand (GAME.hands[newId] never existed) and
  // could get stranded mid-trick/mid-assignment.
  if (GAME.hands && oldId in GAME.hands) { GAME.hands[newId] = GAME.hands[oldId]; delete GAME.hands[oldId]; }
  if (GAME.trick) {
    GAME.trick.order = GAME.trick.order.map(id => (id === oldId ? newId : id));
    if (oldId in GAME.trick.plays) { GAME.trick.plays[newId] = GAME.trick.plays[oldId]; delete GAME.trick.plays[oldId]; }
  }
  if (GAME.pit) {
    if (GAME.pit.winnerId === oldId) GAME.pit.winnerId = newId;
    GAME.pit.otherIds = GAME.pit.otherIds.map(id => (id === oldId ? newId : id));
    if (oldId in GAME.pit.plays) { GAME.pit.plays[newId] = GAME.pit.plays[oldId]; delete GAME.pit.plays[oldId]; }
    if (oldId in GAME.pit.assigned) { GAME.pit.assigned[newId] = GAME.pit.assigned[oldId]; delete GAME.pit.assigned[oldId]; }
  }
  if (GAME.pitQueue) {
    GAME.pitQueue.forEach(entry => { if (entry.playerId === oldId) entry.playerId = newId; });
  }
  if (GAME.lastTrickWinner === oldId) GAME.lastTrickWinner = newId;

  delete disconnectSince[oldId];
}

export function broadcastSync() { room.send('sync', { room: ROOM, game: GAME }); }

// =========================================================
// IDLE-TURN SAFETY NET
// If it's a disconnected player's turn and they've been gone
// longer than ROOM.disconnectTimeoutMs, the host auto-performs
// a safe default for them using the exact same functions a real
// action would use (doRoll / doEndTurn / decline-purchase) — so
// this can never do anything a normal turn couldn't already do.
// Disconnection itself never bankrupts anyone; only the normal
// consequences of the auto-played action can (e.g. rent they
// can't cover), same as if they'd taken that action themselves.
// =========================================================
export function checkDisconnectTimeout() {
  if (!isHost() || !GAME || !ROOM || ROOM.disconnectTimeoutMs <= 0 || GAME.phase === 'gameover') return;

  // These two phases have an acting player who isn't necessarily
  // currentPlayer(GAME) (that pointer is only meaningful while a
  // movement queue is draining), so they're checked independently.
  if (GAME.phase === 'card_pit_assign' && GAME.pit) {
    const w = GAME.pit.winnerId;
    const wSince = disconnectSince[w];
    if (wSince && Date.now() - wSince >= ROOM.disconnectTimeoutMs) {
      pushLog(GAME, `${nameOf(w)} was disconnected too long — auto-assigned the pit numbers in order.`);
      const auto = {};
      GAME.pit.otherIds.forEach((id, i) => { auto[id] = GAME.pit.remainingValues[i]; });
      tryResolvePitAssignment(GAME, w, auto);
      checkWin(GAME);
      broadcastSync();
    }
    return;
  }
  if (GAME.phase === 'card_trick_play' && GAME.trick) {
    const acting = GAME.trick.order[GAME.trick.turnIdx];
    const since = disconnectSince[acting];
    if (since && Date.now() - since >= ROOM.disconnectTimeoutMs) {
      const hand = GAME.hands[acting] || [];
      const led = GAME.trick.ledSuit;
      const legal = led === null ? hand : (hand.some(c => cardSuit(c) === led) ? hand.filter(c => cardSuit(c) === led) : hand);
      const cardIdx = legal[0];
      pushLog(GAME, `${nameOf(acting)} was disconnected too long — auto-played ${cardLabel(cardIdx)}.`);
      playTrickCard(GAME, acting, cardIdx);
      checkWin(GAME);
      broadcastSync();
    }
    return;
  }

  const p = currentPlayer(GAME);
  if (GAME.bankrupt[p]) return;
  const since = disconnectSince[p];
  if (!since || Date.now() - since < ROOM.disconnectTimeoutMs) return;

  if (GAME.phase === 'buy') {
    pushLog(GAME, `${nameOf(p)} was disconnected too long — auto-declined the purchase.`);
    startAuction(GAME, GAME.pendingBuySpace);
  } else if (GAME.phase === 'tax_choice') {
    const space = SPACES[GAME.pendingTaxSpace];
    GAME.pendingTaxSpace = null;
    pushLog(GAME, `${nameOf(p)} was disconnected too long — auto-paid the flat tax.`);
    const ok = payAmount(GAME, p, 'bank', space.amount, 'tax');
    if (ok) {
      GAME.phase = 'resolve';
      if (ROOM.movementMode === 'cards') { continuePit(GAME); finishTrickCycle(GAME); }
    }
    // if not ok, they now owe a 'debt' — handled by the debt-timeout branch below on future ticks
  } else if (GAME.phase === 'roll') {
    pushLog(GAME, `${nameOf(p)} was disconnected too long — auto-rolling for them.`);
    doRoll(GAME, p);
  } else if (GAME.phase === 'resolve') {
    if (ROOM.movementMode === 'cards') {
      continuePit(GAME);
      finishTrickCycle(GAME);
    } else {
      pushLog(GAME, `${nameOf(p)} was disconnected too long — auto-ending their turn.`);
      doEndTurn(GAME);
    }
  } else {
    return; // nothing actionable in this phase (e.g. mid-auction, with no single "current player" to act for)
  }
  checkWin(GAME);
  broadcastSync();
}

// A disconnected player who owes a debt can't mortgage/sell to raise
// cash themselves — after the same timeout, auto-declare bankruptcy for
// them rather than freezing the game indefinitely.
export function checkDebtTimeout() {
  if (!isHost() || !GAME || !ROOM || ROOM.disconnectTimeoutMs <= 0 || GAME.phase !== 'debt' || !GAME.debt) return;
  const p = GAME.debt.playerId;
  const since = disconnectSince[p];
  if (!since || Date.now() - since < ROOM.disconnectTimeoutMs) return;
  const { toId, context } = GAME.debt;
  pushLog(GAME, `${nameOf(p)} was disconnected too long to raise cash — auto-declared bankruptcy.`);
  GAME.debt = null;
  forceBankruptcy(GAME, p, toId);
  resumeAfterDebt(GAME, context, p, true);
  broadcastSync();
}
setInterval(checkDebtTimeout, 5000);
setInterval(checkDisconnectTimeout, 5000);

// Enforces the 5-second-per-turn auction clock: if the player whose
// turn it is hasn't acted by the deadline, they're auto-passed (the
// same safe default a person could choose themselves) and the turn
// moves on. Checked every second for a reasonably tight deadline.
export function checkAuctionTimeout() {
  if (!isHost() || !GAME || GAME.phase !== 'auction' || !GAME.auction) return;
  if (Date.now() < GAME.auction.deadline) return;
  const id = GAME.auction.order[GAME.auction.turnIdx];
  GAME.auction.passed[id] = true;
  pushLog(GAME, `${nameOf(id)} ran out of time and auto-passed on ${SPACES[GAME.auction.spaceIdx].name}.`);
  if (auctionActivePlayers(GAME).length > 1) {
    advanceAuctionTurn(GAME);
    GAME.auction.deadline = Date.now() + AUCTION_TURN_MS;
  } else {
    resolveAuctionIfDone(GAME);
  }
  broadcastSync();
}
setInterval(checkAuctionTimeout, 1000);

// Purely cosmetic: keeps the auction countdown ticking smoothly on
// every client (not just whoever's host), without sending anything.
