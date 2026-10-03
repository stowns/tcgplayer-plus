/*
 * TCGPlayer+ — background page.
 * Owns the price lookups, their caches and their request pacing, so the content
 * scripts and pages stay thin and lookups for the same card are shared.
 * Opens the dashboard when the toolbar button is clicked.
 * It touches no DOM: in Chrome this runs as a service worker.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createCache, singleFlight } from './lib/cache.js';
import { createThrottle } from './lib/throttle.js';
import { createClient } from './lib/httpClient.js';
import { lookupTrend, trendCacheKey, TREND_CACHE_TTL_MS } from './lib/trendLookup.js';
import { lookupListing, listingCacheKey, LISTING_CACHE_TTL_MS } from './lib/listingLookup.js';
import { api, onMessage } from './lib/runtime.js';

const storage = api.storage.local;

// A saved list can hold hundreds of cards; keep the requests gentle. Every request
// goes through this client: paced, and retried with backoff and jitter when TCGplayer
// is slow or briefly failing.
const client = createClient({
  fetch: (...args) => fetch(...args),
  throttle: createThrottle({ concurrency: 2, minIntervalMs: 300 }),
});

// --- Telling the screen that is waiting when a lookup is being retried ------
//
// The request that asked for a lookup is answered when the lookup finishes. If it
// has to be retried first, whoever asked is told, so it can say the data is still
// on its way. `ref` is the page's own name for the thing it asked about. A content
// script is reached through its tab; an extension page (the dashboard) through
// runtime messaging, which reaches extension pages in both browsers.

const flights = new Map(); // "kind:key" -> { watchers: Map<id, {tabId, ref, extensionPage}>, last: retry info | null }
let nextWatcher = 0;

const isExtensionPage = (sender) => Boolean(sender && typeof sender.url === 'string' && sender.url.startsWith(api.runtime.getURL('')));

function tell({ tabId, extensionPage }, kind, ref, info) {
  const message = { type: 'lookup-retry', kind, ref, retry: info.retry, retries: info.retries, delayMs: info.delayMs };
  // The page may have been closed since, or nothing may be listening; nobody needs to hear about that.
  Promise.resolve()
    .then(() => (extensionPage ? api.runtime.sendMessage(message) : api.tabs.sendMessage(tabId, message)))
    .catch(() => {});
}

/**
 * Start telling `sender` about retries of this lookup; returns the function that stops.
 * A flight lasts exactly as long as its lookup (see `untilDone`), so a request that
 * arrives once the lookup is over is never told about a retry that already happened.
 */
function watch(kind, key, sender, ref) {
  const id = `${kind}:${key}`;
  const tabId = sender && sender.tab ? sender.tab.id : undefined;
  const extensionPage = isExtensionPage(sender);
  if (ref === undefined || (!extensionPage && tabId === undefined)) return () => {};
  if (!flights.has(id)) flights.set(id, { watchers: new Map(), last: null });
  const flight = flights.get(id);
  const watcher = nextWatcher++;
  const target = { tabId, ref, extensionPage };
  flight.watchers.set(watcher, target);
  // Joining a lookup that is already being retried: say so straight away.
  if (flight.last) tell(target, kind, ref, flight.last);
  return () => {
    flight.watchers.delete(watcher);
    // Nobody is waiting any more (a request that never needed a lookup, or a closed tab).
    if (!flight.watchers.size && flights.get(id) === flight) flights.delete(id);
  };
}

/** End the flight with its lookup, however the lookup ends. */
function untilDone(kind, key, lookup) {
  return lookup.finally(() => flights.delete(`${kind}:${key}`));
}

const retryNotifier = (kind, key) => (info) => {
  const flight = flights.get(`${kind}:${key}`);
  if (!flight) return;
  flight.last = info;
  for (const target of flight.watchers.values()) tell(target, kind, target.ref, info);
};

// --- TCGplayer price trends ------------------------------------------------

const trendCache = createCache({
  get: (keys) => storage.get(keys),
  set: (items) => storage.set(items),
  remove: (keys) => storage.remove(keys),
}, { ttlMs: TREND_CACHE_TTL_MS, prefix: 'tr:' });

// Two saved items that follow the same SKU share one lookup.
const lookupTrendOnce = singleFlight((key, item) => untilDone('price-trend', key, lookupTrend(item, {
  fetchJson: (url) => client.getJson(url, { onRetry: retryNotifier('price-trend', key) }),
  cache: trendCache,
})));

// --- TCGplayer current listing prices (order history) ----------------------

const listingCache = createCache({
  get: (keys) => storage.get(keys),
  set: (items) => storage.set(items),
  remove: (keys) => storage.remove(keys),
}, { ttlMs: LISTING_CACHE_TTL_MS, prefix: 'ls:' });

const lookupListingOnce = singleFlight((key, item) => untilDone('listing-price', key, lookupListing(item, {
  postJson: (url, body) => client.postJson(url, body, { onRetry: retryNotifier('listing-price', key) }),
  cache: listingCache,
})));

// A click on the toolbar button goes straight to the dashboard, which opens on the tab you used last.
api.action.onClicked.addListener(() => api.tabs.create({ url: api.runtime.getURL('home/home.html') }));

onMessage((message, sender) => {
  if (!message) return undefined;
  if (message.type === 'price-trend') {
    const item = message.item || {};
    const key = trendCacheKey(item);
    const stop = watch('price-trend', key, sender, message.ref);
    return lookupTrendOnce(key, item).catch(() => ({
      direction: 'unknown', pct: null, windowDays: null, recent: null, prior: null,
      series: [], outliersHidden: 0, reason: 'unavailable', sku: null,
    })).finally(stop);
  }
  if (message.type === 'listing-price') {
    const item = message.item || {};
    const key = listingCacheKey(item);
    const stop = watch('listing-price', key, sender, message.ref);
    return lookupListingOnce(key, item).catch(() => ({ status: 'unavailable' })).finally(stop);
  }
  if (message.type === 'open-lists') {
    return api.tabs.create({ url: api.runtime.getURL('home/home.html#lists') }).then(() => ({ opened: true }));
  }
  return undefined;
});
