// canStillReach100 (simili-solver.js) must never call a winnable position lost:
// wherever it says "lost", the exact solver must find 0% to win. Positions with 1 or 2
// rounds left, many of them thinned out (rows emptied) so that they sit near the edge.
//   node ai/test/verify-reach.js [n1] [n2]
const { S, loadGame, rng, randomPosition, greedyPosition } = require('./harness.js');
const G = loadGame();
const N1 = +(process.argv[2] || 2000), N2 = +(process.argv[3] || 60), rand = rng(4242);
const E = S.enc([10, 10, 10, 10]);
let fails = 0;
for (const [k, N] of [[1, N1], [2, N2]]) {
  let lost = 0, exactZero = 0, both = 0, t0 = Date.now();
  for (let t = 0; t < N; t++) {
    const classic = t % 3 === 0;
    const sv = new S.Solver({ classic });
    const { ps, bank } = t % 2 ? randomPosition(G, rand, 10 - k, classic, sv, 0.5) : greedyPosition(G, rand, 10 - k, classic, sv);
    const st0 = S.fromGame(ps, bank).state;
    // thin out: empty some rows (keeps the free-book state; a Bonus II already used stays used)
    const rows = Int16Array.from(st0.rows);
    const drop = Math.floor(rand() * 9);
    for (let j = 0; j < drop; j++) rows[Math.floor(rand() * 15)] = E;
    const st = S.makeState(rows, st0.bank, st0.usedA, st0.usedB);
    const alive = S.canStillReach100(st.rows, st.usedA, st.usedB, k, classic);
    const win = sv.analyzeRoundStart(st, k).categories.some(c => c.value[0] > 0);
    if (!alive) lost++;
    if (!win) exactZero++;
    if (!alive && !win) both++;
    if (!alive && win) { fails++; if (fails <= 5) console.log('FAIL: called lost but the solver can win', JSON.stringify({ k, classic, rows: [...st.rows], bank: [...st.bank], uA: st.usedA, uB: st.usedB })); }
  }
  console.log(`k=${k}: ${N} positions, ${exactZero} lost for sure (exact), ${lost} called lost by the check (all of them truly lost: ${both === lost}) - ${((Date.now() - t0) / N).toFixed(0)} ms each`);
}
console.log(fails ? `${fails} FAILURES` : 'ALL OK');
process.exit(fails ? 1 : 0);
