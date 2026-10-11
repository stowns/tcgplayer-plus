import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_HISTORY_PREFIX, MAX_POINTS, MAX_AGE_MS, SEEN_WRITE_MS, askHistoryKey, sanitizePoints, recordAsk, askChange, noteAsk, staleAskKeys,
} from '../src/lib/askHistory.js';

const ask = (price, shipping = 0) => ({ status: 'ok', price, shipping, seller: 'Shop', count: 3 });
const T0 = Date.UTC(2026, 9, 1, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    writes: 0,
    async get(key) { return key in data ? { [key]: data[key] } : {}; },
    async set(items) { this.writes += 1; Object.assign(data, items); },
  };
}

test('the first Ask seen is recorded with its price, its shipping and the total', () => {
  const { points, changed, write } = recordAsk([], ask(85.99, 0), T0);
  assert.deepEqual(points, [{ at: T0, seen: T0, total: 85.99, price: 85.99, shipping: 0 }]);
  assert.equal(changed, false, 'nothing to have changed from');
  assert.equal(write, true);
  assert.deepEqual(recordAsk([], ask(9.5, 0.99), T0).points[0], { at: T0, seen: T0, total: 10.49, price: 9.5, shipping: 0.99 });
});

test('the same total seen again adds nothing: only "last seen" moves, and it is written at most hourly', () => {
  const first = recordAsk([], ask(10, 1), T0).points;
  const soon = recordAsk(first, ask(10, 1), T0 + 10 * 60 * 1000);
  assert.equal(soon.points.length, 1);
  assert.equal(soon.points[0].at, T0, 'when it was first seen is kept');
  assert.equal(soon.points[0].seen, T0 + 10 * 60 * 1000);
  assert.deepEqual([soon.changed, soon.write], [false, false]);
  assert.equal(recordAsk(first, ask(10, 1), T0 + SEEN_WRITE_MS).write, true);
  // The same total split differently between price and shipping is the same cost to buy.
  assert.equal(recordAsk(first, ask(11, 0), T0 + HOUR).points.length, 1);
});

test('a different total is a new point, by as little as a cent', () => {
  const first = recordAsk([], ask(85.99), T0).points;
  const next = recordAsk(first, ask(85.98), T0 + DAY);
  assert.deepEqual([next.changed, next.write, next.points.length], [true, true, 2]);
  assert.equal(next.points[1].at, T0 + DAY);
  assert.equal(first.length, 1, 'what was passed in is not changed');
});

test('no price is not a price: nothing listed or a failed lookup records nothing', () => {
  const first = recordAsk([], ask(10), T0).points;
  for (const none of [{ status: 'none' }, { status: 'unavailable' }, null, { status: 'ok' }]) {
    const r = recordAsk(first, none, T0 + DAY);
    assert.deepEqual([r.points, r.changed, r.write], [first, false, false]);
  }
});

test('only two prices are kept: the current Ask and the one before it', () => {
  assert.equal(MAX_POINTS, 2);
  let points = [];
  for (let i = 0; i < 5; i += 1) points = recordAsk(points, ask(10 + i), T0 + i * DAY).points;
  assert.deepEqual(points.map((p) => p.total), [13, 14]);
});

test('the change is the current Ask against the different one before it', () => {
  assert.equal(askChange([]), null);
  const one = recordAsk([], ask(100), T0).points;
  assert.deepEqual(askChange(one), { direction: 'flat' }, 'the only price there has been');
  const down = recordAsk(one, ask(95), T0 + DAY).points;
  assert.deepEqual(askChange(down), { direction: 'down', diff: -5, pct: -0.05, previous: 100 });
  const held = recordAsk(down, ask(95), T0 + 3 * DAY).points;
  assert.deepEqual(askChange(held), askChange(down), 'still that change while the price holds, however often it is checked');
  const up = recordAsk(held, ask(104.5), T0 + 4 * DAY).points;
  assert.deepEqual(askChange(up), { direction: 'up', diff: 9.5, pct: 0.1, previous: 95 });
  assert.equal(up.length, 2, 'the 100 it started at is forgotten');
});

test('a stored record is read defensively', () => {
  assert.deepEqual(sanitizePoints(null), []);
  assert.deepEqual(sanitizePoints({ points: 'x' }), []);
  const kept = sanitizePoints({ points: [
    { at: T0 + DAY, total: 9, price: 8, shipping: 1, seen: T0 + 2 * DAY },
    null, { at: 'x', total: 5 }, { at: T0, total: 0 }, { at: T0, total: -1 },
    { at: T0, total: 10.004 },
  ] });
  assert.deepEqual(kept, [
    { at: T0, seen: T0, total: 10, price: 10, shipping: 0 },
    { at: T0 + DAY, seen: T0 + 2 * DAY, total: 9, price: 8, shipping: 1 },
  ], 'bad points dropped, the rest in order, missing parts filled');
});

test('noteAsk records under its own key per card and condition, and returns the change', async () => {
  const storage = memoryStorage();
  assert.equal(askHistoryKey('1|near mint|holofoil'), 'ah:1|near mint|holofoil');
  assert.equal(ASK_HISTORY_PREFIX, 'ah:');
  assert.deepEqual(await noteAsk(storage, '1|near mint|holofoil', ask(100), T0), { direction: 'flat' });
  assert.equal(storage.writes, 1);
  await noteAsk(storage, '1|near mint|holofoil', ask(100), T0 + 60 * 1000);
  assert.equal(storage.writes, 1, 'the same price a minute later is not written again');
  const change = await noteAsk(storage, '1|near mint|holofoil', ask(90), T0 + DAY);
  assert.deepEqual([change.direction, change.pct, change.previous], ['down', -0.1, 100]);
  assert.equal(storage.data['ah:1|near mint|holofoil'].points.length, 2);
  await noteAsk(storage, '2|near mint|holofoil', ask(5), T0);
  assert.deepEqual(Object.keys(storage.data), ['ah:1|near mint|holofoil', 'ah:2|near mint|holofoil']);
});

test('nothing listed neither writes nor forgets what was recorded', async () => {
  const storage = memoryStorage();
  await noteAsk(storage, 'k', ask(100), T0);
  assert.deepEqual(await noteAsk(storage, 'k', { status: 'none' }, T0 + DAY), { direction: 'flat' });
  assert.equal(storage.writes, 1);
  assert.equal(await noteAsk(memoryStorage(), 'k', { status: 'none' }, T0), null);
});

test('records nobody has looked at for six months are stale; newer ones and other keys are not', () => {
  const now = T0 + MAX_AGE_MS + 2 * DAY;
  const all = {
    'ah:old': { points: [{ at: T0, seen: T0 + DAY, total: 5 }] },
    'ah:fresh': { points: [{ at: T0, seen: now - DAY, total: 5 }] },
    'ah:broken': { points: 'nope' },
    lists: { version: 1, lists: [] },
    'tr:1': { storedAt: 1 },
  };
  assert.deepEqual(staleAskKeys(all, now), ['ah:old', 'ah:broken']);
  assert.deepEqual(staleAskKeys(null), []);
});
