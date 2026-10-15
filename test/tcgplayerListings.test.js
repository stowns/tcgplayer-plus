import test from 'node:test';
import assert from 'node:assert/strict';
import {
  listingsUrl, listingsBody, parseLowestListing, listingUrl, isListingUrl, printingsBody, parsePrintings,
} from '../src/lib/tcgplayerListings.js';
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
    price: 9.32, shipping: 1.49, seller: 'Xerneas', url: '', count: 205,
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

const ROW = { productId: 535952, sellerKey: 'd8035033', condition: 'Near Mint', printing: 'Holofoil', language: 'English', price: 10, shippingPrice: 1.49, listingType: 'standard', sellerName: 'Shop' };

test('a listing links to the product page narrowed to its seller, condition, printing and language', () => {
  assert.equal(listingUrl(ROW), 'https://www.tcgplayer.com/product/535952?seller=d8035033&Condition=Near+Mint&Printing=Holofoil&Language=English&page=1');
  assert.equal(listingUrl({ productId: '7', sellerKey: 'abc' }), 'https://www.tcgplayer.com/product/7?seller=abc&page=1');
  assert.equal(listingUrl({ ...ROW, printing: '1st Edition Holofoil' }).includes('Printing=1st+Edition+Holofoil'), true);
});

test('no link is made without a plain seller key and product id', () => {
  for (const bad of [null, {}, { ...ROW, sellerKey: '' }, { ...ROW, sellerKey: undefined }, { ...ROW, sellerKey: 'a&b=c' }, { ...ROW, sellerKey: 'x/../y' },
    { ...ROW, productId: 'abc' }, { ...ROW, productId: undefined }]) assert.equal(listingUrl(bad), '');
});

test('what goes into the address is escaped, never trusted', () => {
  const url = listingUrl({ ...ROW, condition: 'Near Mint&seller=evil#x', language: '"><script>' });
  assert.equal(new URL(url).searchParams.get('seller'), 'd8035033');
  assert.equal(new URL(url).searchParams.get('Condition'), 'Near Mint&seller=evil#x');
  assert.doesNotMatch(url, /[<>"#]/);
  assert.equal(isListingUrl(url), true);
});

test('only addresses of that shape are accepted for a link', () => {
  assert.equal(isListingUrl(listingUrl(ROW)), true);
  for (const bad of ['', null, undefined, 5, 'javascript:alert(1)', 'https://evil.example/product/1?seller=a', 'http://www.tcgplayer.com/product/1?seller=a',
    'https://www.tcgplayer.com/product/1', 'https://www.tcgplayer.com/product/1?seller=a"onclick="x', 'https://www.tcgplayer.com.evil.example/product/1?seller=a',
    'https://www.tcgplayer.com/product/1?seller=a#frag', 'https://www.tcgplayer.com/product/1?seller=a b']) assert.equal(isListingUrl(bad), false, String(bad));
});

test('the cheapest listing carries its own link', () => {
  const json = { results: [{ totalResults: 2, results: [{ ...ROW, price: 12.87, shippingPrice: 0, sellerKey: 'other' }, ROW] }] };
  assert.equal(parseLowestListing(json).url, 'https://www.tcgplayer.com/product/535952?seller=d8035033&Condition=Near+Mint&Printing=Holofoil&Language=English&page=1');
});

test('a row that names another product is not this card\'s price', () => {
  const rows = [{ ...ROW, productId: 999, price: 3.4, shippingPrice: 0.99 }, { ...ROW, price: 32.28, shippingPrice: 1.22 }];
  const json = { results: [{ totalResults: 2, results: rows }] };
  assert.equal(parseLowestListing(json, { productId: '535952' }).price, 32.28);
  assert.equal(parseLowestListing(json).price, 3.4, 'nothing to check against, so nothing is left out');
  // A row that does not say which product it is is taken at its word.
  const bare = { results: [{ totalResults: 1, results: [{ price: 5, listingType: 'standard', shippingPrice: 0 }] }] };
  assert.equal(parseLowestListing(bare, { productId: '535952' }).price, 5);
  assert.equal(parseLowestListing({ results: [{ totalResults: 1, results: [rows[0]] }] }, { productId: 535952 }), null);
});

// ---- which printings a product is listed in ---------------------------------------------

test('the printings query is the listings search with no condition, asking only for the tally by printing', () => {
  const body = printingsBody();
  assert.deepEqual(body.filters.term, { sellerStatus: 'Live', channelId: 0, listingType: 'standard' });
  assert.deepEqual(body.aggregations, ['printing']);
  assert.equal(body.size, 1);
});

test('printings come back most-listed first, with their listing counts', () => {
  const json = { results: [{ totalResults: 324, results: [], aggregations: { printing: [
    { value: 'Reverse Holofoil', count: 45 }, { value: 'Holofoil', count: 279 },
  ] } }] };
  assert.deepEqual(parsePrintings(json), [{ name: 'Holofoil', listings: 279 }, { name: 'Reverse Holofoil', listings: 45 }]);
});

test('nothing listed is no printings; junk entries are left out; a response that is not the feed is null', () => {
  assert.deepEqual(parsePrintings({ results: [{ totalResults: 0, results: [], aggregations: { printing: [] } }] }), []);
  assert.deepEqual(parsePrintings({ results: [{ totalResults: 0, results: [] }] }), []);
  assert.deepEqual(parsePrintings({ results: [{ aggregations: { printing: [null, { value: '' , count: 3 }, { value: 'Normal', count: 0 }, { value: 'Normal ', count: 'x' }, { value: ' 1st  Edition ', count: 2 }, { value: '1st Edition', count: 1 }] } }] }),
    [{ name: '1st Edition', listings: 3 }], 'tidied and added up');
  for (const bad of [null, {}, { results: 'x' }, { results: [] }, { results: [null] }]) assert.equal(parsePrintings(bad), null);
});
