/*
 * TCGPlayer+ — the TCGPlayer+ home page.
 * A row of tabs; each tab is a view that mounts into <main> and cleans up after
 * itself when another is chosen, so a hidden view holds no listeners or requests.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as lists from './views/lists.js';
import * as orders from './views/orders.js';
import * as settingsView from './views/settings.js';
import { viewFromHash, nextTabId } from '../lib/tabRouter.js';
import { clearCachedLookups } from '../lib/cacheKeys.js';
import { api } from '../lib/runtime.js';
import { createAutoRefresh, formatCountdown } from '../lib/autoRefresh.js';
import {
  loadSettings, updateSettings, clampInterval, shouldWarnAboutRate, SETTINGS_KEY,
} from '../lib/settings.js';
import { checkTargets, runExclusive } from '../lib/priceWatch.js';
import { sendNotification } from './notify.js';

const VIEWS = { lists, orders, settings: settingsView };
const IDS = Object.keys(VIEWS);
const LAST_KEY = 'ptcg.lastView';
const TITLES = { lists: 'Watch Lists', orders: 'Order History', settings: 'Settings' };

const root = document.getElementById('view');
const tabs = [...document.querySelectorAll('.tab')];

// Remembering the last tab is a convenience; a browser that refuses storage still works.
const remembered = () => { try { return localStorage.getItem(LAST_KEY) || ''; } catch { return ''; } };
const remember = (id) => { try { localStorage.setItem(LAST_KEY, id); } catch { /* not worth failing over */ } };

let current = null;
let view = null; // { unmount, refresh } of the view on show

function show(id) {
  if (id === current) return;
  if (view) view.unmount();
  current = id;
  root.replaceChildren();
  root.setAttribute('aria-labelledby', `tab-${id}`);
  view = VIEWS[id].mount(root);
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
// so the next look is fresh. Watch lists and orders are never touched.
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

// ---- auto-refresh, and the price targets it checks ---------------------------------
//
// Runs only while this page is open. Each refresh asks the view on show to bring its
// prices up to date, and checks every price target, whichever tab is showing.

const storage = api.storage.local;
const toggle = document.getElementById('autoRefreshOn');
const seconds = document.getElementById('autoRefreshSeconds');
const next = document.getElementById('autoRefreshNext');
const rateWarning = document.getElementById('rateWarning');

const lookupAsk = (item) => api.runtime.sendMessage({
  type: 'listing-price',
  item: { productId: item.productId, condition: item.priceAtSave ? item.priceAtSave.condition : '' },
});

/** Check every price target, unless another dashboard tab is already doing it. */
function watchTargets() {
  return runExclusive(
    () => checkTargets({ storage, lookupAsk, notify: sendNotification }),
    typeof navigator !== 'undefined' ? navigator.locks : undefined,
  ).catch(() => ({ skipped: true }));
}

const auto = createAutoRefresh({
  intervalSeconds: clampInterval(undefined),
  onTick: () => Promise.all([view && view.refresh ? view.refresh() : null, watchTargets()]),
  onCountdown: (left) => { next.textContent = left === null ? '' : `next in ${formatCountdown(left)}`; },
});

let applied = null;
function apply(settings) {
  const { enabled, intervalSeconds } = settings.autoRefresh;
  toggle.checked = enabled;
  // Not while it is being typed in.
  if (document.activeElement !== seconds) seconds.value = String(intervalSeconds);
  rateWarning.hidden = !shouldWarnAboutRate(settings);
  if (!applied || applied.intervalSeconds !== intervalSeconds) auto.setIntervalSeconds(intervalSeconds);
  if (enabled && !auto.isRunning) {
    auto.start();
    // Targets are judged as soon as tracking is on, not one interval later.
    watchTargets();
  } else if (!enabled && auto.isRunning) {
    auto.stop();
  }
  applied = { enabled, intervalSeconds };
}

const change = (fn) => updateSettings(storage, fn).then(apply);

toggle.addEventListener('change', () => change((s) => ({ ...s, autoRefresh: { ...s.autoRefresh, enabled: toggle.checked } })));
seconds.addEventListener('change', () => {
  const value = clampInterval(seconds.value);
  seconds.value = String(value);
  change((s) => ({ ...s, autoRefresh: { ...s.autoRefresh, intervalSeconds: value } }));
});
document.getElementById('rateWarningDismiss').addEventListener('click', () => change((s) => ({ ...s, rateWarningDismissed: true })));

// Another dashboard tab, or the "Enable auto-refresh" button beside a target, changed the settings.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) loadSettings(storage).then(apply);
});

// A target was just set: judge it now if tracking is on.
window.addEventListener(lists.CHECK_TARGETS_EVENT, () => { if (auto.isRunning) watchTargets(); });

loadSettings(storage).then(apply);
