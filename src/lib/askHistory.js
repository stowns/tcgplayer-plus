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
 * An earlier Ask is only compared with once it has been judged against what the
 * card actually sold for. Listings appear at absurd prices (a seller's mistake,
 * withdrawn or cancelled before anyone is sold it), and a $33 card set against a
 * $4 listing would read "+663%" for as long as its real price stayed put. So an
 * earlier Ask far below the cheapest sale of the last month is taken for such a
 * mistake and dropped. One that was bought is, by that fact, among the sales,
 * and is kept however briefly it was listed; so is a seller's ordinary change of
 * price. A card with no sales to judge by has every Ask believed.
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
/** An earlier Ask under this fraction of the cheapest sale of the last month is taken for a mistake. */
export const MISTAKE_BELOW = 0.5;

export const askHistoryKey = (listingKey) => `${ASK_HISTORY_PREFIX}${listingKey}`;

const cents = (value) => Math.round(value * 100) / 100;
const money = (value) => (Number.isFinite(value) && value >= 0 ? cents(value) : null);

function sanitizePoint(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const total = money(raw.total);
  const at = Number(raw.at);
  if (total === null || total <= 0 || !Number.isFinite(at)) return null;
  const seen = Number(raw.seen);
  const point = {
    at,
    seen: Number.isFinite(seen) && seen >= at ? seen : at,
    total,
    price: money(raw.price) ?? total,
    shipping: money(raw.shipping) ?? 0,
  };
  // Judged against the card's sales and believed; absent until it has been.
  if (raw.vetted === true) point.vetted = true;
  return point;
}

/** The points of a stored entry, oldest first; anything unreadable is left out. */
export function sanitizePoints(raw) {
  const list = raw && Array.isArray(raw.points) ? raw.points : [];
  return list.map(sanitizePoint).filter(Boolean).sort((a, b) => a.at - b.at).slice(-MAX_POINTS);
}

/**
 * Note an Ask that was just looked up. A new price is added after the ones already
 * there, so for a moment there can be three: the earlier ones are judged (see
 * `settle`) before the record is cut back to two.
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
  return { points: [...points, point], changed: Boolean(last), write: true };
}

/**
 * Was this Ask a mistake rather than a price: far below anything the card sold for?
 * @param {number|null|undefined} lowestSale the cheapest sale of the last month, with shipping
 */
export const isMistake = (point, lowestSale) => Number.isFinite(lowestSale) && lowestSale > 0
  && point.total < lowestSale * MISTAKE_BELOW;

/** Is there an earlier Ask that has not yet been judged against the card's sales? */
export const needsVetting = (points) => points.slice(0, -1).some((point) => !point.vetted);

/**
 * Judge the earlier Asks against what the card sold for: drop the mistakes, mark the
 * rest as believed. The current Ask is never judged; it is what the card costs now.
 * @param {number|null|undefined} lowestSale the cheapest sale of the last month with shipping;
 *   null when the card had no sales to judge by (every Ask is believed); undefined when the
 *   sales could not be read (nothing is judged yet, and nothing is dropped)
 * @returns {object[]} at most MAX_POINTS, oldest first
 */
export function settle(points, lowestSale) {
  const judged = [];
  points.forEach((point, index) => {
    const current = index === points.length - 1;
    if (current || point.vetted || lowestSale === undefined) { judged.push(point); return; }
    if (isMistake(point, lowestSale)) return;
    judged.push({ ...point, vetted: true });
  });
  // With a mistake taken out, the prices either side of it may be one and the same.
  const merged = [];
  for (const point of judged) {
    const before = merged[merged.length - 1];
    if (before && before.total === point.total) merged[merged.length - 1] = { ...before, seen: Math.max(before.seen, point.seen) };
    else merged.push(point);
  }
  return merged.slice(-MAX_POINTS);
}

/**
 * How the Ask stands against the different one before it.
 * @returns {{direction: 'up'|'down', pct: number, diff: number, previous: number} | {direction: 'flat'} | null}
 *   Flat when there is no earlier Ask that has been judged and believed; null when nothing is recorded.
 */
export function askChange(points) {
  const current = points[points.length - 1];
  if (!current) return null;
  const before = points[points.length - 2];
  if (!before || !before.vetted) return { direction: 'flat' };
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
 * @param {{now?: number, lowestSale?: () => Promise<number|null|undefined>}} [options] `lowestSale`
 *   is asked only when there is an earlier Ask still to judge (see `settle` for what it returns)
 * @returns {Promise<ReturnType<typeof askChange>>}
 */
export async function noteAsk(storage, listingKey, ask, { now = Date.now(), lowestSale } = {}) {
  const key = askHistoryKey(listingKey);
  const bag = await storage.get(key);
  const before = sanitizePoints(bag ? bag[key] : null);
  let { points, write } = recordAsk(before, ask, now);
  if (needsVetting(points)) {
    let floor;
    try {
      floor = lowestSale ? await lowestSale() : undefined;
    } catch {
      floor = undefined;
    }
    const settled = settle(points, floor);
    if (JSON.stringify(settled) !== JSON.stringify(points)) write = true;
    points = settled;
  } else {
    points = points.slice(-MAX_POINTS);
  }
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
