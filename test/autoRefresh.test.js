import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutoRefresh, formatCountdown } from '../src/lib/autoRefresh.js';

/** A clock that only moves when told to, with one heartbeat timer. */
function fakeClock() {
  let time = 1_000_000;
  let beat = null;
  let cleared = 0;
  return {
    now: () => time,
    setTimer: (fn) => { beat = fn; return 'timer'; },
    clearTimer: () => { beat = null; cleared += 1; },
    /** Let `seconds` pass, one heartbeat a second. */
    advance(seconds) { for (let i = 0; i < seconds; i += 1) { time += 1000; if (beat) beat(); } },
    get ticking() { return beat !== null; },
    get cleared() { return cleared; },
  };
}
const make = (clock, extra = {}) => {
  const ticks = [];
  const counts = [];
  const refresh = createAutoRefresh({
    intervalSeconds: 10, onTick: () => { ticks.push(clock.now()); }, onCountdown: (s) => counts.push(s),
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...extra,
  });
  return { refresh, ticks, counts };
};

test('nothing happens until it is started', () => {
  const clock = fakeClock();
  const { refresh, ticks } = make(clock);
  clock.advance(60);
  assert.equal(ticks.length, 0);
  assert.equal(refresh.isRunning, false);
  assert.equal(refresh.secondsUntilNext(), null);
});

test('it refreshes once every interval, the first one a full interval after starting', () => {
  const clock = fakeClock();
  const { refresh, ticks } = make(clock);
  refresh.start();
  clock.advance(9);
  assert.equal(ticks.length, 0);
  clock.advance(1);
  assert.equal(ticks.length, 1);
  clock.advance(30);
  assert.equal(ticks.length, 4);
});

test('the countdown is reported every second', () => {
  const clock = fakeClock();
  const { refresh, counts } = make(clock);
  refresh.start();
  clock.advance(3);
  assert.deepEqual(counts, [10, 9, 8, 7]);
  assert.equal(refresh.secondsUntilNext(), 7);
  clock.advance(7);
  assert.equal(counts.at(-1), 10, 'it starts over after a refresh');
});

test('an interval of a few seconds works to the second', () => {
  const clock = fakeClock();
  const { refresh, ticks } = make(clock, { intervalSeconds: 5 });
  refresh.start();
  clock.advance(20);
  assert.equal(ticks.length, 4);
});

test('stopping stops the timer and says there is nothing to count', () => {
  const clock = fakeClock();
  const { refresh, ticks, counts } = make(clock);
  refresh.start();
  clock.advance(4);
  refresh.stop();
  assert.equal(clock.ticking, false);
  assert.equal(counts.at(-1), null);
  clock.advance(60);
  assert.equal(ticks.length, 0);
  assert.equal(refresh.isRunning, false);
  refresh.stop();
  assert.equal(clock.cleared, 1, 'stopping twice is harmless');
});

test('starting twice does not run two timers', () => {
  const clock = fakeClock();
  let timers = 0;
  const { refresh, ticks } = make(clock, { setTimer: (fn) => { timers += 1; return clock.setTimer(fn); } });
  refresh.start();
  refresh.start();
  assert.equal(timers, 1);
  clock.advance(10);
  assert.equal(ticks.length, 1);
});

test('changing the interval restarts the countdown from the new one', () => {
  const clock = fakeClock();
  const { refresh, ticks } = make(clock);
  refresh.start();
  clock.advance(8);
  refresh.setIntervalSeconds(30);
  assert.equal(refresh.secondsUntilNext(), 30);
  clock.advance(29);
  assert.equal(ticks.length, 0);
  clock.advance(1);
  assert.equal(ticks.length, 1);
});

test('changing the interval while stopped just takes effect when started', () => {
  const clock = fakeClock();
  const { refresh, ticks } = make(clock);
  refresh.setIntervalSeconds(5);
  assert.equal(refresh.secondsUntilNext(), null);
  refresh.start();
  clock.advance(5);
  assert.equal(ticks.length, 1);
});

test('a refresh still under way is not joined by another', async () => {
  const clock = fakeClock();
  let started = 0;
  let finish;
  const refresh = createAutoRefresh({
    intervalSeconds: 5, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onTick: () => { started += 1; return new Promise((resolve) => { finish = resolve; }); },
  });
  refresh.start();
  clock.advance(5);
  assert.equal(started, 1);
  assert.equal(refresh.isRefreshing, true);
  clock.advance(20);
  assert.equal(started, 1, 'four more intervals passed, none started a second refresh');
  finish();
  await new Promise((r) => setImmediate(r));
  assert.equal(refresh.isRefreshing, false);
  clock.advance(5);
  assert.equal(started, 2, 'the next one runs once the first has finished');
});

test('a refresh that throws is reported and the timer carries on', async () => {
  const clock = fakeClock();
  const errors = [];
  let calls = 0;
  const refresh = createAutoRefresh({
    intervalSeconds: 5, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onTick: () => { calls += 1; if (calls === 1) throw new Error('boom'); }, onError: (e) => errors.push(e.message),
  });
  refresh.start();
  clock.advance(5);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(errors, ['boom']);
  clock.advance(5);
  assert.equal(calls, 2);
});

test('refreshNow refreshes at once and counts the next from now', async () => {
  const clock = fakeClock();
  const { refresh, ticks } = make(clock);
  refresh.start();
  clock.advance(7);
  await refresh.refreshNow();
  assert.equal(ticks.length, 1);
  assert.equal(refresh.secondsUntilNext(), 10);
  clock.advance(9);
  assert.equal(ticks.length, 1);
  clock.advance(1);
  assert.equal(ticks.length, 2);
});

test('refreshNow works while stopped, without starting the timer', async () => {
  const clock = fakeClock();
  const { refresh, ticks } = make(clock);
  await refresh.refreshNow();
  assert.equal(ticks.length, 1);
  assert.equal(refresh.isRunning, false);
});

test('the real timer is used when none is given', async () => {
  let ticks = 0;
  const refresh = createAutoRefresh({ intervalSeconds: 0.05, onTick: () => { ticks += 1; } });
  refresh.start();
  await new Promise((r) => setTimeout(r, 1300));
  refresh.stop();
  assert.ok(ticks >= 1);
});

test('the countdown reads as minutes and seconds', () => {
  assert.equal(formatCountdown(272), '4:32');
  assert.equal(formatCountdown(9), '0:09');
  assert.equal(formatCountdown(0), '0:00');
  assert.equal(formatCountdown(600), '10:00');
  assert.equal(formatCountdown(3725), '1:02:05');
  assert.equal(formatCountdown(-4), '0:00');
  assert.equal(formatCountdown(null), '');
  assert.equal(formatCountdown(undefined), '');
});
