/*
 * TCGPlayer+ — which storage entries are disposable lookups.
 * Watch Lists and the order archive are NOT in this list, so "Clear cache"
 * can never delete them.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** `tr:` price trends. The Ask is never cached, so it is not here. */
export const CACHE_PREFIXES = ['tr:'];

/** Remove every cached lookup from `storage`; returns how many were removed. */
export async function clearCachedLookups(storage) {
  const keys = cachedLookupKeys(Object.keys(await storage.get(null)));
  if (keys.length) await storage.remove(keys);
  return keys.length;
}

export function cachedLookupKeys(keys) {
  return (Array.isArray(keys) ? keys : []).filter((key) => typeof key === 'string'
    && CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)));
}
