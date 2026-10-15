/*
 * Runs the built TCGplayer content script against a product page in jsdom,
 * with a stubbed WebExtension storage.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dist, apiName, messageBus, forEachBrowser } from './helpers/extensionApi.js';
import { JSDOM, VirtualConsole } from 'jsdom';
import { PRODUCT_PAGE, PRODUCT_URL } from './fixtures/tcgplayer.js';
import { searchPage, searchCard, SEARCH_URL, CATERPIE, BULBASAUR } from './fixtures/tcgplayerSearch.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function load(initial = {}, page = PRODUCT_PAGE, url = PRODUCT_URL, { answer = () => ({}) } = {}) {
  const dom = new JSDOM(page, {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const data = { ...initial };
  const listeners = [];
  const messages = [];
  window[apiName()] = {
    runtime: { sendMessage: async (m) => { messages.push(m); return answer(m); } },
    storage: {
      local: {
        get: async (key) => (key in data ? { [key]: data[key] } : {}),
        set: async (items) => {
          Object.assign(data, items);
          listeners.forEach((fn) => fn({ lists: { newValue: data.lists } }, 'local'));
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
  };
  window.eval(await readFile(dist('content/tcgplayerProduct.js'), 'utf8'));
  await settle();
  return { window, document: window.document, data, messages };
}

const button = (d) => d.querySelector('.ptcg-list-button');

forEachBrowser(() => {

test('the built script adds a Save control to the product page', async () => {
  const { document } = await load();
  assert.ok(button(document), 'a save button is injected');
  assert.equal(button(document).textContent, 'Add to watch list');
  assert.ok(document.querySelector('.product-details__header .ptcg-list-control'), 'next to the title');
});

// A layout of the product page with no header and no name in the body, only the metadata.
const NO_HEADER_PAGE = PRODUCT_PAGE
  .replace(/<div class="product-details__header">[\s\S]*?<\/h1>\s*<\/div>/, '')
  .replace(/<div class="product-details__spotlight">[\s\S]*?<\/div><\/div>/, '');

test('a page with no header still gets the control, in a bar at the top of the product section', async () => {
  assert.doesNotMatch(NO_HEADER_PAGE, /product-details__name/, 'the fixture really has no heading');
  const bare = await load({ lists: { version: 1, lists: [{ id: 'a', name: 'Watchlist', items: [] }] } }, NO_HEADER_PAGE);
  assert.ok(bare.document.querySelector('.product-details > .ptcg-save-bar .ptcg-list-control'));
  assert.equal(button(bare.document).textContent, 'Add to watch list');
  assert.equal(bare.document.querySelectorAll('.ptcg-list-control').length, 1);
  button(bare.document).click();
  const box = bare.document.querySelector('.ptcg-list-panel input[type="checkbox"]');
  box.checked = true;
  box.dispatchEvent(new bare.window.Event('change'));
  await settle();
  const [saved] = bare.data.lists.lists[0].items;
  assert.equal(saved.productId, '642621');
  assert.equal(saved.name, 'Genesect ex', 'the name comes from the page metadata');
});

// The button is drawn as soon as the header exists, which can be before the page has put the card's name in it.
const NAME_LATER_PAGE = PRODUCT_PAGE
  .replace(/<h1 class="product-details__name">[^<]*<\/h1>/, '<h1 class="product-details__name"></h1>')
  .replace(/<meta property="og:title"[^>]*>/g, '');

test('a card is saved with the name the page shows when you save, not when the button was drawn', async () => {
  assert.doesNotMatch(NAME_LATER_PAGE, /og:title/);
  const page = await load({ lists: { version: 1, lists: [{ id: 'a', name: 'Watchlist', items: [] }] } }, NAME_LATER_PAGE);
  const { document, window, data } = page;
  assert.ok(button(document), 'the button is there before the name is');
  button(document).click();
  const tick = () => {
    const box = document.querySelector('.ptcg-list-panel input[type="checkbox"]');
    box.checked = true;
    box.dispatchEvent(new window.Event('change'));
    return settle();
  };

  await tick();
  assert.equal(data.lists.lists[0].items.length, 0, 'nothing is saved without a name');
  assert.match(document.querySelector('.ptcg-list-error').textContent, /not finished loading/i);

  document.querySelector('h1.product-details__name').textContent = 'Maushold - 146/128 - ME: 30th Celebration (30C)';
  await tick();
  const [saved] = data.lists.lists[0].items;
  assert.equal(saved.name, 'Maushold');
  assert.equal(saved.setName.length > 0, true);
});

test('when the header turns up after the bar was used, the control moves beside the name', async () => {
  const bare = await load({}, NO_HEADER_PAGE);
  const { document } = bare;
  assert.ok(document.querySelector('.ptcg-save-bar .ptcg-list-control'));
  const header = document.createElement('div');
  header.className = 'product-details__header';
  header.innerHTML = '<h1 class="product-details__name">Genesect ex - 169/086 - SV: Black Bolt (BLK)</h1>';
  document.querySelector('.product-details').append(header);
  await settle(80);
  assert.ok(header.querySelector('.ptcg-list-control'), 'moved beside the name');
  assert.equal(document.querySelector('.ptcg-save-bar'), null, 'the empty bar is gone');
  assert.equal(document.querySelectorAll('.ptcg-list-control').length, 1);
});

// The site is one document: a search result opens a product without a reload.
const SEARCH_URL = 'https://www.tcgplayer.com/search/pokemon/product?q=genesect';
const SEARCH_PAGE = '<!doctype html><html><head><title>Search</title></head><body><div class="search-layout"><a href="/product/642621/x">Genesect ex</a></div></body></html>';
const productBody = () => new JSDOM(PRODUCT_PAGE).window.document.body.innerHTML;

test('arriving at a product from a search, without a reload, still gets the button', async () => {
  const page = await load({}, SEARCH_PAGE, SEARCH_URL);
  const { window, document } = page;
  assert.equal(button(document), null, 'nothing on a page that is not a product');
  assert.equal(document.querySelector('.ptcg-save-bar'), null);

  window.history.pushState({}, '', PRODUCT_URL);
  document.body.innerHTML = productBody();
  await settle(80);
  assert.ok(document.querySelector('.product-details__header .ptcg-list-control'), 'beside the name');
  assert.equal(document.querySelectorAll('.ptcg-list-control').length, 1);

  // And it saves this product.
  button(document).click();
  const name = document.querySelector('.ptcg-list-panel input[type="text"]');
  name.value = 'Watching';
  name.closest('form').dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle(60);
  assert.equal(page.data.lists.lists[0].items[0].productId, '642621');

  // Back to the search: the button goes with the product.
  window.history.pushState({}, '', SEARCH_URL);
  document.body.innerHTML = '<div class="search-layout"></div>';
  await settle(80);
  assert.equal(button(document), null);
});

// ---- the cards of a search page -------------------------------------------------------------

const PRINTINGS = {
  517016: [{ value: 'Holofoil', count: 279 }],
  502445: [{ value: 'Reverse Holofoil', count: 300 }, { value: 'Normal', count: 612 }],
};
const answerPrintings = (m) => (m.type === 'product-printings'
  ? { status: 'ok', printings: (PRINTINGS[m.item.productId] || []).map((p) => ({ name: p.value, listings: p.count })).sort((a, b) => b.listings - a.listings) }
  : {});
const openSearch = (initial = {}, options = {}) => load(initial, searchPage(), SEARCH_URL, { answer: answerPrintings, ...options });
const cardOf = (d, name) => [...d.querySelectorAll('.search-result .product-card')].find((c) => c.textContent.includes(name));
// Compared as text: these were made in the page's own JavaScript realm.
const same = (actual, expected, message) => assert.equal(JSON.stringify(actual), JSON.stringify(expected), message);
const watchList = () => ({ lists: { version: 1, lists: [{ id: 'a', name: 'Watchlist', items: [] }, { id: 'b', name: 'Trades', items: [] }] } });
// A search card's panel opens on the page, not inside the card.
const panelOf = (card) => card.querySelector('.ptcg-list-control').panel;
const tickList = async (page, card, index = 0, checked = true) => {
  const box = panelOf(card).querySelectorAll('input[type="checkbox"]')[index];
  box.checked = checked;
  box.dispatchEvent(new page.window.Event('change'));
  await settle(40);
};

test('every result on a search page gets its own button, outside the card\'s link', async () => {
  const { document } = await openSearch();
  const cards = [...document.querySelectorAll('.search-result .product-card')];
  assert.equal(cards.length, 2);
  for (const card of cards) {
    const control = card.querySelector(':scope > .ptcg-list-control.ptcg-list-control--card');
    assert.ok(control, 'one each');
    assert.equal(control.closest('a'), null, 'not inside the link, so it cannot open the product');
    assert.equal(control.querySelector('.ptcg-list-button').textContent, 'Add to watch list');
  }
  assert.equal(document.querySelectorAll('.ptcg-list-control').length, 2);
});

test('a card with one printing goes straight to the lists, and is saved with that printing', async () => {
  const page = await openSearch(watchList());
  const card = cardOf(page.document, 'Caterpie');
  card.querySelector('.ptcg-list-button').click();
  await settle(40);
  same(page.messages.filter((m) => m.type === 'product-printings'), [{ type: 'product-printings', item: { productId: '517016' } }]);
  assert.equal(panelOf(card).querySelector('.ptcg-printing-chosen').textContent, 'Printing: Holofoil');
  await tickList(page, card);
  const [saved] = page.data.lists.lists[0].items;
  same(
    [saved.key, saved.productId, saved.name, saved.number, saved.setName, saved.rarity, saved.printing, saved.url],
    ['517016:english:holofoil', '517016', 'Caterpie', '172/165', 'SV: Scarlet & Violet 151', 'Illustration Rare', 'Holofoil', 'https://www.tcgplayer.com/product/517016/pokemon-sv-scarlet-and-violet-151-caterpie-172-165'],
  );
  same(saved.priceAtSave, { market: 16.3, lowest: null, condition: '', asLowAs: 13.74 });
  assert.equal(card.querySelector('.ptcg-list-button').textContent, 'On 1 watch list');
});

test('a card with several printings asks which, then saves that one; the other can be saved as well', async () => {
  const page = await openSearch(watchList());
  const card = cardOf(page.document, 'Bulbasaur');
  card.querySelector('.ptcg-list-button').click();
  await settle(40);
  assert.deepEqual([...panelOf(card).querySelectorAll('.ptcg-printing-choice')].map((b) => b.getAttribute('data-printing')), ['Normal', 'Reverse Holofoil']);
  assert.equal(panelOf(card).querySelector('.ptcg-list-step').hidden, true);
  panelOf(card).querySelector('.ptcg-printing-choice[data-printing="Reverse Holofoil"]').click();
  await settle(30);
  await tickList(page, card);
  panelOf(card).querySelector('.ptcg-printing-change').click();
  panelOf(card).querySelector('.ptcg-printing-choice[data-printing="Normal"]').click();
  await settle(30);
  assert.equal(panelOf(card).querySelectorAll('input[type="checkbox"]')[0].checked, false, 'Normal is not on the list yet');
  await tickList(page, card);
  same(page.data.lists.lists[0].items.map((i) => [i.key, i.printing]), [
    ['502445:english:normal', 'Normal'], ['502445:english:reverse holofoil', 'Reverse Holofoil'],
  ]);
  assert.equal(card.querySelector('.ptcg-list-button').textContent, 'On 1 watch list', 'one list holds the product');

  // Unticking takes off only the printing shown.
  await tickList(page, card, 0, false);
  same(page.data.lists.lists[0].items.map((i) => i.printing), ['Reverse Holofoil']);
});

test('creating a list from a search card saves the card, in its printing, into it', async () => {
  const page = await openSearch();
  const card = cardOf(page.document, 'Caterpie');
  card.querySelector('.ptcg-list-button').click();
  await settle(40);
  const form = panelOf(card).querySelector('form');
  form.querySelector('input[type="text"]').value = 'Illustration rares';
  form.dispatchEvent(new page.window.Event('submit', { cancelable: true }));
  await settle(40);
  assert.equal(page.data.lists.lists[0].name, 'Illustration rares');
  assert.equal(page.data.lists.lists[0].items[0].printing, 'Holofoil');
});

test('a card already saved from its product page shows as saved, and is not added twice', async () => {
  const fromProductPage = { key: '517016:english', productId: '517016', name: 'Caterpie', priceAtSave: { condition: 'Near Mint Holofoil' } };
  const initial = watchList();
  initial.lists.lists[0].items = [fromProductPage];
  const page = await openSearch(initial);
  const card = cardOf(page.document, 'Caterpie');
  assert.equal(card.querySelector('.ptcg-list-button').textContent, 'On 1 watch list');
  card.querySelector('.ptcg-list-button').click();
  await settle(40);
  assert.equal(panelOf(card).querySelectorAll('input[type="checkbox"]')[0].checked, true, 'the same printing');
  await tickList(page, card, 0, true);
  assert.equal(page.data.lists.lists[0].items.length, 1);
});

test('when the printings cannot be found the card says so, and nothing is saved', async () => {
  const page = await openSearch(watchList(), { answer: () => ({ status: 'unavailable' }) });
  const card = cardOf(page.document, 'Caterpie');
  card.querySelector('.ptcg-list-button').click();
  await settle(40);
  assert.match(panelOf(card).querySelector('.ptcg-printing').textContent, /Could not find out which printings/);
  assert.equal(panelOf(card).querySelector('.ptcg-list-step').hidden, true);
  assert.equal(page.data.lists.lists[0].items.length, 0);
});

test('the panel opens on the page under the button, and goes when its card is drawn over', async () => {
  const page = await openSearch();
  const card = cardOf(page.document, 'Caterpie');
  card.querySelector('.ptcg-list-button').click();
  await settle(40);
  const panel = panelOf(card);
  assert.equal(panel.parentElement, page.document.body, 'not inside the card, which cuts off what overflows it');
  assert.ok(panel.classList.contains('ptcg-list-panel--floating'));
  assert.match(panel.style.top, /px$/);
  page.document.querySelector('.search-results').innerHTML = searchCard(BULBASAUR);
  await settle(80);
  assert.equal(panel.isConnected, false, 'nothing left floating on the page');
});

test('results drawn again (a new page of results) get buttons, and the old ones are let go', async () => {
  const page = await openSearch();
  page.document.querySelector('.search-results').innerHTML = searchCard(BULBASAUR) + searchCard({ ...CATERPIE, id: '517017', name: 'Metapod' });
  await settle(80);
  const cards = [...page.document.querySelectorAll('.search-result .product-card')];
  assert.equal(cards.length, 2);
  for (const card of cards) assert.equal(card.querySelectorAll('.ptcg-list-control').length, 1);
});

test('a product page saves the printing it shows, and still finds a card saved before printings were kept', async () => {
  const page = await load(watchList());
  button(page.document).click();
  const box = page.document.querySelector('.ptcg-list-panel input[type="checkbox"]');
  box.checked = true;
  box.dispatchEvent(new page.window.Event('change'));
  await settle();
  const [saved] = page.data.lists.lists[0].items;
  same([saved.key, saved.printing], ['642621:english:holofoil', 'Holofoil']);
  assert.equal(page.document.querySelector('.ptcg-printing-chosen').hidden, true, 'no printing step on a product page');
});

test('creating a list from the panel saves the card into it', async () => {
  const { document, window, data } = await load();
  button(document).click();
  const form = document.querySelector('.ptcg-list-panel form');
  form.querySelector('input[type="text"]').value = 'Watchlist';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();

  const [list] = data.lists.lists;
  assert.equal(list.name, 'Watchlist');
  assert.equal(list.items.length, 1);
  assert.deepEqual(
    {
      productId: list.items[0].productId,
      name: list.items[0].name,
      setName: list.items[0].setName,
      number: list.items[0].number,
      language: list.items[0].language,
    },
    {
      productId: '642621', name: 'Genesect ex', setName: 'SV: Black Bolt',
      number: '169/086', language: 'English',
    },
  );
  assert.equal(list.items[0].priceAtSave.market, 45.59, 'the price at the time is kept');
  assert.equal(button(document).textContent, 'On 1 watch list');
});

test('the button shows where a product is already saved when the page opens', async () => {
  const { document } = await load({
    lists: {
      version: 1,
      lists: [
        { id: 'a', name: 'Watchlist', items: [{ key: '642621:english', productId: '642621', name: 'Genesect ex' }] },
        { id: 'b', name: 'Trades', items: [] },
      ],
    },
  });
  assert.equal(button(document).textContent, 'On 1 watch list');
  button(document).click();
  const boxes = [...document.querySelectorAll('.ptcg-list-panel input[type="checkbox"]')];
  assert.deepEqual(boxes.map((b) => b.checked), [true, false]);
});

test('ticking and unticking a list saves and unsaves the card', async () => {
  const { document, window, data } = await load({
    lists: { version: 1, lists: [{ id: 'a', name: 'Watchlist', items: [] }] },
  });
  button(document).click();
  const box = document.querySelector('.ptcg-list-panel input[type="checkbox"]');

  box.checked = true;
  box.dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(data.lists.lists[0].items.length, 1);

  document.querySelector('.ptcg-list-panel input[type="checkbox"]').checked = false;
  document.querySelector('.ptcg-list-panel input[type="checkbox"]').dispatchEvent(new window.Event('change'));
  await settle();
  assert.equal(data.lists.lists[0].items.length, 0);
});

test('saving the same card twice does not duplicate it', async () => {
  const { document, window, data } = await load({
    lists: { version: 1, lists: [{ id: 'a', name: 'Watchlist', items: [] }] },
  });
  for (let i = 0; i < 2; i += 1) {
    button(document).click();
    const box = document.querySelector('.ptcg-list-panel input[type="checkbox"]');
    box.checked = true;
    box.dispatchEvent(new window.Event('change'));
    await settle();
  }
  assert.equal(data.lists.lists[0].items.length, 1);
});

test('a refused name is reported in the panel, not swallowed', async () => {
  const { document, window } = await load({
    lists: { version: 1, lists: [{ id: 'a', name: 'Watchlist', items: [] }] },
  });
  button(document).click();
  const form = document.querySelector('.ptcg-list-panel form');
  form.querySelector('input[type="text"]').value = 'watchlist';
  form.dispatchEvent(new window.Event('submit', { cancelable: true }));
  await settle();
  assert.match(document.querySelector('.ptcg-list-error').textContent, /already exists/i);
});

test('Manage watch lists asks the extension to open the lists page', async () => {
  const { document, messages } = await load();
  button(document).click();
  document.querySelector('.ptcg-list-manage').click();
  assert.deepEqual(messages.map((m) => m.type), ['open-lists']);
});

test('the panel stays open while ticking a list, then closes on an outside click', async () => {
  const { document, window } = await load({
    lists: { version: 1, lists: [{ id: 'a', name: 'Watchlist', items: [] }] },
  });
  button(document).click();
  const panel = () => document.querySelector('.ptcg-list-panel');

  const box = panel().querySelector('input[type="checkbox"]');
  box.click(); // real click: fires click, then change, then the rows are redrawn
  await settle();
  assert.equal(panel().hidden, false, 'saving must not dismiss the panel');
  assert.equal(button(document).textContent, 'On 1 watch list');

  document.querySelector('.product-details__name').click();
  assert.equal(panel().hidden, true, 'clicking elsewhere on the page closes it');

  button(document).click();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel().hidden, true, 'Escape closes it too');
});

});
