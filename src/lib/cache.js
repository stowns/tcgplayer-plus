/*
 * TCGPlayer+ — TTL cache over an injectable key/value store.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * @param {{get(keys):Promise<object>, set(items):Promise<void>, remove(keys):Promise<void>}} store
 */
export function createCache(store, { ttlMs = DEFAULT_TTL_MS, now = Date.now, prefix = 'cache:' } = {}) {
  const k = (key) => `${prefix}${key}`;

  return {
    async get(key) {
      const bag = await store.get(k(key));
      const entry = bag ? bag[k(key)] : null;
      if (!entry) return null;
      if (now() - entry.storedAt > ttlMs) {
        await store.remove(k(key));
        return null;
      }
      return entry.value;
    },
    async set(key, value) {
      await store.set({ [k(key)]: { storedAt: now(), value } });
      return value;
    },
    async clear(keys) {
      if (keys) return store.remove(keys.map(k));
      return undefined;
    },
  };
}

/**
 * Collapses concurrent lookups of the same key into one in-flight request.
 * A results page fires 60 cards at once and many share a card.
 */
export function singleFlight(fn) {
  const inFlight = new Map();
  return (key, ...args) => {
    if (inFlight.has(key)) return inFlight.get(key);
    const promise = Promise.resolve(fn(key, ...args)).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
  };
}
