/*
 * Runs the *built* background page, home page and order-page content script
 * together, with messaging wired between them and TCGplayer stubbed at the
 * network. The closest thing to loading the add-on.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dist, apiName, messageBus, forEachBrowser } from './helpers/extensionApi.js';
import { JSDOM, VirtualConsole } from 'jsdom';
import { ORDERS, orderPage, SIGNED_OUT_PAGE } from './fixtures/orderHistoryFull.js';
import { LAPRAS_LISTINGS, NO_LISTINGS } from './fixtures/tcgplayerListings.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (check, limit = 8000) => {
  const start = Date.now();
  while (!check() && Date.now() - start < limit) await settle(25);
  await settle(30);
};

/** "Now" for every page in the test, so "Last 30 Days" means the same thing next month. */
const FIXED_NOW = Date.parse('2026-09-30T12:00:00Z');
function freezeClock(window) {
  const Real = window.Date;
  window.Date = class extends Real {
    constructor(...args) { super(...(args.length ? args : [FIXED_NOW])); }
    static now() { return FIXED_NOW; }
  };
}

function storageArea(initial = {}) {
  const data = { ...initial };
  const listeners = [];
  return {
    data,
    listeners,
    async get(keys) {
      if (keys === null) return { ...data };
      return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]]));
    },
    async set(items) {
      const changes = Object.fromEntries(Object.keys(items).map((k) => [k, { newValue: items[k] }]));
      Object.assign(data, items);
      listeners.forEach((fn) => fn(changes, 'local'));
    },
    async remove(keys) {
      const list = [].concat(keys);
      const changes = Object.fromEntries(list.map((k) => [k, { oldValue: data[k] }]));
      list.forEach((k) => delete data[k]);
      listeners.forEach((fn) => fn(changes, 'local'));
    },
  };
}

/** A tiny TCGplayer. `orders` are the pages of markup it serves; the range is session state. */
function fakeTcgplayer({ pages = [ORDERS.slice(0, 3), ORDERS.slice(3)], loggedIn = true, range = 'Last 30 Days' } = {}) {
  const site = { range, requests: [], posts: [], pages, loggedIn };
  site.fetch = async (url, init = {}) => {
    site.requests.push({ url, method: init.method || 'GET' });
    const reply = (text, extra = {}) => ({ ok: true, status: 200, url, text: async () => text, json: async () => JSON.parse(text), ...extra });
    if (/mp-search-api\.tcgplayer\.com\/v1\/product\/(\d+)\/listings/.test(url)) {
      const id = /product\/(\d+)\//.exec(url)[1];
      return reply(JSON.stringify(id === '696683' ? LAPRAS_LISTINGS : NO_LISTINGS));
    }
    if (/store\.tcgplayer\.com\/MyAccount\/OrderHistory/.test(url) && init.method === 'POST') {
      site.posts.push(new URLSearchParams(init.body));
      site.range = new URLSearchParams(init.body).get('DateRange');
      return reply('{}');
    }
    if (/store\.tcgplayer\.com\/myaccount\/orderhistory/i.test(url)) {
      if (!site.loggedIn) return reply(SIGNED_OUT_PAGE, { url: 'https://www.tcgplayer.com/login?returnUrl=/myaccount/orderhistory' });
      const n = Number((/PageNumber=(\d+)/.exec(url) || [])[1] || 1);
      return reply(orderPage({ orders: site.pages[n - 1] || [], page: n, pages: site.pages.length, range: site.range }));
    }
    return { ok: false, status: 404, url, text: async () => '', json: async () => ({}) };
  };
  return site;
}

async function startBackground(site, local = storageArea()) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  freezeClock(window);
  const bus = messageBus();
  window.fetch = site.fetch;
  window[apiName()] = {
    storage: { local },
    runtime: bus.runtime,
    tabs: { create: async () => ({}) },
  };
  window.eval(await readFile(dist('background.js'), 'utf8'));
  return { local, site, send: bus.send };
}

async function openHome(background, hash = '#orders') {
  const html = await readFile('src/home/home.html', 'utf8');
  const dom = new JSDOM(html, {
    url: `http://localhost/home/home.html${hash}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  freezeClock(window);
  window.fetch = background.site.fetch; // the page reads the order pages itself
  window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
  const sent = [];
  window[apiName()] = {
    storage: { local: background.local, onChanged: {
      addListener: (fn) => background.local.listeners.push(fn),
      removeListener: (fn) => { const i = background.local.listeners.indexOf(fn); if (i >= 0) background.local.listeners.splice(i, 1); },
    } },
    runtime: { sendMessage: (m) => { sent.push(m); return background.send(m); } },
  };
  window.eval(await readFile(dist('home/home.js'), 'utf8'));
  await settle();
  return {
    window, document: window.document, sent,
  };
}

const hasButton = (d, label) => [...d.querySelectorAll('#view button')].some((b) => b.textContent === label);
const selectedTab = (d) => d.querySelector('.tab[aria-selected="true"]').getAttribute('data-view');
const orderNumbers = (d) => [...d.querySelectorAll('.order')].map((a) => a.getAttribute('data-order'));

forEachBrowser(() => {

test('the home page opens on Saved Lists, with both tabs', async () => {
  const bg = await startBackground(fakeTcgplayer());
  const { document } = await openHome(bg, '');
  assert.equal(selectedTab(document), 'lists');
  assert.deepEqual([...document.querySelectorAll('.tab')].map((t) => t.textContent), ['Saved Lists', 'Order History']);
  assert.match(document.title, /Saved Lists/);
  assert.match(document.querySelector('#view').textContent, /Saved Lists/);
  assert.equal(document.querySelector('h1').textContent, 'TCGPlayer+');
});

test('choosing a tab switches the view, the fragment and the title', async () => {
  const bg = await startBackground(fakeTcgplayer());
  const { window, document } = await openHome(bg, '#lists');
  document.querySelector('#tab-orders').click();
  await settle();
  assert.equal(window.location.hash, '#orders');
  assert.equal(selectedTab(document), 'orders');
  assert.match(document.title, /Order History/);
  assert.equal(document.querySelector('#view').getAttribute('aria-labelledby'), 'tab-orders');
  assert.equal(hasButton(document, 'New list'), false, 'the lists view is gone');
  document.querySelector('#tab-lists').click();
  await settle();
  assert.equal(selectedTab(document), 'lists');
  assert.ok(hasButton(document, 'New list'));
});

test('only the selected tab is in the tab order, and arrow keys move between tabs', async () => {
  const bg = await startBackground(fakeTcgplayer());
  const { window, document } = await openHome(bg, '#lists');
  assert.deepEqual([...document.querySelectorAll('.tab')].map((t) => t.tabIndex), [0, -1]);
  document.querySelector('#tab-lists').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
  await settle();
  assert.equal(selectedTab(document), 'orders');
  document.querySelector('#tab-orders').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
  await settle();
  assert.equal(selectedTab(document), 'lists');
});

test('a link straight to #orders opens that tab, and back/forward work', async () => {
  const bg = await startBackground(fakeTcgplayer());
  const { window, document } = await openHome(bg, '#orders');
  assert.equal(selectedTab(document), 'orders');
  window.location.hash = '#lists';
  await settle();
  assert.equal(selectedTab(document), 'lists');
});

test('opening Order History reads TCGplayer, keeps the orders and shows them with a total', async () => {
  const site = fakeTcgplayer();
  const bg = await startBackground(site);
  const { document, sent } = await openHome(bg, '#orders');
  await until(() => document.querySelectorAll('.order').length === 6);
  assert.equal(site.posts.length, 0, 'the range already selected is not changed');
  assert.equal(sent.filter((m) => /order/.test(m.type)).length, 0, 'the background is not involved in reading orders');
  assert.equal(orderNumbers(document).length, 6);
  assert.equal(orderNumbers(document)[0], 'TEST0001-AAAAAA-BBBBB', 'newest first');
  assert.equal(Object.keys(bg.local.data.orders.orders).length, 6);
  assert.match(document.querySelector('.orders-status').textContent, /Up to date: read 6 orders from TCGplayer, 6 new/);
  assert.match(document.querySelector('.orders-bar__age').textContent, /Last synced just now/);
  assert.ok(document.querySelector('.ptcg-total'), 'a total is shown');
});

test('nothing personal is stored or shown', async () => {
  const bg = await startBackground(fakeTcgplayer());
  const { document } = await openHome(bg, '#orders');
  await until(() => document.querySelectorAll('.order').length === 6);
  const stored = JSON.stringify(bg.local.data);
  const shown = document.querySelector('#view').textContent;
  for (const forbidden of ['Test Person', 'Example Street', 'Springfield', 'SHIP TO', 'BILL TO']) {
    assert.equal(stored.includes(forbidden), false, `stored: ${forbidden}`);
    assert.equal(shown.includes(forbidden), false, `shown: ${forbidden}`);
  }
  assert.equal(document.querySelectorAll('#view input[type="button"]').length, 0);
  assert.equal([...document.querySelectorAll('#view button')].some((b) => /contact|rate/i.test(b.textContent)), false);
});

test('current prices are fetched for every order shown, and fill in the totals without scrolling', async () => {
  const bg = await startBackground(fakeTcgplayer());
  const page = await openHome(bg, '#orders');
  await until(() => page.document.querySelectorAll('.order').length === 6);
  await until(() => !page.document.querySelector('.ptcg-now--loading'), 12000);
  const lookups = page.sent.filter((m) => m.type === 'listing-price');
  assert.equal(new Set(lookups.map((m) => m.item.productId)).size, lookups.length, 'one request per distinct item');
  assert.ok(lookups.length >= 10, 'items from every order, not just the first screen');
  const lapras = page.document.querySelector('.order[data-order="TEST0001-AAAAAA-BBBBB"] .ptcg-now');
  assert.equal(lapras.querySelector('.ptcg-now__price').textContent, 'Ask $10.81');
  assert.match(page.document.querySelector('.order[data-order="TEST0001-AAAAAA-BBBBB"] .order__change').className, /--lower/);
  assert.match(page.document.querySelector('.ptcg-total').className, /ptcg-total--lower/);
  assert.match(page.document.querySelector('.ptcg-total__detail').textContent, /1 item counted/);
  assert.doesNotMatch(page.document.querySelector('.ptcg-total__detail').textContent, /still loading/);
});

test('orders already in the archive are shown at once, and are not re-read if recent', async () => {
  const site = fakeTcgplayer();
  const bg = await startBackground(site);
  const first = await openHome(bg, '#orders');
  await until(() => first.document.querySelectorAll('.order').length === 6);
  const orderReads = () => site.requests.filter((r) => /orderhistory/i.test(r.url)).length;
  const before = orderReads();
  const second = await openHome(bg, '#orders');
  assert.equal(second.document.querySelectorAll('.order').length, 6, 'drawn from the archive immediately');
  await settle(300);
  assert.equal(orderReads(), before, 'a read from minutes ago is not repeated');
});

test('Refresh reads again, and an order that has aged out of TCGplayer\'s window is kept', async () => {
  const site = fakeTcgplayer();
  const bg = await startBackground(site);
  const page = await openHome(bg, '#orders');
  await until(() => page.document.querySelectorAll('.order').length === 6);
  site.pages = [ORDERS.slice(2, 4)]; // TCGplayer now lists only two of them
  page.document.querySelector('.orders-bar button').click();
  await until(() => /Up to date: read 2 orders/.test(page.document.querySelector('.orders-status').textContent));
  assert.equal(Object.keys(bg.local.data.orders.orders).length, 6, 'nothing was lost');
  assert.equal(page.document.querySelectorAll('.order').length, 6, 'and all of it is still shown');
});

test('Refresh also re-checks today\'s prices past the cache; opening the tab does not', async () => {
  const site = fakeTcgplayer();
  const bg = await startBackground(site);
  const page = await openHome(bg, '#orders');
  await until(() => page.document.querySelectorAll('.order').length === 6);
  await until(() => !page.document.querySelector('.ptcg-now--loading'), 12000);
  const asked = () => site.requests.filter((r) => /\/listings/.test(r.url)).length;
  const first = asked();
  assert.ok(first > 0);
  assert.ok(page.sent.filter((m) => m.type === 'listing-price').every((m) => !m.item.fresh), 'opening asks normally');

  page.document.querySelector('.orders-bar button').click();
  await until(() => page.sent.some((m) => m.type === 'listing-price' && m.item.fresh));
  await until(() => !page.document.querySelector('.ptcg-now--loading'), 12000);
  assert.ok(asked() > first, 'the cached prices were fetched again');
  assert.match(page.document.querySelector('.ptcg-now__detail').textContent, /shipping/);
});

test('choosing another range asks TCGplayer for it; All saved reads nothing', async () => {
  const site = fakeTcgplayer();
  const bg = await startBackground(site);
  const page = await openHome(bg, '#orders');
  await until(() => page.document.querySelectorAll('.order').length === 6);
  const select = page.document.querySelector('#ordersRange');
  select.value = '2025';
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await until(() => site.posts.length === 1);
  assert.equal(site.posts[0].get('DateRange'), '2025');
  await until(() => !page.document.querySelector('#ordersRange').disabled);

  const orderReads = () => site.requests.filter((r) => /orderhistory/i.test(r.url)).length;
  const requests = orderReads();
  select.value = 'All saved';
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await settle(300);
  assert.equal(orderReads(), requests, 'All saved reads no orders from TCGplayer');
  assert.equal(page.document.querySelector('.orders-bar button').disabled, true, 'nothing to refresh');
  assert.equal(page.document.querySelectorAll('.order').length, 6);
});

test('the range chosen is applied to what is shown (a year window hides other years)', async () => {
  const site = fakeTcgplayer();
  const bg = await startBackground(site);
  const page = await openHome(bg, '#orders');
  await until(() => page.document.querySelectorAll('.order').length === 6);
  const select = page.document.querySelector('#ordersRange');
  select.value = '2025';
  select.dispatchEvent(new page.window.Event('change', { bubbles: true }));
  await until(() => site.posts.length === 1);
  await until(() => !page.document.querySelector('#ordersRange').disabled);
  assert.equal(page.document.querySelectorAll('.order').length, 0);
  assert.match(page.document.querySelector('.notice').textContent, /No saved orders for 2025/);
});

test('signed out: says so, offers the TCGplayer page, and keeps working from the archive', async () => {
  const site = fakeTcgplayer({ loggedIn: false });
  const bg = await startBackground(site);
  const page = await openHome(bg, '#orders');
  await until(() => /not signed in/.test(page.document.querySelector('.orders-status').textContent));
  assert.match(page.document.querySelector('.notice').textContent, /Sign in to TCGplayer/);
  assert.equal(page.document.querySelector('.orders-status').getAttribute('data-error'), '1');
  assert.equal(page.document.querySelector('.orders-bar button').disabled, false, 'can retry');
});

test('a TCGplayer failure is reported and never leaves the tab stuck', async () => {
  const site = fakeTcgplayer();
  site.fetch = async () => { throw new Error('offline'); };
  const bg = await startBackground(site);
  const page = await openHome(bg, '#orders');
  await until(() => /Could not read your orders/.test(page.document.querySelector('.orders-status').textContent));
  assert.equal(page.document.querySelector('#ordersRange').disabled, false);
  assert.equal(page.document.querySelector('.orders-bar button').disabled, false);
});

test('Clear saved orders empties the archive after confirmation', async () => {
  const site = fakeTcgplayer();
  const bg = await startBackground(site);
  const page = await openHome(bg, '#orders');
  await until(() => page.document.querySelectorAll('.order').length === 6);
  page.window.confirm = () => false;
  page.document.querySelector('.orders-footer button').click();
  await settle(100);
  assert.equal(Object.keys(bg.local.data.orders.orders).length, 6, 'declined: nothing removed');
  site.loggedIn = false; // so the redraw after clearing is not refilled
  page.window.confirm = () => true;
  page.document.querySelector('.orders-footer button').click();
  await until(() => !('orders' in bg.local.data));
  await until(() => page.document.querySelectorAll('.order').length === 0);
  assert.equal('orders' in bg.local.data, false);
});

test('switching away mid-read does not break anything (the view cleans up after itself)', async () => {
  const bg = await startBackground(fakeTcgplayer());
  const page = await openHome(bg, '#orders');
  page.document.querySelector('#tab-lists').click();
  await settle(1500);
  assert.equal(selectedTab(page.document), 'lists');
  assert.equal(page.document.querySelectorAll('.order').length, 0);
  assert.equal(bg.local.listeners.length, 1, 'only the lists view is listening now');
});

// ---- the order page itself feeds the archive ------------------------------------

test('visiting TCGplayer\'s own Order History saves what it shows, and the open view picks it up', async () => {
  const site = fakeTcgplayer({ loggedIn: false });
  const bg = await startBackground(site);
  const home = await openHome(bg, '#orders');
  await until(() => /not signed in/.test(home.document.querySelector('.orders-status').textContent));

  const html = orderPage({ orders: ORDERS.slice(0, 3) });
  const dom = new JSDOM(html, {
    url: 'https://store.tcgplayer.com/myaccount/orderhistory', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  dom.window[apiName()] = { storage: { local: bg.local }, runtime: { sendMessage: (m) => bg.send(m) } };
  dom.window.eval(await readFile(dist('content/tcgplayerOrders.js'), 'utf8'));
  await until(() => Object.keys(bg.local.data.orders?.orders || {}).length === 3);

  assert.equal(Object.keys(bg.local.data.orders.orders).length, 3);
  assert.equal(JSON.stringify(bg.local.data).includes('Example Street'), false);
  await until(() => home.document.querySelectorAll('.order').length === 3);
  assert.equal(home.document.querySelectorAll('.order').length, 3);
});

// ---- the background page only answers the messages it knows ----------------------

test('a message of an unknown type is left unanswered, and an empty one is ignored', async () => {
  const bg = await startBackground(fakeTcgplayer());
  assert.equal(await bg.send({ type: 'no-such-message' }), undefined);
  assert.equal(await bg.send(null), undefined);
});

});
