/*
 * TCGPlayer+ — checking price targets and telling the user when one is met.
 *
 * Runs on each auto-refresh, from the dashboard. Every dependency is injected.
 *
 * The order matters. What was found is saved first and the notification sent
 * second, so a crash or a second dashboard tab cannot announce the same thing
 * twice. A notification that fails to send stays owed (`pending`) and is tried
 * again on the next check, so a brief outage does not lose it.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { loadLists } from './listsStorage.js';
import {
  loadTargets, saveTargets, pruneTargets, evaluateTarget, isMet, targetNotification,
} from './targets.js';

export const WATCH_LOCK = 'tcgplayer-plus-price-watch';

/**
 * Run `task` unless another dashboard tab is already running it.
 * @param {{request: Function}|undefined} locks  the Web Locks API (`navigator.locks`), where there is one
 * @returns {Promise<any>} what `task` returned, or `{skipped: true}` if another tab has it
 */
export function runExclusive(task, locks) {
  if (!locks || typeof locks.request !== 'function') return Promise.resolve().then(task);
  return locks.request(WATCH_LOCK, { ifAvailable: true }, (lock) => (lock ? task() : { skipped: true }));
}

/** Apply `change` to the targets as they are now, leaving alone any the user has edited since `seen`. */
async function update(storage, seen, change) {
  const latest = await loadTargets(storage);
  let dirty = false;
  for (const [key, patch] of Object.entries(change)) {
    const current = latest[key];
    if (!current || !seen[key] || current.updatedAt !== seen[key].updatedAt) continue;
    latest[key] = { ...current, ...patch };
    dirty = true;
  }
  if (dirty) await saveTargets(storage, latest);
  return latest;
}

/**
 * @param {object} deps
 * @param {object} deps.storage
 * @param {(item: object) => Promise<object|null>} deps.lookupAsk  the Ask for a watch-list item (a listing lookup result)
 * @param {(notification: object) => Promise<{ok: boolean}>} deps.notify
 * @param {() => string} [deps.now]
 * @returns {Promise<{checked: number, met: number, notified: number, failed: number}>}
 */
export async function checkTargets({ storage, lookupAsk, notify, now = () => new Date().toISOString() }) {
  const lists = await loadLists(storage);
  const all = await loadTargets(storage);
  const targets = pruneTargets(all, lists);
  if (Object.keys(targets).length !== Object.keys(all).length) await saveTargets(storage, targets);

  const itemsByKey = new Map();
  for (const list of lists.lists) for (const item of list.items) if (!itemsByKey.has(item.key)) itemsByKey.set(item.key, item);

  const keys = Object.keys(targets);
  const asks = {};
  await Promise.all(keys.map(async (key) => {
    try {
      asks[key] = await lookupAsk(itemsByKey.get(key));
    } catch {
      asks[key] = null;
    }
  }));

  // 1. What changed.
  const change = {};
  for (const key of keys) {
    const target = targets[key];
    const verdict = evaluateTarget(target, asks[key]);
    if (verdict.changed) change[key] = { met: verdict.met, pending: verdict.shouldNotify };
    // Notifications were switched off after one became owed: it is no longer owed.
    else if (target.pending && !target.notify) change[key] = { pending: false };
  }
  // 2. Save it before telling anyone.
  const saved = Object.keys(change).length ? await update(storage, targets, change) : targets;

  // 3. Send what is owed: newly met, or left over from a failed send, while it is still met.
  const owed = keys.filter((key) => saved[key] && saved[key].pending && saved[key].notify && isMet(saved[key], asks[key]) === true);
  const delivered = {};
  let failed = 0;
  for (const key of owed) {
    let result;
    try {
      result = await notify(targetNotification(itemsByKey.get(key), saved[key], asks[key]));
    } catch {
      result = { ok: false };
    }
    if (result && result.ok) delivered[key] = { pending: false, notifiedAt: now() };
    else failed += 1;
  }
  const final = Object.keys(delivered).length ? await update(storage, saved, delivered) : saved;

  return {
    checked: keys.length,
    met: keys.filter((key) => final[key] && final[key].met).length,
    notified: Object.keys(delivered).length,
    failed,
  };
}
