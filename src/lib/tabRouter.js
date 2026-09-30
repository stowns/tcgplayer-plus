/*
 * TCGPlayer+ — which tab of the home page to show.
 * Pure helpers; the page wires them to the DOM.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/**
 * The tab a URL fragment names, else the last one used, else the first.
 * @param {string} hash e.g. "#orders"
 * @param {string[]} ids valid tab ids, in display order
 */
export function viewFromHash(hash, ids, remembered = '') {
  const wanted = String(hash || '').replace(/^#/, '').toLowerCase();
  if (ids.includes(wanted)) return wanted;
  if (ids.includes(remembered)) return remembered;
  return ids[0];
}

/** Arrow keys move between tabs and wrap round; Home and End jump; anything else is not ours. */
export function nextTabId(current, key, ids) {
  const at = ids.indexOf(current);
  if (at < 0) return null;
  switch (key) {
    case 'ArrowRight': return ids[(at + 1) % ids.length];
    case 'ArrowLeft': return ids[(at - 1 + ids.length) % ids.length];
    case 'Home': return ids[0];
    case 'End': return ids[ids.length - 1];
    default: return null;
  }
}
