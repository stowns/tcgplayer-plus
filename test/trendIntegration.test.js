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

async function startListsPage(background, { settings, hash = '#lists' } = {}) {
  const html = await readFile('src/home/home.html', 'utf8');
  const dom = new JSDOM(html, {
    url: `moz-extension://test/home/home.html${hash}`, runScripts: 'outside-only', virtualConsole: new VirtualConsole(),
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
  // Storage that tells its listeners what changed, as the browser's does.
  const local = storageArea({ lists: LISTS, ...(settings ? { settings } : {}) });
  const listeners = new Set();
  const quietSet = local.set.bind(local);
  local.set = async (items) => {
    await quietSet(items);
    const changes = Object.fromEntries(Object.entries(items).map(([k, newValue]) => [k, { newValue }]));
    for (const fn of [...listeners]) fn(changes, 'local');
  };
  window[apiName()] = {
    storage: {
      local,
      onChanged: { addListener: (fn) => listeners.add(fn), removeListener: (fn) => listeners.delete(fn) },
    },
    runtime: background.pageRuntime(),
  };
  window.eval(await readFile(dist('home/home.js'), 'utf8'));
  await settle();
  return {
    window,
    document: window.document,
    local,
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
  assert.equal(trend.querySelector('.trend__label').textContent, '7 days');
  assert.equal(trend.querySelectorAll('.trend__line').length, 1, 'one line, for 7 days, until more are chosen');
  assert.equal(trend.querySelector('svg.sparkline'), null, 'no chart until the line is clicked');

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
  assert.match(trend.querySelector('.trend__summary').textContent, /^▬ −0\.5%$/);
  assert.equal(trend.querySelector('.trend__label').textContent, '14 days');
});

test('clicking a trend opens its chart with the two periods shaded, and clicking again closes it', async () => {
  const bg = await startBackground();
  const page = await startListsPage(bg);
  await page.reveal(0);
  const trend = () => trendOf(page.document, 'Pikachu ex');
  trend().querySelector('button.trend__line').click();
  await settle();
  const line = trend().querySelector('button.trend__line');
  assert.equal(line.getAttribute('aria-expanded'), 'true');
  assert.ok(trend().querySelector('.trend__chart--down svg.sparkline path'), 'the chart, in the line\'s colour');
  assert.deepEqual([...trend().querySelectorAll('.sparkline__band')].map((b) => b.getAttribute('class').split('--')[1]), ['prior', 'recent']);
  assert.match(trend().querySelector('svg.sparkline').getAttribute('aria-label'), /Shaded: the last 7 days, and the 7 before/);
  assert.equal(bg.requested.length, 1, 'opening a chart asks TCGplayer nothing');

  line.click();
  await settle();
  assert.equal(trend().querySelector('svg.sparkline'), null);
  assert.equal(trend().querySelector('button.trend__line').getAttribute('aria-expanded'), 'false');
});

test('the durations chosen in Settings each get a line, longest first, without asking TCGplayer again', async () => {
  const bg = await startBackground();
  const page = await startListsPage(bg, { settings: { trendDurations: [1, 7] } });
  await page.reveal(0);
  const trend = () => trendOf(page.document, 'Pikachu ex');
  assert.deepEqual([...trend().querySelectorAll('.trend__line')].map((l) => l.getAttribute('data-days')), ['7', '1']);
  assert.match(trend().querySelectorAll('.trend__line')[1].textContent, /1 day/);
  trend().querySelector('button.trend__line').click();
  await settle();
  assert.ok(trend().querySelector('svg.sparkline'));

  // Changed while the list is open (as the Settings tab in another dashboard would).
  await page.local.set({ settings: { trendDurations: [14, 3] } });
  await settle(80);
  assert.deepEqual([...trend().querySelectorAll('.trend__line')].map((l) => l.getAttribute('data-days')), ['14', '3']);
  assert.equal(trend().querySelector('svg.sparkline'), null, 'the open chart was for a line that is gone');
  assert.equal(bg.requested.length, 1, 'every duration comes from the one history already fetched');
});

test('a trend cached under the old rules is worked out again, with its durations', async () => {
  const bg = await startBackground();
  const key = 'tr:712953|english|near mint|holofoil';
  bg.local.data[key] = { storedAt: Date.now(), value: { direction: 'up', pct: 0.5, windowDays: 7, rules: 2, series: [] } };
  const fresh = await bg.send({ type: 'price-trend', item: { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' } });
  assert.equal(bg.requested.length, 1, 'fetched, not served from the old entry');
  assert.equal(fresh.direction, 'down');
  assert.deepEqual(Object.keys(fresh.windows).map(Number), [1, 3, 7, 14]);
});

test('the Settings tab chooses the durations, and keeps at least one', async () => {
  const bg = await startBackground();
  const page = await startListsPage(bg, { hash: '#settings' });
  const box = (days) => page.document.querySelector(`.settings-trends__box[value="${days}"]`);
  const tick = async (days, on) => { box(days).checked = on; box(days).dispatchEvent(new page.window.Event('change', { bubbles: true })); await settle(60); };
  assert.equal(page.document.querySelector('.settings-trends h3').textContent, 'Price trends');
  assert.deepEqual([1, 3, 7, 14].map((d) => box(d).checked), [false, false, true, false], '7 days to begin with');

  await tick(1, true);
  assert.equal(String(page.local.data.settings.trendDurations), '7,1');
  await tick(7, false);
  assert.equal(String(page.local.data.settings.trendDurations), '1');
  await tick(1, false);
  assert.equal(String(page.local.data.settings.trendDurations), '1', 'the last one cannot be switched off');
  assert.equal(box(1).checked, true, 'and the box says so');
  assert.equal(page.document.querySelector('.settings-trends__status').textContent, 'At least one trend is always shown.');
  await tick(3, true);
  assert.equal(page.document.querySelector('.settings-trends__status').textContent, '');
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
