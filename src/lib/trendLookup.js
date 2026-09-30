/*
 * TCGPlayer+ — a saved item's price trend, end to end.
 * The network is injected so this is testable without a browser.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { historyUrl, parseHistory, splitConditionVariant } from './tcgplayerHistory.js';
import { computeTrend } from './priceTrend.js';

/**
 * Six hours. Buckets are daily, so an answer this old is still the same story,
 * and a lists page re-opened during the day should not hit TCGplayer again.
 */
export const TREND_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

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
  if (cached) return cached;

  let history;
  try {
    history = parseHistory(await deps.fetchJson(historyUrl(item.productId)), item);
  } catch {
    return { ...UNAVAILABLE };
  }
  if (!history) return { ...UNAVAILABLE };

  const result = {
    ...computeTrend(history.days),
    sku: { skuId: history.skuId, condition: history.condition, variant: history.variant },
  };
  // Only real answers are cached; an outage should be retried, not remembered.
  if (deps.cache) await deps.cache.set(key, result);
  return result;
}
