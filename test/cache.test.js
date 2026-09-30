import test from 'node:test';
import assert from 'node:assert/strict';
import { createCache, singleFlight, DEFAULT_TTL_MS } from '../src/lib/cache.js';

function memoryStore() {
  const data = new Map();
  return {
    data,
    async get(key) { return data.has(key) ? { [key]: data.get(key) } : {}; },
    async set(items) { for (const [k, v] of Object.entries(items)) data.set(k, v); },
    async remove(keys) { for (const k of [].concat(keys)) data.delete(k); },
  };
}

test('cache round-trips a value', async () => {
  const cache = createCache(memoryStore());
  await cache.set('a', { value: 1 });
  assert.deepEqual(await cache.get('a'), { value: 1 });
});

test('cache misses on an unknown key', async () => {
  assert.equal(await createCache(memoryStore()).get('nope'), null);
});

test('cache expires entries past the TTL and evicts them', async () => {
  const store = memoryStore();
  let now = 1000;
  const cache = createCache(store, { ttlMs: 100, now: () => now });
  await cache.set('a', 1);
  now = 1099;
  assert.equal(await cache.get('a'), 1);
  now = 1101;
  assert.equal(await cache.get('a'), null);
  assert.equal(store.data.size, 0);
});

test('cache namespaces its keys', async () => {
  const store = memoryStore();
  await createCache(store, { prefix: 'cache:' }).set('a', 1);
  assert.ok(store.data.has('cache:a'));
});

test('default TTL is six hours', () => {
  assert.equal(DEFAULT_TTL_MS, 6 * 60 * 60 * 1000);
});

test('singleFlight collapses concurrent calls on the same key', async () => {
  let calls = 0;
  const wrapped = singleFlight(async (key) => { calls += 1; return key.toUpperCase(); });
  const [a, b, c] = await Promise.all([wrapped('x'), wrapped('x'), wrapped('y')]);
  assert.deepEqual([a, b, c], ['X', 'X', 'Y']);
  assert.equal(calls, 2);
});

test('singleFlight releases the slot after settling, including on failure', async () => {
  let calls = 0;
  const wrapped = singleFlight(async () => { calls += 1; throw new Error('boom'); });
  await assert.rejects(wrapped('x'));
  await assert.rejects(wrapped('x'));
  assert.equal(calls, 2);
});
