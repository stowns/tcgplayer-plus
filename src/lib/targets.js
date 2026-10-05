/*
 * TCGPlayer+ — price targets on watch-list products.
 *
 * A target says "tell me when this can be bought for $X or less" (a buyer) or
 * "…when it reaches $X or more" (a seller). It is compared with the Ask: the
 * cheapest live listing, price plus shipping, which is what the list shows.
 *
 * A target belongs to the product (the item key: product and language), not to one
 * list, so the same card in two lists has one target.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { landedNow } from './orderCost.js';
import { formatMoney } from './money.js';

export const TARGETS_KEY = 'targets';
export const DIRECTIONS = ['below', 'above'];
const MAX_PRICE = 10_000_000;

const cents = (value) => Math.round(value * 100) / 100;
// At least a cent once rounded: a target of $0.00 could never be told apart from no target.
const validPrice = (value) => (Number.isFinite(value) && cents(value) > 0 && value <= MAX_PRICE ? cents(value) : null);

/** What someone typed ("$12.50", "12.5", ".91", "1,200") as a price, or null if it is not one. */
export function parseTargetPrice(text) {
  if (typeof text === 'number') return validPrice(text);
  // The whole of what was typed must be a number: "12abc" is a mistake, not twelve dollars.
  const clean = String(text ?? '').replace(/[$,\s]/g, '');
  return /^(\d+\.?\d*|\.\d+)$/.test(clean) ? validPrice(Number(clean)) : null;
}

function sanitizeTarget(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const price = validPrice(Number(raw.price));
  if (price === null) return null;
  const str = (v) => (typeof v === 'string' ? v.slice(0, 40) : '');
  return {
    price,
    direction: DIRECTIONS.includes(raw.direction) ? raw.direction : 'below',
    // On unless it was turned off.
    notify: raw.notify !== false,
    met: raw.met === true,
    // A notification that is owed: the target was met and nobody has been told yet.
    pending: raw.pending === true,
    updatedAt: str(raw.updatedAt),
    notifiedAt: str(raw.notifiedAt),
  };
}

/** @returns {Record<string, object>} targets by item key; anything damaged is dropped */
export function sanitizeTargets(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    const target = sanitizeTarget(value);
    if (target && key) out[key] = target;
  }
  return out;
}

export async function loadTargets(storage) {
  const bag = await storage.get(TARGETS_KEY);
  return sanitizeTargets(bag ? bag[TARGETS_KEY] : null);
}

export async function saveTargets(storage, targets) {
  const clean = sanitizeTargets(targets);
  await storage.set({ [TARGETS_KEY]: clean });
  return clean;
}

/**
 * Set or change a product's target. Any change starts it afresh: it is treated as
 * not yet met, so a target that is already met will notify on the next check.
 * @param {{price: number|string, direction?: 'below'|'above', notify?: boolean}} input
 */
export function setTarget(targets, key, { price, direction = 'below', notify = true }, { now = new Date().toISOString() } = {}) {
  if (!key) throw new Error('A target needs a product');
  const amount = parseTargetPrice(price);
  if (amount === null) throw new Error('Enter a price above zero, such as 12.50');
  if (!DIRECTIONS.includes(direction)) throw new Error('A target is either "below" or "above"');
  return {
    ...targets,
    [key]: { price: amount, direction, notify: notify !== false, met: false, pending: false, updatedAt: now, notifiedAt: '' },
  };
}

export function removeTarget(targets, key) {
  const { [key]: _gone, ...rest } = targets;
  return rest;
}

/** Drop targets for products that are no longer in any list. */
export function pruneTargets(targets, listsState) {
  const held = new Set((listsState && listsState.lists ? listsState.lists : []).flatMap((list) => list.items.map((item) => item.key)));
  return Object.fromEntries(Object.entries(targets).filter(([key]) => held.has(key)));
}

/**
 * Does this Ask meet the target? Null when there is no price to judge by (nothing
 * listed, or the lookup failed): that is not "no".
 */
export function isMet(target, ask) {
  const landed = landedNow(ask);
  if (landed === null) return null;
  return target.direction === 'above' ? landed >= target.price : landed <= target.price;
}

/**
 * What one check of a target means.
 * @returns {{known: boolean, met: boolean, changed: boolean, shouldNotify: boolean}}
 *   `shouldNotify` only on the check where it becomes met; a target that stays met is not announced again.
 */
export function evaluateTarget(target, ask) {
  const met = isMet(target, ask);
  if (met === null) return { known: false, met: target.met, changed: false, shouldNotify: false };
  const changed = met !== target.met;
  return { known: true, met, changed, shouldNotify: changed && met && target.notify };
}

/** "at or below $10.00" */
export function describeTarget(target) {
  return `at or ${target.direction === 'above' ? 'above' : 'below'} ${formatMoney(target.price)}`;
}

/**
 * The notification for a target that has just been met.
 * @param {{name: string, url?: string}} item
 * @param {object} target
 * @param {{price: number, shipping?: number, seller?: string}} ask  a listing result with status 'ok'
 */
export function targetNotification(item, target, ask) {
  const landed = landedNow(ask);
  const parts = ask.shipping > 0
    ? `${formatMoney(ask.price)} + ${formatMoney(ask.shipping)} shipping`
    : `${formatMoney(ask.price)}, free shipping`;
  return {
    title: `Price target reached: ${item.name}`,
    message: `Ask ${formatMoney(landed)} is ${describeTarget(target)}, your target (${parts}).`,
    url: typeof item.url === 'string' && /^https:\/\//.test(item.url) ? item.url : '',
    tags: [target.direction === 'above' ? 'chart_with_upwards_trend' : 'chart_with_downwards_trend'],
    priority: 4,
  };
}
