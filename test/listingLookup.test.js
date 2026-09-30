import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupListing, listingCacheKey, LISTING_CACHE_TTL_MS } from '../src/lib/listingLookup.js';
import { LAPRAS_LISTINGS, NO_LISTINGS } from './fixtures/tcgplayerListings.js';

const memoryCache = () => {
  const data = new Map();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => { data.set(k, v); return v; },
  };
};

const ITEM = { productId: '696683', condition: 'Near Mint Holofoil' };

test('a lookup posts the query for that product and condition', async () => {
  const calls = [];
  const result = await lookupListing(ITEM, {
    postJson: async (url, body) => { calls.push({ url, body }); return LAPRAS_LISTINGS; },
  });
  assert.equal(typeof result.checkedAt, 'number');
  assert.deepEqual({ ...result, checkedAt: 0 }, { status: 'ok', price: 9.32, shipping: 1.49, seller: 'Xerneas', count: 205, checkedAt: 0 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/product\/696683\/listings$/);
  assert.deepEqual(calls[0].body.filters.term.condition, ['Near Mint']);
});

test('answers are cached, so a second lookup does not ask again', async () => {
  const cache = memoryCache();
  let calls = 0;
  const postJson = async () => { calls += 1; return LAPRAS_LISTINGS; };
  await lookupListing(ITEM, { postJson, cache });
  const again = await lookupListing(ITEM, { postJson, cache });
  assert.equal(calls, 1);
  assert.equal(again.price, 9.32);
});

test('"nobody is selling it" is a real answer and is cached', async () => {
  const cache = memoryCache();
  let calls = 0;
  const postJson = async () => { calls += 1; return NO_LISTINGS; };
  assert.deepEqual(await lookupListing(ITEM, { postJson, cache, now: () => 42 }), { status: 'none', checkedAt: 42 });
  await lookupListing(ITEM, { postJson, cache });
  assert.equal(calls, 1);
});

test('a failed request is unavailable and is not cached, so it is retried', async () => {
  const cache = memoryCache();
  let calls = 0;
  const postJson = async () => { calls += 1; throw new Error('503'); };
  assert.deepEqual(await lookupListing(ITEM, { postJson, cache }), { status: 'unavailable' });
  await lookupListing(ITEM, { postJson, cache });
  assert.equal(calls, 2);
  assert.equal(cache.data.size, 0);
});

test('a response that is not a listings result is unavailable, not "none"', async () => {
  for (const bad of [null, {}, { error: 'x' }, 'html']) {
    const cache = memoryCache();
    const result = await lookupListing(ITEM, { postJson: async () => bad, cache });
    assert.deepEqual(result, { status: 'unavailable' });
    assert.equal(cache.data.size, 0);
  }
});

test('a missing or non-numeric product id never reaches the network', async () => {
  let calls = 0;
  const postJson = async () => { calls += 1; return LAPRAS_LISTINGS; };
  for (const bad of [null, {}, { productId: '' }, { productId: '../x' }]) {
    assert.deepEqual(await lookupListing(bad, { postJson }), { status: 'unavailable' });
  }
  assert.equal(calls, 0);
});

test('the cache key is per product, condition and printing, and ignores case', () => {
  assert.equal(listingCacheKey(ITEM), '696683|near mint|holofoil');
  assert.equal(listingCacheKey({ productId: '1', condition: 'NEAR MINT HOLOFOIL' }), '1|near mint|holofoil');
  assert.notEqual(listingCacheKey(ITEM), listingCacheKey({ ...ITEM, condition: 'Lightly Played Holofoil' }));
  assert.notEqual(listingCacheKey(ITEM), listingCacheKey({ ...ITEM, productId: '2' }));
});

test('listings are cached for ten minutes', () => {
  assert.equal(LISTING_CACHE_TTL_MS, 10 * 60 * 1000);
});

test('each answer is stamped with when it was fetched, and a cached one keeps its original time', async () => {
  const cache = memoryCache();
  const postJson = async () => LAPRAS_LISTINGS;
  const first = await lookupListing(ITEM, { postJson, cache, now: () => 1000 });
  assert.equal(first.checkedAt, 1000);
  const again = await lookupListing(ITEM, { postJson, cache, now: () => 9999 });
  assert.equal(again.checkedAt, 1000, 'the age shown is the age of the data, not of the lookup');
});

test('fresh skips the cache but still stores the new answer', async () => {
  const cache = memoryCache();
  let calls = 0;
  const postJson = async () => { calls += 1; return LAPRAS_LISTINGS; };
  await lookupListing(ITEM, { postJson, cache, now: () => 1 });
  const fresh = await lookupListing({ ...ITEM, fresh: true }, { postJson, cache, now: () => 2 });
  assert.equal(calls, 2);
  assert.equal(fresh.checkedAt, 2);
  const after = await lookupListing(ITEM, { postJson, cache, now: () => 3 });
  assert.equal(calls, 2, 'the next ordinary lookup uses the fresh answer');
  assert.equal(after.checkedAt, 2);
});
