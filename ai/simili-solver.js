// ============================================================
// SIMILI exact endgame solver
// ------------------------------------------------------------
// Expectimax over: choose category -> roll (220 distinct, /1000) -> booking.
// Always Strict Placement. Classic vs Modern is the only rules parameter.
//
// Value of a position = lexicographic vector, kept as exact integers:
//   [ winCount, pointsIfWonSum, quadCount ]   (each scaled by 1000^roundsLeft)
//   1. chance of finishing with >= 100 points
//   2. expected points, losses counting 0 (Quad Bonus excluded)
//   3. chance of holding a Quad (4-of-a-kind Matching row)
// Booking tie-breaks (top-level only): 4. fewest digits, 5. avoid the most recently banked digits,
// 6. lean left (same digits placed further left / higher up), 7. ascending Sequences.
// ============================================================
(function (root) {
  'use strict';

  const E = 10;                       // empty cell
  const NCODES = 14641;               // 11^4 row codes
  const SEQ = 0, MAT = 1, LAD = 2;
  const CAT_NAMES = ['sequence', 'matching', 'ladder'];
  const ROWS = 5;

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
  }
  const EMPTY_ROW = enc([E, E, E, E]);

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
  }

  // Key for memoization: canonical (mirror + row order) rows, capped bank, bonus status.
  Solver.prototype.key = function (rows, bank, usedA, usedB, roundsLeft) {
    const a = new Array(26);
    for (let cat = 0; cat < 3; cat++) {
      const t = [];
      for (let i = 0; i < ROWS; i++) t.push(CANON[rows[cat * ROWS + i]]);
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
    return s >= 100 ? [1, s, q] : [0, 0, q];
  };

  // Enumerate every distinct end-of-booking-phase result for (state, cat) once the
  // roll has been added to bank. `final` = this is round 10 (only improving bookings matter).
  // cb(rows, bank, usedA, usedB, nMain, placements) ; placements built only if `track`.
  // `wild` (final round only): allow up to `wild` digits not in the bank; cb's 8th
  // argument is then the missing multiset code (see fast final round below).
  Solver.prototype.forEachBooking = function (st, cat, bank, final, track, cb, wild) {
    wild = wild | 0;
    const classic = this.classic;
    const rows = Int16Array.from(st.rows);
    const bk = Int8Array.from(bank);
    const miss = new Int8Array(10);
    let missN = 0;
    const missKey = () => {
      if (!wild) return 0;
      const t = [];
      for (let d = 0; d < 10; d++) for (let k = 0; k < miss[d]; k++) t.push(d);
      while (t.length < 3) t.push(E);
      return (t[0] * 11 + t[1]) * 11 + t[2];
    };
    // take digits from the bank, else from wildcards; returns false if impossible
    const take = need => {
      let add = 0;
      for (let d = 0; d < 10; d++) if (need[d] > bk[d]) add += need[d] - bk[d];
      if (missN + add > wild) return null;
      const used = new Int8Array(10);
      for (let d = 0; d < 10; d++) {
        const fromBank = Math.min(need[d], bk[d]);
        used[d] = fromBank; bk[d] -= fromBank; miss[d] += need[d] - fromBank;
      }
      missN += add;
      return used;
    };
    const give = (need, used) => {
      for (let d = 0; d < 10; d++) { bk[d] += used[d]; miss[d] -= need[d] - used[d]; missN -= need[d] - used[d]; }
    };
    const [n10] = seqCounts(rows);
    const maxBook = cat === SEQ && n10 >= 1 ? 4 : 3;
    const base = cat * ROWS;
    const choice = new Int32Array(ROWS);
    const placements = [];
    const exts = [];
    for (let i = 0; i < ROWS; i++) {
      const L = getExt(cat, rows[base + i]);
      exts.push(final ? L.improving : L);
    }
    const self = this;

    function bonusPhase(nMain) {
      // Option: stop here.
      cb(rows, bk, st.usedA, st.usedB, nMain, placements, missKey());
      if (st.usedA === 0 || (!classic && st.usedB === 0)) tryBonus(st.usedA, st.usedB, nMain, 0);
    }
    // Use one free book (A or B), then possibly the other.
    function tryBonus(uA, uB, nMain, depth) {
      if (depth >= 2) return;
      const [c10, c15] = seqCounts(rows);
      const which = [];
      if (uA === 0 && c10 >= 5) which.push('A');
      if (!classic && uB === 0 && c15 >= 4) which.push('B');
      for (const w of which) {
        const otherUsed = w === 'A' ? uB : uA;
        const cats = otherUsed === 2 ? [SEQ] : [SEQ, MAT, LAD];
        for (const c of cats) {
          for (let i = 0; i < ROWS; i++) {
            const idx = c * ROWS + i, old = rows[idx];
            if (FILLED[old] === 4) continue;
            // identical rows: only try the first one
            let dup = false;
            for (let j = 0; j < i; j++) if (rows[c * ROWS + j] === old) { dup = true; break; }
            if (dup) continue;
            const L = getExt(c, old);
            const singles = final ? L.singlesImproving : L.singles;
            for (const e of singles) {
              const d = e.cells[0][1];
              const used = take(e.need);
              if (!used) continue;
              rows[idx] = e.code;
              if (track) placements.push({ cat: c, row: i, col: e.cells[0][0], digit: d, bonus: w });
              const nuA = w === 'A' ? (c === SEQ ? 1 : 2) : uA, nuB = w === 'B' ? (c === SEQ ? 1 : 2) : uB;
              cb(rows, bk, nuA, nuB, nMain, placements, missKey());
              tryBonus(nuA, nuB, nMain, depth + 1);
              if (track) placements.pop();
              rows[idx] = old; give(e.need, used);
            }
          }
        }
      }
    }

    // Identical rows are filled in order: a later copy may only take an option at or
    // after the previous copy's, and "nothing" (NONE) counts as the last option, so
    // the upper of two identical rows is the one that gets booked.
    const NONE = 1 << 30;
    (function rec(i, budget, nMain) {
      if (i === ROWS) { bonusPhase(nMain); return; }
      const idx = base + i, old = rows[idx];
      const same = i > 0 && st.rows[idx] === st.rows[idx - 1];
      const minChoice = same ? choice[i - 1] : 0;
      choice[i] = NONE; rec(i + 1, budget, nMain);
      if (minChoice === NONE) return;
      const L = exts[i];
      for (let e = minChoice; e < L.length; e++) {
        const x = L[e];
        if (x.n > budget) break;               // sorted by n
        const need = x.need;
        let used;
        if (!wild) {
          let ok = true;
          for (let d = 0; d < 10; d++) if (need[d] > bk[d]) { ok = false; break; }
          if (!ok) continue;
          for (let d = 0; d < 10; d++) bk[d] -= need[d];
        } else if (!(used = take(need))) continue;
        rows[idx] = x.code; choice[i] = e;
        if (track) for (const [p, d] of x.cells) placements.push({ cat, row: i, col: p, digit: d, bonus: null });
        rec(i + 1, budget - x.n, nMain + x.n);
        if (track) placements.length -= x.n;
        rows[idx] = old;
        if (!wild) for (let d = 0; d < 10; d++) bk[d] += need[d];
        else give(need, used);
      }
      choice[i] = NONE;
    })(0, maxBook, 0);
  };

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
  Solver.prototype.finalTable = function (st, cat, bonus3Before) {
    const rows = st.rows, base = cat * ROWS;
    const rc = [];
    for (let i = 0; i < ROWS; i++) rc.push(rows[base + i]);
    let n10 = 0, n15 = 0;
    for (let i = 0; i < ROWS; i++) { const s = SCORE[SEQ][rows[i]]; if (s >= 10) n10++; if (s >= 15) n15++; }
    const budget = cat === SEQ && n10 >= 1 ? 4 : 3;
    const cap = new Int8Array(10);
    for (let i = 0; i < ROWS; i++) { const m = maxNeed(cat, rc[i]); for (let d = 0; d < 10; d++) cap[d] += m[d]; }
    const bank = new Int8Array(10);
    for (let d = 0; d < 10; d++) bank[d] = Math.min(st.bank[d], cap[d], budget);
    const watchA = cat === SEQ && st.usedA === 0, watchB = cat === SEQ && !this.classic && st.usedB === 0;
    const sorted = rc.map(c => CANON[c]).sort((a, b) => a - b);
    const key = String.fromCharCode(cat, budget, (bonus3Before ? 1 : 0) + (watchA ? 2 : 0) + (watchB ? 4 : 0), ...sorted, ...bank);
    let tab = this.tables.get(key);
    if (tab !== undefined) return tab;
    this.tablesBuilt++;
    // bestGain[m], bestQuad[m]: best gain (any / with a Quad) per missing multiset, -1 = none
    const bestGain = new Int16Array(MISS_N).fill(-1), bestQuad = new Int16Array(MISS_N).fill(-1);
    const classic = this.classic;
    const fullScore = cat === SEQ ? 15 : 20;
    const bonus3Possible = !bonus3Before && (cat === SEQ || !classic);
    const miss = new Int8Array(10), bk = bank.slice();
    const cur = rc.slice();
    const choice = new Int16Array(ROWS).fill(-1);
    const exts = rc.map(c => getExt(cat, c).improving);
    let unlock = false;
    (function rec(i, budgetLeft, missN, gain) {
      if (unlock) return;
      if (i === ROWS) {
        let g = gain;
        if (bonus3Possible) { let f = 0; for (let j = 0; j < ROWS; j++) if (SCORE[cat][cur[j]] >= fullScore) f++; if (f === ROWS) g += 5; }
        if (watchA || watchB) {
          let a = 0, b = 0;
          for (let j = 0; j < ROWS; j++) { const s = SCORE[SEQ][cur[j]]; if (s >= 10) a++; if (s >= 15) b++; }
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
      for (let e = Math.max(0, minChoice); e < L.length; e++) {
        const x = L[e];
        if (x.n > budgetLeft) break;
        const need = x.need;
        let add = 0;
        for (let d = 0; d < 10; d++) if (need[d] > bk[d]) add += need[d] - bk[d];
        if (missN + add > 3) continue;
        const saved = bk.slice();
        for (let d = 0; d < 10; d++) { if (need[d] > bk[d]) miss[d] += need[d] - bk[d]; bk[d] = Math.max(0, bk[d] - need[d]); }
        cur[i] = x.code; choice[i] = e;
        rec(i + 1, budgetLeft - x.n, missN + add, gain + x.gain);
        cur[i] = rc[i];
        for (let d = 0; d < 10; d++) { if (need[d] > saved[d]) miss[d] -= need[d] - saved[d]; bk[d] = saved[d]; }
      }
      choice[i] = -1;
    })(0, budget, 0, 0);
    if (unlock) { if (this.tables.size >= this.maxTables) this.tables.clear(); this.tables.set(key, null); return null; }
    // Per-roll results bucketed by gain, then suffix sums so that a position with
    // base score S0 is evaluated in O(1): wins are rolls with gain >= 100 - S0.
    const W = new Int32Array(GMAX + 1), WG = new Int32Array(GMAX + 1), QE = new Int32Array(GMAX + 1), QA = new Int32Array(GMAX + 1);
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
    }
    // One packed array: [sufW | sufWG | sufQE | preQA], each GMAX+2 long (about 2 KB per table).
    const L = GMAX + 2;
    tab = new Int32Array(4 * L);
    for (let g = GMAX; g >= 0; g--) { tab[g] = tab[g + 1] + W[g]; tab[L + g] = tab[L + g + 1] + WG[g]; tab[2 * L + g] = tab[2 * L + g + 1] + QE[g]; }
    for (let g = 0; g <= GMAX; g++) tab[3 * L + g + 1] = tab[3 * L + g] + QA[g];
    // Bound memory: tables are only a cache, so drop them all when there are too many.
    if (this.tables.size >= this.maxTables) this.tables.clear();
    this.tables.set(key, tab);
    return tab;
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

  // Whole-position table (used when a free book may be in play): best encoded
  // terminal value per missing multiset. Encoding keeps lexicographic order.
  const encV = (win, s, q) => (win ? 1000 + 2 * s + q : q);
  Solver.prototype.fullFinalTable = function (st, cat) {
    const best = new Int16Array(MISS_N).fill(-1);
    const classic = this.classic;
    this.forEachBooking(st, cat, st.bank, true, false, (rows, bk, uA, uB, n, pl, m) => {
      const s = terminalScore(rows, classic);
      const v = encV(s >= 100, s, hasQuad(rows) ? 1 : 0);
      if (v > best[m]) best[m] = v;
    }, 3);
    return best;
  };

  Solver.prototype.finalValue = function (st) {
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
    let best = null;
    for (let cat = 0; cat < 3; cat++) {
      const tab = bonusMaybeUsable(st, this.classic, cat) ? null : this.finalTable(st, cat, b3);
      let v;
      if (tab) {
        const t = Math.max(0, Math.min(GMAX + 1, 100 - S0));
        const L = GMAX + 2, w = tab[t];
        v = [w, S0 * w + tab[L + t], q0 ? 1000 : tab[2 * L + t] + tab[3 * L + t]];
      } else {
        this.fullTablesBuilt++;
        const full = this.fullFinalTable(st, cat);
        let w = 0, p = 0, q = 0;
        for (let r = 0; r < ROLLS.length; r++) {
          const subs = ROLL_SUBSETS[r];
          let V = -1;
          for (let k = 0; k < subs.length; k++) if (full[subs[k]] > V) V = full[subs[k]];
          const wt = ROLLS[r].w;
          if (V >= 1000) { w += wt; p += wt * ((V - 1000) >> 1); q += wt * (V & 1); }
          else q += wt * V;
        }
        v = [w, p, q];
      }
      if (best === null || cmp(v, best) > 0) best = v;
    }
    return best;
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
    const acc = [0, 0, 0];
    const bank = new Int8Array(10);
    for (let ri = r0; ri < r1; ri++) {
      const r = ROLLS[ri];
      bank.set(st.bank);
      for (const d of r.digits) bank[d]++;
      const v = this.bestAfterRoll(st, cat, bank, roundsLeft);
      acc[0] += r.w * v[0]; acc[1] += r.w * v[1]; acc[2] += r.w * v[2];
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

  function cmp(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }

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
    return summarize(CAT_NAMES.map((name, cat) => this.categoryValue(st, cat, roundsLeft)), roundsLeft);
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
    this.forEachBooking(st, cat, bank, final, true, (rows, bk, uA, uB, nMain, placements) => {
      const v = final ? this.terminal(rows) : this.value(makeState(rows, bk, uA, uB), roundsLeft - 1);
      const n = placements.length;
      const idxs = assignBankIndices(bankList, placements);
      const cellOrder = placements.map(p => p.cat * 100 + p.row * 10 + p.col).sort((x, y) => x - y);
      let ascending = 0;
      for (const r of new Set(placements.filter(p => p.cat === SEQ).map(p => p.row))) if (isAscendingRow(rows[r])) ascending++;
      const cand = { v, n, idxs, cellOrder, ascending, placements: placements.map((p, k) => ({ ...p, bankIdx: idxs.byPlacement[k] })) };
      if (best === null || better(cand, best)) best = cand;
    });
    return {
      placements: best.placements.map(p => ({ ...p, category: CAT_NAMES[p.cat] })),
      value: best.v, ...describe(best.v, scale),
    };
  };

  // a Sequence row whose filled cells fit an ascending run (one filled cell counts too)
  function isAscendingRow(code) {
    const c = dec(code), f = [];
    for (let i = 0; i < 4; i++) if (c[i] !== E) f.push((c[i] - i + 10) % 10);
    return f.length > 0 && f.every(x => x === f[0]);
  }
  function better(a, b) {
    const c = cmp(a.v, b.v);
    if (c !== 0) return c > 0;
    if (a.n !== b.n) return a.n < b.n;
    // avoid the most recently banked digits: compare latest bank position used,
    // then the next latest, and so on (smaller wins)
    const x = a.idxs.sorted, y = b.idxs.sorted;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i];
    // same digits: lean left (cells compared in reading order: category, row, column)
    const u = a.cellOrder, w = b.cellOrder;
    for (let i = 0; i < u.length; i++) if (u[i] !== w[i]) return u[i] < w[i];
    // still tied (e.g. 890_ vs 098_): prefer Sequences written ascending
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
  // That ratio usually does not terminate, so it is rounded (half up) to `decimals`.
  function ratioDecimal(num, den, decimals) {
    const scaled = (BigInt(num) * 10n ** BigInt(decimals) * 2n + BigInt(den)) / (2n * BigInt(den));
    return exactDecimal(scaled.toString(), decimals);
  }
  function describe(v, scale) {
    const k = Math.round(Math.log10(scale) / 3);
    const pct = num => (k === 0 ? String(100 * num) : exactDecimal(num, 3 * k - 2));
    const dp = Math.max(0, 3 * k - 2);
    return {
      winPct: (100 * v[0]) / scale,
      winPctExact: pct(v[0]),
      // expected final score given that you win (always >= 100); null if no win is possible
      pointsIfWin: v[0] ? v[1] / v[0] : null,
      pointsIfWinText: v[0] ? ratioDecimal(v[1], v[0], dp) : '-',
      quadPct: (100 * v[2]) / scale,
      quadPctExact: pct(v[2]),
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

  const api = { Solver, fromGame, summarize, makeState, enc, dec, E, SEQ, MAT, LAD, CAT_NAMES, ROLLS, SCORE, LEGAL, getExt, terminalScore, hasQuad };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SimiliSolver = api;
})(typeof self !== 'undefined' ? self : this);
