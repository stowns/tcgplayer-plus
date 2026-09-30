/*
 * TCGPlayer+ — a product's picture.
 *
 * The product page's own `og:image` is a `_in_1000x1000.jpg` file, and TCGplayer's
 * image server does not have that file for every product (newer releases are
 * missing it), so a picture saved from it can be a dead link. The 200x200
 * version exists for every product and is built from the product id alone, so
 * it works for every saved item whatever picture link was stored with it.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const CDN = 'https://tcgplayer-cdn.tcgplayer.com/product';

/** The reliable picture for a product id, or '' when there is no usable id. */
export function productImageUrl(productId) {
  return /^\d+$/.test(String(productId ?? '')) ? `${CDN}/${productId}_in_200x200.jpg` : '';
}

/** Pictures to try, best first, without repeats; only https links are allowed. */
export function imageCandidates(productId, storedUrl) {
  const list = [productImageUrl(productId), typeof storedUrl === 'string' ? storedUrl : ''];
  return [...new Set(list.filter((url) => /^https:\/\//.test(url)))];
}

/**
 * Point `img` at the first candidate, moving to the next if one fails to load,
 * and taking the picture out of the layout if none do (rather than leaving a
 * broken-image icon).
 */
export function loadFirstWorking(img, candidates) {
  let next = 0;
  const tryNext = () => {
    if (next >= candidates.length) {
      img.removeAttribute('src');
      img.setAttribute('data-failed', '1');
      img.hidden = true;
      return;
    }
    img.src = candidates[next];
    next += 1;
  };
  img.addEventListener('error', tryNext);
  tryNext();
}
