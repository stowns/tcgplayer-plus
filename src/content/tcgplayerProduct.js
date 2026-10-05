/*
 * TCGPlayer+ — "Add to watch list" on TCGplayer product pages.
 * TCGplayer has no way to keep a product for later; this adds one that is kept
 * separate from browser bookmarks.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseProductPage, productIdFromUrl } from '../lib/tcgplayerDom.js';
import { renderSaveControl, CONTROL_CLASS } from '../lib/listPanelView.js';
import { loadLists, saveLists, LISTS_KEY } from '../lib/listsStorage.js';
import {
  createList, addItem, removeItem, listsContaining, itemKey,
} from '../lib/lists.js';
import { api } from '../lib/runtime.js';

const storage = api.storage.local;
const FALLBACK_CLASS = 'ptcg-save-bar';

let control = null;
let product = null;
let currentUrl = location.href;

async function refresh() {
  if (!control || !product) return;
  const state = await loadLists(storage);
  control.update({ lists: state.lists, savedIn: listsContaining(state, itemKey(product)) });
}

/** Read, change, write. Errors are shown in the panel, never swallowed. */
async function mutate(change) {
  try {
    const state = await loadLists(storage);
    const next = change(state);
    if (next) await saveLists(storage, next);
    control.showError('');
  } catch (err) {
    control.showError(err && err.message ? err.message : String(err));
  }
  await refresh();
}

/**
 * The product as the page shows it right now. Read when you save, not when the
 * button was drawn: the button appears before the page has filled in the card's
 * name, and a card saved without one would be listed as "Unknown product".
 */
function currentProduct() {
  const fresh = parseProductPage(document, location.href);
  if (!fresh || !fresh.name) throw new Error('This page has not finished loading the card\u2019s name yet. Try again in a moment.');
  product = fresh;
  return fresh;
}

const handlers = {
  onToggle: (listId, checked) => mutate((state) => (checked
    ? addItem(state, listId, currentProduct()).state
    : removeItem(state, listId, itemKey(product)))),

  onCreate: (name) => mutate((state) => {
    const { state: withList, list } = createList(state, name);
    // Creating a list from this panel is a way of saving this card into it.
    return addItem(withList, list.id, currentProduct()).state;
  }),

  onManage: () => api.runtime.sendMessage({ type: 'open-lists' }),
};

function attach(anchor) {
  product = parseProductPage(document, location.href);
  if (!product) return;
  control = renderSaveControl(document, { lists: [], savedIn: [], handlers });
  anchor.append(control);
  refresh();
}

/** Beside the card's name, where TCGplayer's product header normally is. */
function findHeader() {
  return document.querySelector('.product-details__header')
    || (document.querySelector('h1.product-details__name') || {}).parentElement
    || null;
}

/**
 * Some layouts of the product page have no header to sit beside (the card's name
 * is not in the page at all), so the control goes in a bar at the top of the
 * product section instead. The product itself is still read from the page's
 * metadata.
 */
function findFallback() {
  const section = document.querySelector('.product-details');
  if (!section) return null;
  let bar = section.querySelector(`.${FALLBACK_CLASS}`);
  if (!bar) {
    bar = document.createElement('div');
    bar.className = FALLBACK_CLASS;
    section.prepend(bar);
  }
  return bar;
}

/**
 * The site is a single-page app: the heading arrives after load, and moving from
 * a search or another product to a product never reloads the document. So the
 * script runs on every page of the site (see the manifest), watches for both,
 * and does nothing until the address is a product's.
 */
function sync() {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    if (control) control.remove();
    control = null;
    product = null;
  }
  if (!productIdFromUrl(location.href)) return;

  const header = findHeader();
  if (control && control.isConnected) {
    // The header can arrive after the fallback bar was used; move to it.
    const bar = control.parentElement;
    if (header && bar.classList.contains(FALLBACK_CLASS)) {
      header.append(control);
      bar.remove();
    }
    return;
  }

  const anchor = header || findFallback();
  if (anchor && !anchor.querySelector(`.${CONTROL_CLASS}`)) attach(anchor);
}

let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; sync(); });
}).observe(document.documentElement, { childList: true, subtree: true });

window.addEventListener('popstate', sync);
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[LISTS_KEY]) refresh();
});

sync();
