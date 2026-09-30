/*
 * TCGPlayer+ — what an item really costs: price plus shipping.
 *
 * An order history shows each item's price and the order's shipping apart, and a
 * product page shows a listing's price and its shipping apart. Comparing like
 * with like means adding shipping on both sides (tax is left out: it depends on
 * where you live, not on the card).
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const cents = (n) => Math.round(n * 100) / 100;

/**
 * Each item's share of the order's shipping, per unit. Shipping is charged per
 * parcel, not per card, so it is spread in proportion to what each line cost.
 * @param {{shipping: number|null}} summary the order's summary
 * @param {{paid: number|null, quantity?: number}[]} items
 * @returns {number[]} one entry per item; 0 where it cannot be worked out
 */
export function allocateShipping(summary, items) {
  const shipping = summary && Number.isFinite(summary.shipping) && summary.shipping > 0 ? summary.shipping : 0;
  const list = Array.isArray(items) ? items : [];
  const priced = list.map((i) => (Number.isFinite(i && i.paid) && i.paid > 0 ? i.paid : 0));
  const total = list.reduce((sum, item, at) => sum + priced[at] * (item.quantity > 0 ? item.quantity : 1), 0);
  if (!shipping || total <= 0) return list.map(() => 0);
  // Per unit: a line's share of the shipping, divided by its quantity, is shipping x price / order value.
  return priced.map((paid) => cents((shipping * paid) / total));
}

/** What buying it today costs: the cheapest listing's price plus its shipping. */
export function landedNow(result) {
  if (!result || result.status !== 'ok' || !Number.isFinite(result.price)) return null;
  return cents(result.price + (Number.isFinite(result.shipping) && result.shipping > 0 ? result.shipping : 0));
}

/** What one unit cost you: its price plus its share of the order's shipping. */
export function landedPaid(paid, share = 0) {
  return Number.isFinite(paid) ? cents(paid + (Number.isFinite(share) ? share : 0)) : null;
}

/**
 * A line for `totalChange`, on price-plus-shipping for both sides.
 * @param {{paid: number|null, quantity?: number}} item
 * @param {number} share the item's share of its order's shipping, per unit
 * @param {object|null} result a listing lookup result (null while loading)
 */
export function costLine(item, share, result) {
  const now = landedNow(result);
  return {
    paid: landedPaid(item.paid, share),
    quantity: item.quantity,
    result: now === null ? result : { ...result, price: now },
  };
}
