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

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function load(initial = {}, page = PRODUCT_PAGE, url = PRODUCT_URL) {
  const dom = new JSDOM(page, {
    url, runScripts: 'outside-only', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const data = { ...initial };
  const listeners = [];
  const messages = [];
  window[apiName()] = {
    runtime: { sendMessage: async (m) => { messages.push(m); return {}; } },
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
