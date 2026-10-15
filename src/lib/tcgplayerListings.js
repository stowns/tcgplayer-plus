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

const PRODUCT_PAGE = 'https://www.tcgplayer.com/product';

/**
 * Where that one listing can be seen and bought: the product page, narrowed to
 * its seller, condition, printing and language. The page's own first view shows
 * a featured seller, not the cheapest, so the product's plain address would not
 * show it. Empty when the listing does not say who is selling it.
 */
export function listingUrl(row) {
  if (!row || !/^\d+$/.test(String(row.productId ?? '')) || !/^[A-Za-z0-9]{1,40}$/.test(String(row.sellerKey ?? ''))) return '';
  const query = new URLSearchParams({ seller: row.sellerKey });
  for (const [name, value] of [['Condition', row.condition], ['Printing', row.printing], ['Language', row.language]]) {
    if (typeof value === 'string' && value.trim()) query.set(name, value.trim());
  }
  query.set('page', '1');
  return `${PRODUCT_PAGE}/${row.productId}?${query}`;
}

/** Is this an address made by listingUrl? Checked again before it is put in a link. */
export const isListingUrl = (url) => typeof url === 'string' && url.startsWith(`${PRODUCT_PAGE}/`) && /^https:\/\/www\.tcgplayer\.com\/product\/\d+\?seller=[A-Za-z0-9]+(&[A-Za-z]+=[^&#\s"'<>]*)*$/.test(url);

const money = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null);

/**
 * The cheapest matching listing to actually buy (item plus shipping), or null
 * when nothing is for sale or the response is not what we expect. The price
 * reported is the item price alone, which is what an order history shows;
 * shipping is reported separately, and `url` is where to see that listing.
 * @param {{productId?: string|number}} [expect] rows naming a different product are left out
 */
export function parseLowestListing(json, { productId } = {}) {
  const rows = json && Array.isArray(json.results) && json.results[0] && json.results[0].results;
  if (!Array.isArray(rows)) return null;
  let best = null;
  for (const row of rows) {
    const price = money(Number(row && row.price));
    if (price === null || row.listingType === 'custom') continue;
    // A row that says it is another product is not this card's price, whatever the feed meant by it.
    if (productId !== undefined && row.productId !== undefined && String(row.productId) !== String(productId)) continue;
    const shipping = money(Number(row.shippingPrice)) ?? 0;
    const landed = price + shipping;
    if (!best || landed < best.landed || (landed === best.landed && price < best.price)) {
      best = { price, shipping, seller: row.sellerName || '', url: listingUrl(row), landed };
    }
  }
  if (!best) return null;
  const { landed, ...lowest } = best;
  lowest.count = Number(json.results[0].totalResults) || 0;
  return lowest;
}

/**
 * Which printings a product is listed in: the listings search with no condition, asking
 * only for its tally by printing. A product page shows one printing at a time; a search
 * page shows none, so this is how the choice is offered there.
 */
export function printingsBody() {
  return {
    filters: { term: { sellerStatus: 'Live', channelId: 0, listingType: 'standard' }, range: { quantity: { gte: 1 } }, exclude: { channelExclusion: 0 } },
    from: 0,
    size: 1,
    sort: { field: 'price+shipping', order: 'asc' },
    context: { shippingCountry: 'US', cart: {} },
    aggregations: ['printing'],
  };
}

/**
 * @returns {{name: string, listings: number}[]|null} most-listed first; empty when nothing
 *   is listed; null when the response is not what we expect
 */
export function parsePrintings(json) {
  const result = json && Array.isArray(json.results) ? json.results[0] : null;
  if (!result || typeof result !== 'object') return null;
  const tally = result.aggregations && Array.isArray(result.aggregations.printing) ? result.aggregations.printing : [];
  const seen = new Map();
  for (const entry of tally) {
    const name = entry && typeof entry.value === 'string' ? entry.value.replace(/\s+/g, ' ').trim() : '';
    const listings = Number(entry && entry.count);
    if (!name || !Number.isFinite(listings) || listings <= 0) continue;
    seen.set(name, (seen.get(name) || 0) + listings);
  }
  return [...seen].map(([name, listings]) => ({ name, listings }))
    .sort((a, b) => b.listings - a.listings || a.name.localeCompare(b.name));
}
