/*
 * Runs the *built* background page and the *built* order-history content script
 * together on real order tables, with TCGplayer's listings API stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dist, apiName, messageBus, forEachBrowser } from './helpers/extensionApi.js';
import { JSDOM, VirtualConsole } from 'jsdom';
import { ORDER_PAGE, ORDER_URL } from './fixtures/orderHistory.js';
import { LAPRAS_LISTINGS, NO_LISTINGS } from './fixtures/tcgplayerListings.js';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function storageArea() {
  const data = {};
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

// Lapras has listings; Meowth has none; everything else is down.
const feeds = { 696683: LAPRAS_LISTINGS, 714358: NO_LISTINGS };

async function startBackground({ failFirst = 0, random = 0 } = {}) {
  const dom = new JSDOM('<body></body>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const requests = [];
  const bus = messageBus();
  window.Math.random = () => random;
  let failed = 0;
  window.fetch = async (url, init) => {
    requests.push({ url, init });
    if (failed < failFirst) { failed += 1; return { ok: false, status: 503, json: async () => ({}) }; }
    const id = url.match(/product\/(\d+)\/listings/)[1];
    if (!feeds[id]) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => feeds[id] };
  };
  window[apiName()] = {
    storage: { local: storageArea() },
    runtime: bus.runtime,
    action: bus.action,
    tabs: { create: async () => ({}), sendMessage: bus.tabs.sendMessage },
  };
  window.eval(await readFile(dist('background.js'), 'utf8'));
  return { requests, send: bus.send, pageRuntime: bus.pageRuntime };
}

/** Lookups run through a throttle, so wait for the page to finish rather than guess a delay. */
async function untilPricesArrive(document, limitMs = 6000) {
  const start = Date.now();
  await settle(50);
  while (document.querySelector('.ptcg-now--loading') && Date.now() - start < limitMs) await settle(25);
  await settle(50);
}

async function openOrders(background, html = ORDER_PAGE, url = ORDER_URL) {
  const dom = new JSDOM(html, {
    url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  const { window } = dom;
  const sent = [];
  window[apiName()] = { runtime: background.pageRuntime((m) => sent.push(m), { contentScript: true }) };
  window.eval(await readFile(dist('content/tcgplayerOrders.js'), 'utf8'));
  await untilPricesArrive(window.document);
  return { window, document: window.document, sent };
}

const rowFor = (doc, name) => [...doc.querySelectorAll('tbody tr')].find((r) => r.textContent.includes(name));

forEachBrowser(() => {

test('each purchased item gets today\'s price and how it compares with what was paid', async () => {
  const bg = await startBackground();
  const { document } = await openOrders(bg);
  const lapras = rowFor(document, 'Lapras').querySelector('.ptcg-now');
  assert.match(lapras.className, /ptcg-now--lower/);
  // $9.32 + $1.49 shipping = $10.81, against $13.99 paid with free shipping.
  assert.equal(lapras.querySelector('.ptcg-now__price').textContent, 'Ask $10.81');
  assert.equal(lapras.querySelector('.ptcg-now__change').textContent, '▼ −$3.18 (−23%)');
});

test('the query sent matches the condition and printing of the purchase', async () => {
  const bg = await startBackground();
  await openOrders(bg);
  const request = bg.requests.find((r) => r.url.includes('/696683/'));
  assert.equal(request.init.method, 'POST');
  const body = JSON.parse(request.init.body);
  assert.deepEqual(body.filters.term.condition, ['Near Mint']);
  assert.deepEqual(body.filters.term.printing, ['Holofoil']);
});

test('items nobody is selling, and failed lookups, are labelled and never break the page', async () => {
  const bg = await startBackground();
  const { document } = await openOrders(bg);
  assert.equal(rowFor(document, 'Meowth').querySelector('.ptcg-now').textContent, 'No ask');
  assert.equal(rowFor(document, 'Frogadier').querySelector('.ptcg-now').textContent, 'Price unavailable');
  assert.ok(rowFor(document, 'Frogadier').textContent.includes('$5.61'), 'the price paid is untouched');
});

test('one request per item, and each row is annotated exactly once', async () => {
  const bg = await startBackground();
  const { document, sent } = await openOrders(bg);
  assert.equal(sent.length, 7);
  assert.equal(document.querySelectorAll('.ptcg-now').length, 7);
  await settle(100);
  assert.equal(sent.length, 7, 'page mutations do not re-request');
});

test('every visit asks for the price again: the Ask is never cached', async () => {
  const bg = await startBackground();
  await openOrders(bg);
  const first = bg.requests.filter((r) => r.url.includes('/696683/')).length;
  assert.equal(first, 1);
  await openOrders(bg);
  assert.equal(bg.requests.filter((r) => r.url.includes('/696683/')).length, 2);
});

test('rows added after load (the page redraws when the date range changes) are picked up', async () => {
  const bg = await startBackground();
  const { window, document } = await openOrders(bg);
  const holder = document.querySelector('#SellerOrderWidgetWrap');
  holder.innerHTML = ORDER_PAGE.match(/<div id="SellerOrderWidgetWrap">([\s\S]*)<\/div><\/body>/)[1];
  await untilPricesArrive(document);
  assert.equal(document.querySelectorAll('.ptcg-now').length, 7);
  assert.ok(window);
});

test('a page that is not showing orders is left alone', async () => {
  const bg = await startBackground();
  const { document, sent } = await openOrders(bg, '<html><body><p>Sign in</p></body></html>');
  assert.equal(sent.length, 0);
  assert.equal(document.querySelectorAll('.ptcg-now').length, 0);
});

test('the double-slash address the site actually serves works, with tracking parameters', async () => {
  const bg = await startBackground();
  const url = 'https://store.tcgplayer.com//myaccount/orderhistory?_gl=1*abc*_gcl_au*xyz';
  const { document } = await openOrders(bg, ORDER_PAGE, url);
  assert.equal(document.querySelectorAll('.ptcg-now').length, 7);
});

test('other store pages are left alone even if they contain a table like it', async () => {
  const bg = await startBackground();
  const { document, sent } = await openOrders(bg, ORDER_PAGE, 'https://store.tcgplayer.com/myaccount/messagecenter');
  assert.equal(sent.length, 0);
  assert.equal(document.querySelectorAll('.ptcg-now').length, 0);
});

test('the page total sits above the orders and counts only what could be priced', async () => {
  const bg = await startBackground();
  const { document } = await openOrders(bg);
  const totals = document.querySelectorAll('.ptcg-total');
  assert.equal(totals.length, 1);
  const total = totals[0];
  assert.equal(total.nextElementSibling, document.querySelector('.orderWrap'));
  assert.match(total.className, /ptcg-total--lower/);
  assert.equal(total.querySelector('.ptcg-total__figure').textContent, '▼ −$3.18 (−23%)');
  assert.match(total.querySelector('.ptcg-total__detail').textContent, /1 item counted · 6 without a price/);
});

test('the total is redrawn when the orders are, not duplicated', async () => {
  const bg = await startBackground();
  const { document } = await openOrders(bg);
  document.querySelector('#SellerOrderWidgetWrap').innerHTML = ORDER_PAGE.match(/<div id="SellerOrderWidgetWrap">([\s\S]*)<\/div><\/body>/)[1];
  await untilPricesArrive(document);
  assert.equal(document.querySelectorAll('.ptcg-total').length, 1);
});

test('the page settles: drawing the total does not trigger more drawing', async () => {
  const bg = await startBackground();
  const { window, document } = await openOrders(bg);
  let changes = 0;
  new window.MutationObserver((records) => { changes += records.length; }).observe(document.documentElement, { childList: true, subtree: true });
  await settle(400);
  assert.equal(changes, 0, 'no further page changes once every price is in');
});


// ---- retrying ------------------------------------------------------------------

test('a price TCGplayer is slow to give says it is retrying, then shows the price, and the total waits for it', async () => {
  const bg = await startBackground({ failFirst: 1, random: 0.999 });
  const dom = new JSDOM(ORDER_PAGE, { url: ORDER_URL, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole() });
  const { window } = dom;
  window[apiName()] = { runtime: bg.pageRuntime(undefined, { contentScript: true }) };
  window.eval(await readFile(dist('content/tcgplayerOrders.js'), 'utf8'));
  const d = window.document;

  const start = Date.now();
  while (!d.querySelector('.ptcg-now--retrying') && Date.now() - start < 4000) await settle(20);
  const box = d.querySelector('.ptcg-now--retrying');
  assert.ok(box, 'a row says it is retrying');
  assert.equal(box.querySelector('.ptcg-now__label').textContent, 'Retrying (1 of 4)\u2026');
  assert.match(d.querySelector('.ptcg-total').textContent, /Checking prices/);

  await untilPricesArrive(d);
  assert.equal(d.querySelector('.ptcg-now--retrying'), null);
  assert.equal(d.querySelector('.ptcg-now--loading'), null);
  assert.ok(d.querySelector('.ptcg-now__price'), 'a real price replaced it');
  assert.doesNotMatch(d.querySelector('.ptcg-total').textContent, /being retried|still loading/);
});

});
