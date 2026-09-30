/*
 * TCGPlayer+ — money parsing and formatting.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const NUMBER_RE = /(\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)/;

/**
 * Extract the first monetary amount from a chunk of page text.
 * Handles "$13.99", "US $175.00", "$1,234.56". Returns null when there is no
 * amount (e.g. "n/a", "").
 */
export function parseMoney(text) {
  if (typeof text !== 'string') return null;
  // Only look at text that actually carries a currency marker, so stray
  // numbers ("216 items sold") are never mistaken for a price.
  if (!/[$£€¥]|\bUSD\b|\bEUR\b|\bGBP\b/i.test(text)) return null;
  const m = text.match(NUMBER_RE);
  if (!m) return null;
  const value = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export function formatMoney(value, currency = '$') {
  if (!Number.isFinite(value)) return '—';
  return `${currency}${value.toFixed(2)}`;
}
