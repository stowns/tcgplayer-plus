/*
 * TCGPlayer+ — a product's current listing price (its Ask), end to end.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { listingsUrl, listingsBody, parseLowestListing } from './tcgplayerListings.js';
import { splitConditionVariant } from './tcgplayerHistory.js';

/**
 * One key per product and condition, however many orders or lists hold it:
 * lookups that overlap are shared by it, and screens match answers to rows by it.
 */
export function listingCacheKey({ productId, condition } = {}) {
  const { condition: c, variant } = splitConditionVariant(condition);
  return [productId, c, variant].map((p) => String(p ?? '').toLowerCase()).join('|');
}

/**
 * The cheapest live listing, asked for afresh every time: a price that is a few
 * minutes old is no use to someone waiting for it to reach a target. Lookups for
 * the same card that overlap are shared by the caller (see background.js).
 * @param {{productId: string, condition?: string}} item
 * @param {{postJson: (url: string, body: object) => Promise<object>, now?: () => number}} deps
 * @returns {Promise<{status: 'ok', price: number, shipping: number, seller: string, count: number, checkedAt: number}
 *   | {status: 'none', checkedAt: number} | {status: 'unavailable'}>}
 */
export async function lookupListing(item, deps) {
  if (!item || !/^\d+$/.test(String(item.productId ?? ''))) return { status: 'unavailable' };

  let json;
  try {
    json = await deps.postJson(listingsUrl(item.productId), listingsBody(item.condition));
  } catch {
    return { status: 'unavailable' };
  }
  if (!json || !Array.isArray(json.results)) return { status: 'unavailable' };

  const lowest = parseLowestListing(json);
  const checkedAt = (deps.now || Date.now)();
  return lowest ? { status: 'ok', ...lowest, checkedAt } : { status: 'none', checkedAt };
}
