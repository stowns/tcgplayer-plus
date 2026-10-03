import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readOrders, ORDER_PACE } from '../src/lib/orderReader.js';
import { ORDER_HISTORY_URL } from '../src/lib/orderSync.js';
import { ORDERS, orderPage, SIGNED_OUT_PAGE } from './fixtures/orderHistoryFull.js';

const parseHtml = (html) => new JSDOM(html).window.document;
const instant = { run: (task) => task() };

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(keys) { return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, data[k]])); },
    async set(items) { Object.assign(data, items); },
    async remove(keys) { [].concat(keys).forEach((k) => delete data[k]); },
  };
}

/** A tiny TCGplayer behind `fetch`: three pages; the range is session state set by the form post. */
function fakeFetch({ range = 'Last 30 Days', loggedIn = true, failPage = null, failStatus = 503, failTimes = Infinity } = {}) {
  const site = { range, calls: [], failed: 0 };
  const pages = [ORDERS.slice(0, 3), ORDERS.slice(3, 5), ORDERS.slice(5)];
  site.fetch = async (url, init = {}) => {
    site.calls.push({ url, init });
    if (init.method === 'POST') {
      site.range = new URLSearchParams(init.body).get('DateRange');
      return { ok: true, status: 200, url, text: async () => '{}' };
    }
    if (!loggedIn) return { ok: true, status: 200, url: 'https://www.tcgplayer.com/login?returnUrl=/myaccount/orderhistory', text: async () => SIGNED_OUT_PAGE };
    const n = Number((/PageNumber=(\d+)/.exec(url) || [])[1] || 1);
    if (n === failPage && site.failed < failTimes) { site.failed += 1; return { ok: false, status: failStatus, url, text: async () => '' }; }
    return { ok: true, status: 200, url, text: async () => orderPage({ orders: pages[n - 1], page: n, pages: 3, total: 6, range: site.range }) };
  };
  return site;
}

const run = (site, storage, options = {}, extra = {}) => readOrders(options, {
  fetch: site.fetch, parseHtml, storage, throttle: instant, now: () => '2026-09-30T12:00:00.000Z',
  retry: { random: () => 0.5, sleep: async () => {} }, ...extra,
});

test('reads every page, keeps the orders and reports what happened', async () => {
  const storage = memoryStorage();
  const result = await run(fakeFetch(), storage);
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 6);
  assert.equal(result.added, 6);
  assert.equal(result.updated, 0);
  assert.equal(result.pages, 3);
  assert.equal(Object.keys(storage.data.orders.orders).length, 6);
});

test('requests carry the account\'s cookies', async () => {
  const site = fakeFetch();
  await run(site, memoryStorage());
  assert.ok(site.calls.length >= 3);
  for (const { init } of site.calls) assert.equal(init.credentials, 'include');
  assert.equal(site.calls[0].url, ORDER_HISTORY_URL);
});

test('a different range is chosen with the form post TCGplayer\'s dropdown makes', async () => {
  const site = fakeFetch();
  const result = await run(site, memoryStorage(), { range: '2025' });
  const post = site.calls.find((c) => c.init.method === 'POST');
  assert.ok(post, 'posted the range');
  assert.equal(new URLSearchParams(post.init.body).get('DateRange'), '2025');
  assert.match(post.init.headers['Content-Type'], /^application\/x-www-form-urlencoded/);
  assert.equal(post.init.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.ok(post.init.headers.__RequestVerificationToken, 'sends the page token');
  assert.equal(post.init.credentials, 'include');
  assert.equal(result.range, '2025');
  assert.equal(result.rangeApplied, true);
});

test('a complete read records when its range was last synced', async () => {
  const storage = memoryStorage();
  await run(fakeFetch(), storage);
  assert.equal(storage.data.orders.syncedAt['Last 30 Days'], '2026-09-30T12:00:00.000Z');
});

test('a partial read keeps the orders it got but does not claim the range was synced', async () => {
  const storage = memoryStorage();
  const result = await run(fakeFetch({ failPage: 2 }), storage);
  assert.equal(result.status, 'partial');
  assert.ok(result.count > 0);
  assert.equal(Object.keys(storage.data.orders.syncedAt || {}).length, 0);
});

test('signed out: nothing is stored and the status says so', async () => {
  const storage = memoryStorage();
  const result = await run(fakeFetch({ loggedIn: false }), storage);
  assert.equal(result.status, 'signed-out');
  assert.equal(result.count, 0);
  assert.equal(storage.data.orders, undefined);
});

test('reading again updates what is kept and adds nothing new', async () => {
  const storage = memoryStorage();
  await run(fakeFetch(), storage);
  const again = await run(fakeFetch(), storage);
  assert.equal(again.added, 0);
  assert.equal(again.count, 6);
  assert.equal(Object.keys(storage.data.orders.orders).length, 6);
});

test('a network failure is reported, not thrown', async () => {
  const result = await readOrders({}, {
    fetch: async () => { throw new Error('offline'); }, parseHtml, storage: memoryStorage(), throttle: instant,
    retry: { sleep: async () => {} },
  });
  assert.notEqual(result.status, 'ok');
  assert.equal(result.count, 0);
});

test('a storage failure is reported with the orders that were read', async () => {
  const storage = memoryStorage();
  storage.set = async () => { throw new Error('quota exceeded'); };
  const result = await run(fakeFetch(), storage);
  assert.equal(result.status, 'error');
  assert.match(result.error, /quota exceeded/);
  assert.equal(result.count, 6);
});

test('order pages are read one at a time, a beat apart', async () => {
  assert.equal(ORDER_PACE.concurrency, 1);
  assert.ok(ORDER_PACE.minIntervalMs >= 200);
  const site = fakeFetch();
  let inFlight = 0;
  let peak = 0;
  const fetch = async (...args) => {
    inFlight += 1; peak = Math.max(peak, inFlight);
    try { return await site.fetch(...args); } finally { inFlight -= 1; }
  };
  const { createThrottle } = await import('../src/lib/throttle.js');
  await readOrders({}, { fetch, parseHtml, storage: memoryStorage(), throttle: createThrottle({ ...ORDER_PACE, minIntervalMs: 1 }) });
  assert.equal(peak, 1);
});

// ---- retrying ------------------------------------------------------------------

test('a page that fails once is retried, the read is complete, and the caller is told about the wait', async () => {
  const site = fakeFetch({ failPage: 2, failTimes: 1 });
  const told = [];
  const result = await run(site, memoryStorage(), {}, { onRetry: (info) => told.push([info.retry, info.retries]) });
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 6, 'nothing is missing');
  assert.deepEqual(told, [[1, 4]]);
  assert.equal(site.calls.filter((c) => /PageNumber=2/.test(c.url)).length, 2, 'page 2 was asked for twice');
});

test('a page that keeps failing is retried four times, then the read is partial and keeps what it got', async () => {
  const site = fakeFetch({ failPage: 2 });
  const storage = memoryStorage();
  const told = [];
  const result = await run(site, storage, {}, { onRetry: (info) => told.push(info.retry) });
  assert.equal(result.status, 'partial');
  assert.equal(site.calls.filter((c) => /PageNumber=2/.test(c.url)).length, 5, 'one attempt and four retries');
  assert.deepEqual(told, [1, 2, 3, 4]);
  assert.ok(Object.keys(storage.data.orders.orders).length > 0, 'what was read is saved');
});

test('a page that is simply not there is not retried', async () => {
  const site = fakeFetch({ failPage: 2, failStatus: 404 });
  const told = [];
  const result = await run(site, memoryStorage(), {}, { onRetry: (info) => told.push(info) });
  assert.equal(result.status, 'partial');
  assert.equal(site.calls.filter((c) => /PageNumber=2/.test(c.url)).length, 1);
  assert.deepEqual(told, []);
});

test('the range post is retried too', async () => {
  const site = fakeFetch();
  let posts = 0;
  const flaky = async (url, init = {}) => {
    if (init.method === 'POST') {
      posts += 1;
      if (posts === 1) return { ok: false, status: 502, url, text: async () => '' };
    }
    return site.fetch(url, init);
  };
  const result = await run({ fetch: flaky }, memoryStorage(), { range: '2025' });
  assert.equal(posts, 2);
  assert.equal(result.rangeApplied, true);
  assert.equal(result.range, '2025');
});

test('a dropped connection that comes back is retried and the read completes', async () => {
  const site = fakeFetch();
  let calls = 0;
  const flaky = async (...args) => {
    calls += 1;
    if (calls === 1) throw new TypeError('Failed to fetch');
    return site.fetch(...args);
  };
  const result = await run({ fetch: flaky }, memoryStorage());
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 6);
});

test('an order page that never answers times out, is retried, and then the read is reported, not hung', async () => {
  const site = fakeFetch();
  const never = (url, init) => (/PageNumber=2/.test(url) ? new Promise(() => {}) : site.fetch(url, init));
  const told = [];
  const result = await readOrders({}, {
    fetch: never, parseHtml, storage: memoryStorage(), throttle: instant,
    timeoutMs: 15, retry: { random: () => 0, sleep: async () => {} }, onRetry: (i) => told.push(i.retry),
  });
  assert.equal(result.status, 'partial', 'the page that did come back is kept');
  assert.ok(result.count > 0);
  assert.deepEqual(told, [1, 2, 3, 4]);
});

test('a slow order page that answers on the retry completes the read', async () => {
  const site = fakeFetch();
  let slowOnce = true;
  const flaky = (url, init) => {
    if (/PageNumber=2/.test(url) && slowOnce) { slowOnce = false; return new Promise(() => {}); }
    return site.fetch(url, init);
  };
  const result = await readOrders({}, {
    fetch: flaky, parseHtml, storage: memoryStorage(), throttle: instant,
    timeoutMs: 15, retry: { random: () => 0, sleep: async () => {} },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.count, 6);
});
