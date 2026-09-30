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

/**
 * What makes two saved products the same. The product id alone is not enough:
 * one page serves several language printings, which are priced separately and
 * are genuinely different things to want.
 */
export function itemKey({ productId, language } = {}) {
  if (!productId) throw new Error('An item needs a productId');
  return `${String(productId).trim()}:${String(language || 'english').trim().toLowerCase()}`;
}

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
  if (list.items.some((i) => i.key === key)) return { state, added: false };
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

/** Which lists a product is already saved in. */
export function listsContaining(state, key) {
  return state.lists.filter((l) => l.items.some((i) => i.key === key)).map((l) => l.id);
}

export function countItems(state) {
  return state.lists.reduce((total, l) => total + l.items.length, 0);
}
