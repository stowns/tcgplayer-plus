/*
 * TCGPlayer+ — the Order History view.
 * Shows the purchases kept in the local archive, refreshes them from TCGplayer
 * on request, and fills in what each item would cost today.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  loadArchive, ordersInRange, rangeChoices, ALL_SAVED, ORDERS_KEY,
} from '../../lib/ordersArchive.js';
import {
  renderOrders, renderNotice, updateResult, updateOrderTrend, itemKeyOf, trendKeyOf, describeSync, describeAge,
} from '../../lib/ordersView.js';
import { api } from '../../lib/runtime.js';
import { readOrders } from '../../lib/orderReader.js';
import { retryingState, isSettled } from '../../lib/retryState.js';

const storage = api.storage.local;

const RANGE_KEY = 'ptcg.ordersRange';
const DEFAULT_RANGE = 'Last 30 Days';
/** Opening the tab re-reads TCGplayer only if the last read is older than this. */
const STALE_MS = 10 * 60 * 1000;

const remembered = () => { try { return localStorage.getItem(RANGE_KEY) || ''; } catch { return ''; } };
const remember = (range) => { try { localStorage.setItem(RANGE_KEY, range); } catch { /* not worth failing over */ } };

function make(tag, props = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @returns {() => void} unmount */
export function mount(root) {
  const choices = rangeChoices(new Date().getFullYear());
  let range = choices.includes(remembered()) ? remembered() : DEFAULT_RANGE;

  const header = make('div', { className: 'page-header' });
  const intro = make('div');
  intro.append(
    make('h2', {}, 'Order History'),
    make('p', { className: 'intro' }, 'Your TCGplayer purchases, kept in this browser so they stay here after TCGplayer stops listing them, '
      + 'with what each would cost today.'),
  );
  header.append(intro);

  const bar = make('div', { className: 'orders-bar' });
  const rangeLabel = make('label', { className: 'orders-bar__range' });
  const select = make('select', { id: 'ordersRange' });
  for (const choice of choices) select.append(make('option', { value: choice, selected: choice === range }, choice));
  select.title = 'Choosing a range also changes the range shown on TCGplayer’s own Order History page, '
    + 'as its own dropdown does. "All saved" shows everything kept here and reads nothing.';
  rangeLabel.append(make('span', {}, 'Orders placed in '), select);
  const refresh = make('button', { type: 'button', className: 'secondary' }, 'Refresh from TCGplayer');
  const age = make('span', { className: 'orders-bar__age' });
  bar.append(rangeLabel, refresh, age);

  const status = make('p', { role: 'status', className: 'orders-status' });
  const container = make('div', { className: 'orders' });
  const footer = make('p', { className: 'orders-footer' });
  const clear = make('button', { type: 'button', className: 'secondary' }, 'Clear saved orders');
  footer.append(clear);
  root.append(header, bar, status, container, footer);

  let mounted = true;
  let syncing = false;
  let syncOutcome = null;
  let freshPrices = false;
  let shown = [];
  const results = {};
  const requested = new Set();
  const trends = {};            // trend key -> trend, kept so a redraw never flashes back to "checking"
  const trendRequested = new Set();
  let itemsByTrendKey = new Map();

  function say(message, isError = false, signInUrl = '') {
    status.textContent = message;
    status.setAttribute('data-error', isError ? '1' : '0');
    if (signInUrl) {
      const link = make('a', { href: signInUrl, target: '_blank', rel: 'noopener noreferrer', className: 'sign-in' }, 'Sign in');
      status.append(' ', link);
    }
  }

  // ---- today's prices --------------------------------------------------------------
  // Fetched for every item shown, newest order first, so the total above the list
  // fills in without scrolling. The background paces them and caches each for 10 minutes; Refresh goes past the cache.

  async function requestPrice(item, fresh = false) {
    const key = itemKeyOf(item);
    if (!item.productId || !Number.isFinite(item.paid) || requested.has(key)) return;
    requested.add(key);
    let result;
    try {
      result = await api.runtime.sendMessage({ type: 'listing-price', ref: key, item: { productId: item.productId, condition: item.condition, fresh } });
    } catch {
      result = null;
    }
    results[key] = result && result.status ? result : { status: 'unavailable' };
    if (mounted) updateResult(document, container, shown, key, results);
  }

  // ---- price trends ------------------------------------------------------------------
  // The same picture the Watch Lists view shows. Fetched only for items that scroll into view
  // (the totals above do not need them), and shared by every order that holds the same card.

  async function requestTrend(key) {
    const item = itemsByTrendKey.get(key);
    if (!item || trendRequested.has(key)) return;
    trendRequested.add(key);
    let result;
    try {
      result = await api.runtime.sendMessage({ type: 'price-trend', ref: key, item: { productId: item.productId, condition: item.condition } });
    } catch {
      result = null;
    }
    trends[key] = result || { direction: 'unknown', pct: null, series: [], outliersHidden: 0, reason: 'unavailable' };
    if (mounted) updateOrderTrend(container, key, trends[key]);
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      requestTrend(entry.target.getAttribute('data-trend-key'));
    }
  }, { rootMargin: '200px' });

  // The background retries a lookup TCGplayer is not answering, and tells us, so the price
  // (or trend) says it is still loading and why, and the totals do not count it as an answer.
  const onRetryNotice = (message) => {
    if (!mounted || !message || message.type !== 'lookup-retry') return;
    // Only for what this page asked about: the notice reaches every dashboard tab that is open.
    if (message.kind === 'listing-price') {
      if (!requested.has(message.ref) || isSettled(results[message.ref])) return;
      results[message.ref] = retryingState(message);
      updateResult(document, container, shown, message.ref, results);
    } else if (message.kind === 'price-trend') {
      if (!trendRequested.has(message.ref) || isSettled(trends[message.ref])) return;
      trends[message.ref] = retryingState(message);
      updateOrderTrend(container, message.ref, trends[message.ref]);
    }
  };
  api.runtime.onMessage.addListener(onRetryNotice);

  // ---- drawing ------------------------------------------------------------------

  async function draw() {
    const archive = await loadArchive(storage);
    if (!mounted) return;
    const today = new Date().toISOString().slice(0, 10);
    shown = ordersInRange(archive, range, today);

    if (!shown.length) {
      container.replaceChildren(renderNotice(document,
        syncOutcome && syncOutcome.status === 'signed-out' ? 'signed-out'
          : Object.keys(archive.orders).length ? 'empty-range' : 'empty', { range }));
    } else {
      renderOrders(document, container, shown, results, trends);
      for (const order of shown) order.items.forEach((item) => requestPrice(item, freshPrices));
      itemsByTrendKey = new Map(shown.flatMap((o) => o.items).filter((i) => trendKeyOf(i)).map((i) => [trendKeyOf(i), i]));
      observer.disconnect();
      for (const li of container.querySelectorAll('.oitem[data-trend-key]')) {
        if (!isSettled(trends[li.getAttribute('data-trend-key')])) observer.observe(li);
      }
    }
    age.textContent = range === ALL_SAVED
      ? `${Object.keys(archive.orders).length} saved`
      : describeAge(archive.syncedAt[range]);
    refresh.disabled = syncing || range === ALL_SAVED;
    select.disabled = syncing;
    return archive;
  }

  // ---- reading TCGplayer --------------------------------------------------------

  async function sync() {
    if (syncing || range === ALL_SAVED) return;
    syncing = true;
    refresh.disabled = true;
    select.disabled = true;
    say('Reading your orders from TCGplayer…');
    let result;
    try {
      // Read here, not in the background: a Chrome background has no HTML parser.
      result = await readOrders({ range }, {
        fetch: (...args) => window.fetch(...args),
        parseHtml: (html) => new DOMParser().parseFromString(html, 'text/html'),
        storage,
        onRetry: ({ retry, retries }) => {
          if (mounted) say(`TCGplayer did not answer. Retrying (${retry} of ${retries})\u2026`);
        },
      });
    } catch (err) {
      result = { status: 'error', error: err && err.message ? err.message : String(err), count: 0 };
    }
    syncing = false;
    if (!mounted) return;
    syncOutcome = result;
    const { text, isError, signInUrl } = describeSync(result, { range });
    say(text, isError, signInUrl);
    await draw();
  }

  select.addEventListener('change', async () => {
    range = select.value;
    remember(range);
    syncOutcome = null;
    say('');
    const archive = await draw();
    if (range !== ALL_SAVED && archive) sync();
  });

  // Refresh means "make it current": orders from TCGplayer, and today's prices past the cache.
  refresh.addEventListener('click', async () => {
    requested.clear();
    for (const key of Object.keys(results)) delete results[key];
    trendRequested.clear();
    for (const key of Object.keys(trends)) delete trends[key];
    freshPrices = true;
    await sync();
    freshPrices = false;
  });

  clear.addEventListener('click', async () => {
    const count = shown.length;
    if (!window.confirm('Remove every order saved in this browser? '
      + 'They can be read again from TCGplayer, but only while it still lists them.')) return;
    await storage.remove(ORDERS_KEY);
    say(count ? 'Cleared the saved orders.' : '');
    await draw();
  });

  // Orders saved by visiting TCGplayer's own page appear here without a refresh.
  const onChanged = (changes, area) => {
    if (area === 'local' && changes[ORDERS_KEY]) draw();
  };
  api.storage.onChanged.addListener(onChanged);

  draw().then((archive) => {
    if (!archive || range === ALL_SAVED) return;
    const last = Date.parse(archive.syncedAt[range] || '');
    if (!Number.isFinite(last) || Date.now() - last > STALE_MS) sync();
  });

  return () => {
    mounted = false;
    api.storage.onChanged.removeListener(onChanged);
    api.runtime.onMessage.removeListener(onRetryNotice);
    observer.disconnect();
  };
}
