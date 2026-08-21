// =========================================================
// BOARD DATA — space definitions, card decks, and pure helpers
// that don't depend on live room/game state. Edit this file for:
// property prices/rents, Chance/Chest card text, bank supply.
// =========================================================
import { ROOM } from './state.js';

// =========================================================
// BOARD DATA — derived directly from the prices printed on
// the board itself, which match classic Monopoly's numbers
// 1:1, so the real classic rent/house-cost tables are reused.
// idx 0-39 follows the board clockwise starting at GO.
// =========================================================
export const GROUP_HOUSE_COST = { brown:50, lightblue:50, pink:100, orange:100, red:150, yellow:150, green:200, blue:200 };
export const RAIL_RENTS = [25, 50, 100, 200]; // by count owned (1..4)

export const SPACES = [
  { idx:0,  type:'go',       name:'GO' },
  { idx:1,  type:'property', name:'Islamabad',       price:60,  group:'brown',     rent:[2,10,30,90,160,250] },
  { idx:2,  type:'chest',    name:'Community Chest' },
  { idx:3,  type:'property', name:'Karachi',         price:60,  group:'brown',     rent:[4,20,60,180,320,450] },
  { idx:4,  type:'tax',      name:'Income Tax',      amount:200, hasChoice:true },
  { idx:5,  type:'rail',     name:'Station A', price:200 },
  { idx:6,  type:'property', name:'Liverpool',       price:100, group:'lightblue', rent:[6,30,90,270,400,550] },
  { idx:7,  type:'chance',   name:'Chance' },
  { idx:8,  type:'property', name:'London',          price:100, group:'lightblue', rent:[6,30,90,270,400,550] },
  { idx:9,  type:'property', name:'Manchester',      price:120, group:'lightblue', rent:[8,40,100,300,450,600] },
  { idx:10, type:'jail',     name:'In Jail / Just Visiting' },
  { idx:11, type:'property', name:'Melaka',          price:140, group:'pink',      rent:[10,50,150,450,625,750] },
  { idx:12, type:'util',     name:'Electric Company', price:150 },
  { idx:13, type:'property', name:'Langkawi',        price:140, group:'pink',      rent:[10,50,150,450,625,750] },
  { idx:14, type:'property', name:'Kuala Lumpur',    price:160, group:'pink',      rent:[12,60,180,500,700,900] },
  { idx:15, type:'rail',     name:'Station B', price:200 },
  { idx:16, type:'property', name:'Chicago',         price:180, group:'orange',    rent:[14,70,200,550,750,950] },
  { idx:17, type:'chest',    name:'Community Chest' },
  { idx:18, type:'property', name:'San Francisco',   price:180, group:'orange',    rent:[14,70,200,550,750,950] },
  { idx:19, type:'property', name:'New York',        price:200, group:'orange',    rent:[16,80,220,600,800,1000] },
  { idx:20, type:'parking',  name:'Free Parking' },
  { idx:21, type:'property', name:'Dhaka',           price:220, group:'red',       rent:[18,90,250,700,875,1050] },
  { idx:22, type:'chance',   name:'Chance' },
  { idx:23, type:'property', name:'Sylhet',          price:220, group:'red',       rent:[18,90,250,700,875,1050] },
  { idx:24, type:'property', name:'Khulna',          price:240, group:'red',       rent:[20,100,300,750,925,1100] },
  { idx:25, type:'rail',     name:'Station C', price:200 },
  { idx:26, type:'property', name:'Madrid',          price:260, group:'yellow',    rent:[22,110,330,800,975,1150] },
  { idx:27, type:'property', name:'Barcelona',       price:260, group:'yellow',    rent:[22,110,330,800,975,1150] },
  { idx:28, type:'util',     name:'Water Works',     price:150 },
  { idx:29, type:'property', name:'Seville',         price:280, group:'yellow',    rent:[24,120,360,850,1025,1200] },
  { idx:30, type:'gotojail', name:'Go To Jail' },
  { idx:31, type:'property', name:'Delhi',           price:300, group:'green',     rent:[26,130,390,900,1100,1275] },
  { idx:32, type:'property', name:'Bangalore',       price:300, group:'green',     rent:[26,130,390,900,1100,1275] },
  { idx:33, type:'chest',    name:'Community Chest' },
  { idx:34, type:'property', name:'Mumbai',          price:320, group:'green',     rent:[28,150,450,1000,1200,1400] },
  { idx:35, type:'rail',     name:'Station D',      price:200 },
  { idx:36, type:'chance',   name:'Chance' },
  { idx:37, type:'property', name:'Toronto',         price:350, group:'blue',      rent:[35,175,500,1100,1300,1500] },
  { idx:38, type:'tax',      name:'Luxury Tax',      amount:100 },
  { idx:39, type:'property', name:'Ottawa',          price:400, group:'blue',      rent:[50,200,600,1400,1700,2000] },
];
export const RAIL_IDXS = [5,15,25,35];
export const UTIL_IDXS = [12,28];
export const GROUPS = {};
SPACES.forEach(s => { if (s.type === 'property') (GROUPS[s.group] ||= []).push(s.idx); });

// Card effects: {type:'collect'|'pay'|'moveTo'|'moveRelative'|'gotojail'|'getoutfree'|'payEach'|'collectEach'|'repairs', ...}
export const CHANCE_CARDS = [
  { text: 'Advance to GO (Collect Tk200)', effect: { type:'moveTo', idx:0 } },
  { text: 'Advance to Ottawa', effect: { type:'moveTo', idx:39 } },
  { text: 'Advance to Islamabad. If you pass GO, collect Tk200', effect: { type:'moveTo', idx:1 } },
  { text: 'Advance to nearest Railroad. Pay double rent.', effect: { type:'nearestRail' } },
  { text: 'Advance to nearest Utility. Pay 10x dice roll.', effect: { type:'nearestUtil' } },
  { text: 'Bank pays you dividend of Tk50', effect: { type:'collect', amount:50 } },
  { text: 'Get out of Jail Free', effect: { type:'getoutfree' } },
  { text: 'Go back 3 spaces', effect: { type:'moveRelative', delta:-3 } },
  { text: 'Go directly to Jail', effect: { type:'gotojail' } },
  { text: 'Make general repairs: pay Tk25/house, Tk100/hotel', effect: { type:'repairs', perHouse:25, perHotel:100 } },
  { text: 'Pay poor tax of Tk15', effect: { type:'pay', amount:15 } },
  { text: 'Take a trip to Station A', effect: { type:'moveTo', idx:5 } },
  { text: 'Advance to Toronto', effect: { type:'moveTo', idx:37 } },
  { text: 'You have been elected chairman — pay each player Tk50', effect: { type:'payEach', amount:50 } },
  { text: 'Your building loan matures — collect Tk150', effect: { type:'collect', amount:150 } },
  { text: 'You win a crossword competition — collect Tk100', effect: { type:'collect', amount:100 } },
];
export const CHEST_CARDS = [
  { text: 'Advance to GO (Collect Tk200)', effect: { type:'moveTo', idx:0 } },
  { text: 'Bank error in your favor — collect Tk200', effect: { type:'collect', amount:200 } },
  { text: 'Doctor’s fee — pay Tk50', effect: { type:'pay', amount:50 } },
  { text: 'From sale of stock you get Tk50', effect: { type:'collect', amount:50 } },
  { text: 'Get out of Jail Free', effect: { type:'getoutfree' } },
  { text: 'Go directly to Jail', effect: { type:'gotojail' } },
  { text: 'Holiday fund matures — collect Tk100', effect: { type:'collect', amount:100 } },
  { text: 'Income tax refund — collect Tk20', effect: { type:'collect', amount:20 } },
  { text: 'It’s your birthday — collect Tk10 from every player', effect: { type:'collectEach', amount:10 } },
  { text: 'Life insurance matures — collect Tk100', effect: { type:'collect', amount:100 } },
  { text: 'Pay hospital fees of Tk100', effect: { type:'pay', amount:100 } },
  { text: 'Pay school fees of Tk50', effect: { type:'pay', amount:50 } },
  { text: 'Receive Tk25 consultancy fee', effect: { type:'collect', amount:25 } },
  { text: 'Repairs: pay Tk40/house, Tk115/hotel', effect: { type:'repairs', perHouse:40, perHotel:115 } },
  { text: 'You have won second prize in a beauty contest — collect Tk10', effect: { type:'collect', amount:10 } },
  { text: 'You inherit Tk100', effect: { type:'collect', amount:100 } },
];

export const TOKEN_COLORS = ['#ff4d6d', '#4fd8e8', '#f4c464', '#8fe388', '#c77dff', '#ff9f5a'];

// Real Monopoly bank supply: 32 houses, 12 hotels, total. Once they're
// gone nobody can build (of either kind) until someone sells/downgrades
// back to the bank.
export const BANK_HOUSES_START = 32;
export const BANK_HOTELS_START = 12;

// The single Get Out of Jail Free card index within each deck — used to
// return a used card to the bottom of the deck it came from.
export const CHANCE_GOOJF_IDX = CHANCE_CARDS.findIndex(c => c.effect.type === 'getoutfree');
export const CHEST_GOOJF_IDX = CHEST_CARDS.findIndex(c => c.effect.type === 'getoutfree');

// Returns a shuffled permutation of indices [0..arr.length-1] into arr —
// used to build a fresh draw pile for a card deck.
export function shuffled(arr) {
  const a = arr.map((_, i) => i);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Shuffles the actual values of an existing array (used to reshuffle a
// discard pile of already-drawn card indices back into a draw pile).
export function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function priceOf(spaceIdx) {
  const custom = ROOM?.customPrices?.[spaceIdx];
  return (typeof custom === 'number' && custom >= 0) ? custom : SPACES[spaceIdx].price;
}
