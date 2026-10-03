/*
 * TCGPlayer+ — the TCGPlayer+ home page.
 * A row of tabs; each tab is a view that mounts into <main> and cleans up after
 * itself when another is chosen, so a hidden view holds no listeners or requests.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as lists from './views/lists.js';
import * as orders from './views/orders.js';
import { viewFromHash, nextTabId } from '../lib/tabRouter.js';
import { clearCachedLookups } from '../lib/cacheKeys.js';
import { api } from '../lib/runtime.js';

const VIEWS = { lists, orders };
const IDS = Object.keys(VIEWS);
const LAST_KEY = 'ptcg.lastView';
const TITLES = { lists: 'Saved Lists', orders: 'Order History' };

const root = document.getElementById('view');
const tabs = [...document.querySelectorAll('.tab')];

// Remembering the last tab is a convenience; a browser that refuses storage still works.
const remembered = () => { try { return localStorage.getItem(LAST_KEY) || ''; } catch { return ''; } };
const remember = (id) => { try { localStorage.setItem(LAST_KEY, id); } catch { /* not worth failing over */ } };

let current = null;
let unmount = null;

function show(id) {
  if (id === current) return;
  if (unmount) unmount();
  current = id;
  root.replaceChildren();
  root.setAttribute('aria-labelledby', `tab-${id}`);
  unmount = VIEWS[id].mount(root) || null;
  for (const tab of tabs) {
    const selected = tab.getAttribute('data-view') === id;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  document.title = `TCGPlayer+ — ${TITLES[id]}`;
  remember(id);
}

/** Changing the fragment is the one way to change tab, so back/forward and links just work. */
function select(id) {
  if (location.hash.replace(/^#/, '') === id) show(id);
  else location.hash = id;
}

for (const tab of tabs) {
  tab.addEventListener('click', () => select(tab.getAttribute('data-view')));
  tab.addEventListener('keydown', (event) => {
    const next = nextTabId(tab.getAttribute('data-view'), event.key, IDS);
    if (!next) return;
    event.preventDefault();
    select(next);
    document.getElementById(`tab-${next}`).focus();
  });
}

window.addEventListener('hashchange', () => show(viewFromHash(location.hash, IDS, remembered())));
show(viewFromHash(location.hash, IDS, remembered()));

// Prices and trends are looked up from TCGplayer and kept for a while; this throws them away
// so the next look is fresh. Saved lists and orders are never touched.
const cacheStatus = document.getElementById('cacheStatus');
let cacheTimer = null;
document.getElementById('clearCache').addEventListener('click', async () => {
  let message;
  try {
    const count = await clearCachedLookups(api.storage.local);
    message = `Cleared ${count} cached lookup${count === 1 ? '' : 's'}.`;
  } catch (err) {
    message = `Could not clear the cache (${err && err.message ? err.message : err}).`;
  }
  cacheStatus.textContent = message;
  clearTimeout(cacheTimer);
  cacheTimer = setTimeout(() => { cacheStatus.textContent = ''; }, 2500);
});
