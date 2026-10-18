// Web Worker for SIMILI previews: evaluates one category over a slice of the
// 220 rolls. Keeps its solver (and cache) between requests.
importScripts('simili-solver.js');
let solver = null, solverClassic = null;
self.onmessage = e => {
  const { id, rows, bank, usedA, usedB, classic, cat, roundsLeft, r0, r1 } = e.data;
  if (!solver || solverClassic !== classic) { solver = new SimiliSolver.Solver({ classic }); solverClassic = classic; }
  const st = SimiliSolver.makeState(rows, bank, usedA, usedB);
  const v = solver.categoryValueRange(st, cat, roundsLeft, r0, r1);
  self.postMessage({ id, v });
};
