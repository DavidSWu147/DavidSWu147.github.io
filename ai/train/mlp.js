// Training for the networks in ai/simili-ai.js: one hidden ReLU layer, three sigmoid
// outputs, sparse inputs, squared error, Adam. Plain JavaScript, no dependencies.
'use strict';
const AI = require('../simili-ai.js');

// samples: [{ idx: Int32Array, val: Float32Array, n, y: [3] }]
// returns { spec (for AI.Net / model.json), trainLoss, testLoss, testMAE }
function train(samples, opts) {
  const H = opts.hidden || 64, NF = opts.nfeat || AI.NFEAT;
  const epochs = opts.epochs || 40, batch = opts.batch || 128, lr0 = opts.lr || 0.003;
  const outW = opts.outWeights || [1, 1, 0.3];
  const rand = mulberry(opts.seed || 1);
  const w1 = new Float32Array(NF * H), b1 = new Float32Array(H), w2 = new Float32Array(3 * H), b2 = new Float32Array(3);
  // init: inputs are sparse (about 25 active, mostly 0/1)
  const s1 = Math.sqrt(2 / 25), s2 = Math.sqrt(1 / H);
  for (let i = 0; i < w1.length; i++) w1[i] = gauss(rand) * s1;
  for (let i = 0; i < w2.length; i++) w2[i] = gauss(rand) * s2;
  for (let o = 0; o < 3; o++) {   // start at the mean target
    const m = samples.reduce((a, s) => a + s.y[o], 0) / samples.length;
    b2[o] = Math.log(Math.max(1e-3, m) / Math.max(1e-3, 1 - m));
  }
  const params = [w1, b1, w2, b2];
  const m = params.map(p => new Float32Array(p.length)), v = params.map(p => new Float32Array(p.length));
  const g = params.map(p => new Float32Array(p.length));
  const touched = new Uint8Array(NF);
  // hold out 10% to watch for overfitting
  // (opts.test: a given test set; otherwise a share of the samples)
  let test, tr;
  if (opts.test) { test = opts.test; tr = samples.slice(); }
  else {
    const order = samples.map((s, i) => i);
    shuffle(order, rand);
    const nTest = Math.max(1, Math.floor(samples.length * (opts.testShare || 0.1)));
    test = order.slice(0, nTest).map(i => samples[i]); tr = order.slice(nTest).map(i => samples[i]);
  }
  const h = new Float32Array(H), out = new Float64Array(3), dz = new Float64Array(3), dh = new Float32Array(H);
  const forward = s => {
    h.set(b1);
    for (let a = 0; a < s.n; a++) { const base = s.idx[a] * H, x = s.val[a]; for (let j = 0; j < H; j++) h[j] += x * w1[base + j]; }
    for (let o = 0; o < 3; o++) {
      let z = b2[o];
      for (let j = 0; j < H; j++) if (h[j] > 0) z += w2[o * H + j] * h[j];
      out[o] = 1 / (1 + Math.exp(-z));
    }
  };
  const lossOf = list => {
    let L = 0, mae = [0, 0, 0];
    for (const s of list) { forward(s); for (let o = 0; o < 3; o++) { const e = out[o] - s.y[o]; L += outW[o] * e * e; mae[o] += Math.abs(e); } }
    return { loss: L / list.length, mae: mae.map(x => x / list.length) };
  };
  let step = 0, best = null, bestLoss = Infinity;
  for (let ep = 0; ep < epochs; ep++) {
    shuffle(tr, rand);
    const lr = lr0 * (ep < epochs * 0.7 ? 1 : 0.3);
    for (let b0 = 0; b0 < tr.length; b0 += batch) {
      const bs = Math.min(batch, tr.length - b0);
      for (const gg of g) gg.fill(0);
      touched.fill(0);
      for (let t = 0; t < bs; t++) {
        const s = tr[b0 + t];
        forward(s);
        // d loss / d z for sigmoid outputs with squared error
        for (let o = 0; o < 3; o++) dz[o] = 2 * outW[o] * (out[o] - s.y[o]) * out[o] * (1 - out[o]) / bs;
        dh.fill(0);
        for (let o = 0; o < 3; o++) {
          g[3][o] += dz[o];
          for (let j = 0; j < H; j++) if (h[j] > 0) { g[2][o * H + j] += dz[o] * h[j]; dh[j] += dz[o] * w2[o * H + j]; }
        }
        for (let j = 0; j < H; j++) if (h[j] <= 0) dh[j] = 0;
        for (let j = 0; j < H; j++) g[1][j] += dh[j];
        for (let a = 0; a < s.n; a++) {
          const f = s.idx[a], base = f * H, x = s.val[a];
          touched[f] = 1;
          for (let j = 0; j < H; j++) g[0][base + j] += x * dh[j];
        }
      }
      // Adam (lazy on the first layer: only rows that had gradient this batch)
      step++;
      const c1 = 1 - Math.pow(0.9, step), c2 = 1 - Math.pow(0.999, step);
      const upd = (pi, i) => {
        const gi = g[pi][i] + (opts.l2 || 1e-5) * params[pi][i];
        m[pi][i] = 0.9 * m[pi][i] + 0.1 * gi;
        v[pi][i] = 0.999 * v[pi][i] + 0.001 * gi * gi;
        params[pi][i] -= lr * (m[pi][i] / c1) / (Math.sqrt(v[pi][i] / c2) + 1e-8);
      };
      for (let f = 0; f < NF; f++) if (touched[f]) for (let j = 0; j < H; j++) upd(0, f * H + j);
      for (let i = 0; i < H; i++) upd(1, i);
      for (let i = 0; i < 3 * H; i++) upd(2, i);
      for (let i = 0; i < 3; i++) upd(3, i);
    }
    const te = lossOf(test);
    if (te.loss < bestLoss) { bestLoss = te.loss; best = params.map(p => p.slice()); }
    if (opts.log) opts.log(`  epoch ${ep + 1}/${epochs}: test loss ${te.loss.toFixed(5)}, mean abs error win ${(te.mae[0] * 100).toFixed(2)}%`);
  }
  for (let i = 0; i < params.length; i++) params[i].set(best[i]);
  const trL = lossOf(tr), teL = lossOf(test);
  return {
    spec: { H, w1: AI.encode(w1), b1: AI.encode(b1), w2: AI.encode(w2), b2: AI.encode(b2) },
    trainLoss: trL.loss, testLoss: teL.loss, testMAE: teL.mae, nTrain: tr.length, nTest: test.length,
  };
}

function mulberry(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }
function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

module.exports = { train, mulberry, shuffle };
