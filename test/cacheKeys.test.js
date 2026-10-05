import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedLookupKeys, clearCachedLookups, CACHE_PREFIXES } from '../src/lib/cacheKeys.js';

test('"Clear cache" removes price lookups and never the watch lists or the order archive', () => {
  const keys = ['lists', 'orders', 'targets', 'tr:1', 'tr:2|english', 'settings', 'ptcg.lastView'];
  assert.deepEqual(cachedLookupKeys(keys), ['tr:1', 'tr:2|english']);
  assert.deepEqual(CACHE_PREFIXES, ['tr:'], 'only trends are cached; the Ask never is');
});

test('cachedLookupKeys tolerates junk', () => {
  assert.deepEqual(cachedLookupKeys(null), []);
  assert.deepEqual(cachedLookupKeys([null, 5, {}, 'tr:x']), ['tr:x']);
});

function memoryStorage(initial) {
  const data = { ...initial };
  return {
    data,
    get: async (keys) => (keys === null ? { ...data } : {}),
    remove: async (keys) => { [].concat(keys).forEach((k) => delete data[k]); },
  };
}

test('clearCachedLookups removes only cached lookups and says how many', async () => {
  const storage = memoryStorage({ lists: {}, orders: {}, targets: {}, settings: {}, 'tr:1': 1, 'tr:2': 1 });
  assert.equal(await clearCachedLookups(storage), 2);
  assert.deepEqual(Object.keys(storage.data).sort(), ['lists', 'orders', 'settings', 'targets'], 'targets and settings are never touched');
});

test('clearCachedLookups with nothing cached removes nothing, and does not call remove', async () => {
  const storage = memoryStorage({ lists: {} });
  storage.remove = async () => { throw new Error('should not be called'); };
  assert.equal(await clearCachedLookups(storage), 0);
});
