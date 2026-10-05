import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupListing, listingCacheKey } from '../src/lib/listingLookup.js';
import { LAPRAS_LISTINGS, NO_LISTINGS } from './fixtures/tcgplayerListings.js';

const ITEM = { productId: '696683', condition: 'Near Mint Holofoil' };

test('a lookup posts the query for that product and condition', async () => {
  const calls = [];
  const result = await lookupListing(ITEM, {
    postJson: async (url, body) => { calls.push({ url, body }); return LAPRAS_LISTINGS; },
  });
  assert.equal(typeof result.checkedAt, 'number');
  assert.deepEqual({ ...result, checkedAt: 0 }, { status: 'ok', price: 9.32, shipping: 1.49, seller: 'Xerneas', url: '', count: 205, checkedAt: 0 });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/product\/696683\/listings$/);
  assert.deepEqual(calls[0].body.filters.term.condition, ['Near Mint']);
});

test('every lookup asks again: a price is never served from a cache', async () => {
  let calls = 0;
  const postJson = async () => { calls += 1; return LAPRAS_LISTINGS; };
  await lookupListing(ITEM, { postJson });
  const again = await lookupListing(ITEM, { postJson });
  assert.equal(calls, 2);
  assert.equal(again.price, 9.32);
});

test('a cache handed to it is ignored', async () => {
  let reads = 0;
  let writes = 0;
  const cache = { get: async () => { reads += 1; return { status: 'ok', price: 1 }; }, set: async () => { writes += 1; } };
  const result = await lookupListing(ITEM, { postJson: async () => LAPRAS_LISTINGS, cache });
  assert.equal(result.price, 9.32, 'the live answer, not the cached one');
  assert.deepEqual([reads, writes], [0, 0]);
});

test('a new price is seen on the very next lookup', async () => {
  const cheaper = structuredClone(LAPRAS_LISTINGS);
  for (const row of cheaper.results[0].results) row.price = 5;
  const answers = [LAPRAS_LISTINGS, cheaper];
  const postJson = async () => answers.shift();
  assert.equal((await lookupListing(ITEM, { postJson })).price, 9.32);
  assert.equal((await lookupListing(ITEM, { postJson })).price, 5);
});

test('"nobody is selling it" is a real answer, with when it was checked', async () => {
  assert.deepEqual(await lookupListing(ITEM, { postJson: async () => NO_LISTINGS, now: () => 42 }), { status: 'none', checkedAt: 42 });
});

test('a failed request is unavailable, and the next lookup tries again', async () => {
  let calls = 0;
  const postJson = async () => { calls += 1; throw new Error('503'); };
  assert.deepEqual(await lookupListing(ITEM, { postJson }), { status: 'unavailable' });
  await lookupListing(ITEM, { postJson });
  assert.equal(calls, 2);
});

test('a response that is not a listings result is unavailable, not "none"', async () => {
  for (const bad of [null, {}, { error: 'x' }, 'html']) {
    assert.deepEqual(await lookupListing(ITEM, { postJson: async () => bad }), { status: 'unavailable' });
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

test('the key is per product, condition and printing, and ignores case', () => {
  assert.equal(listingCacheKey(ITEM), '696683|near mint|holofoil');
  assert.equal(listingCacheKey({ productId: '1', condition: 'NEAR MINT HOLOFOIL' }), '1|near mint|holofoil');
  assert.notEqual(listingCacheKey(ITEM), listingCacheKey({ ...ITEM, condition: 'Lightly Played Holofoil' }));
  assert.notEqual(listingCacheKey(ITEM), listingCacheKey({ ...ITEM, productId: '2' }));
});

test('each answer is stamped with when it was fetched', async () => {
  const postJson = async () => LAPRAS_LISTINGS;
  assert.equal((await lookupListing(ITEM, { postJson, now: () => 1000 })).checkedAt, 1000);
  assert.equal((await lookupListing(ITEM, { postJson, now: () => 9999 })).checkedAt, 9999);
});
