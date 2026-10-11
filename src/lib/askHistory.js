/*
 * TCGPlayer+ — a record of each card's Ask, so a change in it can be shown.
 *
 * A card that is not selling has no sales for a trend to move on, but its
 * cheapest listing still rises and falls, and that is news about the market.
 * Every Ask that is looked up is noted here. Only two prices are kept for a
 * card: the current Ask and the different one before it, which is all it takes
 * to say whether it is now higher or lower. A price that is seen again just has
 * its "last seen" moved on.
 *
 * It is what this browser saw when it looked, not every price the card had:
 * nothing is recorded while no page is asking.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { landedNow } from './orderCost.js';

/** One storage entry per card and condition, so recording one never rewrites the rest. */
export const ASK_HISTORY_PREFIX = 'ah:';
/** The current Ask and the one before it; anything older is dropped. */
export const MAX_POINTS = 2;
/** A card nobody has looked at for this long is forgotten. */
export const MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000;
/** A price seen again is only written down again this often; in between, nothing has changed. */
export const SEEN_WRITE_MS = 60 * 60 * 1000;

export const askHistoryKey = (listingKey) => `${ASK_HISTORY_PREFIX}${listingKey}`;

const cents = (value) => Math.round(value * 100) / 100;
const money = (value) => (Number.isFinite(value) && value >= 0 ? cents(value) : null);

function sanitizePoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = money(raw.total);
  const at = Number(raw.at);
  if (total === null || total <= 0 || !Number.isFinite(at)) return null;
  const seen = Number(raw.seen);
  return {
    at,
    seen: Number.isFinite(seen) && seen >= at ? seen : at,
    total,
    price: money(raw.price) ?? total,
    shipping: money(raw.shipping) ?? 0,
  };
}

/** The points of a stored entry, oldest first; anything unreadable is left out. */
export function sanitizePoints(raw) {
  const list = raw && Array.isArray(raw.points) ? raw.points : [];
  return list.map(sanitizePoint).filter(Boolean).sort((a, b) => a.at - b.at).slice(-MAX_POINTS);
}

/**
 * Note an Ask that was just looked up.
 * @param {ReturnType<typeof sanitizePoints>} points what is recorded so far, oldest first
 * @param {{status: string, price?: number, shipping?: number}} ask
 * @returns {{points: object[], changed: boolean, write: boolean}} `changed` when the price differs
 *   from the last one recorded; `write` when the record is worth saving
 */
export function recordAsk(points, ask, now = Date.now()) {
  const total = landedNow(ask);
  // No price (nothing listed, or the lookup failed) is not a price of zero: nothing to note.
  if (total === null) return { points, changed: false, write: false };
  const last = points[points.length - 1];
  if (last && last.total === total) {
    const write = now - last.seen >= SEEN_WRITE_MS;
    return { points: [...points.slice(0, -1), { ...last, seen: now }], changed: false, write };
  }
  const point = { at: now, seen: now, total, price: cents(ask.price), shipping: money(ask.shipping) ?? 0 };
  return { points: [...points, point].slice(-MAX_POINTS), changed: Boolean(last), write: true };
}

/**
 * How the Ask stands against the different one before it.
 * @returns {{direction: 'up'|'down', pct: number, diff: number, previous: number} | {direction: 'flat'} | null}
 *   Flat when it is the only price recorded; null when nothing is.
 */
export function askChange(points) {
  const current = points[points.length - 1];
  if (!current) return null;
  const before = points[points.length - 2];
  if (!before) return { direction: 'flat' };
  const diff = cents(current.total - before.total);
  return {
    direction: diff > 0 ? 'up' : 'down',
    diff,
    pct: Math.round((current.total / before.total - 1) * 10000) / 10000,
    previous: before.total,
  };
}

/**
 * Record an Ask in storage and say how it stands against the one before.
 * @param {{get: Function, set: Function}} storage
 * @param {string} listingKey the card and condition (see listingCacheKey)
 * @returns {Promise<ReturnType<typeof askChange>>}
 */
export async function noteAsk(storage, listingKey, ask, now = Date.now()) {
  const key = askHistoryKey(listingKey);
  const bag = await storage.get(key);
  const before = sanitizePoints(bag ? bag[key] : null);
  const { points, write } = recordAsk(before, ask, now);
  if (write) await storage.set({ [key]: { points } });
  return askChange(points);
}

/** The stored entries nobody has looked at for MAX_AGE_MS; for removal. */
export function staleAskKeys(all, now = Date.now()) {
  return Object.keys(all || {}).filter((key) => {
    if (!key.startsWith(ASK_HISTORY_PREFIX)) return false;
    const points = sanitizePoints(all[key]);
    const last = points[points.length - 1];
    return !last || now - last.seen > MAX_AGE_MS;
  });
}
