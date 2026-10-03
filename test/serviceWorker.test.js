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
  let clicked = null;
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
      action: { onClicked: { addListener: (fn) => { clicked = fn; } } },
      tabs: { create: async (o) => { tabs.push(o); return {}; } },
    },
    setTimeout, clearTimeout, console, Promise, JSON, Date, URL, URLSearchParams, AbortController,
  };
  vm.createContext(sandbox);
  vm.runInContext(await readFile('dist/chrome/background.js', 'utf8'), sandbox);
  // Chrome's rule: an answer is only delivered through sendResponse, and only if the listener returns true
  // (or calls it before returning). A returned promise is ignored.
  const send = (message) => new Promise((resolve) => {
    const handled = listener(message, {}, resolve);
    if (handled !== true) resolve(undefined);
  });
  return { send, requests, tabs, data, sandbox, click: () => clicked({ id: 1 }) };
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

test('clicking the toolbar button opens the dashboard, with no popup in between', async () => {
  const worker = await startWorker();
  await worker.click();
  assert.deepEqual(worker.tabs.map((t) => t.url), ['chrome-extension://abc/home/home.html']);
});

// ---- retrying ----------------------------------------------------------------

/** A worker whose TCGplayer answers 503 for its first `failFirst` listing requests. */
async function startFlakyWorker({ failFirst, random = 0 }) {
  const data = {};
  const sent = [];
  let listener = null;
  let failed = 0;
  const sandbox = {
    fetch: async (url) => {
      if (/mp-search-api/.test(url)) {
        if (failed < failFirst) { failed += 1; return { ok: false, status: 503, json: async () => ({}), headers: { get: () => null } }; }
        return reply(LAPRAS_LISTINGS);
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    },
    chrome: {
      storage: { local: {
        get: async (keys) => Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]])),
        set: async (items) => { Object.assign(data, items); },
        remove: async (keys) => { [].concat(keys).forEach((k) => delete data[k]); },
      } },
      runtime: {
        onMessage: { addListener: (fn) => { listener = fn; } },
        getURL: (p) => `chrome-extension://abc/${p}`,
        sendMessage: async (message) => { sent.push({ via: 'runtime', ...message }); },
      },
      action: { onClicked: { addListener: () => {} } },
      tabs: { create: async () => ({}), sendMessage: async (tabId, message) => { sent.push({ via: 'tab', tabId, ...message }); } },
    },
    setTimeout, clearTimeout, console, Promise, JSON, Date, URL, URLSearchParams, AbortController,
    Math: Object.assign(Object.create(Math), { random: () => random }),
  };
  vm.createContext(sandbox);
  vm.runInContext(await readFile('dist/chrome/background.js', 'utf8'), sandbox);
  const send = (message, sender = { tab: { id: 7 } }) => new Promise((resolve) => {
    if (listener(message, sender, resolve) !== true) resolve(undefined);
  });
  return { send, sent, failures: () => failed };
}

const LAPRAS_ASK = { type: 'listing-price', ref: 'lapras-ask', item: { productId: '696683', condition: 'Near Mint Holofoil' } };

test('a listing lookup that hits a 503 is retried, the asking tab is told, and it still gets its answer', async () => {
  const worker = await startFlakyWorker({ failFirst: 2 });
  const result = await worker.send(LAPRAS_ASK);
  assert.equal(result.status, 'ok');
  assert.equal(worker.failures(), 2);
  assert.deepEqual(worker.sent.map((m) => [m.via, m.tabId, m.type, m.kind, m.ref, m.retry, m.retries]), [
    ['tab', 7, 'lookup-retry', 'listing-price', 'lapras-ask', 1, 4],
    ['tab', 7, 'lookup-retry', 'listing-price', 'lapras-ask', 2, 4],
  ], 'a content script is reached through its tab');
});

test('nothing is said when nothing needed retrying', async () => {
  const worker = await startFlakyWorker({ failFirst: 0 });
  assert.equal((await worker.send(LAPRAS_ASK)).status, 'ok');
  assert.deepEqual(worker.sent, []);
});

test('a lookup that never recovers is answered as unavailable after four retries', async () => {
  const worker = await startFlakyWorker({ failFirst: 99 });
  const result = await worker.send(LAPRAS_ASK);
  assert.equal(result.status, 'unavailable');
  assert.equal(worker.failures(), 5);
  assert.deepEqual(worker.sent.map((m) => m.retry), [1, 2, 3, 4]);
});

test('a request from something that is not in a tab is still answered, just not told about retries', async () => {
  const worker = await startFlakyWorker({ failFirst: 1 });
  const result = await worker.send(LAPRAS_ASK, {});
  assert.equal(result.status, 'ok');
  assert.deepEqual(worker.sent, []);
});

test('a request that gives no ref is answered without notices', async () => {
  const worker = await startFlakyWorker({ failFirst: 1 });
  const { ref, ...noRef } = LAPRAS_ASK;
  void ref;
  assert.equal((await worker.send(noRef)).status, 'ok');
  assert.deepEqual(worker.sent, []);
});

test('two tabs asking for the same price share one lookup and are both told, and a latecomer hears about the retry at once', async () => {
  const worker = await startFlakyWorker({ failFirst: 1, random: 0.999 });
  const first = worker.send(LAPRAS_ASK, { tab: { id: 1 } });
  await new Promise((r) => setTimeout(r, 120)); // the first attempt has failed and the retry is waiting
  const second = worker.send({ ...LAPRAS_ASK, ref: 'again' }, { tab: { id: 2 } });
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 'ok');
  assert.equal(b.status, 'ok');
  assert.deepEqual(worker.sent.map((m) => [m.tabId, m.ref]), [[1, 'lapras-ask'], [2, 'again']]);
});

test('once a lookup has finished, a new request for it is not told about the old retry', async () => {
  const worker = await startFlakyWorker({ failFirst: 1 });
  await worker.send(LAPRAS_ASK);
  worker.sent.length = 0;
  assert.equal((await worker.send({ ...LAPRAS_ASK, ref: 'later' }, { tab: { id: 9 } })).status, 'ok');
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(worker.sent, []);
});

test('an extension page (the dashboard) is told through runtime messaging, which reaches extension pages', async () => {
  const worker = await startFlakyWorker({ failFirst: 1 });
  const dashboard = { tab: { id: 3 }, url: 'chrome-extension://abc/home/home.html' };
  assert.equal((await worker.send(LAPRAS_ASK, dashboard)).status, 'ok');
  assert.deepEqual(worker.sent.map((m) => [m.via, m.type, m.kind, m.ref, m.retry]), [['runtime', 'lookup-retry', 'listing-price', 'lapras-ask', 1]]);
});

test('an extension page that is not in a tab is told too', async () => {
  const worker = await startFlakyWorker({ failFirst: 1 });
  const result = await worker.send(LAPRAS_ASK, { url: 'chrome-extension://abc/home/home.html' });
  assert.equal(result.status, 'ok');
  assert.equal(worker.sent.length, 1);
  assert.equal(worker.sent[0].via, 'runtime');
});

test('a page of another extension, or a web page, is not mistaken for ours', async () => {
  const worker = await startFlakyWorker({ failFirst: 1 });
  await worker.send(LAPRAS_ASK, { tab: { id: 4 }, url: 'chrome-extension://someoneelse/page.html' });
  assert.equal(worker.sent[0].via, 'tab');
});
