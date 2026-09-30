/*
 * Chrome runs the background as a service worker: no window, no document, no
 * DOMParser. This evaluates the built Chrome background in a bare context that
 * has only what a worker has, and talks to it the way Chrome does.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { LAPRAS_LISTINGS } from './fixtures/tcgplayerListings.js';

const reply = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

async function startWorker() {
  const data = {};
  const requests = [];
  let listener = null;
  const tabs = [];
  const sandbox = {
    fetch: async (url, init = {}) => {
      requests.push({ url, method: init.method || 'GET' });
      if (/mp-search-api/.test(url)) return reply(LAPRAS_LISTINGS);
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    },
    chrome: {
      storage: {
        local: {
          get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]])),
          set: async (items) => { Object.assign(data, items); },
          remove: async (keys) => { [].concat(keys).forEach((k) => delete data[k]); },
        },
      },
      runtime: { onMessage: { addListener: (fn) => { listener = fn; } }, getURL: (p) => `chrome-extension://abc/${p}` },
      tabs: { create: async (o) => { tabs.push(o); return {}; } },
    },
    setTimeout, clearTimeout, console, Promise, JSON, Date, URL, URLSearchParams,
  };
  vm.createContext(sandbox);
  vm.runInContext(await readFile('dist/chrome/background.js', 'utf8'), sandbox);
  // Chrome's rule: an answer is only delivered through sendResponse, and only if the listener returns true
  // (or calls it before returning). A returned promise is ignored.
  const send = (message) => new Promise((resolve) => {
    const handled = listener(message, {}, resolve);
    if (handled !== true) resolve(undefined);
  });
  return { send, requests, tabs, data, sandbox };
}

test('the Chrome background needs no DOM', async () => {
  const worker = await startWorker();
  for (const name of ['window', 'document', 'DOMParser']) assert.equal(name in worker.sandbox, false, name);
});

test('it answers a listing-price lookup through sendResponse', async () => {
  const worker = await startWorker();
  const result = await worker.send({ type: 'listing-price', item: { productId: '696683', condition: 'Near Mint Holofoil' } });
  assert.ok(result, 'got an answer');
  assert.equal(result.status, 'ok');
  assert.ok(worker.requests.some((r) => r.method === 'POST' && /696683\/listings/.test(r.url)));
});

test('a failed price-trend lookup is answered with an unknown trend, not silence', async () => {
  const worker = await startWorker();
  const result = await worker.send({ type: 'price-trend', item: { productId: '712953', language: 'English', condition: 'Near Mint Holofoil' } });
  assert.equal(result.direction, 'unknown');
});

test('open-lists opens the dashboard on the Saved Lists tab', async () => {
  const worker = await startWorker();
  assert.deepEqual({ ...(await worker.send({ type: 'open-lists' })) }, { opened: true });
  assert.equal(worker.tabs[0].url, 'chrome-extension://abc/home/home.html#lists');
});

test('messages it does not know are left unanswered', async () => {
  const worker = await startWorker();
  assert.equal(await worker.send({ type: 'sync-orders' }), undefined);
  assert.equal(await worker.send(null), undefined);
});
