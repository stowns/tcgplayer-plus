/*
 * TCGPlayer+ — TCGplayer's live listings (the lowest price you could pay today).
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { splitConditionVariant } from './tcgplayerHistory.js';

const HOST = 'https://mp-search-api.tcgplayer.com';

export function listingsUrl(productId) {
  if (!/^\d+$/.test(String(productId ?? ''))) throw new Error(`Not a TCGplayer product id: ${productId}`);
  return `${HOST}/v1/product/${productId}/listings`;
}

/**
 * The same query the product page makes: live seller listings, cheapest first
 * counting shipping (a $1 card with $20 postage is not really the cheapest),
 * narrowed to one condition and printing. "custom" listings (a seller's own
 * photo of one particular copy) are left out, as the page's headline price does.
 * `text` is the order page's phrase, e.g. "Near Mint Holofoil".
 */
export function listingsBody(text, { size = 5 } = {}) {
  const { condition, variant } = splitConditionVariant(text);
  const term = { sellerStatus: 'Live', channelId: 0, listingType: 'standard' };
  if (condition) term.condition = [condition];
  if (variant) term.printing = [variant];
  return {
    filters: { term, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } },
    from: 0,
    size,
    sort: { field: 'price+shipping', order: 'asc' },
    context: { shippingCountry: 'US', cart: {} },
    aggregations: ['listingType'],
  };
}

const money = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null);

/**
 * The cheapest matching listing to actually buy (item plus shipping), or null
 * when nothing is for sale or the response is not what we expect. The price
 * reported is the item price alone, which is what an order history shows;
 * shipping is reported separately.
 */
export function parseLowestListing(json) {
  const rows = json && Array.isArray(json.results) && json.results[0] && json.results[0].results;
  if (!Array.isArray(rows)) return null;
  let best = null;
  for (const row of rows) {
    const price = money(Number(row && row.price));
    if (price === null || row.listingType === 'custom') continue;
    const shipping = money(Number(row.shippingPrice)) ?? 0;
    const landed = price + shipping;
    if (!best || landed < best.landed || (landed === best.landed && price < best.price)) {
      best = { price, shipping, seller: row.sellerName || '', landed };
    }
  }
  if (!best) return null;
  const { landed, ...lowest } = best;
  lowest.count = Number(json.results[0].totalResults) || 0;
  return lowest;
}
