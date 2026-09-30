import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  parseOrders, parseOrderDate, parsePager, parseFilterForm, looksSignedOut, parseItemRow, productIdFromThumbnail,
} from '../src/lib/orderParse.js';
import { ORDERS, orderPage, SIGNED_OUT_PAGE } from './fixtures/orderHistoryFull.js';

const doc = (html) => new JSDOM(html).window.document;
const page = (opts) => doc(orderPage({ orders: ORDERS, ...opts }));

test('every order on the page is read', () => {
  const orders = parseOrders(page());
  assert.equal(orders.length, 6);
  assert.deepEqual(orders.map((o) => o.orderNumber).slice(0, 2), ['TEST0001-AAAAAA-BBBBB', 'TEST0002-AAAAAA-BBBBB']);
});

test('a marketplace order: date, channel, seller, shipping and summary', () => {
  const [order] = parseOrders(page());
  assert.equal(order.kind, 'marketplace');
  assert.equal(order.date, '2026-09-27');
  assert.equal(order.channel, 'TCG Marketplace');
  assert.deepEqual(order.seller, { name: 'Sample Seller A', url: 'https://store.tcgplayer.com/sellerfeedback/seller03' });
  assert.equal(order.shippingStatus, 'Shipped Without Tracking');
  assert.equal(order.shippingMethod, 'Standard (est.delivery by October 09, 2026) - $0.00');
  assert.deepEqual(order.summary, { quantity: 1, subtotal: 13.99, shipping: 0, tax: 1.4, total: 15.39 });
});

test('the shipping status varies by order', () => {
  const orders = parseOrders(page());
  assert.equal(orders[1].shippingStatus, 'Shipping Not Confirmed');
  assert.equal(orders[1].seller.name, 'Sample Seller B');
});

test('an item has what is needed to identify it', () => {
  const [{ items: [item] }] = parseOrders(page());
  assert.deepEqual(item, {
    productId: '696683',
    name: 'Lapras - 131/128',
    url: 'https://store.tcgplayer.com/pokemon/me-30th-celebration/lapras-131-128',
    setName: 'ME: 30th Celebration',
    rarity: 'Illustration Rare',
    condition: 'Near Mint Holofoil',
    paid: 13.99,
    quantity: 1,
    imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/696683_25w.jpg',
    seller: null,
  });
});

test('a TCGplayer Direct order uses its own number label and has per-item sellers', () => {
  const direct = parseOrders(page()).find((o) => o.kind === 'direct');
  assert.equal(direct.orderNumber, '123456-0005');
  assert.equal(direct.date, '2026-09-26');
  assert.deepEqual(direct.seller, { name: 'TCGplayer Direct', url: '' });
  assert.equal(direct.items.length, 5);
  assert.equal(direct.summary.subtotal, 52.68);
  assert.equal(direct.summary.total, 57.94);
  assert.deepEqual(direct.items.map((i) => i.paid), [5.61, 17.06, 6.36, 2.69, 20.96]);
  assert.equal(direct.items[0].seller.name, 'TCG Tavern');
  assert.match(direct.items[0].seller.url, /sellerfeedback/);
});

test('customer details are never read: no name, address or button text in anything returned', () => {
  const json = JSON.stringify(parseOrders(page()));
  for (const forbidden of ['Test Person', 'Example Street', 'Springfield', '00000', 'SHIP TO', 'BILL TO',
    'Contact Seller', 'Contact TCGplayer', 'Rate Transaction', 'Rate Package']) {
    assert.equal(json.includes(forbidden), false, forbidden);
  }
});

test('even if the address block were moved or renamed, only the named blocks are read', () => {
  const html = orderPage({ orders: [ORDERS[0]] }).replace('SHIP TO', 'DELIVERED TO');
  assert.equal(JSON.stringify(parseOrders(doc(html))).includes('Example Street'), false);
});

test('an order with no number is skipped rather than filed under nothing', () => {
  const html = orderPage({ orders: [ORDERS[0].replace(/TEST0001-AAAAAA-BBBBB/g, '')] });
  assert.deepEqual(parseOrders(doc(html)), []);
});

test('a page with no orders, or something else entirely, gives an empty list', () => {
  assert.deepEqual(parseOrders(doc('<p>nothing</p>')), []);
  assert.deepEqual(parseOrders(doc(orderPage({ orders: [] }))), []);
});

test('missing pieces come back as empty values, not exceptions', () => {
  const html = '<div class="orderWrap"><div class="orderHeader"><span><span class="orderTitle">Order Number</span><br> X-1 </span></div></div>';
  const [order] = parseOrders(doc(html));
  assert.equal(order.orderNumber, 'X-1');
  assert.equal(order.date, '');
  assert.equal(order.seller, null);
  assert.deepEqual(order.items, []);
  assert.deepEqual(order.summary, { quantity: null, subtotal: null, shipping: null, tax: null, total: null });
});

test('dates: valid, invalid and empty', () => {
  assert.equal(parseOrderDate('September 27, 2026'), '2026-09-27');
  assert.equal(parseOrderDate('  January 3,  2025 '), '2025-01-03');
  assert.equal(parseOrderDate('DECEMBER 31, 2024'), '2024-12-31');
  for (const bad of ['', null, undefined, 'Smarch 3, 2026', 'September 40, 2026', '2026-09-27', 'September 27']) {
    assert.equal(parseOrderDate(bad), '', String(bad));
  }
});

test('pager: current page, last page and total orders', () => {
  assert.deepEqual(parsePager(page({ pages: 3, page: 1, total: 24 })), { page: 1, pages: 3, total: 24 });
  assert.deepEqual(parsePager(page({ pages: 3, page: 2, total: 24 })), { page: 2, pages: 3, total: 24 });
  assert.deepEqual(parsePager(page({ pages: 3, page: 3, total: 24 })), { page: 3, pages: 3, total: 24 });
});

test('pager: a single page has no pager', () => {
  assert.deepEqual(parsePager(page({ pages: 1 })), { page: 1, pages: 1, total: 6 });
  assert.deepEqual(parsePager(doc('<p>x</p>')), { page: 1, pages: 1, total: null });
});

test('pager: the LAST link counts even when only some page numbers are shown', () => {
  const html = '<div class="pager"><span class="pages currentPage">1</span><a href="?PageNumber=2" class="pages">2</a>'
    + '<a href="?PageNumber=9" class="pageLast">LAST</a></div>';
  assert.equal(parsePager(doc(html)).pages, 9);
});

test('filter form: token, hidden fields, options and the selected range', () => {
  const form = parseFilterForm(page({ range: 'Last 90 Days' }));
  assert.equal(form.token, 'TEST-TOKEN');
  assert.equal(form.action, '/myaccount/orderhistory');
  assert.equal(form.range, 'Last 90 Days');
  assert.deepEqual(form.ranges, ['Last 30 Days', 'Last 90 Days', 'Last 120 Days', '2026', '2025']);
  assert.equal(form.fields.ClearSessionFilters, 'false');
  assert.equal('DateRange' in form.fields, false, 'the select is not an input');
});

test('filter form: absent on a page that is not the order history', () => {
  assert.equal(parseFilterForm(doc('<p>x</p>')), null);
});

test('signed out: a login page has no order filter form; an empty range still does', () => {
  assert.equal(looksSignedOut(doc(SIGNED_OUT_PAGE)), true);
  assert.equal(looksSignedOut(page()), false);
  assert.equal(looksSignedOut(doc(orderPage({ orders: [] }))), false);
});

test('parseItemRow ignores rows that are not items', () => {
  const row = doc('<table><tbody><tr><td>Shipping</td></tr></tbody></table>').querySelector('tr');
  assert.equal(parseItemRow(row), null);
});

test('thumbnails: prefer the lazy-load attribute; the "0" placeholder is not a product', () => {
  const d = doc('<img data-original="https://x/product/696683_25w.jpg" src="p.gif"><img src="https://x/product/0_25w.jpg"><img src="a.gif">');
  const [a, b, c] = d.querySelectorAll('img');
  assert.equal(productIdFromThumbnail(a), '696683');
  assert.equal(productIdFromThumbnail(b), null);
  assert.equal(productIdFromThumbnail(c), null);
  assert.equal(productIdFromThumbnail(null), null);
});

test('what the extension itself adds beside the price never changes what was paid', () => {
  const d = page();
  // Even placed *before* the price, where a naive "first dollar amount" would pick it up.
  d.querySelector('td.orderHistoryPrice').insertAdjacentHTML('afterbegin', '<div class="ptcg-now">Ask $1.00 ▼ −$12.99</div>');
  assert.equal(parseOrders(d)[0].items[0].paid, 13.99);
});
