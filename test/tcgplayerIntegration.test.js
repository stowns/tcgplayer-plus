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

const settle = () => new Promise((r) => setTimeout(r, 30));

async function load(initial = {}) {
  const dom = new JSDOM(PRODUCT_PAGE, {
    url: PRODUCT_URL, runScripts: 'outside-only', pretendToBeVisual: true,
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
  assert.equal(button(document).textContent, 'Save to list');
  assert.ok(document.querySelector('.product-details__header .ptcg-list-control'), 'next to the title');
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
  assert.equal(button(document).textContent, 'Saved in 1 list');
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
  assert.equal(button(document).textContent, 'Saved in 1 list');
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

test('Manage lists asks the extension to open the lists page', async () => {
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
  assert.equal(button(document).textContent, 'Saved in 1 list');

  document.querySelector('.product-details__name').click();
  assert.equal(panel().hidden, true, 'clicking elsewhere on the page closes it');

  button(document).click();
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel().hidden, true, 'Escape closes it too');
});

});
