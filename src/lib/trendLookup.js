/*
 * TCGPlayer+ — a saved item's price trend, end to end.
 * The network is injected so this is testable without a browser.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { historyUrl, parseHistory, splitConditionVariant } from './tcgplayerHistory.js';
import { computeTrend, computeLongTrend, hasLongTrend, TREND } from './priceTrend.js';

/**
 * One hour. TCGplayer's own response is cacheable for an hour (`max-age=3600`), so
 * asking again sooner would only get the same answer back. The newest day is
 * still filling up, which is why it is not longer.
 */
export const TREND_CACHE_TTL_MS = 60 * 60 * 1000;

const UNAVAILABLE = {
  direction: 'unknown', pct: null, windowDays: null, recent: null, prior: null,
  latest: null, turning: null, series: [], outliersHidden: 0, reason: 'unavailable', sku: null,
};

/** One entry per SKU followed, however many saved items point at it. */
export function trendCacheKey({ productId, language, condition } = {}) {
  const { condition: c, variant } = splitConditionVariant(condition);
  return [productId, language || 'English', c, variant].map((p) => String(p ?? '').toLowerCase()).join('|');
}

/**
 * Add the 30-day window to a trend, from the 90-day history. A second request, so it
 * is only made when that duration is wanted. An outage is marked on the window and
 * not remembered, so the next lookup tries again.
 * @returns {Promise<{trend: object, complete: boolean}>} `complete` when the answer is worth caching
 */
async function withLongTrend(trend, item, deps) {
  let history = null;
  let failed = false;
  try {
    history = parseHistory(await deps.fetchJson(historyUrl(item.productId, 'quarter')), item);
  } catch {
    failed = true;
  }
  const long = history ? computeLongTrend(history.days) : null;
  if (failed || !history) {
    const window = { windowDays: TREND.LONG_DURATION, direction: 'unknown', pct: null, recent: null, prior: null, reason: 'unavailable' };
    return { trend: { ...trend, windows: { ...trend.windows, [TREND.LONG_DURATION]: window } }, complete: false };
  }
  const window = long ? long.window
    : { windowDays: TREND.LONG_DURATION, direction: 'unknown', pct: null, recent: null, prior: null, reason: 'not-enough-sales' };
  return {
    trend: {
      ...trend,
      windows: { ...trend.windows, [TREND.LONG_DURATION]: window },
      longSeries: long ? long.series : [],
      longAsOf: long ? long.asOf : trend.asOf,
    },
    complete: true,
  };
}

/**
 * @param {{productId: string, language?: string, condition?: string, long?: boolean}} item
 *   `long` asks for the 30-day window as well, which costs a second request the first time
 * @param {{fetchJson: (url: string) => Promise<object>, cache?: object}} deps
 */
export async function lookupTrend(item, deps) {
  if (!item || !/^\d+$/.test(String(item.productId ?? ''))) return { ...UNAVAILABLE };

  const key = trendCacheKey(item);
  const cached = deps.cache ? await deps.cache.get(key) : null;
  let result = cached && cached.rules === TREND.VERSION ? cached : null;

  if (!result) {
    let history;
    try {
      history = parseHistory(await deps.fetchJson(historyUrl(item.productId)), item);
    } catch {
      return { ...UNAVAILABLE };
    }
    if (!history) return { ...UNAVAILABLE };

    result = {
      ...computeTrend(history.days),
      rules: TREND.VERSION,
      sku: { skuId: history.skuId, condition: history.condition, variant: history.variant },
    };
    // Only real answers are cached; an outage should be retried, not remembered.
    if (deps.cache) await deps.cache.set(key, result);
  }

  // A card with no sales at all has no windows; ninety days of the same would add nothing.
  if (!item.long || !result.windows || hasLongTrend(result)) return result;
  const { trend, complete } = await withLongTrend(result, item, deps);
  if (complete && deps.cache) await deps.cache.set(key, trend);
  return trend;
}
