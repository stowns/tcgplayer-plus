/*
 * Runs the *built* background page and home page together and sorts watch lists,
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
    if (!FEEDS[id]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => FEEDS[id] };
  };
  window[apiName()] = {
    storage: { local: storageArea() },
    runtime: bus.runtime,
    action: bus.action,
    tabs: { create: async () => ({}), sendMessage: bus.tabs.sendMessage },
  };
  window.eval(await readFile(dist('background.js'), 'utf8'));
  return { requested, asked, send: bus.send, pageRuntime: bus.pageRuntime };
}

async function openLists(background, local = storageArea({ lists: freshLists() }), { remembered = {}, brokenStorage = false } = {}) {
  const html = await readFile('src/home/home.html', 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/home/home.html#lists', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (brokenStorage) Object.defineProperty(window, 'localStorage', { get() { throw new Error('storage blocked'); } });
  else for (const [key, value] of Object.entries(remembered)) window.localStorage.setItem(key, value);
  window.confirm = () => true;
  window.prompt = () => 'Brand new';
  window[apiName()] = {
    storage: { local, onChanged: { addListener: () => {}, removeListener: () => {} } },
    runtime: background.pageRuntime(),
  };
  window.eval(await readFile(dist('home/home.js'), 'utf8'));
  await settle();
  const d = window.document;
  const show = async (name) => {
    const dropdown = d.querySelector('.lists-toolbar__list');
    const option = [...dropdown.options].find((o) => o.textContent.startsWith(`${name} (`));
    if (dropdown.value === option.value) return;
    dropdown.value = option.value;
    dropdown.dispatchEvent(new window.Event('change', { bubbles: true }));
    await settle();
  };
  const section = (name) => [...d.querySelectorAll('.list')].find((l) => l.querySelector('.list__name').textContent === name);
  return {
    window, document: d, local,
    section,
    names: (list) => [...section(list).querySelectorAll('.item__name')].map((a) => a.textContent),
    // One list is on show at a time; this switches to the named one.
    show,
    choose: async (list, key) => {
      await show(list);
      const select = section(list).querySelector('.list__sort-select');
      select.value = key;
      select.dispatchEvent(new window.Event('change', { bubbles: true }));
      await settle();
    },
    reverse: async (list) => { await show(list); section(list).querySelector('.list__sort-direction').click(); await settle(); },
    loaded: (count) => until(() => count === undefined || !d.querySelector('#status').textContent),
  };
}

const idle = (bg, page, n, field = 'requested') => until(() => bg[field].length === n && !page.document.querySelector('#status').textContent);

forEachBrowser(() => {

test('every list sorts by date added, newest first, until it is told otherwise', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  assert.deepEqual(page.names('Watching'), ['Mystery Card', 'Genesect ex', 'Pikachu ex']);
  await page.show('Buy');
  assert.deepEqual(page.names('Buy'), ['Genesect ex', 'Pikachu ex']);
  for (const name of ['Watching', 'Buy']) {
    await page.show(name);
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
  assert.equal(page.document.querySelectorAll('.list__sort-select').length, 1, 'the list on show');
});

test('a list with a single card has nothing to order, so it has no sort control', async () => {
  const page = await openLists(await startBackground());
  await page.show('One');
  assert.equal(page.section('One').querySelector('.list__sort'), null);
});

test('sorting one list leaves the others alone', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  await idle(bg, page, 3, 'asked');
  assert.deepEqual(page.names('Watching'), ['Pikachu ex', 'Genesect ex', 'Mystery Card']);
  assert.equal(page.section('Watching').querySelector('.list__sort-select').value, 'ask');
  await page.show('Buy');
  assert.deepEqual(page.names('Buy'), ['Genesect ex', 'Pikachu ex'], 'Buy is still newest first');
  assert.equal(page.section('Buy').querySelector('.list__sort-select').value, 'added');
});

test('two lists can be sorted two different ways at once', async () => {
  const bg = await startBackground();
  const page = await openLists(bg);
  await page.choose('Watching', 'ask');
  await idle(bg, page, 3, 'asked');
  await page.choose('Buy', 'volatility');
  await idle(bg, page, 2);
  await page.reverse('Buy');
  assert.deepEqual(page.names('Buy'), ['Genesect ex', 'Pikachu ex'], 'steadiest first');
  assert.equal(page.section('Buy').querySelector('.list__sort-direction').textContent, 'Steadiest first');
  await page.show('Watching');
  assert.deepEqual(page.names('Watching'), ['Pikachu ex', 'Genesect ex', 'Mystery Card']);
  assert.equal(page.section('Watching').querySelector('.list__sort-direction').textContent, 'Highest first');
});

test('the direction button reverses just its own list and says what it now means', async () => {
  const page = await openLists(await startBackground());
  await page.reverse('Watching');
  assert.deepEqual(page.names('Watching'), ['Pikachu ex', 'Genesect ex', 'Mystery Card']);
  assert.equal(page.section('Watching').querySelector('.list__sort-direction').textContent, 'Oldest first');
  await page.show('Buy');
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
  await again.show('Buy');
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


// ---- choosing a list and paging through it --------------------------------------

const card = (i) => item(String(2000 + i), `Card ${i}`, new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString(), 10 + i);
const bigLists = (n = 60) => ({
  version: 1,
  lists: [
    { id: 'big', name: 'Big', createdAt: '', updatedAt: '', items: Array.from({ length: n }, (_, i) => card(i + 1)) },
    { id: 'small', name: 'Small', createdAt: '', updatedAt: '', items: [card(901), card(902)] },
  ],
});
const openBig = (n, options) => startBackground().then((bg) => openLists(bg, storageArea({ lists: bigLists(n) }), options));
const shown = (page) => [...page.document.querySelectorAll('.item__name')].map((a) => a.textContent);
const range = (page) => page.document.querySelector('.pager__range') && page.document.querySelector('.pager__range').textContent;
const click = async (page, selector) => { page.document.querySelector(selector).click(); await settle(); };
const pick = async (page, selector, value) => {
  const select = page.document.querySelector(selector);
  select.value = value;
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await settle();
};

test('a long list opens on its first 25 cards, newest first, with a pager', async () => {
  const page = await openBig(60);
  assert.equal(shown(page).length, 25);
  assert.equal(shown(page)[0], 'Card 60');
  assert.equal(range(page), 'Showing 1\u201325 of 60');
  assert.equal(page.document.querySelector('.list__count').textContent, '60 items');
});

test('Next and Previous move through the pages in the list\'s order', async () => {
  const page = await openBig(60);
  await click(page, '.pager__next');
  assert.equal(range(page), 'Showing 26\u201350 of 60');
  assert.equal(shown(page)[0], 'Card 35');
  await click(page, '.pager__next');
  assert.equal(shown(page).length, 10);
  assert.equal(page.document.querySelector('.pager__next').disabled, true);
  await click(page, '.pager__prev');
  assert.equal(range(page), 'Showing 26\u201350 of 60');
});

test('a bigger page size shows more, "All" shows everything, and either goes back to page 1', async () => {
  const page = await openBig(160);
  await click(page, '.pager__next');
  await pick(page, '.lists-toolbar__size', '50');
  assert.equal(shown(page).length, 50);
  assert.equal(range(page), 'Showing 1\u201350 of 160');
  await pick(page, '.lists-toolbar__size', 'all');
  assert.equal(shown(page).length, 160);
  assert.equal(range(page), null, 'no pager when everything is on show');
});

test('switching lists shows that list from its first page, and back again starts at page 1', async () => {
  const page = await openBig(60);
  await click(page, '.pager__next');
  await page.show('Small');
  assert.deepEqual(shown(page), ['Card 902', 'Card 901']);
  assert.equal(page.document.querySelector('.list__name').textContent, 'Small');
  await page.show('Big');
  assert.equal(range(page), 'Showing 1\u201325 of 60');
});

test('changing the sort goes back to page 1 of the new order', async () => {
  const page = await openBig(60);
  await click(page, '.pager__next');
  await page.reverse('Big');
  assert.equal(range(page), 'Showing 1\u201325 of 60');
  assert.equal(shown(page)[0], 'Card 1', 'oldest first now');
});

test('the chosen list and page size are remembered for next time', async () => {
  const first = await openBig(60);
  await first.show('Small');
  await pick(first, '.lists-toolbar__size', '75');
  const remembered = Object.fromEntries(['ptcg.listsSelected', 'ptcg.listsPageSize'].map((k) => [k, first.window.localStorage.getItem(k)]));
  assert.deepEqual(remembered, { 'ptcg.listsSelected': 'small', 'ptcg.listsPageSize': '75' });

  const again = await openBig(60, { remembered });
  assert.equal(again.document.querySelector('.list__name').textContent, 'Small');
  assert.equal(again.document.querySelector('.lists-toolbar__size').value, '75');
});

test('a remembered list that no longer exists, or a bad size, falls back to the first list and 25', async () => {
  const page = await openBig(60, { remembered: { 'ptcg.listsSelected': 'deleted-long-ago', 'ptcg.listsPageSize': 'lots' } });
  assert.equal(page.document.querySelector('.list__name').textContent, 'Big');
  assert.equal(page.document.querySelector('.lists-toolbar__size').value, '25');
});

test('deleting the list on show shows the first remaining list', async () => {
  const page = await openBig(60, { remembered: { 'ptcg.listsSelected': 'small' } });
  await click(page, '.list__delete');
  assert.equal(page.document.querySelector('.list__name').textContent, 'Big');
  assert.equal(page.local.data.lists.lists.length, 1);
});

test('a new list is shown as soon as it is made', async () => {
  const page = await openBig(60);
  await click(page, '.page-actions button');
  assert.equal(page.document.querySelector('.list__name').textContent, 'Brand new');
  assert.equal(page.document.querySelector('.lists-toolbar__list').selectedOptions[0].textContent, 'Brand new (0)');
});

test('removing the last card on the last page steps back to the page before', async () => {
  const page = await openBig(26);
  await click(page, '.pager__next');
  assert.deepEqual(shown(page), ['Card 1']);
  await click(page, '.item__remove');
  assert.equal(shown(page).length, 25);
  assert.equal(range(page), null, 'one page left, so no pager');
});

test('only the cards on the page are drawn, so only they can ask for prices', async () => {
  const page = await openBig(160);
  assert.equal(page.document.querySelectorAll('.item').length, 25);
  assert.equal(page.document.querySelectorAll('[data-ask-key]').length, 25);
});

test('with browser storage blocked, the lists still work (it just does not remember)', async () => {
  const page = await openBig(60, { brokenStorage: true });
  assert.equal(shown(page).length, 25);
  await page.show('Small');
  assert.equal(page.document.querySelector('.list__name').textContent, 'Small');
  await pick(page, '.lists-toolbar__size', '50');
  assert.equal(page.document.querySelector('.lists-toolbar__size').value, '50');
});

});
