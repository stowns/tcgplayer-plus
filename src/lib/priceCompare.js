/*
 * TCGPlayer+ — paid versus price today.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { isRetrying } from './retryState.js';

/** Under a cent, or under a percent of the price paid, is not worth an arrow. */
export const SAME_BAND = 0.01;

/**
 * @param {number} paid    what was paid per item
 * @param {number} current the lowest price on sale now
 * @returns {{direction: 'higher'|'lower'|'same', diff: number, pct: number}|null}
 *   `diff` and `pct` are signed: negative when it now costs less than was paid.
 */
export function comparePrice(paid, current) {
  if (!Number.isFinite(paid) || paid <= 0 || !Number.isFinite(current) || current <= 0) return null;
  const diff = Math.round((current - paid) * 100) / 100;
  const pct = diff / paid;
  const direction = Math.abs(diff) < 0.005 || Math.abs(pct) < SAME_BAND
    ? 'same'
    : diff > 0 ? 'higher' : 'lower';
  return { direction, diff, pct };
}

/**
 * What a set of purchases would be worth at today's prices, against what was
 * paid. Only lines with a usable price paid and a live listing are counted, and
 * the rest are reported so a total is never mistaken for the whole page.
 *
 * @param {{paid: number|null, quantity?: number, result: {status: string, price?: number}|null}[]} lines
 * @returns {{direction: string, diff: number, pct: number, paid: number, now: number,
 *   counted: number, missing: number, pending: number, retrying: number}|null} null when nothing could be priced
 */
export function totalChange(lines) {
  let paid = 0;
  let now = 0;
  let counted = 0;
  let missing = 0;
  let pending = 0;
  let retrying = 0;
  for (const { paid: each, quantity = 1, result } of lines) {
    if (!result) { pending += 1; continue; }
    // Being retried is still waiting for an answer, not an answer of "no price".
    if (isRetrying(result)) { pending += 1; retrying += 1; continue; }
    if (result.status !== 'ok' || !Number.isFinite(each) || each <= 0) { missing += 1; continue; }
    const units = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    paid += each * units;
    now += result.price * units;
    counted += 1;
  }
  if (counted === 0) return null;
  const comparison = comparePrice(paid, now);
  return { ...comparison, paid: Math.round(paid * 100) / 100, now: Math.round(now * 100) / 100, counted, missing, pending, retrying };
}
