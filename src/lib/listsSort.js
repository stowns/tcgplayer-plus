/*
 * TCGPlayer+ — ordering the items in saved lists.
 * Pure functions: the trend data is passed in, never fetched here.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { volatility } from './priceTrend.js';
import { landedNow } from './orderCost.js';
import { listingCacheKey } from './listingLookup.js';

/** `dir` is what you get when you first choose the sort: newest, dearest, most volatile first. */
export const SORTS = [
  { key: 'added', label: 'Date added', dir: 'desc' },
  { key: 'ask', label: 'Ask', dir: 'desc' },
  { key: 'volatility', label: 'Volatility', dir: 'desc' },
];

export const DEFAULT_SORT = { key: 'added', dir: 'desc' };

/**
 * What a sort needs fetched for every card in the list before it can be right:
 * the price history (volatility) or the cheapest live listing (ask).
 */
export const needsHistory = (key) => key === 'volatility';
export const needsAsk = (key) => key === 'ask';

/** The key under which a card's ask is looked up and shared. */
export const askKey = (item) => listingCacheKey({
  productId: item.productId,
  condition: item.priceAtSave ? item.priceAtSave.condition : '',
});

/** Read a saved choice defensively; anything unexpected is the default. */
export function parseSort(raw) {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const known = SORTS.find((s) => value && s.key === value.key);
    if (!known) return { ...DEFAULT_SORT };
    return { key: known.key, dir: value.dir === 'asc' || value.dir === 'desc' ? value.dir : known.dir };
  } catch {
    return { ...DEFAULT_SORT };
  }
}

/** The direction a sort starts in when it is chosen. */
export const defaultDirection = (key) => (SORTS.find((s) => s.key === key) || SORTS[0]).dir;

/**
 * The number an item is ordered by, or null when it has none yet.
 *
 * Ask is what buying it today costs: the cheapest live listing's price
 * plus its shipping (TCGplayer's featured listing), not TCGplayer's own "Market
 * Price", which is a calculation over past sales. There is no stand-in while it
 * loads: a card with no ask yet goes last.
 * @param {{trends?: object, asks?: object}} data lookups by item key (trends) and ask key (asks)
 */
export function sortValue(item, key, data = {}) {
  switch (key) {
    case 'added': {
      const at = Date.parse(item.savedAt || '');
      return Number.isFinite(at) ? at : null;
    }
    case 'ask':
      return landedNow((data.asks || {})[askKey(item)]);
    case 'volatility': {
      const trend = (data.trends || {})[item.key];
      return trend ? volatility(trend.series) : null;
    }
    default:
      return null;
  }
}

/**
 * A new array, ordered. Items with no value go last whichever way it is sorted,
 * and ties keep the order the list already had (so a sort never shuffles equals).
 * @param {object[]} items
 * @param {{key: string, dir: 'asc'|'desc'}} sort
 * @param {{trends?: Record<string, object>, asks?: Record<string, object>}} data what has been looked up
 */
export function sortItems(items, sort, data = {}) {
  const { key, dir } = parseSort(sort);
  const sign = dir === 'asc' ? 1 : -1;
  return items
    .map((item, index) => ({ item, index, value: sortValue(item, key, data) }))
    .sort((a, b) => {
      if (a.value === null && b.value === null) return a.index - b.index;
      if (a.value === null) return 1;
      if (b.value === null) return -1;
      return (a.value - b.value) * sign || a.index - b.index;
    })
    .map((entry) => entry.item);
}

const DIRECTION_LABELS = {
  added: { desc: 'Newest first', asc: 'Oldest first' },
  ask: { desc: 'Highest first', asc: 'Lowest first' },
  volatility: { desc: 'Most volatile first', asc: 'Steadiest first' },
};

/** What the direction button says for this sort. */
export function directionLabel(key, dir) {
  const labels = DIRECTION_LABELS[key] || DIRECTION_LABELS.added;
  return dir === 'asc' ? labels.asc : labels.desc;
}
