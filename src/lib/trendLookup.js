/*
 * TCGPlayer+ — a saved item's price trend, end to end.
 * The network is injected so this is testable without a browser.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { historyUrl, parseHistory, splitConditionVariant } from './tcgplayerHistory.js';
import { computeTrend, TREND } from './priceTrend.js';

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
 * @param {{productId: string, language?: string, condition?: string}} item
 * @param {{fetchJson: (url: string) => Promise<object>, cache?: object}} deps
 */
export async function lookupTrend(item, deps) {
  if (!item || !/^\d+$/.test(String(item.productId ?? ''))) return { ...UNAVAILABLE };

  const key = trendCacheKey(item);
  const cached = deps.cache ? await deps.cache.get(key) : null;
  if (cached && cached.rules === TREND.VERSION) return cached;

  let history;
  try {
    history = parseHistory(await deps.fetchJson(historyUrl(item.productId)), item);
  } catch {
    return { ...UNAVAILABLE };
  }
  if (!history) return { ...UNAVAILABLE };

  const result = {
    ...computeTrend(history.days),
    rules: TREND.VERSION,
    sku: { skuId: history.skuId, condition: history.condition, variant: history.variant },
  };
  // Only real answers are cached; an outage should be retried, not remembered.
  if (deps.cache) await deps.cache.set(key, result);
  return result;
}
