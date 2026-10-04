/*
 * TCGPlayer+ — rendering the watch lists page.
 * Text comes from web pages, so everything goes in through textContent.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { formatMoney } from './money.js';
import { renderSparkline } from './sparkline.js';
import { imageCandidates, loadFirstWorking } from './productImage.js';
import { currentPrice, volatility } from './priceTrend.js';
import { SORTS, sortItems, defaultDirection, directionLabel, askKey } from './listsSort.js';
import { landedNow } from './orderCost.js';
import { listSort } from './lists.js';
import { isRetrying, retryText, retryTitle } from './retryState.js';
import { PAGE_SIZES, pageOf, parsePageSize, resolveSelection } from './listsPage.js';

export function itemSubtitle(item) {
  return [item.setName, item.number, item.rarity].filter(Boolean).join(' · ');
}

export function priceSummary(price) {
  if (!price || (!price.market && !price.lowest && !price.asLowAs)) return 'No price recorded';
  const parts = [];
  if (Number.isFinite(price.market)) parts.push(`Market ${formatMoney(price.market)}`);
  const lowest = Number.isFinite(price.lowest) ? price.lowest : price.asLowAs;
  if (Number.isFinite(lowest)) {
    parts.push(`lowest ${formatMoney(lowest)}${price.condition ? ` (${price.condition})` : ''}`);
  }
  return parts.join(' · ');
}

function el(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}


// ---- price trend -------------------------------------------------------------

const MINUS = '\u2212';

/** "−16%", "+20%", "−0.5%": whole numbers once a move is big enough to be plain. */
export function formatChange(pct) {
  if (!Number.isFinite(pct)) return '';
  const size = Math.abs(pct) * 100;
  const text = size >= 10 ? Math.round(size).toString() : size.toFixed(1);
  const sign = pct > 0 ? '+' : pct < 0 && Number(text) !== 0 ? MINUS : '';
  return `${sign}${text}%`;
}

export function trendSummary(trend) {
  if (!trend) return 'Checking trend\u2026';
  if (isRetrying(trend)) return retryText(trend);
  switch (trend.direction) {
    case 'up': return `\u25B2 ${formatChange(trend.pct)}`;
    case 'down': return `\u25BC ${formatChange(trend.pct)}`;
    case 'flat': return `\u25AC Flat (${formatChange(trend.pct)})`;
    default:
      return trend.reason === 'not-enough-sales' ? 'Not enough recent sales' : 'Trend unavailable';
  }
}

export function trendTooltip(trend) {
  if (!trend) return '';
  if (isRetrying(trend)) return retryTitle(trend);
  if (trend.direction === 'unknown') {
    return trend.reason === 'not-enough-sales'
      ? 'Too few recent sales to call a direction. It needs at least 5 sales on 3 different days, in each of two comparison periods.'
      : 'TCGplayer\u2019s price history could not be read just now.';
  }
  const n = trend.windowDays;
  const lines = [
    `Median sold price ${formatMoney(trend.recent.median)} over the last ${n} days `
      + `vs ${formatMoney(trend.prior.median)} the ${n} days before.`,
    `Based on ${trend.recent.sales} and ${trend.prior.sales} sales.`,
  ];
  if (trend.turning && trend.latest) {
    lines.push(`But the last ${trend.latest.days} days sold around ${formatMoney(trend.latest.median)}, `
      + `${trend.turning === 'down' ? 'below' : 'above'} that recent median.`);
  }
  if (trend.sku) {
    const name = [trend.sku.condition, trend.sku.variant].filter(Boolean).join(' ');
    if (name) lines.push(name);
  }
  if (trend.outliersHidden > 0) {
    lines.push(`${trend.outliersHidden} outlier day${trend.outliersHidden === 1 ? '' : 's'} left out of the chart.`);
  }
  return lines.join('\n');
}

/** "but falling in the last 3 days": the newest sales are moving against the headline. */
function turnNote(trend) {
  const days = trend.latest ? trend.latest.days : 3;
  return `but ${trend.turning === 'down' ? 'falling' : 'rising'} in the last ${days} days`;
}

/** @param {object|null} trend null while it is still being fetched, or a retrying state (see retryState.js) */
export function renderTrend(doc, original) {
  // While it is being retried there is no trend yet; it is drawn as loading, with the reason.
  const retrying = isRetrying(original);
  const trend = retrying ? null : original;
  const state = !trend ? 'loading' : trend.direction;
  const box = el(doc, 'div', `trend trend--${state}`);
  box.setAttribute('data-trend', state);
  box.setAttribute('title', trendTooltip(original));
  if (retrying) box.setAttribute('data-retrying', '1');

  if (trend && trend.direction !== 'unknown') {
    const word = { up: 'up', down: 'down', flat: 'flat' }[trend.direction];
    const turn = trend.turning ? turnNote(trend) : '';
    box.setAttribute(
      'aria-label',
      (trend.direction === 'flat'
        ? `Price flat over the last ${trend.windowDays} days`
        : `Price trending ${word} ${formatChange(trend.pct).replace(/^[+\u2212]/, '')} over the last ${trend.windowDays} days`)
        + (turn ? `, ${turn}` : ''),
    );
    if (trend.turning) box.setAttribute('data-turning', trend.turning);
  }

  box.append(el(doc, 'div', 'trend__summary', trendSummary(original)));
  if (trend && trend.direction !== 'unknown') {
    box.append(el(doc, 'div', 'trend__label', `vs previous ${trend.windowDays} days`));
    if (trend.turning) box.append(el(doc, 'div', 'trend__note', turnNote(trend)));
  }
  // The two numbers the list can be sorted by, so the order can be checked by eye.
  const market = currentPrice(trend);
  if (market !== null) {
    // Not TCGplayer's "Market Price" and not the price to buy it at: what it has just been selling for.
    const stat = el(doc, 'div', 'trend__stat trend__stat--sales', `Recent sales ${formatMoney(market)}`);
    stat.setAttribute('title', 'The median of the newest three days of sales. To buy one today, see Ask.');
    box.append(stat);
  }
  const swing = trend ? volatility(trend.series) : null;
  if (swing !== null) {
    const stat = el(doc, 'div', 'trend__stat trend__stat--volatility', `\u00B1${(swing * 100).toFixed(swing >= 0.1 ? 0 : 1)}% a day`);
    stat.setAttribute('title', 'Volatility: how much the price typically moves from one day of sales to the next.');
    box.append(stat);
  }
  const line = trend && trend.series && trend.series.length ? renderSparkline(doc, trend.series) : null;
  if (line) box.append(line);
  return box;
}

/**
 * Swap a trend in place, without redrawing the list. A card saved in several
 * lists has a row in each, and all of them are the same fact.
 * @returns {boolean} whether any row with that key was found
 */
export function updateTrend(container, key, trend) {
  let found = false;
  for (const row of container.querySelectorAll('.item')) {
    if (row.getAttribute('data-key') !== key) continue;
    const cell = row.querySelector('.item__trend');
    if (!cell) continue;
    cell.textContent = '';
    cell.append(renderTrend(container.ownerDocument, trend));
    found = true;
  }
  return found;
}

// ---- ask: what it would cost to buy today ---------------------------------

/**
 * The cheapest live listing in the card's condition, price plus shipping. That is
 * TCGplayer's featured listing on the product page, and the real cost of getting
 * the card, unlike its "Market Price", which is a calculation over past sales.
 * @param {object|null} ask a listing lookup result; null while it is being fetched
 */
export function askSummary(ask) {
  if (!ask) return 'Checking ask\u2026';
  if (isRetrying(ask)) return retryText(ask);
  if (ask.status === 'none') return 'Ask: none listed';
  const total = landedNow(ask);
  if (total === null) return 'Ask unavailable';
  const parts = ask.shipping > 0
    ? `${formatMoney(ask.price)} + ${formatMoney(ask.shipping)} shipping`
    : `${formatMoney(ask.price)}, free shipping`;
  return `Ask ${formatMoney(total)} (${parts})`;
}

export function renderAsk(doc, ask) {
  const retrying = isRetrying(ask);
  const node = el(doc, 'span', `item__ask item__ask--${!ask || retrying ? 'loading' : landedNow(ask) === null ? 'unknown' : 'ok'}`, askSummary(ask));
  if (retrying) {
    node.setAttribute('data-retrying', '1');
    node.setAttribute('title', retryTitle(ask));
  }
  if (ask && landedNow(ask) !== null) {
    node.setAttribute('title', `The cheapest live listing in the same condition and printing, with its shipping`
      + `${ask.seller ? `, from ${ask.seller}` : ''}. This is what it costs to buy, unlike TCGplayer\u2019s Market Price.`);
  }
  return node;
}

/** Swap an ask in place in every row holding that card, without redrawing the list. */
export function updateAsk(container, key, ask) {
  let found = false;
  for (const row of container.querySelectorAll('.item')) {
    if (row.getAttribute('data-ask-key') !== key) continue;
    const slot = row.querySelector('.item__ask');
    if (!slot) continue;
    slot.replaceWith(renderAsk(container.ownerDocument, ask));
    found = true;
  }
  return found;
}

/** "Market $X · Ask $Y (…)": the price when saved, and what buying costs now. */
function renderPriceLine(doc, item, asks) {
  const line = el(doc, 'p', 'item__price');
  // Without asks (nothing has been looked up) the line is just what was recorded at save time.
  if (!asks) {
    line.textContent = priceSummary(item.priceAtSave);
    return line;
  }
  const saved = item.priceAtSave || {};
  if (Number.isFinite(saved.market)) {
    const market = el(doc, 'span', 'item__market', `Market ${formatMoney(saved.market)}`);
    market.setAttribute('title', `TCGplayer\u2019s Market Price when you saved it. ${priceSummary(item.priceAtSave)}.`);
    line.append(market, doc.createTextNode(' \u00B7 '));
  }
  line.append(renderAsk(doc, asks[askKey(item)] || null));
  return line;
}

function renderItem(doc, list, item, handlers, trends, asks) {
  const row = el(doc, 'li', 'item');
  row.setAttribute('data-key', item.key);

  const pictures = imageCandidates(item.productId, item.imageUrl);
  if (pictures.length) {
    const img = el(doc, 'img', 'item__image');
    img.alt = '';
    img.loading = 'lazy';
    loadFirstWorking(img, pictures);
    row.append(img);
  }

  const body = el(doc, 'div', 'item__body');
  const link = el(doc, 'a', 'item__name', item.name);
  link.href = item.url || '#';
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  body.append(link);
  body.append(el(doc, 'p', 'item__subtitle', itemSubtitle(item)));
  body.append(renderPriceLine(doc, item, asks));
  if (asks) row.setAttribute('data-ask-key', askKey(item));
  if (item.savedAt) {
    const when = new Date(item.savedAt);
    body.append(el(doc, 'p', 'item__saved', `Saved ${Number.isNaN(when.getTime()) ? item.savedAt : when.toLocaleDateString()}`));
  }
  row.append(body);

  // Only when the caller asked for trends; a missing map leaves the row as it was.
  if (trends) {
    const cell = el(doc, 'div', 'item__trend');
    cell.append(renderTrend(doc, trends[item.key] || null));
    row.append(cell);
  }

  const remove = el(doc, 'button', 'item__remove', 'Remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${item.name}`);
  remove.addEventListener('click', () => handlers.onRemoveItem && handlers.onRemoveItem(list.id, item.key));
  row.append(remove);
  return row;
}

/** "Sort by [Date added v] [Newest first]", for this list alone. */
function renderSortControl(doc, list, sort, handlers) {
  const wrap = el(doc, 'span', 'list__sort');
  const select = el(doc, 'select', 'list__sort-select');
  select.setAttribute('aria-label', `Sort ${list.name} by`);
  for (const option of SORTS) {
    const node = el(doc, 'option', '', option.label);
    node.value = option.key;
    node.selected = option.key === sort.key;
    select.append(node);
  }
  select.addEventListener('change', () => handlers.onSortChange && handlers.onSortChange(list.id, select.value, defaultDirection(select.value)));
  const direction = el(doc, 'button', 'list__sort-direction', directionLabel(sort.key, sort.dir));
  direction.type = 'button';
  direction.title = 'Reverse the order';
  direction.addEventListener('click', () => handlers.onSortDirection && handlers.onSortDirection(list.id));
  wrap.append(select, direction);
  return wrap;
}

function renderList(doc, list, handlers, trends, asks, view = {}) {
  const section = el(doc, 'section', 'list');

  const header = el(doc, 'header', 'list__header');
  header.append(el(doc, 'h2', 'list__name', list.name));
  header.append(el(doc, 'span', 'list__count', `${list.items.length} item${list.items.length === 1 ? '' : 's'}`));

  const actions = el(doc, 'div', 'list__actions');
  const sort = listSort(list);
  // Ordering one card is meaningless, so the control appears once there is something to order.
  if (list.items.length > 1) actions.append(renderSortControl(doc, list, sort, handlers));
  for (const [cls, label, handler] of [
    ['list__rename', 'Rename', 'onRenameList'],
    ['list__delete', 'Delete', 'onDeleteList'],
  ]) {
    const button = el(doc, 'button', cls, label);
    button.type = 'button';
    button.addEventListener('click', () => handlers[handler] && handlers[handler](list.id));
    actions.append(button);
  }
  header.append(actions);
  section.append(header);

  if (list.items.length === 0) {
    section.append(el(doc, 'p', 'list__empty', 'Nothing saved here yet.'));
    return section;
  }
  // Paging comes after sorting, so page 1 is always the top of the chosen order.
  const page = pageOf(sortItems(list.items, sort, { trends, asks }), { page: view.page, size: view.size });
  const items = el(doc, 'ul', 'item-list');
  for (const item of page.items) items.append(renderItem(doc, list, item, handlers, trends, asks));
  section.append(renderPager(doc, page, handlers, 'pager--top'), items, renderPager(doc, page, handlers, 'pager--bottom'));
  return section;
}

/** "Showing 26–50 of 140  [Previous] [Next]"; nothing when everything fits on one page. */
function renderPager(doc, page, handlers, className) {
  const nav = el(doc, 'nav', `pager ${className}`);
  nav.setAttribute('aria-label', 'Pages');
  if (page.pages <= 1) { nav.hidden = true; return nav; }
  nav.append(el(doc, 'span', 'pager__range', `Showing ${page.from}\u2013${page.to} of ${page.total}`));
  for (const [cls, label, target, disabled] of [
    ['pager__prev', 'Previous', page.page - 1, page.page <= 1],
    ['pager__next', 'Next', page.page + 1, page.page >= page.pages],
  ]) {
    const button = el(doc, 'button', `${cls} secondary`, label);
    button.type = 'button';
    button.disabled = disabled;
    button.addEventListener('click', () => handlers.onPage && handlers.onPage(target));
    nav.append(button);
  }
  return nav;
}

/** "List [Watching (6) v]  Show [25 v]": which list, and how many cards at a time. */
function renderToolbar(doc, lists, selected, size, handlers) {
  const bar = el(doc, 'div', 'lists-toolbar');

  const listLabel = el(doc, 'label', 'lists-toolbar__field', 'List ');
  const listSelect = el(doc, 'select', 'lists-toolbar__list');
  for (const list of lists) {
    const option = el(doc, 'option', '', `${list.name} (${list.items.length})`);
    option.value = list.id;
    option.selected = list.id === selected.id;
    listSelect.append(option);
  }
  listSelect.addEventListener('change', () => handlers.onSelectList && handlers.onSelectList(listSelect.value));
  listLabel.append(listSelect);

  const sizeLabel = el(doc, 'label', 'lists-toolbar__field', 'Show ');
  const sizeSelect = el(doc, 'select', 'lists-toolbar__size');
  for (const choice of PAGE_SIZES) {
    const option = el(doc, 'option', '', choice === 'all' ? 'All' : String(choice));
    option.value = String(choice);
    option.selected = choice === size;
    sizeSelect.append(option);
  }
  sizeSelect.addEventListener('change', () => handlers.onPageSize && handlers.onPageSize(parsePageSize(sizeSelect.value)));
  sizeLabel.append(sizeSelect);

  bar.append(listLabel, sizeLabel);
  return bar;
}

/**
 * One list at a time, chosen from a dropdown, a page of cards at a time.
 * @param {{selectedId?: string, size?: number|'all', page?: number}} view
 */
export function renderLists(doc, container, state, handlers = {}, trends, asks, view = {}) {
  container.textContent = '';
  if (state.lists.length === 0) {
    container.append(el(doc, 'p', 'empty',
      'No lists yet. Open a TCGplayer product page and choose "Add to watch list".'));
    return container;
  }
  const selected = resolveSelection(state.lists, view.selectedId);
  const size = parsePageSize(view.size);
  container.append(
    renderToolbar(doc, state.lists, selected, size, handlers),
    renderList(doc, selected, handlers, trends, asks, { page: view.page, size }),
  );
  return container;
}

export function exportJson(state) {
  return JSON.stringify({ exportedAt: new Date().toISOString(), ...state }, null, 2);
}
