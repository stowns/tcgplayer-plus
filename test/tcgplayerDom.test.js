import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { productIdFromUrl, canonicalProductUrl, languageFromUrl, parseProductPage } from '../src/lib/tcgplayerDom.js';
import { PRODUCT_PAGE, PRODUCT_PAGE_UNRENDERED, PRODUCT_URL } from './fixtures/tcgplayer.js';

const doc = (html) => new JSDOM(html, { url: PRODUCT_URL }).window.document;

test('productIdFromUrl reads the id, and only from a product page', () => {
  assert.equal(productIdFromUrl(PRODUCT_URL), '642621');
  assert.equal(productIdFromUrl('https://www.tcgplayer.com/search/pokemon/product'), null);
  assert.equal(productIdFromUrl(null), null);
});

test('canonicalProductUrl drops tracking but keeps the language', () => {
  assert.equal(
    canonicalProductUrl(PRODUCT_URL),
    'https://www.tcgplayer.com/product/642621/pokemon-sv-black-bolt-genesect-ex-169-086?Language=English',
  );
  assert.equal(
    canonicalProductUrl('https://www.tcgplayer.com/product/642621/x?page=4&utm_source=a'),
    'https://www.tcgplayer.com/product/642621/x',
  );
});

test('languageFromUrl defaults to English', () => {
  assert.equal(languageFromUrl(PRODUCT_URL), 'English');
  assert.equal(languageFromUrl('https://www.tcgplayer.com/product/1/x?Language=Japanese'), 'Japanese');
  assert.equal(languageFromUrl('https://www.tcgplayer.com/product/1/x'), 'English');
});

test('parseProductPage reads the card from a rendered page', () => {
  const p = parseProductPage(doc(PRODUCT_PAGE), PRODUCT_URL);
  assert.equal(p.productId, '642621');
  assert.equal(p.name, 'Genesect ex');
  assert.equal(p.number, '169/086');
  assert.equal(p.setName, 'SV: Black Bolt');
  assert.equal(p.category, 'Pokemon Cards');
  assert.equal(p.rarity, 'Special Illustration Rare');
  assert.equal(p.language, 'English');
  assert.match(p.imageUrl, /642621_in_1000x1000\.jpg$/);
  assert.equal(p.url, canonicalProductUrl(PRODUCT_URL));
});

test('parseProductPage records the prices showing when it was saved', () => {
  const p = parseProductPage(doc(PRODUCT_PAGE), PRODUCT_URL);
  assert.deepEqual(p.priceAtSave, {
    market: 45.59, lowest: 40.18, condition: 'Near Mint Holofoil', asLowAs: 38,
  });
});

test('parseProductPage still identifies the card before the page has rendered', () => {
  // The content script can run before the SPA paints; the meta tags are served
  // with the HTML and are enough to save something meaningful.
  const p = parseProductPage(doc(PRODUCT_PAGE_UNRENDERED), PRODUCT_URL);
  assert.equal(p.productId, '642621');
  assert.equal(p.name, 'Genesect ex');
  assert.equal(p.number, '169/086');
  assert.equal(p.setName, 'SV: Black Bolt');
  assert.equal(p.priceAtSave, null, 'no price is better than a wrong one');
});

test('parseProductPage returns null when the page is not a product', () => {
  assert.equal(parseProductPage(doc('<html><body></body></html>'), 'https://www.tcgplayer.com/search'), null);
});

test('parseProductPage splits number from rarity even though the number has a slash', () => {
  const html = PRODUCT_PAGE.replace(
    '<li><strong>Card Number / Rarity:</strong>169/086 / Special Illustration Rare</li>',
    '<li><strong>Card Number / Rarity:</strong>SV107 / Black White Rare</li>',
  );
  const p = parseProductPage(doc(html), PRODUCT_URL);
  assert.equal(p.number, 'SV107');
  assert.equal(p.rarity, 'Black White Rare');
});
