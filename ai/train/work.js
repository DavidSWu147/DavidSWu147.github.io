// The work behind ai/train/train.js, shared by the main thread and the workers:
// self-play games that collect round-start positions, and their value labels.
'use strict';
const S = require('../simili-solver.js');
const AI = require('../simili-ai.js');
const { mulberry } = require('./mlp.js');

const EMPTY = S.enc([S.E, S.E, S.E, S.E]);
const randomRoll = rand => [0, 1, 2].map(() => Math.floor(rand() * 10));

// Players (one per rules variant) per model id; a job without its model reuses the
// one sent earlier with the same id
// one. The solver's caches are kept small and dropped every so often: a training run
// visits far more positions than a game, and unbounded caches ran a worker out of memory.
const cache = new Map();
const SOLVER_OPTS = { exactLoss: false, maxTables: 15000, maxMemo: 150000 };
let uses = 0;
function players(model, modelId) {
  let p = cache.get(modelId);
  if (!p || model) {
    p = [false, true].map(classic => new AI.Player({ classic, model: model || { nets: {} }, solver: new S.Solver({ classic, ...SOLVER_OPTS }), canonical: process.env.SIMILI_CANONICAL !== '0' }));
    cache.set(modelId, p);
    if (cache.size > 3) cache.delete(cache.keys().next().value);
  }
  if (++uses % 200 === 0) for (const q of cache.values()) for (const pl of q) pl.solver = new S.Solver({ classic: pl.classic, ...SOLVER_OPTS });
  return p;
}

// All results of booking in `cat` with bank `bank` (roll included).
function options(sv, st, cat, bank) {
  const list = [];
  sv.forEachBooking(st, cat, bank, false, true, (rows, bk, uA, uB, nMain, placements) => {
    list.push({ rows: Int16Array.from(rows), bk: Int8Array.from(bk), uA, uB, n: placements.length });
  });
  return list;
}

// A simple player for the first pass, before any network exists: mostly greedy (the
// booking with the most points now, in the category that gives the most on average),
// sometimes booking nothing or something random so the positions vary. (A first try
// with random categories and many random bookings gave almost only hopeless positions,
// about 1% to win by round 9, and the networks learnt nothing useful from them.)
function heuristicPick(list, rand, classic) {
  const r = rand();
  if (r < 0.1) return list.find(o => o.n === 0) || list[0];
  if (r < 0.15) return list[Math.floor(rand() * list.length)];
  let best = null, bs = -Infinity;
  for (const o of list) { const s = S.terminalScore(o.rows, classic) - 0.01 * o.n + 0.05 * rand(); if (s > bs) { bs = s; best = o; } }
  return best;
}
// the category with the most points now, on average over a few rolls
function greedyCategory(sv, st, rand, classic, nRolls) {
  let bc = 0, bv = -Infinity;
  for (let c = 0; c < 3; c++) {
    let tot = 0;
    for (let i = 0; i < nRolls; i++) {
      const b = Int8Array.from(st.bank); for (const d of randomRoll(rand)) b[d]++;
      let m = 0; sv.forEachBooking(st, c, b, false, false, rows => { const x = S.terminalScore(rows, classic); if (x > m) m = x; });
      tot += m;
    }
    tot += 0.5 * rand();
    if (tot > bv) { bv = tot; bc = c; }
  }
  return bc;
}

// One game up to the start of round 9. Returns positions at the start of rounds 2-9,
// keyed by rounds left k = 9 .. 2. With a model, the computer plays (with a little
// randomness, so the positions vary); without one, the rough player above.
// model: the model, or null for the simple player.
// opts (train.js --tieRule, --explore ...):
//  - tieRule: book as the real computer does (among bookings within its tie margin of
//    the best estimate, the fewest digits) instead of simply the best estimate;
//  - explore (0-1), exploreMargin (default 0.02 of win chance), exploreRounds (default 6):
//    in the first exploreRounds rounds, each decision is, with chance `explore`, a random
//    pick among the near-best: categories within exploreMargin of the best, or bookings
//    (equivalent ones once) within exploreMargin, with booking nothing always among them
//    unless it makes 100 unreachable (S.canStillReach100). So the networks also see where
//    the moves they rate a little lower lead, instead of only ever their own favourites.
const explored = { cat: 0, book: 0 };
function playGame(rand, classic, model, modelId, opts) {
  const pl = players(null, modelId)[classic ? 1 : 0];
  const sv = pl.solver;
  let st = S.makeState(new Array(15).fill(EMPTY), new Array(10).fill(0), 0, 0);
  const out = {};
  const eps = opts.eps === undefined ? 0.1 : opts.eps;
  const xMargin = opts.exploreMargin || 0.02, xRounds = opts.exploreRounds || 6;
  for (let round = 1; round <= 8; round++) {
    const k = 11 - round;
    if (round >= 2) out[k] = { rows: Array.from(st.rows), bank: Array.from(st.bank), uA: st.usedA, uB: st.usedB, classic };
    const useAI = model && pl.nets[k - 1] && rand() >= eps;
    const exploreHere = () => !!opts.explore && round <= xRounds && rand() < opts.explore;
    let cat;
    if (useAI && rand() >= eps) {
      const rolls = []; for (let i = 0; i < (opts.catRolls || 6); i++) rolls.push(randomRoll(rand));
      const c = pl.chooseCategory(st, k, rolls);
      cat = c.cat;
      if (exploreHere()) {
        const us = c.values.map(v => AI.utility(v)), bu = Math.max(...us);
        const near = [0, 1, 2].filter(i => us[i] >= bu - xMargin);
        cat = near[Math.floor(rand() * near.length)];
        explored.cat++;
      }
    } else cat = rand() < 0.1 ? Math.floor(rand() * 3) : greedyCategory(sv, st, rand, classic, 6);
    const bank = Int8Array.from(st.bank); for (const d of randomRoll(rand)) bank[d]++;
    const list = options(sv, st, cat, bank);
    let pick;
    if (useAI) {
      let bu = -Infinity;
      for (const o of list) { o.u = AI.utility(pl.value(o.rows, o.bk, o.uA, o.uB, k - 1)); if (o.u > bu) { bu = o.u; pick = o; } }
      if (exploreHere()) {
        const seen = new Set(), near = [];
        for (const o of list) {
          const key = sv.key(o.rows, o.bk, o.uA, o.uB, k - 1);
          if (seen.has(key)) continue;
          if (o.u >= bu - xMargin || (o.n === 0 && S.canStillReach100(o.rows, o.uA, o.uB, k - 1, classic))) { seen.add(key); near.push(o); }
        }
        pick = near[Math.floor(rand() * near.length)];
        explored.book++;
      } else if (opts.tieRule) {
        const margin = Math.max(AI.TIE, pl.tieMargin(k));
        let b = null;
        for (const o of list) {
          if (o.u < bu - margin) continue;
          if (b === null || o.n < b.n || (o.n === b.n && o.u > b.u + AI.TIE)) b = o;
        }
        pick = b;
      }
    } else pick = heuristicPick(list, rand, classic);
    st = S.makeState(pick.rows, pick.bk, pick.uA, pick.uB);
  }
  out[2] = { rows: Array.from(st.rows), bank: Array.from(st.bank), uA: st.usedA, uB: st.usedB, classic };
  return out;
}

// Value label for a round-start position with k rounds left, from `m` random rolls
// (the same rolls for all three categories):
//  - k = 2: the exact solver's best round-9 booking for each roll (round 10 exact);
//  - k >= 3: the best booking for each roll judged by the network for k - 1.
function label(pos, k, rand, m, model, modelId) {
  const pl = players(model, modelId)[pos.classic ? 1 : 0];
  const st = S.makeState(pos.rows, pos.bank, pos.uA, pos.uB);
  const rolls = []; for (let i = 0; i < m; i++) rolls.push(randomRoll(rand));
  if (k >= 3) return pl.positionValue(st, k, rolls, true);
  const sv = pl.solver, bank = new Int8Array(10);
  let best = null;
  for (let cat = 0; cat < 3; cat++) {
    const acc = [0, 0, 0];
    for (const r of rolls) {
      bank.set(st.bank); for (const d of r) bank[d]++;
      const v = sv.bestAfterRollFast(st, cat, bank);
      acc[0] += v[0] / 1000; acc[1] += v[1] / 1000 / 150; acc[2] += v[2] / 1000;
    }
    const val = acc.map(x => x / m);
    if (best === null || AI.utility(val) > AI.utility(best)) best = val;
  }
  return best;
}

// Exact value (all 220 rolls) of a round-9 start position, for checking N[2].
function exactValue2(pos) {
  const pl = players(null, 'none')[pos.classic ? 1 : 0];
  return pl.chooseCategory(S.makeState(pos.rows, pos.bank, pos.uA, pos.uB), 2).values
    .reduce((a, b) => (AI.utility(b) > AI.utility(a) ? b : a));
}

// A whole game on given dice (rolls[0..9]) by the computer player (policy 'ai') or by a
// simple greedy player ('greedy': most points now, category by the average over a few
// rolls), both exact in rounds 9 and 10. Returns the final score, Quad, and what
// happened in round 1, plus the computer's own estimate at the start of round 2.
function evalGame(rolls, classic, policy, model, modelId, catRolls, recheck, margins) {
  const pl = players(model, modelId)[classic ? 1 : 0];
  const sv = pl.solver;
  let st = S.makeState(new Array(15).fill(EMPTY), new Array(10).fill(0), 0, 0);
  const bankList = [];
  const info = { round1Booked: null, estimateRound2: null };
  const rand = mulberry(rolls.flat().reduce((a, d) => a * 11 + d + 1, 7) | 0);
  for (let round = 1; round <= 10; round++) {
    const k = 11 - round;
    if (round === 2 && policy === 'ai' && pl.nets[9]) info.estimateRound2 = pl.value(st.rows, st.bank, st.usedA, st.usedB, 9)[0];
    let cat;
    if (policy === 'ai' || k <= 2) {
      const sample = k >= 3 && catRolls ? Array.from({ length: catRolls }, () => randomRoll(rand)) : undefined;
      cat = pl.chooseCategory(st, k, sample).cat;
    } else {
      // greedy: the category with the most points now, on average over 12 rolls
      let bc = 0, bv = -1;
      for (let c = 0; c < 3; c++) {
        let tot = 0;
        for (let i = 0; i < 12; i++) {
          const b = Int8Array.from(st.bank); for (const d of randomRoll(rand)) b[d]++;
          let m = 0; sv.forEachBooking(st, c, b, false, false, rows => { const x = S.terminalScore(rows, classic); if (x > m) m = x; });
          tot += m;
        }
        if (tot > bv) { bv = tot; bc = c; }
      }
      cat = bc;
    }
    for (const d of rolls[round - 1]) bankList.push({ digit: d, used: false });
    let res;
    if (policy === 'ai' || k <= 2) {
      // as in the page: the re-check over all 220 rolls before Round 8 (recheck.all), else a sample
      const sample = Array.from({ length: recheck ? recheck.rolls : 0 }, () => randomRoll(rand));
      const rc = recheck && recheck.top > 1 ? { top: recheck.top, rolls: recheck.all && k >= 4 ? 'all' : sample } : null;
      pl.margins = margins === false ? {} : null;   // false: no tie margins (as before)
      res = pl.chooseBooking(st, cat, bankList, k, rc);
    } else {
      const bank = new Int8Array(10); for (const b of bankList) if (!b.used) bank[b.digit]++;
      let best = null, bs = -Infinity;
      sv.forEachBooking(st, cat, bank, false, true, (rows, bk, uA, uB, n, placements) => {
        const x = S.terminalScore(rows, classic) - 0.01 * placements.length;
        if (x > bs) { bs = x; best = placements.map(p => ({ ...p })); }
      });
      res = { placements: best };
    }
    if (round === 1) info.round1Booked = res.placements.length;
    // apply the placements: rows, bank, free books
    const rows = Int16Array.from(st.rows);
    let uA = st.usedA, uB = st.usedB;
    for (const p of res.placements) {
      const c = S.dec(rows[p.cat * 5 + p.row]); c[p.col] = p.digit; rows[p.cat * 5 + p.row] = S.enc(c);
      if (p.bonus === 'A') uA = 1; if (p.bonus === 'B') uB = 1;
      const bi = p.bankIdx !== undefined && p.bankIdx >= 0 ? p.bankIdx : bankList.findIndex(b => !b.used && b.digit === p.digit);
      bankList[bi].used = true;
    }
    const bank = new Int8Array(10); for (const b of bankList) if (!b.used) bank[b.digit]++;
    st = S.makeState(rows, bank, uA, uB);
  }
  const score = S.terminalScore(st.rows, classic);
  // Ladder use (does it play LM as well as SM?): rows with any digit, rows complete (20)
  let ladUsed = 0, ladDone = 0;
  for (let i = 10; i < 15; i++) { if (st.rows[i] !== EMPTY) ladUsed++; if (S.SCORE[S.LAD][st.rows[i]] >= 20) ladDone++; }
  return { score, win: score >= 100, quad: S.hasQuad(st.rows), ladUsed, ladDone, ...info };
}

function handle(msg) {
  if (msg.type === 'evalGame') return evalGame(msg.rolls, msg.classic, msg.policy, msg.model, msg.modelId, msg.catRolls, msg.recheck, msg.margins);
  if (msg.type === 'games') {
    const rand = mulberry(msg.seed);
    const res = [];
    if (msg.model) players(msg.model, msg.modelId);   // keep the model for the later jobs without it
    for (let i = 0; i < msg.n; i++) {
      const classic = rand() < msg.classicShare;
      // later passes: a quarter of the games by the simple player too, for variety
      const simple = msg.modelId === 'rough' || rand() < 0.25;
      res.push(playGame(rand, classic, simple ? null : msg.modelId, simple ? 'rough' : msg.modelId, msg.opts || {}));
    }
    return res;
  }
  if (msg.type === 'label') {
    const rand = mulberry(msg.seed);
    return msg.items.map(p => label(p, msg.k, rand, msg.m, msg.model, msg.modelId));
  }
  if (msg.type === 'exact2') return msg.items.map(exactValue2);
  throw new Error('unknown job ' + msg.type);
}

module.exports = { explored, handle, playGame, label, options, exactValue2, evalGame };
