/*
 * TCGPlayer+ — background page.
 * Owns every network request, the cache and the request pacing, so the content
 * scripts and pages stay thin and lookups for the same card are shared.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createCache, singleFlight } from './lib/cache.js';
import { createThrottle } from './lib/throttle.js';
import { lookupTrend, trendCacheKey, TREND_CACHE_TTL_MS } from './lib/trendLookup.js';
import { lookupListing, listingCacheKey, LISTING_CACHE_TTL_MS } from './lib/listingLookup.js';
import { syncOrders } from './lib/orderSync.js';
import { archiveOrders } from './lib/ordersArchive.js';

const api = globalThis.browser || globalThis.chrome;
const storage = api.storage.local;
const parser = new DOMParser();

// --- TCGplayer price trends ------------------------------------------------

const trendCache = createCache({
  get: (keys) => storage.get(keys),
  set: (items) => storage.set(items),
  remove: (keys) => storage.remove(keys),
}, { ttlMs: TREND_CACHE_TTL_MS, prefix: 'tr:' });

// A saved list can hold hundreds of cards; keep the requests gentle.
const tcgplayerThrottle = createThrottle({ concurrency: 2, minIntervalMs: 300 });

function fetchJson(url) {
  return tcgplayerThrottle.run(async () => {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`TCGplayer responded ${response.status}`);
    return response.json();
  });
}

// Two saved items that follow the same SKU share one lookup.
const lookupTrendOnce = singleFlight((_key, item) => lookupTrend(item, { fetchJson, cache: trendCache }));

// --- TCGplayer current listing prices (order history) ----------------------

const listingCache = createCache({
  get: (keys) => storage.get(keys),
  set: (items) => storage.set(items),
  remove: (keys) => storage.remove(keys),
}, { ttlMs: LISTING_CACHE_TTL_MS, prefix: 'ls:' });

function postJson(url, body) {
  return tcgplayerThrottle.run(async () => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`TCGplayer responded ${response.status}`);
    return response.json();
  });
}

const lookupListingOnce = singleFlight((_key, item) => lookupListing(item, { postJson, cache: listingCache }));

// --- TCGplayer order history (the Order History view) ----------------------

// Its own queue, so a burst of price lookups never delays reading your orders.
const orderThrottle = createThrottle({ concurrency: 1, minIntervalMs: 250 });

async function getOrderPage(url) {
  return orderThrottle.run(async () => {
    const response = await fetch(url, { credentials: 'include', redirect: 'follow', headers: { Accept: 'text/html' } });
    return { ok: response.ok, status: response.status, url: response.url, text: await response.text() };
  });
}

// What TCGplayer's own date-range dropdown sends (an AJAX form post with the page's token).
function postOrderFilter(url, body, token) {
  return orderThrottle.run(async () => {
    const response = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        __RequestVerificationToken: token,
      },
      body,
    });
    return { ok: response.ok, status: response.status };
  });
}

/** Read the orders, keep them, and say how it went. Only a complete read counts as "synced". */
async function handleSyncOrders(range) {
  const result = await syncOrders({ range }, {
    getText: getOrderPage,
    postForm: postOrderFilter,
    parseHtml: (html) => parser.parseFromString(html, 'text/html'),
  });
  let added = 0;
  let updated = 0;
  if (result.orders.length) {
    ({ added, updated } = await archiveOrders(storage, result.orders, {
      range: result.status === 'ok' && result.range ? result.range : undefined,
    }));
  }
  return {
    status: result.status, error: result.error || '', range: result.range,
    rangeApplied: result.rangeApplied, pages: result.pages, count: result.orders.length, added, updated,
  };
}

// Two tabs asking at once share one read.
const syncOrdersOnce = singleFlight((_key, range) => handleSyncOrders(range));

api.runtime.onMessage.addListener((message) => {
  if (!message) return undefined;
  // Returning a promise is the WebExtension (Firefox) way to reply async.
  if (message.type === 'price-trend') {
    const item = message.item || {};
    return lookupTrendOnce(trendCacheKey(item), item).catch(() => ({
      direction: 'unknown', pct: null, windowDays: null, recent: null, prior: null,
      series: [], outliersHidden: 0, reason: 'unavailable', sku: null,
    }));
  }
  if (message.type === 'listing-price') {
    const item = message.item || {};
    return lookupListingOnce(listingCacheKey(item), item).catch(() => ({ status: 'unavailable' }));
  }
  if (message.type === 'sync-orders') {
    return syncOrdersOnce(String(message.range || ''), message.range || undefined)
      .catch((err) => ({ status: 'error', error: String(err && err.message ? err.message : err), count: 0, added: 0, updated: 0 }));
  }
  if (message.type === 'open-lists') {
    return api.tabs.create({ url: api.runtime.getURL('home/home.html#lists') }).then(() => ({ opened: true }));
  }
  return undefined;
});
