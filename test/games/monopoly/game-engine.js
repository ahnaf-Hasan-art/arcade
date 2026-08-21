// =========================================================
// GAME ENGINE — pure game-rule functions. Every function here
// takes the game object 'g' and mutates it directly; none of
// this file touches the DOM or the network. Edit this file for:
// rent/tax/jail/trade/auction/bankruptcy rules, cheats, Cards
// mode trick-taking logic.
// =========================================================
import {
  SPACES, GROUPS, RAIL_IDXS, UTIL_IDXS, RAIL_RENTS, GROUP_HOUSE_COST,
  CHANCE_CARDS, CHEST_CARDS, CHANCE_GOOJF_IDX, CHEST_GOOJF_IDX,
  BANK_HOUSES_START, BANK_HOTELS_START, shuffled, shuffleArray, priceOf,
} from './board-data.js';
import { ROOM, nameOf, labelFor } from './state.js';

// =========================================================
// CARDS MODE — proper trick-taking, up to 4 players. Every
// hand deals exactly 13 cards to every seated player, no
// matter how many are seated (a 4-player game uses the whole
// 52-card deck; with fewer players, the leftover cards simply
// sit out unused until the next hand is dealt).
// Each trick, every player (jailed players included — they
// still play, they just never move) plays one card in turn
// order starting from the previous trick's winner (the very
// first trick starts from seat 1). You must follow the suit
// that was led if you're holding one. Spades are trump — any
// Spade beats any non-Spade regardless of rank; otherwise
// highest rank of the led suit wins (off-suit, non-trump
// sluffs can never win the trick).
//
// The trick's winner moves by the number on their OWN played
// card (A=14 down to 2), then freely assigns the OTHER played
// cards' numbers to the other participants however they like
// — not tied to whose card was whose. A jailed winner still
// gets to assign numbers to everyone else; their own token
// just doesn't move. Once every hand is exhausted, the deck
// reshuffles and a fresh hand is dealt, continuing seamlessly
// from the same trick rotation.
//
// The game ends the instant any player goes bankrupt; everyone
// else is ranked by cash + property value (see checkWin).
// =========================================================
export const CARD_RANK_LABELS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
export const CARD_SUIT_SYMBOLS = ['♠','♥','♦','♣'];
export function cardSuit(cardIdx) { return Math.floor(cardIdx / 13); } // 0=Spades,1=Hearts,2=Diamonds,3=Clubs
export function cardRankIdx(cardIdx) { return cardIdx % 13; }
export function cardValue(cardIdx) { return cardRankIdx(cardIdx) + 2; } // 2..14 (Ace=14)
export function cardLabel(cardIdx) { return CARD_RANK_LABELS[cardRankIdx(cardIdx)] + CARD_SUIT_SYMBOLS[cardSuit(cardIdx)]; }
// Does eligible card `a` beat eligible card `b`? (Both already known to
// be either the led suit or trump — see determineTrickWinner.) Spades
// beat any non-Spade; otherwise higher rank wins; a same-rank tie
// between two non-Spade suits breaks toward whichever suit sorts first.
export function cardBeats(a, b) {
  const aSpade = cardSuit(a) === 0, bSpade = cardSuit(b) === 0;
  if (aSpade !== bSpade) return aSpade;
  const av = cardValue(a), bv = cardValue(b);
  if (av !== bv) return av > bv;
  return cardSuit(a) < cardSuit(b);
}
export function handSizeForPlayers(n) { return 13; } // fixed regardless of player count — Cards mode caps at 4 players, so 13 each always fits within one 52-card deck

// Shuffles a fresh 52-card deck and deals 13 cards to every seated
// player (any cards left over when fewer than 4 are seated just sit
// out, unused, until the next hand).
export function dealNewHand(g) {
  const size = handSizeForPlayers(g.order.length);
  const deck = shuffled(Array.from({ length: 52 })); // NOT `new Array(52)` — that's all holes, and .map() skips holes, so it would silently deal every hand full of `undefined` cards
  g.hands = {};
  g.order.forEach((id, i) => { g.hands[id] = deck.slice(i * size, (i + 1) * size); });
  pushLog(g, `New hand dealt — ${size} cards each.`);
}

// Starts a fresh trick led by `leaderId`, in seat order from there.
// Every seated player takes part (jailed players play too).
export function startNewTrick(g, leaderId) {
  const li = g.order.indexOf(leaderId);
  const order = g.order.slice(li).concat(g.order.slice(0, li));
  g.trick = { order, turnIdx: 0, ledSuit: null, plays: {} };
  g.phase = 'card_trick_play';
}

// Attempts to play `cardIdx` from playerId's hand into the current
// trick. Enforces turn order and the must-follow-suit rule. Returns
// false (no state change) on any illegal attempt.
export function playTrickCard(g, playerId, cardIdx) {
  if (!g.trick || g.trick.order[g.trick.turnIdx] !== playerId) return false;
  const hand = g.hands[playerId] || [];
  const pos = hand.indexOf(cardIdx);
  if (pos === -1) return false;
  const suit = cardSuit(cardIdx);
  if (g.trick.ledSuit !== null && suit !== g.trick.ledSuit) {
    const hasLedSuit = hand.some(c => cardSuit(c) === g.trick.ledSuit);
    if (hasLedSuit) return false; // must follow suit when able
  }
  hand.splice(pos, 1);
  g.trick.plays[playerId] = cardIdx;
  if (g.trick.ledSuit === null) g.trick.ledSuit = suit;
  g.trick.turnIdx++;
  if (g.trick.turnIdx >= g.trick.order.length) resolveTrick(g);
  return true;
}

// Only cards of the led suit or Spades (trump) are eligible to win a
// trick — an off-suit, non-trump sluff can never take it, no matter
// its rank.
export function determineTrickWinner(g) {
  const led = g.trick.ledSuit;
  let winnerId = null, winnerCard = null;
  for (const id of g.trick.order) {
    const c = g.trick.plays[id];
    if (cardSuit(c) !== 0 && cardSuit(c) !== led) continue; // ineligible sluff
    if (winnerCard === null || cardBeats(c, winnerCard)) { winnerId = id; winnerCard = c; }
  }
  return winnerId;
}

// All four cards are in — determine the winner and hand off to the
// 'card_pit_assign' phase for them to distribute the other numbers.
export function resolveTrick(g) {
  const { order, plays } = g.trick;
  const winnerId = determineTrickWinner(g);
  const winnerVal = cardValue(plays[winnerId]);
  const otherIds = order.filter(id => id !== winnerId);
  const remainingValues = otherIds.map(id => cardValue(plays[id]));
  pushLog(g, `Trick: ${order.map(id => `${nameOf(id)} ${cardLabel(plays[id])}`).join(', ')} — ${nameOf(winnerId)} wins with ${cardLabel(plays[winnerId])}${g.jail[winnerId].in ? ' (in Jail — assigns movement but doesn\u2019t move)' : ''} and must assign ${remainingValues.join(', ')} to the others.`);
  g.pit = { winnerId, winnerVal, otherIds, remainingValues, plays, assigned: {} };
  g.lastTrickWinner = winnerId; // leads the next trick, even across a reshuffle
  g.trick = null;
  g.phase = 'card_pit_assign';
}

// The winner submits a full assignment of the remaining card numbers to
// the other trick participants (any bijection they like). Validates
// it's an exact permutation of the values actually in play. Jailed
// participants (winner included) still receive/give numbers but never
// actually move.
export function tryResolvePitAssignment(g, winnerId, assignments) {
  if (!g.pit || g.pit.winnerId !== winnerId) return false;
  const { otherIds, remainingValues, winnerVal } = g.pit;
  const chosen = otherIds.map(id => assignments[id]);
  if (chosen.some(v => typeof v !== 'number' || !Number.isFinite(v))) return false;
  const need = remainingValues.slice().sort((a, b) => a - b);
  const got = chosen.slice().sort((a, b) => a - b);
  if (need.length !== got.length || !need.every((v, i) => v === got[i])) return false;

  const queue = [];
  if (!g.jail[winnerId].in) queue.push({ playerId: winnerId, spaces: winnerVal });
  else pushLog(g, `${nameOf(winnerId)} is in Jail and stays put despite winning the trick.`);
  otherIds.forEach(id => {
    if (!g.jail[id].in) queue.push({ playerId: id, spaces: assignments[id] });
    else pushLog(g, `${nameOf(id)} is in Jail and stays put.`);
  });
  g.pit = null;
  g.pitQueue = queue;
  g.phase = 'resolve';
  continuePit(g);
  finishTrickCycle(g);
  return true;
}

// Drains the trick's movement queue while the game is fully settled
// ('resolve'). Each queued mover is briefly made the "current player"
// (via turnIdx) so all the existing buy/tax/debt/auction machinery —
// normally written assuming only the current player ever lands —
// works unchanged for whoever's moving. If a landing opens a pending
// decision (buy/tax_choice/debt/auction), this pauses here; whichever
// handler resolves that decision back to 'resolve' calls continuePit
// again to keep draining. A no-op in dice mode (pitQueue stays null).
export function continuePit(g) {
  if (g.phase !== 'resolve' || !g.pitQueue || !g.pitQueue.length) return;
  const next = g.pitQueue.shift();
  if (g.bankrupt[next.playerId]) { continuePit(g); return; }
  g.turnIdx = g.order.indexOf(next.playerId);
  g.lastRoll = [next.spaces, 0]; // stand-in "dice sum" for any Chance/Chest util-rent reference
  const np = (g.pos[next.playerId] + next.spaces) % 40;
  movePlayerTo(g, next.playerId, np);
  landOn(g, next.playerId, np, next.spaces);
  continuePit(g);
}

// Once a trick's whole movement queue has drained with nothing left
// pending, moves on: reshuffles and deals a new hand if everyone's
// hand is now empty, then starts the next trick led by whoever won
// the last one. A no-op outside Cards mode.
export function finishTrickCycle(g) {
  if (!ROOM || ROOM.movementMode !== 'cards') return;
  if (g.phase !== 'resolve' || (g.pitQueue && g.pitQueue.length) || g.pit || g.trick) return;
  g.pitQueue = null;
  if ((g.hands[g.order[0]] || []).length === 0) dealNewHand(g);
  startNewTrick(g, g.lastTrickWinner ?? g.order[0]);
}

// =========================================================
// GAME ENGINE — host mutates this directly, then broadcasts
// the full object as JSON. Trading is supported (cash,
// properties, Get Out of Jail Free cards); mortgaging and
// auctions are still out of scope.
// =========================================================
export function freshGame(order) {
  const cash = {}, pos = {}, jail = {}, jailCardsHeld = {}, bankrupt = {};
  order.forEach(id => { cash[id] = 1500; pos[id] = 0; jail[id] = { in:false, turns:0 }; jailCardsHeld[id] = []; bankrupt[id] = false; });
  return {
    order, cash, pos, owner: {}, houses: {}, mortgaged: {}, jail, jailCardsHeld, bankrupt,
    turnIdx: 0, phase: 'roll', lastRoll: [1,1], doublesStreak: 0,
    pendingBuySpace: null, pendingTaxSpace: null, auction: null,
    bankruptcyAuctionQueue: [], // spaceIdxs still waiting to be auctioned after the current auction resolves
    debt: null,           // { playerId, toId, amount, context } — pending "raise money or go bankrupt" situation
    multiPayQueue: null,  // queued per-player payments for collectEach/payEach card effects
    houseBank: BANK_HOUSES_START,
    hotelBank: BANK_HOTELS_START,
    chancePile: shuffled(CHANCE_CARDS), chanceDiscard: [],
    chestPile: shuffled(CHEST_CARDS), chestDiscard: [],
    trades: [], nextTradeId: 1,
    log: ['Game started.'], winnerId: null, finalRanking: null,
    announcement: null, // { kind:'card'|'jail', text, ts } — drives the toast popup
    // Cards movement mode (see CARDS MODE section above) — unused/inert
    // when ROOM.movementMode is 'dice'.
    hands: {},            // { playerId: [cardIdx,...] } — current trick-taking hand
    trick: null,           // { order, turnIdx, ledSuit, plays } — trick currently being played out
    pit: null,              // { winnerId, winnerVal, otherIds, remainingValues, plays, assigned } — set while the winner distributes movement
    pitQueue: null,          // [{playerId, spaces}, ...] — movers still waiting to move+land once assignment is confirmed
    lastTrickWinner: null,    // leads the next trick
  };
}

export function currentPlayer(g) { return g.order[g.turnIdx]; }
export function pushLog(g, msg) { g.log = [...g.log.slice(-11), msg]; }

export function livingOrder(g) { return g.order.filter(id => !g.bankrupt[id]); }

export function advanceTurn(g) {
  g.doublesStreak = 0;
  g.phase = 'roll';
  const n = g.order.length;
  for (let i = 1; i <= n; i++) {
    const next = (g.turnIdx + i) % n;
    if (!g.bankrupt[g.order[next]]) { g.turnIdx = next; return; }
  }
}

export function checkWin(g) {
  if (ROOM && ROOM.movementMode === 'cards') {
    const bankruptIds = g.order.filter(id => g.bankrupt[id]);
    if (bankruptIds.length > 0 && g.phase !== 'gameover') {
      const remaining = livingOrder(g).sort((a, b) => computeNetWorth(g, b) - computeNetWorth(g, a));
      g.finalRanking = [...remaining, ...bankruptIds];
      g.phase = 'gameover';
      g.winnerId = remaining[0] || null;
      pushLog(g, `${nameOf(bankruptIds[0])} went bankrupt — game over! Ranking: ${g.finalRanking.map((id, i) => `${i + 1}. ${nameOf(id)}`).join(', ')}`);
    }
    return;
  }
  const alive = livingOrder(g);
  if (alive.length <= 1) {
    g.phase = 'gameover';
    g.winnerId = alive[0] || null;
    pushLog(g, alive.length === 1 ? `${nameOf(alive[0])} wins the game!` : 'Game over.');
  }
}
// Every other on-screen label (players box, seat list, chat) numbers
// people by seat index — "Player 1", "Player 2", etc. — unless that
// player has chosen their own display name in the lobby, in which case
// that name is used instead. This is the shared text baked into the
// game log/toasts/trade summaries (identical for every viewer), so
// unlike labelFor() below it never says "You".

export function ownerCountInGroup(g, ownerId, groupIdxs) {
  return groupIdxs.filter(i => g.owner[i] === ownerId).length;
}

export function houseGroupComplete(g, ownerId, group) {
  const idxs = GROUPS[group];
  return idxs.every(i => g.owner[i] === ownerId);
}

// Official rule: you can't build on a color group while any property
// in it is mortgaged (and, symmetrically, can't mortgage a property
// that still has houses on it — enforced separately in the handler).
export function houseGroupUnmortgaged(g, group) {
  return GROUPS[group].every(i => !g.mortgaged[i]);
}

export function mortgageValueOf(spaceIdx) { return Math.floor(priceOf(spaceIdx) / 2); }
export function unmortgageCostOf(spaceIdx) {
  const mv = mortgageValueOf(spaceIdx);
  return mv + Math.ceil(mv * 0.1); // 10% interest, official rule
}
export function houseSaleValueOf(group) { return Math.floor(GROUP_HOUSE_COST[group] / 2); } // sell back at half price

// Bank supply checks: going from `current` houses to `current+1` either
// consumes one house from the bank (current 0-3) or converts 4 houses
// into a hotel (current === 4, consumes the bank's last hotel and
// returns the 4 houses to the bank's house pool).
export function canBuildOneMore(g, current) {
  if (current >= 5) return false;
  if (current === 4) return g.hotelBank > 0;
  return g.houseBank > 0;
}
export function applyBuildToBank(g, current) {
  if (current === 4) { g.hotelBank -= 1; g.houseBank += 4; }
  else { g.houseBank -= 1; }
}
// Selling down from `current` to `current-1`: selling a hotel (current
// === 5) needs 4 houses available in the bank to break it back down;
// selling a plain house just returns 1 house to the bank.
export function canSellOneDown(g, current) {
  if (current <= 0) return false;
  if (current === 5) return g.houseBank >= 4;
  return true;
}
export function applySellToBank(g, current) {
  if (current === 5) { g.hotelBank += 1; g.houseBank -= 4; }
  else { g.houseBank += 1; }
}
// Returns all houses/hotels currently on a property to the bank pool and
// clears them — used when a property is forfeited in bankruptcy.
export function forfeitHousesAt(g, idx) {
  const current = g.houses[idx] || 0;
  if (current === 5) { g.hotelBank += 1; }
  else if (current > 0) { g.houseBank += current; }
  g.houses[idx] = 0;
}

// Net worth for the Income Tax 10% option: cash + face value of every
// owned property/rail/util (mortgaged or not) + what was paid for
// every house/hotel currently built.
export function computeNetWorth(g, playerId) {
  let total = g.cash[playerId] || 0;
  for (const idxStr of Object.keys(g.owner)) {
    const idx = Number(idxStr);
    if (g.owner[idx] !== playerId) continue;
    total += priceOf(idx);
    const space = SPACES[idx];
    if (space.type === 'property') {
      total += (g.houses[idx] || 0) * GROUP_HOUSE_COST[space.group];
    }
  }
  return total;
}

export function computeRent(g, spaceIdx, ownerId, diceSum) {
  if (g.mortgaged[spaceIdx]) return 0; // mortgaged properties collect no rent
  const space = SPACES[spaceIdx];
  if (space.type === 'rail') {
    const count = RAIL_IDXS.filter(i => g.owner[i] === ownerId).length;
    return count === 0 ? 0 : RAIL_RENTS[Math.max(0, count - 1)];
  }
  if (space.type === 'util') {
    const count = UTIL_IDXS.filter(i => g.owner[i] === ownerId).length;
    return diceSum * (count >= 2 ? 10 : 4);
  }
  const houses = g.houses[spaceIdx] || 0;
  if (houses > 0) return space.rent[houses];
  const monopoly = houseGroupComplete(g, ownerId, space.group);
  return monopoly ? space.rent[0] * 2 : space.rent[0];
}

// Pays `amount` from `fromId` toward `toId` ('bank' or a player id).
// If fromId can't cover it outright, this does NOT bankrupt them on the
// spot — real Monopoly gives you a chance to raise the cash first
// (mortgaging properties, selling houses) before you have to declare
// bankruptcy. So instead this pauses the game in a 'debt' phase and
// returns false; the debtor can then mortgage/sell freely (those
// actions work regardless of turn/phase) and either pay off the debt
// via 'settle_debt' once they can afford it, or give up via
// 'declare_bankruptcy'. Returns true if the amount was paid immediately.
export function payAmount(g, fromId, toId, amount, context = 'generic') {
  if (amount <= 0) return true;
  if (g.cash[fromId] >= amount) {
    g.cash[fromId] -= amount;
    if (toId !== 'bank') g.cash[toId] += amount;
    return true;
  }
  g.debt = { playerId: fromId, toId, amount, context };
  g.phase = 'debt';
  pushLog(g, `${nameOf(fromId)} owes Tk${amount} to ${toId === 'bank' ? 'the Bank' : nameOf(toId)} but only has Tk${g.cash[fromId]} — they must raise cash (mortgage/sell houses) or declare bankruptcy.`);
  return false;
}

// Declares fromId bankrupt to toId ('bank' or a player). Pays over
// whatever cash remains, then forfeits every owned property:
//  - to a player creditor: properties transfer to them; any mortgaged
//    ones transfer with houses cleared (returned to the bank pool),
//    and the creditor must immediately pay the bank 10% of the
//    mortgage value as a transfer fee (official rule).
//  - to the bank: properties don't just sit idle — every one of them
//    goes up for auction immediately, one after another.
export function forceBankruptcy(g, fromId, toId) {
  const paid = Math.max(0, g.cash[fromId]);
  if (toId !== 'bank') g.cash[toId] += paid;
  g.cash[fromId] = 0;
  g.bankrupt[fromId] = true;
  pushLog(g, `${nameOf(fromId)} went bankrupt!`);

  const forfeitedToBank = [];
  for (const idxStr of Object.keys(g.owner)) {
    const idx = Number(idxStr);
    if (g.owner[idx] !== fromId) continue;
    const wasMortgaged = !!g.mortgaged[idx];
    forfeitHousesAt(g, idx); // houses/hotels always return to the bank pool
    if (toId !== 'bank') {
      g.owner[idx] = toId;
      if (wasMortgaged) {
        const fee = Math.ceil(mortgageValueOf(idx) * 0.1);
        // Official rule: the creditor must immediately pay the bank 10%
        // of the mortgage value, or unmortgage the property outright.
        // Simplified here to a straight fee (clamped so it can't push
        // their own cash negative) rather than opening a second nested
        // debt situation.
        const actualFee = Math.min(fee, g.cash[toId]);
        g.cash[toId] -= actualFee;
        pushLog(g, `${nameOf(toId)} paid Tk${actualFee} transfer fee on mortgaged ${SPACES[idx].name} inherited from ${nameOf(fromId)}.`);
      }
    } else {
      delete g.owner[idx];
      g.mortgaged[idx] = false;
      forfeitedToBank.push(idx);
    }
  }

  g.debt = null;
  g.phase = 'resolve'; // may be overridden to 'auction' below, or to 'gameover' by checkWin
  checkWin(g);
  if (g.phase !== 'gameover' && toId === 'bank' && forfeitedToBank.length > 0) {
    startBankruptcyAuctions(g, forfeitedToBank);
  }
}

// Queues every one of a bankrupt-to-the-bank player's forfeited
// properties for auction, one at a time (chained via
// resolveAuctionIfDone once each auction settles).
export function startBankruptcyAuctions(g, spaceIdxs) {
  if (!spaceIdxs.length) return;
  g.bankruptcyAuctionQueue = spaceIdxs.slice(1);
  startAuction(g, spaceIdxs[0]);
}

// A single "pay everyone" or "collect from everyone" card effect is
// really a sequence of individual payments. If one of them can't be
// covered, we pause in the 'debt' phase for just that payer — once
// resolved (paid or bankrupted), the rest of the queue continues.
export function queueMultiPay(g, pairs) {
  g.multiPayQueue = pairs;
  processMultiPayQueue(g);
}
export function processMultiPayQueue(g) {
  while (g.multiPayQueue && g.multiPayQueue.length) {
    const { fromId, toId, amount } = g.multiPayQueue[0];
    if (g.bankrupt[fromId]) { g.multiPayQueue.shift(); continue; }
    const ok = payAmount(g, fromId, toId, amount, 'multiPay');
    if (!ok) return; // paused — resumes via settle_debt/declare_bankruptcy
    g.multiPayQueue.shift();
  }
  g.multiPayQueue = null;
}

export function collectFromEach(g, toId, amount) {
  const pairs = g.order.filter(id => id !== toId && !g.bankrupt[id]).map(id => ({ fromId: id, toId, amount }));
  queueMultiPay(g, pairs);
}
export function payToEach(g, fromId, amount) {
  const pairs = g.order.filter(id => id !== fromId && !g.bankrupt[id]).map(id => ({ fromId, toId: id, amount }));
  queueMultiPay(g, pairs);
}

// Called after a 'debt' situation is resolved (paid off or the debtor
// went bankrupt) to put the game back into a sane phase and continue
// whatever was interrupted.
export function resumeAfterDebt(g, context, playerId, bankrupted) {
  if (context === 'jailFine' && !bankrupted) {
    // Only reachable in dice mode (three failed doubles rolls force a
    // paid release) — cards mode lets a jailed player pay/use a card
    // any time, with no forced-after-3-tries mechanic.
    g.jail[playerId] = { in:false, turns:0 };
    pushLog(g, `${nameOf(playerId)} paid Tk50 to leave Jail after 3 tries.`);
    const [d1, d2] = g.lastRoll;
    const np = (g.pos[playerId] + d1 + d2) % 40;
    movePlayerTo(g, playerId, np);
    landOn(g, playerId, np, d1 + d2);
    checkWin(g);
    return;
  }
  if (context === 'multiPay') {
    processMultiPayQueue(g);
    if (g.phase === 'debt') return; // another player in the same batch now owes money
  }
  if (g.phase !== 'auction' && g.phase !== 'buy' && g.phase !== 'debt') g.phase = 'resolve';
  if (ROOM && ROOM.movementMode === 'cards') {
    continuePit(g);
    finishTrickCycle(g);
  } else if (g.phase === 'resolve' && g.bankrupt[currentPlayer(g)]) {
    doEndTurn(g);
  }
}

export function movePlayerTo(g, playerId, newPos, { awardGo = true } = {}) {
  const old = g.pos[playerId];
  if (awardGo && newPos <= old) { g.cash[playerId] += 200; pushLog(g, `${nameOf(playerId)} passed GO, collected Tk200.`); }
  g.pos[playerId] = newPos;
}

// Draws the next card from the given deck, reshuffling the discard pile
// back into play whenever the draw pile runs dry (real-deck behavior,
// instead of cycling through the same fixed order forever). A drawn Get
// Out of Jail Free card is held by the player (removed from circulation)
// rather than going to the discard pile — it only returns to the deck
// when used.
export function drawCard(g, deckName) {
  const cardsArr = deckName === 'chance' ? CHANCE_CARDS : CHEST_CARDS;
  const pileKey = deckName === 'chance' ? 'chancePile' : 'chestPile';
  const discardKey = deckName === 'chance' ? 'chanceDiscard' : 'chestDiscard';
  if (g[pileKey].length === 0) {
    if (g[discardKey].length === 0) {
      g[pileKey] = shuffled(cardsArr); // safety fallback: every card is somehow out of circulation
    } else {
      g[pileKey] = shuffleArray(g[discardKey]);
      g[discardKey] = [];
      pushLog(g, `The ${deckName === 'chance' ? 'Chance' : 'Community Chest'} deck was reshuffled.`);
    }
  }
  const cardIdx = g[pileKey].shift();
  return { cardIdx, card: cardsArr[cardIdx] };
}

export function applyCard(g, playerId, deckName) {
  const { cardIdx, card } = drawCard(g, deckName);
  if (card.effect.type === 'getoutfree') {
    g.jailCardsHeld[playerId].push(deckName); // held by the player, out of the deck until used
  } else {
    (deckName === 'chance' ? g.chanceDiscard : g.chestDiscard).push(cardIdx);
  }
  pushLog(g, `${nameOf(playerId)} drew: ${card.text}`);
  g.announcement = {
    kind: 'card',
    text: `${nameOf(playerId)} drew ${deckName === 'chance' ? 'Chance' : 'Community Chest'}: ${card.text}`,
    ts: Date.now(),
  };
  const e = card.effect;
  if (e.type === 'collect') g.cash[playerId] += e.amount;
  else if (e.type === 'pay') payAmount(g, playerId, 'bank', e.amount, 'card');
  else if (e.type === 'collectEach') collectFromEach(g, playerId, e.amount);
  else if (e.type === 'payEach') payToEach(g, playerId, e.amount);
  else if (e.type === 'getoutfree') {} // already granted above, before the effect switch
  else if (e.type === 'gotojail') sendToJail(g, playerId, { announce: false }); // card text already says it
  else if (e.type === 'moveRelative') {
    let np = (g.pos[playerId] + e.delta + 40) % 40;
    movePlayerTo(g, playerId, np, { awardGo:false });
    landOn(g, playerId, np, g.lastRoll[0] + g.lastRoll[1]);
  } else if (e.type === 'moveTo') {
    movePlayerTo(g, playerId, e.idx);
    landOn(g, playerId, e.idx, g.lastRoll[0] + g.lastRoll[1]);
  } else if (e.type === 'nearestRail') {
    const np = RAIL_IDXS.find(i => i > g.pos[playerId]) ?? RAIL_IDXS[0];
    movePlayerTo(g, playerId, np);
    landOn(g, playerId, np, g.lastRoll[0] + g.lastRoll[1], { doubleRent:true });
  } else if (e.type === 'nearestUtil') {
    const np = UTIL_IDXS.find(i => i > g.pos[playerId]) ?? UTIL_IDXS[0];
    movePlayerTo(g, playerId, np);
    landOn(g, playerId, np, g.lastRoll[0] + g.lastRoll[1], { tenXUtil:true });
  } else if (e.type === 'repairs') {
    let total = 0;
    for (const idxStr of Object.keys(g.owner)) {
      const idx = Number(idxStr);
      if (g.owner[idx] === playerId) {
        const h = g.houses[idx] || 0;
        total += h === 5 ? e.perHotel : h * e.perHouse;
      }
    }
    payAmount(g, playerId, 'bank', total, 'card');
  }
}

export function sendToJail(g, playerId, opts = {}) {
  g.pos[playerId] = 10;
  g.jail[playerId] = { in:true, turns:0 };
  g.phase = 'resolve';
  pushLog(g, `${nameOf(playerId)} was sent to Jail.`);
  if (opts.announce !== false) {
    g.announcement = { kind: 'jail', text: `${nameOf(playerId)} was sent to Jail!`, ts: Date.now() };
  }
}

// Resolves whatever space a player just landed on. May set phase to
// 'buy' (waiting on the player) or 'resolve' (done, ready to end turn).
export function landOn(g, playerId, spaceIdx, diceSum, opts = {}) {
  const space = SPACES[spaceIdx];
  if (space.type === 'property' || space.type === 'rail' || space.type === 'util') {
    const owner = g.owner[spaceIdx];
    if (owner === undefined) {
      g.pendingBuySpace = spaceIdx;
      g.phase = 'buy';
      pushLog(g, `${nameOf(playerId)} landed on ${space.name} (unowned, Tk${priceOf(spaceIdx)}).`);
      return;
    }
    if (owner !== playerId) {
      if (g.mortgaged[spaceIdx]) {
        pushLog(g, `${nameOf(playerId)} landed on ${space.name} — it's mortgaged, no rent due.`);
      } else {
        let rent = computeRent(g, spaceIdx, owner, diceSum);
        if (opts.doubleRent) rent *= 2;
        if (opts.tenXUtil) rent = diceSum * 10;
        const ok = payAmount(g, playerId, owner, rent, 'rent');
        if (ok) pushLog(g, `${nameOf(playerId)} paid Tk${rent} rent to ${nameOf(owner)} for ${space.name}.`);
        else { checkWin(g); return; } // paused — raising cash or declaring bankruptcy
      }
    }
    g.phase = 'resolve';
  } else if (space.type === 'tax') {
    if (space.hasChoice) {
      g.pendingTaxSpace = spaceIdx;
      g.phase = 'tax_choice';
      pushLog(g, `${nameOf(playerId)} landed on ${space.name} — choosing how to pay.`);
    } else {
      const ok = payAmount(g, playerId, 'bank', space.amount, 'tax');
      if (ok) { pushLog(g, `${nameOf(playerId)} paid Tk${space.amount} tax.`); g.phase = 'resolve'; }
      else { checkWin(g); return; } // paused — raising cash or declaring bankruptcy
    }
  } else if (space.type === 'chance') {
    applyCard(g, playerId, 'chance');
    if (g.phase !== 'buy' && g.phase !== 'debt' && g.phase !== 'auction') g.phase = 'resolve';
  } else if (space.type === 'chest') {
    applyCard(g, playerId, 'chest');
    if (g.phase !== 'buy' && g.phase !== 'debt' && g.phase !== 'auction') g.phase = 'resolve';
  } else if (space.type === 'gotojail') {
    sendToJail(g, playerId);
  } else {
    g.phase = 'resolve'; // go, jail(visiting), parking
  }
  checkWin(g);
}

// =========================================================
// CHEATS — dev/testing shortcuts, gated to the host in the
// 'cheat_command' handler below. Every cheat mutates GAME
// directly and returns a short human-readable result string
// that gets pushed to ROOM.cheatLog (shown in the cheat
// window) and echoed as a one-line entry into the main game
// log, so what happened is never a mystery mid-test.
// =========================================================
export const CHEAT_SUITS = { spades:0, s:0, hearts:1, h:1, diamonds:2, d:2, clubs:3, c:3 };

// Hands spaceIdx to playerId for free. Any houses on it are returned to
// the bank pool first and any mortgage is cleared, so a cheated
// property never leaves the bank bookkeeping in a broken state.
export function cheatGrantSpace(g, playerId, idx) {
  const space = SPACES[idx];
  if (space.type === 'property') forfeitHousesAt(g, idx);
  g.mortgaged[idx] = false;
  g.owner[idx] = playerId;
}
export function cheatGrantSet(g, playerId, idxs) {
  idxs.forEach(idx => cheatGrantSpace(g, playerId, idx));
  return idxs.length;
}

// Runs one cheat command for playerId against live game state g.
// Returns { ok, text } — ok=false renders the entry as an error in the
// cheat log (still logged, just styled red) instead of throwing.
export function executeCheat(g, playerId, raw) {
  const text = String(raw || '').trim();
  if (!text) return { ok:false, text:'Type a command — try "help".' };
  const sepIdx = text.indexOf(':');
  const cmd = (sepIdx === -1 ? text : text.slice(0, sepIdx)).trim().toLowerCase();
  const arg = sepIdx === -1 ? '' : text.slice(sepIdx + 1).trim();

  if (!g) return { ok:false, text:'No game in progress.' };
  if (g.phase === 'gameover') return { ok:false, text:'Game is over — cheats disabled.' };

  switch (cmd) {
    case 'help':
      return { ok:true, text:'allproperty, allcoloredproperty, allrails, allutils, monopoly:<color>, maxhouses, goto:<idx|name>, forcelead:<suit>' };

    case 'allproperty': {
      const idxs = SPACES.filter(s => s.type === 'property' || s.type === 'rail' || s.type === 'util').map(s => s.idx);
      const n = cheatGrantSet(g, playerId, idxs);
      return { ok:true, text:`${nameOf(playerId)} now owns all ${n} properties for Tk0.` };
    }

    case 'allcoloredproperty': {
      const idxs = SPACES.filter(s => s.type === 'property').map(s => s.idx);
      const n = cheatGrantSet(g, playerId, idxs);
      return { ok:true, text:`${nameOf(playerId)} now owns all ${n} colored (house-eligible) properties for Tk0.` };
    }

    case 'allrails': {
      const n = cheatGrantSet(g, playerId, RAIL_IDXS);
      return { ok:true, text:`${nameOf(playerId)} now owns all ${n} railroads for Tk0.` };
    }

    case 'allutils': {
      const n = cheatGrantSet(g, playerId, UTIL_IDXS);
      return { ok:true, text:`${nameOf(playerId)} now owns both utilities for Tk0.` };
    }

    case 'monopoly': {
      const group = arg.toLowerCase();
      if (!GROUPS[group]) return { ok:false, text:`Unknown color "${arg}". Try: ${Object.keys(GROUPS).join(', ')}.` };
      const n = cheatGrantSet(g, playerId, GROUPS[group]);
      return { ok:true, text:`${nameOf(playerId)} now owns the full ${group} group (${n} properties) for Tk0.` };
    }

    case 'maxhouses': {
      let count = 0;
      Object.keys(g.owner).forEach(idxStr => {
        const idx = Number(idxStr);
        const space = SPACES[idx];
        if (!space || space.type !== 'property' || g.owner[idx] !== playerId) return;
        const cur = g.houses[idx] || 0;
        if (cur === 5) return;
        if (cur > 0) g.houseBank += cur; // return existing houses to the pool
        g.houses[idx] = 5;
        g.hotelBank -= 1; // may go negative — that's the point, for testing supply limits
        count++;
      });
      if (count === 0) return { ok:false, text:`${nameOf(playerId)} doesn't own any colored properties yet.` };
      return { ok:true, text:`${nameOf(playerId)} slapped a hotel on ${count} propert${count === 1 ? 'y' : 'ies'} (hotel bank now ${g.hotelBank}).` };
    }

    case 'goto': {
      if (!arg) return { ok:false, text:'Usage: goto:<space index or name>' };
      let idx = null;
      if (/^\d+$/.test(arg)) {
        const n = Number(arg);
        if (n >= 0 && n < SPACES.length) idx = n;
      } else {
        const q = arg.toLowerCase();
        const exact = SPACES.find(s => s.name.toLowerCase() === q);
        const partial = exact || SPACES.find(s => s.name.toLowerCase().includes(q));
        if (partial) idx = partial.idx;
      }
      if (idx === null) return { ok:false, text:`No space matches "${arg}".` };
      if (!['roll', 'resolve'].includes(g.phase)) return { ok:false, text:`Can't teleport mid-"${g.phase}" — resolve that first.` };
      // Same trick continuePit() uses: briefly make the teleported player
      // the acting player so the existing buy/tax/rent/card machinery
      // (which all key off "current player") works unmodified.
      g.turnIdx = g.order.indexOf(playerId);
      movePlayerTo(g, playerId, idx);
      landOn(g, playerId, idx, g.lastRoll[0] + g.lastRoll[1]);
      return { ok:true, text:`${nameOf(playerId)} teleported to ${SPACES[idx].name}.` };
    }

    case 'forcelead': {
      if (!ROOM || ROOM.movementMode !== 'cards') return { ok:false, text:'forcelead only applies in Cards mode.' };
      if (!g.trick) return { ok:false, text:'No trick is currently being played.' };
      if (Object.keys(g.trick.plays).length > 0) return { ok:false, text:'A card has already been played this trick — too late to force the led suit.' };
      const suitIdx = CHEAT_SUITS[arg.toLowerCase()];
      if (suitIdx === undefined) return { ok:false, text:`Unknown suit "${arg}". Try: spades, hearts, diamonds, clubs.` };
      g.trick.ledSuit = suitIdx;
      const suitName = ['Spades','Hearts','Diamonds','Clubs'][suitIdx];
      return { ok:true, text:`Led suit forced to ${suitName}.` };
    }

    default:
      return { ok:false, text:`Unknown command "${cmd}". Type "help" for a list.` };
  }
}

// Official rule: a declined property goes to auction among ALL
// non-bankrupt players (including the one who declined). Bidding
// goes turn-by-turn around the table (starting with whoever's turn
// it currently is, i.e. the decliner); each player gets exactly one
// action on their turn — raise by one of three fixed steps above the
// current (present) bid, or pass — within a time limit, no free-for-all
// typing of arbitrary amounts. Passing is permanent for that auction.
// When only one non-passed participant remains, they win at their
// standing bid (or, if nobody ever bid, the property simply stays
// unowned).
export const AUCTION_TURN_MS = 5000;

// The three raise buttons always add one of these flat amounts on top
// of the current bid — same three steps regardless of property price,
// so "present value + 20/40/60" is always what's on the buttons.
export const AUCTION_RAISE_STEPS = [20, 40, 60];

export function startAuction(g, spaceIdx) {
  g.pendingBuySpace = null;
  const order = livingOrder(g).slice();
  const startIdx = Math.max(0, order.indexOf(currentPlayer(g)));
  g.auction = {
    spaceIdx,
    bid: 0,
    highestBidderId: null,
    order,
    passed: {},
    turnIdx: startIdx,
    deadline: Date.now() + AUCTION_TURN_MS,
  };
  g.phase = 'auction';
  pushLog(g, `${SPACES[spaceIdx].name} goes to auction — raise by Tk20/40/60 or pass, ${AUCTION_TURN_MS / 1000}s per turn.`);
}

export function auctionActivePlayers(g) {
  return g.auction.order.filter(id => !g.auction.passed[id]);
}

export function advanceAuctionTurn(g) {
  const { order } = g.auction;
  for (let i = 1; i <= order.length; i++) {
    const next = (g.auction.turnIdx + i) % order.length;
    if (!g.auction.passed[order[next]]) { g.auction.turnIdx = next; return; }
  }
}

export function resolveAuctionIfDone(g) {
  if (!g.auction || auctionActivePlayers(g).length > 1) return;
  const { spaceIdx, bid, highestBidderId } = g.auction;
  if (highestBidderId) {
    g.cash[highestBidderId] -= bid;
    g.owner[spaceIdx] = highestBidderId;
    pushLog(g, `${nameOf(highestBidderId)} won the auction for ${SPACES[spaceIdx].name} at Tk${bid}.`);
  } else {
    pushLog(g, `No bids — ${SPACES[spaceIdx].name} stays unowned.`);
  }
  g.auction = null;
  checkWin(g);
  if (g.phase === 'gameover') return;
  // Bankruptcy-to-the-bank queues every forfeited property for auction —
  // chain straight into the next one instead of settling back to 'resolve'.
  if (g.bankruptcyAuctionQueue && g.bankruptcyAuctionQueue.length > 0) {
    const next = g.bankruptcyAuctionQueue.shift();
    startAuction(g, next);
    return;
  }
  g.phase = 'resolve';
  if (ROOM && ROOM.movementMode === 'cards') {
    continuePit(g);
    finishTrickCycle(g);
  } else if (g.bankrupt[currentPlayer(g)]) {
    doEndTurn(g);
  }
}

export function doRoll(g, playerId) {
  const d1 = 1 + Math.floor(Math.random() * 6);
  const d2 = 1 + Math.floor(Math.random() * 6);
  g.lastRoll = [d1, d2];
  const isDouble = d1 === d2;

  if (g.jail[playerId].in) {
    if (isDouble) {
      g.jail[playerId] = { in:false, turns:0 };
      pushLog(g, `${nameOf(playerId)} rolled doubles and left Jail.`);
      const np = (g.pos[playerId] + d1 + d2) % 40;
      movePlayerTo(g, playerId, np);
      landOn(g, playerId, np, d1 + d2);
    } else {
      g.jail[playerId].turns++;
      if (g.jail[playerId].turns >= 3) {
        const ok = payAmount(g, playerId, 'bank', 50, 'jailFine');
        if (!ok) return; // paused — resumes (and moves) via resumeAfterDebt
        g.jail[playerId] = { in:false, turns:0 };
        pushLog(g, `${nameOf(playerId)} paid Tk50 to leave Jail after 3 tries.`);
        const np = (g.pos[playerId] + d1 + d2) % 40;
        movePlayerTo(g, playerId, np);
        landOn(g, playerId, np, d1 + d2);
      } else {
        pushLog(g, `${nameOf(playerId)} stayed in Jail (try ${g.jail[playerId].turns}/3).`);
        g.phase = 'resolve';
      }
    }
    return;
  }

  if (isDouble) {
    g.doublesStreak++;
    if (g.doublesStreak >= 3) {
      sendToJail(g, playerId);
      return;
    }
  } else {
    g.doublesStreak = 0;
  }
  const np = (g.pos[playerId] + d1 + d2) % 40;
  movePlayerTo(g, playerId, np);
  landOn(g, playerId, np, d1 + d2);
}

export function doEndTurn(g) {
  const p = currentPlayer(g);
  if (g.doublesStreak > 0 && !g.jail[p].in && !g.bankrupt[p]) {
    g.phase = 'roll'; // same player rolls again
  } else {
    advanceTurn(g);
  }
}

// =========================================================
// TRADING — any player can propose a trade to any other
// player at any time (not gated by turn/phase). A trade can
// include cash, whole properties (no houses on them — sell
// houses first, matching the classic rule), and Get Out of
// Jail Free cards. The recipient accepts or declines; the
// proposer can cancel a still-pending offer. Conditions are
// re-checked at accept time in case anything changed since
// the offer was made (e.g. the property got mortgaged... it
// can't in this build, but cash/ownership still can).
// =========================================================
export function isTradeable(g, spaceIdx, ownerId) {
  const space = SPACES[spaceIdx];
  return space && space.type === 'property' && g.owner[spaceIdx] === ownerId && (g.houses[spaceIdx] || 0) === 0;
}

export function canExecuteTrade(g, t) {
  if (g.bankrupt[t.fromId] || g.bankrupt[t.toId]) return false;
  if (g.cash[t.fromId] < t.offerCash) return false;
  if (g.cash[t.toId] < t.reqCash) return false;
  if (!t.offerProps.every(idx => isTradeable(g, idx, t.fromId))) return false;
  if (!t.reqProps.every(idx => isTradeable(g, idx, t.toId))) return false;
  if (t.offerJail && g.jailCardsHeld[t.fromId].length < 1) return false;
  if (t.reqJail && g.jailCardsHeld[t.toId].length < 1) return false;
  return true;
}

export function executeTrade(g, t) {
  g.cash[t.fromId] -= t.offerCash; g.cash[t.toId] += t.offerCash;
  g.cash[t.toId] -= t.reqCash; g.cash[t.fromId] += t.reqCash;
  t.offerProps.forEach(idx => { g.owner[idx] = t.toId; });
  t.reqProps.forEach(idx => { g.owner[idx] = t.fromId; });
  if (t.offerJail) { g.jailCardsHeld[t.toId].push(g.jailCardsHeld[t.fromId].shift()); }
  if (t.reqJail) { g.jailCardsHeld[t.fromId].push(g.jailCardsHeld[t.toId].shift()); }
}

export function tradeSummary(t) {
  const give = [];
  if (t.offerCash) give.push(`Tk${t.offerCash}`);
  t.offerProps.forEach(idx => give.push(SPACES[idx].name));
  if (t.offerJail) give.push('Jail card');
  const get = [];
  if (t.reqCash) get.push(`Tk${t.reqCash}`);
  t.reqProps.forEach(idx => get.push(SPACES[idx].name));
  if (t.reqJail) get.push('Jail card');
  return `${nameOf(t.fromId)} offers ${give.join(', ') || 'nothing'} for ${get.join(', ') || 'nothing'} from ${nameOf(t.toId)}`;
}

// =========================================================
// NETWORKING — same host-authoritative pattern as Ultimate
// Tic Tac Toe: ROOM.hostId is explicit state, not re-derived
// from presence timing on every message.
// =========================================================
