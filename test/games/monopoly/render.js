// =========================================================
// RENDER — all DOM-writing functions. Reads ROOM/GAME/state
// from state.js and calls room.send(...) for user actions
// (buy, roll, trade, etc). Edit this file for: anything about
// how the game LOOKS or what buttons/UI show up.
// =========================================================
import {
  SPACES, GROUPS, RAIL_IDXS, UTIL_IDXS, GROUP_HOUSE_COST, TOKEN_COLORS, priceOf,
} from './board-data.js';
import {
  ROOM, GAME, myId, room, connectedIds, isHost, isMyTurn, nameOf, labelFor,
} from './state.js';
import {
  currentPlayer, computeRent, computeNetWorth, houseGroupComplete, houseGroupUnmortgaged,
  canBuildOneMore, canSellOneDown, mortgageValueOf, unmortgageCostOf, houseSaleValueOf,
  isTradeable, tradeSummary, cardSuit, cardValue, cardLabel, AUCTION_RAISE_STEPS,
} from './game-engine.js';
import { activityModalMode, showingRestartConfirm } from './main.js';

// =========================================================
// RENDER
// =========================================================
export function renderFromState() {
  if (!ROOM) return;
  // Log/Chat/Cheats are available to every player, including the host.
  document.getElementById('chat-panel').classList.remove('hidden');
  document.getElementById('cheat-panel').classList.remove('hidden');
  document.getElementById('btn-open-log').disabled = false;
  renderChat();
  renderCheatLog();
  checkAnnouncement();
  if (!document.getElementById('settings-modal-overlay').classList.contains('hidden')) renderSettingsList();
  if (!ROOM.started) { showHomeOrLobby('screen-lobby'); renderLobby(); }
  else { gameShell.classList.add('active'); screenHome.classList.add('hidden'); screenLobby.classList.add('hidden'); renderGame(); }
}

export function renderLobby() {
  document.getElementById('host-tag').classList.toggle('hidden', !isHost());
  const nameInput = document.getElementById('name-input');
  if (document.activeElement !== nameInput) {
    nameInput.value = ROOM.names?.[myId] || '';
  }
  const mode = ROOM.movementMode || 'dice';
  seatSelectEl.querySelectorAll('.seat-btn').forEach(b => {
    const n = Number(b.dataset.n);
    b.classList.toggle('active', n === ROOM.capacity);
    b.disabled = !isHost() || ROOM.started || (mode === 'cards' && n > 4);
    b.style.display = (mode === 'cards' && n > 4) ? 'none' : '';
  });

  document.getElementById('mode-btn-dice').classList.toggle('active', mode === 'dice');
  document.getElementById('mode-btn-cards').classList.toggle('active', mode === 'cards');
  document.getElementById('mode-btn-dice').disabled = !isHost() || ROOM.started;
  document.getElementById('mode-btn-cards').disabled = !isHost() || ROOM.started;
  document.getElementById('movement-mode-desc').textContent = mode === 'cards'
    ? 'Cards mode (2-4 players): each hand deals everyone 13 cards (any leftover cards just sit out until the next hand). Every trick, all players (jailed ones too) play a card in turn, following the led suit if able. Spades trump everything; otherwise the highest card of the led suit wins the trick. The winner moves by their own card\'s number (A=14, K=13, Q=12, J=11, 10..2) and assigns the other cards\' numbers to the other players by clicking a number for each — only legal numbers are offered. A jailed winner still assigns numbers but never moves themselves. First bankruptcy ends the game — everyone else is ranked by cash + property value.'
    : 'Dice mode: classic two-die rolls, doubles go again (three in a row sends you to Jail).';

  const listEl = document.getElementById('seat-list');
  listEl.innerHTML = '';
  for (let i = 0; i < ROOM.capacity; i++) {
    const id = ROOM.seats[i];
    const row = document.createElement('div');
    row.className = 'seat-row' + (id ? ' filled' : '') + (id === myId ? ' mine' : '');
    const dot = document.createElement('div');
    dot.className = 'token-dot';
    dot.style.background = id ? TOKEN_COLORS[i] : '#333';
    const who = document.createElement('div');
    who.className = 'who';
    who.textContent = id ? labelFor(id) : 'open seat';
    row.appendChild(dot); row.appendChild(who);
    listEl.appendChild(row);
  }

  const joinBtn = document.getElementById('btn-join-seat');
  const alreadyIn = ROOM.seats.includes(myId);
  joinBtn.disabled = alreadyIn || ROOM.seats.length >= ROOM.capacity || ROOM.started;
  joinBtn.textContent = alreadyIn ? 'You’re seated' : 'Take a Seat';

  const startBtn = document.getElementById('btn-start');
  startBtn.classList.toggle('hidden', !isHost());
  startBtn.disabled = ROOM.seats.length < 2;

  const timeoutLabel = { 0:'disabled', 30000:'30 seconds', 60000:'1 minute', 120000:'2 minutes', 300000:'5 minutes' }[ROOM.disconnectTimeoutMs] || `${Math.round(ROOM.disconnectTimeoutMs/1000)}s`;
  document.getElementById('lobby-msg').textContent = (ROOM.seats.length < 2
    ? 'Need at least 2 players.'
    : (isHost() ? 'Ready to launch whenever you are.' : 'Waiting for host to launch.'))
    + ` Disconnected-player auto-skip: ${timeoutLabel}.`;
}

// Auction UI is a centered modal, shown to every player the moment an
// auction starts (not just whoever's turn it is) — everyone can see the
// live bid, order, and countdown; only the active bidder gets live
// (non-disabled) buttons. Present bid = GAME.auction.bid; each raise
// button adds one of the three fixed AUCTION_RAISE_STEPS on top of it.
export function renderAuctionUI() {
  const overlay = document.getElementById('auction-modal-overlay');
  if (GAME.phase !== 'auction' || !GAME.auction) { overlay.classList.add('hidden'); return; }
  overlay.classList.remove('hidden');

  const { spaceIdx, bid, highestBidderId, order, passed, turnIdx, deadline } = GAME.auction;
  const space = SPACES[spaceIdx];
  const turnPlayerId = order[turnIdx];
  const secondsLeft = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

  document.getElementById('auction-modal-title').textContent = `${space.name} — Auction`;

  const statusEl = document.getElementById('auction-modal-status');
  statusEl.textContent = highestBidderId
    ? `Present bid: Tk${bid} by ${nameOf(highestBidderId)}`
    : 'No bids yet — starting bid Tk0.';

  // Turn order, with the active player highlighted and passed
  // players struck through — makes the rotation visible at a glance.
  const orderEl = document.getElementById('auction-modal-order');
  orderEl.innerHTML = 'Order: ' + order.map(id => {
    const label = nameOf(id) + (id === myId ? ' (you)' : '');
    if (passed[id]) return `<span style="text-decoration:line-through; opacity:.5;">${label}</span>`;
    if (id === turnPlayerId) return `<strong>${label}</strong>`;
    return label;
  }).join(' → ');

  const timerEl = document.getElementById('auction-modal-timer');
  timerEl.textContent = secondsLeft;
  timerEl.classList.toggle('low', secondsLeft <= 2);

  const turnMsgEl = document.getElementById('auction-modal-turnmsg');
  turnMsgEl.textContent = turnPlayerId === myId ? 'Your turn to act' : `Waiting for ${nameOf(turnPlayerId)}…`;

  const actions = document.getElementById('auction-modal-actions');
  actions.innerHTML = '';

  if (turnPlayerId !== myId) {
    const waiting = document.createElement('div');
    waiting.className = 'auction-modal-waiting';
    waiting.textContent = `Only ${nameOf(turnPlayerId)} can act right now.`;
    actions.appendChild(waiting);
    return;
  }

  AUCTION_RAISE_STEPS.forEach(step => {
    const nextBid = bid + step;
    const canAfford = nextBid <= GAME.cash[myId];
    const btn = document.createElement('button');
    btn.className = 'raise-btn';
    btn.textContent = `Raise to Tk${nextBid} (+${step})`;
    btn.disabled = !canAfford;
    btn.onclick = () => room.send('auction_raise', { amount: step });
    actions.appendChild(btn);
  });

  const passBtn = document.createElement('button');
  passBtn.className = 'pass-btn';
  passBtn.textContent = 'Pass';
  passBtn.onclick = () => room.send('auction_pass', {});
  actions.appendChild(passBtn);
}

export function renderTaxChoiceUI() {
  const wrap = document.getElementById('tax-choice-hud-box');
  const box = document.getElementById('tax-choice-box');
  if (GAME.phase !== 'tax_choice' || currentPlayer(GAME) !== myId) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  box.innerHTML = '';

  const space = SPACES[GAME.pendingTaxSpace];
  const percentAmount = Math.ceil(computeNetWorth(GAME, myId) * 0.1);

  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.style.fontSize = '12px';
  msg.textContent = 'Pay a flat amount, or 10% of your net worth — whichever you prefer.';
  box.appendChild(msg);

  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '6px';
  const flatBtn = document.createElement('button');
  flatBtn.textContent = `Pay Tk${space.amount} flat`;
  flatBtn.onclick = () => room.send('pay_tax_flat', {});
  const pctBtn = document.createElement('button');
  pctBtn.textContent = `Pay Tk${percentAmount} (10%)`;
  pctBtn.onclick = () => room.send('pay_tax_percent', {});
  row.appendChild(flatBtn); row.appendChild(pctBtn);
  box.appendChild(row);
}

export function renderRestartUI() {
  const restartBtn = document.getElementById('btn-restart');
  const confirmBox = document.getElementById('restart-confirm-box');
  const voteBox = document.getElementById('restart-vote-box');

  restartBtn.classList.toggle('hidden', !isHost() || showingRestartConfirm || !!ROOM.restartVote);
  confirmBox.classList.toggle('hidden', !showingRestartConfirm);

  if (!ROOM.restartVote) {
    voteBox.innerHTML = '';
    return;
  }

  voteBox.innerHTML = '';
  const { votes } = ROOM.restartVote;
  const myVote = votes[myId];
  const total = Object.keys(votes).length;
  const yesCount = Object.values(votes).filter(v => v === true).length;

  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.style.fontSize = '12px';
  if (myVote === undefined) {
    msg.textContent = `Restart requested — ${yesCount}/${total} players agreed.`;
    voteBox.appendChild(msg);
  } else if (myVote === true) {
    msg.textContent = `Waiting for other players... (${yesCount}/${total} confirmed)`;
    voteBox.appendChild(msg);
  } else {
    msg.textContent = 'Host wants to restart. Restart the game?';
    voteBox.appendChild(msg);
    const row = document.createElement('div');
    row.className = 'row';
    row.style.marginTop = '6px';
    const yesBtn = document.createElement('button');
    yesBtn.textContent = 'Yes';
    yesBtn.onclick = () => room.send('restart_vote', { vote: true });
    const noBtn = document.createElement('button');
    noBtn.textContent = 'No';
    noBtn.onclick = () => room.send('restart_vote', { vote: false });
    row.appendChild(yesBtn); row.appendChild(noBtn);
    voteBox.appendChild(row);
  }

  if (isHost() && ROOM.restartVote.initiatorId === myId) {
    const cancelBtn = document.createElement('button');
    cancelBtn.style.marginTop = '6px';
    cancelBtn.style.width = '100%';
    cancelBtn.textContent = 'Cancel restart request';
    cancelBtn.onclick = () => room.send('restart_cancel', {});
    voteBox.appendChild(cancelBtn);
  }
}

export function renderReconnectBox() {
  const wrap = document.getElementById('reconnect-hud-box');
  const box = document.getElementById('reconnect-box');
  const amSeated = ROOM.seats.includes(myId);
  if (amSeated) { wrap.style.display = 'none'; return; }
  const ghosts = ROOM.seats.filter(id => !connectedIds.includes(id));
  if (ghosts.length === 0) { wrap.style.display = 'none'; return; }
  wrap.style.display = '';
  box.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.style.fontSize = '12px';
  msg.textContent = 'You’re spectating. A seat looks disconnected — is one of these yours?';
  box.appendChild(msg);
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '8px';
  ghosts.forEach(oldId => {
    const btn = document.createElement('button');
    btn.textContent = `Claim ${labelFor(oldId)}'s seat`;
    btn.onclick = () => room.send('claim_seat', { oldId });
    row.appendChild(btn);
  });
  box.appendChild(row);
}

export function renderGame() {
  if (!GAME) return;
  applyPriceDisplay();
  renderReconnectBox();
  renderRestartUI();

  // tokens — group players by the space they're currently on, then
  // place them as a small cluster centered on that cell (a single
  // token sits dead-center; multiple tokens fan out symmetrically
  // around the center, overlapping a bit rather than being pushed
  // into a corner).
  document.querySelectorAll('.token').forEach(t => t.remove());
  const boardEl = document.getElementById('board');
  const boardRect = boardEl.getBoundingClientRect();
  const tokenPx = boardRect.width * 0.036; // matches .token { width: 3.6% }
  const unit = tokenPx * 0.62;
  const CLUSTER_OFFSETS = {
    1: [[0,0]],
    2: [[-0.55,0],[0.55,0]],
    3: [[-0.6,-0.4],[0.6,-0.4],[0,0.55]],
    4: [[-0.55,-0.55],[0.55,-0.55],[-0.55,0.55],[0.55,0.55]],
    5: [[-0.65,-0.6],[0.65,-0.6],[0,0],[-0.65,0.6],[0.65,0.6]],
    6: [[-0.7,-0.6],[0,-0.65],[0.7,-0.6],[-0.7,0.6],[0,0.65],[0.7,0.6]],
  };

  const bySpace = {};
  GAME.order.forEach((id, seatIdx) => {
    if (GAME.bankrupt[id]) return;
    const spaceIdx = GAME.pos[id];
    (bySpace[spaceIdx] ||= []).push(seatIdx);
  });

  Object.entries(bySpace).forEach(([spaceIdxStr, seatIdxs]) => {
    const cellEl = boardEl.querySelector(`[data-idx="${spaceIdxStr}"]`);
    if (!cellEl) return;
    const cellRect = cellEl.getBoundingClientRect();
    const centerX = cellRect.left - boardRect.left + cellRect.width / 2;
    const centerY = cellRect.top - boardRect.top + cellRect.height / 2;
    const offsets = CLUSTER_OFFSETS[Math.min(seatIdxs.length, 6)];
    seatIdxs.forEach((seatIdx, i) => {
      const [ux, uy] = offsets[i] || [0, 0];
      const t = document.createElement('div');
      t.className = 'token';
      t.style.background = TOKEN_COLORS[seatIdx];
      t.style.left = (centerX + ux * unit - tokenPx / 2) + 'px';
      t.style.top = (centerY + uy * unit - tokenPx / 2) + 'px';
      boardEl.appendChild(t);
    });
  });

  // ownership markers — colored border matching the owner's token
  // color, plus a small house/hotel badge, directly on the board.
  boardEl.querySelectorAll('[data-idx]').forEach(el => {
    el.classList.remove('owned');
    el.style.removeProperty('--owner-color');
  });
  boardEl.querySelectorAll('.house-badge').forEach(b => b.remove());
  Object.keys(GAME.owner).forEach(idxStr => {
    const idx = Number(idxStr);
    const ownerId = GAME.owner[idx];
    const seatIdx = GAME.order.indexOf(ownerId);
    if (seatIdx === -1) return;
    const cellEl = boardEl.querySelector(`[data-idx="${idx}"]`);
    if (!cellEl) return;
    cellEl.classList.add('owned');
    cellEl.style.setProperty('--owner-color', TOKEN_COLORS[seatIdx]);
    const houses = GAME.houses[idx] || 0;
    if (houses > 0) {
      const badge = document.createElement('div');
      badge.className = 'house-badge';
      badge.textContent = houses >= 5 ? '🏨' : '🏠'.repeat(houses);
      cellEl.appendChild(badge);
    }
  });

  // players box
  const playersBox = document.getElementById('players-box');
  playersBox.innerHTML = '';
  GAME.order.forEach((id, i) => {
    const row = document.createElement('div');
    row.className = 'player-row' + (currentPlayer(GAME) === id && GAME.phase !== 'gameover' ? ' turn' : '') + (GAME.bankrupt[id] ? ' bankrupt' : '');
    const dot = document.createElement('div');
    dot.className = 'token-dot'; dot.style.background = TOKEN_COLORS[i]; dot.style.width='12px'; dot.style.height='12px';
    const label = document.createElement('span');
    const offline = !connectedIds.includes(id) && !GAME.bankrupt[id];
    label.textContent = labelFor(id) + (GAME.jail[id].in ? ' 🔒' : '') + (offline ? ' [offline]' : '');
    if (offline) label.style.opacity = '.6';
    const cash = document.createElement('span');
    cash.className = 'cash';
    cash.textContent = 'Tk' + GAME.cash[id];
    row.appendChild(dot); row.appendChild(label); row.appendChild(cash);
    playersBox.appendChild(row);
  });

  // dice / trick display — the card-mode trick/hand UI has moved onto
  // the board itself (see renderCenterCardUI), so the HUD's dice-row
  // only ever shows the classic two dice, and only in Dice mode.
  const cardsMode = ROOM.movementMode === 'cards';
  const diceRow = document.getElementById('dice-row');
  if (!cardsMode) {
    diceRow.style.display = '';
    diceRow.innerHTML = `<div class="die">${GAME.lastRoll[0]}</div><div class="die">${GAME.lastRoll[1]}</div>`;
  } else {
    diceRow.style.display = 'none';
    diceRow.innerHTML = '';
  }

  // jail box — in cards mode, pay/use-card is available any time (no
  // personal "turn"), so it gets its own persistent box instead of
  // living in the roll-phase action row.
  const jailWrap = document.getElementById('jail-hud-box');
  if (cardsMode && GAME.jail[myId] && GAME.jail[myId].in && GAME.phase !== 'gameover') {
    jailWrap.style.display = '';
    const jailBox = document.getElementById('jail-box');
    jailBox.innerHTML = '';
    const msg = document.createElement('div');
    msg.className = 'msg';
    msg.textContent = "You're in Jail — you still play cards in every trick, but your token won't move until you pay or use a card.";
    jailBox.appendChild(msg);
    if (GAME.cash[myId] >= 50) addBtn(jailBox, 'Pay Tk50 bail', () => room.send('pay_jail_fine', {}));
    if ((GAME.jailCardsHeld[myId] || []).length > 0) addBtn(jailBox, 'Use Jail card', () => room.send('use_jail_card', {}));
  } else {
    jailWrap.style.display = 'none';
  }

  // turn message + actions
  const turnMsg = document.getElementById('turn-msg');
  const actionRow = document.getElementById('action-row');
  actionRow.innerHTML = '';

  if (GAME.phase === 'gameover') {
    if (cardsMode && GAME.finalRanking) {
      turnMsg.innerHTML = 'Game over! Final ranking (cash + property value):<br>' +
        GAME.finalRanking.map((id, i) => `${i + 1}. ${labelFor(id)}${GAME.bankrupt[id] ? ' (bankrupt)' : ' — Tk' + computeNetWorth(GAME, id)}`).join('<br>');
    } else {
      turnMsg.textContent = GAME.winnerId === myId ? 'You win! 🎉' : (GAME.winnerId ? 'Game over — you were eliminated.' : 'Game over.');
    }
  } else if (GAME.phase === 'auction') {
    turnMsg.textContent = `Auction in progress for ${SPACES[GAME.auction.spaceIdx].name} — see below.`;
  } else if (GAME.phase === 'tax_choice') {
    const cp = currentPlayer(GAME);
    turnMsg.textContent = cp === myId ? 'Choose how to pay — see below.' : `Waiting for ${nameOf(cp)} to choose how to pay tax...`;
  } else if (GAME.phase === 'debt') {
    const d = GAME.debt;
    if (d.playerId === myId) {
      const short = d.amount - GAME.cash[myId];
      turnMsg.textContent = `You owe Tk${d.amount} to ${d.toId === 'bank' ? 'the Bank' : nameOf(d.toId)} — you're Tk${Math.max(0, short)} short. Mortgage properties or sell houses below, then pay, or declare bankruptcy.`;
      const payBtn = addBtn(actionRow, `Pay Tk${d.amount}`, () => room.send('settle_debt', {}));
      payBtn.disabled = GAME.cash[myId] < d.amount;
      const bkBtn = addBtn(actionRow, 'Declare Bankruptcy', () => room.send('declare_bankruptcy', {}));
      bkBtn.style.background = '#7a2020';
    } else {
      turnMsg.textContent = `${nameOf(d.playerId)} owes Tk${d.amount} and is raising cash to pay it off...`;
    }
  } else if (GAME.phase === 'card_pit_assign' && GAME.pit) {
    const winnerId = GAME.pit.winnerId;
    if (winnerId === myId) {
      turnMsg.textContent = `You won the trick with ${cardLabel(GAME.pit.plays[winnerId])} (move ${GAME.pit.winnerVal}${GAME.jail[myId].in ? ' — but you\'re in Jail, so you stay put' : ''}). Assign ${GAME.pit.remainingValues.join(', ')} to the others below.`;
    } else {
      turnMsg.textContent = `${nameOf(winnerId)} won the trick and is assigning movement numbers...`;
    }
  } else if (GAME.phase === 'card_trick_play' && GAME.trick) {
    const acting = GAME.trick.order[GAME.trick.turnIdx];
    turnMsg.textContent = acting === myId ? 'Your turn to play a card — pick one from your hand below.' : `Waiting for ${nameOf(acting)} to play a card...`;
  } else {
    const mine = isMyTurn();
    const cp = currentPlayer(GAME);
    turnMsg.textContent = mine ? 'Your turn' : `Waiting for ${labelFor(cp)}...`;

    if (mine && GAME.phase === 'roll') {
      if (GAME.jail[myId].in) {
        addBtn(actionRow, 'Roll (try to escape)', () => room.send('roll', {}));
        if (GAME.cash[myId] >= 50) addBtn(actionRow, 'Pay Tk50 bail', () => room.send('pay_jail_fine', {}));
        if ((GAME.jailCardsHeld[myId] || []).length > 0) addBtn(actionRow, 'Use Jail card', () => room.send('use_jail_card', {}));
      } else {
        addBtn(actionRow, 'Roll Dice', () => room.send('roll', {}));
      }
    } else if (mine && GAME.phase === 'buy') {
      const space = SPACES[GAME.pendingBuySpace];
      turnMsg.textContent = `Buy ${space.name} for Tk${priceOf(GAME.pendingBuySpace)}?`;
      addBtn(actionRow, 'Buy', () => room.send('buy_yes', {}));
      addBtn(actionRow, 'Pass', () => room.send('buy_no', {}));
    } else if (mine && GAME.phase === 'resolve') {
      addBtn(actionRow, GAME.doublesStreak > 0 ? 'Roll Again (doubles)' : 'End Turn', () => room.send('end_turn', {}));
    }
  }

  // bank supply — visible reminder that houses/hotels are limited
  const bankSupplyEl = document.getElementById('bank-supply');
  if (bankSupplyEl) bankSupplyEl.textContent = `Bank: ${GAME.houseBank} houses, ${GAME.hotelBank} hotels left`;

  // my properties + build controls (available on my turn, phase roll)
  const propsBox = document.getElementById('props-box');
  propsBox.innerHTML = '';
  Object.keys(GAME.owner).map(Number).filter(idx => GAME.owner[idx] === myId).forEach(idx => {
    const space = SPACES[idx];
    const mortgaged = !!GAME.mortgaged[idx];
    const row = document.createElement('div');
    row.className = 'prop-row';
    row.style.flexWrap = 'wrap';
    const sw = document.createElement('div');
    sw.className = 'swatch';
    sw.style.background = space.group ? getComputedGroupColor(space.group) : '#888';
    const label = document.createElement('span');
    const houses = GAME.houses[idx] || 0;
    label.textContent = space.name + (houses > 0 ? (houses >= 5 ? ' 🏨' : ' ' + '🏠'.repeat(houses)) : '') + (mortgaged ? ' (mortgaged)' : '');
    if (mortgaged) label.style.opacity = '.6';
    row.appendChild(sw); row.appendChild(label);

    // Official rule: houses/hotels can be built any time between any
    // player's rolls, not just on your own turn — so this is only
    // gated by ownership/monopoly/bank-supply, matching the handler.
    if (space.type === 'property' && !mortgaged && GAME.phase !== 'gameover' && GAME.phase !== 'auction' && houses < 5 &&
        houseGroupComplete(GAME, myId, space.group) &&
        houseGroupUnmortgaged(GAME, space.group) &&
        houses <= Math.min(...GROUPS[space.group].map(i => GAME.houses[i] || 0))) {
      const cost = GROUP_HOUSE_COST[space.group];
      const noSupply = !canBuildOneMore(GAME, houses);
      const btn = document.createElement('button');
      btn.textContent = noSupply ? (houses === 4 ? 'No hotels left' : 'No houses left') : `Build (Tk${cost})`;
      btn.disabled = GAME.cash[myId] < cost || noSupply;
      btn.onclick = () => room.send('build_house', { spaceIdx: idx });
      row.appendChild(btn);
    }

    if (space.type === 'property' && houses > 0 &&
        houses >= Math.max(...GROUPS[space.group].map(i => GAME.houses[i] || 0))) {
      const refund = houseSaleValueOf(space.group);
      const btn = document.createElement('button');
      btn.textContent = houses >= 5 ? `Sell Hotel (+Tk${refund})` : `Sell house (+Tk${refund})`;
      btn.disabled = !canSellOneDown(GAME, houses);
      btn.onclick = () => room.send('sell_house', { spaceIdx: idx });
      row.appendChild(btn);
    }

    if (!mortgaged && houses === 0) {
      const value = mortgageValueOf(idx);
      const btn = document.createElement('button');
      btn.textContent = `Mortgage (+Tk${value})`;
      btn.onclick = () => room.send('mortgage_property', { spaceIdx: idx });
      row.appendChild(btn);
    } else if (mortgaged) {
      const cost = unmortgageCostOf(idx);
      const btn = document.createElement('button');
      btn.textContent = `Unmortgage (Tk${cost})`;
      btn.disabled = GAME.cash[myId] < cost;
      btn.onclick = () => room.send('unmortgage_property', { spaceIdx: idx });
      row.appendChild(btn);
    }

    propsBox.appendChild(row);
  });

  renderAuctionUI();
  renderTaxChoiceUI();
  renderTrades();
  renderCenterCardUI(cardsMode);
  document.getElementById('btn-open-trade').disabled = GAME.phase === 'gameover';

  // log — natural chronological order (oldest to newest), auto-scrolled
  // to the bottom so the newest entry is always visible without having
  // to manually scroll, with that newest line visually highlighted.
  const logBox = document.getElementById('log-box');
  const logWasNearBottom = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight < 30;
  logBox.innerHTML = '';
  GAME.log.forEach((line, i) => {
    const d = document.createElement('div');
    d.textContent = line;
    if (i === GAME.log.length - 1) d.className = 'log-newest';
    logBox.appendChild(d);
  });
  if (logWasNearBottom || logBox.dataset.everScrolled !== 'true') {
    logBox.scrollTop = logBox.scrollHeight;
    logBox.dataset.everScrolled = 'true';
  }
  if (activityModalMode === 'log') renderExpandedLog();
  if (activityModalMode === 'chat') renderChat();
}

// =========================================================
// CENTER-BOARD CARDS-MODE UI
// Replaces the decorative MONOPOLY logo + Chance/Chest stacks
// with two live regions while movement mode is "cards":
//   - #center-trick-box (red border): the trick currently being
//     played, one card slot per participant.
//   - #center-hand-box (black border): your hand to play from,
//     or — once a trick is won — the movement-assignment UI
//     (including the "Confirm Assignment" button, i.e. the
//     confirmation of movement).
// This used to live down in the HUD sidebar (dice-row / a
// dedicated hand box / the action-row), which pushed the actual
// controls off-screen on mobile; now it sits on the board itself.
// =========================================================
export function renderCenterCardUI(cardsMode) {
  const cardUiEl = document.getElementById('center-card-ui');
  const logoEl = document.querySelector('.center .logo');
  const chanceStackEl = document.querySelector('.center .chance-stack');
  const chestStackEl = document.querySelector('.center .chest-stack');

  if (!cardsMode || GAME.phase === 'gameover') {
    cardUiEl.classList.add('hidden');
    if (logoEl) logoEl.style.display = '';
    if (chanceStackEl) chanceStackEl.style.display = '';
    if (chestStackEl) chestStackEl.style.display = '';
    return;
  }
  cardUiEl.classList.remove('hidden');
  if (logoEl) logoEl.style.display = 'none';
  if (chanceStackEl) chanceStackEl.style.display = 'none';
  if (chestStackEl) chestStackEl.style.display = 'none';

  const trickBox = document.getElementById('center-trick-cards');
  const handBox = document.getElementById('center-hand-cards');
  const handLabel = document.getElementById('center-hand-label');
  trickBox.innerHTML = '';
  handBox.innerHTML = '';

  // --- red box: the trick currently in progress (or just resolved) ---
  if (GAME.trick) {
    GAME.trick.order.forEach(id => {
      const cardIdx = GAME.trick.plays[id];
      const slot = document.createElement('div');
      slot.className = 'center-trick-slot';
      const isActive = id === GAME.trick.order[GAME.trick.turnIdx] && cardIdx === undefined;
      if (isActive) slot.classList.add('active-turn');
      if (cardIdx === undefined) {
        slot.innerHTML = `<div class="ct-card empty">?</div><div class="ct-name">${labelFor(id)}</div>`;
      } else {
        const suit = cardSuit(cardIdx); const red = suit === 1 || suit === 2;
        slot.innerHTML = `<div class="ct-card" style="color:${red ? '#c0392b' : '#1a1a1a'}">${cardLabel(cardIdx)}</div><div class="ct-name">${labelFor(id)}</div>`;
      }
      trickBox.appendChild(slot);
    });
  } else if (GAME.pit) {
    Object.keys(GAME.pit.plays).forEach(id => {
      const cardIdx = GAME.pit.plays[id];
      const suit = cardSuit(cardIdx); const red = suit === 1 || suit === 2;
      const isWinner = id === GAME.pit.winnerId;
      const slot = document.createElement('div');
      slot.className = 'center-trick-slot' + (isWinner ? ' winner' : '');
      slot.innerHTML = `<div class="ct-card" style="color:${red ? '#c0392b' : '#1a1a1a'}">${cardLabel(cardIdx)}</div><div class="ct-name">${labelFor(id)}</div>`;
      trickBox.appendChild(slot);
    });
  } else {
    trickBox.innerHTML = '<div class="msg">Waiting for the next trick…</div>';
  }

  // --- black box: your hand to play from, or the movement-assignment
  //     UI (with its confirmation button) once a trick is won ---
  if (GAME.phase === 'card_pit_assign' && GAME.pit) {
    handLabel.textContent = 'Assign Movement';
    if (GAME.pit.winnerId === myId) {
      renderPitAssignUI(handBox);
    } else {
      const msg = document.createElement('div');
      msg.className = 'msg';
      msg.textContent = `${nameOf(GAME.pit.winnerId)} is assigning movement…`;
      handBox.appendChild(msg);
    }
    return;
  }

  handLabel.textContent = 'Your Hand';
  if (!GAME.hands || !GAME.hands[myId]) {
    handBox.innerHTML = '<div class="msg">Spectating.</div>';
    return;
  }

  const myTrickTurn = GAME.trick && GAME.trick.order[GAME.trick.turnIdx] === myId;
  const led = GAME.trick ? GAME.trick.ledSuit : null;
  const hand = GAME.hands[myId].slice().sort((a, b) => cardSuit(a) - cardSuit(b) || cardValue(a) - cardValue(b));
  const hasLedSuit = led !== null && hand.some(c => cardSuit(c) === led);

  if (GAME.jail[myId] && GAME.jail[myId].in) {
    const note = document.createElement('div');
    note.className = 'msg';
    note.style.marginBottom = '4px';
    note.textContent = "You're in Jail — you still play, but won't move.";
    handBox.appendChild(note);
  }

  const cardsWrap = document.createElement('div');
  cardsWrap.id = 'center-hand-cards-inner';
  cardsWrap.style.display = 'flex';
  cardsWrap.style.flexWrap = 'wrap';
  cardsWrap.style.gap = '1vmin';
  cardsWrap.style.justifyContent = 'center';
  cardsWrap.style.width = '100%';
  hand.forEach(cardIdx => {
    const suit = cardSuit(cardIdx); const red = suit === 1 || suit === 2;
    const legal = myTrickTurn && (led === null || suit === led || !hasLedSuit);
    const card = document.createElement('div');
    card.className = 'center-hand-card';
    card.style.color = red ? '#c0392b' : '#1a1a1a';
    card.style.cursor = legal ? 'pointer' : 'default';
    card.style.opacity = myTrickTurn && !legal ? '.4' : '1';
    card.textContent = cardLabel(cardIdx);
    if (legal) card.onclick = () => room.send('play_trick_card', { cardIdx });
    cardsWrap.appendChild(card);
  });
  handBox.appendChild(cardsWrap);

  if (!myTrickTurn) {
    const waitMsg = document.createElement('div');
    waitMsg.className = 'msg';
    waitMsg.style.marginTop = '6px';
    waitMsg.style.width = '100%';
    waitMsg.style.textAlign = 'center';
    waitMsg.textContent = GAME.trick ? `Waiting for ${nameOf(GAME.trick.order[GAME.trick.turnIdx])}…` : '';
    handBox.appendChild(waitMsg);
  }
}

// Client-local (not synced) scratch state for the pit assignment UI —
// which number the winner has tentatively clicked for each other
// player, kept across re-renders (e.g. a chat message triggering a
// resync) by keying it to this specific pit round. Reset automatically
// whenever a new pit round starts, since the key won't match.
export let pitAssignState = null; // { key, chosen: { playerId: number|null } }
export function pitAssignKey(pit) {
  return pit.winnerId + '|' + pit.remainingValues.join(',') + '|' + pit.otherIds.join(',');
}

// Lets the pit's winner assign the other cards' numbers to the other
// participants by clicking a number for each — only numbers still
// available in the pool are ever offered as buttons, so an illegal or
// duplicate assignment isn't something the UI can even produce. The
// "Confirm Assignment" button at the bottom is the confirmation of
// movement — nothing moves until it's pressed and accepted by the host.
export function renderPitAssignUI(container) {
  const pit = GAME.pit;
  const key = pitAssignKey(pit);
  if (!pitAssignState || pitAssignState.key !== key) {
    pitAssignState = { key, chosen: {} };
    pit.otherIds.forEach(id => { pitAssignState.chosen[id] = null; });
  }
  const chosen = pitAssignState.chosen;

  // How many of each value are still unclaimed (values can repeat,
  // e.g. two players both playing a rank-5 card, so this is a
  // multiset count, not just a yes/no per value).
  const availCount = {};
  pit.remainingValues.forEach(v => { availCount[v] = (availCount[v] || 0) + 1; });
  Object.values(chosen).forEach(v => { if (v != null) availCount[v] -= 1; });
  const distinctValues = [...new Set(pit.remainingValues)].sort((a, b) => a - b);

  const wrap = document.createElement('div');
  wrap.className = 'center-assign-wrap';
  const poolMsg = document.createElement('div');
  poolMsg.className = 'msg';
  poolMsg.textContent = `Click a number for each player to give out: ${pit.remainingValues.join(', ')}`;
  wrap.appendChild(poolMsg);

  pit.otherIds.forEach(id => {
    const row = document.createElement('div');
    const label = document.createElement('div');
    label.style.fontWeight = '700';
    label.style.fontSize = '1.3vmin';
    label.style.marginBottom = '4px';
    label.textContent = labelFor(id) + ':';
    row.appendChild(label);

    if (chosen[id] != null) {
      const badge = document.createElement('button');
      badge.textContent = `${chosen[id]} ✕`;
      badge.title = 'Click to change';
      badge.style.background = 'linear-gradient(160deg,#e8d98a,var(--gold))';
      badge.style.borderColor = 'var(--gold-dark)';
      badge.onclick = () => { chosen[id] = null; renderGame(); };
      row.appendChild(badge);
    } else {
      const btnRow = document.createElement('div');
      btnRow.className = 'row';
      btnRow.style.justifyContent = 'center';
      distinctValues.forEach(v => {
        if ((availCount[v] || 0) <= 0) return;
        const btn = document.createElement('button');
        btn.textContent = (availCount[v] > 1) ? `${v} (×${availCount[v]})` : String(v);
        btn.style.minWidth = '40px';
        btn.onclick = () => { chosen[id] = v; renderGame(); };
        btnRow.appendChild(btn);
      });
      row.appendChild(btnRow);
    }
    wrap.appendChild(row);
  });

  const allAssigned = pit.otherIds.every(id => chosen[id] != null);
  const confirmBtn = document.createElement('button');
  confirmBtn.textContent = 'Confirm Assignment';
  confirmBtn.disabled = !allAssigned;
  confirmBtn.style.marginTop = '4px';
  confirmBtn.onclick = () => {
    room.send('card_pit_assign', { assignments: { ...chosen } });
  };
  wrap.appendChild(confirmBtn);
  container.appendChild(wrap);
}

export function addBtn(container, label, onClick) {
  const b = document.createElement('button');
  b.textContent = label;
  b.onclick = onClick;
  container.appendChild(b);
  return b;
}

export function getComputedGroupColor(group) {
  const map = { brown:'#7a4128', lightblue:'#8fd2f5', pink:'#c22384', orange:'#e87f0f', red:'#d21017', yellow:'#f0d800', green:'#149249', blue:'#00568f' };
  return map[group] || '#888';
}

// =========================================================
// TRADE UI
// =========================================================
export function populateTradeTargets() {
  const sel = document.getElementById('trade-target');
  const prev = sel.value;
  sel.innerHTML = '';
  GAME.order.forEach((id) => {
    if (id === myId || GAME.bankrupt[id]) return;
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = labelFor(id);
    sel.appendChild(opt);
  });
  if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
}

export function tradeablePropsOf(ownerId) {
  return Object.keys(GAME.owner).map(Number).filter(idx => isTradeable(GAME, idx, ownerId));
}

export function buildPropOption(idx, checked) {
  const space = SPACES[idx];
  const label = document.createElement('label');
  label.className = 'prop-option' + (checked ? ' checked' : '');
  const swatch = document.createElement('span');
  swatch.className = 'swatch';
  swatch.style.background = getComputedGroupColor(space.group);
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.value = idx;
  cb.checked = checked;
  cb.addEventListener('change', () => label.classList.toggle('checked', cb.checked));
  const text = document.createElement('span');
  text.textContent = `${space.name} (Tk${priceOf(idx)})`;
  label.appendChild(cb); label.appendChild(swatch); label.appendChild(text);
  return label;
}

export function renderTradeSides() {
  const targetId = document.getElementById('trade-target').value;
  const giveBox = document.getElementById('trade-give-props');
  const getBox = document.getElementById('trade-get-props');
  giveBox.innerHTML = ''; getBox.innerHTML = '';

  const myProps = tradeablePropsOf(myId);
  if (myProps.length === 0) {
    giveBox.innerHTML = '<div class="empty-msg">You have no tradeable properties.</div>';
  } else {
    myProps.forEach(idx => giveBox.appendChild(buildPropOption(idx, false)));
  }

  if (targetId) {
    const theirProps = tradeablePropsOf(targetId);
    if (theirProps.length === 0) {
      getBox.innerHTML = '<div class="empty-msg">They have no tradeable properties.</div>';
    } else {
      theirProps.forEach(idx => getBox.appendChild(buildPropOption(idx, false)));
    }
  } else {
    getBox.innerHTML = '<div class="empty-msg">Pick a player above.</div>';
  }

  document.getElementById('trade-give-cash').value = 0;
  document.getElementById('trade-get-cash').value = 0;
  document.getElementById('trade-give-jail').checked = false;
  document.getElementById('trade-get-jail').checked = false;
  document.getElementById('trade-give-jail-wrap').classList.toggle('hidden', !((GAME.jailCardsHeld[myId] || []).length > 0));
  document.getElementById('trade-get-jail-wrap').classList.toggle('hidden', !(targetId && (GAME.jailCardsHeld[targetId] || []).length > 0));
}

export function sendTradeOffer() {
  const toId = document.getElementById('trade-target').value;
  if (!toId) return;
  const offerProps = [...document.querySelectorAll('#trade-give-props input:checked')].map(el => Number(el.value));
  const reqProps = [...document.querySelectorAll('#trade-get-props input:checked')].map(el => Number(el.value));
  const offerCash = Number(document.getElementById('trade-give-cash').value) || 0;
  const reqCash = Number(document.getElementById('trade-get-cash').value) || 0;
  const offerJail = document.getElementById('trade-give-jail').checked;
  const reqJail = document.getElementById('trade-get-jail').checked;
  room.send('propose_trade', { toId, offerCash, offerProps, offerJail, reqCash, reqProps, reqJail });
  closeTradeModal();
}

export function renderTrades() {
  const box = document.getElementById('trades-box');
  box.innerHTML = '';
  const mine = GAME.trades.filter(t => t.fromId === myId || t.toId === myId);
  if (mine.length === 0) {
    box.innerHTML = '<div class="msg" style="font-size:12px;">No active trades.</div>';
    return;
  }
  mine.forEach(t => {
    const row = document.createElement('div');
    row.className = 'trade-offer-row';
    const label = document.createElement('div');
    label.textContent = tradeSummary(t);
    row.appendChild(label);
    const btnRow = document.createElement('div');
    btnRow.className = 'row';
    if (t.toId === myId) {
      addBtn(btnRow, 'Accept', () => room.send('respond_trade', { tradeId: t.id, accept: true }));
      addBtn(btnRow, 'Decline', () => room.send('respond_trade', { tradeId: t.id, accept: false }));
    } else {
      addBtn(btnRow, 'Withdraw', () => room.send('cancel_trade', { tradeId: t.id }));
    }
    row.appendChild(btnRow);
    box.appendChild(row);
  });
}

// =========================================================
// SETTINGS UI (prices) + BOARD PRICE DISPLAY
// =========================================================
export function applyPriceDisplay() {
  SPACES.forEach(space => {
    if (space.type !== 'property' && space.type !== 'rail' && space.type !== 'util') return;
    const cellEl = document.querySelector(`#board [data-idx="${space.idx}"]`);
    if (!cellEl) return;
    const priceEl = cellEl.querySelector('.price');
    if (!priceEl) return;
    const mortgaged = !!GAME?.mortgaged?.[space.idx];
    cellEl.classList.toggle('mortgaged-cell', mortgaged);
    if (mortgaged) {
      priceEl.textContent = 'MORTGAGED';
      priceEl.classList.remove('price-rent');
      return;
    }
    const owner = GAME?.owner?.[space.idx];
    if (owner === undefined) {
      // Unowned — still for sale, show the purchase price.
      priceEl.textContent = 'Tk' + priceOf(space.idx);
      priceEl.classList.remove('price-rent');
      return;
    }
    // Owned — show what landing here actually costs right now, so
    // houses/hotels (and completed monopolies) are reflected live
    // instead of the tile forever showing the original buy price.
    priceEl.classList.add('price-rent');
    if (space.type === 'util') {
      const count = UTIL_IDXS.filter(i => GAME.owner[i] === owner).length;
      priceEl.textContent = count >= 2 ? '10x dice' : '4x dice';
    } else {
      priceEl.textContent = 'Tk' + computeRent(GAME, space.idx, owner, 0);
    }
  });
}

export function renderSettingsList() {
  const listEl = document.getElementById('settings-list');
  listEl.innerHTML = '';
  const editable = isHost() && !ROOM.started;

  const groupsInOrder = ['brown','lightblue','pink','orange','red','yellow','green','blue'];
  const groupLabels = { brown:'Brown', lightblue:'Light Blue', pink:'Pink', orange:'Orange', red:'Red', yellow:'Yellow', green:'Green', blue:'Blue' };
  groupsInOrder.forEach(group => {
    const groupDiv = document.createElement('div');
    groupDiv.className = 'settings-group';
    const h4 = document.createElement('h4');
    h4.textContent = groupLabels[group];
    groupDiv.appendChild(h4);
    GROUPS[group].forEach(idx => groupDiv.appendChild(buildSettingsRow(idx)));
    listEl.appendChild(groupDiv);
  });

  const railDiv = document.createElement('div');
  railDiv.className = 'settings-group';
  railDiv.innerHTML = '<h4>Railroads</h4>';
  RAIL_IDXS.forEach(idx => railDiv.appendChild(buildSettingsRow(idx)));
  listEl.appendChild(railDiv);

  const utilDiv = document.createElement('div');
  utilDiv.className = 'settings-group';
  utilDiv.innerHTML = '<h4>Utilities</h4>';
  UTIL_IDXS.forEach(idx => utilDiv.appendChild(buildSettingsRow(idx)));
  listEl.appendChild(utilDiv);

  document.getElementById('btn-reset-settings').classList.toggle('hidden', !editable);
  document.getElementById('settings-hint').textContent = ROOM.started
    ? 'Prices are locked in for this game (settings can only be changed before launch).'
    : (editable
      ? 'Purchase prices only — rent still follows the classic table for each space. Changes save automatically.'
      : 'Only the host can change prices. Purchase prices only — rent still follows the classic table.');

  function buildSettingsRow(idx) {
    const space = SPACES[idx];
    const row = document.createElement('div');
    row.className = 'settings-row';
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = space.group ? getComputedGroupColor(space.group) : '#888';
    const name = document.createElement('span');
    name.className = 'sname';
    name.textContent = space.name;
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.max = '9999';
    input.dataset.idx = idx;
    input.value = priceOf(idx);
    input.disabled = !editable;
    const tick = document.createElement('span');
    tick.className = 'save-tick';
    tick.textContent = '✓';
    if (editable) {
      input.addEventListener('input', () => scheduleAutoSavePrice(idx, input, tick));
    }
    row.appendChild(swatch); row.appendChild(name); row.appendChild(input); row.appendChild(tick);
    return row;
  }
}

// =========================================================
// CHAT
// =========================================================
export function renderExpandedLog() {
  const box = document.getElementById('expanded-log-box');
  if (!box || !GAME) return;
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.innerHTML = '';
  (GAME.log || []).forEach((line, i) => {
    const d = document.createElement('div');
    d.textContent = line;
    if (i === GAME.log.length - 1) d.className = 'log-newest';
    box.appendChild(d);
  });
  if (wasNearBottom || box.dataset.everScrolled !== 'true') {
    box.scrollTop = box.scrollHeight;
    box.dataset.everScrolled = 'true';
  }
}

export function renderChat() {
  const box = document.getElementById('expanded-chat-messages');
  if (!box) return;
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.innerHTML = '';
  (ROOM.chat || []).forEach(m => {
    const div = document.createElement('div');
    div.className = 'chat-msg' + (m.senderId === myId ? ' mine' : '');
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = labelFor(m.senderId) + ':';
    div.appendChild(who);
    div.appendChild(document.createTextNode(' ' + m.text));
    box.appendChild(div);
  });
  if (wasNearBottom || box.dataset.everScrolled !== 'true') {
    box.scrollTop = box.scrollHeight;
    box.dataset.everScrolled = 'true';
  }
}


// =========================================================
// ANNOUNCEMENT TOAST — card draws and jail sends, shown to
// everyone (matching how these are always visible/audible to
// the whole table in a real game), not just the affected player.
// =========================================================
export let lastSeenAnnouncementTs = null;
export let toastHideTimer = null;

export function checkAnnouncement() {
  const ann = GAME?.announcement;
  if (!ann || ann.ts === lastSeenAnnouncementTs) return;
  lastSeenAnnouncementTs = ann.ts;
  showAnnouncementToast(ann);
}

export function showAnnouncementToast(ann) {
  const el = document.getElementById('announcement-toast');
  clearTimeout(toastHideTimer);
  el.className = 'toast-' + ann.kind; // resets 'hidden'/'fading' too
  el.innerHTML = `
    <div class="toast-kind">${ann.kind === 'jail' ? 'Jail' : 'Card Drawn'}</div>
    <div class="toast-text">${ann.text}</div>
  `;
  toastHideTimer = setTimeout(() => {
    el.classList.add('fading');
    setTimeout(() => { el.className = 'hidden'; }, 500);
  }, 4500);
}

export function renderCheatLog() {
  const box = document.getElementById('cheat-log');
  if (!box) return;
  const entries = ROOM?.cheatLog || [];
  if (entries.length === 0) {
    box.innerHTML = '<div class="cheat-log-empty">No cheats run yet. Try "help".</div>';
    return;
  }
  box.innerHTML = '';
  entries.forEach(e => {
    const div = document.createElement('div');
    div.className = 'cheat-log-entry' + (e.ok === false ? ' cheat-error' : '');
    const cmd = document.createElement('span');
    cmd.className = 'cheat-cmd';
    cmd.textContent = `${labelFor(e.senderId)}: ${e.command}`;
    const result = document.createElement('span');
    result.className = 'cheat-result';
    result.textContent = e.result;
    div.appendChild(cmd);
    div.appendChild(result);
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}
