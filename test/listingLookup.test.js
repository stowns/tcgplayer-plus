import test from 'node:test';
import assert from 'node:assert/strict';
import { lookupListing, lookupPrintings, listingCacheKey } from '../src/lib/listingLookup.js';
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

// ---- a product that may be sealed ---------------------------------------------------------

test('when Near Mint has nothing listed and the product may be sealed, unopened copies are looked for', async () => {
  const calls = [];
  const postJson = async (url, body) => { calls.push(body.filters.term); return calls.length === 1 ? NO_LISTINGS : LAPRAS_LISTINGS; };
  const result = await lookupListing({ productId: '528039', condition: 'Near Mint', orSealed: true }, { postJson });
  assert.equal(result.status, 'ok');
  assert.deepEqual(calls.map((t) => t.condition), [['Near Mint'], ['Unopened']]);
});

test('that second look is not made when Near Mint has a listing, or when the product is known to be a card', async () => {
  let calls = 0;
  await lookupListing({ productId: '1', condition: 'Near Mint', orSealed: true }, { postJson: async () => { calls += 1; return LAPRAS_LISTINGS; } });
  assert.equal(calls, 1);
  calls = 0;
  const none = await lookupListing({ productId: '1', condition: 'Near Mint Holofoil' }, { postJson: async () => { calls += 1; return NO_LISTINGS; }, now: () => 5 });
  assert.equal(calls, 1);
  assert.deepEqual(none, { status: 'none', checkedAt: 5 }, 'a card with no Near Mint copies has no Ask, not a damaged one');
});

test('nothing listed either way is "none", and a failure on the second look is unavailable', async () => {
  const item = { productId: '1', condition: 'Near Mint Holofoil', orSealed: true };
  const terms = [];
  assert.equal((await lookupListing(item, { postJson: async (url, body) => { terms.push(body.filters.term); return NO_LISTINGS; } })).status, 'none');
  assert.deepEqual(terms[1].printing, ['Holofoil'], 'the printing is kept');
  let calls = 0;
  const failing = async () => { calls += 1; if (calls === 2) throw new Error('503'); return NO_LISTINGS; };
  assert.deepEqual(await lookupListing(item, { postJson: failing }), { status: 'unavailable' });
});

test('lookupPrintings asks the listings search for the product\'s tally by printing', async () => {
  const calls = [];
  const postJson = async (url, body) => { calls.push({ url, body }); return { results: [{ aggregations: { printing: [{ value: 'Holofoil', count: 9 }] } }] }; };
  assert.deepEqual(await lookupPrintings({ productId: '517016' }, { postJson }), { status: 'ok', printings: [{ name: 'Holofoil', listings: 9 }] });
  assert.equal(calls[0].url, 'https://mp-search-api.tcgplayer.com/v1/product/517016/listings');
  assert.deepEqual(calls[0].body.aggregations, ['printing']);
});

test('lookupPrintings fails soft', async () => {
  assert.deepEqual(await lookupPrintings({ productId: 'x' }, { postJson: async () => ({}) }), { status: 'unavailable' });
  assert.deepEqual(await lookupPrintings({ productId: '1' }, { postJson: async () => { throw new Error('503'); } }), { status: 'unavailable' });
  assert.deepEqual(await lookupPrintings({ productId: '1' }, { postJson: async () => ({ nonsense: true }) }), { status: 'unavailable' });
});
