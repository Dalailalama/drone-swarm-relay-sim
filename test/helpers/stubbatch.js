// Stand-in for tools/batch.js inside the server's worker thread (test only,
// reached through createApp's workerBatchPath). It lets the time-budget tests
// control progress deterministically instead of racing real simulation speed.
//   label 'steady': 12 progress heartbeats 100 ms apart (~1.2 s), then a result
//   label 'stall':  one heartbeat at 50%, then silence (a worker that hangs)
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function runBatch(cfg, progress, heartbeat) {
  if (cfg.label === 'stall') {
    heartbeat(0.5);
    pause(30000); // never returns in time; the server terminates the worker
  } else {
    for (let i = 1; i <= 12; i++) {
      heartbeat(i / 13);
      pause(100);
    }
  }
  return { rows: [{}], summary: [], md: 'ok', csv: '' };
}

module.exports = { runBatch };
