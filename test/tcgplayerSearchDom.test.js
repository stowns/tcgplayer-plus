import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { parseSearchCard, SEARCH_CARD_SELECTOR } from '../src/lib/tcgplayerDom.js';
import { searchPage, searchCard, SEARCH_URL, CATERPIE, BULBASAUR } from './fixtures/tcgplayerSearch.js';

const cardsOf = (html) => [...new JSDOM(html).window.document.querySelectorAll(SEARCH_CARD_SELECTOR)];

test('each result card on a search page is found', () => {
  assert.equal(cardsOf(searchPage()).length, 2);
});

test('a card gives everything a watch-list entry needs except its printing', () => {
  const [caterpie] = cardsOf(searchPage());
  assert.deepEqual(parseSearchCard(caterpie, SEARCH_URL), {
    productId: '517016',
    language: 'English',
    name: 'Caterpie',
    number: '172/165',
    setName: 'SV: Scarlet & Violet 151',
    category: '',
    rarity: 'Illustration Rare',
    imageUrl: '',
    url: 'https://www.tcgplayer.com/product/517016/pokemon-sv-scarlet-and-violet-151-caterpie-172-165',
    priceAtSave: { market: 16.3, lowest: null, condition: '', asLowAs: 13.74 },
  });
  assert.equal('printing' in parseSearchCard(caterpie, SEARCH_URL), false, 'chosen when it is saved');
});

test('cheap cards and their prices are read the same way', () => {
  const [, bulbasaur] = cardsOf(searchPage());
  const item = parseSearchCard(bulbasaur, SEARCH_URL);
  assert.deepEqual([item.productId, item.name, item.number, item.rarity], ['502445', 'Bulbasaur', '001/165', 'Common']);
  assert.deepEqual(item.priceAtSave, { market: 0.18, lowest: null, condition: '', asLowAs: 0.1 });
});

test('a language in the card\'s link is kept; without one it is English', () => {
  const html = searchPage([CATERPIE]).replace('?page=1', '?page=1&Language=Japanese');
  assert.equal(parseSearchCard(cardsOf(html)[0], SEARCH_URL).language, 'Japanese');
  assert.equal(parseSearchCard(cardsOf(html)[0], SEARCH_URL).url, 'https://www.tcgplayer.com/product/517016/pokemon-sv-scarlet-and-violet-151-caterpie-172-165?Language=Japanese');
});

test('a card with no prices shown is saved with none', () => {
  const html = searchPage([CATERPIE]).replace(/<span class="inventory__price-with-shipping">[^<]*<\/span>/, '').replace(/\$16\.30/, '');
  assert.equal(parseSearchCard(cardsOf(html)[0], SEARCH_URL).priceAtSave, null);
});

test('something that is not a product card is not one', () => {
  const { document } = new JSDOM('<div class="product-card"><a href="/search/other">x</a></div><div class="product-card"><span>no link</span></div>').window;
  for (const el of document.querySelectorAll('.product-card')) assert.equal(parseSearchCard(el, SEARCH_URL), null);
  assert.equal(parseSearchCard(null, SEARCH_URL), null);
  assert.equal(typeof searchCard, 'function');
  assert.ok(BULBASAUR.id);
});
