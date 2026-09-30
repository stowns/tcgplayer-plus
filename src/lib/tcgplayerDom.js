/*
 * TCGPlayer+ — reading a TCGplayer product page.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseMoney } from './money.js';

const PRODUCT_PATH = /\/product\/(\d+)(?:\/([^?#]*))?/;

export function productIdFromUrl(url) {
  const m = String(url || '').match(PRODUCT_PATH);
  return m ? m[1] : null;
}

/** Language is part of the product's identity; page number and tracking are not. */
export function languageFromUrl(url) {
  try {
    return new URL(url).searchParams.get('Language') || 'English';
  } catch {
    return 'English';
  }
}

export function canonicalProductUrl(url) {
  const parsed = new URL(url);
  const language = parsed.searchParams.get('Language');
  parsed.search = language ? `?Language=${encodeURIComponent(language)}` : '';
  parsed.hash = '';
  return parsed.toString();
}

const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/**
 * Split the title TCGplayer renders, which is
 * "<name> - <number> - <set>" with an optional " (CODE)" suffix.
 */
function splitTitle(title) {
  const parts = String(title || '').split(' - ').map((p) => p.trim()).filter(Boolean);
  const out = { name: parts[0] || '', number: '', setName: '' };
  if (parts.length >= 2 && /\d/.test(parts[1])) out.number = parts[1];
  if (parts.length >= 3) out.setName = parts[2].replace(/\s*\([A-Z0-9]{2,5}\)\s*$/, '').trim();
  return out;
}

function marketPrice(doc) {
  const cells = doc.querySelectorAll('.price-guide__points td, .price-guide__points th');
  for (const cell of cells) {
    if (/^market price$/i.test(text(cell)) && cell.nextElementSibling) {
      return parseMoney(text(cell.nextElementSibling));
    }
  }
  return null;
}

/**
 * @returns {object|null} the product, or null if this is not a product page
 */
export function parseProductPage(doc, url) {
  const productId = productIdFromUrl(url);
  if (!productId) return null;

  // The page is a single-page app, so the rendered heading may not exist yet.
  // og:title is served with the HTML and carries the same three fields.
  const heading = text(doc.querySelector('h1.product-details__name, h1'));
  const ogTitle = (doc.querySelector('meta[property="og:title"]') || {}).content || '';
  const fromHeading = splitTitle(heading);
  const fromMeta = splitTitle(ogTitle.replace(/\s*-\s*Pokemon\s*$/i, ''));
  const title = fromHeading.name ? fromHeading : fromMeta;

  const crumbs = [...doc.querySelectorAll('.product-details__breadcrumbs a')].map(text).filter(Boolean);
  const attributes = [...doc.querySelectorAll('.product__item-details__attributes li')].map(text);
  const numberRarity = attributes.find((a) => /^card number \/ rarity:/i.test(a)) || '';
  // "Card Number / Rarity:169/086 / Special Illustration Rare" — the card
  // number contains its own unspaced slash, so split on the spaced one.
  const [, numberPart, rarityPart] = numberRarity.match(/:\s*(.+?)\s+\/\s+(.+)$/) || [];

  const lowest = parseMoney(text(doc.querySelector('.spotlight__price')));
  const asLowAs = parseMoney(text(doc.querySelector('.top-listing-price')));
  const market = marketPrice(doc);
  const condition = text(doc.querySelector('.spotlight__condition'));

  const priceAtSave = (market || lowest || asLowAs)
    ? { market, lowest, condition: condition || '', asLowAs }
    : null;

  return {
    productId,
    language: languageFromUrl(url),
    name: title.name,
    number: (numberPart || title.number || '').trim(),
    setName: (crumbs[crumbs.length - 1] || title.setName || '').trim(),
    category: crumbs.length >= 2 ? crumbs[crumbs.length - 2] : '',
    rarity: (rarityPart || '').trim(),
    imageUrl: (doc.querySelector('meta[property="og:image"]') || {}).content || '',
    url: canonicalProductUrl(url),
    priceAtSave,
  };
}
