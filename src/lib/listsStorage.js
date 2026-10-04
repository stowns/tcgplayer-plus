/*
 * TCGPlayer+ — where watch lists live.
 *
 * This is the only user-created data the extension holds, so reads are
 * defensive: a malformed entry is repaired or dropped, never allowed to throw
 * and take someone's whole collection of saved products with it.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { emptyState, itemKey, LISTS_VERSION, LIST_LIMITS } from './lists.js';
import { parseSort } from './listsSort.js';

export const LISTS_KEY = 'lists';

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object' || !raw.productId) return null;
  const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
  let key;
  try {
    key = raw.key || itemKey(raw);
  } catch {
    return null;
  }
  return {
    key,
    productId: String(raw.productId),
    language: str(raw.language) || 'English',
    name: str(raw.name) || 'Unknown product',
    setName: str(raw.setName),
    category: str(raw.category),
    number: str(raw.number, 40),
    rarity: str(raw.rarity, 80),
    imageUrl: str(raw.imageUrl, 500),
    url: str(raw.url, 500),
    priceAtSave: raw.priceAtSave && typeof raw.priceAtSave === 'object' ? raw.priceAtSave : null,
    note: str(raw.note, LIST_LIMITS.maxNoteLength),
    savedAt: str(raw.savedAt, 40),
  };
}

function sanitizeList(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .map(sanitizeItem)
    .filter(Boolean)
    .slice(0, LIST_LIMITS.maxItemsPerList);
  return {
    id: raw.id,
    name: raw.name.trim().slice(0, LIST_LIMITS.maxNameLength),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : '',
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
    // Only kept once a sort has been chosen, and repaired if it is damaged.
    ...(raw.sort ? { sort: parseSort(raw.sort) } : {}),
    items,
  };
}

export function sanitizeState(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.lists)) return emptyState();
  return {
    version: LISTS_VERSION,
    lists: raw.lists.map(sanitizeList).filter(Boolean).slice(0, LIST_LIMITS.maxLists),
  };
}

export async function loadLists(storage) {
  const bag = await storage.get(LISTS_KEY);
  return sanitizeState(bag ? bag[LISTS_KEY] : null);
}

export async function saveLists(storage, state) {
  const clean = sanitizeState(state);
  await storage.set({ [LISTS_KEY]: clean });
  return clean;
}
