import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TARGETS_KEY, DIRECTIONS, parseTargetPrice, sanitizeTargets, loadTargets, saveTargets,
  setTarget, removeTarget, pruneTargets, isMet, evaluateTarget, describeTarget, targetNotification,
} from '../src/lib/targets.js';

const ask = (price, shipping = 0, extra = {}) => ({ status: 'ok', price, shipping, seller: 'Shop', count: 3, ...extra });
const NOW = '2026-10-04T12:00:00.000Z';
const KEY = '716228:english';
const below = (price, extra = {}) => ({ price, direction: 'below', notify: true, met: false, pending: false, updatedAt: NOW, notifiedAt: '', ...extra });
const above = (price, extra = {}) => below(price, { direction: 'above', ...extra });

test('a price can be typed with or without a dollar sign, and must be above zero', () => {
  assert.equal(parseTargetPrice('12.50'), 12.5);
  assert.equal(parseTargetPrice('$12.5'), 12.5);
  assert.equal(parseTargetPrice(' 1,200 '), 1200);
  assert.equal(parseTargetPrice(7), 7);
  assert.equal(parseTargetPrice('9.999'), 10, 'to the cent');
  assert.equal(parseTargetPrice('.91'), 0.91, 'cents without a leading zero');
  assert.equal(parseTargetPrice('$.5'), 0.5);
  assert.equal(parseTargetPrice('0.01'), 0.01, 'anything over zero');
  assert.equal(parseTargetPrice('5.'), 5);
  for (const bad of ['', 'abc', '12abc', '1.2.3', '0', '0.00', '.', '.00', '0.004', 0.004, '-5', '-.5', null, undefined, NaN, 0, -1, Infinity]) assert.equal(parseTargetPrice(bad), null, String(bad));
});

test('setting a target records the price, the direction and that notifications are on', () => {
  const targets = setTarget({}, KEY, { price: '10', direction: 'below' }, { now: NOW });
  assert.deepEqual(targets[KEY], { price: 10, direction: 'below', notify: true, met: false, pending: false, updatedAt: NOW, notifiedAt: '' });
});

test('both directions are supported, and below is the default', () => {
  assert.deepEqual(DIRECTIONS, ['below', 'above']);
  assert.equal(setTarget({}, KEY, { price: 5 })[KEY].direction, 'below');
  assert.equal(setTarget({}, KEY, { price: 5, direction: 'above' })[KEY].direction, 'above');
  assert.throws(() => setTarget({}, KEY, { price: 5, direction: 'sideways' }), /below.*above/);
});

test('notifications can be turned off for a target', () => {
  assert.equal(setTarget({}, KEY, { price: 5, notify: false })[KEY].notify, false);
});

test('a bad price or a missing product is refused with a message fit to show', () => {
  assert.throws(() => setTarget({}, KEY, { price: 'cheap' }), /Enter a price above zero/);
  assert.throws(() => setTarget({}, KEY, { price: 0 }), /Enter a price above zero/);
  assert.throws(() => setTarget({}, '', { price: 5 }), /needs a product/);
});

test('editing a target starts it afresh, so it can notify again', () => {
  const met = { [KEY]: below(10, { met: true, notifiedAt: NOW }) };
  const edited = setTarget(met, KEY, { price: 12 }, { now: '2026-10-05T00:00:00.000Z' });
  assert.equal(edited[KEY].met, false);
  assert.equal(edited[KEY].notifiedAt, '');
  assert.equal(edited[KEY].price, 12);
  assert.equal(met[KEY].met, true, 'the input is not changed');
});

test('removing a target leaves the others', () => {
  const targets = { a: below(1), b: below(2) };
  assert.deepEqual(Object.keys(removeTarget(targets, 'a')), ['b']);
  assert.deepEqual(removeTarget(targets, 'nope'), targets);
});

test('targets for products that are in no list any more are dropped', () => {
  const lists = { lists: [{ items: [{ key: 'a' }] }, { items: [{ key: 'c' }, { key: 'a' }] }] };
  assert.deepEqual(Object.keys(pruneTargets({ a: below(1), b: below(2), c: below(3) }, lists)), ['a', 'c']);
  assert.deepEqual(pruneTargets({ a: below(1) }, { lists: [] }), {});
  assert.deepEqual(pruneTargets({ a: below(1) }, null), {});
});

test('a buyer\'s target is met when the Ask, with shipping, is at or below it', () => {
  assert.equal(isMet(below(10), ask(9, 0.99)), true, '$9.99');
  assert.equal(isMet(below(10), ask(9.01, 0.99)), true, 'exactly $10.00 counts');
  assert.equal(isMet(below(10), ask(9.02, 0.99)), false, '$10.01');
  assert.equal(isMet(below(10), ask(9.5, 0.99)), false, 'shipping takes it over');
  assert.equal(isMet(below(10), ask(9.5, 0)), true);
});

test('a seller\'s target is met when the Ask, with shipping, is at or above it', () => {
  assert.equal(isMet(above(50), ask(49, 0.99)), false);
  assert.equal(isMet(above(50), ask(49.01, 0.99)), true, 'exactly $50.00 counts');
  assert.equal(isMet(above(50), ask(60)), true);
});

test('with nothing listed, or a failed lookup, a target is neither met nor unmet', () => {
  for (const none of [{ status: 'none' }, { status: 'unavailable' }, null, undefined, { retrying: true }]) {
    assert.equal(isMet(below(10), none), null);
    assert.deepEqual(evaluateTarget(below(10, { met: true }), none), { known: false, met: true, changed: false, shouldNotify: false });
  }
});

test('it notifies on the check where the target becomes met, and not again while it stays met', () => {
  assert.deepEqual(evaluateTarget(below(10), ask(9)), { known: true, met: true, changed: true, shouldNotify: true });
  assert.deepEqual(evaluateTarget(below(10, { met: true }), ask(8)), { known: true, met: true, changed: false, shouldNotify: false });
});

test('it re-arms when the price moves back out of range, without notifying', () => {
  assert.deepEqual(evaluateTarget(below(10, { met: true }), ask(11)), { known: true, met: false, changed: true, shouldNotify: false });
  assert.deepEqual(evaluateTarget(below(10), ask(11)), { known: true, met: false, changed: false, shouldNotify: false });
});

test('a target with notifications off still becomes met, quietly', () => {
  assert.deepEqual(evaluateTarget(below(10, { notify: false }), ask(9)), { known: true, met: true, changed: true, shouldNotify: false });
});

test('a target reads as a phrase', () => {
  assert.equal(describeTarget(below(10)), 'at or below $10.00');
  assert.equal(describeTarget(above(1200.5)), 'at or above $1200.50');
});

test('the notification says what happened and links to the product', () => {
  const item = { name: 'Maushold - 146/128', url: 'https://www.tcgplayer.com/product/716228?Language=English' };
  const n = targetNotification(item, below(10), ask(8.8, 0.99));
  assert.equal(n.title, 'Price target reached: Maushold - 146/128');
  assert.equal(n.message, 'Ask $9.79 is at or below $10.00, your target ($8.80 + $0.99 shipping).');
  assert.equal(n.url, item.url);
  assert.deepEqual(n.tags, ['chart_with_downwards_trend']);
  const up = targetNotification(item, above(50), ask(55, 0));
  assert.equal(up.message, 'Ask $55.00 is at or above $50.00, your target ($55.00, free shipping).');
  assert.deepEqual(up.tags, ['chart_with_upwards_trend']);
});

test('only an https link is put in a notification', () => {
  for (const url of ['javascript:alert(1)', 'http://x', '', undefined, 5]) {
    assert.equal(targetNotification({ name: 'x', url }, below(10), ask(9)).url, '');
  }
});

test('damaged targets are dropped, good ones kept, and nothing else survives', () => {
  const clean = sanitizeTargets({
    good: { price: 10, direction: 'above', notify: false, met: true, pending: true, updatedAt: NOW, notifiedAt: NOW, junk: 1 },
    defaulted: { price: '7.5' },
    zero: { price: 0 }, negative: { price: -1 }, text: 'x', missing: null, '': { price: 5 },
  });
  assert.deepEqual(Object.keys(clean), ['good', 'defaulted']);
  assert.deepEqual(clean.good, { price: 10, direction: 'above', notify: false, met: true, pending: true, updatedAt: NOW, notifiedAt: NOW });
  assert.deepEqual(clean.defaulted, { price: 7.5, direction: 'below', notify: true, met: false, pending: false, updatedAt: '', notifiedAt: '' });
  for (const junk of [null, undefined, 'x', 5, []]) assert.deepEqual(sanitizeTargets(junk), {});
});

test('targets are stored under their own key and read back repaired', async () => {
  const data = {};
  const storage = { get: async (k) => (k in data ? { [k]: data[k] } : {}), set: async (items) => { Object.assign(data, items); } };
  assert.deepEqual(await loadTargets(storage), {});
  await saveTargets(storage, { [KEY]: below(10), bad: { price: 0 } });
  assert.deepEqual(Object.keys(data[TARGETS_KEY]), [KEY]);
  assert.equal((await loadTargets(storage))[KEY].price, 10);
});
