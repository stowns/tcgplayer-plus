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
 * @param {{productId: string, condition?: string, orSealed?: boolean}} item  `orSealed`: when nothing is
 *   listed in `condition`, look among unopened (sealed) copies too, at the cost of a second request
 * @param {{postJson: (url: string, body: object) => Promise<object>, now?: () => number}} deps
 * @returns {Promise<{status: 'ok', price: number, shipping: number, seller: string, count: number, checkedAt: number}
 *   | {status: 'none', checkedAt: number} | {status: 'unavailable'}>}
 */
export async function lookupListing(item, deps) {
  if (!item || !/^\d+$/.test(String(item.productId ?? ''))) return { status: 'unavailable' };

  const ask = async (condition) => {
    const json = await deps.postJson(listingsUrl(item.productId), listingsBody(condition));
    if (!json || !Array.isArray(json.results)) throw new Error('not the listings feed');
    return parseLowestListing(json);
  };

  let lowest;
  try {
    lowest = await ask(item.condition);
    // A sealed product has no Near Mint copies; when the caller could not tell which it
    // is, and nothing came back, look among the unopened ones before saying "none".
    if (!lowest && item.orSealed) {
      const { variant } = splitConditionVariant(item.condition);
      lowest = await ask(['Unopened', variant].filter(Boolean).join(' '));
    }
  } catch {
    return { status: 'unavailable' };
  }

  const checkedAt = (deps.now || Date.now)();
  return lowest ? { status: 'ok', ...lowest, checkedAt } : { status: 'none', checkedAt };
}
