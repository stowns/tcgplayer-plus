import test from 'node:test';
import assert from 'node:assert/strict';
import { median } from '../src/lib/stats.js';

test('median for odd and even samples', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([7]), 7);
});

test('median of nothing usable is null', () => {
  assert.equal(median([]), null);
  assert.equal(median([NaN, undefined, Infinity]), null);
});

test('median ignores non-numbers and does not reorder its input', () => {
  const input = [5, NaN, 1, 3];
  assert.equal(median(input), 3);
  assert.deepEqual(input, [5, NaN, 1, 3]);
});
