/*
 * TCGPlayer+ — what buying every card on a watch list would cost today.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { landedNow } from './orderCost.js';
import { askKey } from './listsSort.js';
import { isRetrying } from './retryState.js';

const cents = (value) => Math.round(value * 100) / 100;

/**
 * The sum of each card's Ask: its cheapest live listing, price plus shipping. A
 * card with no Ask yet, or none at all, is counted apart, so a total is never
 * mistaken for the whole list when it is not.
 * @param {object[]} items the list's cards
 * @param {Record<string, object>} asks what has been looked up, by ask key
 * @returns {{total: number, items: number, priced: number, pending: number, missing: number}}
 *   `pending` are still being looked up; `missing` have nothing listed or could not be read
 */
export function listTotal(items, asks = {}) {
  let total = 0;
  let priced = 0;
  let pending = 0;
  let missing = 0;
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    const ask = asks[askKey(item)];
    if (!ask || isRetrying(ask)) { pending += 1; continue; }
    const landed = landedNow(ask);
    if (landed === null) { missing += 1; continue; }
    total += landed;
    priced += 1;
  }
  return { total: cents(total), items: list.length, priced, pending, missing };
}
