/*
 * TCGPlayer+ — TCGplayer's price-history feed.
 *
 * The product page draws its "Market Price History" from this endpoint, and it
 * answers a plain GET. It is undocumented, so everything here fails soft: a
 * response that does not look right yields null, never an exception.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { normalizeBuckets } from './priceTrend.js';

const HOST = 'https://infinite-api.tcgplayer.com';
const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged', 'Unopened'];

export function historyUrl(productId, range = 'month') {
  if (!/^\d+$/.test(String(productId ?? ''))) throw new Error(`Not a TCGplayer product id: ${productId}`);
  return `${HOST}/price/history/${productId}/detailed?range=${encodeURIComponent(range)}`;
}

/**
 * The product page shows condition and variant as one phrase ("Near Mint
 * Holofoil"); the feed keeps them apart.
 */
export function splitConditionVariant(text) {
  const clean = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const lower = clean.toLowerCase();
  for (const condition of CONDITIONS) {
    if (lower.startsWith(condition.toLowerCase())) {
      return { condition, variant: clean.slice(condition.length).trim() };
    }
  }
  return { condition: '', variant: clean };
}

const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const sold = (s) => Number(s.totalQuantitySold) || 0;
const busiest = (list) => list.reduce((best, s) => (!best || sold(s) > sold(best) ? s : best), null);

/**
 * Choose which SKU (a condition x variant x language) to follow.
 * Prefers an exact match, then the same variant in Near Mint, then whichever
 * Near Mint printing sells most, then the busiest of anything.
 */
export function pickSku(skus, { condition = '', variant = '', language = '' } = {}) {
  if (!Array.isArray(skus) || skus.length === 0) return null;

  // A language we hold no data for should not turn the answer into "nothing".
  const inLanguage = language ? skus.filter((s) => same(s.language, language)) : skus;
  const pool = inLanguage.length ? inLanguage : skus;

  if (condition && variant) {
    const exact = pool.find((s) => same(s.condition, condition) && same(s.variant, variant));
    if (exact) return exact;
  }
  if (variant) {
    const nearMint = pool.filter((s) => same(s.condition, 'Near Mint') && same(s.variant, variant));
    if (nearMint.length) return busiest(nearMint);
  }
  if (condition && !variant) {
    const sameCondition = pool.filter((s) => same(s.condition, condition));
    if (sameCondition.length) return busiest(sameCondition);
  }
  const anyNearMint = pool.filter((s) => same(s.condition, 'Near Mint'));
  return busiest(anyNearMint.length ? anyNearMint : pool);
}

/**
 * @param {object} json the feed's response
 * @param {{language?: string, condition?: string}} saved what the saved item recorded;
 *   `condition` may be the page's combined phrase ("Near Mint Holofoil")
 * @returns {{skuId: string, condition: string, variant: string, language: string,
 *   days: ReturnType<typeof normalizeBuckets>}|null}
 */
export function parseHistory(json, saved = {}) {
  const skus = json && Array.isArray(json.result) ? json.result : null;
  if (!skus) return null;
  const wanted = splitConditionVariant(saved.condition);
  const sku = pickSku(skus, { ...wanted, language: saved.language });
  if (!sku) return null;
  return {
    skuId: String(sku.skuId),
    condition: sku.condition || '',
    variant: sku.variant || '',
    language: sku.language || '',
    days: normalizeBuckets(sku.buckets),
  };
}
