/*
 * TCGPlayer+ — toolbar popup: a way into the dashboard, and a cache reset.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { loadLists } from '../lib/listsStorage.js';
import { countItems } from '../lib/lists.js';
import { cachedLookupKeys } from '../lib/cacheKeys.js';
import { api } from '../lib/runtime.js';

const storage = api.storage.local;
const status = document.getElementById('status');

function say(message) {
  status.textContent = message;
  setTimeout(() => { status.textContent = ''; }, 2500);
}

document.getElementById('clearCache').addEventListener('click', async () => {
  const keys = cachedLookupKeys(Object.keys(await storage.get(null)));
  if (keys.length) await storage.remove(keys);
  say(`Cleared ${keys.length} cached lookup${keys.length === 1 ? '' : 's'}.`);
});

// No fragment: the dashboard opens on the tab you used last (Saved Lists the first time).
document.getElementById('openDashboard').addEventListener('click', async () => {
  await api.tabs.create({ url: api.runtime.getURL('home/home.html') });
  window.close();
});

async function showListsSummary() {
  const state = await loadLists(storage);
  const lists = state.lists.length;
  const items = countItems(state);
  document.getElementById('listsSummary').textContent = lists === 0
    ? 'No lists yet. Save a product from TCGplayer to start one.'
    : `${items} product${items === 1 ? '' : 's'} across ${lists} list${lists === 1 ? '' : 's'}.`;
}

showListsSummary();
