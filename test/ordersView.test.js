import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  describeSync,
  formatOrderDate, productPageUrl, renderOrder, renderOrders, renderNotice, renderOrderChange, updateResult, itemKeyOf, linesFor,
} from '../src/lib/ordersView.js';
import { parseOrders } from '../src/lib/orderParse.js';
import { ORDERS, orderPage } from './fixtures/orderHistoryFull.js';

const doc = () => new JSDOM('<body><div id="c"></div></body>').window.document;
const orders = parseOrders(new JSDOM(orderPage({ orders: ORDERS })).window.document);
const ok = (price) => ({ status: 'ok', price, shipping: 0, count: 5, seller: '' });
const laprasKey = itemKeyOf(orders[0].items[0]);

test('dates read as people write them, and a bad one says so', () => {
  assert.equal(formatOrderDate('2026-09-27'), 'Sep 27, 2026');
  assert.equal(formatOrderDate('2025-01-03'), 'Jan 3, 2025');
  for (const bad of ['', null, undefined, 'x', '2026-13-01']) assert.equal(formatOrderDate(bad), 'Date unknown');
});

test('an order shows its date, number, seller, channel and shipping', () => {
  const d = doc();
  const a = renderOrder(d, orders[0]);
  assert.equal(a.querySelector('.order__date').textContent, 'Sep 27, 2026');
  assert.equal(a.querySelector('.order__number').textContent, 'Order TEST0001-AAAAAA-BBBBB');
  assert.equal(a.querySelector('.order__seller').textContent, 'Sample Seller A');
  assert.equal(a.querySelector('.order__seller').getAttribute('href'), 'https://store.tcgplayer.com/sellerfeedback/seller03');
  assert.equal(a.querySelector('.order__channel').textContent, 'TCG Marketplace');
  assert.match(a.querySelector('.order__ship').textContent, /Shipped Without Tracking · Standard \(est\.delivery by October 09, 2026\)/);
});

test('an order shows its totals', () => {
  const rows = [...renderOrder(doc(), orders[0]).querySelectorAll('.order__total-row')]
    .map((r) => [r.querySelector('dt').textContent, r.querySelector('dd').textContent]);
  assert.deepEqual(rows, [['Items', '1'], ['Subtotal', '$13.99'], ['Shipping', '$0.00'], ['Tax', '$1.40'], ['Total', '$15.39']]);
});

test('each item shows what identifies it: name link, set, rarity, condition, price paid', () => {
  const li = renderOrder(doc(), orders[0]).querySelector('.oitem');
  const name = li.querySelector('.oitem__name');
  assert.equal(name.textContent, 'Lapras - 131/128');
  assert.equal(name.getAttribute('href'), 'https://www.tcgplayer.com/product/696683');
  assert.equal(name.getAttribute('target'), '_blank');
  assert.equal(name.getAttribute('rel'), 'noopener noreferrer');
  assert.equal(li.querySelector('.oitem__meta').textContent, 'ME: 30th Celebration · Illustration Rare · Near Mint Holofoil');
  assert.equal(li.querySelector('.oitem__paid-price').textContent, '$13.99');
  assert.equal(li.querySelector('.oitem__qty'), null, 'no "× 1" clutter');
  // The sharper 200px picture; the order page's 25px thumbnail is only the fallback.
  assert.equal(li.querySelector('img').getAttribute('src'), 'https://tcgplayer-cdn.tcgplayer.com/product/696683_in_200x200.jpg');
  li.querySelector('img').dispatchEvent(new li.ownerDocument.defaultView.Event('error'));
  assert.equal(li.querySelector('img').getAttribute('src'), 'https://tcgplayer-cdn.tcgplayer.com/product/696683_25w.jpg');
});

test('a Direct order is labelled, lists every item and who sold each', () => {
  const direct = orders.find((o) => o.kind === 'direct');
  const a = renderOrder(doc(), direct);
  assert.match(a.querySelector('.order__number').textContent, /^TCGplayer Direct # 123456-0005$/);
  assert.equal(a.querySelectorAll('.oitem').length, 5);
  assert.equal(a.querySelector('.oitem__seller').textContent, 'Sold by TCG Tavern');
});

test('quantity above one is shown', () => {
  const o = structuredClone(orders[0]);
  o.items[0].quantity = 3;
  assert.equal(renderOrder(doc(), o).querySelector('.oitem__qty').textContent, '× 3');
});

test('nothing personal or interactive appears in an order', () => {
  const d = doc();
  const c = d.getElementById('c');
  renderOrders(d, c, orders);
  for (const forbidden of ['SHIP TO', 'BILL TO', 'Test Person', 'Example Street', 'Contact', 'Rate ']) {
    assert.equal(c.textContent.includes(forbidden), false, forbidden);
  }
  assert.equal(c.querySelectorAll('button, input').length, 0);
});

test('page text is never interpreted as markup', () => {
  const o = structuredClone(orders[0]);
  o.items[0].name = '<img src=x onerror=alert(1)>';
  o.seller.name = '<b>x</b>';
  const a = renderOrder(doc(), o);
  assert.equal(a.querySelector('img[src="x"]'), null);
  assert.equal(a.querySelector('.order__seller b'), null);
});

test('the title links to the item\'s product page, built from its product id', () => {
  assert.equal(productPageUrl({ productId: '696683', url: 'https://store.tcgplayer.com/pokemon/x/y' }), 'https://www.tcgplayer.com/product/696683');
  // Even an order saved without a usable link still has one.
  const o = structuredClone(orders[0]);
  o.items[0].url = '';
  assert.equal(renderOrder(doc(), o).querySelector('a.oitem__name').getAttribute('href'), 'https://www.tcgplayer.com/product/696683');
});

test('without a product id, the order page\'s own link is used, but only if it is http(s)', () => {
  assert.equal(productPageUrl({ productId: null, url: 'https://store.tcgplayer.com/pokemon/x/y' }), 'https://store.tcgplayer.com/pokemon/x/y');
  assert.equal(productPageUrl({ productId: null, url: 'javascript:alert(1)' }), '');
  assert.equal(productPageUrl({ productId: 'abc', url: '' }), '');
  assert.equal(productPageUrl({}), '');
});

test('links and images with unsafe schemes are not rendered as links', () => {
  const o = structuredClone(orders[0]);
  o.items[0].productId = null;
  o.items[0].url = 'javascript:alert(1)';
  o.items[0].imageUrl = 'http://insecure/x.jpg';
  o.seller.url = 'data:text/html,x';
  const a = renderOrder(doc(), o);
  assert.equal(a.querySelector('a.oitem__name'), null);
  assert.equal(a.querySelector('.oitem__name').textContent, 'Lapras - 131/128');
  // No id to build a picture from, and an insecure saved one is refused.
  assert.equal(a.querySelector('.oitem__image'), null);
  assert.equal(a.querySelector('a.order__seller'), null);
  assert.equal(a.querySelector('span.order__seller').textContent, 'Sample Seller A');
});

test('an item with no answer yet says it is checking; with one it shows now and the change', () => {
  const loading = renderOrder(doc(), orders[0]).querySelector('.ptcg-now');
  assert.match(loading.className, /ptcg-now--loading/);
  const done = renderOrder(doc(), orders[0], { [laprasKey]: ok(9.32) }).querySelector('.ptcg-now');
  assert.match(done.className, /ptcg-now--lower/);
  assert.equal(done.querySelector('.ptcg-now__change').textContent, '▼ −$4.67 (−33%)');
});

test('an item that cannot be looked up gets no price block at all', () => {
  const o = structuredClone(orders[0]);
  o.items[0].productId = null;
  assert.equal(renderOrder(doc(), o).querySelector('.ptcg-now'), null);
});

test('the order header carries that order\'s own gain or loss, in colour classes', () => {
  const d = doc();
  const lossy = renderOrderChange(d, orders[0], { [laprasKey]: ok(9.32) });
  assert.match(lossy.className, /order__change--lower/);
  assert.equal(lossy.textContent, '▼ −$4.67 (−33%)');
  assert.match(renderOrderChange(d, orders[0], { [laprasKey]: ok(20) }).className, /order__change--higher/);
  assert.match(renderOrderChange(d, orders[0], {}).className, /order__change--unknown/);
});

test('the summary above the list totals every order shown', () => {
  const d = doc();
  const c = d.getElementById('c');
  const counts = renderOrders(d, c, orders.slice(0, 2), {});
  assert.deepEqual(counts, { orders: 2, items: 2 });
  assert.match(c.querySelector('.ptcg-total__figure').textContent, /Checking prices/);
  assert.match(c.querySelector('.ptcg-total__title').textContent, /these orders/);
  assert.match(c.querySelector('.orders-summary__facts').textContent, /^2 orders · 2 items · \$\d+\.\d\d spent including shipping and tax$/);
});

test('with prices in, the total is green or red and counts what it covers', () => {
  const d = doc();
  const c = d.getElementById('c');
  const results = Object.fromEntries(orders.slice(0, 2).map((o) => [itemKeyOf(o.items[0]), ok(o.items[0].paid * 0.5)]));
  renderOrders(d, c, orders.slice(0, 2), results);
  assert.match(c.querySelector('.ptcg-total').className, /ptcg-total--lower/);
  assert.match(c.querySelector('.ptcg-total__detail').textContent, /2 items counted/);
});

test('updateResult patches every matching row and both totals in place', () => {
  const d = doc();
  const c = d.getElementById('c');
  const shown = orders.slice(0, 2);
  const results = {};
  renderOrders(d, c, shown, results);
  const firstRow = c.querySelector('.oitem');
  results[laprasKey] = ok(9.32);
  updateResult(d, c, shown, laprasKey, results);
  assert.equal(c.querySelector('.oitem'), firstRow, 'the row element is kept, not redrawn');
  assert.equal(firstRow.querySelector('.ptcg-now__price').textContent, 'Ask $9.32');
  assert.match(c.querySelector('.order .order__change').className, /order__change--lower/);
  assert.match(c.querySelector('.ptcg-total').className, /ptcg-total--lower/);
  assert.equal(c.querySelectorAll('.orders-summary').length, 1);
});

test('the same card bought in two orders shares one lookup and both rows update', () => {
  const a = structuredClone(orders[0]);
  const b = structuredClone(orders[0]);
  b.orderNumber = 'OTHER-2';
  const d = doc();
  const c = d.getElementById('c');
  const results = {};
  renderOrders(d, c, [a, b], results);
  results[laprasKey] = ok(9.32);
  updateResult(d, c, [a, b], laprasKey, results);
  assert.equal(c.querySelectorAll('.ptcg-now__price').length, 2);
});

test('linesFor: unlookable items count as missing, not as loading', () => {
  const o = structuredClone(orders[0]);
  o.items[0].productId = null;
  assert.deepEqual(linesFor([o], {})[0].result, { status: 'unavailable' });
  assert.equal(linesFor([orders[0]], {})[0].result, null);
});

test('an empty list renders nothing, not an empty summary', () => {
  const d = doc();
  const c = d.getElementById('c');
  assert.deepEqual(renderOrders(d, c, [], {}), { orders: 0, items: 0 });
  assert.equal(c.children.length, 0);
});

test('an order with no items says so', () => {
  const o = structuredClone(orders[0]);
  o.items = [];
  assert.match(renderOrder(doc(), o).textContent, /No items were read/);
});

test('notices: signed out offers the TCGplayer page, empty explains where orders come from', () => {
  const d = doc();
  const signedOut = renderNotice(d, 'signed-out');
  assert.match(signedOut.textContent, /Sign in to TCGplayer/);
  assert.equal(signedOut.querySelector('a').getAttribute('href'), 'https://store.tcgplayer.com/myaccount/orderhistory');
  assert.match(renderNotice(d, 'empty').textContent, /No orders saved yet/);
  assert.equal(renderNotice(d, 'empty-range', { range: '2025' }).textContent, 'No saved orders for 2025.');
});

test('in the view, an item\'s price shows shipping and how old it is', () => {
  const li = renderOrder(doc(), orders[0], { [laprasKey]: { ...ok(9.32), shipping: 1.49, seller: 'Xerneas', checkedAt: Date.now() } }).querySelector('.oitem');
  const lines = [...li.querySelectorAll('.ptcg-now__detail')].map((e) => e.textContent);
  assert.deepEqual(lines, ['$9.32 + $1.49 shipping', 'Xerneas · checked just now']);
});

test('what was paid includes the order\'s shipping, shown with its breakdown', () => {
  const mewOrder = orders.find((o) => o.items[0].name === 'Mew');
  const li = renderOrder(doc(), mewOrder).querySelector('.oitem');
  assert.equal(li.querySelector('.oitem__paid-price').textContent, '$2.39');
  assert.equal(li.querySelector('.oitem__paid-detail').textContent, '$0.90 + $1.49 shipping');
});

test('with free shipping the price paid is just the item price', () => {
  const li = renderOrder(doc(), orders[0]).querySelector('.oitem');
  assert.equal(li.querySelector('.oitem__paid-price').textContent, '$13.99');
  assert.equal(li.querySelector('.oitem__paid-detail').textContent, '$13.99, no shipping');
});

test('gain or loss compares price plus shipping on both sides', () => {
  const mewOrder = orders.find((o) => o.items[0].name === 'Mew');
  const key = itemKeyOf(mewOrder.items[0]);
  // Paid $0.90 + $1.49 = $2.39. Today $0.50 + $0.99 = $1.49.
  const results = { [key]: { status: 'ok', price: 0.5, shipping: 0.99, count: 3, seller: 's', checkedAt: Date.now() } };
  const chip = renderOrderChange(doc(), mewOrder, results);
  assert.equal(chip.textContent, '▼ −$0.90 (−38%)');
  assert.match(chip.title, /Paid \$2\.39 with shipping; the same items' Ask is \$1\.49 with shipping/);
  const li = renderOrder(doc(), mewOrder, results).querySelector('.oitem');
  assert.equal(li.querySelector('.ptcg-now__price').textContent, 'Ask $1.49');
});

test('shipping is spread over a multi-item order in proportion to price', () => {
  const a = structuredClone(orders[0]);
  a.summary = { quantity: 2, subtotal: 30, shipping: 3, tax: 0, total: 33 };
  a.items = [{ ...a.items[0], paid: 10 }, { ...a.items[0], productId: '2', paid: 20 }];
  const lis = [...renderOrder(doc(), a).querySelectorAll('.oitem')];
  assert.equal(lis[0].querySelector('.oitem__paid-detail').textContent, '$10.00 + $1.00 shipping');
  assert.equal(lis[1].querySelector('.oitem__paid-detail').textContent, '$20.00 + $2.00 shipping');
});

test('describeSync: signed out offers the sign-in page, and no other outcome does', () => {
  const out = describeSync({ status: 'signed-out', count: 0 });
  assert.match(out.text, /not signed in to TCGplayer/);
  assert.equal(out.isError, true);
  assert.equal(out.signInUrl, 'https://www.tcgplayer.com/login/revalidate?returnUrl=/myaccount/orderhistory');
  for (const status of ['ok', 'partial', 'error']) {
    assert.equal(describeSync({ status, count: 1, error: 'x' }).signInUrl, undefined, status);
  }
});
