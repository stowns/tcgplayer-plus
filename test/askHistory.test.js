import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ASK_HISTORY_PREFIX, MAX_POINTS, MAX_AGE_MS, SEEN_WRITE_MS, MISTAKE_BELOW, askHistoryKey, sanitizePoints,
  recordAsk, askChange, noteAsk, staleAskKeys, isMistake, needsVetting, settle,
} from '../src/lib/askHistory.js';

const ask = (price, shipping = 0) => ({ status: 'ok', price, shipping, seller: 'Shop', count: 3 });
const T0 = Date.UTC(2026, 9, 1, 12);
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const point = (total, at = T0, extra = {}) => ({ at, seen: at, total, price: total, shipping: 0, ...extra });

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    writes: 0,
    async get(key) { return key in data ? { [key]: data[key] } : {}; },
    async set(items) { this.writes += 1; Object.assign(data, items); },
  };
}
/** A lowest-sale lookup that counts how often it is asked. */
const sales = (value) => { const fn = async () => { fn.calls += 1; if (value instanceof Error) throw value; return value; }; fn.calls = 0; return fn; };

// ---- recording ---------------------------------------------------------------------------

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

test('a different total is a new point, by as little as a cent, however soon it comes', () => {
  const first = recordAsk([], ask(85.99), T0).points;
  const next = recordAsk(first, ask(85.98), T0 + 60 * 1000);
  assert.deepEqual([next.changed, next.write, next.points.length], [true, true, 2]);
  assert.equal(next.points[1].at, T0 + 60 * 1000);
  assert.equal(first.length, 1, 'what was passed in is not changed');
});

test('no price is not a price: nothing listed or a failed lookup records nothing', () => {
  const first = recordAsk([], ask(10), T0).points;
  for (const none of [{ status: 'none' }, { status: 'unavailable' }, null, { status: 'ok' }]) {
    const r = recordAsk(first, none, T0 + DAY);
    assert.deepEqual([r.points, r.changed, r.write], [first, false, false]);
  }
});

// ---- judging an earlier Ask against what the card sold for ----------------------------------

test('an Ask under half the cheapest sale of the last month is a mistake; at half or more it is a price', () => {
  assert.equal(MISTAKE_BELOW, 0.5);
  assert.equal(isMistake(point(4.39), 32.02), true, 'the real case: $4.39 against sales no lower than $32.02');
  assert.equal(isMistake(point(15.99), 32), true);
  assert.equal(isMistake(point(16), 32), false, 'exactly half is believed');
  assert.equal(isMistake(point(28), 32), false);
  assert.equal(isMistake(point(500), 32), false, 'a high Ask is never a mistake: it may be the only copy left');
});

test('with no sales to judge by, or sales that could not be read, nothing is called a mistake', () => {
  for (const unknown of [null, undefined, 0, NaN, -5]) assert.equal(isMistake(point(0.01), unknown), false, String(unknown));
});

test('an earlier Ask needs judging until it has been; the current one never does', () => {
  assert.equal(needsVetting([]), false);
  assert.equal(needsVetting([point(10)]), false, 'only a current Ask');
  assert.equal(needsVetting([point(10), point(12, T0 + DAY)]), true);
  assert.equal(needsVetting([point(10, T0, { vetted: true }), point(12, T0 + DAY)]), false);
});

test('settling believes an earlier Ask the sales bear out, and marks it so it is not judged again', () => {
  const out = settle([point(30), point(33.5, T0 + DAY)], 28);
  assert.deepEqual(out.map((p) => [p.total, p.vetted === true]), [[30, true], [33.5, false]]);
  assert.equal(needsVetting(out), false);
});

test('settling drops an earlier Ask the card never sold near', () => {
  // As 1.3.0 stored it: a $4.39 listing, then the real price.
  assert.deepEqual(settle([point(4.39), point(33.5, T0 + 600000)], 32.02).map((p) => p.total), [33.5]);
});

test('a mistake between two real prices is taken out, and the real one before it is what is compared with', () => {
  const real = point(33.5, T0, { vetted: true });
  const onward = settle([real, point(4.39, T0 + HOUR), point(34, T0 + 2 * HOUR)], 32.02);
  assert.deepEqual(onward.map((p) => [p.total, p.vetted === true]), [[33.5, true], [34, false]]);
  assert.deepEqual(askChange(onward), { direction: 'up', diff: 0.5, pct: 0.0149, previous: 33.5 });

  // And when the price simply came back, the two sides are one price again.
  const back = settle([real, point(4.39, T0 + HOUR), point(33.5, T0 + 2 * HOUR)], 32.02);
  assert.deepEqual(back.map((p) => p.total), [33.5]);
  assert.equal(back[0].at, T0, 'first seen when it was');
  assert.equal(back[0].seen, T0 + 2 * HOUR);
  assert.deepEqual(askChange(back), { direction: 'flat' });
});

test('a listing that was bought is among the sales, so it is kept however briefly it was listed', () => {
  // $28 was the cheapest for ten minutes and sold: the day's lowest sale is now $28.
  const out = settle([point(33.5, T0, { vetted: true }), point(28, T0 + HOUR), point(33.5, T0 + HOUR + 600000)], 28);
  assert.deepEqual(out.map((p) => p.total), [28, 33.5]);
  assert.deepEqual(askChange(out), { direction: 'up', diff: 5.5, pct: 0.1964, previous: 28 });
});

test('a card with no sales has every Ask believed; unreadable sales judge nothing and drop nothing', () => {
  const pair = [point(4.39), point(33.5, T0 + DAY)];
  assert.deepEqual(settle(pair, null).map((p) => [p.total, p.vetted === true]), [[4.39, true], [33.5, false]]);
  const waiting = settle(pair, undefined);
  assert.deepEqual(waiting, pair, 'left as it was, to be judged when the sales can be read');
  assert.deepEqual(askChange(waiting), { direction: 'flat' }, 'and nothing is claimed in the meantime');
});

test('only two prices are kept: the current Ask and the one before it', () => {
  assert.equal(MAX_POINTS, 2);
  let points = [];
  for (let i = 0; i < 5; i += 1) points = settle(recordAsk(points, ask(10 + i), T0 + i * DAY).points, 9);
  assert.deepEqual(points.map((p) => p.total), [13, 14]);
});

// ---- the change shown ------------------------------------------------------------------------

test('the change is the current Ask against the believed one before it', () => {
  assert.equal(askChange([]), null);
  assert.deepEqual(askChange([point(100)]), { direction: 'flat' }, 'the only price there has been');
  const down = [point(100, T0, { vetted: true }), point(95, T0 + DAY)];
  assert.deepEqual(askChange(down), { direction: 'down', diff: -5, pct: -0.05, previous: 100 });
  assert.deepEqual(askChange([point(95, T0, { vetted: true }), point(104.5, T0 + DAY)]), { direction: 'up', diff: 9.5, pct: 0.1, previous: 95 });
  assert.deepEqual(askChange([point(100), point(95, T0 + DAY)]), { direction: 'flat' }, 'not until the earlier one has been judged');
});

test('a stored record is read defensively, and keeps what has been judged', () => {
  assert.deepEqual(sanitizePoints(null), []);
  assert.deepEqual(sanitizePoints({ points: 'x' }), []);
  const kept = sanitizePoints({ points: [
    { at: T0 + DAY, total: 9, price: 8, shipping: 1, seen: T0 + 2 * DAY },
    null, { at: 'x', total: 5 }, { at: T0, total: 0 }, { at: T0, total: -1 },
    { at: T0, total: 10.004, vetted: true },
  ] });
  assert.deepEqual(kept, [
    { at: T0, seen: T0, total: 10, price: 10, shipping: 0, vetted: true },
    { at: T0 + DAY, seen: T0 + 2 * DAY, total: 9, price: 8, shipping: 1 },
  ], 'bad points dropped, the rest in order, missing parts filled');
  assert.equal('vetted' in sanitizePoints({ points: [{ at: T0, total: 5, vetted: 'yes' }] })[0], false);
});

// ---- in storage ------------------------------------------------------------------------------

test('noteAsk records under its own key per card and condition, and returns the change', async () => {
  const storage = memoryStorage();
  const lowestSale = sales(80);
  assert.equal(askHistoryKey('1|near mint|holofoil'), 'ah:1|near mint|holofoil');
  assert.equal(ASK_HISTORY_PREFIX, 'ah:');
  assert.deepEqual(await noteAsk(storage, '1|near mint|holofoil', ask(100), { now: T0, lowestSale }), { direction: 'flat' });
  assert.equal(storage.writes, 1);
  await noteAsk(storage, '1|near mint|holofoil', ask(100), { now: T0 + 60 * 1000, lowestSale });
  assert.equal(storage.writes, 1, 'the same price a minute later is not written again');
  assert.equal(lowestSale.calls, 0, 'the sales are not asked for while there is nothing to judge');

  const change = await noteAsk(storage, '1|near mint|holofoil', ask(90), { now: T0 + DAY, lowestSale });
  assert.deepEqual([change.direction, change.pct, change.previous], ['down', -0.1, 100]);
  assert.equal(lowestSale.calls, 1, 'asked once, when there was an earlier Ask to judge');
  assert.deepEqual(storage.data['ah:1|near mint|holofoil'].points.map((p) => [p.total, p.vetted === true]), [[100, true], [90, false]]);

  await noteAsk(storage, '1|near mint|holofoil', ask(90), { now: T0 + 2 * DAY, lowestSale });
  assert.equal(lowestSale.calls, 1, 'and not again: it has been judged');
  await noteAsk(storage, '2|near mint|holofoil', ask(5), { now: T0, lowestSale });
  assert.deepEqual(Object.keys(storage.data), ['ah:1|near mint|holofoil', 'ah:2|near mint|holofoil']);
});

test('a record left by the earlier version loses its mistaken price the next time the Ask is looked up', async () => {
  const key = 'ah:497677|near mint|holofoil';
  const storage = memoryStorage({ [key]: { points: [point(4.39), point(33.5, T0 + 600000)] } });
  const change = await noteAsk(storage, '497677|near mint|holofoil', ask(32.28, 1.22), { now: T0 + 5 * DAY, lowestSale: sales(32.02) });
  assert.deepEqual(change, { direction: 'flat' }, 'no +663%');
  assert.deepEqual(storage.data[key].points.map((p) => p.total), [33.5]);
});

test('if the sales cannot be read, nothing is dropped or claimed, and it is tried again next time', async () => {
  const key = 'ah:k';
  const storage = memoryStorage({ [key]: { points: [point(100), point(90, T0 + DAY)] } });
  for (const failing of [sales(new Error('503')), sales(undefined), undefined]) {
    assert.deepEqual(await noteAsk(storage, 'k', ask(90), { now: T0 + 2 * DAY, lowestSale: failing }), { direction: 'flat' });
    assert.equal(storage.data[key].points.length, 2);
  }
  const later = await noteAsk(storage, 'k', ask(90), { now: T0 + 3 * DAY, lowestSale: sales(85) });
  assert.deepEqual([later.direction, later.previous], ['down', 100]);
});

test('nothing listed neither writes nor forgets what was recorded', async () => {
  const storage = memoryStorage();
  await noteAsk(storage, 'k', ask(100), { now: T0 });
  assert.deepEqual(await noteAsk(storage, 'k', { status: 'none' }, { now: T0 + DAY }), { direction: 'flat' });
  assert.equal(storage.writes, 1);
  assert.equal(await noteAsk(memoryStorage(), 'k', { status: 'none' }, { now: T0 }), null);
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
