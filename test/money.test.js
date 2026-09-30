import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMoney, formatMoney } from '../src/lib/money.js';

test('parseMoney reads the price shapes TCGplayer uses', () => {
  assert.equal(parseMoney('$13.99'), 13.99);
  assert.equal(parseMoney('  $0.50 '), 0.5);
  assert.equal(parseMoney('$1,234.56'), 1234.56);
  assert.equal(parseMoney('US $175.00'), 175);
  assert.equal(parseMoney('$9.50 + $0.99 Shipping'), 9.5, 'the first amount');
  assert.equal(parseMoney('-$4.67'), 4.67);
});

test('parseMoney ignores numbers with no currency marker', () => {
  assert.equal(parseMoney('216 items sold'), null);
  assert.equal(parseMoney('Quantity: 3'), null);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney(undefined), null);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney(13.99), null);
});

test('formatMoney', () => {
  assert.equal(formatMoney(175), '$175.00');
  assert.equal(formatMoney(0.9), '$0.90');
  assert.equal(formatMoney(NaN), '—');
  assert.equal(formatMoney(undefined), '—');
  assert.equal(formatMoney(5, '€'), '€5.00');
});
