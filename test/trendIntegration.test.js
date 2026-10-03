/*
 * Runs the *built* background page and the *built* lists page together, with
 * messaging wired between them and TCGplayer's history feed stubbed by real
 * captured responses. The closest thing to loading the add-on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dist, apiName, messageBus, forEachBrowser } from './helpers/extensionApi.js';
import { JSDOM, VirtualConsole } from 'jsdom';
import { PIKACHU_HISTORY, GENESECT_HISTORY } from './fixtures/tcgplayerHistory.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const item = (productId, name) => ({
  key: `${productId}:english`, productId, language: 'English', name, setName: '', number: '',
  rarity: '', imageUrl: '', url: `https://www.tcgplayer.com/product/${productId}/x`, note: '',
  savedAt: '2026-09-30T12:00:00.000Z',
  priceAtSave: { market: 50, lowest: 45, condition: 'Near Mint Holofoil', asLowAs: 45 },
});

const LISTS = {
  version: 1,
  lists: [{
    id: 'a', name: 'Watchlist', createdAt: '', updatedAt: '',
    items: [item('712953', 'Pikachu ex'), item('642621', 'Genesect ex')],
  }],
};

const FEEDS = {
  '712953': PIKACHU_HISTORY,
  '642621': GENESECT_HISTORY,
};

/** A Firefox storage area with just enough surface for these pages. */
function storageArea(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) {
      if (keys === null) return { ...data };
      const list = [].concat(keys);
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) { Object.assign(data, items); },
    async remove(keys) { [].concat(keys).forEach((k) => delete data[k]); },
  };
}

async function startBackground({ failFeeds = false, failFirst = 0, random = 0 } = {}) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const requested = [];
  const bus = messageBus();
  window.Math.random = () => random; // 0: retries wait no time at all
  window.fetch = async (url) => {
    // The lists page also asks for each card's ask; these tests are about the history feed.
    if (/\/listings$/.test(url)) return { ok: true, status: 200, json: async () => ({ results: [{ totalResults: 0, results: [] }] }) };
    requested.push(url);
    if (failFeeds || requested.length <= failFirst) return { ok: false, status: 503, json: async () => ({}) };
    const id = url.match(/history\/(\d+)\//)[1];
    return { ok: true, status: 200, json: async () => FEEDS[id] };
  };
  const local = storageArea();
  window[apiName()] = {
    storage: { local },
    runtime: bus.runtime,
    action: bus.action,
    tabs: { create: async () => ({}), sendMessage: bus.tabs.sendMessage },
  };
  window.eval(await readFile(dist('background.js'), 'utf8'));
  return { requested, local, send: bus.send, pageRuntime: bus.pageRuntime };
}

async function startListsPage(background) {
  const html = await readFile('src/home/home.html', 'utf8');
  const dom = new JSDOM(html, {
    url: 'moz-extension://test/home/home.html#lists', runScripts: 'outside-only', virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const observed = [];
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(target) { observed.push(target); }
    unobserve() {}
    disconnect() {}
    show(target) { this.cb([{ isIntersecting: true, target }]); }
  };
  const instances = [];
  const Original = window.IntersectionObserver;
  window.IntersectionObserver = class extends Original {
    constructor(cb) { super(cb); instances.push(this); }
  };
  window[apiName()] = {
    storage: {
      local: storageArea({ lists: LISTS }),
      onChanged: { addListener: () => {}, removeListener: () => {} },
    },
    runtime: background.pageRuntime(),
  };
  window.eval(await readFile(dist('home/home.js'), 'utf8'));
  await settle();
  return {
    document: window.document,
    observed,
    reveal: async (index) => { instances[0].show(observed[index]); await settle(400); },
  };
}

const trendOf = (d, name) => [...d.querySelectorAll('.item')]
  .find((row) => row.textContent.includes(name)).querySelector('.trend');

forEachBrowser(() => {

test('every item starts on "Checking trend" and nothing is fetched until it is on screen', async () => {
  const bg = await startBackground();
  const page = await startListsPage(bg);
  assert.equal(page.document.querySelectorAll('.trend--loading').length, 2);
  assert.equal(bg.requested.length, 0, 'no request for items that have not scrolled into view');
  assert.equal(page.observed.length, 2);
});

test('scrolling an item into view fetches TCGplayer and shows its trend and chart', async () => {
  const bg = await startBackground();
  const page = await startListsPage(bg);

  await page.reveal(0); // Pikachu
  assert.deepEqual(bg.requested, ['https://infinite-api.tcgplayer.com/price/history/712953/detailed?range=month']);

  const trend = trendOf(page.document, 'Pikachu ex');
  assert.match(trend.className, /trend--down/);
  assert.match(trend.querySelector('.trend__summary').textContent, /^▼ −16%$/);
  assert.match(trend.querySelector('.trend__label').textContent, /vs previous 7 days/);
  assert.ok(trend.querySelector('svg.sparkline path'), 'the sparkline is drawn');

  // The other item is still waiting: it has not been scrolled to.
  assert.match(trendOf(page.document, 'Genesect ex').className, /trend--loading/);
  assert.equal(bg.requested.length, 1);
});

test('a quiet card widens its window and reads flat', async () => {
  const bg = await startBackground();
  const page = await startListsPage(bg);
  await page.reveal(1); // Genesect
  const trend = trendOf(page.document, 'Genesect ex');
  assert.match(trend.className, /trend--flat/);
  assert.match(trend.querySelector('.trend__summary').textContent, /^▬ Flat \(−0\.5%\)$/);
  assert.match(trend.querySelector('.trend__label').textContent, /vs previous 14 days/);
});

test('the answer is cached, so the same card costs one request', async () => {
  const bg = await startBackground();
  const a = await bg.send({ type: 'price-trend', item: { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' } });
  const b = await bg.send({ type: 'price-trend', item: { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' } });
  assert.equal(bg.requested.length, 1);
  assert.equal(a.direction, b.direction);
  assert.ok(Object.keys(bg.local.data).some((k) => k.startsWith('tr:')), 'stored under the tr: prefix the popup clears');
});

test('concurrent requests for one card share a single fetch', async () => {
  const bg = await startBackground();
  const ask = () => bg.send({ type: 'price-trend', item: { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' } });
  await Promise.all([ask(), ask(), ask()]);
  assert.equal(bg.requested.length, 1);
});

test('when TCGplayer is down the row says so, and the page keeps working', async () => {
  const bg = await startBackground({ failFeeds: true });
  const page = await startListsPage(bg);
  await page.reveal(0);
  const start = Date.now();
  while (/trend--(loading|retrying)/.test(trendOf(page.document, 'Pikachu ex').className) && Date.now() - start < 8000) await settle(50);
  const trend = trendOf(page.document, 'Pikachu ex');
  assert.match(trend.className, /trend--unknown/);
  assert.match(trend.textContent, /Trend unavailable/);
  assert.equal(page.document.querySelectorAll('.item').length, 2, 'the list itself is untouched');
  assert.equal(Object.keys(bg.local.data).filter((k) => k.startsWith('tr:')).length, 0, 'an outage is not cached');
  assert.equal(bg.requested.length, 5, 'it was tried, then retried four times, before giving up');
});

test('a request with no product id is answered, not thrown', async () => {
  const bg = await startBackground();
  const r = await bg.send({ type: 'price-trend', item: {} });
  assert.equal(r.direction, 'unknown');
  assert.equal(bg.requested.length, 0);
});


// ---- retrying ------------------------------------------------------------------

const waitFor = async (check, limit = 8000) => {
  const start = Date.now();
  while (!check() && Date.now() - start < limit) await settle(20);
  return check();
};

test('while TCGplayer is not answering, the card says it is retrying, then shows the trend when it does', async () => {
  const bg = await startBackground({ failFirst: 1, random: 0.999 }); // the first retry waits about half a second
  const page = await startListsPage(bg);
  await page.reveal(0);
  const row = () => [...page.document.querySelectorAll('.item')].find((r) => r.textContent.includes('Pikachu ex'));

  assert.ok(await waitFor(() => row().querySelector('.trend[data-retrying="1"]')), 'the card says it is retrying');
  assert.equal(row().querySelector('.trend__summary').textContent, 'Retrying (1 of 4)\u2026');
  assert.match(row().querySelector('.trend').className, /trend--loading/);

  assert.ok(await waitFor(() => !row().querySelector('.trend[data-retrying="1"]') && !/trend--loading/.test(row().querySelector('.trend').className)));
  assert.match(row().querySelector('.trend').className, /trend--(up|down|flat)/, 'the real trend replaced it');
  assert.equal(bg.requested.length >= 2, true, 'it did ask again');
});

test('two requests for the same trend share one lookup, and both are answered after the retry', async () => {
  const bg = await startBackground({ failFirst: 1, random: 0.999 });
  const asking = Promise.all([
    bg.send({ type: 'price-trend', ref: 'a', item: { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' } }),
    bg.send({ type: 'price-trend', ref: 'b', item: { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' } }),
  ]);
  const [a, b] = await asking;
  assert.equal(a.direction, b.direction);
  assert.equal(bg.requested.length, 2, 'one lookup, retried once, shared');
});

test('a trend that fails every time ends as unavailable, after being shown as retrying', async () => {
  const bg = await startBackground({ failFeeds: true });
  const page = await startListsPage(bg);
  await page.reveal(0);
  const row = () => [...page.document.querySelectorAll('.item')].find((r) => r.textContent.includes('Pikachu ex'));
  assert.ok(await waitFor(() => /Trend unavailable/.test(row().querySelector('.trend').textContent)));
  assert.equal(row().querySelector('.trend[data-retrying]'), null, 'no longer claims to be retrying');
});

});
