/*
 * TCGPlayer+ — "Add to watch list" on TCGplayer product pages, and on each product
 * card of its search pages. TCGplayer has no way to keep a product for later; this
 * adds one that is kept separate from browser bookmarks.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  parseProductPage, productIdFromUrl, parseSearchCard, SEARCH_CARD_SELECTOR,
} from '../lib/tcgplayerDom.js';
import { splitConditionVariant } from '../lib/tcgplayerHistory.js';
import { renderSaveControl, CONTROL_CLASS } from '../lib/listPanelView.js';
import { loadLists, saveLists, LISTS_KEY } from '../lib/listsStorage.js';
import {
  createList, addItem, removeEntry, listsContaining, listsHoldingProduct, effectivePrinting,
} from '../lib/lists.js';
import { api } from '../lib/runtime.js';

const storage = api.storage.local;
const FALLBACK_CLASS = 'ptcg-save-bar';

let control = null;
let product = null;
let currentUrl = location.href;

async function refresh() {
  const state = await loadLists(storage);
  // Matched by product, language and printing, so cards saved before printings were kept still
  // count. Until the page has shown which printing it is, any printing of the product counts.
  if (control && product) {
    const savedIn = effectivePrinting(product) ? listsContaining(state, product) : listsHoldingProduct(state, product);
    control.update({ lists: state.lists, savedIn });
  }
  refreshCards(state);
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
  // The printing the page is showing (its listing's "Near Mint Holofoil"), kept with the entry.
  const { variant } = splitConditionVariant(fresh.priceAtSave ? fresh.priceAtSave.condition : '');
  if (variant) fresh.printing = variant;
  product = fresh;
  return fresh;
}

const handlers = {
  onToggle: (listId, checked) => mutate((state) => (checked
    ? addItem(state, listId, currentProduct()).state
    : removeEntry(state, listId, product))),

  onCreate: (name) => mutate((state) => {
    const { state: withList, list } = createList(state, name);
    // Creating a list from this panel is a way of saving this card into it.
    return addItem(withList, list.id, currentProduct()).state;
  }),

  onManage: () => api.runtime.sendMessage({ type: 'open-lists' }),
};

// ---- the cards of a search page ----------------------------------------------------------

/** Each search card's control, with what it saves: the card's product, and the printing chosen. */
const cards = new Map(); // card element -> { control, item, printing: string|null }

const entryOf = (card) => ({ ...card.item, ...(card.printing ? { printing: card.printing } : {}) });

function refreshCards(state) {
  for (const [element, card] of cards) {
    // A card drawn over by a new page of results: its panel goes with it.
    if (!element.isConnected) { card.control.close(); cards.delete(element); continue; }
    card.control.update({
      lists: state.lists,
      savedIn: card.printing === null ? [] : listsContaining(state, entryOf(card)),
      // The button stands for the product, so it counts every printing of it.
      buttonCount: listsHoldingProduct(state, card.item).length,
    });
  }
}

async function mutateCard(card, change) {
  try {
    const state = await loadLists(storage);
    const next = change(state);
    if (next) await saveLists(storage, next);
    card.control.showError('');
  } catch (err) {
    card.control.showError(err && err.message ? err.message : String(err));
  }
  await refresh();
}

function decorate(element) {
  const item = parseSearchCard(element, location.href);
  if (!item) return;
  const card = { item, printing: null, control: null };
  card.control = renderSaveControl(document, {
    lists: [],
    savedIn: [],
    choosePrinting: true,
    // The result cards cut off whatever overflows them, so the panel opens on the page itself.
    floating: true,
    handlers: {
      onLoadPrintings: () => api.runtime.sendMessage({ type: 'product-printings', item: { productId: item.productId } }),
      onChoosePrinting: (name) => { card.printing = name; refresh(); },
      onToggle: (listId, checked) => mutateCard(card, (state) => (checked
        ? addItem(state, listId, entryOf(card)).state
        : removeEntry(state, listId, entryOf(card)))),
      onCreate: (name) => mutateCard(card, (state) => {
        const { state: withList, list } = createList(state, name);
        return addItem(withList, list.id, entryOf(card)).state;
      }),
      onManage: () => api.runtime.sendMessage({ type: 'open-lists' }),
    },
  });
  card.control.classList.add('ptcg-list-control--card');
  element.classList.add('ptcg-card');
  element.append(card.control);
  cards.set(element, card);
  return card;
}

/** Give every search result that has none a control. Results are redrawn on paging and filtering. */
function syncSearch() {
  let added = false;
  for (const element of document.querySelectorAll(SEARCH_CARD_SELECTOR)) {
    if (cards.has(element) || element.querySelector(`.${CONTROL_CLASS}`)) continue;
    if (decorate(element)) added = true;
  }
  if (added) refresh();
}

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
  if (!productIdFromUrl(location.href)) {
    syncSearch();
    return;
  }

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
