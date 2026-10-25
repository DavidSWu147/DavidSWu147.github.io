// Web Worker for SIMILI: odds previews and the round-8 Hint. Keeps its solver (and
// caches) between requests.
//  - default message: one category over a slice of the 220 rolls (odds previews). Previews
//    only show win chances, points if win and Quad, so the 4th value need not be exact.
//  - { type: 'bound', sample: k }: the quick (roll-free) upper bound for one round-9 start
//    position (round-8 Hint), and its estimate from every k-th roll
//  - { type: 'screen', sample: k }: that estimate alone
//  - { type: 'alt' }: the tie-break values of that position's other round-9 categories
//  - { type: 'solve', order }: that position's value, or null if it cannot beat the given best
//    (order: the rolls to solve first; per-roll wins come back as per);
//    with bound: null the per-roll bounds are worked out first and sent back too
//  - { type: 'aiCategory', k, cat }: the computer player's value for one category at the
//    start of a round with k rounds left (simili-ai.js; exact for k <= 2)
//  - { type: 'aiBooking', k, cat, bankList, recheckRolls }: the computer player's booking
//  - { type: 'aiRank', k, cat, bankList, top }: its `top` bookings by the network alone, best first
//  - { type: 'aiValues', k, states }: the network's utility for each of the states
//  - { type: 'aiShortlist' / 'aiRecheck' / 'aiPick', ... }: aiBooking's three steps (Rounds 1-7)
importScripts('simili-solver.js');
let solver = null, solverClassic = null;
// Smaller caches than the solver's defaults: a page runs up to 8 of these workers at once,
// and with the defaults one worker reached about 1.4 GB on a big Round 8 Sequence search
// (enough for the browser to kill the page). With these, about 0.3 GB, at roughly 20% less speed.
const CACHE = { maxTables: 20000, maxMemo: 200000 };
// computer player: simili-ai.js and its model (model.json, else the small model-small.json)
let aiModel = null;
const aiPlayers = {};
function loadModel() {
  if (!aiModel) {
    const get = f => fetch(f).then(r => (r.ok ? r.json() : Promise.reject(new Error(f + ': ' + r.status))));
    aiModel = get('model.json').catch(() => get('model-small.json'));
  }
  return aiModel;
}
async function aiJob(m) {
  if (typeof SimiliAI === 'undefined') importScripts('simili-ai.js');
  const model = await loadModel();
  const key = m.classic ? 'c' : 'm';
  if (!aiPlayers[key]) aiPlayers[key] = new SimiliAI.Player({ classic: !!m.classic, model, solver: new SimiliSolver.Solver({ classic: !!m.classic, exactLoss: false, ...CACHE }) });
  const pl = aiPlayers[key];
  const st = SimiliSolver.makeState(m.rows, m.bank, m.usedA, m.usedB);
  if (m.type === 'aiCategory') {
    if (m.k <= 2) return { raw: pl.solver.categoryValue(st, m.cat, m.k) };
    const v = pl.categoryValues(st, m.k, undefined, false, [m.cat])[0];
    return { value: { v, u: SimiliAI.utility(v) } };
  }
  // the network's value (utility) of each of m.states with m.k rounds left (orders the Round 8 search)
  if (m.type === 'aiValues') return { values: m.states.map(p => SimiliAI.utility(pl.value(Int16Array.from(p.rows), Int8Array.from(p.bank), p.usedA, p.usedB, m.k))) };
  // the network's ranking of the bookings (orders the computer's exact Round 8 search)
  if (m.type === 'aiRank') return { ranked: pl.rankBookings(st, m.cat, m.bankList, m.k, m.top || 40) };
  // the booking in Rounds 1-7 in three steps, so the page can spread the re-checks over the
  // workers (same result as aiBooking): the shortlist, each item's re-check over all 220
  // rolls (m.rows etc.: that item's position), then the choice among the re-checked
  if (m.type === 'aiShortlist') {
    const sl = pl.bookingShortlist(st, m.cat, m.bankList, m.k, m.top || 6);
    return sl.best ? { best: pl.bookingResult(sl.best) } : { list: sl.list };
  }
  if (m.type === 'aiRecheck') {
    const v = pl.positionValue(st, m.k - 1);
    return { v, u: SimiliAI.utility(v) };
  }
  if (m.type === 'aiPick') return { best: pl.bookingResult(pl.pickBooking(m.list, m.k)) };
  // the re-check over all 220 rolls in Rounds 2-7 (a few seconds); in Round 8 it uses the
  // exact solver, so a sample of rolls there
  let rolls = 'all';
  if (m.k <= 3) {
    rolls = [];
    for (let i = 0; i < (m.recheckRolls || 8); i++) rolls.push([0, 1, 2].map(() => Math.floor(Math.random() * 10)));
  }
  return { best: pl.chooseBooking(st, m.cat, m.bankList, m.k, { top: 6, rolls }) };
}
self.onmessage = e => {
  const m = e.data;
  if (m.type === 'aiCategory' || m.type === 'aiBooking' || m.type === 'aiRank' || m.type === 'aiValues' || m.type === 'aiShortlist' || m.type === 'aiRecheck' || m.type === 'aiPick') {
    aiJob(m).then(r => self.postMessage({ id: m.id, ...r }), err => self.postMessage({ id: m.id, error: String(err && err.message || err) }));
    return;
  }
  if (!solver || solverClassic !== m.classic) { solver = new SimiliSolver.Solver({ classic: m.classic, exactLoss: false, ...CACHE }); solverClassic = m.classic; }
  const st = SimiliSolver.makeState(m.rows, m.bank, m.usedA, m.usedB);
  if (m.type === 'screen') {
    self.postMessage({ id: m.id, screen: solver.screenValue(st, 'sample', m.sample) });
  } else if (m.type === 'alt') {
    self.postMessage({ id: m.id, alt: solver.altValues(st, 2) });
  } else if (m.type === 'bound') {
    self.postMessage({ id: m.id, bound: solver.quickBound(st), screen: m.sample ? solver.screenValue(st, 'sample', m.sample) : null });
  } else if (m.type === 'solve') {
    const { cmp3, cmp } = { cmp3: SimiliSolver.compareFirst3, cmp: SimiliSolver.compareValues };
    const best = m.best;
    // phase 1: win, points if win and Quad only; phase 2: all four values, ties to the booking tie-breaks
    const beats = m.phase === 1
      ? v => best === null || cmp3(v, best) >= 0
      : v => best === null || cmp(v, best) > 0 || (cmp(v, best) === 0 && m.tieWins);
    // m.quickFirst (a position whose quick bound was not worked out ahead): if even the quick
    // bound cannot reach the best so far, it is skipped without the per-roll bounds
    if (m.quickFirst && best !== null && m.phase === 1) {
      const q = solver.quickBound(st);
      if (cmp3(q.ub, best) < 0) { self.postMessage({ id: m.id, v: null, bound: q }); return; }
    }
    const bound = m.bound || solver.positionBound(st);
    solver.exactLoss = m.phase !== 1;
    // m.order: the roll order to use (see valueWithCutoff); the per-roll wins of the
    // returned value's category come back as per (for the next roll order)
    const v = solver.valueWithCutoff(st, bound, beats, { order: m.order || null, record: true });
    solver.exactLoss = false;
    self.postMessage({ id: m.id, v, bound: m.bound ? undefined : bound, per: v && solver.lastPer ? Array.from(solver.lastPer) : null });
  } else {
    solver.exactLoss = false;
    const v = solver.categoryValueRange(st, m.cat, m.roundsLeft, m.r0, m.r1);
    self.postMessage({ id: m.id, v });
  }
};
