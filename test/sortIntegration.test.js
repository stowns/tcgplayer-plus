/*
 * Runs the *built* background page and home page together and sorts saved lists,
 * each list on its own.
 * TCGplayer's history feed is stubbed with real captured responses.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dist, apiName, messageBus, forEachBrowser } from './helpers/extensionApi.js';
import { JSDOM, VirtualConsole } from 'jsdom';
import { PIKACHU_HISTORY, GENESECT_HISTORY } from './fixtures/tcgplayerHistory.js';
import { NO_LISTINGS } from './fixtures/tcgplayerListings.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (check, limit = 8000) => {
  const start = Date.now();
  while (!check() && Date.now() - start < limit) await settle(25);
  await settle(30);
};

const item = (productId, name, savedAt, market) => ({
  key: `${productId}:english`, productId, language: 'English', name, setName: '', number: '', rarity: '',
  imageUrl: '', url: `https://www.tcgplayer.com/product/${productId}/x`, note: '', savedAt,
  priceAtSave: { market, lowest: market, condition: 'Near Mint Holofoil', asLowAs: market },
});

// Pikachu: $72.91 now, ~4.5% a day. Genesect: $45.59, ~0.3% a day. "Mystery": no feed, saved at $60.
const pikachu = () => item('712953', 'Pikachu ex', '2026-09-01T00:00:00.000Z', 50);
const genesect = () => item('642621', 'Genesect ex', '2026-09-02T00:00:00.000Z', 99);
const mystery = () => item('999001', 'Mystery Card', '2026-09-03T00:00:00.000Z', 60);

const freshLists = () => ({
  version: 1,
  lists: [
    { id: 'w', name: 'Watching', createdAt: '', updatedAt: '', items: [pikachu(), genesect(), mystery()] },
    { id: 'b', name: 'Buy', createdAt: '', updatedAt: '', items: [pikachu(), genesect()] },
    { id: 'o', name: 'One', createdAt: '', updatedAt: '', items: [pikachu()] },
  ],
});
const FEEDS = { 712953: PIKACHU_HISTORY, 642621: GENESECT_HISTORY };

// The cheapest live listing for each card: what it costs to buy, price + shipping.
//   Pikachu $70.00 + $2.50 = $72.50    Genesect $44.00 + $0 = $44.00    Mystery: nothing listed
const listing = (price, shippingPrice) => ({
  errors: [], results: [{ totalResults: 12, results: [{ price, shippingPrice, listingType: 'standard', sellerName: 'EmeraldElsya' }] }],
});
const LISTINGS = { 712953: listing(70, 2.5), 642621: listing(44, 0) };

function storageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null) return { ...data };
      return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) { Object.assign(data, items); },
    async remove(keys) { [].concat(keys).forEach((k) => delete data[k]); },
  };
}

async function startBackground() {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const requested = [];
  const asked = [];
  const bus = messageBus();
  window.fetch = async (url) => {
    if (/\/listings$/.test(url)) {
      const id = url.match(/product\/(\d+)\/listings/)[1];
      asked.push(id);
      return { ok: true, status: 200, json: async () => LISTINGS[id] || NO_LISTINGS };
    }
    requested.push(url);
    const id = url.match(/history\/(\d+)\//)[1];
    if (!FEEDS[id]) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => FEEDS[id] };
  };
  window[apiName()] = {
    storage: { local: storageArea() },
    runtime: bus.runtime,
    tabs: { create: async () => ({}) },
  };
  window.eval(await readFile(dist('background.js'), 'utf8'));
  return { requested, asked, send: bus.send };
}

async function openLists(background, local = storageArea({ lists: freshLists() })) {
  const html = await readFile('src/home/home.html', 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/home/home.html#lists', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  window[apiName()] = {
    storage: { local, onChanged: { addListener: () => {}, removeListener: () => {} } },
    runtime: { sendMessage: (m) => background.send(m) },
  };
  window.eval(await readFile(dist('home/home.js'), 'utf8'));
  await settle();
  const d = window.document;
  const section = (name) => [...d.querySelectorAll('.list')].find((l) => l.querySelector('.list__name').textContent === name);
  return {
    window, document: d, local,
    section,
    names: (list) => [...section(list).querySelectorAll('.item__name')].map((a) => a.textContent),
    choose: async (list, key) => {
      const select = section(list).querySelector('.list__sort-select');
      select.value = key;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settle();
    },
    reverse: async (list) => { section(list).querySelector('.list__sort-direction').click(); await settle(); },
    loaded: (count) => until(() => count === undefined || !d.querySelector('#status').textContent),
  };
}

const idle = (bg, page, n, field = 'requested') => until(() => bg[field].length === n && !page.document.querySelector('#status').textContent);

forEachBrowser(() => {

test('every list sorts by date added, newest first, until it is told otherwise', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  assert.deepEqual(page.names('Watching'), ['Mystery Card', 'Genesect ex', 'Pikachu ex']);
  assert.deepEqual(page.names('Buy'), ['Genesect ex', 'Pikachu ex']);
  for (const name of ['Watching', 'Buy']) {
    const control = page.section(name).querySelector('.list__sort-select');
    assert.equal(control.value, 'added');
    assert.deepEqual([...control.options].map((o) => o.textContent), ['Date added', 'Ask', 'Volatility']);
    assert.equal(page.section(name).querySelector('.list__sort-direction').textContent, 'Newest first');
  }
  assert.equal(bg.requested.length, 0, 'sorting by date needs no price history');
});

test('there is no page-wide sort: the controls belong to the lists', async () => {
  const page = await openLists(await startBackground());
  assert.equal(page.document.getElementById('listsSort'), null);
  assert.equal(page.document.querySelectorAll('.page-actions select').length, 0);
  assert.equal(page.document.querySelectorAll('.list__sort-select').length, 2, 'one per list that has something to order');
});

test('a list with a single card has nothing to order, so it has no sort control', async () => {
  const page = await openLists(await startBackground());
  assert.equal(page.section('One').querySelector('.list__sort'), null);
});

test('sorting one list leaves the others alone', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  await idle(bg, page, 3, 'asked');
  assert.deepEqual(page.names('Watching'), ['Pikachu ex', 'Genesect ex', 'Mystery Card']);
  assert.deepEqual(page.names('Buy'), ['Genesect ex', 'Pikachu ex'], 'Buy is still newest first');
  assert.equal(page.section('Buy').querySelector('.list__sort-select').value, 'added');
  assert.equal(page.section('Watching').querySelector('.list__sort-select').value, 'ask');
});

test('two lists can be sorted two different ways at once', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  await page.choose('Buy', 'volatility');
  await idle(bg, page, 2);
  await page.reverse('Buy');
  assert.deepEqual(page.names('Watching'), ['Pikachu ex', 'Genesect ex', 'Mystery Card']);
  assert.deepEqual(page.names('Buy'), ['Genesect ex', 'Pikachu ex'], 'steadiest first');
  assert.equal(page.section('Buy').querySelector('.list__sort-direction').textContent, 'Steadiest first');
  assert.equal(page.section('Watching').querySelector('.list__sort-direction').textContent, 'Highest first');
});

test('the direction button reverses just its own list and says what it now means', async () => {
  const page = await openLists(await startBackground());
  await page.reverse('Watching');
  assert.deepEqual(page.names('Watching'), ['Pikachu ex', 'Genesect ex', 'Mystery Card']);
  assert.equal(page.section('Watching').querySelector('.list__sort-direction').textContent, 'Oldest first');
  assert.deepEqual(page.names('Buy'), ['Genesect ex', 'Pikachu ex']);
  await page.reverse('Watching');
  assert.deepEqual(page.names('Watching'), ['Mystery Card', 'Genesect ex', 'Pikachu ex']);
});

test('ask looks up the cheapest listing of the list\'s own cards, including ones never scrolled to', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Buy', 'ask');
  await idle(bg, page, 2, 'asked');
  assert.deepEqual([...bg.asked].sort(), ['642621', '712953']);
  assert.equal(bg.requested.length, 0, 'an ask needs no price history');
  assert.deepEqual(page.names('Buy'), ['Pikachu ex', 'Genesect ex']);
});

test('each item shows its Market (as saved) and then its Ask, price plus shipping', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  await idle(bg, page, 3, 'asked');
  const row = (name) => [...page.section('Watching').querySelectorAll('.item')].find((r) => r.textContent.includes(name));
  assert.equal(row('Pikachu ex').querySelector('.item__price').textContent,
    'Market $50.00 · Ask $72.50 ($70.00 + $2.50 shipping)');
  assert.equal(row('Genesect ex').querySelector('.item__price').textContent,
    'Market $99.00 · Ask $44.00 ($44.00, free shipping)');
  assert.equal(row('Mystery Card').querySelector('.item__price').textContent, 'Market $60.00 · Ask: none listed');
});

test('the sort is by the ask, not by the Market price saved with the card', async () => {
  // Genesect was saved with the higher Market ($99) but costs less to buy ($44) than Pikachu ($72.50).
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  await idle(bg, page, 3, 'asked');
  assert.deepEqual(page.names('Watching').slice(0, 2), ['Pikachu ex', 'Genesect ex']);
  await page.reverse('Watching');
  assert.deepEqual(page.names('Watching'), ['Genesect ex', 'Pikachu ex', 'Mystery Card'], 'cheapest first; nothing listed stays last');
});

test('a row shows its ask when it scrolls into view, without any sort being chosen', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  assert.equal(bg.asked.length, 0, 'nothing is fetched for rows that have not been seen');
  assert.match(page.section('Watching').querySelector('.item__ask').className, /item__ask--loading/);
});

test('volatility sorts the choppiest first, and cards with no history stay last either way round', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'volatility');
  await idle(bg, page, 3);
  assert.deepEqual(page.names('Watching'), ['Pikachu ex', 'Genesect ex', 'Mystery Card']);
  await page.reverse('Watching');
  assert.deepEqual(page.names('Watching'), ['Genesect ex', 'Pikachu ex', 'Mystery Card']);
});

test('a card saved in two lists is looked up once, and another list\'s sort reuses it', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  await idle(bg, page, 3, 'asked');
  await page.choose('Buy', 'ask');
  await settle(150);
  assert.equal(bg.asked.length, 3, 'Buy\'s two cards were already looked up for Watching');
  assert.deepEqual(page.names('Buy'), ['Pikachu ex', 'Genesect ex']);
});

test('the sort is saved with the list, so it survives closing and reopening the page', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  await page.reverse('Watching');
  await idle(bg, page, 3, 'asked');
  const saved = page.local.data.lists.lists.find((l) => l.name === 'Watching');
  assert.deepEqual([saved.sort.key, saved.sort.dir], ['ask', 'asc']);
  assert.equal(page.local.data.lists.lists.find((l) => l.name === 'Buy').sort, undefined, 'untouched lists store nothing');

  const again = await openLists(await startBackground(), page.local);
  assert.equal(again.section('Watching').querySelector('.list__sort-select').value, 'ask');
  await until(() => !again.document.querySelector('#status').textContent);
  assert.deepEqual(again.names('Watching'), ['Genesect ex', 'Pikachu ex', 'Mystery Card']);
  assert.equal(again.section('Buy').querySelector('.list__sort-select').value, 'added');
});

test('changing a list\'s sort is a display choice: it does not count as editing the list', async () => {
  const lists = freshLists();
  lists.lists[0].updatedAt = '2026-09-10T00:00:00.000Z';
  const page = await openLists(await startBackground(), storageArea({ lists }));
  await page.reverse('Watching');
  assert.equal(page.local.data.lists.lists[0].updatedAt, '2026-09-10T00:00:00.000Z');
});

test('while prices load, the page says so', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  assert.match(page.document.querySelector('#status').textContent, /Loading prices for 3 cards/);
  await until(() => !page.document.querySelector('#status').textContent);
});

test('a list sorted by date needs nothing looked up, even when another list is sorted by ask', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Buy', 'ask');
  await idle(bg, page, 2, 'asked');
  assert.equal(bg.asked.length, 2, 'only Buy\'s two cards, not Watching\'s Mystery Card');
});

});
