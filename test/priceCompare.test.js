import test from 'node:test';
import assert from 'node:assert/strict';
import { comparePrice, totalChange, SAME_BAND } from '../src/lib/priceCompare.js';

test('a lower price today is negative, in dollars and as a share of what was paid', () => {
  const c = comparePrice(13.99, 9.32);
  assert.equal(c.direction, 'lower');
  assert.equal(c.diff, -4.67);
  assert.ok(Math.abs(c.pct - (-4.67 / 13.99)) < 1e-9);
});

test('a higher price today is positive', () => {
  const c = comparePrice(10, 12.5);
  assert.deepEqual([c.direction, c.diff, c.pct], ['higher', 2.5, 0.25]);
});

test('identical prices and changes under one percent read as the same', () => {
  assert.equal(comparePrice(10, 10).direction, 'same');
  assert.equal(comparePrice(100, 100.9).direction, 'same');
  assert.equal(comparePrice(100, 99.1).direction, 'same');
  assert.equal(comparePrice(100, 101).direction, 'higher');
  assert.equal(SAME_BAND, 0.01);
});

test('on a very cheap card one cent is already a real move', () => {
  const c = comparePrice(0.5, 0.51);
  assert.deepEqual([c.direction, c.diff], ['higher', 0.01]);
});

test('the difference is rounded to cents', () => {
  assert.equal(comparePrice(5.61, 3.2).diff, -2.41);
});

test('unusable inputs give null rather than a made-up comparison', () => {
  for (const [a, b] of [[0, 5], [5, 0], [null, 5], [5, null], [NaN, 5], [5, undefined], [-1, 5]]) {
    assert.equal(comparePrice(a, b), null);
  }
});

const ok = (price) => ({ status: 'ok', price });

test('the total is worth-now minus paid across every priced line', () => {
  const t = totalChange([
    { paid: 13.99, quantity: 1, result: ok(9.32) },
    { paid: 5.61, quantity: 1, result: ok(4.16) },
  ]);
  assert.equal(t.paid, 19.6);
  assert.equal(t.now, 13.48);
  assert.equal(t.diff, -6.12);
  assert.equal(t.direction, 'lower');
  assert.equal(t.counted, 2);
  assert.ok(Math.abs(t.pct - (-6.12 / 19.6)) < 1e-9);
});

test('gains and losses offset each other', () => {
  const t = totalChange([{ paid: 10, result: ok(15) }, { paid: 10, result: ok(7) }]);
  assert.deepEqual([t.diff, t.direction], [2, 'higher']);
});

test('quantity multiplies both sides', () => {
  const t = totalChange([{ paid: 10, quantity: 3, result: ok(12) }]);
  assert.deepEqual([t.paid, t.now, t.diff], [30, 36, 6]);
  const bad = totalChange([{ paid: 10, quantity: 0, result: ok(12) }, { paid: 10, quantity: 'x', result: ok(12) }]);
  assert.equal(bad.paid, 20, 'a nonsense quantity counts as one');
});

test('lines without an answer are reported, not silently dropped or guessed', () => {
  const t = totalChange([
    { paid: 10, result: ok(8) },
    { paid: 10, result: { status: 'none' } },
    { paid: 10, result: { status: 'unavailable' } },
    { paid: null, result: ok(8) },
    { paid: 10, result: null },
  ]);
  assert.deepEqual([t.counted, t.missing, t.pending, t.paid, t.now], [1, 3, 1, 10, 8]);
});

test('nothing priced gives no total', () => {
  assert.equal(totalChange([]), null);
  assert.equal(totalChange([{ paid: 10, result: null }, { paid: 10, result: { status: 'none' } }]), null);
});

test('a total within one percent reads as level', () => {
  assert.equal(totalChange([{ paid: 100, result: ok(100.5) }]).direction, 'same');
});
