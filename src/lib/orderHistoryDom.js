/*
 * TCGPlayer+ — TCGplayer's "Order History" page.
 * Reads what was bought from the item tables, and adds today's price beneath
 * what was paid. Pure DOM in, DOM out, so it runs against saved pages in tests.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isRetrying, retryText, retryTitle } from './retryState.js';
import { formatMoney } from './money.js';
import { parseItemRow, parseSummary, productIdFromThumbnail } from './orderParse.js';
import { allocateShipping, landedNow, landedPaid } from './orderCost.js';
import { comparePrice, totalChange } from './priceCompare.js';
import { formatChange } from './listsPageView.js';

export { productIdFromThumbnail };

export const NOW_CLASS = 'ptcg-now';
const DONE_ATTR = 'data-ptcg-now';
const MINUS = '−';

/**
 * Match patterns cannot express "any slashes, any capitals", and TCGplayer
 * serves this page at `//myaccount/orderhistory` as well as `/MyAccount/OrderHistory`.
 */
export function isOrderHistoryPath(pathname) {
  return /^\/+myaccount\/+orderhistory\/*$/i.test(String(pathname || ''));
}

/**
 * Every purchased line on the page, with its row so the caller can annotate it and
 * its share of the order's shipping so the comparison can be price plus shipping.
 * @returns {{row: Element, productId: string|null, name: string, condition: string,
 *   paid: number|null, quantity: number, shippingShare: number}[]}
 */
export function parseOrderItems(doc) {
  const items = [];
  const wraps = [...doc.querySelectorAll('.orderWrap')];
  const seen = new Set();
  const collect = (rows, summary) => {
    const parsed = rows.map((row) => ({ row, item: parseItemRow(row) })).filter((p) => p.item);
    const shares = allocateShipping(summary, parsed.map((p) => p.item));
    parsed.forEach(({ row, item }, at) => {
      seen.add(row);
      items.push({ row, ...item, shippingShare: shares[at] });
    });
  };
  for (const wrap of wraps) collect([...wrap.querySelectorAll('table.orderTable tbody tr')], parseSummary(wrap));
  // Rows outside any order block (not expected) still get read, with no shipping.
  collect([...doc.querySelectorAll('table.orderTable tbody tr')].filter((r) => !seen.has(r)), null);
  return items;
}

const signed = (diff) => `${diff < 0 ? MINUS : '+'}${formatMoney(Math.abs(diff))}`;

/** Wording that says which way, and for whom: the reference is what *you* paid. */
export function comparisonSummary(comparison) {
  if (!comparison) return '';
  if (comparison.direction === 'same') return '▬ Same as you paid';
  const arrow = comparison.direction === 'higher' ? '▲' : '▼';
  return `${arrow} ${signed(comparison.diff)} (${formatChange(comparison.pct)})`;
}

/**
 * What to draw in a row, for each state the lookup can be in.
 * `result` is null while loading, else a listing lookup result.
 */
export function renderNow(doc, { paid, paidShipping = 0, result, detail = false, now = Date.now() }) {
  const box = doc.createElement('div');
  box.className = NOW_CLASS;

  const line = (className, text) => {
    const el = doc.createElement('div');
    el.className = className;
    el.textContent = text;
    box.append(el);
    return el;
  };

  if (!result) {
    box.classList.add(`${NOW_CLASS}--loading`);
    line(`${NOW_CLASS}__label`, 'Checking price…');
    return box;
  }
  if (isRetrying(result)) {
    // Still loading: TCGplayer did not answer and the request is being tried again.
    box.classList.add(`${NOW_CLASS}--loading`, `${NOW_CLASS}--retrying`);
    box.title = retryTitle(result);
    line(`${NOW_CLASS}__label`, retryText(result));
    return box;
  }
  if (result.status !== 'ok') {
    box.classList.add(`${NOW_CLASS}--unknown`);
    line(`${NOW_CLASS}__label`, result.status === 'none' ? 'No ask' : 'Price unavailable');
    if (result.status === 'none') box.title = 'No live listing matches this condition and printing right now.';
    return box;
  }

  // Both sides are price plus shipping: that is what it costs, and what it cost.
  const paidTotal = landedPaid(paid, paidShipping);
  const nowTotal = landedNow(result);
  const comparison = comparePrice(paidTotal, nowTotal);
  box.classList.add(`${NOW_CLASS}--${comparison ? comparison.direction : 'unknown'}`);
  line(`${NOW_CLASS}__price`, `Ask ${formatMoney(nowTotal)}`);
  if (comparison) line(`${NOW_CLASS}__change`, comparisonSummary(comparison));
  if (detail) {
    // What the product page's spotlight listing shows, so the two can be compared at a glance.
    line(`${NOW_CLASS}__detail`, result.shipping > 0
      ? `${formatMoney(result.price)} + ${formatMoney(result.shipping)} shipping` : `${formatMoney(result.price)}, free shipping`);
    const seller = [result.seller, formatChecked(result.checkedAt, now)].filter(Boolean).join(' \u00B7 ');
    if (seller) line(`${NOW_CLASS}__detail`, seller);
  }
  const shipping = result.shipping > 0 ? `${formatMoney(result.price)} + ${formatMoney(result.shipping)} shipping` : `${formatMoney(result.price)}, free shipping`;
  const paidNote = paidShipping > 0 ? `${formatMoney(paid)} + ${formatMoney(paidShipping)} shipping` : `${formatMoney(paid)}, no shipping`;
  box.title = `Lowest current listing in the same condition, price plus shipping: ${formatMoney(nowTotal)} (${shipping}), `
    + `from ${result.count || 'several'} listing${result.count === 1 ? '' : 's'}. `
    + `You paid ${formatMoney(paidTotal)} (${paidNote}).`;
  if (comparison) {
    const words = { higher: 'higher than', lower: 'lower than', same: 'about the same as' }[comparison.direction];
    box.setAttribute('aria-label', `Ask ${formatMoney(nowTotal)} with shipping, ${words} the ${formatMoney(paidTotal)} you paid with shipping`);
  }
  return box;
}

/** "checked 4 min ago": how old a price is, so a stale one is recognisable. */
export function formatChecked(checkedAt, now = Date.now()) {
  if (!Number.isFinite(checkedAt)) return '';
  const minutes = Math.max(0, Math.round((now - checkedAt) / 60000));
  if (minutes < 1) return 'checked just now';
  if (minutes < 60) return `checked ${minutes} min ago`;
  return `checked ${Math.round(minutes / 60)} h ago`;
}

/** Put (or replace) the "now" block under the price the row already shows. */
export function showNow(doc, item, result) {
  const cell = item.row.querySelector('td.orderHistoryPrice');
  if (!cell) return;
  cell.querySelectorAll(`.${NOW_CLASS}`).forEach((el) => el.remove());
  cell.append(renderNow(doc, { paid: item.paid, paidShipping: item.shippingShare || 0, result }));
  item.row.setAttribute(DONE_ATTR, result ? 'done' : 'pending');
}

/** Rows not yet touched (the page redraws its tables when the date range changes). */
export function isPending(row) {
  return !row.hasAttribute(DONE_ATTR);
}

// --- The total for the whole page ---------------------------------------

export const TOTAL_CLASS = 'ptcg-total';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param {{paid: number|null, quantity?: number, result: object|null}[]} lines every item on the page
 */
export function renderTotal(doc, lines, { title = 'Value of items on this page vs. what you paid' } = {}) {
  const box = doc.createElement('div');
  box.className = TOTAL_CLASS;
  const total = totalChange(lines);
  const text = (className, value) => {
    const el = doc.createElement('span');
    el.className = className;
    el.textContent = value;
    box.append(el);
  };

  text(`${TOTAL_CLASS}__title`, title);
  if (!total) {
    box.classList.add(`${TOTAL_CLASS}--unknown`);
    const waiting = lines.some((l) => !l.result || isRetrying(l.result));
    const retrying = lines.some((l) => isRetrying(l.result));
    text(`${TOTAL_CLASS}__figure`, retrying ? 'Checking prices\u2026 some are being retried' : waiting ? 'Checking prices\u2026' : 'No prices available');
    return box;
  }

  box.classList.add(`${TOTAL_CLASS}--${total.direction}`);
  text(`${TOTAL_CLASS}__figure`, comparisonSummary(total));
  const parts = [`paid ${formatMoney(total.paid)}, ask ${formatMoney(total.now)}`, `${plural(total.counted, 'item')} counted`];
  if (total.missing) parts.push(`${total.missing} without a price`);
  if (total.pending) parts.push(`${total.pending} still loading${total.retrying ? ` (${total.retrying} being retried)` : ''}`);
  text(`${TOTAL_CLASS}__detail`, parts.join(' \u00B7 '));
  box.title = 'Price plus shipping on both sides (tax excluded); your share of each order\u2019s shipping is spread by item price. "Ask" is the cheapest live listing in the same '
    + 'condition, with its shipping: what it costs to buy, not what you could sell it for, and not TCGplayer\u2019s Market Price.';
  return box;
}

/** Put (or replace) the total above the first order. */
export function showTotal(doc, lines) {
  doc.querySelectorAll(`.${TOTAL_CLASS}`).forEach((el) => el.remove());
  const firstOrder = doc.querySelector('.orderWrap') || doc.querySelector('table.orderTable');
  if (!firstOrder) return;
  firstOrder.parentNode.insertBefore(renderTotal(doc, lines), firstOrder);
}
