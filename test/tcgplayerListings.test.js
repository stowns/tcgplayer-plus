import test from 'node:test';
import assert from 'node:assert/strict';
import { listingsUrl, listingsBody, parseLowestListing } from '../src/lib/tcgplayerListings.js';
import { LAPRAS_LISTINGS, NO_LISTINGS } from './fixtures/tcgplayerListings.js';

test('listingsUrl targets the product and refuses anything that is not a numeric id', () => {
  assert.equal(listingsUrl('696683'), 'https://mp-search-api.tcgplayer.com/v1/product/696683/listings');
  for (const bad of ['', null, undefined, '12/../3', 'abc', '1 2']) assert.throws(() => listingsUrl(bad));
});

test('listingsBody narrows to the condition and printing that was bought', () => {
  const { filters, sort } = listingsBody('Near Mint Holofoil');
  assert.deepEqual(filters.term.condition, ['Near Mint']);
  assert.deepEqual(filters.term.printing, ['Holofoil']);
  assert.equal(filters.term.listingType, 'standard');
  assert.equal(filters.term.sellerStatus, 'Live');
  assert.deepEqual(sort, { field: 'price+shipping', order: 'asc' });
  assert.equal(filters.range.quantity.gte, 1);
});

test('listingsBody handles two-word printings and lower conditions', () => {
  const { term } = listingsBody('Lightly Played Reverse Holofoil').filters;
  assert.deepEqual(term.condition, ['Lightly Played']);
  assert.deepEqual(term.printing, ['Reverse Holofoil']);
});

test('listingsBody leaves out filters it cannot know (sealed products, no condition text)', () => {
  const { term } = listingsBody('').filters;
  assert.equal('condition' in term, false);
  assert.equal('printing' in term, false);
  assert.equal('condition' in listingsBody('Near Mint').filters.term, true);
  assert.equal('printing' in listingsBody('Near Mint').filters.term, false);
});

test('parseLowestListing takes the cheapest standard listing and ignores custom ones', () => {
  assert.deepEqual(parseLowestListing(LAPRAS_LISTINGS), {
    price: 9.32, shipping: 1.49, seller: 'Xerneas', count: 205,
  });
});

test('parseLowestListing does not trust the order of the rows', () => {
  const json = { results: [{ totalResults: 3, results: [
    { price: 12, listingType: 'standard', shippingPrice: 0 },
    { price: 4.5, listingType: 'standard', shippingPrice: 0.99, sellerName: 'A' },
    { price: 8, listingType: 'standard', shippingPrice: 0 },
  ] }] };
  assert.equal(parseLowestListing(json).price, 4.5);
  assert.equal(parseLowestListing(json).shipping, 0.99);
});

test('a cheap card with heavy postage is not the cheapest way to buy it', () => {
  // Real: Frogadier had a $1.00 listing carrying $19.99 shipping.
  const json = { results: [{ totalResults: 3, results: [
    { price: 1, listingType: 'standard', shippingPrice: 19.99, sellerName: 'Postage Pirate' },
    { price: 2.4, listingType: 'standard', shippingPrice: 1.49, sellerName: 'Fair' },
    { price: 4, listingType: 'standard', shippingPrice: 0, sellerName: 'Free' },
  ] }] };
  const lowest = parseLowestListing(json);
  assert.equal(lowest.seller, 'Fair');
  assert.equal(lowest.price, 2.4);
  assert.equal('landed' in lowest, false);
});

test('on equal cost to buy, the lower item price wins', () => {
  const json = { results: [{ results: [
    { price: 5, listingType: 'standard', shippingPrice: 0, sellerName: 'Free' },
    { price: 4, listingType: 'standard', shippingPrice: 1, sellerName: 'Cheaper item' },
  ] }] };
  assert.equal(parseLowestListing(json).seller, 'Cheaper item');
});

test('parseLowestListing returns null when nothing usable is for sale', () => {
  assert.equal(parseLowestListing(NO_LISTINGS), null);
  const onlyCustom = { results: [{ results: [{ price: 7, listingType: 'custom' }] }] };
  assert.equal(parseLowestListing(onlyCustom), null);
});

test('parseLowestListing rejects rows with no usable price and malformed responses', () => {
  const junk = { results: [{ results: [{ price: 0 }, { price: -3 }, { price: 'x' }, {}, null] }] };
  assert.equal(parseLowestListing(junk), null);
  for (const bad of [null, undefined, {}, [], { results: [] }, { results: [{}] }, 'no']) {
    assert.equal(parseLowestListing(bad), null);
  }
});

test('parseLowestListing rounds prices to cents and defaults missing shipping to free', () => {
  const json = { results: [{ results: [{ price: 3.1000000001, listingType: 'standard' }] }] };
  const lowest = parseLowestListing(json);
  assert.equal(lowest.price, 3.1);
  assert.equal(lowest.shipping, 0);
  assert.equal(lowest.count, 0);
});
