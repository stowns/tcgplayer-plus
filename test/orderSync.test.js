import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { syncOrders, ORDER_HISTORY_URL, MAX_PAGES } from '../src/lib/orderSync.js';
import { ORDERS, orderPage, SIGNED_OUT_PAGE } from './fixtures/orderHistoryFull.js';

const parseHtml = (html) => new JSDOM(html).window.document;

/** A tiny TCGplayer: 3 pages of orders; the selected range is session state, changed by the form post. */
function fakeSite({ range = 'Last 30 Days', search = '', failPage = null, loggedIn = true, postOk = true } = {}) {
  const state = { range, search, requests: [], posts: [] };
  const pagesOf = { 1: ORDERS.slice(0, 3), 2: ORDERS.slice(3, 5), 3: ORDERS.slice(5) };
  return {
    state,
    deps: {
      parseHtml,
      getText: async (url) => {
        state.requests.push(url);
        if (!loggedIn) return { ok: true, status: 200, url: 'https://www.tcgplayer.com/login?returnUrl=/myaccount/orderhistory', text: SIGNED_OUT_PAGE };
        const n = Number((/PageNumber=(\d+)/.exec(url) || [])[1] || 1);
        if (n === failPage) return { ok: false, status: 503, url, text: '' };
        let html = orderPage({ orders: pagesOf[n], page: n, pages: 3, total: 6, range: state.range });
        if (state.search) html = html.replace('id="SearchString" name="SearchString" type="text"', `id="SearchString" name="SearchString" type="text" value="${state.search}"`);
        return { ok: true, status: 200, url, text: html };
      },
      postForm: async (url, body, token) => {
        state.posts.push({ url, body: new URLSearchParams(body), token });
        if (!postOk) return { ok: false, status: 500 };
        state.range = new URLSearchParams(body).get('DateRange');
        state.search = '';
        return { ok: true, status: 200 };
      },
    },
  };
}

test('reads every page of the current range without touching any setting', async () => {
  const site = fakeSite();
  const result = await syncOrders({}, site.deps);
  assert.equal(result.status, 'ok');
  assert.equal(result.orders.length, 6);
  assert.equal(result.pages, 3);
  assert.equal(result.range, 'Last 30 Days');
  assert.deepEqual(site.state.requests, [ORDER_HISTORY_URL, `${ORDER_HISTORY_URL}?PageNumber=2`, `${ORDER_HISTORY_URL}?PageNumber=3`]);
  assert.equal(site.state.posts.length, 0);
});

test('asking for the range already selected changes nothing', async () => {
  const site = fakeSite({ range: 'Last 90 Days' });
  const result = await syncOrders({ range: 'Last 90 Days' }, site.deps);
  assert.equal(site.state.posts.length, 0);
  assert.equal(result.rangeApplied, true);
});

test('a different range is chosen with the same form post TCGplayer\'s dropdown makes', async () => {
  const site = fakeSite();
  const result = await syncOrders({ range: '2025' }, site.deps);
  assert.equal(site.state.posts.length, 1);
  const post = site.state.posts[0];
  assert.equal(post.url, 'https://store.tcgplayer.com/MyAccount/OrderHistory');
  assert.equal(post.token, 'TEST-TOKEN');
  assert.equal(post.body.get('DateRange'), '2025');
  assert.equal(post.body.get('ClearSessionFilters'), 'true');
  assert.equal(post.body.get('__RequestVerificationToken'), 'TEST-TOKEN');
  assert.equal(result.range, '2025');
  assert.equal(result.rangeApplied, true);
  assert.equal(result.orders.length, 6);
});

test('a leftover search term is cleared, or it would quietly hide orders', async () => {
  const site = fakeSite({ search: 'pikachu' });
  await syncOrders({}, site.deps);
  assert.equal(site.state.posts.length, 1);
  assert.equal(site.state.posts[0].body.get('SearchString'), '');
  assert.equal(site.state.posts[0].body.get('DateRange'), 'Last 30 Days', 'the range is left as it was');
});

test('a failed range change is an error, not silently the wrong range', async () => {
  const site = fakeSite({ postOk: false });
  const result = await syncOrders({ range: '2025' }, site.deps);
  assert.equal(result.status, 'error');
  assert.match(result.error, /would not change the range/);
});

test('if TCGplayer accepts the post but still shows another range, that is reported', async () => {
  const site = fakeSite();
  site.deps.postForm = async () => ({ ok: true, status: 200 });
  const result = await syncOrders({ range: '2025' }, site.deps);
  assert.equal(result.rangeApplied, false);
  assert.equal(result.range, 'Last 30 Days');
  assert.equal(result.orders.length, 6, 'the orders read are still real orders');
});

test('a login redirect means signed out, and nothing else is requested', async () => {
  const site = fakeSite({ loggedIn: false });
  const result = await syncOrders({}, site.deps);
  assert.equal(result.status, 'signed-out');
  assert.deepEqual(result.orders, []);
  assert.equal(site.state.requests.length, 1);
});

test('a page without the order form is treated as signed out too', async () => {
  const deps = { parseHtml, getText: async (url) => ({ ok: true, status: 200, url, text: SIGNED_OUT_PAGE }), postForm: async () => ({ ok: true }) };
  assert.equal((await syncOrders({}, deps)).status, 'signed-out');
});

test('an account with no orders in the range is fine, not signed out', async () => {
  const deps = { parseHtml, getText: async (url) => ({ ok: true, status: 200, url, text: orderPage({ orders: [] }) }), postForm: async () => ({ ok: true }) };
  const result = await syncOrders({}, deps);
  assert.deepEqual([result.status, result.orders.length], ['ok', 0]);
});

test('an error on the first page is an error', async () => {
  const site = fakeSite({ failPage: 1 });
  const result = await syncOrders({}, site.deps);
  assert.equal(result.status, 'error');
  assert.match(result.error, /503/);
});

test('an error part-way keeps the pages already read', async () => {
  const site = fakeSite({ failPage: 3 });
  const result = await syncOrders({}, site.deps);
  assert.equal(result.status, 'partial');
  assert.equal(result.orders.length, 5);
  assert.equal(result.pages, 2);
  assert.match(result.error, /503/);
});

test('being signed out part-way is partial, keeping what was read', async () => {
  const site = fakeSite();
  const original = site.deps.getText;
  site.deps.getText = async (url) => (url.includes('PageNumber=2')
    ? { ok: true, status: 200, url: 'https://www.tcgplayer.com/login', text: SIGNED_OUT_PAGE }
    : original(url));
  const result = await syncOrders({}, site.deps);
  assert.equal(result.status, 'partial');
  assert.equal(result.orders.length, 3);
});

test('a network exception is an error result, never thrown', async () => {
  const deps = { parseHtml, getText: async () => { throw new Error('offline'); }, postForm: async () => ({ ok: true }) };
  const result = await syncOrders({}, deps);
  assert.deepEqual([result.status, result.error], ['error', 'offline']);
});

test('a runaway pager cannot make it fetch forever', async () => {
  const requests = [];
  const deps = {
    parseHtml,
    postForm: async () => ({ ok: true }),
    getText: async (url) => {
      requests.push(url);
      return { ok: true, status: 200, url, text: orderPage({ orders: [ORDERS[0]], pages: 200 }) };
    },
  };
  await syncOrders({}, deps);
  assert.equal(requests.length, MAX_PAGES);
});
