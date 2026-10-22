// The computer player's network sees positions in canonical form: every one of the
// 20 digit renamings of a position must get exactly the same estimate, and a booking
// evaluated with the shortcut (other categories precomputed) the same as without.
//   node ai/test/verify-canonical.js [model] [n]
const S = require('../simili-solver.js');
const AI = require('../simili-ai.js');
const fs = require('fs'), path = require('path');
const model = JSON.parse(fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'model-small.json'), 'utf8'));
const N = +(process.argv[3] || 300);
const pl = new AI.Player({ classic: false, model });
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const legal = [0, 1, 2].map(c => { const l = []; for (let x = 0; x < S.LEGAL[c].length; x++) if (S.LEGAL[c][x]) l.push(x); return l; });
let bad = 0, maxd = 0;
for (let t = 0; t < N; t++) {
  const rows = []; for (let c = 0; c < 3; c++) for (let i = 0; i < 5; i++) rows.push(rnd() < 0.4 ? S.enc([S.E, S.E, S.E, S.E]) : legal[c][Math.floor(rnd() * legal[c].length)]);
  const bank = new Array(10).fill(0); const nb = Math.floor(rnd() * 14); for (let i = 0; i < nb; i++) bank[Math.floor(rnd() * 10)]++;
  const k = 2 + Math.floor(rnd() * 8);
  const p = { rows, bank, uA: 0, uB: 0, classic: false };
  const ref = pl.value(rows, bank, 0, 0, k);
  for (const sg of [1, -1]) for (let s = 0; s < 10; s++) {
    const q = AI.renamePosition(p, sg, s);
    const v = pl.value(q.rows, q.bank, 0, 0, k);
    const d = Math.max(...v.map((x, i) => Math.abs(x - ref[i])));
    if (d > maxd) maxd = d;
    if (d !== 0) bad++;
  }
}
console.log(`${N} random positions x 20 renamings: largest difference ${maxd}${bad ? `, ${bad} not identical` : ' (all identical)'}`);
// shortcut vs full features inside a booking search
let maxs = 0, cnt = 0;
for (let t = 0; t < 20; t++) {
  const rows = []; for (let c = 0; c < 3; c++) for (let i = 0; i < 5; i++) rows.push(rnd() < 0.5 ? S.enc([S.E, S.E, S.E, S.E]) : legal[c][Math.floor(rnd() * legal[c].length)]);
  const bank = new Int8Array(10); for (let i = 0; i < 8; i++) bank[Math.floor(rnd() * 10)]++;
  const st = S.makeState(rows, bank, 1, 1);
  for (let cat = 0; cat < 3; cat++) {
    const base = pl.baseFor(st.rows, cat, 5);
    pl.solver.forEachBooking(st, cat, bank, false, false, (r2, bk, uA, uB) => {
      const a = pl.pair(r2, bk, uA, uB, 5, base), b = pl.pair(r2, bk, uA, uB, 5);
      for (let h = 0; h < 2; h++) for (let o = 0; o < 3; o++) maxs = Math.max(maxs, Math.abs(a[h][o] - b[h][o]));
      cnt++;
    });
  }
}
console.log(`${cnt} bookings: shortcut vs full features, largest difference ${maxs.toExponential(2)}`);
process.exit(bad || maxs > 1e-5 ? 1 : 0);
