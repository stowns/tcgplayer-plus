import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupTrend, trendCacheKey, TREND_CACHE_TTL_MS } from '../src/lib/trendLookup.js';
import { createCache } from '../src/lib/cache.js';
import { PIKACHU_HISTORY, GENESECT_HISTORY } from './fixtures/tcgplayerHistory.js';

const ITEM = { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' };

function memoryCache(now = Date.now) {
  const data = new Map();
  return createCache({
    async get(k) { return data.has(k) ? { [k]: data.get(k) } : {}; },
    async set(items) { Object.entries(items).forEach(([k, v]) => data.set(k, v)); },
    async remove(keys) { [].concat(keys).forEach((k) => data.delete(k)); },
  }, { ttlMs: TREND_CACHE_TTL_MS, prefix: 'tr:', now });
}

test('trendCacheKey identifies the SKU being followed, not the listing', () => {
  const key = trendCacheKey(ITEM);
  assert.equal(key, '712953|english|near mint|holofoil');
  assert.notEqual(key, trendCacheKey({ ...ITEM, condition: 'Lightly Played Holofoil' }));
  assert.notEqual(key, trendCacheKey({ ...ITEM, language: 'Japanese' }));
  assert.equal(trendCacheKey({ productId: '1' }), '1|english||');
});

test('lookupTrend fetches the feed and returns the trend with its SKU', async () => {
  const urls = [];
  const r = await lookupTrend(ITEM, { fetchJson: async (u) => { urls.push(u); return PIKACHU_HISTORY; } });
  assert.deepEqual(urls, ['https://infinite-api.tcgplayer.com/price/history/712953/detailed?range=month']);
  assert.equal(r.direction, 'down');
  assert.equal(r.sku.condition, 'Near Mint');
  assert.equal(r.sku.variant, 'Holofoil');
  assert.ok(r.series.length > 0);
});

test('lookupTrend caches a real answer, and a repeat costs no request', async () => {
  let calls = 0;
  const cache = memoryCache();
  const deps = { fetchJson: async () => { calls += 1; return GENESECT_HISTORY; }, cache };
  const item = { productId: '642621', language: 'English', condition: 'Near Mint Holofoil' };
  const first = await lookupTrend(item, deps);
  const second = await lookupTrend(item, deps);
  assert.equal(calls, 1);
  assert.deepEqual(second, first);
  assert.equal(first.direction, 'flat');
});

test('a cached answer expires', async () => {
  let now = 1000;
  let calls = 0;
  const cache = memoryCache(() => now);
  const deps = { fetchJson: async () => { calls += 1; return PIKACHU_HISTORY; }, cache };
  await lookupTrend(ITEM, deps);
  now += TREND_CACHE_TTL_MS + 1;
  await lookupTrend(ITEM, deps);
  assert.equal(calls, 2);
});

test('lookupTrend reports an unavailable feed without throwing, and does not cache it', async () => {
  let calls = 0;
  const cache = memoryCache();
  const failing = { fetchJson: async () => { calls += 1; throw new Error('503'); }, cache };
  const r = await lookupTrend(ITEM, failing);
  assert.equal(r.direction, 'unknown');
  assert.equal(r.reason, 'unavailable');
  await lookupTrend(ITEM, failing);
  assert.equal(calls, 2, 'a transient failure is retried next time');
});

test('a response that is not the feed reads as unavailable', async () => {
  for (const junk of [null, {}, { result: [] }, 'html']) {
    const r = await lookupTrend(ITEM, { fetchJson: async () => junk });
    assert.equal(r.direction, 'unknown');
    assert.equal(r.reason, 'unavailable');
  }
});

test('an item with no product id is unavailable and makes no request', async () => {
  let calls = 0;
  const r = await lookupTrend({ language: 'English' }, { fetchJson: async () => { calls += 1; return {}; } });
  assert.equal(r.reason, 'unavailable');
  assert.equal(calls, 0);
});

test('a quiet, uncertain answer is cached too — it is still the answer for now', async () => {
  let calls = 0;
  const cache = memoryCache();
  const thin = { count: 1, result: [{ skuId: '1', condition: 'Near Mint', variant: 'Normal', language: 'English', totalQuantitySold: '1', buckets: [] }] };
  const deps = { fetchJson: async () => { calls += 1; return thin; }, cache };
  const a = await lookupTrend(ITEM, deps);
  await lookupTrend(ITEM, deps);
  assert.equal(a.reason, 'no-data');
  assert.equal(calls, 1);
});
