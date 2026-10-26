#!/usr/bin/env node
// Plays whole games with the computer player and with a simple greedy player on the
// same dice, and reports how often each reaches 100 (and how much each uses Ladders).
//
//   node ai/train/evaluate.js [--games 200] [--model ai/model.json] [--catRolls 0] [--workers <cores>] [--classic 0]
//     [--recheckAll 1] [--margins 1] [--from 0]   (0 / 0: re-check on 8 random rolls in every round, no tie margins, as before)
//
// catRolls: 0 = category choice over all 220 rolls (as in play); n = a sample of n rolls (faster).
'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { Worker } = require('worker_threads');
const { mulberry } = require('./mlp.js');

const args = { games: 200, model: path.join(__dirname, '..', 'model.json'), catRolls: 0, workers: os.cpus().length, classic: 0, seed: 99, greedy: 1, top: 6, recheckRolls: 8, recheckAll: 1, margins: 1, from: 0 };
const v = process.argv.slice(2);
for (let i = 0; i < v.length; i++) { const k = v[i].replace(/^--/, ''); if (!(k in args)) { console.error('unknown option --' + k); process.exit(1); } args[k] = k === 'model' ? v[++i] : +v[++i]; }
const model = JSON.parse(fs.readFileSync(args.model, 'utf8'));

const pool = [];
for (let i = 0; i < args.workers; i++) { const w = new Worker(path.join(__dirname, 'worker.js')); w.sent = false; pool.push(w); }
function runAll(jobs, onEach) {
  return new Promise((resolve, reject) => {
    const res = new Array(jobs.length); let next = 0, done = 0, id = 0;
    const feed = w => {
      if (next >= jobs.length) return;
      const i = next++, myId = id++;
      const h = m => { if (m.id !== myId) return; w.off('message', h); if (m.error) return reject(new Error(m.error)); res[i] = m.result; done++; onEach(done, jobs.length, res[i], jobs[i]); if (done === jobs.length) resolve(res); else feed(w); };
      w.on('message', h);
      const job = { ...jobs[i], id: myId };
      if (job.policy === 'ai') { if (w.sent) job.model = null; else { job.model = model; w.sent = true; } }
      w.postMessage(job);
    };
    for (const w of pool) feed(w);
  });
}

(async () => {
  const rand = mulberry(args.seed);
  const jobs = [];
  for (let g = 0; g < args.games; g++) {
    const rolls = Array.from({ length: 10 }, () => [0, 1, 2].map(() => Math.floor(rand() * 10)));
    if (g < args.from) continue;   // --from n: only games n.. (the same dice as a full run)
    for (const policy of args.greedy ? ['ai', 'greedy'] : ['ai']) jobs.push({ type: 'evalGame', rolls, classic: !!args.classic, policy, modelId: policy === 'ai' ? 'eval' : 'none', catRolls: args.catRolls || 0, recheck: args.top ? { top: args.top, rolls: args.recheckRolls, all: !!args.recheckAll } : null, margins: args.margins ? null : false });
  }
  const t0 = Date.now();
  const tally = { ai: [], greedy: [] };
  await runAll(jobs, (done, total, r, job) => {
    tally[job.policy].push(r);
    if (done % 20 === 0 || done === total) {
      const line = p => { const t = tally[p]; if (!t.length) return ''; const w = t.filter(x => x.win); return `${p} ${(100 * w.length / t.length).toFixed(1)}% wins (${t.length} games, ${w.length ? (w.reduce((a, x) => a + x.score, 0) / w.length).toFixed(1) : '-'} if win)`; };
      console.log(`[${Math.round((Date.now() - t0) / 1000)}s] ${line('ai')} | ${line('greedy')}`);
    }
  });
  const ai = tally.ai;
  const est = ai.filter(x => x.estimateRound2 !== null);
  console.log(`computer: booked nothing in round 1 in ${ai.filter(x => x.round1Booked === 0).length} of ${ai.length} games`);
  if (est.length) console.log(`computer's own estimate at the start of round 2: ${(100 * est.reduce((a, x) => a + x.estimateRound2, 0) / est.length).toFixed(1)}% on average; actual wins ${(100 * ai.filter(x => x.win).length / ai.length).toFixed(1)}%`);
  console.log(`Quad: computer ${ai.filter(x => x.quad).length}/${ai.length}` + (tally.greedy.length ? `, greedy ${tally.greedy.filter(x => x.quad).length}/${tally.greedy.length}` : ''));
  const lad = list => `Ladder in ${list.filter(x => x.ladUsed > 0).length}/${list.length} games, ${list.reduce((a, x) => a + (x.ladDone || 0), 0)} complete Ladder rows (${(list.reduce((a, x) => a + (x.ladDone || 0), 0) / list.length).toFixed(2)} a game)`;
  console.log(`Ladder: computer ${lad(ai)}` + (tally.greedy.length ? ` | greedy ${lad(tally.greedy)}` : ''));
  for (const w of pool) w.terminate();
})().catch(e => { console.error(e); process.exit(1); });
