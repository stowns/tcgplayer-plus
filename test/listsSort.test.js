import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SORTS, DEFAULT_SORT, parseSort, sortValue, sortItems, needsHistory, needsAsk, askKey, defaultDirection, directionLabel,
} from '../src/lib/listsSort.js';

const item = (key, extra = {}) => ({
  key, productId: key, name: key, savedAt: '2026-09-01T00:00:00.000Z',
  priceAtSave: { market: 1, condition: 'Near Mint Holofoil' }, ...extra,
});
const ask = (price, shipping = 0) => ({ status: 'ok', price, shipping, seller: 's', count: 3 });
const series = (...prices) => prices.map((price, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, price }));
const trend = (prices) => ({ series: series(...prices) });
const keys = (items) => items.map((i) => i.key);

test('the choices are date added, ask and volatility, defaulting to date added, newest first', () => {
  assert.deepEqual(SORTS.map((s) => s.label), ['Date added', 'Ask', 'Volatility']);
  assert.deepEqual(DEFAULT_SORT, { key: 'added', dir: 'desc' });
});

test('there is no sort by TCGplayer\'s calculated Market Price: what matters is what buying costs', () => {
  assert.equal(SORTS.some((s) => /market/i.test(s.key) || /market/i.test(s.label)), false);
  assert.deepEqual(parseSort({ key: 'market', dir: 'asc' }), DEFAULT_SORT);
});

test('volatility needs each card\'s price history, and ask needs each card\'s cheapest listing', () => {
  assert.equal(needsHistory('volatility'), true);
  assert.equal(needsHistory('ask'), false);
  assert.equal(needsAsk('ask'), true);
  assert.equal(needsAsk('volatility'), false);
  assert.equal(needsHistory('added') || needsAsk('added'), false);
});

test('an ask is looked up per product and condition, so two conditions of one card are two asks', () => {
  assert.equal(askKey(item('1')), '1|near mint|holofoil');
  assert.notEqual(askKey(item('1')), askKey(item('1', { priceAtSave: { condition: 'Lightly Played Holofoil' } })));
  assert.equal(askKey(item('7', { priceAtSave: null })), '7||');
});

test('date added sorts newest first, and oldest first when reversed', () => {
  const items = [item('a', { savedAt: '2026-09-01T00:00:00Z' }), item('b', { savedAt: '2026-09-03T00:00:00Z' }), item('c', { savedAt: '2026-09-02T00:00:00Z' })];
  assert.deepEqual(keys(sortItems(items, { key: 'added', dir: 'desc' })), ['b', 'c', 'a']);
  assert.deepEqual(keys(sortItems(items, { key: 'added', dir: 'asc' })), ['a', 'c', 'b']);
});

test('ask sorts by what buying costs, price plus shipping, highest first by default', () => {
  const items = [item('cheap'), item('dear'), item('mid')];
  // $9 + $1.50 = $10.50 against $12 + $0 = $12: the shipping changes who is dearer.
  const asks = {
    [askKey(items[0])]: ask(9, 1.5),
    [askKey(items[1])]: ask(80),
    [askKey(items[2])]: ask(10, 1.6),
  };
  assert.deepEqual(keys(sortItems(items, { key: 'ask', dir: 'desc' }, { asks })), ['dear', 'mid', 'cheap']);
  assert.deepEqual(keys(sortItems(items, { key: 'ask', dir: 'asc' }, { asks })), ['cheap', 'mid', 'dear']);
});

test('the ask counts shipping: a cheaper item with dear postage is not the cheaper buy', () => {
  const items = [item('a'), item('b')];
  const asks = { [askKey(items[0])]: ask(1, 19.99), [askKey(items[1])]: ask(9, 0.99) };
  assert.deepEqual(keys(sortItems(items, { key: 'ask', dir: 'asc' }, { asks })), ['b', 'a']);
});

test('until a card\'s ask has loaded it has no value: TCGplayer\'s saved Market Price is not a stand-in', () => {
  const a = item('a', { priceAtSave: { market: 500, condition: 'Near Mint Holofoil' } });
  const b = item('b');
  assert.equal(sortValue(a, 'ask', { asks: {} }), null);
  assert.equal(sortValue(a, 'ask', {}), null);
  assert.equal(sortValue(a, 'ask'), null);
  assert.deepEqual(keys(sortItems([a, b], { key: 'ask', dir: 'desc' }, { asks: { [askKey(b)]: ask(5) } })), ['b', 'a']);
});

test('a card with nothing listed, or whose lookup failed, has no ask and goes last', () => {
  const items = [item('none'), item('down'), item('ok')];
  const asks = { [askKey(items[0])]: { status: 'none' }, [askKey(items[1])]: { status: 'unavailable' }, [askKey(items[2])]: ask(7) };
  for (const dir of ['asc', 'desc']) assert.equal(keys(sortItems(items, { key: 'ask', dir }, { asks }))[0], 'ok');
});

test('volatility sorts the choppiest first by default', () => {
  const items = [item('calm'), item('wild'), item('mild')];
  const trends = {
    calm: trend([10, 10.05, 10, 10.05, 10]),
    wild: trend([10, 14, 9, 15, 8]),
    mild: trend([10, 10.5, 10, 10.6, 10.1]),
  };
  assert.deepEqual(keys(sortItems(items, { key: 'volatility', dir: 'desc' }, { trends })), ['wild', 'mild', 'calm']);
  assert.deepEqual(keys(sortItems(items, { key: 'volatility', dir: 'asc' }, { trends })), ['calm', 'mild', 'wild']);
});

test('items with no value sort last whichever way round, and keep their own order', () => {
  const items = [item('none1'), item('a'), item('none2'), item('b')];
  const trends = { a: trend([10, 12, 9, 13, 8]), b: trend([10, 10.1, 10, 10.1, 10]) };
  for (const dir of ['asc', 'desc']) {
    const order = keys(sortItems(items, { key: 'volatility', dir }, { trends }));
    assert.deepEqual(order.slice(2), ['none1', 'none2'], dir);
  }
});

test('a card with too little history has no volatility, so it goes last', () => {
  const items = [item('thin'), item('full')];
  const trends = { thin: trend([10, 11, 12]), full: trend([10, 12, 9, 13, 8]) };
  assert.deepEqual(keys(sortItems(items, { key: 'volatility', dir: 'desc' }, { trends })), ['full', 'thin']);
});

test('ties keep the order the list already had, so sorting never shuffles equals', () => {
  const items = [item('x'), item('y'), item('z')];
  const same = Object.fromEntries(items.map((i) => [askKey(i), ask(5)]));
  // (the three cards are the same product here, so they share one ask, which is the tie)
  assert.deepEqual(keys(sortItems(items, { key: 'ask', dir: 'desc' }, { asks: same })), ['x', 'y', 'z']);
  assert.deepEqual(keys(sortItems(items, { key: 'ask', dir: 'asc' }, { asks: same })), ['x', 'y', 'z']);
});

test('sorting returns a new array and never changes the one it was given', () => {
  const items = [item('a', { savedAt: '2026-09-01' }), item('b', { savedAt: '2026-09-02' })];
  const sorted = sortItems(items, DEFAULT_SORT);
  assert.notEqual(sorted, items);
  assert.deepEqual(keys(items), ['a', 'b']);
});

test('an item with no usable save date has no date value', () => {
  assert.equal(sortValue(item('a', { savedAt: '' }), 'added'), null);
  assert.equal(sortValue(item('a', { savedAt: 'not a date' }), 'added'), null);
  assert.equal(sortValue(item('a'), 'nonsense', undefined), null);
});

test('a saved choice is read defensively', () => {
  assert.deepEqual(parseSort('{"key":"ask","dir":"asc"}'), { key: 'ask', dir: 'asc' });
  assert.deepEqual(parseSort({ key: 'volatility', dir: 'desc' }), { key: 'volatility', dir: 'desc' });
  assert.deepEqual(parseSort('{"key":"ask","dir":"sideways"}'), { key: 'ask', dir: 'desc' });
  for (const bad of [null, undefined, '', 'nope', '{"key":"price"}', '[1]', 5]) assert.deepEqual(parseSort(bad), DEFAULT_SORT);
});

test('each sort starts in its natural direction, and the button says what it means', () => {
  for (const key of ['added', 'market', 'volatility']) assert.equal(defaultDirection(key), 'desc');
  assert.equal(directionLabel('added', 'desc'), 'Newest first');
  assert.equal(directionLabel('added', 'asc'), 'Oldest first');
  assert.equal(directionLabel('ask', 'desc'), 'Highest first');
  assert.equal(directionLabel('ask', 'asc'), 'Lowest first');
  assert.equal(directionLabel('volatility', 'desc'), 'Most volatile first');
  assert.equal(directionLabel('volatility', 'asc'), 'Steadiest first');
  assert.equal(directionLabel('nonsense', 'asc'), 'Oldest first');
});
