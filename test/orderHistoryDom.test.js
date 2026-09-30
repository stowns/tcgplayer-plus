import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  parseOrderItems, formatChecked, isOrderHistoryPath, renderTotal, showTotal, TOTAL_CLASS, productIdFromThumbnail, renderNow, showNow, isPending, comparisonSummary, NOW_CLASS,
} from '../src/lib/orderHistoryDom.js';
import { comparePrice } from '../src/lib/priceCompare.js';
import { orderPage, ORDERS } from './fixtures/orderHistoryFull.js';
import { ORDER_PAGE } from './fixtures/orderHistory.js';

const page = () => new JSDOM(ORDER_PAGE).window.document;
const ok = (price, extra = {}) => ({ status: 'ok', price, shipping: 1.49, seller: 'x', count: 10, ...extra });

test('every purchased line is read, across orders', () => {
  const items = parseOrderItems(page());
  assert.equal(items.length, 7);
  assert.deepEqual(items.map((i) => i.productId), ['696683', '714358', '693491', '624677', '680480', '684439', '654477']);
});

test('name, condition, price paid and quantity come from the row', () => {
  const [lapras] = parseOrderItems(page());
  assert.equal(lapras.name, 'Lapras - 131/128');
  assert.equal(lapras.condition, 'Near Mint Holofoil');
  assert.equal(lapras.paid, 13.99);
  assert.equal(lapras.quantity, 1);
});

test('a multi-item order gives each item its own price', () => {
  const paid = parseOrderItems(page()).slice(2).map((i) => i.paid);
  assert.deepEqual(paid, [5.61, 17.06, 6.36, 2.69, 20.96]);
});

test('the product id comes from the thumbnail, preferring the lazy-load attribute', () => {
  const doc = new JSDOM('<img data-original="https://x/product/696683_25w.jpg" src="placeholder.gif">').window.document;
  assert.equal(productIdFromThumbnail(doc.querySelector('img')), '696683');
  const onlySrc = new JSDOM('<img src="https://x/product/42_200w.jpg">').window.document;
  assert.equal(productIdFromThumbnail(onlySrc.querySelector('img')), '42');
});

test('a thumbnail with no product id, or the "0" placeholder image, gives null', () => {
  const doc = new JSDOM('<img src="a.gif"><img src="https://x/product/0_25w.jpg">').window.document;
  const [a, b] = doc.querySelectorAll('img');
  assert.equal(productIdFromThumbnail(a), null);
  assert.equal(productIdFromThumbnail(b), null);
  assert.equal(productIdFromThumbnail(null), null);
});

test('rows that lack a price cell (headers, shipping summaries) are ignored', () => {
  const doc = new JSDOM('<table class="orderTable"><tbody><tr><td>Shipping</td></tr></tbody></table>').window.document;
  assert.deepEqual(parseOrderItems(doc), []);
  assert.deepEqual(parseOrderItems(new JSDOM('<p>nothing</p>').window.document), []);
});

test('a quantity that is missing or nonsense counts as one, and an unreadable price is null', () => {
  const doc = new JSDOM(`<table class="orderTable"><tbody><tr>
    <td class="orderHistoryItems"><a title="X">X</a></td><td class="orderHistoryDetail"></td>
    <td class="orderHistoryPrice">n/a</td><td class="orderHistoryQuantity">?</td></tr></tbody></table>`).window.document;
  const [item] = parseOrderItems(doc);
  assert.equal(item.quantity, 1);
  assert.equal(item.paid, null);
  assert.equal(item.condition, '');
  assert.equal(item.productId, null);
});

test('summary wording says which way and by how much', () => {
  assert.equal(comparisonSummary(comparePrice(13.99, 9.32)), '▼ −$4.67 (−33%)');
  assert.equal(comparisonSummary(comparePrice(10, 12.5)), '▲ +$2.50 (+25%)');
  assert.equal(comparisonSummary(comparePrice(10, 10)), '▬ Same as you paid');
  assert.equal(comparisonSummary(null), '');
});

test('lower today: shows the price now, the change, and a direction class', () => {
  const box = renderNow(page(), { paid: 13.99, result: ok(9.32) });
  assert.match(box.className, /ptcg-now--lower/);
  // Price plus shipping: $9.32 + $1.49 = $10.81 against the $13.99 paid.
  assert.equal(box.querySelector('.ptcg-now__price').textContent, 'Ask $10.81');
  assert.equal(box.querySelector('.ptcg-now__change').textContent, '▼ −$3.18 (−23%)');
  assert.match(box.getAttribute('aria-label'), /lower than the \$13\.99 you paid/);
});

test('higher today', () => {
  const box = renderNow(page(), { paid: 10, result: ok(12.5) });
  assert.match(box.className, /ptcg-now--higher/);
  assert.equal(box.querySelector('.ptcg-now__change').textContent, '▲ +$3.99 (+40%)');
  assert.match(box.getAttribute('aria-label'), /higher than/);
});

test('about the same: no dollar figure is invented', () => {
  const box = renderNow(page(), { paid: 10, result: ok(8.51) }); // $8.51 + $1.49 shipping = $10.00
  assert.match(box.className, /ptcg-now--same/);
  assert.equal(box.querySelector('.ptcg-now__change').textContent, '▬ Same as you paid');
});

test('the tooltip gives shipping and how many listings back the number', () => {
  const free = renderNow(page(), { paid: 10, result: ok(9, { shipping: 0, count: 1 }) });
  assert.match(free.title, /free shipping/);
  assert.match(free.title, /1 listing\./);
  const paid = renderNow(page(), { paid: 10, result: ok(9, { shipping: 1.49, count: 205 }) });
  assert.match(paid.title, /\$9\.00 \+ \$1\.49 shipping/);
  assert.match(paid.title, /205 listings/);
});

test('loading, nothing for sale, and unavailable each say so and show no figures', () => {
  const doc = page();
  const loading = renderNow(doc, { paid: 10, result: null });
  assert.match(loading.className, /ptcg-now--loading/);
  assert.equal(loading.textContent, 'Checking price…');
  const none = renderNow(doc, { paid: 10, result: { status: 'none' } });
  assert.equal(none.textContent, 'No ask');
  assert.match(none.title, /No live listing/);
  const down = renderNow(doc, { paid: 10, result: { status: 'unavailable' } });
  assert.equal(down.textContent, 'Price unavailable');
  for (const b of [loading, none, down]) assert.doesNotMatch(b.textContent, /\$/);
});

test('an unreadable price paid still shows the current price, without a comparison', () => {
  const box = renderNow(page(), { paid: null, result: ok(9) });
  assert.match(box.className, /ptcg-now--unknown/);
  assert.equal(box.querySelector('.ptcg-now__change'), null);
  assert.equal(box.querySelector('.ptcg-now__price').textContent, 'Ask $10.49');
});

test('showNow puts the block under the price paid and replaces it on update', () => {
  const doc = page();
  const item = parseOrderItems(doc)[0];
  assert.equal(isPending(item.row), true);
  showNow(doc, item, null);
  assert.equal(isPending(item.row), false);
  showNow(doc, item, ok(9.32));
  const cell = item.row.querySelector('td.orderHistoryPrice');
  assert.equal(cell.querySelectorAll(`.${NOW_CLASS}`).length, 1);
  assert.ok(cell.firstChild.textContent.includes('$13.99'), 'what was paid is still shown');
  assert.equal(cell.querySelector('.ptcg-now__price').textContent, 'Ask $10.81');
});

test('text from the page is never interpreted as HTML', () => {
  const box = renderNow(page(), { paid: 10, result: ok(9, { seller: '<img src=x onerror=alert(1)>' }) });
  assert.equal(box.querySelector('img'), null);
});

test('the order history path matches however TCGplayer spells it', () => {
  for (const ok of ['/myaccount/orderhistory', '//myaccount/orderhistory', '/MyAccount/OrderHistory',
    '/myaccount/orderhistory/', '///MyAccount//OrderHistory']) assert.equal(isOrderHistoryPath(ok), true, ok);
  for (const no of ['/', '/myaccount', '/myaccount/messagecenter', '/myaccount/orderhistory/details',
    '/x/myaccount/orderhistory', '', null, undefined]) assert.equal(isOrderHistoryPath(no), false, String(no));
});

const line = (paid, result, quantity = 1) => ({ paid, quantity, result });

test('total: a loss is worded with direction, dollars and percent, and detail says what it covers', () => {
  const box = renderTotal(page(), [line(13.99, ok(9.32)), line(5.61, ok(4.16)), line(10, { status: 'none' }), line(10, null)]);
  assert.match(box.className, /ptcg-total--lower/);
  assert.equal(box.querySelector('.ptcg-total__figure').textContent, '▼ −$6.12 (−31%)');
  const detail = box.querySelector('.ptcg-total__detail').textContent;
  assert.match(detail, /paid \$19\.60, ask \$13\.48/);
  assert.match(detail, /2 items counted/);
  assert.match(detail, /1 without a price/);
  assert.match(detail, /1 still loading/);
});

test('total: a gain', () => {
  const box = renderTotal(page(), [line(10, ok(15), 2)]);
  assert.match(box.className, /ptcg-total--higher/);
  assert.equal(box.querySelector('.ptcg-total__figure').textContent, '▲ +$10.00 (+50%)');
  assert.match(box.querySelector('.ptcg-total__detail').textContent, /1 item counted/);
});

test('total: level, loading and nothing-priced states', () => {
  assert.match(renderTotal(page(), [line(100, ok(100.4))]).className, /ptcg-total--same/);
  const loading = renderTotal(page(), [line(10, null)]);
  assert.match(loading.className, /ptcg-total--unknown/);
  assert.equal(loading.querySelector('.ptcg-total__figure').textContent, 'Checking prices…');
  const none = renderTotal(page(), [line(10, { status: 'none' })]);
  assert.equal(none.querySelector('.ptcg-total__figure').textContent, 'No prices available');
});

test('showTotal places one total above the first order and replaces it on update', () => {
  const doc = page();
  showTotal(doc, [line(10, null)]);
  showTotal(doc, [line(10, ok(8))]);
  const totals = doc.querySelectorAll(`.${TOTAL_CLASS}`);
  assert.equal(totals.length, 1);
  assert.equal(totals[0].nextElementSibling, doc.querySelector('.orderWrap'));
  assert.match(totals[0].className, /ptcg-total--lower/);
});

test('showTotal does nothing on a page with no orders', () => {
  const doc = new JSDOM('<p>none</p>').window.document;
  showTotal(doc, [line(10, ok(8))]);
  assert.equal(doc.querySelectorAll(`.${TOTAL_CLASS}`).length, 0);
});

test('formatChecked says how old a price is', () => {
  const now = 10 * 3600000;
  assert.equal(formatChecked(now, now), 'checked just now');
  assert.equal(formatChecked(now - 4 * 60000, now), 'checked 4 min ago');
  assert.equal(formatChecked(now - 90 * 60000, now), 'checked 2 h ago');
  assert.equal(formatChecked(now + 5000, now), 'checked just now', 'a clock a little ahead is not "in the future"');
  for (const bad of [undefined, null, NaN, 'x']) assert.equal(formatChecked(bad, now), '');
});

test('the detail lines (view only) show shipping, seller and age, like the product page\'s featured listing', () => {
  const now = 10 * 3600000;
  const box = renderNow(page(), { paid: 13, result: { status: 'ok', price: 9.5, shipping: 0.99, seller: 'EmeraldElsya', count: 182, checkedAt: now - 180000 }, detail: true, now });
  const lines = [...box.querySelectorAll('.ptcg-now__detail')].map((e) => e.textContent);
  assert.deepEqual(lines, ['$9.50 + $0.99 shipping', 'EmeraldElsya · checked 3 min ago']);
  const free = renderNow(page(), { paid: 13, result: { status: 'ok', price: 9.5, shipping: 0, seller: '', checkedAt: now }, detail: true, now });
  assert.deepEqual([...free.querySelectorAll('.ptcg-now__detail')].map((e) => e.textContent), ['$9.50, free shipping', 'checked just now']);
});

test('the order page\'s narrow column gets no detail lines', () => {
  const box = renderNow(page(), { paid: 13, result: { status: 'ok', price: 9.5, shipping: 0.99, seller: 'X', count: 1, checkedAt: 0 } });
  assert.equal(box.querySelectorAll('.ptcg-now__detail').length, 0);
});

test('the price paid includes the order\'s shipping, and so does today\'s price', () => {
  // A $0.90 card that cost $1.49 to ship (the fixture's Mew) against $0.80 + $0.99 today.
  const paidWithShipping = renderNow(page(), { paid: 0.9, paidShipping: 1.49, result: ok(0.8, { shipping: 0.99 }) });
  assert.equal(paidWithShipping.querySelector('.ptcg-now__price').textContent, 'Ask $1.79');
  assert.equal(paidWithShipping.querySelector('.ptcg-now__change').textContent, '▼ −$0.60 (−25%)');
  assert.match(paidWithShipping.title, /You paid \$2\.39 \(\$0\.90 \+ \$1\.49 shipping\)/);
  assert.match(paidWithShipping.getAttribute('aria-label'), /\$2\.39 you paid with shipping/);
});

test('without shipping on the order, only the item price counts as paid', () => {
  const box = renderNow(page(), { paid: 13.99, paidShipping: 0, result: ok(9.32) });
  assert.match(box.title, /You paid \$13\.99 \(\$13\.99, no shipping\)/);
});

test('parseOrderItems gives each row its share of the order\'s shipping', () => {
  const items = parseOrderItems(new JSDOM(orderPage({ orders: ORDERS })).window.document);
  const mew = items.find((i) => i.name === 'Mew');
  assert.equal(mew.paid, 0.9);
  assert.equal(mew.shippingShare, 1.49, 'the only item in a $1.49 shipment carries all of it');
  const lapras = items.find((i) => i.name.startsWith('Lapras'));
  assert.equal(lapras.shippingShare, 0, 'free shipping adds nothing');
});

test('the total counts shipping on both sides', () => {
  const box = renderTotal(page(), [{ paid: 2.39, quantity: 1, result: { status: 'ok', price: 1.79 } }]);
  assert.match(box.querySelector('.ptcg-total__detail').textContent, /paid \$2\.39, ask \$1\.79/);
  assert.match(box.title, /Price plus shipping on both sides/);
});
