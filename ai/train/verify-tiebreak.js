// The round-9 Hint picks, among bookings equal on all values and on the end-of-round
// score, the one whose round-10 second-best category (then worst) is best.
//   node ai/test/verify-tiebreak.js [n] [seed]
const { S, loadGame, rng, greedyPosition } = require('./harness.js');
const G = loadGame();
const N = +(process.argv[2] || 20), seed = +(process.argv[3] || 3);
const cmp = S.compareValues;
let bad = 0, decided = 0;
for (let t = 0; t < N; t++) {
  const rand = rng(seed * 1000 + t);
  const classic = t % 4 === 3;
  const sv = new S.Solver({ classic });
  const { ps, bank } = greedyPosition(G, rand, 8, classic, sv);
  const { state, bankList } = S.fromGame(ps, bank);
  const roll = [0, 1, 2].map(() => Math.floor(rand() * 10));
  const cat = Math.floor(rand() * 3);
  const bl = bankList.concat(roll.map(d => ({ digit: d, used: false })));
  const pick = sv.bestBooking(state, cat, bl, 2);
  // brute force: every booking with its value, end score and second/worst categories
  const B = new S.Solver({ classic });
  const bk = new Int8Array(10); for (const b of bl) if (!b.used) bk[b.digit]++;
  const all = [];
  B.forEachBooking(state, cat, bk, false, true, (rows, b2, uA, uB, nMain, placements) => {
    const st = S.makeState(rows, b2, uA, uB);
    const vs = [0, 1, 2].map(c => B.categoryValue(st, c, 1)).sort((x, y) => S.compareFirst3(y, x));
    // (described the way the solver reports a booking: new rows fullest first, see candidateOf)
    const shown = S.candidateOf(rows, placements, bl, classic).placements;
    all.push({ v: B.value(st, 1), now: S.terminalScore(rows, classic), alt: [vs[1][0], vs[1][1], vs[2][0], vs[2][1]], desc: shown.map(p => p.digit + '' + p.cat + p.row + p.col + (p.bonus || '')).join(' ') });
  });
  const key = a => [...a.v, a.now, ...a.alt];
  const lex = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
  all.sort((a, b) => lex(key(b), key(a)));
  const top = all[0];
  const tiedVnow = all.filter(a => cmp(a.v, top.v) === 0 && a.now === top.now);
  const altSpread = new Set(tiedVnow.map(a => a.alt.join())).size > 1;
  if (altSpread) decided++;
  const desc = pick.placements.map(p => p.digit + '' + p.cat + p.row + p.col + (p.bonus || '')).join(' ');
  const mine = all.find(a => a.desc === desc);
  const ok = mine && lex(key(mine), key(top)) === 0;
  if (!ok) bad++;
  console.log(`#${t} ${S.CAT_NAMES[cat]} roll ${roll} | ${all.length} bookings, ${tiedVnow.length} equal on values+score${altSpread ? ', second/worst category decides' : ''} | ${ok ? 'ok' : 'WRONG ' + desc + ' vs ' + top.desc}`);
}
console.log(bad ? `${bad} WRONG` : `ALL OK (${decided} decided by the new tie-break)`);
process.exit(bad ? 1 : 0);
