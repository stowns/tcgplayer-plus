/*
 * TCGPlayer+ — "Save to list" on TCGplayer product pages.
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

const api = globalThis.browser || globalThis.chrome;
const storage = api.storage.local;

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

const handlers = {
  onToggle: (listId, checked) => mutate((state) => (checked
    ? addItem(state, listId, product).state
    : removeItem(state, listId, itemKey(product)))),

  onCreate: (name) => mutate((state) => {
    const { state: withList, list } = createList(state, name);
    // Creating a list from this panel is a way of saving this card into it.
    return addItem(withList, list.id, product).state;
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

function findAnchor() {
  return document.querySelector('.product-details__header')
    || (document.querySelector('h1.product-details__name') || {}).parentElement
    || null;
}

/**
 * The page is a single-page app: the heading arrives after load, and moving to
 * another product never reloads the document. So watch for both.
 */
function sync() {
  if (location.href !== currentUrl) {
    currentUrl = location.href;
    if (control) control.remove();
    control = null;
    product = null;
  }
  if (!productIdFromUrl(location.href)) return;
  if (control && control.isConnected) return;

  const anchor = findAnchor();
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
