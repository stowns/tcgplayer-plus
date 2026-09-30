/*
 * Runs the *built* popup against a stubbed WebExtension API.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM, VirtualConsole } from 'jsdom';

const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function openPopup(data = {}) {
  const html = await readFile('src/popup/popup.html', 'utf8');
  const dom = new JSDOM(html, { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  const { window } = dom;
  const created = [];
  let closed = false;
  window.close = () => { closed = true; };
  window.browser = {
    storage: { local: {
      get: async (keys) => (keys === null ? { ...data } : Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]]))),
      remove: async (keys) => { [].concat(keys).forEach((k) => delete data[k]); },
    } },
    runtime: { getURL: (path) => `moz-extension://test/${path}` },
    tabs: { create: async (options) => { created.push(options.url); } },
  };
  window.eval(await readFile('dist/popup/popup.js', 'utf8'));
  await settle();
  return { document: window.document, created, data, wasClosed: () => closed };
}

const list = (n) => ({ id: `l${n}`, name: `List ${n}`, createdAt: '', updatedAt: '', items: [
  { key: `${n}:english`, productId: String(n), language: 'English', name: 'Card', savedAt: '' },
] });

test('the popup is TCGPlayer+ with one button into the dashboard', async () => {
  const { document } = await openPopup();
  assert.equal(document.querySelector('h1').textContent, 'TCGPlayer+');
  assert.deepEqual([...document.querySelectorAll('button')].map((b) => b.textContent),
    ['Dashboard', 'Clear price cache']);
  assert.equal(document.querySelectorAll('input, select, form').length, 0);
});

test('the Dashboard button opens the home page, which picks the tab itself, then closes the popup', async () => {
  const page = await openPopup();
  page.document.getElementById('openDashboard').click();
  await settle();
  assert.deepEqual(page.created, ['moz-extension://test/home/home.html']);
  assert.equal(page.wasClosed(), true);
});

test('the summary counts products and lists, or says there are none yet', async () => {
  assert.match((await openPopup()).document.getElementById('listsSummary').textContent, /No lists yet/);
  const page = await openPopup({ lists: { version: 1, lists: [list(1), list(2)] } });
  assert.equal(page.document.getElementById('listsSummary').textContent, '2 products across 2 lists.');
  const one = await openPopup({ lists: { version: 1, lists: [list(1)] } });
  assert.equal(one.document.getElementById('listsSummary').textContent, '1 product across 1 list.');
});

test('Clear price cache removes trends and prices, and never saved lists or the order archive', async () => {
  const page = await openPopup({
    lists: { version: 1, lists: [] }, orders: { orders: {} },
    'tr:1|english|near mint|holofoil': 1, 'tr:2': 1, 'ls:3|near mint|holofoil': 1,
  });
  page.document.getElementById('clearCache').click();
  await settle();
  assert.deepEqual(Object.keys(page.data).sort(), ['lists', 'orders']);
  assert.equal(page.document.getElementById('status').textContent, 'Cleared 3 cached lookups.');
});

test('clearing an empty cache says so in the singular correctly', async () => {
  const page = await openPopup({ 'tr:1': 1 });
  page.document.getElementById('clearCache').click();
  await settle();
  assert.equal(page.document.getElementById('status').textContent, 'Cleared 1 cached lookup.');
});
