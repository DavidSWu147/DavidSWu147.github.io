// Web Worker for SIMILI: odds previews and the round-8 Hint. Keeps its solver (and
// caches) between requests.
//  - default message: one category over a slice of the 220 rolls (odds previews). Previews
//    only show win chances, points if win and Quad, so the 4th value need not be exact.
//  - { type: 'bound' }: the quick (roll-free) upper bound for one round-9 start position (round-8 Hint)
//  - { type: 'solve' }: that position's value, or null if it cannot beat the given best;
//    with bound: null the per-roll bounds are worked out first and sent back too
importScripts('simili-solver.js');
let solver = null, solverClassic = null;
self.onmessage = e => {
  const m = e.data;
  if (!solver || solverClassic !== m.classic) { solver = new SimiliSolver.Solver({ classic: m.classic, exactLoss: false }); solverClassic = m.classic; }
  const st = SimiliSolver.makeState(m.rows, m.bank, m.usedA, m.usedB);
  if (m.type === 'bound') {
    self.postMessage({ id: m.id, bound: solver.quickBound(st) });
  } else if (m.type === 'solve') {
    const { cmp3, cmp } = { cmp3: SimiliSolver.compareFirst3, cmp: SimiliSolver.compareValues };
    const best = m.best;
    // phase 1: win, points if win and Quad only; phase 2: all four values, ties to the booking tie-breaks
    const beats = m.phase === 1
      ? v => best === null || cmp3(v, best) >= 0
      : v => best === null || cmp(v, best) > 0 || (cmp(v, best) === 0 && m.tieWins);
    const bound = m.bound || solver.positionBound(st);
    solver.exactLoss = m.phase !== 1;
    const v = solver.valueWithCutoff(st, bound, beats);
    solver.exactLoss = false;
    self.postMessage({ id: m.id, v, bound: m.bound ? undefined : bound });
  } else {
    solver.exactLoss = false;
    const v = solver.categoryValueRange(st, m.cat, m.roundsLeft, m.r0, m.r1);
    self.postMessage({ id: m.id, v });
  }
};
