import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyArchive, sanitizeOrder, sanitizeArchive, mergeOrders, recordSync, sortOrders, rangeWindow,
  ordersInRange, loadArchive, saveArchive, archiveOrders, ORDERS_KEY, ALL_SAVED,
} from '../src/lib/ordersArchive.js';

const order = (n, date, extra = {}) => ({
  orderNumber: n, kind: 'marketplace', date, channel: 'TCG Marketplace',
  seller: { name: 'Shop', url: 'https://x/s' }, shippingStatus: 'Shipping Not Confirmed',
  shippingMethod: 'Standard', summary: { quantity: 1, subtotal: 10, shipping: 1, tax: 0.8, total: 11.8 },
  items: [{ productId: '1', name: 'Card', url: '', setName: 'Set', rarity: 'Rare', condition: 'Near Mint Holofoil',
    paid: 10, quantity: 1, imageUrl: '', seller: null }],
  ...extra,
});

const memory = (initial = {}) => {
  const data = { ...initial };
  return { data, get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (o) => Object.assign(data, o) };
};

test('an order is kept with only the fields the archive names', () => {
  const kept = sanitizeOrder({ ...order('A-1', '2026-09-27'), shipTo: 'Test Person, 1 Example St', email: 'a@b.c' });
  assert.equal('shipTo' in kept, false);
  assert.equal('email' in kept, false);
  assert.equal(JSON.stringify(kept).includes('Example St'), false);
});

test('an order without a number, or a non-object, is dropped', () => {
  for (const bad of [null, undefined, 5, 'x', {}, { orderNumber: '' }, { orderNumber: '  ' }]) {
    assert.equal(sanitizeOrder(bad), null);
  }
});

test('damaged fields are repaired, not trusted', () => {
  const kept = sanitizeOrder({
    orderNumber: 'A-1', date: 'yesterday', kind: 'weird', summary: { total: 'lots', quantity: NaN },
    items: [null, { name: 5, productId: 'abc', paid: '3', quantity: -2 }, 'x'],
  });
  assert.equal(kept.date, '');
  assert.equal(kept.kind, 'marketplace');
  assert.equal(kept.summary.total, null);
  assert.equal(kept.items.length, 1);
  assert.deepEqual([kept.items[0].name, kept.items[0].productId, kept.items[0].paid, kept.items[0].quantity],
    ['Unknown product', null, null, 1]);
});

test('an unreadable archive becomes an empty one', () => {
  for (const bad of [null, undefined, 3, 'x', [], { orders: [] }, { orders: 'x' }]) {
    assert.deepEqual(sanitizeArchive(bad), emptyArchive());
  }
});

test('one bad order does not take the others with it', () => {
  const archive = sanitizeArchive({ orders: { a: order('A-1', '2026-09-01'), b: { nope: true }, c: order('C-3', '2026-09-03') } });
  assert.deepEqual(Object.keys(archive.orders).sort(), ['A-1', 'C-3']);
});

test('merging adds new orders and counts them', () => {
  const { archive, added, updated } = mergeOrders(emptyArchive(), [order('A-1', '2026-09-01'), order('B-2', '2026-09-02')], { now: 'T1' });
  assert.deepEqual([added, updated, Object.keys(archive.orders).length], [2, 0, 2]);
  assert.equal(archive.orders['A-1'].firstSeen, 'T1');
});

test('merging the same orders again changes nothing but when they were last seen', () => {
  const first = mergeOrders(emptyArchive(), [order('A-1', '2026-09-01')], { now: 'T1' }).archive;
  const again = mergeOrders(first, [order('A-1', '2026-09-01')], { now: 'T2' });
  assert.deepEqual([again.added, again.updated], [0, 0]);
  assert.equal(again.archive.orders['A-1'].firstSeen, 'T1');
  assert.equal(again.archive.orders['A-1'].lastSeen, 'T2');
});

test('a newer read replaces the older one (shipping moves on) and is counted as updated', () => {
  const first = mergeOrders(emptyArchive(), [order('A-1', '2026-09-01')], { now: 'T1' }).archive;
  const next = mergeOrders(first, [order('A-1', '2026-09-01', { shippingStatus: 'Shipped' })], { now: 'T2' });
  assert.equal(next.updated, 1);
  assert.equal(next.archive.orders['A-1'].shippingStatus, 'Shipped');
});

test('nothing is ever removed: an order missing from a later read stays', () => {
  const first = mergeOrders(emptyArchive(), [order('OLD-1', '2026-01-01'), order('NEW-2', '2026-09-01')]).archive;
  const later = mergeOrders(first, [order('NEW-2', '2026-09-01')]).archive;
  assert.ok(later.orders['OLD-1'], 'the order that aged out of TCGplayer\'s window is still here');
});

test('merging tolerates junk input', () => {
  assert.equal(mergeOrders(emptyArchive(), null).added, 0);
  assert.equal(mergeOrders(emptyArchive(), [null, {}, 'x']).added, 0);
});

test('merging never mutates the archive it was given', () => {
  const start = emptyArchive();
  mergeOrders(start, [order('A-1', '2026-09-01')]);
  assert.deepEqual(start, emptyArchive());
});

test('recordSync remembers when each range was last read', () => {
  const a = recordSync(emptyArchive(), 'Last 30 Days', 'T1');
  assert.deepEqual(recordSync(a, '2025', 'T2').syncedAt, { 'Last 30 Days': 'T1', '2025': 'T2' });
});

test('orders sort newest first, undated last, ties by number', () => {
  const sorted = sortOrders([order('A', '2026-01-01'), order('B', ''), order('C', '2026-09-01'), order('D', '2026-09-01')]);
  assert.deepEqual(sorted.map((o) => o.orderNumber), ['D', 'C', 'A', 'B']);
});

test('range windows: last N days, a year, and all', () => {
  assert.deepEqual(rangeWindow('Last 30 Days', '2026-09-30'), { from: '2026-08-31', to: '2026-09-30' });
  assert.deepEqual(rangeWindow('Last 120 Days', '2026-09-30'), { from: '2026-06-02', to: '2026-09-30' });
  assert.deepEqual(rangeWindow('2025', '2026-09-30'), { from: '2025-01-01', to: '2025-12-31' });
  assert.equal(rangeWindow(ALL_SAVED, '2026-09-30'), null);
  assert.equal(rangeWindow('', '2026-09-30'), null);
});

test('range windows work across a year boundary', () => {
  assert.equal(rangeWindow('Last 30 Days', '2026-01-10').from, '2025-12-11');
});

test('ordersInRange filters by date, keeps order, and "All saved" includes undated orders', () => {
  const archive = mergeOrders(emptyArchive(), [
    order('A', '2026-09-27'), order('B', '2026-07-01'), order('C', '2025-12-01'), order('D', ''),
  ]).archive;
  assert.deepEqual(ordersInRange(archive, 'Last 30 Days', '2026-09-30').map((o) => o.orderNumber), ['A']);
  assert.deepEqual(ordersInRange(archive, 'Last 120 Days', '2026-09-30').map((o) => o.orderNumber), ['A', 'B']);
  assert.deepEqual(ordersInRange(archive, '2025', '2026-09-30').map((o) => o.orderNumber), ['C']);
  assert.deepEqual(ordersInRange(archive, ALL_SAVED, '2026-09-30').map((o) => o.orderNumber), ['A', 'B', 'C', 'D']);
});

test('the range bounds are inclusive', () => {
  const archive = mergeOrders(emptyArchive(), [order('EDGE', '2026-08-31'), order('TODAY', '2026-09-30'), order('OUT', '2026-08-30')]).archive;
  assert.deepEqual(ordersInRange(archive, 'Last 30 Days', '2026-09-30').map((o) => o.orderNumber), ['TODAY', 'EDGE']);
});

test('storage round-trips, and a storage failure reads as an empty archive', async () => {
  const store = memory();
  const { archive } = mergeOrders(emptyArchive(), [order('A-1', '2026-09-01')]);
  await saveArchive(store, archive);
  assert.equal((await loadArchive(store)).orders['A-1'].orderNumber, 'A-1');
  assert.deepEqual(await loadArchive({ get: async () => { throw new Error('boom'); } }), emptyArchive());
  assert.deepEqual(await loadArchive(memory({ [ORDERS_KEY]: 'garbage' })), emptyArchive());
});

test('archiveOrders merges into what is stored and notes the range', async () => {
  const store = memory();
  await archiveOrders(store, [order('A-1', '2026-09-01')], { now: 'T1' });
  const r = await archiveOrders(store, [order('B-2', '2026-09-02')], { now: 'T2', range: 'Last 30 Days' });
  assert.deepEqual([r.added, Object.keys(store.data[ORDERS_KEY].orders).length], [1, 2]);
  assert.equal(store.data[ORDERS_KEY].syncedAt['Last 30 Days'], 'T2');
});
