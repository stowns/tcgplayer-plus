/*
 * TCGPlayer+ — which list is showing, and which page of it.
 * Pure: the Saved Lists view keeps the state and calls these.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const PAGE_SIZES = [25, 50, 75, 'all'];
export const DEFAULT_PAGE_SIZE = 25;

/** A stored or chosen size, or the default if it is not one we offer. */
export function parsePageSize(raw) {
  if (raw === 'all') return 'all';
  const n = Number(raw);
  return PAGE_SIZES.includes(n) ? n : DEFAULT_PAGE_SIZE;
}

/**
 * One page of `items` (already in the order to be shown). The page is clamped, so
 * a stale page number after removing cards lands on the last real page.
 * @returns {{items: any[], page: number, pages: number, from: number, to: number, total: number, size: number|'all'}}
 *   `from`/`to` are 1-based and inclusive; both are 0 for an empty list.
 */
export function pageOf(items, { page = 1, size = DEFAULT_PAGE_SIZE } = {}) {
  const total = items.length;
  const sz = parsePageSize(size);
  if (sz === 'all' || total === 0) {
    return { items: items.slice(), page: 1, pages: 1, from: total ? 1 : 0, to: total, total, size: sz };
  }
  const pages = Math.ceil(total / sz);
  const current = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
  const start = (current - 1) * sz;
  const slice = items.slice(start, start + sz);
  return { items: slice, page: current, pages, from: start + 1, to: start + slice.length, total, size: sz };
}

/** The list to show: the one asked for if it still exists, otherwise the first; null when there are none. */
export function resolveSelection(lists, id) {
  return lists.find((l) => l.id === id) || lists[0] || null;
}
