// ============================================================
// SIMILI exact endgame solver
// ------------------------------------------------------------
// Expectimax over: choose category -> roll (220 distinct, /1000) -> booking.
// Always Strict Placement. Classic vs Modern is the only rules parameter.
//
// Value of a position = lexicographic vector, kept as exact integers:
//   [ winCount, pointsIfWonSum, quadCount, pointsIfLostSum ]   (scaled by 1000^roundsLeft)
//   1. chance of finishing with >= 100 points
//   2. average final score when winning (sum over winning outcomes; Quad Bonus excluded)
//   3. chance of holding a Quad (4-of-a-kind Matching row), win or lose
//   4. average final score when losing (sum over losing outcomes)
// Booking tie-breaks (top-level only): 5. most points at the end of this round,
// 6. fewest digits, 7. avoid the most recently banked digits,
// 8. lean left (same digits placed further left / higher up), 9. ascending Sequences and Ladders.
// ============================================================
(function (root) {
  'use strict';

  const E = 10;                       // empty cell
  const NCODES = 14641;               // 11^4 row codes
  const SEQ = 0, MAT = 1, LAD = 2;
  const CAT_NAMES = ['sequence', 'matching', 'ladder'];
  const ROWS = 5;
  const W_A = ['A'], W_B = ['B'], W_AB = ['A', 'B'];

  // ---------- row codes ----------
  function enc(c) { return ((c[0] * 11 + c[1]) * 11 + c[2]) * 11 + c[3]; }
  function dec(code) {
    const c = [0, 0, 0, 0];
    for (let i = 3; i >= 0; i--) { c[i] = code % 11; code = (code - c[i]) / 11; }
    return c;
  }
  const toNull = c => c.map(x => (x === E ? null : x));

  // ---------- rules, copied from index.html (strict placement) ----------
  function isValidSequence(digits) {
    if (digits.length < 2) return true;
    let asc = true, desc = true;
    for (let i = 1; i < digits.length; i++) if ((digits[i - 1] + 1) % 10 !== digits[i]) { asc = false; break; }
    for (let i = 1; i < digits.length; i++) if ((digits[i - 1] - 1 + 10) % 10 !== digits[i]) { desc = false; break; }
    return asc || desc;
  }
  function seqLegal(cells) { // canExtendSequence over the whole row
    const f = [];
    cells.forEach((d, pos) => { if (d !== null) f.push({ d, pos }); });
    if (f.length < 2) return true;
    const a = f.map(({ d, pos }) => (d - pos + 40) % 10), b = f.map(({ d, pos }) => (d + pos) % 10);
    return a.every(s => s === a[0]) || b.every(s => s === b[0]);
  }
  function matLegal(cells) { const f = cells.filter(c => c !== null); return f.every(d => d === f[0]); }
  function ladLegal(row) {
    const [a, b, c, d] = row;
    if (a !== null && b !== null && a !== b) return false;
    if (c !== null && d !== null && c !== d) return false;
    const l = a !== null ? a : b, r = c !== null ? c : d;
    if (l !== null && r !== null) { const diff = Math.abs(l - r); if (diff !== 1 && diff !== 9) return false; }
    return true;
  }
  function scoreSeq(cells) {
    const filled = cells.filter(c => c !== null);
    if (filled.length >= 4 && isValidSequence(filled)) return 15;
    if (filled.length >= 3) {
      const pos = cells.map((c, i) => (c !== null ? i : -1)).filter(i => i !== -1);
      for (let s = 0; s <= pos.length - 3; s++) {
        const g = pos.slice(s, s + 3);
        if (g[2] - g[0] === 2 && isValidSequence(g.map(i => cells[i]))) return 10;
      }
    }
    return 0;
  }
  function scoreMat(cells) {
    const filled = cells.filter(c => c !== null);
    if (filled.length === 0 || !filled.every(d => d === filled[0])) return 0;
    if (filled.length >= 4) return 20;
    if (filled.length >= 3) {
      const pos = cells.map((c, i) => (c !== null ? i : -1)).filter(i => i !== -1);
      for (let s = 0; s <= pos.length - 3; s++) if (pos[s + 2] - pos[s] === 2) return 15;
    }
    return 0;
  }
  function scoreLad(cells) { return cells.every(c => c !== null) && ladLegal(cells) ? 20 : 0; }

  // ---------- per-code tables ----------
  const LEGAL = [new Uint8Array(NCODES), new Uint8Array(NCODES), new Uint8Array(NCODES)];
  const SCORE = [new Int8Array(NCODES), new Int8Array(NCODES), new Int8Array(NCODES)];
  const CANON = new Uint16Array(NCODES);   // min(code, mirrored code): rules are mirror-symmetric
  // Ladder rows are also unchanged by swapping the two cells of a pair (34_4 = 344_ = 4_43):
  // legality and scoring only look at each pair's digit(s). So Ladder gets a finer class.
  const CANON_LAD = new Uint16Array(NCODES);
  const FILLED = new Uint8Array(NCODES);
  for (let code = 0; code < NCODES; code++) {
    const c = dec(code), n = toNull(c);
    FILLED[code] = c.filter(x => x !== E).length;
    LEGAL[SEQ][code] = seqLegal(n) ? 1 : 0;
    LEGAL[MAT][code] = matLegal(n) ? 1 : 0;
    LEGAL[LAD][code] = ladLegal(n) ? 1 : 0;
    SCORE[SEQ][code] = scoreSeq(n);
    SCORE[MAT][code] = scoreMat(n);
    SCORE[LAD][code] = scoreLad(n);
    CANON[code] = Math.min(code, enc([c[3], c[2], c[1], c[0]]));
    let m = NCODES;
    for (const [a, b] of [[c[0], c[1]], [c[1], c[0]]]) for (const [x, y] of [[c[2], c[3]], [c[3], c[2]]]) {
      m = Math.min(m, enc([a, b, x, y]), enc([y, x, b, a]));
    }
    CANON_LAD[code] = m;
  }
  const EMPTY_ROW = enc([E, E, E, E]);

  // ---------- rows that play the same ----------
  // Two rows of a category are interchangeable if each can answer every digit the other
  // takes with the same digit and stay at least as good (and score at least as much
  // now). Then any plan for one works for the other, so positions that differ only by
  // such rows have the same value, and caches can share them. Examples: mirrored rows
  // (123_ = _321); Matching 1___ = _1__ and 11__ = _11_ = 1_1_ (but not 1__1, which
  // needs both remaining cells for anything); Ladder 1_2_ = _12_ = 2__1 and so on.
  // Rows that can never score more are interchangeable with any row of the same score.
  // Computed level by level from full rows down (each placement adds a cell).
  function rowClasses(cat) {
    const legal = [], moves = new Map(), best = new Map(), level = [[], [], [], [], []];
    for (let c = 0; c < NCODES; c++) if (LEGAL[cat][c]) legal.push(c);
    for (const c of legal) {
      const cells = dec(c), mv = [];
      for (let p = 0; p < 4; p++) if (cells[p] === E) {
        for (let d = 0; d <= 9; d++) { cells[p] = d; const n = enc(cells); if (LEGAL[cat][n]) mv.push(d, n); }
        cells[p] = E;
      }
      moves.set(c, mv);
      level[4 - dec(c).filter(x => x === E).length].push(c);
    }
    for (let k = 4; k >= 0; k--) for (const c of level[k]) {
      let b = SCORE[cat][c];
      const mv = moves.get(c);
      for (let j = 1; j < mv.length; j += 2) b = Math.max(b, best.get(mv[j]));
      best.set(c, b);
    }
    const dead = c => best.get(c) === SCORE[cat][c];
    const le = new Map();
    const LE = (a, b) => {
      if (a === b) return true;
      const v = le.get(a * NCODES + b);
      if (v !== undefined) return v;
      return dead(a) && SCORE[cat][a] <= SCORE[cat][b];   // wasted digits can simply be kept
    };
    // candidates: rows with the same number of filled cells (digits may differ: 123_ and
    // _567 both just wait for a 4)
    const groupsAt = k => [level[k]];
    for (let k = 4; k >= 0; k--) for (const g of groupsAt(k)) for (const a of g) for (const b of g) {
      if (a === b) continue;
      let ok = SCORE[cat][a] <= SCORE[cat][b];
      const ma = moves.get(a), mb = moves.get(b);
      for (let i = 0; ok && i < ma.length; i += 2) {
        let found = false;
        for (let j = 0; j < mb.length; j += 2) if (mb[j] === ma[i] && LE(ma[i + 1], mb[j + 1])) { found = true; break; }
        if (!found) ok = false;
      }
      le.set(a * NCODES + b, ok);
    }
    const cls = new Uint16Array(NCODES);
    for (let c = 0; c < NCODES; c++) cls[c] = c;
    for (let k = 0; k <= 4; k++) for (const g of groupsAt(k)) for (const a of g) for (const b of g) {
      if (b < cls[a] && LE(a, b) && LE(b, a)) cls[a] = b;
    }
    const deadRep = new Map();
    for (const c of legal) if (dead(c)) { const sc = SCORE[cat][c]; if (!deadRep.has(sc) || c < deadRep.get(sc)) deadRep.set(sc, c); }
    for (const c of legal) if (dead(c)) cls[c] = deadRep.get(SCORE[cat][c]);
    ROW_LE[cat] = LE;
    return cls;
  }
  // ROW_LE[cat](a, b): row b can do everything row a can (b is at least as good)
  const ROW_LE = [null, null, null];
  const CLASS = [rowClasses(SEQ), rowClasses(MAT), rowClasses(LAD)];

  // Extensions of a row: every legal way to fill a non-empty subset of its empty cells.
  // ext = { code, n, need: Int8Array(10), cells: [[pos, digit], ...], gain }
  const EXT = [new Map(), new Map(), new Map()];
  function getExt(cat, code) {
    let list = EXT[cat].get(code);
    if (list) return list;
    list = [];
    const cells = dec(code), empties = [];
    for (let i = 0; i < 4; i++) if (cells[i] === E) empties.push(i);
    const placed = [];
    (function dfs(start) {
      for (let j = start; j < empties.length; j++) {
        const p = empties[j];
        for (let d = 0; d <= 9; d++) {
          cells[p] = d;
          const nc = enc(cells);
          if (LEGAL[cat][nc]) {
            placed.push([p, d]);
            const need = new Int8Array(10);
            for (const [, dd] of placed) need[dd]++;
            list.push({ code: nc, n: placed.length, need, cells: placed.slice(), gain: SCORE[cat][nc] - SCORE[cat][code] });
            dfs(j + 1);
            placed.pop();
          }
        }
        cells[p] = E;
      }
    })(0);
    // fewer digits first, so equal-valued results are found with fewer digits first
    list.sort((a, b) => a.n - b.n);
    list.improving = list.filter(e => e.gain > 0);
    list.singles = list.filter(e => e.n === 1);
    list.singlesImproving = list.singles.filter(e => e.gain > 0);
    // "lean" lists for value searches: among extensions that use the same digits, drop
    // any whose result is beaten by another's (e.g. Matching 1__1 vs 11__), and keep one
    // of each set of interchangeable results (Ladder 1_2_ = _12_ = ...). The value is
    // unchanged; only the Hint, which must pick particular cells, uses the full lists.
    const LE = ROW_LE[cat];
    const sameNeed = (a, b) => { for (let d = 0; d < 10; d++) if (a.need[d] !== b.need[d]) return false; return true; };
    list.lean = list.filter((e, i) => {
      for (let j = 0; j < list.length; j++) {
        if (j === i) continue;
        const f = list[j];
        if (f.n !== e.n || !sameNeed(e, f) || !LE(e.code, f.code)) continue;
        if (!LE(f.code, e.code) || j < i) return false;   // strictly beaten, or an earlier equal one
      }
      return true;
    });
    list.improvingLean = list.lean.filter(e => e.gain > 0);
    list.singlesLean = list.lean.filter(e => e.n === 1);
    list.singlesImprovingLean = list.singlesLean.filter(e => e.gain > 0);
    EXT[cat].set(code, list);
    return list;
  }

  // ---------- rolls ----------
  const ROLLS = [];
  for (let a = 0; a <= 9; a++) for (let b = a; b <= 9; b++) for (let c = b; c <= 9; c++) {
    ROLLS.push({ digits: [a, b, c], w: a === b && b === c ? 1 : a === b || b === c ? 3 : 6 });
  }

  // ---------- state ----------
  // rows: Int16Array(15) (cat*5 + i), bank: Int8Array(10) unused-digit counts,
  // usedA/usedB: 0 unused, 1 used into Sequence, 2 used into Matching/Ladder ('?')
  function makeState(rows, bank, usedA, usedB) {
    return { rows: Int16Array.from(rows), bank: Int8Array.from(bank), usedA: usedA | 0, usedB: usedB | 0 };
  }
  function seqCounts(rows) {
    let n10 = 0, n15 = 0;
    for (let i = 0; i < ROWS; i++) { const s = SCORE[SEQ][rows[i]]; if (s >= 10) n10++; if (s >= 15) n15++; }
    return [n10, n15];
  }
  function terminalScore(rows, classic) {
    let s = 0;
    for (let cat = 0; cat < 3; cat++) for (let i = 0; i < ROWS; i++) s += SCORE[cat][rows[cat * ROWS + i]];
    let n15 = 0, m20 = 0, l20 = 0;
    for (let i = 0; i < ROWS; i++) {
      if (SCORE[SEQ][rows[i]] >= 15) n15++;
      if (SCORE[MAT][rows[ROWS + i]] >= 20) m20++;
      if (SCORE[LAD][rows[2 * ROWS + i]] >= 20) l20++;
    }
    if (n15 >= 5 || (!classic && (m20 === ROWS || l20 === ROWS))) s += 5;
    return s;
  }
  // ---------- can 100 still be reached at all? ----------
  // With k rounds to play from a round start, could the score reach 100 even if every
  // digit were always at hand? If not, the game is lost whatever the dice do (booking
  // nothing in rounds 1-4 in Classic, say). Optimistic on purpose, so it never calls a
  // winnable position lost: each row needs only cells (any digits), a round gives 3 cells
  // in its category (4 in Sequence once Bonus I is active; the first Sequence round only 3
  // if it is not yet), each free book still to come (II-A once 5 Sequence rows score 10+,
  // II-B in Modern once 4 score 15) one cell anywhere, at any time, and Bonus III +5.
  // reachBest[cat][code * 5 + c]: the best score this row can reach with c more cells
  const reachBest = [0, 1, 2].map(() => new Int8Array(NCODES * 5).fill(-1));
  function rowReach(cat, code, c) {
    const t = reachBest[cat], key = code * 5 + c;
    if (t[key] >= 0) return t[key];
    let best = SCORE[cat][code];
    if (c > 0) {
      const cells = dec(code);
      for (let p = 0; p < 4; p++) {
        if (cells[p] !== E) continue;
        for (let d = 0; d <= 9; d++) {
          cells[p] = d;
          const n = enc(cells);
          if (LEGAL[cat][n]) { const v = rowReach(cat, n, c - 1); if (v > best) best = v; }
        }
        cells[p] = E;
      }
    }
    t[key] = best;
    return best;
  }
  // best gain from one category's 5 rows with at most b cells (b <= REACH_B), by how many
  // rows end at 10+ / 15 (Sequence) or 20 (Matching, Ladder): flags[b][x * 6 + y] ("at
  // least x / y rows"; NEG: impossible) and plain[b] (any). Cached by the 5 rows (in any order).
  const REACH_B = 22, NEG = -1e9;   // a category has 20 cells, + 2 free books
  const catReachCache = new Map();
  function categoryReach(rows, cat) {
    const codes = [];
    for (let i = 0; i < ROWS; i++) codes.push(rows[cat * ROWS + i]);
    codes.sort((x, y) => x - y);
    const key = cat + ':' + codes.join(',');
    const hit = catReachCache.get(key);
    if (hit) return hit;
    let cur = [];
    for (let b = 0; b <= REACH_B; b++) cur.push(new Float64Array(36).fill(NEG));
    cur[0][0] = 0;
    for (const code of codes) {
      const base = SCORE[cat][code];
      const opts = [];
      for (let c = 0; c <= 4; c++) {
        const sc = rowReach(cat, code, c);
        opts.push({ c, gain: sc - base, x: cat === SEQ ? (sc >= 10 ? 1 : 0) : (sc >= 20 ? 1 : 0), y: cat === SEQ && sc >= 15 ? 1 : 0 });
      }
      const next = [];
      for (let bb = 0; bb <= REACH_B; bb++) next.push(new Float64Array(36).fill(NEG));
      for (let bb = 0; bb <= REACH_B; bb++) for (let st = 0; st < 36; st++) {
        const g = cur[bb][st];
        if (g === NEG) continue;
        const x = Math.floor(st / 6), y = st % 6;
        for (const o of opts) {
          const nb = bb + o.c;
          if (nb > REACH_B) break;
          if (o.c > 0 && o.gain === opts[o.c - 1].gain && o.x === opts[o.c - 1].x && o.y === opts[o.c - 1].y) continue;   // a cell more for nothing
          const ns = (x + o.x) * 6 + (y + o.y);
          if (g + o.gain > next[nb][ns]) next[nb][ns] = g + o.gain;
        }
      }
      cur = next;
    }
    const flags = [], plain = new Float64Array(REACH_B + 1);
    for (let bb = 0; bb <= REACH_B; bb++) {
      const t = new Float64Array(36).fill(NEG);
      for (let x = 5; x >= 0; x--) for (let y = 5; y >= 0; y--) {
        let v = Math.max(cur[bb][x * 6 + y], bb > 0 ? flags[bb - 1][x * 6 + y] : NEG);
        if (x < 5) v = Math.max(v, t[(x + 1) * 6 + y]);
        if (y < 5) v = Math.max(v, t[x * 6 + y + 1]);
        t[x * 6 + y] = v;
      }
      flags.push(t);
      plain[bb] = t[0];
    }
    const r = { flags, plain };
    if (catReachCache.size > 100000) catReachCache.clear();
    catReachCache.set(key, r);
    return r;
  }
  const reachCache = new Map();
  function canStillReach100(rows, usedA, usedB, k, classic) {
    let base = 0;
    for (let i = 0; i < 3 * ROWS; i++) base += SCORE[Math.floor(i / ROWS)][rows[i]];
    if (base >= 100) return true;
    let bonusI = false;
    for (let i = 0; i < ROWS; i++) if (SCORE[SEQ][rows[i]] >= 10) bonusI = true;
    const freeMax = (usedA === 0 ? 1 : 0) + (!classic && usedB === 0 ? 1 : 0);
    const capS = r => Math.min(20, r === 0 ? 0 : bonusI ? 4 * r : 3 + 4 * (r - 1));
    const cap3 = r => Math.min(20, 3 * r);
    const S_ = categoryReach(rows, SEQ), M_ = categoryReach(rows, MAT), L_ = categoryReach(rows, LAD);
    const need = 100 - base;
    // clearly lost: not even with every round in every category, the free books and Bonus III
    if (S_.plain[capS(k) + freeMax] + M_.plain[cap3(k) + freeMax] + L_.plain[cap3(k) + freeMax] + 5 < need) return false;
    // clearly alive: some split of the rounds gets there without free books or Bonus III
    for (let rS = 0; rS <= k; rS++) for (let rM = 0; rM <= k - rS; rM++) {
      if (S_.plain[capS(rS)] + M_.plain[cap3(rM)] + L_.plain[cap3(k - rS - rM)] >= need) return true;
    }
    const key = (classic ? 'c' : 'm') + k + usedA + usedB + Array.prototype.join.call(rows, ',');
    const hit = reachCache.get(key);
    if (hit !== undefined) return hit;
    let ok = false;
    for (let rS = 0; rS <= k && !ok; rS++) for (let rM = 0; rM <= k - rS && !ok; rM++) {
      const cS = capS(rS), cM = cap3(rM), cL = cap3(k - rS - rM);
      for (let a = 0; a <= 5 && !ok; a++) for (let c = 0; c <= a && !ok; c++) {
        const free = (usedA === 0 && a >= 5 ? 1 : 0) + (!classic && usedB === 0 && c >= 4 ? 1 : 0);
        for (let fS = 0; fS <= free && !ok; fS++) for (let fM = 0; fM <= free - fS && !ok; fM++) {
          const fL = free - fS - fM;
          const sg = S_.flags[cS + fS][a * 6 + c];
          if (sg <= NEG) continue;
          for (const mAll of [0, 5]) for (const lAll of [0, 5]) {
            const m = M_.flags[cM + fM][mAll * 6], l = L_.flags[cL + fL][lAll * 6];
            if (m <= NEG || l <= NEG) continue;
            const bonusIII = c >= 5 || (!classic && (mAll === 5 || lAll === 5));
            if (sg + m + l + (bonusIII ? 5 : 0) >= need) { ok = true; break; }
          }
        }
      }
    }
    if (reachCache.size > 200000) reachCache.clear();
    reachCache.set(key, ok);
    return ok;
  }

  function hasQuad(rows) {
    for (let i = 0; i < ROWS; i++) if (SCORE[MAT][rows[ROWS + i]] >= 20) return true;
    return false;
  }

  // ---------- solver ----------
  function Solver(opts) {
    opts = opts || {};
    this.classic = !!opts.classic;
    this.memo = [null, new Map(), new Map(), new Map(), new Map(), new Map()];
    this.nodes = 0;
    this.tables = new Map();
    this.tablesBuilt = 0;
    this.fullTablesBuilt = 0;
    this.maxTables = opts.maxTables || 100000;      // ~200 MB at most
    this.maxMemo = opts.maxMemo || 1000000;         // round-10 position cache, ~150 MB at most
    this.fastFinal = opts.fastFinal !== false;
    this.prune = opts.prune === true;   // experimental: exact but not faster yet (see README)
    this.pruned = 0; this.evaluated = 0; this.cheap = 0;
    this.fast2 = opts.fast2 !== false;
    // skip bookings whose result another booking with the same digits matches or beats
    this.dominance = opts.dominance !== false;
    // exactLoss: false -> the 4th value (points if lost) may come out low; the first three
    // stay exact and the search can skip much more (for odds displays, not for Hints)
    this.exactLoss = opts.exactLoss !== false;
    // free books only in the last round (same values, far fewer options; see forEachBooking)
    this.saveFreeBooks = opts.saveFreeBooks !== false;
    this.l1 = new Map(); this.l2size = 0;
  }

  // Key for memoization: canonical (mirror + row order) rows, capped bank, bonus status.
  Solver.prototype.key = function (rows, bank, usedA, usedB, roundsLeft) {
    const a = new Array(26);
    for (let cat = 0; cat < 3; cat++) {
      const t = [];
      const CN = CLASS[cat];
      for (let i = 0; i < ROWS; i++) t.push(CN[rows[cat * ROWS + i]]);
      t.sort((x, y) => x - y);
      for (let i = 0; i < ROWS; i++) a[cat * ROWS + i] = t[i];
    }
    const cap = roundsLeft * 4 + 2;   // can never book more digits than this
    for (let d = 0; d < 10; d++) a[15 + d] = Math.min(bank[d], cap) + 1;
    a[25] = 1 + usedA * 3 + usedB;
    return String.fromCharCode.apply(null, a);
  };

  Solver.prototype.terminal = function (rows) {
    const s = terminalScore(rows, this.classic), q = hasQuad(rows) ? 1 : 0;
    return s >= 100 ? [1, s, q, 0] : [0, 0, q, s];
  };

  // Enumerate every distinct end-of-booking-phase result for (state, cat) once the
  // roll has been added to bank. `final` = this is round 10 (only improving bookings matter).
  // cb(rows, bank, usedA, usedB, nMain, placements) ; placements built only if `track`.
  // `wild` (final round only): allow up to `wild` digits not in the bank; cb's 8th
  // argument is then the missing multiset code (see fast final round below).
  // `lastCb(missKey, score, quad)` (last round, no tracking): optional fast path for the
  // final free book, reporting the end score directly instead of calling cb per option.
  // `unlockOnly` (last round, Sequence): only main bookings that unlock a free book, and
  // only their free-book continuations (the caller covers everything else).
  Solver.prototype.forEachBooking = function (st, cat, bank, final, track, cb, wild, lastCb, unlockOnly) {
    wild = wild | 0;
    const classic = this.classic;
    const rows = Int16Array.from(st.rows);
    const bk = Int8Array.from(bank);
    const miss = new Int8Array(10);
    let missN = 0;
    const missKey = () => {
      if (!wild) return 0;
      let m = 0, k = 0;
      for (let d = 0; d < 10; d++) for (let c = miss[d]; c > 0; c--) { m = m * 11 + d; k++; }
      for (; k < 3; k++) m = m * 11 + E;
      return m;
    };
    // take digits from the bank, else from wildcards; returns false if impossible
    const usedBuf = wild ? new Int8Array(ROWS * 10) : null;   // one slot per row (no allocation per booking)
    const take = (need, slot) => {
      let add = 0;
      for (let d = 0; d < 10; d++) if (need[d] > bk[d]) add += need[d] - bk[d];
      if (missN + add > wild) return false;
      const o = slot * 10;
      for (let d = 0; d < 10; d++) {
        const fromBank = need[d] < bk[d] ? need[d] : bk[d];
        usedBuf[o + d] = fromBank; bk[d] -= fromBank; miss[d] += need[d] - fromBank;
      }
      missN += add;
      return true;
    };
    const give = (need, slot) => {
      const o = slot * 10;
      for (let d = 0; d < 10; d++) { const u = usedBuf[o + d]; bk[d] += u; miss[d] -= need[d] - u; missN -= need[d] - u; }
    };
    const [n10, n15] = seqCounts(rows);
    const maxBook = cat === SEQ && n10 >= 1 ? 4 : 3;
    const base = cat * ROWS;
    const choice = new Int32Array(ROWS);
    const placements = [];
    const exts = [];
    // In the last round only scoring bookings matter, unless a Bonus II free book can
    // finish a row afterwards: e.g. three main books 33_4 into an empty Ladder row,
    // then a free 4 makes 3344. A free book is usable if one is already unlocked and
    // unused, or if booking Sequence could unlock one this round.
    const leanFree = this.dominance && !track;
    const nFree = final ? freeBooksPossible(rows, st.usedA, st.usedB, classic, cat === SEQ ? maxBook : 0) : 0;
    const onlyScoring = nFree === 0;
    for (let i = 0; i < ROWS; i++) {
      const L = getExt(cat, rows[base + i]);
      const lean = this.dominance && !track;
      exts.push(!final ? (lean ? L.lean : L) : onlyScoring ? (lean ? L.improvingLean : L.improving) : finishable(cat, lean ? L.lean : L, nFree));
    }
    const self = this;

    function bonusPhase(nMain, setups) {
      if (unlockOnly) {
        let c10 = 0, c15 = 0;
        for (let i = 0; i < ROWS; i++) { const s = SCORE[SEQ][rows[i]]; if (s >= 10) c10++; if (s >= 15) c15++; }
        if ((st.usedA === 0 && c10 >= 5) || (!classic && st.usedB === 0 && c15 >= 4)) tryBonus(st.usedA, st.usedB, nMain, 0, -1);
        return;
      }
      if (setups > 0) {
        // last round with non-scoring set-ups: only useful if a free book is now at hand
        // (stopping here is never better than not making the set-ups at all)
        let c10 = 0, c15 = 0;
        for (let i = 0; i < ROWS; i++) { const s = SCORE[SEQ][rows[i]]; if (s >= 10) c10++; if (s >= 15) c15++; }
        if (!((st.usedA === 0 && c10 >= 5) || (!classic && st.usedB === 0 && c15 >= 4))) return;
      } else {
        // Option: stop here.
        cb(rows, bk, st.usedA, st.usedB, nMain, placements, missKey());
      }
      // Before the last round a free book is never worth using: kept until round 10 (or
      // after it), the same digit can still go in the same cell then, with everything
      // known, and nothing in between depends on it (any partial row of a legal row is
      // legal, free books do not count against booking limits, and unlocking only looks
      // at the rows at that time).
      if (!final && self.saveFreeBooks) return;
      if (st.usedA === 0 || (!classic && st.usedB === 0)) tryBonus(st.usedA, st.usedB, nMain, 0, -1);
    }
    // Use one free book (A or B), then possibly the other. In the last round a free
    // book that scores nothing is only worth it if the other free book then finishes
    // that same row (`onlyIdx`); and when both are already unlocked, which one goes
    // first changes nothing, so only A-then-B is tried.
    function tryBonus(uA, uB, nMain, depth, onlyIdx) {
      if (depth >= 2) return;
      let c10 = 0, c15 = 0;
      for (let i = 0; i < ROWS; i++) { const s = SCORE[SEQ][rows[i]]; if (s >= 10) c10++; if (s >= 15) c15++; }
      const okA = uA === 0 && c10 >= 5, okB = !classic && uB === 0 && c15 >= 4;
      if (!okA && !okB) return;
      const which = okA && okB ? (final ? W_A : W_AB) : okA ? W_A : W_B;
      // the second free book of the last round: score each option without recursing
      const fast = depth === 1 && final && !track && lastCb;
      let sNo = 0, n15 = 0, m20 = 0, l20 = 0, q = false;
      if (fast) {
        for (let i = 0; i < ROWS; i++) {
          const a = SCORE[SEQ][rows[i]], m = SCORE[MAT][rows[ROWS + i]], l = SCORE[LAD][rows[2 * ROWS + i]];
          sNo += a + m + l;
          if (a >= 15) n15++; if (m >= 20) { m20++; q = true; } if (l >= 20) l20++;
        }
      }
      for (let wi = 0; wi < which.length; wi++) {
        const w = which[wi];
        const otherUsed = w === 'A' ? uB : uA;
        // can the other free book still follow? (a non-scoring digit unlocks nothing)
        const otherReady = w === 'A' ? (!classic && uB === 0 && c15 >= 4) : (uA === 0 && c10 >= 5);
        const nCats = otherUsed === 2 ? 1 : 3;
        for (let c = 0; c < nCats; c++) {
          for (let i = 0; i < ROWS; i++) {
            const idx = c * ROWS + i, old = rows[idx];
            if (onlyIdx >= 0 && idx !== onlyIdx) continue;
            if (FILLED[old] === 4) continue;
            // identical rows: only try the first one
            let dup = false;
            for (let j = 0; j < i; j++) if (rows[c * ROWS + j] === old) { dup = true; break; }
            if (dup) continue;
            const L = getExt(c, old);
            const singles = !final || (depth === 0 && otherReady) ? (leanFree ? L.singlesLean : L.singles) : (leanFree ? L.singlesImprovingLean : L.singlesImproving);
            if (fast) {
              const full = c === SEQ ? 15 : 20, wasFull = SCORE[c][old] >= full;
              for (const e of singles) {
                const d = e.cells[0][1];
                let key;
                if (bk[d] > 0) key = missKey();
                else if (missN < wild) { miss[d]++; key = missKey(); miss[d]--; }
                else continue;
                const nowFull = !wasFull && SCORE[c][e.code] >= full;
                const a = n15 + (nowFull && c === SEQ ? 1 : 0), m = m20 + (nowFull && c === MAT ? 1 : 0), l = l20 + (nowFull && c === LAD ? 1 : 0);
                const b3 = a >= 5 || (!classic && (m === ROWS || l === ROWS));
                lastCb(key, sNo + e.gain + (b3 ? 5 : 0), q || (c === MAT && nowFull));
              }
              continue;
            }
            for (const e of singles) {
              const d = e.cells[0][1];
              // one digit: from the bank, else a wildcard
              let fromBank;
              if (bk[d] > 0) { bk[d]--; fromBank = true; }
              else if (missN < wild) { miss[d]++; missN++; fromBank = false; }
              else continue;
              rows[idx] = e.code;
              if (track) placements.push({ cat: c, row: i, col: e.cells[0][0], digit: d, bonus: w });
              const nuA = w === 'A' ? (c === SEQ ? 1 : 2) : uA, nuB = w === 'B' ? (c === SEQ ? 1 : 2) : uB;
              const scoring = e.gain > 0;
              if (!final || scoring) cb(rows, bk, nuA, nuB, nMain, placements, missKey());
              tryBonus(nuA, nuB, nMain, depth + 1, final && !scoring ? idx : -1);
              if (track) placements.pop();
              rows[idx] = old;
              if (fromBank) bk[d]++; else { miss[d]--; missN--; }
            }
          }
        }
      }
    }

    // Identical rows are filled in order: a later copy may only take an option at or
    // after the previous copy's, and "nothing" (NONE) counts as the last option, so
    // the upper of two identical rows is the one that gets booked.
    const NONE = 1 << 30;
    // unlockOnly: can the rows still reach an unlock with `budget` digits from row i on?
    const canUnlock = (i, budget) => {
      if (st.usedA === 0) {
        let ok = true, need = 0;
        for (let j = 0; j < ROWS && ok; j++) {
          const n = needTo(rows[base + j], 10);
          if (j < i) { if (n > 0) ok = false; } else need += n;
        }
        if (ok && need <= budget) return true;
      }
      if (!classic && st.usedB === 0) {
        let have = 0;
        const needs = [];
        for (let j = 0; j < ROWS; j++) {
          const n = needTo(rows[base + j], 15);
          if (n === 0) have++; else if (j >= i) needs.push(n);
        }
        needs.sort((x, y) => x - y);
        let left = budget;
        for (const n of needs) { if (have >= 4 || n > left) break; left -= n; have++; }
        if (have >= 4) return true;
      }
      return false;
    };
    (function rec(i, budget, nMain, setups) {
      if (i === ROWS) { bonusPhase(nMain, setups); return; }
      if (unlockOnly && !canUnlock(i, budget)) return;
      const idx = base + i, old = rows[idx];
      const same = i > 0 && st.rows[idx] === st.rows[idx - 1];
      const minChoice = same ? choice[i - 1] : 0;
      choice[i] = NONE; rec(i + 1, budget, nMain, setups);
      if (minChoice === NONE) return;
      const L = exts[i];
      for (let e = minChoice; e < L.length; e++) {
        const x = L[e];
        if (x.n > budget) break;               // sorted by n
        // last round: each non-scoring set-up needs its own free book to finish it
        const setup = final && x.gain <= 0 ? 1 : 0;
        if (setups + setup > nFree && setup) continue;
        const need = x.need;
        let used;
        if (!wild) {
          let ok = true;
          for (let d = 0; d < 10; d++) if (need[d] > bk[d]) { ok = false; break; }
          if (!ok) continue;
          for (let d = 0; d < 10; d++) bk[d] -= need[d];
        } else if (!take(need, i)) continue;
        rows[idx] = x.code; choice[i] = e;
        if (track) for (const [p, d] of x.cells) placements.push({ cat, row: i, col: p, digit: d, bonus: null });
        rec(i + 1, budget - x.n, nMain + x.n, setups + setup);
        if (track) placements.length -= x.n;
        rows[idx] = old;
        if (!wild) for (let d = 0; d < 10; d++) bk[d] += need[d];
        else give(need, i);
      }
      choice[i] = NONE;
    })(0, maxBook, 0, 0);
  };
  // How many Bonus II free books could be used this round (upper bound): each one is
  // either unlocked and unused, or could be unlocked with the digits that can still go
  // into Sequence (`seqBooks` main books, plus the other free book).
  function freeBooksPossible(rows, usedA, usedB, classic, seqBooks) {
    const need = (target, k) => {
      const a = [];
      for (let i = 0; i < ROWS; i++) a.push(needTo(rows[i], target));
      a.sort((x, y) => x - y);
      let t = 0; for (let i = 0; i < k; i++) t += a[i];
      return t;
    };
    const nA = usedA === 0 ? need(10, 5) : 99, nB = !classic && usedB === 0 ? need(15, 4) : 99;
    let a = nA <= seqBooks, b = nB <= seqBooks;
    for (let it = 0; it < 2; it++) { a = a || nA <= seqBooks + (b ? 1 : 0); b = b || nB <= seqBooks + (a ? 1 : 0); }
    return (a ? 1 : 0) + (b ? 1 : 0);
  }
  // Last-round extension list when k free books may follow: scoring extensions, plus
  // set-ups that k more single digits could turn into a score.
  function finishable(cat, L, k) {
    const name = 'fin' + k;
    if (L[name]) return L[name];
    const out = L.filter(e => {
      if (e.gain > 0) return true;
      const base = SCORE[cat][e.code];
      for (const f of getExt(cat, e.code)) { if (f.n > k) break; if (SCORE[cat][f.code] > base) return true; }
      return false;
    });
    L[name] = out;
    return out;
  }

  // ---------- fast final round ----------
  // In the last round a booking works for roll R iff the digits it needs beyond the
  // bank (its "missing" multiset, at most 3) are contained in R. So per category we
  // enumerate scoring bookings once, with up to 3 wildcard digits, and keep the best
  // gain per missing multiset; each roll then checks its <= 8 sub-multisets.
  // Tables depend only on that category's rows, the relevant bank digits and whether
  // Bonus III is already earned, so they are shared across many positions.
  const MISS_N = 1331;                         // sorted up to 3 digits, 10 = none
  const missCode = (a, b, c) => (a * 11 + b) * 11 + c;
  const ROLL_SUBSETS = ROLLS.map(r => {
    const [a, b, c] = r.digits, set = new Set();
    const subs = [[], [a], [b], [c], [a, b], [a, c], [b, c], [a, b, c]];
    for (const s of subs) { const t = s.slice().sort((x, y) => x - y); while (t.length < 3) t.push(E); set.add(missCode(t[0], t[1], t[2])); }
    return Int16Array.from(set);
  });
  // the other way round: for each missing multiset, the rolls that contain it
  const ROLLS_WITH = (() => {
    const lists = Array.from({ length: MISS_N }, () => []);
    ROLL_SUBSETS.forEach((subs, r) => { for (const m of subs) lists[m].push(r); });
    return lists.map(l => Int16Array.from(l));
  })();
  // per row code: max copies of each digit any scoring extension needs
  const MAXNEED = [new Map(), new Map(), new Map()];
  function maxNeed(cat, code) {
    let m = MAXNEED[cat].get(code);
    if (m) return m;
    m = new Int8Array(10);
    for (const e of getExt(cat, code).improving) for (let d = 0; d < 10; d++) if (e.need[d] > m[d]) m[d] = e.need[d];
    MAXNEED[cat].set(code, m);
    return m;
  }

  // Shared per-category table. Returns null if (Sequence only) some booking could
  // unlock a Bonus II free book this round, in which case the caller must use the
  // whole-position table instead.
  const GMAX = 128;
  Solver.prototype.finalTable = function (st, cat, bonus3Before, budgetOverride, ignoreUnlock) {
    const rows = st.rows, base = cat * ROWS;
    const rc = [];
    for (let i = 0; i < ROWS; i++) rc.push(rows[base + i]);
    let n10 = 0, n15 = 0;
    for (let i = 0; i < ROWS; i++) { const s = SCORE[SEQ][rows[i]]; if (s >= 10) n10++; if (s >= 15) n15++; }
    const budget = budgetOverride || (cat === SEQ && n10 >= 1 ? 4 : 3);
    const cap = new Int8Array(10);
    for (let i = 0; i < ROWS; i++) { const m = maxNeed(cat, rc[i]); for (let d = 0; d < 10; d++) cap[d] += m[d]; }
    const bank = new Int8Array(10);
    for (let d = 0; d < 10; d++) bank[d] = Math.min(st.bank[d], cap[d], budget);
    const watchA = !ignoreUnlock && cat === SEQ && st.usedA === 0, watchB = !ignoreUnlock && cat === SEQ && !this.classic && st.usedB === 0;
    const CN = CLASS[cat];
    const sorted = rc.map(c => CN[c]).sort((a, b) => a - b);
    const key = String.fromCharCode(cat, budget, (bonus3Before ? 1 : 0) + (watchA ? 2 : 0) + (watchB ? 4 : 0), ...sorted, ...bank);
    let tab = this.tables.get(key);
    if (tab !== undefined) return tab;
    tab = this.buildTable(cat, rc, budget, bank, bonus3Before, watchA, watchB);
    // Bound memory: tables are only a cache, so drop them all when there are too many.
    if (this.tables.size >= this.maxTables) this.tables.clear();
    this.tables.set(key, tab);
    return tab;
  };

  // Best gain per missing multiset for main bookings in `cat` alone (no free books),
  // cached like finalTable.
  Solver.prototype.plainGains = function (st, cat, bonus3Before) {
    const rows = st.rows, base = cat * ROWS, rc = [];
    for (let i = 0; i < ROWS; i++) rc.push(rows[base + i]);
    const [n10] = seqCounts(rows);
    const budget = cat === SEQ && n10 >= 1 ? 4 : 3;
    const bank = new Int8Array(10);
    for (let i = 0; i < ROWS; i++) { const m = maxNeed(cat, rc[i]); for (let d = 0; d < 10; d++) bank[d] += m[d]; }
    for (let d = 0; d < 10; d++) bank[d] = Math.min(st.bank[d], bank[d], budget);
    const CN = CLASS[cat];
    const sorted = rc.map(c => CN[c]).sort((a, b) => a - b);
    const key = String.fromCharCode(cat, budget, bonus3Before ? 1 : 0, ...sorted, ...bank);
    if (!this.gainTables) this.gainTables = new Map();
    let g = this.gainTables.get(key);
    if (g === undefined) {
      this.buildTable(cat, rc, budget, bank, bonus3Before, false, false);
      g = TB_bestGain.slice();
      if (this.gainTables.size >= this.maxTables) this.gainTables.clear();
      this.gainTables.set(key, g);
    }
    return g;
  };

  // Build one final-round table: rows `rc` (5 codes) of category `cat`, booking limit
  // `budget`, bank already capped. Returns null if a booking could unlock a free book
  // (only checked for the flags given). Allocation-free inner loop.
  const TB_bestGain = new Int16Array(MISS_N), TB_bestQuad = new Int16Array(MISS_N);
  const TB_miss = new Int8Array(10), TB_bk = new Int8Array(10), TB_cur = new Int32Array(ROWS), TB_choice = new Int32Array(ROWS);
  const TB_save = new Int8Array((ROWS + 1) * 10);
  const TB_W = new Int32Array(GMAX + 1), TB_WG = new Int32Array(GMAX + 1), TB_QE = new Int32Array(GMAX + 1), TB_QA = new Int32Array(GMAX + 1);
  const TB_LG = new Int32Array(GMAX + 1), TB_LQ = new Int32Array(GMAX + 1);
  Solver.prototype.buildTable = function (cat, rc, budget, bank, bonus3Before, watchA, watchB) {
    this.tablesBuilt++;
    const bestGain = TB_bestGain.fill(-1), bestQuad = TB_bestQuad.fill(-1);
    const fullScore = cat === SEQ ? 15 : 20;
    const bonus3Possible = !bonus3Before && (cat === SEQ || !this.classic);
    const miss = TB_miss.fill(0), bk = TB_bk, cur = TB_cur, choice = TB_choice, save = TB_save;
    for (let d = 0; d < 10; d++) bk[d] = bank[d];
    for (let i = 0; i < ROWS; i++) { cur[i] = rc[i]; choice[i] = -1; }
    const exts = [];
    for (let i = 0; i < ROWS; i++) { const X = getExt(cat, rc[i]); exts.push(this.dominance ? X.improvingLean : X.improving); }
    const SC = SCORE[cat];
    let unlock = false;
    const rec = (i, budgetLeft, missN, gain) => {
      if (unlock) return;
      if (i === ROWS) {
        let g = gain;
        if (bonus3Possible) { let f = 0; for (let j = 0; j < ROWS; j++) if (SC[cur[j]] >= fullScore) f++; if (f === ROWS) g += 5; }
        if (watchA || watchB) {
          let a = 0, b = 0;
          for (let j = 0; j < ROWS; j++) { const sc = SCORE[SEQ][cur[j]]; if (sc >= 10) a++; if (sc >= 15) b++; }
          if ((watchA && a >= 5) || (watchB && b >= 4)) { unlock = true; return; }
        }
        let quad = false;
        if (cat === MAT) for (let j = 0; j < ROWS; j++) if (FILLED[cur[j]] === 4) { quad = true; break; }
        let m = 0, k = 0;
        for (let d = 0; d < 10; d++) for (let c = 0; c < miss[d]; c++) { m = m * 11 + d; k++; }
        for (; k < 3; k++) m = m * 11 + E;
        if (g > bestGain[m]) bestGain[m] = g;
        if (quad && g > bestQuad[m]) bestQuad[m] = g;
        return;
      }
      const same = i > 0 && rc[i] === rc[i - 1];
      const minChoice = same ? choice[i - 1] : -1;
      if (minChoice === -1) { choice[i] = -1; rec(i + 1, budgetLeft, missN, gain); }
      const L = exts[i];
      const sv = i * 10;
      for (let e = Math.max(0, minChoice); e < L.length; e++) {
        const x = L[e];
        if (x.n > budgetLeft) break;
        const need = x.need;
        let add = 0;
        for (let d = 0; d < 10; d++) if (need[d] > bk[d]) add += need[d] - bk[d];
        if (missN + add > 3) continue;
        for (let d = 0; d < 10; d++) {
          const b = bk[d]; save[sv + d] = b;
          if (need[d] > b) { miss[d] += need[d] - b; bk[d] = 0; } else bk[d] = b - need[d];
        }
        cur[i] = x.code; choice[i] = e;
        rec(i + 1, budgetLeft - x.n, missN + add, gain + x.gain);
        cur[i] = rc[i];
        for (let d = 0; d < 10; d++) { const b = save[sv + d]; if (need[d] > b) miss[d] -= need[d] - b; bk[d] = b; }
      }
      choice[i] = -1;
    };
    rec(0, budget, 0, 0);
    if (unlock) return null;
    return packTable(bestGain, bestQuad);
  };
  // Per-roll results bucketed by gain, then suffix sums so that a position with
  // base score S0 is evaluated in O(1): wins are rolls with gain >= 100 - S0.
  function packTable(bestGain, bestQuad) {
    const W = TB_W.fill(0), WG = TB_WG.fill(0), QE = TB_QE.fill(0), QA = TB_QA.fill(0), LG = TB_LG.fill(0), LQ = TB_LQ.fill(0);
    for (let r = 0; r < ROLLS.length; r++) {
      const subs = ROLL_SUBSETS[r];
      let G = -1, GQ = -1;
      for (let k = 0; k < subs.length; k++) {
        const m = subs[k];
        if (bestGain[m] > G) G = bestGain[m];
        if (bestQuad[m] > GQ) GQ = bestQuad[m];
      }
      const wt = ROLLS[r].w;
      W[G] += wt; WG[G] += wt * G;
      if (GQ === G) QE[G] += wt;
      if (GQ >= 0) QA[G] += wt;
      // if this roll loses: Quad first, then the most points (with or without a Quad already)
      LG[G] += wt * G; LQ[G] += wt * (GQ >= 0 ? GQ : G);
    }
    // One packed array: [sufW | sufWG | sufQE | preQA | preLG | preLQ], each GMAX+2 long.
    const L = GMAX + 2;
    const tab = new Int32Array(6 * L);
    for (let g = GMAX; g >= 0; g--) { tab[g] = tab[g + 1] + W[g]; tab[L + g] = tab[L + g + 1] + WG[g]; tab[2 * L + g] = tab[2 * L + g + 1] + QE[g]; }
    for (let g = 0; g <= GMAX; g++) {
      tab[3 * L + g + 1] = tab[3 * L + g] + QA[g];
      tab[4 * L + g + 1] = tab[4 * L + g] + LG[g];
      tab[5 * L + g + 1] = tab[5 * L + g] + LQ[g];
    }
    return tab;
  }

  // The same table from a list of every scoring booking of these rows (made once per
  // row set, ignoring the bank): a booking counts for a bank if it is short of at most
  // three digits. Much faster when one row set meets many banks, as in a round-9
  // search where the same booked rows come up under every roll.
  Solver.prototype.bookingList = function (cat, rc, budget, bonus3Before, watchA, watchB) {
    const fullScore = cat === SEQ ? 15 : 20;
    const bonus3Possible = !bonus3Before && (cat === SEQ || !this.classic);
    const SC = SCORE[cat];
    const cur = Int32Array.from(rc), choice = new Int32Array(ROWS).fill(-1), need = new Int8Array(10);
    const exts = [];
    for (let i = 0; i < ROWS; i++) { const X = getExt(cat, rc[i]); exts.push(this.dominance ? X.improvingLean : X.improving); }
    const needs = [], gains = [], flags = [];
    const rec = (i, budgetLeft, gain) => {
      if (i === ROWS) {
        let g = gain, f = 0;
        if (bonus3Possible) { let k = 0; for (let j = 0; j < ROWS; j++) if (SC[cur[j]] >= fullScore) k++; if (k === ROWS) g += 5; }
        if (watchA || watchB) {
          let a = 0, b = 0;
          for (let j = 0; j < ROWS; j++) { const sc = SCORE[SEQ][cur[j]]; if (sc >= 10) a++; if (sc >= 15) b++; }
          if ((watchA && a >= 5) || (watchB && b >= 4)) f |= 2;
        }
        if (cat === MAT) for (let j = 0; j < ROWS; j++) if (FILLED[cur[j]] === 4) { f |= 1; break; }
        for (let d = 0; d < 10; d++) needs.push(need[d]);
        gains.push(g); flags.push(f);
        return;
      }
      const same = i > 0 && rc[i] === rc[i - 1];
      const minChoice = same ? choice[i - 1] : -1;
      if (minChoice === -1) { choice[i] = -1; rec(i + 1, budgetLeft, gain); }
      const L = exts[i];
      for (let e = Math.max(0, minChoice); e < L.length; e++) {
        const x = L[e];
        if (x.n > budgetLeft) break;
        for (let d = 0; d < 10; d++) need[d] += x.need[d];
        cur[i] = x.code; choice[i] = e;
        rec(i + 1, budgetLeft - x.n, gain + x.gain);
        cur[i] = rc[i];
        for (let d = 0; d < 10; d++) need[d] -= x.need[d];
      }
      choice[i] = -1;
    };
    rec(0, budget, 0);
    let gmax = 0, anyQuad = 0;
    for (let i = 0; i < gains.length; i++) { if (gains[i] > gmax) gmax = gains[i]; anyQuad |= flags[i] & 1; }
    return { n: gains.length, needs: Int8Array.from(needs), gains: Int16Array.from(gains), flags: Uint8Array.from(flags), gmax, anyQuad };
  };
  // does any booking in the list unlock a free book? (then no skipping: the caller must see null)
  function hasUnlock(q) { if (q.unl === undefined) { q.unl = false; for (let i = 0; i < q.n; i++) if (q.flags[i] & 2) { q.unl = true; break; } } return q.unl; }
  // Fill TB_bestGain / TB_bestQuad from a booking list; false if a free book could be unlocked.
  const GL_used = new Int16Array(MISS_N + 1);   // missing codes set by the last gainsFromList (count first)
  function gainsFromList(q, bank) {
    const bestGain = TB_bestGain.fill(-1), bestQuad = TB_bestQuad.fill(-1);
    const { needs, gains, flags } = q;
    let nUsed = 0;
    for (let i = 0, o = 0; i < q.n; i++, o += 10) {
      let short = 0;
      for (let d = 0; d < 10; d++) { const x = needs[o + d] - bank[d]; if (x > 0) short += x; }
      if (short > 3) continue;
      if (flags[i] & 2) return false;
      let m = 0, k = 0;
      for (let d = 0; d < 10; d++) for (let x = needs[o + d] - bank[d]; x > 0; x--) { m = m * 11 + d; k++; }
      for (; k < 3; k++) m = m * 11 + E;
      const g = gains[i];
      if (bestGain[m] < 0) GL_used[++nUsed] = m;
      if (g > bestGain[m]) bestGain[m] = g;
      if ((flags[i] & 1) && g > bestQuad[m]) bestQuad[m] = g;
    }
    GL_used[0] = nUsed;
    return true;
  }
  const VL_G = new Int16Array(ROLLS.length), VL_GQ = new Int16Array(ROLLS.length);
  // The category's value at base score S0 straight from a booking list (no table kept),
  // written into v as [win, pointsIfWin, quad, pointsIfLose]; false if a free book could
  // be unlocked.
  function valueFromList(q, bank, S0, q0, v) {
    if (!gainsFromList(q, bank)) return false;
    const bestGain = TB_bestGain, bestQuad = TB_bestQuad;
    // best gain per roll, pushed from the few missing multisets that occur
    const Gr = VL_G.fill(-1), GQr = VL_GQ.fill(-1);
    for (let u = 1; u <= GL_used[0]; u++) {
      const m = GL_used[u], g = bestGain[m], gq = bestQuad[m], rl = ROLLS_WITH[m];
      for (let k = 0; k < rl.length; k++) { const r = rl[k]; if (g > Gr[r]) Gr[r] = g; if (gq > GQr[r]) GQr[r] = gq; }
    }
    let w = 0, p = 0, qq = 0, l = 0;
    for (let r = 0; r < ROLLS.length; r++) {
      const G = Gr[r], GQ = GQr[r];
      const wt = ROLLS[r].w;
      if (S0 + G >= 100) { w += wt; p += wt * (S0 + G); if (q0 || GQ === G) qq += wt; }
      else { if (q0 || GQ >= 0) qq += wt; l += wt * (S0 + (q0 || GQ < 0 ? G : GQ)); }
    }
    v[0] = w; v[1] = p; v[2] = qq; v[3] = l;
    return true;
  }
  Solver.prototype.tableFromList = function (q, bank) {
    this.tablesBuilt++;
    const bestGain = TB_bestGain.fill(-1), bestQuad = TB_bestQuad.fill(-1);
    const { needs, gains, flags } = q;
    for (let i = 0, o = 0; i < q.n; i++, o += 10) {
      let short = 0;
      for (let d = 0; d < 10; d++) { const x = needs[o + d] - bank[d]; if (x > 0) short += x; }
      if (short > 3) continue;
      if (flags[i] & 2) return null;          // a free book could be unlocked
      let m = 0, k = 0;
      for (let d = 0; d < 10; d++) for (let x = needs[o + d] - bank[d]; x > 0; x--) { m = m * 11 + d; k++; }
      for (; k < 3; k++) m = m * 11 + E;
      const g = gains[i];
      if (g > bestGain[m]) bestGain[m] = g;
      if ((flags[i] & 1) && g > bestQuad[m]) bestQuad[m] = g;
    }
    return packTable(bestGain, bestQuad);
  };

  // Can a Bonus II free book possibly be used this round when choosing `cat`?
  // (If so the category's table is built from the whole position, free books included.)
  function bonusMaybeUsable(st, classic, cat) {
    const rows = st.rows;
    const needA = st.usedA === 0, needB = !classic && st.usedB === 0;
    if (!needA && !needB) return false;
    const [a10, a15] = seqCounts(rows);
    if ((needA && a10 >= 5) || (needB && a15 >= 4)) return true;   // already unlocked
    return false;   // unlocking during this round is detected inside finalTable
  }

  // A category table at base score S0 (q0: a Quad is already there) ->
  // [win, pointsIfWin, quad, pointsIfLose] over the 220 rolls.
  function evalTab(tab, S0, q0) {
    const t = Math.max(0, Math.min(GMAX + 1, 100 - S0)), L = GMAX + 2, w = tab[t];
    return [w, S0 * w + tab[L + t], q0 ? 1000 : tab[2 * L + t] + tab[3 * L + t], S0 * (1000 - w) + tab[(q0 ? 4 : 5) * L + t]];
  }
  // Whole-position table (used when a free book may be in play): best encoded
  // terminal value per missing multiset. Encoding keeps lexicographic order.
  // win: 1000 + 2*score + quad; loss: 200*quad + score (score < 100)
  const encV = (win, s, q) => (win ? 1000 + 2 * s + q : 200 * q + s);
  // The result only depends on part of the position, so it is cached by that part:
  //  - the booked category and Sequence (free books can add two digits there, and
  //    unlock each other) in full;
  //  - any other category gets at most one free digit (a second free book must go into
  //    Sequence if the first did not), so only its rows that one digit can improve
  //    matter, plus how many rows are full (Bonus III) and whether it has a Quad.
  // Results are stored relative to the current score, which makes them shareable:
  // gq[m] = best 2*gain + quad, lq[m] = best 200*quad + gain, for missing multiset m.
  Solver.prototype.fullFinalTable = function (st, cat) {
    const classic = this.classic, rows = st.rows;
    const parts = [cat, st.usedA * 3 + st.usedB];
    for (let c = 0; c < 3; c++) {
      const CN = CLASS[c];
      const t = [];
      if (c === cat || c === SEQ) {
        for (let i = 0; i < ROWS; i++) t.push(CN[rows[c * ROWS + i]]);
      } else {
        let full = 0, quad = 0;
        for (let i = 0; i < ROWS; i++) {
          const code = rows[c * ROWS + i];
          if (SCORE[c][code] >= 20) { full++; if (c === MAT) quad = 1; }
          if (bestSingleGain(c, code) > 0) t.push(CN[code]);
        }
        parts.push(100 + full * 2 + quad);
      }
      t.sort((a, b) => a - b);
      parts.push(t.length, ...t);
    }
    for (let d = 0; d < 10; d++) parts.push(Math.min(st.bank[d], 6));
    const key = String.fromCharCode(...parts);
    if (!this.fullCache) this.fullCache = new Map();
    let ent = this.fullCache.get(key);
    const S0 = terminalScore(rows, classic);
    if (ent === undefined) {
      this.fullTablesBuilt++;
      const gq = new Int16Array(MISS_N).fill(-1), lq = new Int16Array(MISS_N).fill(-1);
      const q0 = hasQuad(rows) ? 1 : 0;
      // Sequence with no free book at hand yet: bookings that unlock none are covered by
      // the plain table (also a lower bound for those that do), so only the unlocking
      // ones need the slow whole-position search.
      let unlockOnly = false;
      if (cat === SEQ) {
        const [n10, n15] = seqCounts(rows);
        const freeNow = (st.usedA === 0 && n10 >= 5) || (!classic && st.usedB === 0 && n15 >= 4);
        if (!freeNow) {
          unlockOnly = true;
          const g = this.plainGains(st, SEQ, bonus3Of(rows, classic));
          for (let m = 0; m < MISS_N; m++) if (g[m] >= 0) { gq[m] = 2 * g[m] + q0; lq[m] = 200 * q0 + g[m]; }
        }
      }
      const rec = (m, s, q) => {
        const v = 2 * (s - S0) + q, u = 200 * q + (s - S0);
        if (v > gq[m]) gq[m] = v;
        if (u > lq[m]) lq[m] = u;
      };
      this.forEachBooking(st, cat, st.bank, true, false,
        (r, bk, uA, uB, n, pl, m) => rec(m, terminalScore(r, classic), hasQuad(r) ? 1 : 0), 3,
        (m, s, q) => rec(m, s, q ? 1 : 0), unlockOnly);
      ent = { gq, lq };
      if (this.fullCache.size >= (this.maxTables >> 2)) this.fullCache.clear();
      this.fullCache.set(key, ent);
    }
    const best = new Int16Array(MISS_N).fill(-1);
    const { gq, lq } = ent;
    for (let m = 0; m < MISS_N; m++) {
      if (gq[m] < 0) continue;
      if (S0 + (gq[m] >> 1) >= 100) best[m] = 1000 + 2 * S0 + gq[m];
      else { const q = lq[m] >= 200 ? 1 : 0; best[m] = 200 * q + S0 + lq[m] - 200 * q; }
    }
    return best;
  };

  // Sum a whole-position table over the 220 rolls into [win, pointsIfWin, quad, pointsIfLose].
  function aggregateFull(full) {
    let w = 0, p = 0, q = 0, l = 0;
    for (let r = 0; r < ROLLS.length; r++) {
      const subs = ROLL_SUBSETS[r];
      let V = -1;
      for (let k = 0; k < subs.length; k++) if (full[subs[k]] > V) V = full[subs[k]];
      const wt = ROLLS[r].w;
      if (V >= 1000) { w += wt; p += wt * ((V - 1000) >> 1); q += wt * (V & 1); }
      else { const qq = V >= 200 ? 1 : 0; q += wt * qq; l += wt * (V - 200 * qq); }
    }
    return [w, p, q, l];
  }

  Solver.prototype.finalValue = function (st) {
    const vs = this.finalCategoryValues(st);
    let best = vs[0];
    for (let c = 1; c < 3; c++) if (cmp(vs[c], best) > 0) best = vs[c];
    return best;
  };
  // Start of round 10: value of each category.
  Solver.prototype.finalCategoryValues = function (st) {
    const rows = st.rows;
    const S0 = terminalScore(rows, this.classic);
    const q0 = hasQuad(rows);
    // Bonus III already earned?
    let n15 = 0, m20 = 0, l20 = 0;
    for (let i = 0; i < ROWS; i++) {
      if (SCORE[SEQ][rows[i]] >= 15) n15++;
      if (SCORE[MAT][rows[ROWS + i]] >= 20) m20++;
      if (SCORE[LAD][rows[2 * ROWS + i]] >= 20) l20++;
    }
    const b3 = n15 >= 5 || (!this.classic && (m20 === ROWS || l20 === ROWS));
    const out = [];
    for (let cat = 0; cat < 3; cat++) {
      const tab = bonusMaybeUsable(st, this.classic, cat) ? null : this.finalTable(st, cat, b3);
      if (tab) {
        out.push(evalTab(tab, S0, q0));
      } else {
        this.fullTablesBuilt++;
        out.push(aggregateFull(this.fullFinalTable(st, cat)));
      }
    }
    return out;
  };
  // Tie-break data for a booking made before round 10: the next round's second-best
  // and worst categories, as [win, points-if-win sum, win, points-if-win sum].
  // (Categories equal on win and points if win give the same entries whichever is
  // ranked first, so display-mode values are enough.)
  Solver.prototype.altValues = function (st, roundsLeft) {
    const vs = roundsLeft === 1 && this.fastFinal ? this.finalCategoryValues(st)
      : [0, 1, 2].map(c => this.categoryValue(st, c, roundsLeft));
    vs.sort((a, b) => cmp3(b, a));
    return [vs[1][0], vs[1][1], vs[2][0], vs[2][1]];
  };

  // Value of a position at the START of a round with `roundsLeft` rounds to play.
  Solver.prototype.value = function (st, roundsLeft) {
    if (roundsLeft === 0) return this.terminal(st.rows);
    if (roundsLeft === 1 && this.fastFinal) {
      const key = this.key(st.rows, st.bank, st.usedA, st.usedB, 1);
      const hit = this.memo[1].get(key);
      if (hit) return hit;
      this.nodes++;
      const v = this.finalValue(st);
      if (this.memo[1].size >= this.maxMemo) this.memo[1].clear();
      this.memo[1].set(key, v);
      return v;
    }
    return this.genericValue(st, roundsLeft);
  };

  // ---------- pruned search with two rounds left ----------
  // For a fixed round-9 category and roll, every booking draws on the same digits B
  // (bank + roll), which gives one shared upper bound on each booking's round-10 value:
  //  - round-10 category other than round 9's: those rows are untouched and the
  //    booking's bank is a subset of B, so its value is at most that of B (one table);
  //  - same category: booking P now and Q in round 10 ends where booking P and Q
  //    together in round 10 would, so it is at most the original rows with B and a
  //    booking limit |P| higher (one table per |P|).
  // Lexicographic order is compatible with addition, so per-roll bounds add up.
  // Bookings are evaluated in order of their bound until the next bound cannot beat
  // the best found. Free books (Bonus II) break the argument, so a booking that uses
  // one, or after which one is unlocked and unused, or could be unlocked in round 10
  // (the tables detect that and return no bound), is always evaluated exactly.

  const bonus3Of = (rows, classic) => {
    let n15 = 0, m20 = 0, l20 = 0;
    for (let i = 0; i < ROWS; i++) {
      if (SCORE[SEQ][rows[i]] >= 15) n15++;
      if (SCORE[MAT][rows[ROWS + i]] >= 20) m20++;
      if (SCORE[LAD][rows[2 * ROWS + i]] >= 20) l20++;
    }
    return n15 >= 5 || (!classic && (m20 === ROWS || l20 === ROWS));
  };
  // best single-digit gain of a row (what one free book could add there)
  const SINGLE = [new Map(), new Map(), new Map()];
  function bestSingleGain(cat, code) {
    let g = SINGLE[cat].get(code);
    if (g === undefined) { g = 0; for (const e of getExt(cat, code).singlesImproving) if (e.gain > g) g = e.gain; SINGLE[cat].set(code, g); }
    return g;
  }
  // Upper bound on what up to two free books could add outside category `cat`.
  function freeExtra(rows, cat, b3) {
    let g1 = 0, g2 = 0, pair = 0, quadNear = false;
    for (let c = 0; c < 3; c++) {
      if (c === cat) continue;
      for (let i = 0; i < ROWS; i++) {
        const code = rows[c * ROWS + i], g = bestSingleGain(c, code);
        if (g > g1) { g2 = g1; g1 = g; } else if (g > g2) g2 = g;
        // both free digits in one row (e.g. 1__4 -> 1234) can beat two single gains
        for (const e of getExt(c, code).improving) { if (e.n > 2) break; if (e.gain > pair) pair = e.gain; }
        if (c === MAT && FILLED[code] >= 2 && FILLED[code] < 4) quadNear = true;
      }
    }
    return { extra: Math.max(g1 + g2, pair) + (b3 ? 0 : 5), quadNear };
  }
  Solver.prototype.bestAfterRollPruned = function (st, c9, bank) {
    const classic = this.classic;
    const base = { rows: st.rows, bank, usedA: st.usedA, usedB: st.usedB };
    const b3s = bonus3Of(st.rows, classic);
    const limit = c9 === SEQ ? 4 : 3;
    const sameTab = [], sameTabFree = [];
    const kids = [];
    this.forEachBooking(st, c9, bank, false, false, (rows, bk, uA, uB, nMain) => {
      const kid = { rows: Int16Array.from(rows), bank: Int8Array.from(bk), uA, uB };
      const S0t = terminalScore(rows, classic), q0t = hasQuad(rows), b3t = bonus3Of(rows, classic);
      const [a10, a15] = seqCounts(rows);
      const freeNow = (uA === 0 && a10 >= 5) || (!classic && uB === 0 && a15 >= 4);
      const tstate = { rows: kid.rows, bank: kid.bank, usedA: uA, usedB: uB };
      // other round-10 categories: exact when no free book can be involved, else a bound
      let lo = null, hi = null, allExact = true;
      for (let c = 0; c < 3; c++) {
        if (c === c9) continue;
        const tab = freeNow ? null : this.finalTable(tstate, c, b3t);
        let v;
        if (tab) { v = evalTab(tab, S0t, q0t); if (lo === null || cmp(v, lo) > 0) lo = v; }
        else {
          allExact = false;
          const loose = this.finalTable(tstate, c, false, (c === SEQ ? 4 : 3) + 2, true);
          const fx = freeExtra(rows, c, b3t);
          v = evalTab(loose, S0t + fx.extra, q0t || fx.quadNear);
        }
        if (hi === null || cmp(v, hi) > 0) hi = v;
      }
      // same category as round 9: shared bound (book P now + Q later = P and Q later)
      let catT = 0, catS = 0;
      for (let i = 0; i < ROWS; i++) { catT += SCORE[c9][rows[c9 * ROWS + i]]; catS += SCORE[c9][st.rows[c9 * ROWS + i]]; }
      const S0x = S0t - catT + catS;
      let same = null;
      if (!freeNow) {
        if (sameTab[nMain] === undefined) sameTab[nMain] = this.finalTable(base, c9, b3s, limit + nMain);
        if (sameTab[nMain]) same = evalTab(sameTab[nMain], S0x, c9 === MAT ? hasQuad(st.rows) && q0t : q0t);
      }
      if (same === null) {
        if (sameTabFree[nMain] === undefined) sameTabFree[nMain] = this.finalTable(base, c9, false, limit + nMain + 2, true);
        const fx = freeExtra(rows, c9, b3t);
        same = evalTab(sameTabFree[nMain], S0x + fx.extra, q0t || fx.quadNear);
      }
      kid.lo = allExact ? lo : null;      // exact value of the other categories, if known
      kid.same = same;
      kid.ub = cmp(same, hi) > 0 ? same : hi;
      kids.push(kid);
    });
    kids.sort((a, b) => cmp(b.ub, a.ub));
    let best = null;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i];
      if (best !== null && cmp(k.ub, best) <= 0) { this.pruned += kids.length - i; break; }
      // only the other categories can beat the best: their exact value settles it
      if (k.lo !== null && best !== null && cmp(k.same, best) <= 0 && cmp(k.same, k.lo) <= 0) {
        this.cheap++;
        if (cmp(k.lo, best) > 0) best = k.lo;
        continue;
      }
      this.evaluated++;
      const v = this.value(makeState(k.rows, k.bank, k.uA, k.uB), 1);
      if (best === null || cmp(v, best) > 0) best = v;
    }
    return best;
  };

  // ---------- fast path, two rounds left ----------
  // Round 9 bookings are evaluated in place (no copies, no position cache). Final-round
  // tables are cached in two levels: by the category's rows (built once per row set;
  // for categories other than the booked one, the same for every booking) and then by
  // the relevant bank digits packed into one number.
  const POW5 = [1, 5, 25, 125, 625, 3125, 15625, 78125, 390625, 1953125];
  const FT_bank = new Int8Array(10);
  // With S0, q0 and vout given, a row set seen with many banks is evaluated straight
  // into vout (returns DIRECT) instead of building and keeping a table.
  const DIRECT = new Int32Array(0), SKIP = new Int32Array(0);
  // alpha (optional): a value this category need not beat. If even its best possible
  // outcome (every roll getting the row set's biggest gain) cannot beat it, return SKIP.
  Solver.prototype.fastTable = function (c, rows, bk, uA, uB, b3, n10, S0, q0, vout, alpha) {
    const base = c * ROWS;
    const budget = c === SEQ && n10 >= 1 ? 4 : 3;
    const watchA = c === SEQ && uA === 0, watchB = c === SEQ && !this.classic && uB === 0;
    // canonical rows, sorted (insertion sort of five)
    const x = this.fx || (this.fx = new Int32Array(ROWS));
    for (let i = 0; i < ROWS; i++) {
      const v = CLASS[c][rows[base + i]];
      let j = i - 1;
      while (j >= 0 && x[j] > v) { x[j + 1] = x[j]; j--; }
      x[j + 1] = v;
    }
    const k1 = String.fromCharCode(c * 32 + budget * 8 + (b3 ? 4 : 0) + (watchA ? 2 : 0) + (watchB ? 1 : 0), x[0], x[1], x[2], x[3], x[4]);
    let e = this.l1.get(k1);
    if (e === undefined) {
      const cap = new Int8Array(10), rc = [];
      for (let i = 0; i < ROWS; i++) {
        rc.push(rows[base + i]);
        const m = maxNeed(c, rows[base + i]);
        for (let d = 0; d < 10; d++) cap[d] += m[d];
      }
      for (let d = 0; d < 10; d++) if (cap[d] > budget) cap[d] = budget;
      e = { cap, rc, m: new Map(), misses: 0, q: null };
      this.l1.set(k1, e);
    }
    const cap = e.cap;
    let key = 0;
    for (let d = 0; d < 10; d++) key += (bk[d] < cap[d] ? bk[d] : cap[d]) * POW5[d];
    let tab = e.m.get(key);
    if (tab === undefined || tab === DIRECT) {
      for (let d = 0; d < 10; d++) FT_bank[d] = bk[d] < cap[d] ? bk[d] : cap[d];
      // a row set that keeps coming back with new banks gets its booking list
      if (!e.q && ++e.misses > 2) e.q = this.bookingList(c, e.rc, budget, b3, watchA, watchB);
      if (e.q && alpha && alpha[0] >= 0 && !(e.q.flags.length && hasUnlock(e.q))) {
        const top = S0 + e.q.gmax;
        const ub0 = top >= 100 ? 1000 : 0;
        let beat;
        if (ub0 !== alpha[0]) beat = ub0 > alpha[0];
        else if (ub0) beat = 1000 * top > alpha[1] || (1000 * top === alpha[1] && (this.exactLoss ? 1000 >= alpha[2] : 1000 > alpha[2]));
        else { const uq = q0 || e.q.anyQuad ? 1000 : 0; beat = uq > alpha[2] || (uq === alpha[2] && this.exactLoss && 1000 * top > alpha[3]); }
        if (!beat) return SKIP;
      }
      // first time this bank shows up: evaluate directly; keep a table only if it comes back
      if (e.q && vout && tab === undefined) {
        this.tablesBuilt++;
        if (!valueFromList(e.q, FT_bank, S0, q0, vout)) { e.m.set(key, null); return null; }
        e.m.set(key, DIRECT);
        return DIRECT;
      }
      tab = e.q ? this.tableFromList(e.q, FT_bank) : this.buildTable(c, e.rc, budget, FT_bank, b3, watchA, watchB);
      e.m.set(key, tab);
      if (++this.l2size > this.maxTables) { this.l1.clear(); this.l2size = 0; }
    }
    return tab;
  };
  // Value of a position at the start of round 10 (same result as finalValue).
  // Writes [win, points, quad] into `out`.
  Solver.prototype.v1Fast = function (rows, bk, uA, uB, out, alpha) {
    const classic = this.classic;
    let S0 = 0, n10 = 0, n15 = 0, m20 = 0, l20 = 0;
    for (let i = 0; i < ROWS; i++) {
      const a = SCORE[SEQ][rows[i]], m = SCORE[MAT][rows[ROWS + i]], l = SCORE[LAD][rows[2 * ROWS + i]];
      S0 += a + m + l;
      if (a >= 10) n10++; if (a >= 15) n15++; if (m >= 20) m20++; if (l >= 20) l20++;
    }
    const b3 = n15 >= 5 || (!classic && (m20 === ROWS || l20 === ROWS));
    if (b3) S0 += 5;
    const q0 = m20 > 0;
    const freeNow = (uA === 0 && n10 >= 5) || (!classic && uB === 0 && n15 >= 4);
    const t = Math.max(0, Math.min(GMAX + 1, 100 - S0)), L = GMAX + 2;
    const tabs = this.v1tabs || (this.v1tabs = [null, null, null]);
    const vals = this.v1vals || (this.v1vals = [new Float64Array(4), new Float64Array(4), new Float64Array(4)]);
    let needFull = freeNow;
    for (let c = 0; c < 3 && !needFull; c++) { tabs[c] = this.fastTable(c, rows, bk, uA, uB, b3, n10, S0, q0, vals[c], alpha); if (!tabs[c]) needFull = true; }
    if (needFull) {
      // a free book may be in play: whole-position tables are costly, so cache by position
      const key = this.key(rows, bk, uA, uB, 1);
      let v = this.memo[1].get(key);
      if (v === undefined) {
        const st = makeState(rows, bk, uA, uB);
        v = null;
        for (let c = 0; c < 3; c++) {
          const tab = freeNow ? null : this.fastTable(c, rows, bk, uA, uB, b3, n10);
          let cv;
          if (tab) cv = evalTab(tab, S0, q0);
          else {
            cv = this.fullCategoryValue(st, c);
          }
          if (v === null || cmp(cv, v) > 0) v = cv;
        }
        if (this.memo[1].size >= this.maxMemo) this.memo[1].clear();
        this.memo[1].set(key, v);
      }
      out[0] = v[0]; out[1] = v[1]; out[2] = v[2]; out[3] = v[3];
      return;
    }
    let bw = -1, bp = 0, bq = 0, bl = 0;
    const qo = (q0 ? 4 : 5) * L;
    for (let c = 0; c < 3; c++) {
      const tab = tabs[c];
      if (tab === SKIP) continue;
      let w, p, q, l;
      if (tab === DIRECT) { const v = vals[c]; w = v[0]; p = v[1]; q = v[2]; l = v[3]; }
      else { w = tab[t]; p = S0 * w + tab[L + t]; q = q0 ? 1000 : tab[2 * L + t] + tab[3 * L + t]; l = S0 * (1000 - w) + tab[qo + t]; }
      if (w > bw || (w === bw && (p > bp || (p === bp && (q > bq || (q === bq && l > bl)))))) { bw = w; bp = p; bq = q; bl = l; }
    }
    if (bw < 0) { out[0] = -1; out[1] = 0; out[2] = 0; out[3] = 0; return; }   // all skipped: cannot beat alpha
    out[0] = bw; out[1] = bp; out[2] = bq; out[3] = bl;
  };
  // One category's round-10 value through the whole-position table (free books).
  Solver.prototype.fullCategoryValue = function (st, cat) {
    this.fullTablesBuilt++;
    return aggregateFull(this.fullFinalTable(st, cat));
  };
  // Best value over round-9 bookings for `c9` with this bank (roll included).
  Solver.prototype.bestAfterRollFast = function (st, c9, bank) {
    const out = this.v1out || (this.v1out = new Float64Array(4));
    let bw = -1, bp = 0, bq = 0, bl = 0;
    const alpha = this.alphaBuf || (this.alphaBuf = new Float64Array(4));
    this.forEachBooking(st, c9, bank, false, false, (rows, bk, uA, uB) => {
      alpha[0] = bw; alpha[1] = bp; alpha[2] = bq; alpha[3] = bl;
      this.v1Fast(rows, bk, uA, uB, out, bw >= 0 ? alpha : null);
      this.nodes++;
      if (out[0] > bw || (out[0] === bw && (out[1] > bp || (out[1] === bp && (out[2] > bq || (out[2] === bq && out[3] > bl)))))) { bw = out[0]; bp = out[1]; bq = out[2]; bl = out[3]; }
    });
    return [bw, bp, bq, bl];
  };

  Solver.prototype.genericValue = function (st, roundsLeft) {
    if (roundsLeft === 0) return this.terminal(st.rows);
    const memo = this.memo[roundsLeft];
    const key = this.key(st.rows, st.bank, st.usedA, st.usedB, roundsLeft);
    const hit = memo.get(key);
    if (hit) return hit;
    this.nodes++;
    let best = null;
    for (let cat = 0; cat < 3; cat++) {
      const v = this.categoryValue(st, cat, roundsLeft);
      if (best === null || cmp(v, best) > 0) best = v;
    }
    memo.set(key, best);
    return best;
  };

  // Expected value of choosing `cat` now (before the roll).
  Solver.prototype.categoryValue = function (st, cat, roundsLeft) {
    return this.categoryValueRange(st, cat, roundsLeft, 0, ROLLS.length);
  };
  // Same, summed over rolls ROLLS[r0..r1) only, so the work can be split across threads.
  Solver.prototype.categoryValueRange = function (st, cat, roundsLeft, r0, r1) {
    const acc = [0, 0, 0, 0];
    const bank = new Int8Array(10);
    const pruned = roundsLeft === 2 && this.prune && this.fastFinal;
    const fast2 = roundsLeft === 2 && !this.prune && this.fastFinal && this.fast2;
    for (let ri = r0; ri < r1; ri++) {
      const r = ROLLS[ri];
      bank.set(st.bank);
      for (const d of r.digits) bank[d]++;
      const v = pruned ? this.bestAfterRollPruned(st, cat, bank) : fast2 ? this.bestAfterRollFast(st, cat, bank) : this.bestAfterRoll(st, cat, bank, roundsLeft);
      acc[0] += r.w * v[0]; acc[1] += r.w * v[1]; acc[2] += r.w * v[2]; acc[3] += r.w * v[3];
    }
    return acc;
  };

  // Best value over bookings, given the bank including this round's roll.
  Solver.prototype.bestAfterRoll = function (st, cat, bank, roundsLeft) {
    const final = roundsLeft === 1;
    let best = null;
    const self = this;
    this.forEachBooking(st, cat, bank, final, false, (rows, bk, uA, uB) => {
      const v = final ? self.terminal(rows) : self.value(makeState(rows, bk, uA, uB), roundsLeft - 1);
      if (best === null || cmp(v, best) > 0) best = v;
    });
    return best;
  };

  function cmp(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]; }
  function cmp3(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }

  // ---------- top-level API ----------
  // Start of round 10: which of the 220 rolls win (reach 100) for category `cat`.
  // Returns { weight (out of 1000), rolls: [[a, b, c], ...] (sorted triples) }.
  Solver.prototype.winningRolls = function (st, cat) {
    const bank = new Int8Array(10), rolls = [];
    let weight = 0;
    for (const r of ROLLS) {
      bank.set(st.bank);
      for (const d of r.digits) bank[d]++;
      if (this.bestAfterRoll(st, cat, bank, 1)[0] === 1) { weight += r.w; rolls.push(r.digits.slice()); }
    }
    return { weight, rolls };
  };

  // Values at round start, per category. roundsLeft counts the current round.
  Solver.prototype.analyzeRoundStart = function (st, roundsLeft) {
    return this.breakSummaryTie(st, summarize(CAT_NAMES.map((name, cat) => this.categoryValue(st, cat, roundsLeft)), roundsLeft), roundsLeft);
  };
  // Rounds 9 and 10 (roundsLeft <= 2): when the best category is a sure win and another ties
  // it on points if win and Quad too, the one fewestDigitsCategory picks (the most points
  // from the bank alone, then the fewest digits; then Sequence, Matching, Ladder).
  // values: the raw category values (win scaled by 1000 per round left); b: the best so far.
  Solver.prototype.sureWinTieBreak = function (st, values, roundsLeft, b) {
    if (roundsLeft > 2 || values[b][0] !== Math.pow(1000, roundsLeft)) return b;
    const tied = [0, 1, 2].filter(c => cmp3(values[c], values[b]) === 0);
    return tied.length > 1 ? this.fewestDigitsCategory(st, tied) : b;
  };
  // The same for an analyzeRoundStart / summarize result (its ★ category)
  Solver.prototype.breakSummaryTie = function (st, summary, roundsLeft) {
    const b = this.sureWinTieBreak(st, summary.categories.map(c => c.value), roundsLeft, CAT_NAMES.indexOf(summary.best));
    return { ...summary, best: CAT_NAMES[b] };
  };
  // Turn the three raw category values into the analyzeRoundStart result.
  function summarize(values, roundsLeft) {
    const scale = Math.pow(1000, roundsLeft);
    const out = CAT_NAMES.map((name, cat) => ({ category: name, value: values[cat], ...describe(values[cat], scale) }));
    let best = out[0];
    for (const o of out) if (cmp(o.value, best.value) > 0) best = o;  // ties keep S > M > L
    return { categories: out, best: best.category };
  }

  // Best booking after the roll. `bankList` = array of {digit, used} in bank order
  // (so ties can prefer the earliest digits). roundsLeft counts the current round.
  Solver.prototype.bestBooking = function (st, cat, bankList, roundsLeft) {
    const final = roundsLeft === 1;
    const scale = Math.pow(1000, roundsLeft - 1);
    const bank = new Int8Array(10);
    for (const b of bankList) if (!b.used) bank[b.digit]++;
    let best = null;
    // equal values and end-of-round score: compare the next round's other categories
    const fill = c => { if (!c.alt) c.alt = this.altValues(c.st, roundsLeft - 1); };
    this.forEachBooking(st, cat, bank, final, true, (rows, bk, uA, uB, nMain, placements) => {
      const next = final ? null : makeState(rows, bk, uA, uB);
      const v = final ? this.terminal(rows) : this.value(next, roundsLeft - 1);
      const cand = candidateOf(rows, placements, bankList, this.classic);
      cand.v = v; cand.st = next;
      if (best === null) { best = cand; return; }
      const c = cmp(v, best.v);
      if (c === 0 && !final && cand.now === best.now) { fill(cand); fill(best); }
      if (c > 0 || (c === 0 && tieBetter(cand, best))) best = cand;
    });
    return {
      placements: best.placements.map(p => ({ ...p, category: CAT_NAMES[p.cat] })),
      value: best.v, ...describe(best.v, scale),
    };
  };

  // ---------- round 8: branch and bound over bookings ----------
  // A round-8 booking leads to a round-9 start position whose exact value costs a full
  // two-round search. Most of them cannot be best, and a cheap upper bound shows it:
  // per round-9 category and roll, the best booking is worth at most
  //  - round 10 in the same category: booking P now and Q later ends where P and Q
  //    together would, so at most a final-round table of the current rows with the
  //    bank after the roll and both rounds' booking limits combined;
  //  - round 10 in another category c: those rows are untouched, so at most c's table
  //    with the whole bank after the roll, at a base score raised by the most round 9
  //    could add (the lowest best gain over the 220 round-10 rolls is an upper bound on
  //    a booking from the bank alone);
  //  - free books (only if one could be unlocked in time): +2 to every booking limit,
  //    plus what two single digits could add in the categories not covered.
  // Bonus III is never assumed earned (so it can always be added) and Quad counts as
  // possible whenever Matching is played. Positions are then solved exactly in order
  // of their bound, a round-9 category is abandoned as soon as its rolls so far plus
  // the bounds of the rest cannot beat the best found, and the search ends when the
  // next bound cannot. Equal values fall back to the booking tie-breaks.
  const minGain = tab => { let g = 0; while (g <= GMAX && tab[g + 1] === 1000) g++; return g; };
  const NEEDTO = new Map();
  function needTo(code, target) {     // fewest digits that take a Sequence row to `target`
    const k = code * 32 + target;
    let n = NEEDTO.get(k);
    if (n === undefined) {
      n = SCORE[SEQ][code] >= target ? 0 : 99;
      for (const e of getExt(SEQ, code)) if (SCORE[SEQ][e.code] >= target && e.n < n) n = e.n;
      NEEDTO.set(k, n);
    }
    return n;
  }
  // Could a Bonus II free book be unlocked (or still be unused) within two rounds?
  // At most 8 digits go into Sequence in two rounds, plus up to 2 free ones.
  function bonusReachable(st, classic) {
    const sum = (target, k) => {
      const a = [];
      for (let i = 0; i < ROWS; i++) a.push(needTo(st.rows[i], target));
      a.sort((x, y) => x - y);
      let t = 0; for (let i = 0; i < k; i++) t += a[i];
      return t;
    };
    return (st.usedA === 0 && sum(10, 5) <= 10) || (!classic && st.usedB === 0 && sum(15, 4) <= 10);
  }
  // Most that two free single digits can add in categories `cats` (rows untouched
  // otherwise): two different rows, or two digits in one row, plus Bonus III if one
  // of those categories could be completed.
  function freeTwo(rows, cats) {
    let g1 = 0, g2 = 0, pair = 0, b3 = 0;
    for (const c of cats) {
      let open = 0;
      const full = c === SEQ ? 15 : 20;
      for (let i = 0; i < ROWS; i++) {
        const code = rows[c * ROWS + i];
        if (SCORE[c][code] < full) open++;
        for (const e of getExt(c, code).improving) {
          if (e.n === 1) { if (e.gain > g1) { g2 = g1; g1 = e.gain; } else if (e.gain > g2) g2 = e.gain; }
          if (e.n <= 2 && e.gain > pair) pair = e.gain;
        }
      }
      if (open <= 2) b3 = 5;
    }
    return Math.max(g1 + g2, pair) + b3;
  }
  // Upper bound on the best round-9 booking for category c9, bank B (roll included).
  // free.reach: a free book could still be unlocked; free.now: one is unlocked and unused.
  // A free book is only unlocked by booking Sequence, so it can matter only if Sequence
  // is played in round 9 or 10 (or one is already waiting).
  const maxGain = tab => { let g = GMAX; while (g > 0 && tab[g] === 0) g--; return g; };
  Solver.prototype.rollBound = function (st, c9, B, free) {
    const S0 = terminalScore(st.rows, this.classic), q0 = hasQuad(st.rows);
    const pos = { rows: st.rows, bank: B, usedA: st.usedA, usedB: st.usedB };
    const b9 = c9 === SEQ ? 4 : 3;
    const f9 = free.now || (free.reach && c9 === SEQ);
    const others = c9 === SEQ ? [MAT, LAD] : c9 === MAT ? [SEQ, LAD] : [SEQ, MAT];
    const qx = q0 || c9 === MAT;
    // round 10 in the same category
    let ub = evalTab(this.finalTable(pos, c9, false, 2 * b9 + (f9 ? 2 : 0), true), S0 + (f9 ? freeTwo(st.rows, others) : 0), qx || f9);
    // round 10 in another category
    for (let k = 0; k < 2; k++) {
      const c = others[k];
      const f = f9 || (free.reach && c === SEQ);
      // what round 9 (plus any free digits landing in its rows) can add
      const g9 = f ? maxGain(this.finalTable(pos, c9, false, b9 + 2, true)) : minGain(this.finalTable(pos, c9, false, b9, true));
      const v = evalTab(this.finalTable(pos, c, false, (c === SEQ ? 4 : 3) + (f ? 2 : 0), true), S0 + g9 + (f ? freeTwo(st.rows, [others[1 - k]]) : 0), qx || f);
      if (cmp(v, ub) > 0) ub = v;
    }
    return ub;
  };
  Solver.prototype.freeState = function (st) {
    let n10 = 0, n15 = 0;
    for (let i = 0; i < ROWS; i++) { const sc = SCORE[SEQ][st.rows[i]]; if (sc >= 10) n10++; if (sc >= 15) n15++; }
    return {
      reach: bonusReachable(st, this.classic),
      now: (st.usedA === 0 && n10 >= 5) || (!this.classic && st.usedB === 0 && n15 >= 4),
    };
  };
  // A quick, looser bound for a round-9 start position, without going through the
  // rolls: a bank holding three more of every digit contains the bank after any roll,
  // and a bigger bank never does worse, so rollBound with it bounds every roll (and an
  // average of values each at most U is at most U).
  // Same shape as positionBound ({ per, tot, ub }, every roll given its category's bound).
  Solver.prototype.quickBound = function (st) {
    const free = this.freeState(st);
    const bb = new Int8Array(10);
    for (let d = 0; d < 10; d++) bb[d] = st.bank[d] + 3;
    const per = [], tot = [];
    let ub = null;
    for (let c = 0; c < 3; c++) {
      const u = this.rollBound(st, c, bb, free);
      per.push(ROLLS.map(() => u));
      const t = u.map(x => x * 1000);    // the 220 roll weights add up to 1000
      tot.push(t);
      if (ub === null || cmp(t, ub) > 0) ub = t;
    }
    return { per, tot, ub, quick: true };
  };
  // Per category and roll bounds for a round-9 start position.
  Solver.prototype.positionBound = function (st) {
    const free = this.freeState(st);
    const per = [[], [], []], tot = [];
    const bb = new Int8Array(10);
    for (let c = 0; c < 3; c++) {
      const acc = [0, 0, 0, 0];
      for (const r of ROLLS) {
        bb.set(st.bank); for (const d of r.digits) bb[d]++;
        const u = this.rollBound(st, c, bb, free);
        per[c].push(u);
        acc[0] += r.w * u[0]; acc[1] += r.w * u[1]; acc[2] += r.w * u[2]; acc[3] += r.w * u[3];
      }
      tot.push(acc);
    }
    let ub = tot[0];
    for (let c = 1; c < 3; c++) if (cmp(tot[c], ub) > 0) ub = tot[c];
    return { per, tot, ub };
  };
  // Cheap estimates of a round-9 start position, for ordering (never for the answer):
  //  - 'r10': its value as if round 10 came next (one round of table lookups);
  //  - 'sample': the round-9 analysis (display mode) over every k-th roll only.
  const SAMPLE_ROLLS = k => ROLLS.map((r, i) => i).filter(i => i % k === Math.floor(k / 2));
  Solver.prototype.screenValue = function (st, kind, k) {
    if (kind === 'r10') return this.value(st, 1);
    const idx = SAMPLE_ROLLS(k || 10), bb = new Int8Array(10);
    const saved = this.exactLoss;
    this.exactLoss = false;
    let best = null;
    for (let c = 0; c < 3; c++) {
      const acc = [0, 0, 0, 0];
      for (const i of idx) {
        const r = ROLLS[i];
        bb.set(st.bank); for (const d of r.digits) bb[d]++;
        const v = this.bestAfterRollFast(st, c, bb);
        for (let j = 0; j < 4; j++) acc[j] += r.w * v[j];
      }
      if (best === null || cmp3(acc, best) > 0) best = acc;
    }
    this.exactLoss = saved;
    return best;
  };
  // Round-9 start value, abandoning categories that cannot satisfy beats(value).
  // Returns the exact value, or null if it cannot satisfy beats().
  // opts.order: the rolls (indices into ROLLS) in the order to solve them, the same for
  // every category (e.g. the best play's losing rolls first: those tend to rule a play
  // out soonest, and they are quick to solve); otherwise most at stake first.
  // opts.record: keep the win part of each roll's value for the category that gives the
  // returned best (this.lastPer, a Float64Array over ROLLS), to make such an order from.
  Solver.prototype.valueWithCutoff = function (st, bound, beats, opts) {
    let best = null;
    const order = [0, 1, 2].sort((a, b) => cmp(bound.tot[b], bound.tot[a]));
    const bb = new Int8Array(10);
    const ok = v => beats(v) && (best === null || cmp(v, best) > 0);
    const rec = opts && opts.record ? new Float64Array(ROLLS.length) : null;
    this.lastPer = null;
    for (const c of order) {
      if (!ok(bound.tot[c])) continue;
      const part = [0, 0, 0, 0], rem = bound.tot[c].slice(), s = [0, 0, 0, 0];
      let done = true;
      // rolls with the most at stake first, so a hopeless category is dropped early
      const per = bound.per[c];
      const idx = opts && opts.order ? opts.order
        : ROLLS.map((r, i) => i).sort((x, y) => ROLLS[y].w * per[y][0] - ROLLS[x].w * per[x][0] || ROLLS[y].w * per[y][1] - ROLLS[x].w * per[x][1]);
      for (let k = 0; k < ROLLS.length; k++) {
        const ri = idx[k], r = ROLLS[ri];
        bb.set(st.bank); for (const d of r.digits) bb[d]++;
        const v = this.fastFinal && this.fast2 ? this.bestAfterRollFast(st, c, bb) : this.bestAfterRoll(st, c, bb, 2);
        if (rec) rec[ri] = v[0];
        const u = bound.per[c][ri];
        if (cmp(v, u) > 0) this.boundViolations = (this.boundViolations || 0) + 1;
        for (let j = 0; j < 4; j++) { part[j] += r.w * v[j]; rem[j] -= r.w * u[j]; s[j] = part[j] + rem[j]; }
        this.rollsSolved = (this.rollsSolved || 0) + 1;
        if (this.deadline && Date.now() > this.deadline) return undefined;
        if (!ok(s)) { done = false; break; }
      }
      if (done && (best === null || cmp(part, best) > 0)) { best = part; if (rec) this.lastPer = rec.slice(); }
    }
    return best !== null && beats(best) ? best : null;
  };
  // Round 10 categories that tie on everything (a sure win, the same points if win and the
  // same Quad chance): the one whose best booking from the bank alone (as if the roll's
  // digits could not be booked) uses the fewest digits; then Sequence, Matching, Ladder.
  // cats: the tied categories in that order.
  Solver.prototype.fewestDigitsCategory = function (st, cats) {
    const bankList = [];
    for (let d = 0; d < 10; d++) for (let k = 0; k < st.bank[d]; k++) bankList.push({ digit: d, used: false });
    // (the bank-only booking's score first, so a category that cannot reach 100 that way
    // never wins by booking nothing)
    let best = cats[0], top = -1, fewest = Infinity;
    for (const c of cats) {
      const r = this.bestBooking(st, c, bankList, 1);
      const rows = Int16Array.from(st.rows);
      for (const p of r.placements) { const x = dec(rows[p.cat * 5 + p.row]); x[p.col] = p.digit; rows[p.cat * 5 + p.row] = enc(x); }
      const score = terminalScore(rows, this.classic), n = r.placements.length;
      if (score > top || (score === top && n < fewest)) { top = score; fewest = n; best = c; }
    }
    return best;
  };
  // Value-equivalent round-8 bookings grouped by resulting position, each group with
  // its tie-break-best booking.
  Solver.prototype.bookingGroups = function (st, cat, bankList, roundsLeft) {
    const bank = new Int8Array(10);
    for (const b of bankList) if (!b.used) bank[b.digit]++;
    const groups = new Map();
    this.forEachBooking(st, cat, bank, false, true, (rows, bk, uA, uB, nMain, placements) => {
      const key = this.key(rows, bk, uA, uB, roundsLeft - 1);
      const cand = candidateOf(rows, placements, bankList, this.classic);
      const g = groups.get(key);
      if (!g) groups.set(key, { state: makeState(rows, bk, uA, uB), cand });
      else if (tieBetter(cand, g.cand)) g.cand = cand;
    });
    return [...groups.values()];
  };
  // Exact best booking with three rounds left (after the round-8 roll).
  // Same result as bestBooking(st, cat, bankList, 3), usually far faster.
  // opts.timeLimit (ms): give up when exceeded (returns { timedOut: true, ... }).
  Solver.prototype.bestBookingBnB = function (st, cat, bankList, opts) {
    const t0 = Date.now();
    const limit = (opts && opts.timeLimit) || Infinity;
    this.deadline = t0 + limit;
    const groups = this.bookingGroups(st, cat, bankList, 3);
    // opts.bounds: 'roll' (per-roll bounds for all, the default), 'quick' (only the
    // roll-free bound) or 'lazy' (quick bounds to order and skip; per-roll bounds
    // worked out only for positions that still have to be solved)
    const mode = (opts && opts.bounds) || 'roll';
    for (const g of groups) {
      g.bound = mode === 'roll' ? this.positionBound(g.state) : this.quickBound(g.state);
      if (Date.now() > this.deadline) return { timedOut: true, stats: { positions: groups.length, solved: 0, ms: Date.now() - t0 } };
    }
    const refine = g => { if (mode === 'lazy' && g.bound.quick) g.bound = this.positionBound(g.state); };
    // opts.order: solve positions best bound first (default), or by a screen ('r10',
    // 'sample'), which tends to find the best play sooner; the answer is the same
    const order = opts && opts.order;
    if (order) for (const g of groups) g.screen = this.screenValue(g.state, order, opts.sampleK);
    const key = g => (order ? g.screen : g.bound.ub);
    const tBound = Date.now() - t0;
    groups.sort((a, b) => cmp(key(b), key(a)) || (tieBetter(a.cand, b.cand) ? -1 : tieBetter(b.cand, a.cand) ? 1 : 0));
    this.lastGroups = groups;
    // Phase 1: the first three values only (win, points if win, Quad), which lets the
    // search skip far more; keep every position that ties for the best on those.
    const exactSaved = this.exactLoss;
    this.exactLoss = false;
    let best3 = null, tied = [], solved = 0;
    const out = (extra) => { this.exactLoss = exactSaved; return { timedOut: true, stats: { positions: groups.length, solved, boundMs: tBound, ms: Date.now() - t0, ...extra } }; };
    for (const g of groups) {
      if (best3 !== null && cmp3(g.bound.ub, best3) < 0) continue;
      refine(g);
      if (best3 !== null && cmp3(g.bound.ub, best3) < 0) continue;
      const beats = v => best3 === null || cmp3(v, best3) >= 0;
      solved++;
      const r0 = this.rollsSolved || 0, tc = Date.now();
      const v = this.valueWithCutoff(g.state, g.bound, beats);
      if (v === undefined) return out();
      if (v !== null) {
        const c = best3 === null ? 1 : cmp3(v, best3);
        if (c > 0) { best3 = v; tied = [g]; } else if (c === 0) tied.push(g);
      }
      if (this.trace) this.trace({ index: solved, of: groups.length, bound: g.bound.ub, value: v, best: best3, rolls: (this.rollsSolved || 0) - r0, ms: Date.now() - tc, group: g });
    }
    this.exactLoss = exactSaved;
    // Phase 2: exact values (points if lost too) for the tied ones, then the end-of-round
    // score. Same branch and bound as before, now on all four values, among the tied ones only.
    let best = null, ties = [];
    for (const g of tied) {
      const beats = v => best === null || cmp(v, best.v) > 0 || (cmp(v, best.v) === 0 && g.cand.now >= best.cand.now);
      if (!beats(g.bound.ub)) continue;
      const v = this.valueWithCutoff(g.state, g.bound, beats);
      if (v === undefined) return out({ tied: tied.length });
      if (v === null) continue;
      if (best === null || cmp(v, best.v) > 0 || g.cand.now > best.cand.now) { best = { v, cand: g.cand }; ties = [g]; } else ties.push(g);
    }
    // Phase 3: still equal, so the round-9 categories other than the best one decide
    // (then the rest of the booking tie-breaks)
    if (ties.length > 1) {
      this.exactLoss = false;
      for (const g of ties) {
        g.cand.alt = this.altValues(g.state, 2);
        if (this.deadline && Date.now() > this.deadline) return out({ tied: tied.length });
      }
      this.exactLoss = exactSaved;
      for (const g of ties) if (tieBetter(g.cand, best.cand)) best = { v: best.v, cand: g.cand };
    }
    return {
      placements: best.cand.placements.map(p => ({ ...p, category: CAT_NAMES[p.cat] })),
      value: best.v, ...describe(best.v, 1e6),
      stats: { positions: groups.length, solved, tied: tied.length, ties: ties.length, boundMs: tBound, ms: Date.now() - t0 },
    };
  };

  // a Sequence row whose filled cells fit an ascending run (one filled cell counts too)
  function isAscendingRow(code) {
    const c = dec(code), f = [];
    for (let i = 0; i < 4; i++) if (c[i] !== E) f.push((c[i] - i + 10) % 10);
    return f.length > 0 && f.every(x => x === f[0]);
  }
  // a Ladder row XXYY going up: Y = X + 1 (mod 10, so 9900 is ascending and 0099 is not);
  // both halves need a digit
  function isAscendingLadder(code) {
    const c = dec(code);
    const x = c[0] !== E ? c[0] : c[1], y = c[2] !== E ? c[2] : c[3];
    return x !== E && y !== E && y === (x + 1) % 10;
  }
  // tie-break data for one booking (placements as built by forEachBooking with `track`)
  function candidateOf(rows, placements, bankList, classic) {
    const n = placements.length;
    const idxs = assignBankIndices(bankList, placements);
    const cellOrder = placements.map(p => p.cat * 100 + p.row * 10 + p.col).sort((x, y) => x - y);
    let ascending = 0;
    for (const r of new Set(placements.filter(p => p.cat === SEQ).map(p => p.row))) if (isAscendingRow(rows[r])) ascending++;
    for (const r of new Set(placements.filter(p => p.cat === LAD).map(p => p.row))) if (isAscendingLadder(rows[LAD * 5 + r])) ascending++;
    const nB = placements.filter(p => p.bonus === 'B').length, nA = placements.filter(p => p.bonus === 'A').length;
    return { v: null, now: terminalScore(rows, classic), alt: null, n, idxs, nB, nA, cellOrder, ascending, placements: placements.map((p, k) => ({ ...p, bankIdx: idxs.byPlacement[k] })) };
  }
  function better(a, b) {
    const c = cmp(a.v, b.v);
    if (c !== 0) return c > 0;
    return tieBetter(a, b);
  }
  // tie-breaks 5-11 only (equal values; item 6 needs .alt filled in on both, see README)
  function tieBetter(a, b) {
    // most points at the end of this round
    if (a.now !== b.now) return a.now > b.now;
    // before round 10: the best chances with the next round's second-best category,
    // then with its worst (win, then points if win, each)
    if (a.alt && b.alt) for (let i = 0; i < 4; i++) if (a.alt[i] !== b.alt[i]) return a.alt[i] > b.alt[i];
    if (a.n !== b.n) return a.n < b.n;
    // avoid the most recently banked digits: compare latest bank position used,
    // then the next latest, and so on (smaller wins)
    const x = a.idxs.sorted, y = b.idxs.sorted;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
    // Same digits; only where they go is left. Ordinary books before Bonus II-A, and
    // II-B last (what wins without II-B also wins in Classic)
    if (a.nB !== b.nB) return a.nB < b.nB;
    if (a.nA !== b.nA) return a.nA < b.nA;
    // lean left (cells compared in reading order: category, row, column)
    const u = a.cellOrder, w = b.cellOrder;
    for (let i = 0; i < u.length; i++) if (u[i] !== w[i]) return u[i] < w[i];
    // still tied (e.g. 890_ vs 098_, 3344 vs 4433): prefer Sequences and Ladders written ascending
    return a.ascending > b.ascending;
  }
  // earliest unused copy of each digit (equal digits: keep the newest ones in the bank)
  function assignBankIndices(bankList, placements) {
    const taken = new Set();
    const byPlacement = placements.map(p => {
      for (let i = 0; i < bankList.length; i++) {
        if (!bankList[i].used && !taken.has(i) && bankList[i].digit === p.digit) { taken.add(i); return i; }
      }
      return -1;
    });
    return { byPlacement, sorted: byPlacement.slice().sort((a, b) => b - a) };
  }

  // With k rolls still to come every value is an integer over 1000^k, so
  // percentages are exact at 3k-2 decimals and expected points at 3k decimals.
  // The *Exact strings are built from the integers, never through floating point.
  function exactDecimal(num, decimals) {
    const s = String(num).padStart(decimals + 1, '0');
    return decimals ? s.slice(0, s.length - decimals) + '.' + s.slice(s.length - decimals) : s;
  }
  // Points if you win = (sum of winning scores) / (number of winning outcomes).
  // When every outcome wins it is exact at 3k decimals; otherwise it usually does not
  // terminate, so it is rounded (half up). Trailing zeros are kept (102.440).
  function ratioDecimal(num, den, decimals) {
    const scaled = (BigInt(num) * 10n ** BigInt(decimals) * 2n + BigInt(den)) / (2n * BigInt(den));
    return exactDecimal(scaled.toString(), decimals);
  }
  function describe(v, scale) {
    const k = Math.round(Math.log10(scale) / 3);
    const pct = num => (k === 0 ? String(100 * num) : exactDecimal(num, 3 * k - 2));
    const dp = 3 * k;
    return {
      winPct: (100 * v[0]) / scale,
      winPctExact: pct(v[0]),
      // expected final score given that you win (always >= 100); null if no win is possible
      pointsIfWin: v[0] ? v[1] / v[0] : null,
      pointsIfWinText: v[0] ? ratioDecimal(v[1], v[0], dp) : '-',
      quadPct: (100 * v[2]) / scale,
      quadPctExact: pct(v[2]),
      // expected final score given that you lose (null if a loss is impossible)
      pointsIfLose: v[0] < scale && v[3] !== undefined ? v[3] / (scale - v[0]) : null,
      pointsIfLoseText: v[0] < scale && v[3] !== undefined ? ratioDecimal(v[3], scale - v[0], dp) : '-',
    };
  }

  // ---------- conversion from the game's player state ----------
  // ps: game player state; bankDigits: array of digits in bank order.
  function fromGame(ps, bankDigits) {
    const rows = [];
    for (const name of CAT_NAMES) for (const r of ps.grids[name]) rows.push(enc(r.map(x => (x === null ? E : x))));
    const bank = new Int8Array(10);
    const bankList = bankDigits.map((d, i) => ({ digit: d, used: !!ps.bankUsed[i] }));
    for (const b of bankList) if (!b.used) bank[b.digit]++;
    const u = (used, catg) => (!used ? 0 : catg === 'S' ? 1 : 2);
    return {
      state: makeState(rows, bank, u(ps.seqBonusIIAUsed, ps.seqBonusIIACategory), u(ps.seqBonusIIBUsed, ps.seqBonusIIBCategory)),
      bankList,
    };
  }

  // Cache key for a position: equal for positions that only differ by row order within
  // a category, mirrored rows, or (Ladder) the two cells of a pair swapped.
  function positionKey(st, roundsLeft, classic) {
    return (classic ? 'c' : 'm') + roundsLeft + Solver.prototype.key.call(null, st.rows, st.bank, st.usedA, st.usedB, roundsLeft);
  }
  const api = { Solver, fromGame, summarize, makeState, enc, dec, E, SEQ, MAT, LAD, CAT_NAMES, ROLLS, SCORE, LEGAL, CANON, CANON_LAD, CLASS, ROW_LE, getExt, terminalScore, hasQuad, positionKey, canStillReach100,
    // for running the round-8 search across workers (see bestBookingBnB for the order of work)
    compareValues: cmp, compareFirst3: cmp3, tieBreakBetter: tieBetter, describeValue: describe, candidateOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SimiliSolver = api;
})(typeof self !== 'undefined' ? self : this);
