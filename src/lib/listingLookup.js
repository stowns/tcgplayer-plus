/*
 * TCGPlayer+ — a purchased item's current listing price, end to end.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { listingsUrl, listingsBody, parseLowestListing } from './tcgplayerListings.js';
import { splitConditionVariant } from './tcgplayerHistory.js';

/**
 * Ten minutes. Cheap cards are listed and sold within the hour, so an older
 * answer can name a listing that is already gone; but an order history opened a
 * few times in one sitting should not ask again each time.
 */
export const LISTING_CACHE_TTL_MS = 10 * 60 * 1000;

/** One entry per product and condition, however many orders contain it. */
export function listingCacheKey({ productId, condition } = {}) {
  const { condition: c, variant } = splitConditionVariant(condition);
  return [productId, c, variant].map((p) => String(p ?? '').toLowerCase()).join('|');
}

/**
 * @param {{productId: string, condition?: string, fresh?: boolean}} item  `fresh` skips the cache
 *   (the answer is still stored for the next caller)
 * @param {{postJson: (url: string, body: object) => Promise<object>, cache?: object, now?: () => number}} deps
 * @returns {Promise<{status: 'ok', price: number, shipping: number, seller: string, count: number, checkedAt: number}
 *   | {status: 'none', checkedAt: number} | {status: 'unavailable'}>}
 */
export async function lookupListing(item, deps) {
  if (!item || !/^\d+$/.test(String(item.productId ?? ''))) return { status: 'unavailable' };

  const key = listingCacheKey(item);
  const cached = deps.cache && !item.fresh ? await deps.cache.get(key) : null;
  if (cached) return cached;

  let json;
  try {
    json = await deps.postJson(listingsUrl(item.productId), listingsBody(item.condition));
  } catch {
    return { status: 'unavailable' };
  }
  if (!json || !Array.isArray(json.results)) return { status: 'unavailable' };

  const lowest = parseLowestListing(json);
  const checkedAt = (deps.now || Date.now)();
  const result = lowest ? { status: 'ok', ...lowest, checkedAt } : { status: 'none', checkedAt };
  // An outage is retried next time; "nobody is selling it" is a real answer.
  if (deps.cache) await deps.cache.set(key, result);
  return result;
}
