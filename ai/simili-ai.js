// SIMILI computer player for the whole game.
//
// Rounds 9 and 10 are played by the exact solver (simili-solver.js). For earlier rounds
// a small neural network per round estimates how good a round-start position is:
// N[k](position) ~ (chance to reach 100, E[final score if 100 is reached, else 0] / 150,
// chance of holding a Quad at the end) with k rounds still to play. A decision looks
// one step ahead: each booking is judged by the network value of the position it
// leaves, and a category by the average of the best booking over the rolls.
//
// The networks are trained backwards (ai/train/train.js): N[2] (start of round 9) on
// values from the exact solver, then N[3] on one-step look-ahead with N[2], and so on.
//
// Works in the browser (window.SimiliAI, after simili-solver.js) and in Node.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./simili-solver.js'));
  else root.SimiliAI = factory(root.SimiliSolver);
})(typeof self !== 'undefined' ? self : this, function (S) {
  'use strict';
  const { SEQ, MAT, LAD, SCORE, LEGAL, CLASS, ROLLS, terminalScore, hasQuad, makeState } = S;
  const ROWS = 5;

  // ---------- features ----------
  // Each row is one of 102 / 52 / 42 interchangeable classes (see the solver), so a
  // category is described by how many of its rows are in each class. The bank by
  // "at least 1, 2, 3, 4 copies" of each digit; then bonus state and score.
  const CLS = [0, 1, 2].map(cat => {
    const map = new Int16Array(CLASS[cat].length).fill(-1), seen = new Map();
    for (let code = 0; code < CLASS[cat].length; code++) {
      if (!LEGAL[cat][code]) continue;
      const rep = CLASS[cat][code];
      if (!seen.has(rep)) seen.set(rep, seen.size);
      map[code] = seen.get(rep);
    }
    return { map, n: seen.size };
  });
  const OFF = [0, CLS[0].n, CLS[0].n + CLS[1].n];
  const BANK0 = OFF[2] + CLS[2].n;                 // 196
  const FLAG0 = BANK0 + 40;
  const F = {
    usedA: FLAG0, usedB: FLAG0 + 1, n10: FLAG0 + 2, n15: FLAG0 + 3, bonus3: FLAG0 + 4,
    quad: FLAG0 + 5, classic: FLAG0 + 6, score: FLAG0 + 7, bankSize: FLAG0 + 8,
  };
  const NFEAT = FLAG0 + 9;
  const MAXACTIVE = 15 + 40 + 9;

  // Fill idx/val (sparse) for a position; returns the number of active features.
  // onlyCat >= 0: leave out the rows of the other two categories (the caller adds them).
  function features(rows, bank, usedA, usedB, classic, idx, val, onlyCat) {
    let n = 0;
    for (let cat = 0; cat < 3; cat++) {
      if (onlyCat >= 0 && cat !== onlyCat) continue;
      const m = CLS[cat].map;
      for (let i = 0; i < ROWS; i++) { idx[n] = OFF[cat] + m[rows[cat * ROWS + i]]; val[n] = 1; n++; }
    }
    let size = 0;
    for (let d = 0; d < 10; d++) {
      const c = bank[d];
      size += c;
      for (let j = 0; j < 4 && j < c; j++) { idx[n] = BANK0 + d * 4 + j; val[n] = 1; n++; }
    }
    let n10 = 0, n15 = 0, m20 = 0, l20 = 0;
    for (let i = 0; i < ROWS; i++) {
      const s = SCORE[SEQ][rows[i]];
      if (s >= 10) n10++;
      if (s >= 15) n15++;
      if (SCORE[MAT][rows[ROWS + i]] >= 20) m20++;
      if (SCORE[LAD][rows[2 * ROWS + i]] >= 20) l20++;
    }
    const put = (f, v) => { if (v) { idx[n] = f; val[n] = v; n++; } };
    put(F.usedA, usedA ? 1 : 0);
    put(F.usedB, usedB ? 1 : 0);
    put(F.n10, n10 / 5);
    put(F.n15, n15 / 5);
    put(F.bonus3, n15 >= 5 || (!classic && (m20 === 5 || l20 === 5)) ? 1 : 0);
    put(F.quad, hasQuad(rows) ? 1 : 0);
    put(F.classic, classic ? 1 : 0);
    put(F.score, terminalScore(rows, classic) / 100);
    put(F.bankSize, size / 10);
    return n;
  }

  // ---------- canonical form ----------
  // The game looks the same after renaming every digit d to s*d + t (mod 10), s = +-1
  // (shifts, and reflections about any axis): runs, pairs and ladders wrap around (9012,
  // 0099) and the dice are uniform. So all (up to) 20 renamings of a position have the
  // same value, and the network only ever sees one of them, the canonical one: the
  // renaming with the smallest bank (as the counts of 0, 1, ..., 9), then the smallest
  // rows (each category's row classes, sorted). The network is then exactly symmetric,
  // and an equal choice between equivalent plays stays a true tie.
  const NG = 20;
  const DMAP = [], RMAP = [];          // per renaming g: digit map, row-code map
  for (let g = 0; g < NG; g++) {
    const sg = g < 10 ? 1 : -1, t = g % 10;
    const dm = new Int8Array(10);
    for (let d = 0; d < 10; d++) dm[d] = (((sg * d + t) % 10) + 10) % 10;
    DMAP.push(dm);
    const n = CLASS[0].length, rm = new Int16Array(n);
    for (let code = 0; code < n; code++) rm[code] = S.enc(S.dec(code).map(x => (x === S.E ? S.E : dm[x])));
    RMAP.push(rm);
  }
  const cbBank = new Int8Array(10), cbRows = new Int16Array(15);
  const keyRows = new Int16Array(15), bestRows = new Int16Array(15);
  // sorted class indices of each category's rows (the network cannot tell row order)
  function rowKey(rows, out) {
    for (let cat = 0; cat < 3; cat++) {
      const m = CLS[cat].map, b = cat * ROWS;
      for (let i = 0; i < ROWS; i++) {
        const v = m[rows[b + i]];
        let j = i;
        while (j > 0 && out[b + j - 1] > v) { out[b + j] = out[b + j - 1]; j--; }
        out[b + j] = v;
      }
    }
  }
  // The canonical renaming of (rows, bank): returns g; the renamed rows and bank are
  // left in canon.rows / canon.bank (reused buffers).
  const canon = { rows: new Int16Array(15), bank: new Int8Array(10) };
  // a given renaming g, into the same buffers
  function renameInto(rows, bank, g) {
    const dm = DMAP[g], rm = RMAP[g];
    for (let d = 0; d < 10; d++) canon.bank[dm[d]] = bank[d];
    for (let i = 0; i < 15; i++) canon.rows[i] = rm[rows[i]];
  }
  function canonicalize(rows, bank) {
    let best = -1;
    for (let g = 0; g < NG; g++) {
      const dm = DMAP[g];
      for (let d = 0; d < 10; d++) cbBank[dm[d]] = bank[d];
      let c = 0;
      if (best >= 0) for (let d = 0; d < 10 && c === 0; d++) c = cbBank[d] - canon.bank[d];
      if (c > 0) continue;
      const rm = RMAP[g];
      for (let i = 0; i < 15; i++) cbRows[i] = rm[rows[i]];
      rowKey(cbRows, keyRows);
      if (best >= 0 && c === 0) {
        for (let i = 0; i < 15 && c === 0; i++) c = keyRows[i] - bestRows[i];
        if (c >= 0) continue;
      }
      best = g;
      canon.bank.set(cbBank); canon.rows.set(cbRows); bestRows.set(keyRows);
    }
    return best;
  }

  // ---------- network ----------
  // One hidden layer (ReLU), three sigmoid outputs. Weights: w1[feature * H + j], b1[j],
  // w2[o * H + j], b2[o]. The first layer only touches the active features.
  function Net(spec) {
    this.H = spec.H;
    this.w1 = spec.w1 instanceof Float32Array ? spec.w1 : decode(spec.w1);
    this.b1 = spec.b1 instanceof Float32Array ? spec.b1 : decode(spec.b1);
    this.w2 = spec.w2 instanceof Float32Array ? spec.w2 : decode(spec.w2);
    this.b2 = spec.b2 instanceof Float32Array ? spec.b2 : decode(spec.b2);
    this.h = new Float32Array(this.H);
  }
  Net.prototype.eval = function (idx, val, n, out, h0) {
    const H = this.H, h = this.h, w1 = this.w1, w2 = this.w2;
    h.set(h0 || this.b1);
    for (let a = 0; a < n; a++) {
      const base = idx[a] * H, v = val[a];
      if (v === 1) for (let j = 0; j < H; j++) h[j] += w1[base + j];
      else for (let j = 0; j < H; j++) h[j] += v * w1[base + j];
    }
    for (let o = 0; o < 3; o++) {
      let z = this.b2[o];
      const b = o * H;
      for (let j = 0; j < H; j++) if (h[j] > 0) z += w2[b + j] * h[j];
      out[o] = 1 / (1 + Math.exp(-z));
    }
    return out;
  };
  // b1 plus the contribution of some features (to start eval from)
  Net.prototype.partial = function (idx, val, n) {
    const H = this.H, h = Float32Array.from(this.b1), w1 = this.w1;
    for (let a = 0; a < n; a++) { const base = idx[a] * H, v = val[a]; for (let j = 0; j < H; j++) h[j] += v * w1[base + j]; }
    return h;
  };
  // Float32Array <-> base64 (works in browsers and Node)
  function encode(f32) {
    const u8 = new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength);
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return btoa(s);
  }
  function decode(b64) {
    let u8;
    if (typeof Buffer !== 'undefined') u8 = new Uint8Array(Buffer.from(b64, 'base64'));
    else { const s = atob(b64); u8 = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i); }
    return new Float32Array(u8.buffer, u8.byteOffset, u8.byteLength / 4);
  }

  // ---------- comparing estimates ----------
  // Estimates are never exactly equal, so the usual order (win, points if win, Quad)
  // becomes one score in which points and Quad only matter when win chances are close:
  // 5 more points if win (s up by 0.033 at a sure win) count like 0.07% more win chance,
  // and a sure Quad like 0.2%.
  const LS = 0.02, LQ = 0.002;
  const utility = v => v[0] + LS * v[1] + LQ * v[2];
  // Estimates of equivalent positions can differ in the last bits (sums in a different
  // order); closer than this they count as equal and the usual tie-breaks decide.
  const TIE = 1e-7;

  // ---------- player ----------
  // model: { nets: { 2: spec, 3: spec, ... } } (k = rounds left at the start of a round)
  function Player(opts) {
    opts = opts || {};
    this.classic = !!opts.classic;
    this.solver = opts.solver || new S.Solver({ classic: this.classic, exactLoss: false });
    // two networks per round, trained on different positions (see "double" below);
    // their average is the estimate
    this.nets = {};
    if (opts.model) for (const k of Object.keys(opts.model.nets)) {
      const spec = opts.model.nets[k];
      this.nets[k] = (Array.isArray(spec) ? spec : [spec]).map(x => new Net(x));
    }
    this.o2 = new Float64Array(3);
    this.frame = null;
    // canonical: false - no renaming at all (as before; for comparisons)
    this.fixedFrame = opts.canonical === false ? 0 : null;
    this.idx = new Int32Array(MAXACTIVE); this.val = new Float32Array(MAXACTIVE);
    this.out = new Float64Array(3);
    this.evals = 0;
  }
  // Value estimate [win, score-if-win/150, Quad] of a round-start position with k
  // rounds to play. k = 1 is exact (a table lookup), k = 0 is the end of the game.
  Player.prototype.value = function (rows, bank, usedA, usedB, k) {
    if (k === 0) {
      const s = terminalScore(rows, this.classic);
      return [s >= 100 ? 1 : 0, s >= 100 ? s / 150 : 0, hasQuad(rows) ? 1 : 0];
    }
    if (k === 1) {
      const v = this.solver.value(makeState(rows, bank, usedA, usedB), 1);
      return [v[0] / 1000, v[1] / 1000 / 150, v[2] / 1000];
    }
    const pair = this.pair(rows, bank, usedA, usedB, k);
    return [(pair[0][0] + pair[1][0]) / 2, (pair[0][1] + pair[1][1]) / 2, (pair[0][2] + pair[1][2]) / 2];
  };
  // Both networks' estimates (the same one twice if there is only one).
  // base (optional, from baseFor): the other categories' rows already added in.
  Player.prototype.pair = function (rows, bank, usedA, usedB, k, base) {
    const nets = this.nets[k];
    if (!nets) throw new Error('no network for ' + k + ' rounds left');
    this.evals++;
    // within one decision (this.frame set), every option is renamed the same way: the
    // canonical renaming of the decision's position (see bestAfterRoll); otherwise each
    // position its own canonical renaming
    let g;
    if (this.fixedFrame !== null) { g = this.fixedFrame; renameInto(rows, bank, g); }
    else if (this.frame !== null) { g = this.frame; renameInto(rows, bank, g); } else g = canonicalize(rows, bank);
    const h0 = base ? this.baseH(base, g) : null;
    const n = features(canon.rows, canon.bank, usedA, usedB, this.classic, this.idx, this.val, base ? base.cat : -1);
    const a = nets[0].eval(this.idx, this.val, n, this.out, h0 && h0[0]);
    const va = [a[0], a[1], a[2]];
    if (nets.length < 2) return [va, va];
    const b = nets[1].eval(this.idx, this.val, n, this.o2, h0 && h0[1]);
    return [va, [b[0], b[1], b[2]]];
  };
  // Bookings in one category leave the other two untouched (except free books): their
  // rows' part of the first layer is worked out once.
  // (Under each renaming g those rows look different, so one sum per renaming used.)
  Player.prototype.baseFor = function (rows, cat, k) {
    const nets = this.nets[k];
    if (!nets) return null;
    return { cat, rows: Int16Array.from(rows), nets, h: new Array(NG).fill(null) };
  };
  Player.prototype.baseH = function (base, g) {
    if (!base.h[g]) {
      const idx = [], val = [], rm = RMAP[g];
      for (let c = 0; c < 3; c++) {
        if (c === base.cat) continue;
        for (let i = 0; i < ROWS; i++) { idx.push(OFF[c] + CLS[c].map[rm[base.rows[c * ROWS + i]]]); val.push(1); }
      }
      base.h[g] = base.nets.map(net => net.partial(idx, val, idx.length));
    }
    return base.h[g];
  };
  // Best booking value after the roll (bank includes it), k rounds left counting this one.
  // double: for training labels. Picking the best of many noisy estimates and taking
  // its estimate overrates it (the pick is likely one the network overrates), and
  // that would grow round after round. So the booking is picked with one network and
  // valued with the other, and the other way round, and the two are averaged.
  // All bookings of one decision are judged in one renaming: the canonical renaming of the
  // position with the roll in the bank. The decision is then the same for every
  // renaming of the situation, and the network's small digit-specific errors are the
  // same for all the options compared (renaming each option on its own made them differ
  // from option to option, and the computer played worse: 72.5% instead of 78.3% of 240
  // test games).
  Player.prototype.bestAfterRoll = function (st, cat, bank, k, double) {
    const saved = this.frame;
    this.frame = canonicalize(st.rows, bank);
    try { return this.bestAfterRollIn(st, cat, bank, k, double); } finally { this.frame = saved; }
  };
  Player.prototype.bestAfterRollIn = function (st, cat, bank, k, double) {
    const base = k - 1 >= 2 ? this.baseFor(st.rows, cat, k - 1) : null;
    // a free book may change another category: then no shortcut
    const baseOf = (uA, uB) => (uA === st.usedA && uB === st.usedB ? base : null);
    if (double && k - 1 >= 2) {
      let ua = -Infinity, ub = -Infinity, va = null, vb = null;
      this.solver.forEachBooking(st, cat, bank, false, false, (rows, bk, uA, uB) => {
        const [a, b] = this.pair(rows, bk, uA, uB, k - 1, baseOf(uA, uB));
        const x = utility(a), y = utility(b);
        if (x > ua) { ua = x; va = b; }
        if (y > ub) { ub = y; vb = a; }
      });
      return [(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2];
    }
    let best = null, bu = -Infinity;
    this.solver.forEachBooking(st, cat, bank, false, false, (rows, bk, uA, uB) => {
      let v;
      if (k - 1 >= 2) { const [a, b] = this.pair(rows, bk, uA, uB, k - 1, baseOf(uA, uB)); v = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]; }
      else v = this.value(rows, bk, uA, uB, k - 1);
      const u = utility(v);
      if (u > bu) { bu = u; best = v; }
    });
    return best;
  };
  // Expected value of each category at the start of a round (k rounds left), over the
  // given rolls (default: all 220, weighted; or an array of digit triples, equally weighted).
  // cats: only these categories (default all three), in that order.
  Player.prototype.categoryValues = function (st, k, rolls, double, cats) {
    const list = rolls ? rolls.map(d => ({ digits: d, w: 1 })) : ROLLS;
    const tot = list.reduce((a, r) => a + r.w, 0);
    const bank = new Int8Array(10), out = [];
    for (const cat of cats || [0, 1, 2]) {
      const acc = [0, 0, 0];
      for (const r of list) {
        bank.set(st.bank); for (const d of r.digits) bank[d]++;
        const v = this.bestAfterRoll(st, cat, bank, k, double);
        acc[0] += r.w * v[0]; acc[1] += r.w * v[1]; acc[2] += r.w * v[2];
      }
      out.push(acc.map(x => x / tot));
    }
    return out;
  };
  Player.prototype.positionValue = function (st, k, rolls, double) {
    const cv = this.categoryValues(st, k, rolls, double);
    let best = cv[0];
    for (const v of cv) if (utility(v) > utility(best)) best = v;
    return best;
  };
  // Choice of category at the start of a round: index 0-2 and the per-category values.
  Player.prototype.chooseCategory = function (st, k, rolls) {
    if (k <= 2) {
      const vs = [0, 1, 2].map(c => this.solver.categoryValue(st, c, k));
      let b = 0;
      for (let c = 1; c < 3; c++) if (S.compareFirst3(vs[c], vs[b]) > 0) b = c;
      const sc = Math.pow(1000, k);
      return { cat: b, values: vs.map(v => [v[0] / sc, v[1] / sc / 150, v[2] / sc]), exact: true };
    }
    const values = this.categoryValues(st, k, rolls);
    let b = 0;
    for (let c = 1; c < 3; c++) if (utility(values[c]) > utility(values[b]) + TIE) b = c;   // ties: S, M, L
    return { cat: b, values, exact: false };
  };
  // Booking after the roll: { placements (as bestBooking), value }. bankList includes the roll.
  // recheck: { top, rolls } - the `top` best bookings by the network are judged again by
  // looking one round further (the network for the round after, or the exact solver),
  // over the same `rolls` (digit triples) for all of them. Picking the best of ~1000
  // estimates favours the ones the network happens to overrate; the deeper look averages
  // many estimates, so those errors partly cancel.
  Player.prototype.chooseBooking = function (st, cat, bankList, k, recheck) {
    if (k <= 2) return this.solver.bestBooking(st, cat, bankList, k);
    const bank = new Int8Array(10);
    for (const b of bankList) if (!b.used) bank[b.digit]++;
    this.frame = canonicalize(st.rows, bank);     // one renaming for all options (see bestAfterRoll)
    const top = recheck && recheck.top > 1 ? recheck.top : 1;
    const list = [];       // best `top` by estimate, best first
    this.solver.forEachBooking(st, cat, bank, false, true, (rows, bk, uA, uB, nMain, placements) => {
      const v = this.value(rows, bk, uA, uB, k - 1), u = utility(v);
      if (list.length === top && u < list[top - 1].u - TIE) return;
      const cand = S.candidateOf(rows, placements, bankList, this.classic);
      // equal estimates (equivalent positions): the solver's booking tie-breaks
      const same = list.findIndex(x => Math.abs(x.u - u) <= TIE);
      if (same >= 0) { if (S.tieBreakBetter(cand, list[same].cand)) list[same] = { u, v, cand, rows: Int16Array.from(rows), bk: Int8Array.from(bk), uA, uB }; return; }
      list.push({ u, v, cand, rows: Int16Array.from(rows), bk: Int8Array.from(bk), uA, uB });
      list.sort((a, b) => b.u - a.u);
      if (list.length > top) list.pop();
    });
    this.frame = null;
    let best = list[0];
    if (top > 1 && list.length > 1) {
      let bu = -Infinity;
      for (const x of list) {
        const v = this.positionValue(S.makeState(x.rows, x.bk, x.uA, x.uB), k - 1, recheck.rolls);
        const u = utility(v);
        if (u > bu + TIE) { bu = u; best = { ...x, v }; }
      }
    }
    return { placements: best.cand.placements.map(p => ({ ...p, category: S.CAT_NAMES[p.cat] })), value: best.v };
  };

  // The game looks the same after renaming every digit d to s*d + t (mod 10), s = +-1:
  // runs, pairs and ladders wrap around (9012, 0099), and the dice are uniform. So a
  // position's value is the same for all 20 renamings, which gives 20 training examples
  // per labelled position.
  const RENAME = new Map();
  function renameRow(code, sg, t) {
    const key = code * 40 + (sg > 0 ? 0 : 20) + t;
    let r = RENAME.get(key);
    if (r === undefined) {
      const c = S.dec(code).map(x => (x === S.E ? S.E : (((sg * x + t) % 10) + 10) % 10));
      r = S.enc(c); RENAME.set(key, r);
    }
    return r;
  }
  function renamePosition(p, sg, t) {
    const bank = new Array(10).fill(0);
    for (let d = 0; d < 10; d++) bank[(((sg * d + t) % 10) + 10) % 10] = p.bank[d];
    return { rows: p.rows.map(code => renameRow(code, sg, t)), bank, uA: p.uA, uB: p.uB, classic: p.classic };
  }

  // features of a position's canonical form (training)
  function canonicalFeatures(p, idx, val) {
    canonicalize(p.rows, p.bank);
    return features(canon.rows, canon.bank, p.uA, p.uB, p.classic, idx, val);
  }

  return { TIE, canonicalize, canonicalFeatures, renamePosition, features, NFEAT, MAXACTIVE, Net, Player, utility, encode, decode, LS, LQ, CLS };
});
