import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { renderLists, exportJson, itemSubtitle, priceSummary, askSummary, renderAsk, updateAsk } from '../src/lib/listsPageView.js';
import { emptyState, createList, addItem, setListSort } from '../src/lib/lists.js';
import { askKey } from '../src/lib/listsSort.js';

const doc = () => new JSDOM('<body><div id="lists"></div></body>').window.document;
const ITEM = {
  productId: '642621', language: 'English', name: 'Genesect ex', setName: 'SV: Black Bolt',
  number: '169/086', rarity: 'Special Illustration Rare',
  url: 'https://www.tcgplayer.com/product/642621/x', imageUrl: 'https://cdn/642621.jpg',
  priceAtSave: { market: 45.59, lowest: 40.18, condition: 'Near Mint Holofoil', asLowAs: 38 },
};

function populated() {
  const { state, list } = createList(emptyState(), 'Watchlist', { now: '2026-09-30T12:00:00.000Z' });
  return {
    state: addItem(state, list.id, ITEM, { now: '2026-09-30T12:05:00.000Z' }).state,
    listId: list.id,
  };
}

test('itemSubtitle reads as one line of card identity', () => {
  assert.equal(itemSubtitle(ITEM), 'SV: Black Bolt · 169/086 · Special Illustration Rare');
  assert.equal(itemSubtitle({ setName: 'Base Set' }), 'Base Set');
  assert.equal(itemSubtitle({}), '');
});

test('priceSummary states what the price was when it was saved', () => {
  assert.equal(priceSummary(ITEM.priceAtSave), 'Market $45.59 · lowest $40.18 (Near Mint Holofoil)');
  assert.equal(priceSummary({ market: 10, lowest: null, condition: '' }), 'Market $10.00');
  assert.equal(priceSummary(null), 'No price recorded');
});

test('renderLists draws each list with its items', () => {
  const d = doc();
  const { state } = populated();
  renderLists(d, d.getElementById('lists'), state, {});
  assert.equal(d.querySelectorAll('.list').length, 1);
  assert.match(d.querySelector('.list__name').textContent, /Watchlist/);
  const item = d.querySelector('.item');
  assert.match(item.textContent, /Genesect ex/);
  assert.match(item.textContent, /SV: Black Bolt · 169\/086/);
  assert.equal(item.querySelector('a').getAttribute('href'), ITEM.url);
  assert.equal(item.querySelector('a').getAttribute('rel'), 'noopener noreferrer');
  // Built from the product id, which always exists; the saved picture is only a fallback.
  assert.equal(item.querySelector('img').getAttribute('src'), 'https://tcgplayer-cdn.tcgplayer.com/product/642621_in_200x200.jpg');
});

test('renderLists escapes names that came from a web page', () => {
  const d = doc();
  const { state, listId } = populated();
  const nasty = addItem(state, listId, { ...ITEM, productId: '9', name: '<img src=x onerror=alert(1)>' }).state;
  renderLists(d, d.getElementById('lists'), nasty, {});
  assert.equal(d.querySelectorAll('.item img[onerror]').length, 0);
  assert.match(d.querySelector('.item__name').textContent, /<img src=x/);
});

test('renderLists says so when there is nothing saved yet', () => {
  const d = doc();
  renderLists(d, d.getElementById('lists'), emptyState(), {});
  assert.match(d.getElementById('lists').textContent, /No lists yet/i);
});

test('renderLists shows an empty list as empty, not as missing', () => {
  const d = doc();
  const { state } = createList(emptyState(), 'Trades');
  renderLists(d, d.getElementById('lists'), state, {});
  assert.equal(d.querySelectorAll('.list').length, 1);
  assert.match(d.querySelector('.list__empty').textContent, /Nothing saved/i);
});

test('the remove, rename and delete controls call back with the right ids', () => {
  const d = doc();
  const { state, listId } = populated();
  const calls = [];
  renderLists(d, d.getElementById('lists'), state, {
    onRemoveItem: (l, k) => calls.push(['remove', l, k]),
    onRenameList: (l) => calls.push(['rename', l]),
    onDeleteList: (l) => calls.push(['delete', l]),
  });
  d.querySelector('.item__remove').click();
  d.querySelector('.list__rename').click();
  d.querySelector('.list__delete').click();
  assert.deepEqual(calls, [
    ['remove', listId, '642621:english'],
    ['rename', listId],
    ['delete', listId],
  ]);
});

test('exportJson produces readable, re-importable data', () => {
  const { state } = populated();
  const parsed = JSON.parse(exportJson(state));
  assert.equal(parsed.lists[0].name, 'Watchlist');
  assert.equal(parsed.lists[0].items[0].productId, '642621');
  assert.ok(exportJson(state).includes('\n'), 'pretty-printed so it can be read');
});

// ---- price trend -----------------------------------------------------------
import { formatChange, trendSummary, trendTooltip, renderTrend, updateTrend } from '../src/lib/listsPageView.js';

const DOWN = {
  direction: 'down', pct: -0.1589, windowDays: 7, reason: 'ok',
  recent: { median: 73.62, days: 7, sales: 270 }, prior: { median: 87.53, days: 7, sales: 197 },
  series: [{ date: '2026-09-20', price: 87.5 }, { date: '2026-09-25', price: 81.4 }, { date: '2026-09-30', price: 72.9 }],
  outliersHidden: 2, sku: { skuId: '9465652', condition: 'Near Mint', variant: 'Holofoil' },
};
const UP = { ...DOWN, direction: 'up', pct: 0.2 };
const FLAT = { ...DOWN, direction: 'flat', pct: -0.005, windowDays: 14, outliersHidden: 0 };
const THIN = { direction: 'unknown', pct: null, reason: 'not-enough-sales', series: [], outliersHidden: 0 };
const GONE = { direction: 'unknown', pct: null, reason: 'unavailable', series: [], outliersHidden: 0 };

test('formatChange shows a signed percentage, finer for small moves', () => {
  assert.equal(formatChange(-0.1589), '−16%');
  assert.equal(formatChange(0.2), '+20%');
  assert.equal(formatChange(-0.005), '−0.5%');
  assert.equal(formatChange(0.031), '+3.1%');
  assert.equal(formatChange(0), '0.0%');
  assert.equal(formatChange(null), '');
});

test('trendSummary is what the cell says, per state', () => {
  assert.equal(trendSummary(DOWN), '▼ −16%');
  assert.equal(trendSummary(UP), '▲ +20%');
  assert.equal(trendSummary(FLAT), '▬ Flat (−0.5%)');
  assert.equal(trendSummary(THIN), 'Not enough recent sales');
  assert.equal(trendSummary(GONE), 'Trend unavailable');
});

test('trendTooltip shows the working behind the arrow', () => {
  const tip = trendTooltip(DOWN);
  assert.match(tip, /\$73\.62 over the last 7 days/);
  assert.match(tip, /\$87\.53 the 7 days before/);
  assert.match(tip, /270 and 197 sales/);
  assert.match(tip, /Near Mint Holofoil/);
  assert.match(tip, /2 outlier days left out of the chart/);
  assert.doesNotMatch(trendTooltip(FLAT), /outlier/);
  assert.match(trendTooltip(THIN), /at least 5 sales/i);
});

test('renderTrend gives each state a class, an accessible name, and only draws a line when there is one', () => {
  const d = doc();
  const down = renderTrend(d, DOWN);
  assert.match(down.className, /trend--down/);
  assert.match(down.getAttribute('aria-label'), /trending down 16% over the last 7 days/i);
  assert.ok(down.querySelector('svg.sparkline'));
  assert.match(down.querySelector('.trend__label').textContent, /vs previous 7 days/);

  assert.match(renderTrend(d, UP).className, /trend--up/);
  assert.match(renderTrend(d, FLAT).className, /trend--flat/);
  assert.equal(renderTrend(d, FLAT).querySelector('.trend__label').textContent, 'vs previous 14 days');

  const thin = renderTrend(d, THIN);
  assert.match(thin.className, /trend--unknown/);
  assert.equal(thin.querySelector('svg'), null);
  assert.match(renderTrend(d, GONE).textContent, /Trend unavailable/);
});

test('renderTrend has a loading state', () => {
  const el = renderTrend(doc(), null);
  assert.match(el.className, /trend--loading/);
  assert.match(el.textContent, /Checking trend/);
});

test('rising is green and falling is red, from the shared tokens, and flat is neither', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile('src/home/lists.css', 'utf8');
  const home = await readFile('src/home/home.css', 'utf8');
  const colour = (selector) => (css.match(new RegExp(`\\.${selector}[^{]*\\{([^}]*)\\}`)) || [])[1]?.match(/(?:^|;|\s)color:\s*([^;]+)/)?.[1].trim();
  assert.equal(colour('trend--up'), 'var(--gain)');
  assert.equal(colour('trend--down'), 'var(--loss)');
  assert.equal(colour('trend--flat'), undefined, 'flat keeps the soft grey of .trend');
  // The tokens exist for light and dark, and are different colours.
  const tokens = [...home.matchAll(/--(gain|loss):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]]);
  assert.equal(tokens.length, 4, 'gain and loss, in light and in dark');
  assert.notEqual(tokens.find((t) => t[0] === 'gain')[1], tokens.find((t) => t[0] === 'loss')[1]);
  assert.doesNotMatch(css, /\.trend--(up|down)[^{]*\{[^}]*var\(--accent\)/, 'the green accent must not colour a falling price');
});

test('renderLists adds no trend cells unless it is given a trends map', () => {
  const d = doc();
  renderLists(d, d.getElementById('lists'), populated().state, {});
  assert.equal(d.querySelectorAll('.item__trend').length, 0);
});

test('with a trends map, each item shows its state, and loading until it has one', () => {
  const d = doc();
  const { state } = populated();
  renderLists(d, d.getElementById('lists'), state, {}, {});
  assert.match(d.querySelector('.item__trend .trend').className, /trend--loading/);

  renderLists(d, d.getElementById('lists'), state, {}, { '642621:english': DOWN });
  assert.match(d.querySelector('.item__trend .trend').className, /trend--down/);
});

test('updateTrend patches one row in place without redrawing the rest', () => {
  const d = doc();
  const { state } = populated();
  const container = d.getElementById('lists');
  renderLists(d, container, state, {}, {});
  const before = container.querySelector('.item');

  assert.equal(updateTrend(container, '642621:english', UP), true);
  assert.equal(container.querySelector('.item'), before, 'the row itself is the same element');
  assert.match(container.querySelector('.item__trend .trend').className, /trend--up/);
  assert.equal(updateTrend(container, 'no:such', UP), false);
});

test('items expose their key so updates can find them', () => {
  const d = doc();
  renderLists(d, d.getElementById('lists'), populated().state, {}, {});
  assert.equal(d.querySelector('.item').getAttribute('data-key'), '642621:english');
});

/** Draws each list into its own box inside one wrapper, as if both were on screen. */
function bothLists(d, state, trends, asks) {
  const root = d.createElement('div');
  for (const list of state.lists) {
    const box = d.createElement('div');
    root.append(box);
    renderLists(d, box, state, {}, trends, asks, { selectedId: list.id });
  }
  return root;
}

test('a card saved in two lists updates in both places', () => {
  const d = doc();
  const { state } = populated();
  const second = createList(state, 'Trades');
  const both = addItem(second.state, second.list.id, ITEM).state;
  const container = bothLists(d, both, {});

  assert.equal(updateTrend(container, '642621:english', DOWN), true);
  const cells = [...container.querySelectorAll('.item__trend .trend')];
  assert.equal(cells.length, 2);
  assert.ok(cells.every((c) => /trend--down/.test(c.className)), 'neither row is left on "checking"');
});

// ---- a trend that is already turning ------------------------------------------

const FADED_SPIKE = {
  ...UP, pct: 0.5, turning: 'down', latest: { median: 75.13, days: 3 },
  recent: { median: 112.82, days: 7, sales: 257 }, prior: { median: 75.26, days: 7, sales: 384 },
};

test('a trend that is already reversing says so beneath the arrow', () => {
  const d = doc();
  const el = renderTrend(d, FADED_SPIKE);
  assert.equal(el.querySelector('.trend__summary').textContent, '▲ +50%', 'the headline is still the week-on-week move');
  assert.equal(el.querySelector('.trend__note').textContent, 'but falling in the last 3 days');
  assert.equal(el.getAttribute('data-turning'), 'down');

  const bounce = renderTrend(d, { ...DOWN, turning: 'up', latest: { median: 80, days: 3 } });
  assert.equal(bounce.querySelector('.trend__note').textContent, 'but rising in the last 3 days');
});

test('the tooltip gives the recent-days price behind the warning', () => {
  assert.match(trendTooltip(FADED_SPIKE), /last 3 days sold around \$75\.13/);
});

test('an ordinary trend carries no note', () => {
  const el = renderTrend(doc(), { ...DOWN, turning: null });
  assert.equal(el.querySelector('.trend__note'), null);
  assert.equal(el.hasAttribute('data-turning'), false);
  assert.doesNotMatch(trendTooltip(DOWN), /last 3 days sold/);
});

test('the screen-reader label includes the reversal', () => {
  assert.match(renderTrend(doc(), FADED_SPIKE).getAttribute('aria-label'), /but falling in the last 3 days/);
});

test('an item saved with no picture still shows one', () => {
  const d = doc();
  const { state } = populated();
  state.lists[0].items[0].imageUrl = '';
  renderLists(d, d.getElementById('lists'), state, {});
  assert.match(d.querySelector('.item img').getAttribute('src'), /product\/642621_in_200x200\.jpg$/);
});

test('an item whose reliable picture fails falls back to the one saved with it, then hides', () => {
  const d = doc();
  const { state } = populated();
  renderLists(d, d.getElementById('lists'), state, {});
  const img = d.querySelector('.item img');
  img.dispatchEvent(new d.defaultView.Event('error'));
  assert.equal(img.getAttribute('src'), 'https://cdn/642621.jpg');
  img.dispatchEvent(new d.defaultView.Event('error'));
  assert.equal(img.hidden, true);
});

test('a trend shows recent sales (not TCGplayer\'s Market Price) and volatility', () => {
  const series = [10, 11, 10, 11, 10, 11].map((price, i) => ({ date: `2026-09-0${i + 1}`, price }));
  const el = renderTrend(doc(), { direction: 'flat', pct: 0, windowDays: 7, recent: { median: 10.5, sales: 9 }, prior: { median: 10.5, sales: 9 },
    latest: { median: 10.5, days: 3 }, turning: null, series, outliersHidden: 0, reason: 'ok', sku: null });
  assert.equal(el.querySelector('.trend__stat--sales').textContent, 'Recent sales $10.50');
  assert.equal(el.querySelector('.trend__stat--market'), null, 'it is not called Market: that is TCGplayer\'s own figure');
  assert.match(el.querySelector('.trend__stat--volatility').textContent, /^±9\.6% a day$/);
});

test('volatility reads in whole percent once it is big, and is left out with too few sale-days', () => {
  const wild = [10, 14, 9, 15, 8].map((price, i) => ({ date: `2026-09-0${i + 1}`, price }));
  const big = renderTrend(doc(), { direction: 'unknown', reason: 'not-enough-sales', series: wild, latest: null });
  assert.match(big.querySelector('.trend__stat--volatility').textContent, /^±\d\d% a day$/);
  const thin = renderTrend(doc(), { direction: 'unknown', reason: 'not-enough-sales', series: wild.slice(0, 3), latest: null });
  assert.equal(thin.querySelector('.trend__stat--volatility'), null);
  assert.ok(thin.querySelector('.trend__stat--sales'), 'the recent sales figure still shows');
});

test('no stats while loading or when there is nothing to show', () => {
  assert.equal(renderTrend(doc(), null).querySelectorAll('.trend__stat').length, 0);
  assert.equal(renderTrend(doc(), { direction: 'unknown', reason: 'unavailable', series: [], latest: null }).querySelectorAll('.trend__stat').length, 0);
});

// ---- sorting belongs to each list -------------------------------------------------

const cardsIn = (d, n) => [...d.querySelectorAll('.list')[n].querySelectorAll('.item__name')].map((a) => a.textContent);

function twoListsOfCards() {
  let state = createList(emptyState(), 'Watching', { now: '2026-09-30T12:00:00.000Z' }).state;
  state = createList(state, 'Buy', { now: '2026-09-30T12:00:01.000Z' }).state;
  const [w, b] = state.lists.map((l) => l.id);
  const card = (id, name, min) => ({ ...ITEM, productId: id, name, url: `https://www.tcgplayer.com/product/${id}/x` });
  let n = 0;
  const add = (id, cardId, name) => { state = addItem(state, id, card(cardId, name), { now: `2026-09-30T12:0${n += 1}:00.000Z` }).state; };
  add(w, '1', 'First'); add(w, '2', 'Second'); add(w, '3', 'Third');
  add(b, '1', 'First'); add(b, '2', 'Second');
  return { state, w, b };
}

test('each list with more than one card has its own sort control, set to that list\'s sort', () => {
  const { state, w, b } = twoListsOfCards();
  const d = doc();
  const show = (st, id) => renderLists(d, d.getElementById('lists'), st, {}, undefined, undefined, { selectedId: id });
  show(state, w);
  assert.equal(d.querySelectorAll('.list__sort-select').length, 1, 'only the list on show');
  assert.equal(d.querySelector('.list__sort-select').value, 'added');
  assert.equal(d.querySelector('.list__sort-select').getAttribute('aria-label'), 'Sort Watching by');
  show(state, b);
  assert.equal(d.querySelector('.list__sort-select').getAttribute('aria-label'), 'Sort Buy by');
  const sorted = setListSort(state, w, { key: 'ask', dir: 'asc' });
  show(sorted, w);
  assert.equal(d.querySelector('.list__sort-select').value, 'ask');
  assert.equal(d.querySelector('.list__sort-direction').textContent, 'Lowest first');
  show(sorted, b);
  assert.equal(d.querySelector('.list__sort-select').value, 'added');
});

test('a list with one card, or none, has no sort control', () => {
  const d = doc();
  renderLists(d, d.getElementById('lists'), populated().state, {});
  assert.equal(d.querySelector('.list__sort'), null);
  const empty = createList(emptyState(), 'Empty').state;
  renderLists(d, d.getElementById('lists'), empty, {});
  assert.equal(d.querySelector('.list__sort'), null);
});

test('items are ordered by their own list\'s sort: newest first by default, and only that list changes', () => {
  const { state, w, b } = twoListsOfCards();
  const d = doc();
  const show = (st, id) => renderLists(d, d.getElementById('lists'), st, {}, undefined, undefined, { selectedId: id });
  show(state, w);
  assert.deepEqual(cardsIn(d, 0), ['Third', 'Second', 'First']);
  show(state, b);
  assert.deepEqual(cardsIn(d, 0), ['Second', 'First']);
  const sorted = setListSort(state, w, { key: 'added', dir: 'asc' });
  show(sorted, w);
  assert.deepEqual(cardsIn(d, 0), ['First', 'Second', 'Third']);
  show(sorted, b);
  assert.deepEqual(cardsIn(d, 0), ['Second', 'First'], 'the other list is unchanged');
});

test('sorting by ask uses the asks passed in, price plus shipping', () => {
  const { state, w } = twoListsOfCards();
  const nm = 'Near Mint Holofoil';
  const askFor = (id, price, shipping) => [askKey({ productId: id, priceAtSave: { condition: nm } }), { status: 'ok', price, shipping, seller: 's', count: 4 }];
  const asks = Object.fromEntries([askFor('1', 5, 0), askFor('2', 40, 2), askFor('3', 20, 0)]);
  const d = doc();
  renderLists(d, d.getElementById('lists'), setListSort(state, w, { key: 'ask', dir: 'desc' }), {}, undefined, asks);
  assert.deepEqual(cardsIn(d, 0), ['Second', 'Third', 'First']);
});

test('the controls call the list\'s handlers with that list\'s id', () => {
  const { state, w, b } = twoListsOfCards();
  const calls = [];
  const d = doc();
  const handlers = {
    onSortChange: (...args) => calls.push(['change', ...args]),
    onSortDirection: (...args) => calls.push(['direction', ...args]),
  };
  renderLists(d, d.getElementById('lists'), state, handlers, undefined, undefined, { selectedId: b });
  const select = d.querySelector('.list__sort-select');
  select.value = 'volatility';
  select.dispatchEvent(new d.defaultView.Event('change'));
  renderLists(d, d.getElementById('lists'), state, handlers, undefined, undefined, { selectedId: w });
  d.querySelector('.list__sort-direction').click();
  assert.deepEqual(calls, [['change', b, 'volatility', 'desc'], ['direction', w]]);
});

test('the controls are harmless without handlers', () => {
  const { state } = twoListsOfCards();
  const d = doc();
  renderLists(d, d.getElementById('lists'), state, {});
  d.querySelector('.list__sort-direction').click();
  const select = d.querySelector('.list__sort-select');
  select.dispatchEvent(new d.defaultView.Event('change'));
});

test('sorting never changes the saved list order in the state it was given', () => {
  const { state } = twoListsOfCards();
  const before = state.lists[0].items.map((i) => i.name);
  renderLists(doc(), doc().getElementById('lists'), state, {});
  assert.deepEqual(state.lists[0].items.map((i) => i.name), before);
});

// ---- ask: what it costs to buy today --------------------------------------

const NM = 'Near Mint Holofoil';
const okAsk = (price, shipping, extra = {}) => ({ status: 'ok', price, shipping, seller: 'EmeraldElsya', count: 182, ...extra });

test('the ask reads as price plus shipping, with the breakdown', () => {
  assert.equal(askSummary(okAsk(9.5, 0.99)), 'Ask $10.49 ($9.50 + $0.99 shipping)');
  assert.equal(askSummary(okAsk(9.5, 0)), 'Ask $9.50 ($9.50, free shipping)');
});

test('the ask says so while loading, when nothing is listed, and when it could not be read', () => {
  assert.equal(askSummary(null), 'Checking ask…');
  assert.equal(askSummary({ status: 'none' }), 'Ask: none listed');
  assert.equal(askSummary({ status: 'unavailable' }), 'Ask unavailable');
  assert.equal(askSummary({ status: 'ok' }), 'Ask unavailable', 'an ok result with no price is not shown as a price');
});

test('the ask is not TCGplayer\'s Market Price, and its tooltip says so', () => {
  const node = renderAsk(doc(), okAsk(9.5, 0.99));
  assert.match(node.getAttribute('title'), /cheapest live listing/);
  assert.match(node.getAttribute('title'), /EmeraldElsya/);
  assert.match(node.getAttribute('title'), /unlike TCGplayer’s Market Price/);
});

test('an item\'s detail shows Market (as saved) and then Ask, in that order', () => {
  const d = doc();
  const { state } = populated();
  const asks = { [askKey(ITEM)]: okAsk(9.5, 0.99) };
  renderLists(d, d.getElementById('lists'), state, {}, {}, asks);
  const line = d.querySelector('.item__price');
  assert.equal(line.textContent, 'Market $45.59 · Ask $10.49 ($9.50 + $0.99 shipping)');
  const parts = [...line.children].map((c) => c.className);
  assert.deepEqual(parts, ['item__market', 'item__ask item__ask--ok']);
  assert.match(line.querySelector('.item__market').getAttribute('title'), /Market Price when you saved it\. Market \$45\.59 · lowest \$40\.18/);
});

test('without asks, the detail is just what was recorded when the item was saved', () => {
  const d = doc();
  renderLists(d, d.getElementById('lists'), populated().state, {});
  assert.equal(d.querySelector('.item__price').textContent, 'Market $45.59 · lowest $40.18 (Near Mint Holofoil)');
  assert.equal(d.querySelector('.item__ask'), null);
});

test('an item saved with no Market price still shows its Ask', () => {
  const d = doc();
  const { state } = populated();
  state.lists[0].items[0].priceAtSave = { market: null, lowest: null, condition: NM };
  renderLists(d, d.getElementById('lists'), state, {}, {}, {});
  assert.equal(d.querySelector('.item__price').textContent, 'Checking ask…');
});

test('every row starts on "checking" and is updated in place when its ask arrives', () => {
  const d = doc();
  const { state } = populated();
  const container = d.getElementById('lists');
  renderLists(d, container, state, {}, {}, {});
  assert.match(d.querySelector('.item__ask').className, /item__ask--loading/);
  const row = d.querySelector('.item');
  assert.equal(updateAsk(container, askKey(ITEM), okAsk(9.5, 0.99)), true);
  assert.equal(d.querySelector('.item'), row, 'the row is kept, not redrawn');
  assert.equal(d.querySelector('.item__ask').textContent, 'Ask $10.49 ($9.50 + $0.99 shipping)');
  assert.equal(updateAsk(container, 'no-such-key', okAsk(1, 0)), false);
});

test('a card held in two lists updates in both', () => {
  let { state } = populated();
  const second = createList(state, 'Buy', { now: '2026-09-30T13:00:00.000Z' });
  state = addItem(second.state, second.list.id, ITEM, { now: '2026-09-30T13:01:00.000Z' }).state;
  const d = doc();
  const container = bothLists(d, state, {}, {});
  assert.equal(updateAsk(container, askKey(ITEM), okAsk(9.5, 0.99)), true);
  assert.equal(container.querySelectorAll('.item__ask--ok').length, 2);
});

test('a different condition of the same card has its own ask', () => {
  const lp = { ...ITEM, priceAtSave: { ...ITEM.priceAtSave, condition: 'Lightly Played Holofoil' } };
  assert.notEqual(askKey(ITEM), askKey(lp));
});

// ---- choosing a list and paging through it -----------------------------------

function manyCards(n, listName = 'Big') {
  let { state, list } = createList(emptyState(), listName, { now: '2026-09-30T12:00:00.000Z' });
  for (let i = 1; i <= n; i += 1) {
    const stamp = `2026-09-30T12:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`;
    state = addItem(state, list.id, { ...ITEM, productId: String(1000 + i), name: `Card ${i}`, language: 'English' }, { now: stamp }).state;
  }
  return { state, id: list.id };
}
const names = (d) => [...d.querySelectorAll('.item__name')].map((a) => a.textContent);
const showView = (d, state, view, handlers = {}) => renderLists(d, d.getElementById('lists'), state, handlers, undefined, undefined, view);

test('a dropdown names every list with its count, and only the chosen list is drawn', () => {
  const { state, w, b } = twoListsOfCards();
  const d = doc();
  showView(d, state, { selectedId: b });
  const options = [...d.querySelectorAll('.lists-toolbar__list option')];
  assert.deepEqual(options.map((o) => o.textContent), ['Watching (3)', 'Buy (2)']);
  assert.deepEqual(options.map((o) => o.value), [w, b]);
  assert.equal(d.querySelector('.lists-toolbar__list').value, b);
  assert.equal(d.querySelectorAll('.list').length, 1);
  assert.equal(d.querySelector('.list__name').textContent, 'Buy');
});

test('the first list is shown when none is chosen or the chosen one is gone', () => {
  const { state } = twoListsOfCards();
  for (const selectedId of [undefined, 'gone']) {
    const d = doc();
    showView(d, state, { selectedId });
    assert.equal(d.querySelector('.list__name').textContent, 'Watching');
  }
});

test('list names go in as text, not markup', () => {
  const d = doc();
  const nasty = createList(emptyState(), '<img src=x onerror=alert(1)>').state;
  showView(d, nasty, {});
  assert.equal(d.querySelector('.lists-toolbar img'), null);
  assert.match(d.querySelector('.lists-toolbar__list option').textContent, /<img src=x/);
});

test('choosing a list asks for it by id', () => {
  const { state, b } = twoListsOfCards();
  const d = doc();
  const chosen = [];
  showView(d, state, {}, { onSelectList: (id) => chosen.push(id) });
  const select = d.querySelector('.lists-toolbar__list');
  select.value = b;
  select.dispatchEvent(new d.defaultView.Event('change'));
  assert.deepEqual(chosen, [b]);
});

test('the page size offers 25, 50, 75 and All, showing the one in use', () => {
  const { state } = twoListsOfCards();
  const d = doc();
  showView(d, state, { size: 50 });
  const options = [...d.querySelectorAll('.lists-toolbar__size option')];
  assert.deepEqual(options.map((o) => o.textContent), ['25', '50', '75', 'All']);
  assert.equal(d.querySelector('.lists-toolbar__size').value, '50');
  showView(d, state, {});
  assert.equal(d.querySelector('.lists-toolbar__size').value, '25', 'default');
});

test('choosing a page size passes it on as a number, or "all"', () => {
  const { state } = twoListsOfCards();
  const d = doc();
  const sizes = [];
  showView(d, state, {}, { onPageSize: (n) => sizes.push(n) });
  const select = d.querySelector('.lists-toolbar__size');
  for (const value of ['75', 'all']) {
    select.value = value;
    select.dispatchEvent(new d.defaultView.Event('change'));
  }
  assert.deepEqual(sizes, [75, 'all']);
});

test('a long list shows one page, newest first, with "Showing x–y of n" above and below', () => {
  const { state } = manyCards(60);
  const d = doc();
  showView(d, state, { size: 25, page: 1 });
  assert.equal(names(d).length, 25);
  assert.equal(names(d)[0], 'Card 60');
  assert.equal(names(d).at(-1), 'Card 36');
  const ranges = [...d.querySelectorAll('.pager__range')].map((r) => r.textContent);
  assert.deepEqual(ranges, ['Showing 1–25 of 60', 'Showing 1–25 of 60']);
  assert.equal(d.querySelector('.list__count').textContent, '60 items', 'the header still counts every card');
});

test('later pages continue the same order, and the last one is partial', () => {
  const { state } = manyCards(60);
  const d = doc();
  showView(d, state, { size: 25, page: 3 });
  assert.equal(names(d).length, 10);
  assert.equal(names(d)[0], 'Card 10');
  assert.equal(d.querySelector('.pager__range').textContent, 'Showing 51–60 of 60');
});

test('paging follows the list\'s sort, not the order the cards were saved in', () => {
  const { state, id } = manyCards(60);
  const asc = setListSort(state, id, { key: 'added', dir: 'asc' });
  const d = doc();
  showView(d, asc, { size: 25, page: 1 });
  assert.equal(names(d)[0], 'Card 1');
  showView(d, asc, { size: 25, page: 2 });
  assert.equal(names(d)[0], 'Card 26');
});

test('Previous and Next are disabled at the ends and ask for the neighbouring page', () => {
  const { state } = manyCards(60);
  const d = doc();
  const pages = [];
  const handlers = { onPage: (n) => pages.push(n) };
  showView(d, state, { size: 25, page: 1 }, handlers);
  assert.equal(d.querySelector('.pager__prev').disabled, true);
  assert.equal(d.querySelector('.pager__next').disabled, false);
  d.querySelector('.pager__next').click();
  showView(d, state, { size: 25, page: 2 }, handlers);
  d.querySelectorAll('.pager__prev')[1].click();
  showView(d, state, { size: 25, page: 3 }, handlers);
  assert.equal(d.querySelector('.pager__next').disabled, true);
  assert.deepEqual(pages, [2, 1]);
});

test('no pager when everything fits on one page, or when All is chosen', () => {
  const { state } = manyCards(60);
  const d = doc();
  showView(d, state, { size: 'all' });
  assert.equal(names(d).length, 60);
  assert.ok([...d.querySelectorAll('.pager')].every((p) => p.hidden));
  showView(d, manyCards(10).state, { size: 25 });
  assert.ok([...d.querySelectorAll('.pager')].every((p) => p.hidden));
});

test('a page number past the end shows the last page', () => {
  const { state } = manyCards(60);
  const d = doc();
  showView(d, state, { size: 25, page: 9 });
  assert.equal(d.querySelector('.pager__range').textContent, 'Showing 51–60 of 60');
});

// ---- while a lookup is being retried ------------------------------------------

const RETRYING = { retrying: true, retry: 1, retries: 4 };

test('a trend being retried reads as loading and says it is retrying', () => {
  assert.equal(trendSummary(RETRYING), 'Retrying (1 of 4)\u2026');
  assert.match(trendTooltip(RETRYING), /TCGplayer did not answer/);
  const box = renderTrend(doc(), RETRYING);
  assert.match(box.className, /trend--loading/);
  assert.equal(box.getAttribute('data-retrying'), '1');
  assert.equal(box.querySelector('.trend__summary').textContent, 'Retrying (1 of 4)\u2026');
  assert.equal(box.querySelector('.trend__label'), null, 'nothing is claimed about the trend');
  assert.equal(box.querySelector('.trend__stat'), null);
});

test('a trend that is merely loading is not marked as retrying', () => {
  const box = renderTrend(doc(), null);
  assert.equal(box.getAttribute('data-retrying'), null);
  assert.equal(box.querySelector('.trend__summary').textContent, 'Checking trend\u2026');
});

test('an ask being retried reads as loading and says it is retrying', () => {
  assert.equal(askSummary(RETRYING), 'Retrying (1 of 4)\u2026');
  const node = renderAsk(doc(), RETRYING);
  assert.match(node.className, /item__ask--loading/);
  assert.equal(node.getAttribute('data-retrying'), '1');
  assert.match(node.getAttribute('title'), /Trying again automatically/);
  assert.equal(renderAsk(doc(), null).getAttribute('data-retrying'), null);
});

test('a retrying state can be swapped in place, and replaced by the real answer', () => {
  const d = doc();
  const { state } = populated();
  const container = d.getElementById('lists');
  renderLists(d, container, state, {}, {}, {});
  assert.equal(updateTrend(container, '642621:english', RETRYING), true);
  assert.equal(container.querySelector('.item__trend .trend__summary').textContent, 'Retrying (1 of 4)\u2026');
  assert.equal(updateTrend(container, '642621:english', DOWN), true);
  assert.match(container.querySelector('.item__trend .trend').className, /trend--down/);
  assert.equal(container.querySelector('.item__trend [data-retrying]'), null);
  assert.equal(updateAsk(container, askKey(ITEM), RETRYING), true);
  assert.equal(container.querySelector('.item__ask').textContent, 'Retrying (1 of 4)\u2026');
});

test('sorting by volatility or ask does not break on a card still being retried', () => {
  const { state, w } = twoListsOfCards();
  const d = doc();
  const asks = { [askKey({ productId: '1', priceAtSave: { condition: 'Near Mint Holofoil' } })]: RETRYING };
  const trends = { '1:english': RETRYING };
  for (const key of ['ask', 'volatility']) {
    renderLists(d, d.getElementById('lists'), setListSort(state, w, { key, dir: 'desc' }), {}, trends, asks, { selectedId: w });
    assert.equal(d.querySelectorAll('.item').length, 3);
  }
});
