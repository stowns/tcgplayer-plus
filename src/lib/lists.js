/*
 * TCGPlayer+ — saved product lists.
 *
 * TCGplayer has no way to keep a product for later, and browser bookmarks mix
 * these in with everything else. These are the pure state operations behind a
 * small set of named lists; storage and UI live elsewhere.
 *
 * Every function returns a new state rather than editing the old one, so a
 * failed write never leaves half-applied changes behind.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseSort } from './listsSort.js';
import { splitConditionVariant } from './tcgplayerHistory.js';

export const LISTS_VERSION = 1;

export const LIST_LIMITS = {
  maxLists: 50,
  maxItemsPerList: 500,
  maxNameLength: 60,
  maxNoteLength: 500,
};

export function emptyState() {
  return { version: LISTS_VERSION, lists: [] };
}

/** A printing as it is kept: "Reverse Holofoil", tidied; empty when there is none. */
export const cleanPrinting = (printing) => (typeof printing === 'string' ? printing.replace(/\s+/g, ' ').trim().slice(0, 60) : '');

/**
 * What makes two saved products the same. The product id alone is not enough:
 * one page serves several language printings, which are priced separately and
 * are genuinely different things to want. A chosen printing (Holofoil, Reverse
 * Holofoil) is part of it too; an entry saved without one keeps the key it has
 * always had.
 */
export function itemKey({ productId, language, printing } = {}) {
  if (!productId) throw new Error('An item needs a productId');
  const base = `${String(productId).trim()}:${String(language || 'english').trim().toLowerCase()}`;
  const chosen = cleanPrinting(printing).toLowerCase();
  return chosen ? `${base}:${chosen}` : base;
}

/**
 * The printing an entry follows: the one chosen for it, or else the one in the
 * condition recorded from its product page ("Near Mint Holofoil").
 */
export function effectivePrinting(item) {
  if (!item) return '';
  const chosen = cleanPrinting(item.printing);
  if (chosen) return chosen;
  return splitConditionVariant(item.priceAtSave ? item.priceAtSave.condition : '').variant;
}

/**
 * Are these the same thing to watch: one product, language and printing? Whichever way
 * each was saved, with a printing chosen or read from its product page. An entry whose
 * printing was never known stands for the product in any printing, so it matches them all.
 */
export function sameEntry(a, b) {
  if (!a || !b || String(a.productId) !== String(b.productId)) return false;
  const lang = (item) => String(item.language || 'english').trim().toLowerCase();
  if (lang(a) !== lang(b)) return false;
  const [pa, pb] = [effectivePrinting(a).toLowerCase(), effectivePrinting(b).toLowerCase()];
  return !pa || !pb || pa === pb;
}

/** The entry in a list that is this product, language and printing, if there is one. */
export const findEntry = (list, item) => (list ? list.items.find((i) => sameEntry(i, item)) : undefined);

function cleanName(name) {
  const text = typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '';
  if (!text) throw new Error('A list needs a name');
  return text.slice(0, LIST_LIMITS.maxNameLength);
}

function requireList(state, listId) {
  const list = state.lists.find((l) => l.id === listId);
  if (!list) throw new Error(`List not found: ${listId}`);
  return list;
}

function assertNameFree(state, name, exceptId) {
  const taken = state.lists.some(
    (l) => l.id !== exceptId && l.name.toLowerCase() === name.toLowerCase(),
  );
  if (taken) throw new Error(`A list called "${name}" already exists`);
}

/** Ids only have to be unique within one browser profile. */
function newId(existing) {
  let id;
  do {
    id = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  } while (existing.has(id));
  return id;
}

export function createList(state, name, { now = new Date().toISOString() } = {}) {
  const clean = cleanName(name);
  assertNameFree(state, clean);
  if (state.lists.length >= LIST_LIMITS.maxLists) {
    throw new Error(`You can keep at most ${LIST_LIMITS.maxLists} lists`);
  }
  const list = {
    id: newId(new Set(state.lists.map((l) => l.id))),
    name: clean,
    createdAt: now,
    updatedAt: now,
    items: [],
  };
  return { state: { ...state, lists: [...state.lists, list] }, list };
}

export function renameList(state, listId, name, { now = new Date().toISOString() } = {}) {
  requireList(state, listId);
  const clean = cleanName(name);
  assertNameFree(state, clean, listId);
  return {
    ...state,
    lists: state.lists.map((l) => (l.id === listId ? { ...l, name: clean, updatedAt: now } : l)),
  };
}

export function deleteList(state, listId) {
  requireList(state, listId);
  return { ...state, lists: state.lists.filter((l) => l.id !== listId) };
}

/**
 * Save a product into a list.
 * @returns {{state: object, added: boolean}} `added` is false when it was
 *   already there — saving twice is a no-op, not an error or a duplicate.
 */
export function addItem(state, listId, item, { now = new Date().toISOString() } = {}) {
  const list = requireList(state, listId);
  const key = itemKey(item);
  if (list.items.some((i) => i.key === key || sameEntry(i, item))) return { state, added: false };
  if (list.items.length >= LIST_LIMITS.maxItemsPerList) {
    throw new Error(`"${list.name}" is full (${LIST_LIMITS.maxItemsPerList} items)`);
  }

  const saved = {
    key,
    productId: String(item.productId),
    language: item.language || 'English',
    name: item.name || 'Unknown product',
    setName: item.setName || '',
    category: item.category || '',
    number: item.number || '',
    rarity: item.rarity || '',
    imageUrl: item.imageUrl || '',
    url: item.url || '',
    priceAtSave: item.priceAtSave || null,
    ...(cleanPrinting(item.printing) ? { printing: cleanPrinting(item.printing) } : {}),
    note: typeof item.note === 'string' ? item.note.slice(0, LIST_LIMITS.maxNoteLength) : '',
    savedAt: now,
  };

  return {
    state: {
      ...state,
      lists: state.lists.map((l) => (l.id === listId
        ? { ...l, items: [saved, ...l.items], updatedAt: now }
        : l)),
    },
    added: true,
  };
}

/** How a list is ordered; a list that has never been sorted is newest first. */
export function listSort(list) {
  return parseSort(list && list.sort);
}

/**
 * Set how one list is ordered. It is a display preference, so it does not count
 * as editing the list (`updatedAt` is left alone).
 */
export function setListSort(state, listId, sort) {
  if (!state.lists.some((l) => l.id === listId)) throw new Error('That list no longer exists.');
  const clean = parseSort(sort);
  return { ...state, lists: state.lists.map((l) => (l.id === listId ? { ...l, sort: clean } : l)) };
}

export function removeItem(state, listId, key, { now = new Date().toISOString() } = {}) {
  requireList(state, listId);
  return {
    ...state,
    lists: state.lists.map((l) => (l.id === listId
      ? { ...l, items: l.items.filter((i) => i.key !== key), updatedAt: now }
      : l)),
  };
}

/**
 * Which lists a product is already saved in.
 * @param {string|object} keyOrItem a stored key, or an item (matched by `sameEntry`)
 */
export function listsContaining(state, keyOrItem) {
  const matches = typeof keyOrItem === 'string'
    ? (i) => i.key === keyOrItem
    : (i) => sameEntry(i, keyOrItem);
  return state.lists.filter((l) => l.items.some(matches)).map((l) => l.id);
}

/** Which lists hold this product in any printing (for a button that stands for the product). */
export function listsHoldingProduct(state, { productId, language } = {}) {
  const lang = String(language || 'english').trim().toLowerCase();
  return state.lists.filter((l) => l.items.some((i) => String(i.productId) === String(productId)
    && String(i.language || 'english').trim().toLowerCase() === lang)).map((l) => l.id);
}

/** Take this product, language and printing off a list, however it was saved there. */
export function removeEntry(state, listId, item, options) {
  const entry = findEntry(state.lists.find((l) => l.id === listId), item);
  return entry ? removeItem(state, listId, entry.key, options) : state;
}

export function countItems(state) {
  return state.lists.reduce((total, l) => total + l.items.length, 0);
}
