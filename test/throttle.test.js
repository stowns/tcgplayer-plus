import test from 'node:test';
import assert from 'node:assert/strict';
import { createThrottle } from '../src/lib/throttle.js';

const noSleep = () => Promise.resolve();

test('throttle never runs more than `concurrency` tasks at once', async () => {
  let running = 0;
  let peak = 0;
  const t = createThrottle({ concurrency: 2, minIntervalMs: 0, sleep: noSleep });
  const task = () => {
    running += 1;
    peak = Math.max(peak, running);
    return new Promise((r) => setTimeout(() => { running -= 1; r('done'); }, 5));
  };
  const results = await Promise.all(Array.from({ length: 8 }, () => t.run(task)));
  assert.equal(peak, 2);
  assert.deepEqual(results, Array(8).fill('done'));
});

test('throttle propagates a task failure without stalling the queue', async () => {
  const t = createThrottle({ concurrency: 1, minIntervalMs: 0, sleep: noSleep });
  await assert.rejects(t.run(async () => { throw new Error('boom'); }));
  assert.equal(await t.run(async () => 'ok'), 'ok');
  assert.equal(t.active, 0);
  assert.equal(t.pending, 0);
});

test('throttle waits between starts', async () => {
  const waits = [];
  const t = createThrottle({
    concurrency: 1,
    minIntervalMs: 100,
    sleep: (ms) => { waits.push(ms); return Promise.resolve(); },
  });
  await t.run(async () => 1);
  await t.run(async () => 2);
  assert.equal(waits.length, 2);
  assert.ok(waits[1] > 0, 'the second start should be delayed');
});
