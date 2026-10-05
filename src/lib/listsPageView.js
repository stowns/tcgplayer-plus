/*
 * TCGPlayer+ — rendering the watch lists page.
 * Text comes from web pages, so everything goes in through textContent.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { formatMoney } from './money.js';
import { renderSparkline } from './sparkline.js';
import { imageCandidates, loadFirstWorking } from './productImage.js';
import { currentPrice, volatility, selectTrendLines, TREND } from './priceTrend.js';
import { SORTS, sortItems, defaultDirection, directionLabel, askKey } from './listsSort.js';
import { landedNow } from './orderCost.js';
import { isListingUrl } from './tcgplayerListings.js';
import { listSort } from './lists.js';
import { isRetrying, retryText, retryTitle } from './retryState.js';
import { describeTarget, DIRECTIONS } from './targets.js';
import { SECRET_WORD_MAX, SECRET_WORD_RULE } from './settings.js';
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
    case 'flat': return `\u25AC ${formatChange(trend.pct)}`;
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

const ARROWS = { up: '\u25B2', down: '\u25BC', flat: '\u25AC' };
const daysLabel = (days) => `${days} day${days === 1 ? '' : 's'}`;

/** What one duration's percent compares, for its tooltip. */
function lineTooltip(trend, line) {
  const n = daysLabel(line.shownDays);
  if (line.reason !== 'ok') {
    const needs = Math.min(TREND.MIN_DAYS, line.shownDays);
    return `Too few sales to compare the last ${n} with the ${n} before. Each period needs at least `
      + `${TREND.MIN_SALES} sales, on ${needs === 1 ? 'at least 1 day' : `${needs} different days`}.`;
  }
  const lines = [
    `Median sold price ${formatMoney(line.recent.median)} over the last ${n} `
      + `vs ${formatMoney(line.prior.median)} the ${n} before.`,
    `Based on ${line.recent.sales} and ${line.prior.sales} sales.`,
  ];
  if (line.shownDays !== line.days) lines.push(`Too few sales over ${daysLabel(line.days)}, so ${n} are compared instead.`);
  if (line.headline && trend.turning && trend.latest && trend.windowDays === line.shownDays) {
    lines.push(`But the last ${trend.latest.days} days sold around ${formatMoney(trend.latest.median)}, `
      + `${trend.turning === 'down' ? 'below' : 'above'} that recent median.`);
  }
  if (trend.sku) {
    const name = [trend.sku.condition, trend.sku.variant].filter(Boolean).join(' ');
    if (name) lines.push(name);
  }
  return lines.join('\n');
}

/**
 * One duration: "▲ +2.1%  7 days". A button when there is a percent, so its chart can be
 * opened; plain text when there were too few sales to give one.
 */
function renderTrendLine(doc, trend, line, { expanded, onToggle, turn = '' }) {
  const known = line.reason === 'ok';
  const node = el(doc, known ? 'button' : 'div', `trend__line trend__line--${line.direction}`);
  node.setAttribute('data-days', String(line.days));
  node.setAttribute('title', lineTooltip(trend, line));
  if (!known) {
    node.append(el(doc, 'span', 'trend__label', `${daysLabel(line.shownDays)}: not enough sales`));
    return node;
  }
  node.type = 'button';
  const open = expanded === line.days;
  node.setAttribute('aria-expanded', open ? 'true' : 'false');
  const word = line.direction === 'flat'
    ? `Price flat over the last ${daysLabel(line.shownDays)}`
    : `Price trending ${line.direction} ${formatChange(line.pct).replace(/^[+\u2212]/, '')} over the last ${daysLabel(line.shownDays)}`;
  node.setAttribute('aria-label', `${word}${turn ? `, ${turn}` : ''}. ${open ? 'Hide' : 'Show'} the chart`);
  node.append(
    // Flat is said by the bar and the grey, as up and down are by their arrows and colours.
    el(doc, 'span', 'trend__summary', `${ARROWS[line.direction]} ${formatChange(line.pct)}`),
    el(doc, 'span', 'trend__label', daysLabel(line.shownDays)),
  );
  node.addEventListener('click', () => onToggle && onToggle(line.days));
  return node;
}

/**
 * @param {object|null} original null while it is still being fetched, or a retrying state (see retryState.js)
 * @param {{durations?: number[], expanded?: number|null, onToggle?: (days: number) => void}} [options]
 *   which durations get a line (see TREND.DURATIONS; 7 days when omitted), which one's chart is open,
 *   and what to call when a line is clicked
 */
export function renderTrend(doc, original, options = {}) {
  // While it is being retried there is no trend yet; it is drawn as loading, with the reason.
  const retrying = isRetrying(original);
  const trend = retrying ? null : original;
  const state = !trend ? 'loading' : trend.direction;
  const box = el(doc, 'div', `trend trend--${state}`);
  box.setAttribute('data-trend', state);
  if (retrying) box.setAttribute('data-retrying', '1');

  const lines = trend ? selectTrendLines(trend, options.durations) : [];
  if (lines.length === 0) {
    // Loading, retrying, or nothing to go on at all: one line saying which.
    box.setAttribute('title', trendTooltip(original));
    box.append(el(doc, 'div', 'trend__summary', trendSummary(original)));
  }

  const shown = lines.find((line) => line.reason === 'ok' && line.days === options.expanded) || null;
  for (const line of lines) {
    const turning = line.headline && line.reason === 'ok' && trend.turning && trend.windowDays === line.shownDays;
    const turn = turning ? turnNote(trend) : '';
    box.append(renderTrendLine(doc, trend, line, { expanded: shown ? shown.days : null, onToggle: options.onToggle, turn }));
    if (turning) {
      box.setAttribute('data-turning', trend.turning);
      box.append(el(doc, 'div', 'trend__note', turn));
    }
  }
  if (shown) {
    // The thirty days of sales, with the two periods this line compares shaded.
    const chart = renderSparkline(doc, trend.series, { width: 124, height: 36, endDate: trend.asOf, highlightDays: shown.shownDays });
    if (chart) {
      const frame = el(doc, 'div', `trend__chart trend__chart--${shown.direction}`);
      const hidden = trend.outliersHidden > 0
        ? ` ${trend.outliersHidden} outlier day${trend.outliersHidden === 1 ? '' : 's'} left out.` : '';
      frame.setAttribute('title', `Sold price over the last 30 days. Shaded: the last ${daysLabel(shown.shownDays)} (darker) and the ${daysLabel(shown.shownDays)} before.${hidden}`);
      frame.append(chart);
      box.append(frame);
    }
  }
  // The two numbers the list can be sorted by, so the order can be checked by eye.
  const market = currentPrice(trend);
  if (market !== null) {
    // Not TCGplayer's "Market Price" and not the price to buy it at: what it has just been selling for.
    const stat = el(doc, 'div', 'trend__stat trend__stat--sales', `Recent sales ${formatMoney(market)}`);
    stat.setAttribute('title', 'The median of the newest three days of sales, before shipping. '
      + 'Ask and price targets include shipping, so compare a target with Ask, not with this.');
    // TCGplayer's sales history carries no shipping; said outright so it is not read against Ask.
    const note = el(doc, 'div', 'trend__stat trend__stat--shipping', 'before shipping');
    box.append(stat, note);
  }
  const swing = trend ? volatility(trend.series) : null;
  if (swing !== null) {
    const stat = el(doc, 'div', 'trend__stat trend__stat--volatility', `\u00B1${(swing * 100).toFixed(swing >= 0.1 ? 0 : 1)}% a day`);
    stat.setAttribute('title', 'Volatility: how much the price typically moves from one day of sales to the next.');
    box.append(stat);
  }
  return box;
}

/**
 * renderTrend's options for one item, from what a view holds for all of them.
 * @param {{durations?: number[], expanded?: Record<string, number>, onToggle?: (key: string, days: number) => void}} [trendView]
 */
export function trendOptionsFor(key, trendView = {}) {
  return {
    durations: trendView.durations,
    expanded: trendView.expanded && key in trendView.expanded ? trendView.expanded[key] : null,
    onToggle: (days) => trendView.onToggle && trendView.onToggle(key, days),
  };
}

/**
 * Swap a trend in place, without redrawing the list. A card saved in several
 * lists has a row in each, and all of them are the same fact.
 * @returns {boolean} whether any row with that key was found
 */
export function updateTrend(container, key, trend, options) {
  let found = false;
  for (const row of container.querySelectorAll('.item')) {
    if (row.getAttribute('data-key') !== key) continue;
    const cell = row.querySelector('.item__trend');
    if (!cell) continue;
    cell.textContent = '';
    cell.append(renderTrend(container.ownerDocument, trend, options));
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
    // The product page opens on a featured seller, so the listing itself is linked.
    if (isListingUrl(ask.url)) {
      const link = el(doc, 'a', 'item__ask-link', 'view listing');
      link.href = ask.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.setAttribute('title', `Open this listing on TCGplayer${ask.seller ? `, sold by ${ask.seller}` : ''}`);
      node.append(' \u00B7 ', link);
    }
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

// ---- price target: "tell me when it reaches this price" --------------------------

const DIRECTION_LABELS = { below: 'At or below', above: 'At or above' };

/** What the target form holds right now, so a redraw can put it back as it was. */
function readDraft(form) {
  return {
    direction: form.querySelector('.target-form__direction').value,
    price: form.querySelector('.target-form__price').value,
    notify: form.querySelector('.target-form__notify').checked,
    word: form.querySelector('.target-form__word').value,
  };
}

function renderTargetForm(doc, item, { target, editing, autoRefreshOn, hasTopic }, handlers) {
  const draft = editing.draft || (target
    ? { direction: target.direction, price: String(target.price), notify: target.notify }
    : { direction: 'below', price: '', notify: true });
  const form = el(doc, 'form', 'target-form');
  form.setAttribute('aria-label', `Price target for ${item.name}`);

  const direction = el(doc, 'select', 'target-form__direction');
  direction.setAttribute('aria-label', 'Notify when the Ask is');
  for (const value of DIRECTIONS) {
    const option = el(doc, 'option', '', DIRECTION_LABELS[value]);
    option.value = value;
    option.selected = value === draft.direction;
    direction.append(option);
  }

  const price = el(doc, 'input', 'target-form__price');
  price.type = 'text';
  price.inputMode = 'decimal';
  price.placeholder = '0.00';
  price.value = draft.price;
  price.setAttribute('aria-label', 'Target price in dollars, including shipping');

  const notifyLabel = el(doc, 'label', 'target-form__notify-label');
  const notify = el(doc, 'input', 'target-form__notify');
  notify.type = 'checkbox';
  notify.checked = draft.notify;
  notifyLabel.append(notify, ' Notify me');

  const save = el(doc, 'button', 'target-form__save', 'Save');
  save.type = 'submit';
  const cancel = el(doc, 'button', 'target-form__cancel secondary', 'Cancel');
  cancel.type = 'button';
  cancel.addEventListener('click', () => handlers.onCancelTarget && handlers.onCancelTarget(item.key));

  const row = el(doc, 'div', 'target-form__row');
  row.append(direction, el(doc, 'span', 'target-form__currency', '$'), price, notifyLabel, save, cancel);
  if (target) {
    const remove = el(doc, 'button', 'target-form__remove secondary', 'Remove target');
    remove.type = 'button';
    remove.addEventListener('click', () => handlers.onRemoveTarget && handlers.onRemoveTarget(item.key));
    row.append(remove);
  }
  form.append(row);

  // Notifications need somewhere to go: asked for here, the first time they are wanted.
  const setup = el(doc, 'p', 'target-form__setup');
  const wordLabel = el(doc, 'label', 'target-form__word-label', 'Secret word for your notifications ');
  const word = el(doc, 'input', 'target-form__word');
  word.type = 'text';
  word.maxLength = SECRET_WORD_MAX;
  word.autocomplete = 'off';
  word.spellcheck = false;
  word.value = editing.draft && editing.draft.word ? editing.draft.word : '';
  wordLabel.append(word);
  setup.append(wordLabel, el(doc, 'span', 'target-form__setup-note',
    ` ${SECRET_WORD_RULE} It starts the ntfy topic you subscribe to; Settings shows the whole topic.`));
  form.append(setup);

  // Tracking happens in this browser, on a timer; without the timer a target would never be checked.
  const alert = el(doc, 'p', 'target-form__alert');
  alert.setAttribute('role', 'alert');
  alert.append('Price tracking runs in your browser while this dashboard is open, and needs auto-refresh to be on. ');
  const enable = el(doc, 'button', 'target-form__enable', 'Enable auto-refresh');
  enable.type = 'button';
  enable.addEventListener('click', () => handlers.onEnableAutoRefresh && handlers.onEnableAutoRefresh());
  alert.append(enable);
  const showAlert = () => {
    alert.hidden = autoRefreshOn || !notify.checked;
    setup.hidden = hasTopic || !notify.checked;
  };
  showAlert();
  form.append(alert);

  if (editing.error) {
    const error = el(doc, 'p', 'target-form__error', editing.error);
    error.setAttribute('role', 'alert');
    form.append(error);
  }

  const drafted = () => handlers.onTargetDraft && handlers.onTargetDraft(item.key, readDraft(form));
  direction.addEventListener('change', drafted);
  price.addEventListener('input', drafted);
  word.addEventListener('input', drafted);
  notify.addEventListener('change', () => { showAlert(); drafted(); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    if (handlers.onSaveTarget) handlers.onSaveTarget(item.key, readDraft(form));
  });
  return form;
}

/**
 * The target part of an item: the target once set, or the form. Empty when there is neither.
 * @param {{targets?: object, editing?: {key: string, draft?: object, error?: string}|null, autoRefreshOn?: boolean,
 *   hasTopic?: boolean}} extras  `hasTopic: false` asks for a secret word when notifications are wanted
 */
export function renderTargetBlock(doc, item, extras = {}, handlers = {}) {
  const slot = el(doc, 'div', 'item__target');
  const target = extras.targets ? extras.targets[item.key] : null;
  const editing = extras.editing && extras.editing.key === item.key ? extras.editing : null;

  if (editing) {
    slot.append(renderTargetForm(doc, item, {
      target, editing, autoRefreshOn: Boolean(extras.autoRefreshOn), hasTopic: extras.hasTopic !== false,
    }, handlers));
    return slot;
  }
  // Nothing set: the button that starts one sits beside the item, above Remove.
  if (!target) return slot;

  const line = el(doc, 'p', 'item__target-line');
  line.append(el(doc, 'span', 'item__target-text', `Target: ${describeTarget(target)}`));
  line.append(' \u00B7 ', el(doc, 'span', 'item__target-notify', `notifications ${target.notify ? 'on' : 'off'}`));
  if (target.notify) {
    // Being notified takes a subscription on the receiving device; Settings says how.
    const how = el(doc, 'a', 'item__target-how', 'how to receive them');
    how.href = '#settings';
    line.append(' (', how, ')');
  }
  if (target.met) {
    const met = el(doc, 'span', 'item__target-met', 'Target met');
    met.title = 'The Ask, with shipping, is at your target now.';
    line.append(' \u00B7 ', met);
  }
  // Notifications are wanted but nothing is checking: say so where the target is shown.
  if (target.notify && !extras.autoRefreshOn) {
    const off = el(doc, 'span', 'item__target-paused', 'not being checked: auto-refresh is off');
    line.append(' \u00B7 ', off);
  }
  const edit = el(doc, 'button', 'item__target-edit link', 'Edit');
  edit.type = 'button';
  edit.setAttribute('aria-label', `Edit the price target for ${item.name}`);
  edit.addEventListener('click', () => handlers.onEditTarget && handlers.onEditTarget(item.key));
  line.append(' \u00B7 ', edit);
  slot.append(line);
  return slot;
}

/** Is "Set price target" on offer: no target yet, and its form is not open. */
function canSetTarget(item, extras) {
  const editing = extras.editing && extras.editing.key === item.key;
  return !editing && !(extras.targets && extras.targets[item.key]);
}

/** Redraw the target part of every row holding that product, without redrawing the list. */
export function updateTargetBlock(container, item, extras, handlers) {
  let found = false;
  for (const row of container.querySelectorAll('.item')) {
    if (row.getAttribute('data-key') !== item.key) continue;
    const slot = row.querySelector('.item__target');
    if (!slot) continue;
    slot.replaceWith(renderTargetBlock(container.ownerDocument, item, extras, handlers));
    const set = row.querySelector('.item__target-set');
    if (set) set.hidden = !canSetTarget(item, extras);
    found = true;
  }
  return found;
}

function renderItem(doc, list, item, handlers, trends, asks, extras) {
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
  // Only when the caller is tracking targets; without them the row is as it was.
  if (extras && extras.targets) body.append(renderTargetBlock(doc, item, extras, handlers));
  row.append(body);

  // Only when the caller asked for trends; a missing map leaves the row as it was.
  if (trends) {
    const cell = el(doc, 'div', 'item__trend');
    cell.append(renderTrend(doc, trends[item.key] || null, trendOptionsFor(item.key, extras && extras.trendView)));
    row.append(cell);
  }

  const side = el(doc, 'div', 'item__side');
  if (extras && extras.targets) {
    const set = el(doc, 'button', 'item__target-set secondary', 'Set price target');
    set.type = 'button';
    set.setAttribute('aria-label', `Set a price target for ${item.name}`);
    set.hidden = !canSetTarget(item, extras);
    set.addEventListener('click', () => handlers.onEditTarget && handlers.onEditTarget(item.key));
    side.append(set);
  }
  const remove = el(doc, 'button', 'item__remove', 'Remove');
  remove.type = 'button';
  remove.setAttribute('aria-label', `Remove ${item.name}`);
  remove.addEventListener('click', () => handlers.onRemoveItem && handlers.onRemoveItem(list.id, item.key));
  side.append(remove);
  row.append(side);
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
  for (const item of page.items) items.append(renderItem(doc, list, item, handlers, trends, asks, view));
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
 * @param {{selectedId?: string, size?: number|'all', page?: number, targets?: object, trendView?: object,
 *   editing?: object|null, autoRefreshOn?: boolean}} view  `targets` turns on the price-target part of each item
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
    renderList(doc, selected, handlers, trends, asks, { ...view, page: view.page, size }),
  );
  return container;
}

/** Everything the user has made, as text they can keep: the lists, and any price targets. */
export function exportJson(state, targets) {
  const extra = targets && Object.keys(targets).length ? { targets } : {};
  return JSON.stringify({ exportedAt: new Date().toISOString(), ...state, ...extra }, null, 2);
}
