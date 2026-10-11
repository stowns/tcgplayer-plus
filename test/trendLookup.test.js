import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupTrend, trendCacheKey, TREND_CACHE_TTL_MS } from '../src/lib/trendLookup.js';
import { createCache } from '../src/lib/cache.js';
import { TREND } from '../src/lib/priceTrend.js';
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

test('a trend cached under older rules is worked out again, not shown', async () => {
  let calls = 0;
  const cache = memoryCache();
  const item = { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' };
  // What an earlier version stored: a "flat" verdict and no record of which rules made it.
  await cache.set(trendCacheKey(item), { direction: 'flat', pct: 0.013, reason: 'ok', series: [] });
  const deps = { fetchJson: async () => { calls += 1; return PIKACHU_HISTORY; }, cache };
  const fresh = await lookupTrend(item, deps);
  assert.equal(calls, 1, 'looked up again');
  assert.equal(fresh.direction, 'down');
  assert.equal(fresh.rules, TREND.VERSION);
  await lookupTrend(item, deps);
  assert.equal(calls, 1, 'and the new answer is cached');
});

test('trends are cached for one hour, as long as TCGplayer\'s own response is good for', () => {
  assert.equal(TREND_CACHE_TTL_MS, 60 * 60 * 1000);
});

// ---- the 30-day window, from a second and longer history ------------------------------

/** Ninety days in three-day steps, newest first, rising: 12 for the newest thirty days, 10 before. */
const QUARTER = {
  result: [{
    skuId: '9', condition: 'Near Mint', variant: 'Holofoil', language: 'English', totalQuantitySold: '100',
    buckets: Array.from({ length: 30 }, (_, i) => ({
      marketPrice: i < 10 ? '12' : '10', quantitySold: '6', transactionCount: '6', lowSalePrice: '9', highSalePrice: '13',
      bucketStartDate: new Date(Date.UTC(2026, 8, 30) - i * 3 * 86400000).toISOString().slice(0, 10),
    })),
  }],
};
const feeds = (calls, { quarter = QUARTER } = {}) => async (url) => {
  calls.push(url);
  if (/range=quarter/.test(url)) { if (quarter instanceof Error) throw quarter; return quarter; }
  return PIKACHU_HISTORY;
};
const LONG_ITEM = { productId: '712953', language: 'English', condition: 'Near Mint Holofoil', long: true };

test('the 90-day history is not asked for unless the 30-day trend is wanted', async () => {
  const calls = [];
  const trend = await lookupTrend({ ...LONG_ITEM, long: false }, { fetchJson: feeds(calls), cache: memoryCache() });
  assert.deepEqual(calls.map((u) => u.split('range=')[1]), ['month']);
  assert.equal(trend.windows[30], undefined);
});

test('asking for it makes one more request and adds the 30-day window and its 90-day chart', async () => {
  const calls = [];
  const cache = memoryCache();
  const trend = await lookupTrend(LONG_ITEM, { fetchJson: feeds(calls), cache });
  assert.deepEqual(calls, [
    'https://infinite-api.tcgplayer.com/price/history/712953/detailed?range=month',
    'https://infinite-api.tcgplayer.com/price/history/712953/detailed?range=quarter',
  ]);
  assert.deepEqual([trend.windows[30].direction, trend.windows[30].pct, trend.windows[30].reason], ['up', 0.2, 'ok']);
  assert.equal(trend.longSeries.length, 30);
  assert.equal(trend.longAsOf, '2026-09-30');
  assert.equal(trend.direction, 'down', 'the month\'s own answer is untouched');
  assert.ok(trend.windows[7], 'and so are its windows');

  // Cached whole: neither history is asked for again, with or without the 30-day trend.
  await lookupTrend(LONG_ITEM, { fetchJson: feeds(calls), cache });
  const short = await lookupTrend({ ...LONG_ITEM, long: false }, { fetchJson: feeds(calls), cache });
  assert.equal(calls.length, 2);
  assert.ok(short.windows[30], 'what is already known is not thrown away');
});

test('a month already cached costs only the 90-day request when 30 days is chosen later', async () => {
  const calls = [];
  const cache = memoryCache();
  await lookupTrend({ ...LONG_ITEM, long: false }, { fetchJson: feeds(calls), cache });
  const trend = await lookupTrend(LONG_ITEM, { fetchJson: feeds(calls), cache });
  assert.deepEqual(calls.map((u) => u.split('range=')[1]), ['month', 'quarter']);
  assert.equal(trend.windows[30].reason, 'ok');
});

test('when the 90-day history cannot be read, the rest of the trend still arrives and the failure is not remembered', async () => {
  const calls = [];
  const cache = memoryCache();
  for (const quarter of [new Error('503'), { nonsense: true }]) {
    const trend = await lookupTrend(LONG_ITEM, { fetchJson: feeds(calls, { quarter }), cache });
    assert.equal(trend.direction, 'down');
    assert.deepEqual([trend.windows[30].reason, trend.windows[30].direction], ['unavailable', 'unknown']);
  }
  // Tried again each time, and it works once the feed is back.
  const again = await lookupTrend(LONG_ITEM, { fetchJson: feeds(calls), cache });
  assert.equal(again.windows[30].reason, 'ok');
  assert.deepEqual(calls.map((u) => u.split('range=')[1]), ['month', 'quarter', 'quarter', 'quarter']);
});

test('ninety days with nothing sold is "not enough sales", and is remembered', async () => {
  const calls = [];
  const cache = memoryCache();
  const empty = { result: [{ ...QUARTER.result[0], buckets: QUARTER.result[0].buckets.map((b) => ({ ...b, transactionCount: '0', quantitySold: '0' })) }] };
  const trend = await lookupTrend(LONG_ITEM, { fetchJson: feeds(calls, { quarter: empty }), cache });
  assert.equal(trend.windows[30].reason, 'not-enough-sales');
  assert.deepEqual(trend.longSeries, []);
  await lookupTrend(LONG_ITEM, { fetchJson: feeds(calls, { quarter: empty }), cache });
  assert.equal(calls.length, 2);
});

test('a card with no sales in the month is not asked about for ninety days', async () => {
  const calls = [];
  const none = { result: [{ ...QUARTER.result[0], buckets: [] }] };
  const trend = await lookupTrend(LONG_ITEM, { fetchJson: async (url) => { calls.push(url); return none; } });
  assert.equal(calls.length, 1);
  assert.equal(trend.reason, 'no-data');
});
