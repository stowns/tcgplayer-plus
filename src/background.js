/*
 * TCGPlayer+ — background page.
 * Owns the price lookups, their caches and their request pacing, so the content
 * scripts and pages stay thin and lookups for the same card are shared.
 * It touches no DOM: in Chrome this runs as a service worker.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createCache, singleFlight } from './lib/cache.js';
import { createThrottle } from './lib/throttle.js';
import { lookupTrend, trendCacheKey, TREND_CACHE_TTL_MS } from './lib/trendLookup.js';
import { lookupListing, listingCacheKey, LISTING_CACHE_TTL_MS } from './lib/listingLookup.js';
import { api, onMessage } from './lib/runtime.js';

const storage = api.storage.local;

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

onMessage((message) => {
  if (!message) return undefined;
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
  if (message.type === 'open-lists') {
    return api.tabs.create({ url: api.runtime.getURL('home/home.html#lists') }).then(() => ({ opened: true }));
  }
  return undefined;
});
