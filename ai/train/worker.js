// Worker thread for ai/train/train.js: runs one job from work.js and sends back the result.
'use strict';
const { parentPort } = require('worker_threads');
const { handle } = require('./work.js');
parentPort.on('message', msg => {
  try { parentPort.postMessage({ id: msg.id, result: handle(msg) }); }
  catch (e) { parentPort.postMessage({ id: msg.id, error: String(e && e.stack || e) }); }
});
