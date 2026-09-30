import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedLookupKeys, CACHE_PREFIXES } from '../src/lib/cacheKeys.js';

test('"Clear cache" removes price lookups and never the saved lists or the order archive', () => {
  const keys = ['lists', 'orders', 'tr:1', 'ls:2', 'settings', 'ptcg.lastView'];
  assert.deepEqual(cachedLookupKeys(keys), ['tr:1', 'ls:2']);
  assert.deepEqual(CACHE_PREFIXES, ['tr:', 'ls:']);
});

test('cachedLookupKeys tolerates junk', () => {
  assert.deepEqual(cachedLookupKeys(null), []);
  assert.deepEqual(cachedLookupKeys([null, 5, {}, 'tr:x']), ['tr:x']);
});
