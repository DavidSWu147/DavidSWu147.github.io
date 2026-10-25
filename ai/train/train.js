#!/usr/bin/env node
// Trains the networks of ai/simili-ai.js and writes ai/model.json.
//
//   node ai/train/train.js [--games 40000] [--labels 40000] [--rolls 12] [--iterations 3]
//                          [--hidden 64] [--epochs 15] [--workers <cores>] [--out ai/model.json]
//                          [--partner ai/model-small.json] [--partnerShare 0.5]
//                          [--tieRule 1] [--explore 0.15] [--exploreMargin 0.02] [--exploreRounds 6]
//
// Backwards, round by round: positions at the start of rounds 2-9 come from self-play
// games; N[2] (start of round 9) learns values worked out by the exact solver, N[3]
// learns one-step look-ahead values using N[2], and so on up to N[9] (start of round 2).
// The first pass plays the games with a rough player; later passes with the computer
// player trained so far, so the positions look more like real play.
//
// --partner <model file>: in the passes still to run, a share (--partnerShare, default half)
// of the self-play games is played by that model's computer instead of the previous
// pass's, so the positions cover the way both of them play (pass 6 from pass 5 and the
// small model, say, which between them play both the SM and LM strategies). Only
// the positions change: their values are worked out as always (the exact solver, then
// one-step look-ahead with the networks of this pass).
//
// --tieRule 1: the self-play computer books as the real one does (tie margin, then the
// fewest digits) instead of always taking the best estimate. --explore p: in the first
// --exploreRounds rounds, each of its decisions is, with chance p, a random pick among
// the categories / bookings within --exploreMargin (win chance) of the best, booking
// nothing always among them unless it makes 100 unreachable (see work.js playGame).
//
// It can be stopped at any time (Ctrl+C) and started again with the same command: it
// picks up after the last finished network. Intermediate files go to ai/train/data/.
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker } = require('worker_threads');
const S = require('../simili-solver.js');
const AI = require('../simili-ai.js');
const { train, mulberry, shuffle } = require('./mlp.js');

const args = (() => {
  const a = {
    games: 40000, labels: 40000, rolls: 12, iterations: 3, hidden: 64, epochs: 15,
    workers: Math.max(1, os.cpus().length), out: path.join(__dirname, '..', 'model.json'),
    classic: 0.25, seed: 1, check: 300, verbose: 0, stopAfter: 0, partner: '', partnerShare: 0.5,
    tieRule: 0, explore: 0, exploreMargin: 0.02, exploreRounds: 6,
  };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i++) {
    const k = v[i].replace(/^--/, '');
    if (!(k in a)) { console.error('unknown option --' + k); process.exit(1); }
    a[k] = k === 'out' || k === 'partner' ? v[++i] : +v[++i];
  }
  return a;
})();
const DATA = path.join(__dirname, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ---------- worker pool ----------
const pool = [];
for (let i = 0; i < args.workers; i++) { const w = new Worker(path.join(__dirname, 'worker.js')); w.sent = new Set(); pool.push(w); }
let nextId = 0;
function runAll(jobs, progress) {
  return new Promise((resolve, reject) => {
    const results = new Array(jobs.length);
    let next = 0, done = 0;
    if (jobs.length === 0) return resolve(results);
    const feed = w => {
      if (next >= jobs.length) return;
      const i = next++, id = nextId++;
      const onMsg = m => {
        if (m.id !== id) return;
        w.off('message', onMsg);
        if (m.error) return reject(new Error(m.error));
        results[i] = m.result; done++;
        if (progress) progress(done, jobs.length);
        if (done === jobs.length) resolve(results); else feed(w);
      };
      w.on('message', onMsg);
      // each worker gets a model once, then only its id
      const job = { ...jobs[i], id };
      if (job.model && w.sent.has(job.modelId)) job.model = null; else if (job.model) w.sent.add(job.modelId);
      w.postMessage(job);
    };
    for (const w of pool) feed(w);
  });
}

// ---------- model file ----------
function loadModel() {
  if (fs.existsSync(args.out)) {
    const m = JSON.parse(fs.readFileSync(args.out, 'utf8'));
    if (m.meta && m.meta.inProgress) return m;
    if (m.meta && m.meta.iterationsDone >= args.iterations) return m;
    if (m.meta) { m.meta.inProgress = { iteration: m.meta.iterationsDone + 1, done: [] }; return m; }
  }
  return { version: 1, nets: {}, meta: { iterationsDone: 0, inProgress: { iteration: 1, done: [] }, settings: args, stats: {} } };
}
function saveModel(m) {
  const tmp = args.out + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(m));
  fs.renameSync(tmp, args.out);
}

const t0 = Date.now();
const clock = () => { const s = Math.round((Date.now() - t0) / 1000); return `[${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m${String(s % 60).padStart(2, '0')}s]`; };
const log = s => console.log(`${clock()} ${s}`);
function progressBar(what) {
  let last = 0;
  const start = Date.now();
  return (done, total) => {
    const now = Date.now();
    if (now - last < 15000 && done < total) return;
    last = now;
    const eta = done ? Math.round((now - start) / done * (total - done) / 1000) : 0;
    log(`  ${what}: ${done}/${total}${done < total ? ` (about ${Math.floor(eta / 60)} min left)` : ''}`);
  };
}

// a position as a plain key, to drop repeats
const posKey = p => p.rows.join(',') + '|' + p.bank.join('') + '|' + p.uA + p.uB + (p.classic ? 'c' : 'm');

async function main() {
  log(`SIMILI training: ${args.workers} workers, ${args.games} games, ${args.labels} labels per round, ${args.rolls} rolls per label, ${args.iterations} passes -> ${args.out}`);
  const model = loadModel();
  if (model.meta.iterationsDone) log(`Continuing from pass ${model.meta.iterationsDone} (${args.out})`);
  const partner = args.partner ? { nets: JSON.parse(fs.readFileSync(args.partner, 'utf8')).nets } : null;
  if (partner) log(`Partner: ${args.partner} plays ${Math.round(args.partnerShare * 100)}% of each pass's games`);
  const playOpts = { tieRule: args.tieRule ? 1 : 0, explore: args.explore, exploreMargin: args.exploreMargin, exploreRounds: args.exploreRounds };
  if (args.tieRule || args.explore) log(`Self-play: ${args.tieRule ? 'the real computer\'s tie rule' : 'best estimate'}${args.explore ? `, exploring ${Math.round(args.explore * 100)}% of decisions in rounds 1-${args.exploreRounds} (within ${args.exploreMargin * 100} points of the best, booking nothing always a candidate)` : ''}`);
  while (model.meta.inProgress) {
    const it = model.meta.inProgress.iteration;
    log(`Pass ${it} of ${args.iterations}`);
    // 1. positions from self-play (saved, so a restart does not replay the games)
    const posFile = path.join(DATA, `positions-${it}-${args.games}-${args.seed}.json`);
    let byK;
    if (fs.existsSync(posFile)) {
      byK = JSON.parse(fs.readFileSync(posFile, 'utf8'));
      log(`  positions from ${posFile}`);
    } else {
      // the computer from the previous pass plays (pass 1: the rough player)
      const policy = it === 1 ? null : { nets: model.nets };
      const chunk = 25, jobs = [];
      // with --partner: chunks spread evenly between the two players
      const byPartner = ci => !!partner && Math.floor((ci + 1) * args.partnerShare) > Math.floor(ci * args.partnerShare);
      for (let g = 0, ci = 0; g < args.games; g += chunk, ci++) {
        const p = byPartner(ci);
        jobs.push({ type: 'games', n: Math.min(chunk, args.games - g), seed: args.seed * 1e6 + it * 1e5 + g, classicShare: args.classic,
          model: p ? partner : policy, modelId: p ? `partner-${it}` : policy ? `play-${it}` : 'rough', opts: playOpts });
      }
      const nPartner = jobs.filter(j => j.modelId.startsWith('partner')).reduce((a, j) => a + j.n, 0);
      const own = it === 1 ? 'rough player' : 'computer player from pass ' + (it - 1);
      log(`  playing ${args.games} games (${partner ? `${args.games - nPartner} by the ${own}, ${nPartner} by ${args.partner}` : own})`);
      if (partner) model.meta.stats[`${it}-partner`] = { file: args.partner, games: nPartner };
      if (args.tieRule || args.explore) model.meta.stats[`${it}-selfplay`] = playOpts;
      const res = await runAll(jobs, progressBar('games'));
      byK = {};
      for (let k = 2; k <= 9; k++) byK[k] = [];
      for (const chunkRes of res) for (const game of chunkRes) for (let k = 2; k <= 9; k++) byK[k].push(game[k]);
      fs.writeFileSync(posFile, JSON.stringify(byK));
    }
    // 2. networks for k = 2 (start of round 9) up to 9 (start of round 2)
    for (let k = 2; k <= 9; k++) {
      if (model.meta.inProgress.done.includes(k)) continue;
      const rand = mulberry(args.seed * 7919 + it * 131 + k);
      // half the positions from this pass's games, half from earlier passes' (kept so the
      // networks do not forget positions the computer no longer steers into; without
      // them the networks swung from pass to pass)
      const older = [];
      for (let j = 1; j < it; j++) {
        const f = path.join(DATA, `positions-${j}-${args.games}-${args.seed}.json`);
        if (fs.existsSync(f)) older.push(...JSON.parse(fs.readFileSync(f, 'utf8'))[k]);
      }
      const seen = new Set(), pick = [];
      const take = (list, n) => {
        for (const p of shuffle(list.slice(), rand)) {
          if (pick.length >= n) break;
          const key = posKey(p);
          if (seen.has(key)) continue;
          seen.add(key); pick.push(p);
        }
      };
      take(byK[k], older.length ? Math.ceil(args.labels / 2) : args.labels);
      take(older, args.labels);
      take(byK[k], args.labels);
      log(`  round ${11 - k} start (k=${k}): labelling ${pick.length} positions`);
      const labelModel = { nets: model.nets };
      const chunk = k === 2 ? 4 : 10, jobs = [];
      for (let i = 0; i < pick.length; i += chunk) {
        jobs.push({ type: 'label', k, items: pick.slice(i, i + chunk), seed: args.seed * 1e7 + it * 1e6 + k * 1e5 + i, m: args.rolls,
          model: k >= 3 ? labelModel : null, modelId: `label-${it}-${k}` });
      }
      // labels are saved too, so a restart (or an experiment) does not redo them
      const labFile = path.join(DATA, `labels-${it}-${k}-${args.games}-${args.seed}.json`);
      let ys;
      if (fs.existsSync(labFile)) { ys = JSON.parse(fs.readFileSync(labFile, 'utf8')).ys; log(`  labels from ${labFile}`); }
      else {
        ys = (await runAll(jobs, progressBar('labels'))).flat();
        fs.writeFileSync(labFile, JSON.stringify({ positions: pick, ys }));
      }
      // features + training
      // In play the network sees each position's canonical renaming (simili-ai.js), so its
      // estimates are exactly the same for all 20 renamings. It still learns from all 20
      // renamings of each labelled position: on round-9 starts that gave 7.8 points of
      // error on canonical inputs, against 8.4 when trained on canonical inputs only (the
      // canonical choice jumps around between similar positions, which is harder to learn).
      const featOf = (p, y, canonical) => {
        const idx = new Int32Array(AI.MAXACTIVE), val = new Float32Array(AI.MAXACTIVE);
        const n = canonical ? AI.canonicalFeatures(p, idx, val) : AI.features(p.rows, p.bank, p.uA, p.uB, p.classic, idx, val);
        return { idx, val, n, y };
      };
      const feat = (p, y) => featOf(p, y, true);
      const expand = list => list.flatMap(s => [1, -1].flatMap(sg => Array.from({ length: 10 }, (_, t) => featOf(AI.renamePosition(s.p, sg, t), s.y, false))));
      const samples = pick.map((p, i) => ({ p, y: ys[i] }));
      const meanWin = samples.reduce((a, s) => a + s.y[0], 0) / samples.length;
      const testRand = mulberry(args.seed * 31 + k);
      log(`  training N[${k}] (average label: ${(meanWin * 100).toFixed(1)}% to win)`);
      // two networks on the two halves (the labels for the next round use one to pick and the other to value)
      // (10% of each half held out, never renamed, to measure the error on new positions)
      const half = Math.ceil(samples.length / 2);
      const rs = [samples.slice(0, half), samples.slice(half)].map((part, h) => {
        shuffle(part, testRand);
        const nt = Math.max(1, Math.floor(part.length * 0.1));
        return train(expand(part.slice(nt)), { test: part.slice(0, nt).map(s => feat(s.p, s.y)), hidden: args.hidden, epochs: args.epochs, l2: 3e-4,
          seed: args.seed + k * 2 + h, log: args.verbose ? log : null });
      });
      const r = { testMAE: [0, 1, 2].map(o => (rs[0].testMAE[o] + rs[1].testMAE[o]) / 2), trainLoss: (rs[0].trainLoss + rs[1].trainLoss) / 2, testLoss: (rs[0].testLoss + rs[1].testLoss) / 2 };
      log(`  N[${k}]: test error (mean abs, one network) win ${(r.testMAE[0] * 100).toFixed(2)} points, score ${(r.testMAE[1] * 150).toFixed(2)}, Quad ${(r.testMAE[2] * 100).toFixed(2)} points`);
      model.nets[k] = rs.map(x => x.spec);
      model.meta.stats[`${it}-${k}`] = { labels: pick.length, meanWin, testMAE: r.testMAE, trainLoss: r.trainLoss, testLoss: r.testLoss };
      // N[2] against the exact solver (all 220 rolls) on positions it was not trained on
      if (k === 2 && args.check > 0) {
        const rest = shuffle(byK[2].filter(p => !seen.has(posKey(p))), rand).slice(0, args.check);
        if (rest.length) {
          const exact = (await runAll(rest.map((p, i) => ({ type: 'exact2', items: [p] })), progressBar('exact check'))).flat();
          const pl = [false, true].map(classic => new AI.Player({ classic, model: { nets: { 2: model.nets[2] } } }));
          let err = 0;
          rest.forEach((p, i) => { const v = pl[p.classic ? 1 : 0].value(p.rows, p.bank, p.uA, p.uB, 2); err += Math.abs(v[0] - exact[i][0]); });
          model.meta.stats[`${it}-2-exact`] = { n: rest.length, maeWin: err / rest.length };
          log(`  N[2] against the exact solver on ${rest.length} new positions: mean abs error ${(err / rest.length * 100).toFixed(2)} points of win chance`);
        }
      }
      model.meta.inProgress.done.push(k);
      saveModel(model);
      log(`  saved ${args.out}`);
      if (args.stopAfter === k) { log('Stopping (--stopAfter).'); for (const w of pool) w.terminate(); return; }
    }
    model.meta.iterationsDone = it;
    model.meta.inProgress = it < args.iterations ? { iteration: it + 1, done: [] } : null;
    model.meta.finished = model.meta.inProgress ? null : new Date().toISOString();
    saveModel(model);
    // a copy of each pass's model, to compare them with evaluate.js and keep the best
    const copy = args.out.replace(/\.json$/, '') + `-pass${it}.json`;
    fs.copyFileSync(args.out, copy);
    log(`  pass ${it} done; copy in ${copy}`);
  }
  log('Done.');
  for (const w of pool) w.terminate();
}
main().catch(e => { console.error(e); process.exit(1); });
