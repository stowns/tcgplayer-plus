/*
 * TCGPlayer+ — the Order History view, as DOM.
 * Pure functions from data to elements, so every state can be tested in jsdom.
 * Everything from the archive reaches the page through textContent or a checked
 * URL, never as markup.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { SIGN_IN_URL } from './orderSync.js';
import { formatMoney } from './money.js';
import { imageCandidates, loadFirstWorking } from './productImage.js';
import { totalChange } from './priceCompare.js';
import { listingCacheKey } from './listingLookup.js';
import { allocateShipping, costLine, landedPaid } from './orderCost.js';
import { renderNow, renderTotal, comparisonSummary } from './orderHistoryDom.js';
import { renderTrend } from './listsPageView.js';
import { trendCacheKey } from './trendLookup.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-09-27" -> "Sep 27, 2026" */
export function formatOrderDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return 'Date unknown';
  return `${MONTHS[Number(m[2]) - 1]} ${Number(m[3])}, ${m[1]}`;
}

const safeUrl = (url, { httpsOnly = false } = {}) => {
  try {
    const u = new URL(String(url));
    return (httpsOnly ? u.protocol === 'https:' : /^https?:$/.test(u.protocol)) ? u.href : '';
  } catch {
    return '';
  }
};

/**
 * Where to check an item's price: its TCGplayer product page, which shows the live
 * listings. Built from the product id, and falling back to the link the order
 * page carried when there is no id.
 */
export function productPageUrl(item) {
  if (/^\d+$/.test(String(item.productId ?? ''))) return `https://www.tcgplayer.com/product/${item.productId}`;
  return safeUrl(item.url);
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Key by which a purchased line's current price is looked up and shared. */
export const itemKeyOf = (item) => listingCacheKey({ productId: item.productId, condition: item.condition });

const lookupable = (item) => item.productId && Number.isFinite(item.paid);

/** What a trend is looked up (and cached) by: the card and its condition, however many orders hold it. '' if there is no product. */
export const trendKeyOf = (item) => (item.productId ? trendCacheKey({ productId: item.productId, condition: item.condition }) : '');

/** Lines for `totalChange`: each item, price plus shipping on both sides, with the answer we have if any. */
export function linesFor(orders, results) {
  return orders.flatMap((order) => {
    const shares = allocateShipping(order.summary, order.items);
    return order.items.map((item, at) => costLine(
      item,
      shares[at],
      // An item we cannot look up will never have an answer; it is "missing", not "pending".
      lookupable(item) ? results[itemKeyOf(item)] || null : { status: 'unavailable' },
    ));
  });
}

function renderItem(doc, item, results, share = 0, trends = {}) {
  const li = el(doc, 'li', 'oitem');
  li.setAttribute('data-key', lookupable(item) ? itemKeyOf(item) : '');
  const trendKey = trendKeyOf(item);
  if (trendKey) li.setAttribute('data-trend-key', trendKey);

  // The order page's own thumbnail is 25px wide; the 200px picture is sharper, with that as the fallback.
  const pictures = imageCandidates(item.productId, item.imageUrl);
  if (pictures.length) {
    const img = el(doc, 'img', 'oitem__image');
    img.alt = '';
    img.loading = 'lazy';
    loadFirstWorking(img, pictures);
    li.append(img);
  }

  const body = el(doc, 'div', 'oitem__body');
  const href = productPageUrl(item);
  if (href) {
    const a = el(doc, 'a', 'oitem__name', item.name);
    a.title = 'Open the product page on TCGplayer to check the current price';
    a.href = href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    body.append(a);
  } else {
    body.append(el(doc, 'span', 'oitem__name', item.name));
  }
  const meta = [item.setName, item.rarity, item.condition].filter(Boolean).join(' · ');
  if (meta) body.append(el(doc, 'p', 'oitem__meta', meta));
  if (item.seller) body.append(el(doc, 'p', 'oitem__seller', `Sold by ${item.seller.name}`));
  li.append(body);

  // Where its price has been going, the same picture the Watch Lists view draws.
  const trend = el(doc, 'div', 'oitem__trend');
  if (trendKey) trend.append(renderTrend(doc, trends[trendKey] || null));
  li.append(trend);

  // What it cost: the price, plus this item's share of the order's shipping.
  const paid = el(doc, 'div', 'oitem__paid');
  paid.append(el(doc, 'span', 'oitem__paid-price', Number.isFinite(item.paid) ? formatMoney(landedPaid(item.paid, share)) : '\u2014'));
  if (Number.isFinite(item.paid)) {
    paid.append(el(doc, 'span', 'oitem__paid-detail',
      share > 0 ? `${formatMoney(item.paid)} + ${formatMoney(share)} shipping` : `${formatMoney(item.paid)}, no shipping`));
  }
  if (item.quantity > 1) paid.append(el(doc, 'span', 'oitem__qty', `× ${item.quantity}`));
  li.append(paid);

  const now = el(doc, 'div', 'oitem__now');
  if (lookupable(item)) now.append(renderNow(doc, { paid: item.paid, paidShipping: share, result: results[itemKeyOf(item)] || null, detail: true }));
  li.append(now);
  return li;
}

/** The "worth vs paid" chip in an order's header. */
export function renderOrderChange(doc, order, results) {
  const total = totalChange(linesFor([order], results));
  const chip = el(doc, 'div', 'order__change');
  if (!total) {
    chip.classList.add('order__change--unknown');
    return chip;
  }
  chip.classList.add(`order__change--${total.direction}`);
  chip.textContent = comparisonSummary(total);
  chip.title = `Paid ${formatMoney(total.paid)} with shipping; the same items' Ask is ${formatMoney(total.now)} with shipping.`;
  return chip;
}

export function renderOrder(doc, order, results = {}, trends = {}) {
  const article = el(doc, 'article', 'order');
  article.setAttribute('data-order', order.orderNumber);

  const head = el(doc, 'header', 'order__head');
  const main = el(doc, 'div', 'order__main');
  main.append(el(doc, 'span', 'order__date', formatOrderDate(order.date)));
  main.append(el(doc, 'span', 'order__number',
    `${order.kind === 'direct' ? 'TCGplayer Direct #' : 'Order'} ${order.orderNumber}`));
  head.append(main);

  const who = el(doc, 'div', 'order__who');
  if (order.seller) {
    const href = safeUrl(order.seller.url);
    if (href) {
      const a = el(doc, 'a', 'order__seller', order.seller.name);
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      who.append(a);
    } else {
      who.append(el(doc, 'span', 'order__seller', order.seller.name));
    }
  }
  if (order.channel) who.append(el(doc, 'span', 'order__channel', order.channel));
  head.append(who);

  const ship = [order.shippingStatus, order.shippingMethod].filter(Boolean).join(' · ');
  if (ship) head.append(el(doc, 'div', 'order__ship', ship));
  head.append(renderOrderChange(doc, order, results));
  article.append(head);

  const list = el(doc, 'ul', 'oitem-list');
  const shares = allocateShipping(order.summary, order.items);
  order.items.forEach((item, at) => list.append(renderItem(doc, item, results, shares[at], trends)));
  if (!order.items.length) list.append(el(doc, 'li', 'oitem oitem--empty', 'No items were read for this order.'));
  article.append(list);

  const totals = el(doc, 'dl', 'order__totals');
  const s = order.summary || {};
  const rows = [['Items', s.quantity], ['Subtotal', s.subtotal], ['Shipping', s.shipping], ['Tax', s.tax], ['Total', s.total]];
  for (const [label, value] of rows) {
    if (value === null || value === undefined) continue;
    const row = el(doc, 'div', label === 'Total' ? 'order__total-row order__total-row--grand' : 'order__total-row');
    row.append(el(doc, 'dt', '', label));
    row.append(el(doc, 'dd', '', label === 'Items' ? String(value) : formatMoney(value)));
    totals.append(row);
  }
  article.append(totals);
  return article;
}

/**
 * States that replace the list: nothing yet, nothing in this range, not signed in.
 * @param {'empty'|'empty-range'|'signed-out'} kind
 */
export function renderNotice(doc, kind, { range = '' } = {}) {
  const box = el(doc, 'div', `empty notice notice--${kind}`);
  if (kind === 'signed-out') {
    box.append(el(doc, 'p', '', 'Sign in to TCGplayer to load your orders.'));
    const a = el(doc, 'a', '', 'Open your TCGplayer Order History');
    a.href = 'https://store.tcgplayer.com/myaccount/orderhistory';
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    box.append(a);
    box.append(el(doc, 'p', 'notice__hint', 'Once you are signed in, come back and refresh. Visiting that page also saves the orders it shows.'));
  } else if (kind === 'empty-range') {
    box.append(el(doc, 'p', '', `No saved orders for ${range}.`));
  } else {
    box.append(el(doc, 'p', '', 'No orders saved yet.'));
    box.append(el(doc, 'p', 'notice__hint', 'Orders are read from TCGplayer when you open this tab while signed in, and kept in this browser.'));
  }
  return box;
}

/**
 * The whole list plus the total above it.
 * @returns {{orders: number, items: number}}
 */
export function renderOrders(doc, container, orders, results = {}, trends = {}) {
  container.replaceChildren();
  if (!orders.length) return { orders: 0, items: 0 };
  container.append(renderSummary(doc, orders, results));
  const list = el(doc, 'div', 'order-list');
  for (const order of orders) list.append(renderOrder(doc, order, results, trends));
  container.append(list);
  return { orders: orders.length, items: orders.reduce((n, o) => n + o.items.length, 0) };
}

/** Total gain or loss for what is shown, with how many orders and items that covers. */
export function renderSummary(doc, orders, results) {
  const box = el(doc, 'section', 'orders-summary');
  box.append(renderTotal(doc, linesFor(orders, results), { title: 'Value of these orders vs. what you paid (price + shipping)' }));
  const items = orders.reduce((n, o) => n + o.items.reduce((q, i) => q + i.quantity, 0), 0);
  const spent = orders.reduce((n, o) => n + (Number.isFinite(o.summary && o.summary.total) ? o.summary.total : 0), 0);
  box.append(el(doc, 'p', 'orders-summary__facts',
    `${orders.length} order${orders.length === 1 ? '' : 's'} · ${items} item${items === 1 ? '' : 's'} · ${formatMoney(spent)} spent including shipping and tax`));
  return box;
}

/**
 * Swap a trend in place in every row that holds that card, without redrawing the orders.
 * @returns {boolean} whether any row was found
 */
export function updateOrderTrend(container, key, trend) {
  let found = false;
  for (const li of container.querySelectorAll('.oitem[data-trend-key]')) {
    if (li.getAttribute('data-trend-key') !== key) continue;
    const cell = li.querySelector('.oitem__trend');
    if (!cell) continue;
    cell.replaceChildren(renderTrend(container.ownerDocument, trend));
    found = true;
  }
  return found;
}

/** Patch one answer into every row that shares its key, and refresh the totals. */
export function updateResult(doc, container, orders, key, results) {
  for (const li of container.querySelectorAll('.oitem[data-key]')) {
    if (li.getAttribute('data-key') !== key) continue;
    const order = orders.find((o) => o.orderNumber === li.closest('.order').getAttribute('data-order'));
    const at = order ? order.items.findIndex((i) => lookupable(i) && itemKeyOf(i) === key) : -1;
    if (at < 0) continue;
    const item = order.items[at];
    const share = allocateShipping(order.summary, order.items)[at];
    li.querySelector('.oitem__now').replaceChildren(renderNow(doc, { paid: item.paid, paidShipping: share, result: results[key] || null, detail: true }));
  }
  for (const article of container.querySelectorAll('.order')) {
    const order = orders.find((o) => o.orderNumber === article.getAttribute('data-order'));
    if (order) article.querySelector('.order__change').replaceWith(renderOrderChange(doc, order, results));
  }
  const summary = container.querySelector('.orders-summary');
  if (summary) summary.replaceWith(renderSummary(doc, orders, results));
}

/**
 * One sentence about how a read from TCGplayer went.
 * @returns {{text: string, isError: boolean, signInUrl?: string}}  `signInUrl` is set when signing in would fix it
 */
export function describeSync(result, { range = '' } = {}) {
  const orders = (n) => `${n} order${n === 1 ? '' : 's'}`;
  if (!result) return { text: '', isError: false };
  switch (result.status) {
    case 'ok': {
      const fresh = result.added ? `, ${result.added} new` : '';
      const note = result.rangeApplied === false && range
        ? ` TCGplayer is showing ${result.range || 'a different range'}, not ${range}.` : '';
      return { text: `Up to date: read ${orders(result.count)} from TCGplayer${fresh}.${note}`, isError: false };
    }
    case 'partial':
      return { text: `Read ${orders(result.count)}, then stopped (${result.error}). What was read is saved.`, isError: true };
    case 'signed-out':
      return { text: 'You are not signed in to TCGplayer, new orders could not be read.', isError: true, signInUrl: SIGN_IN_URL };
    default:
      return { text: `Could not read your orders (${result.error || 'unknown error'}). Showing what is saved.`, isError: true };
  }
}

/** "Last synced 5 minutes ago", from the archive's record of when a range was read. */
export function describeAge(iso, now = Date.now()) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return 'Not read from TCGplayer yet';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return 'Last synced just now';
  if (minutes < 60) return `Last synced ${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `Last synced ${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `Last synced ${Math.round(hours / 24)} days ago`;
}
