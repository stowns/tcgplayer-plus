/*
 * TCGPlayer+ — the Watch Lists view.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  renderLists, exportJson, updateTrend, updateAsk, updateTargetBlock, trendOptionsFor,
} from '../../lib/listsPageView.js';
import { loadLists, saveLists } from '../../lib/listsStorage.js';
import {
  createList, renameList, deleteList, removeItem, setListSort, listSort,
} from '../../lib/lists.js';
import { pageOf, parsePageSize, resolveSelection } from '../../lib/listsPage.js';
import { needsHistory, needsAsk, defaultDirection, askKey } from '../../lib/listsSort.js';
import { api } from '../../lib/runtime.js';
import { retryingState, isSettled } from '../../lib/retryState.js';
import {
  loadTargets, saveTargets, setTarget, removeTarget, pruneTargets, TARGETS_KEY,
} from '../../lib/targets.js';
import {
  loadSettings, updateSettings, createTopic, parseSecretWord, hasTopic, shouldShowSubscribeNotice, SETTINGS_KEY,
} from '../../lib/settings.js';
import { requestConsent } from '../../lib/consent.js';

/** Asks the dashboard to check price targets now, rather than at the next auto-refresh. */
export const CHECK_TARGETS_EVENT = 'ptcg:check-targets';

const storage = api.storage.local;

const SELECTED_KEY = 'ptcg.listsSelected';
const SIZE_KEY = 'ptcg.listsPageSize';
const recall = (key) => { try { return localStorage.getItem(key) || ''; } catch { return ''; } };
const keep = (key, value) => { try { localStorage.setItem(key, String(value)); } catch { /* not worth failing over */ } };

function make(tag, props = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @returns {{unmount: () => void, refresh: () => Promise<void>}} */
export function mount(root) {
  const header = make('div', { className: 'page-header' });
  const intro = make('div');
  intro.append(
    make('h2', {}, 'Watch Lists'),
    make('p', { className: 'intro' }, 'Products you are watching on TCGplayer, stored in this browser and separate from your bookmarks.'),
  );
  const actions = make('div', { className: 'page-actions' });
  const newList = make('button', { type: 'button' }, 'New list');
  const exportButton = make('button', { type: 'button', className: 'secondary' }, 'Export JSON');
  actions.append(newList, exportButton);
  header.append(intro, actions);

  const status = make('p', { role: 'status' });
  status.id = 'status';
  // Shown from the first target that asks for notifications until it is dismissed.
  const notice = make('p', { className: 'subscribe-notice', hidden: true });
  notice.setAttribute('role', 'status');
  const noticeText = make('span', { className: 'subscribe-notice__text' });
  const noticeTopic = make('code', { className: 'subscribe-notice__topic' });
  const noticeLink = make('a', { className: 'subscribe-notice__link', href: '#settings' }, 'Open the Settings tab');
  noticeText.append(
    make('strong', {}, 'One more step to get notifications. '),
    'Alerts are sent to your topic ', noticeTopic,
    ', and arrive only on a phone or computer that is subscribed to it. ',
    noticeLink, ' to see how to subscribe and to send a test.',
  );
  const noticeDismiss = make('button', { type: 'button', className: 'subscribe-notice__dismiss secondary' }, 'Dismiss');
  notice.append(noticeText, noticeDismiss);
  const container = make('div');
  container.id = 'lists';
  root.append(header, status, notice, container);

  function say(message, isError = false) {
    status.textContent = message;
    status.setAttribute('data-error', isError ? '1' : '0');
  }

  // Which list is showing, and which page of it. Both are per-viewer conveniences.
  let selectedId = recall(SELECTED_KEY);
  let size = parsePageSize(recall(SIZE_KEY));
  let page = 1;

  function select(id) {
    selectedId = id;
    page = 1;
    keep(SELECTED_KEY, id);
  }

  // Price targets, by item key; which one is being edited; and whether anything is checking them.
  let targets = {};
  let editing = null;
  let autoRefreshOn = false;
  let topicReady = false;
  const targetView = () => ({ targets, editing, autoRefreshOn, hasTopic: topicReady });

  // Which durations each trend shows (a setting), and whose chart is open (by item key; this visit only).
  const trendView = {
    durations: undefined,
    expanded: {},
    onToggle: (key, days) => {
      if (trendView.expanded[key] === days) delete trendView.expanded[key];
      else trendView.expanded[key] = days;
      drawTrend(key);
    },
  };
  const drawTrend = (key) => updateTrend(container, key, trends[key] || null, trendOptionsFor(key, trendView));

  async function readSettings() {
    const settings = await loadSettings(storage);
    autoRefreshOn = settings.autoRefresh.enabled;
    topicReady = hasTopic(settings);
    const before = String(trendView.durations);
    trendView.durations = settings.trendDurations;
    // The setting changed while the list is showing: redraw the trends, nothing else.
    if (before !== 'undefined' && before !== String(trendView.durations)) for (const key of itemsByKey.keys()) drawTrend(key);
    noticeTopic.textContent = settings.notifications.topic;
    notice.hidden = !shouldShowSubscribeNotice(settings, targets);
  }

  const dismissNotice = () => updateSettings(storage, (s) => ({ ...s, subscribeNoticeDismissed: true })).then(readSettings);
  noticeDismiss.addEventListener('click', dismissNotice);
  // Following the link is having seen it.
  noticeLink.addEventListener('click', dismissNotice);

  async function mutate(change) {
    try {
      const next = change(await loadLists(storage));
      if (next) {
        await saveLists(storage, next);
        // A target goes when the last list holding its product does.
        const all = await loadTargets(storage);
        const kept = pruneTargets(all, next);
        if (Object.keys(kept).length !== Object.keys(all).length) await saveTargets(storage, kept);
      }
      say('');
    } catch (err) {
      say(err && err.message ? err.message : String(err), true);
    }
    await draw();
  }

  /** Redraw the target part of one product's rows, or of every row. */
  function drawTargets(key) {
    const items = key ? [itemsByKey.get(key)].filter(Boolean) : [...itemsByKey.values()];
    for (const item of items) updateTargetBlock(container, item, targetView(), handlers);
  }

  async function changeTargets(key, change) {
    try {
      targets = await saveTargets(storage, change(await loadTargets(storage)));
      editing = null;
    } catch (err) {
      editing = { ...(editing || { key }), key, error: err && err.message ? err.message : String(err) };
    }
    drawTargets(key);
  }

  const handlers = {
    onRemoveItem: (listId, key) => mutate((state) => removeItem(state, listId, key)),

    onEditTarget: (key) => {
      const before = editing && editing.key;
      editing = { key };
      if (before && before !== key) drawTargets(before);
      drawTargets(key);
      const field = container.querySelector('.target-form__price');
      if (field) field.focus();
    },
    onCancelTarget: (key) => { editing = null; drawTargets(key); },
    // Kept so that a redraw while the form is open puts back what was typed.
    onTargetDraft: (key, draft) => { if (editing && editing.key === key) editing = { key, draft }; },
    onSaveTarget: async (key, draft) => {
      editing = { key, draft };
      // Notifications need a topic; the secret word for it is asked for in the form.
      const needsTopic = draft.notify && !topicReady;
      const word = needsTopic ? parseSecretWord(draft.word) : null;
      if (word && !word.ok) {
        editing = { key, draft, error: word.error };
        drawTargets(key);
        return;
      }
      // First, while the click still counts: the browser may need to ask before notifications can be sent.
      const allowed = draft.notify ? await requestConsent(api) : true;
      if (word) topicReady = hasTopic(await createTopic(storage, word.word));
      await changeTargets(key, (all) => setTarget(all, key, draft));
      await readSettings();
      if (!editing && !allowed) {
        say('The target is saved, but Firefox was not given permission to send notifications, so it will not notify. '
          + 'Use Send test notification in Settings to allow it.', true);
      }
      // A target that is already met should say so now, not at the next refresh.
      if (!editing) window.dispatchEvent(new window.CustomEvent(CHECK_TARGETS_EVENT));
    },
    onRemoveTarget: (key) => changeTargets(key, (all) => removeTarget(all, key)),
    onEnableAutoRefresh: async () => {
      const settings = await updateSettings(storage, (s) => ({ ...s, autoRefresh: { ...s.autoRefresh, enabled: true } }));
      autoRefreshOn = settings.autoRefresh.enabled;
      drawTargets();
    },

    onSelectList: (listId) => { select(listId); draw(); },
    onPageSize: (next) => { size = next; page = 1; keep(SIZE_KEY, next); draw(); },
    onPage: (next) => {
      page = next;
      draw();
      if (container.scrollIntoView) container.scrollIntoView({ block: 'start' });
    },

    onRenameList: (listId) => mutate((state) => {
      const list = state.lists.find((l) => l.id === listId);
      const name = window.prompt('Rename list', list ? list.name : '');
      return name === null ? null : renameList(state, listId, name);
    }),

    // Each list keeps its own order, saved with the list.
    onSortChange: (listId, key) => mutate((state) => {
      page = 1;
      return setListSort(state, listId, { key, dir: defaultDirection(key) });
    }),

    onSortDirection: (listId) => mutate((state) => {
      const list = state.lists.find((l) => l.id === listId);
      if (!list) return null;
      const now = listSort(list);
      page = 1;
      return setListSort(state, listId, { key: now.key, dir: now.dir === 'asc' ? 'desc' : 'asc' });
    }),

    onDeleteList: (listId) => mutate((state) => {
      const list = state.lists.find((l) => l.id === listId);
      if (!list) return null;
      const count = list.items.length;
      const warning = count
        ? `Delete "${list.name}" and the ${count} item${count === 1 ? '' : 's'} in it?`
        : `Delete "${list.name}"?`;
      if (!window.confirm(warning)) return null;
      if (listId === selectedId) { selectedId = ''; page = 1; }
      return deleteList(state, listId);
    }),
  };

  // ---- price trends and asks, fetched only for items that scroll into view ----

  const trends = {};        // item key -> result, kept so a redraw never flashes back to "checking"
  const inflight = new Map(); // item key -> the request for it, so each card is asked about once
  const asks = {};          // ask key (product + condition) -> cheapest live listing, same idea
  const askInflight = new Map();
  let itemsByKey = new Map();
  let itemsByAskKey = new Map();
  let mounted = true;

  function requestTrend(key) {
    if (inflight.has(key)) return inflight.get(key);
    const item = itemsByKey.get(key);
    if (!item) return Promise.resolve();
    const request = (async () => {
      let result;
      try {
        result = await api.runtime.sendMessage({
          type: 'price-trend',
          ref: key,
          item: {
            productId: item.productId,
            language: item.language,
            condition: item.priceAtSave ? item.priceAtSave.condition : '',
          },
        });
      } catch {
        result = null;
      }
      trends[key] = result || { direction: 'unknown', pct: null, series: [], outliersHidden: 0, reason: 'unavailable' };
      // The tab may have been switched away while this was in flight.
      if (mounted) drawTrend(key);
    })();
    inflight.set(key, request);
    return request;
  }

  /** What buying it costs today: the cheapest live listing in this card's condition, with shipping. */
  function requestAsk(key) {
    if (askInflight.has(key)) return askInflight.get(key);
    const item = itemsByAskKey.get(key);
    if (!item) return Promise.resolve();
    const request = (async () => {
      let result;
      try {
        result = await api.runtime.sendMessage({
          type: 'listing-price',
          ref: key,
          item: { productId: item.productId, condition: item.priceAtSave ? item.priceAtSave.condition : '' },
        });
      } catch {
        result = null;
      }
      asks[key] = result && result.status ? result : { status: 'unavailable' };
      if (mounted) updateAsk(container, key, asks[key]);
    })();
    askInflight.set(key, request);
    return request;
  }

  // While TCGplayer is not answering, the background retries the lookup and tells us, so the
  // card says it is still loading and why, instead of looking stuck.
  let sortLoading = 0;
  const onRetryNotice = (message) => {
    if (!mounted || !message || message.type !== 'lookup-retry') return;
    // Only for what this page asked about: the notice reaches every dashboard tab that is open.
    if (message.kind === 'price-trend' && inflight.has(message.ref) && !isSettled(trends[message.ref])) {
      trends[message.ref] = retryingState(message);
      drawTrend(message.ref);
    } else if (message.kind === 'listing-price' && askInflight.has(message.ref) && !isSettled(asks[message.ref])) {
      asks[message.ref] = retryingState(message);
      updateAsk(container, message.ref, asks[message.ref]);
    } else {
      return;
    }
    if (sortLoading) say(`Loading prices for ${sortLoading} card${sortLoading === 1 ? '' : 's'}\u2026 TCGplayer is slow to answer, so some are being retried.`);
  };
  api.runtime.onMessage.addListener(onRetryNotice);

  // Sorting a list by volatility or ask needs that for every one of its cards,
  // not just the ones on the page; only the list on show is loaded.
  let sortRun = 0;
  async function loadEverythingForSort(state) {
    const shown = resolveSelection(state.lists, selectedId);
    const need = (test) => (shown && test(listSort(shown).key) ? shown.items : []);
    const missingTrends = [...new Set(need(needsHistory).map((i) => i.key))].filter((key) => !isSettled(trends[key]));
    const missingAsks = [...new Set(need(needsAsk).map(askKey))].filter((key) => !isSettled(asks[key]));
    const total = missingTrends.length + missingAsks.length;
    if (!total) return;
    const run = ++sortRun;
    say(`Loading prices for ${total} card${total === 1 ? '' : 's'}\u2026`);
    sortLoading = total;
    await Promise.all([...missingTrends.map(requestTrend), ...missingAsks.map(requestAsk)]);
    if (run === sortRun) sortLoading = 0;
    if (!mounted || run !== sortRun) return;
    say('');
    await draw();
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      requestTrend(entry.target.getAttribute('data-key'));
      requestAsk(entry.target.getAttribute('data-ask-key'));
    }
  }, { rootMargin: '200px' });

  async function draw() {
    const state = await loadLists(storage);
    targets = await loadTargets(storage);
    await readSettings();
    if (!mounted) return;
    const everything = state.lists.flatMap((l) => l.items);
    itemsByKey = new Map(everything.map((i) => [i.key, i]));
    itemsByAskKey = new Map(everything.map((i) => [askKey(i), i]));
    observer.disconnect();
    // Removing cards can leave the page past the end; step back to the last real one.
    const shown = resolveSelection(state.lists, selectedId);
    if (shown) page = pageOf(shown.items, { page, size }).page;
    renderLists(document, container, state, handlers, trends, asks, { selectedId, size, page, ...targetView(), trendView });
    for (const row of container.querySelectorAll('.item')) {
      if (!isSettled(trends[row.getAttribute('data-key')]) || !isSettled(asks[row.getAttribute('data-ask-key')])) observer.observe(row);
    }
    loadEverythingForSort(state);
  }

  newList.addEventListener('click', () => mutate((state) => {
    const name = window.prompt('Name the new list');
    if (name === null) return null;
    const created = createList(state, name);
    select(created.list.id);
    return created.state;
  }));

  exportButton.addEventListener('click', async () => {
    const json = exportJson(await loadLists(storage), await loadTargets(storage));
    try {
      await navigator.clipboard.writeText(json);
      say('Copied every list to the clipboard as JSON.');
    } catch {
      // Clipboard access can be refused; a download always works.
      const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'tcg-saved-lists.json';
      link.click();
      URL.revokeObjectURL(url);
      say('Downloaded your lists as JSON.');
    }
  });

  const onChanged = async (changes, area) => {
    if (area !== 'local') return;
    if (changes.lists) { draw(); return; }
    // A target was met, or changed in another tab; or auto-refresh was switched. Only the
    // target lines change, and the form someone is typing in is left alone.
    if (changes[TARGETS_KEY] || changes[SETTINGS_KEY]) {
      targets = await loadTargets(storage);
      await readSettings();
      if (!mounted) return;
      for (const item of itemsByKey.values()) {
        if (editing && editing.key === item.key && !changes[SETTINGS_KEY]) continue;
        updateTargetBlock(container, item, targetView(), handlers);
      }
    }
  };
  api.storage.onChanged.addListener(onChanged);

  /**
   * Ask again for the Ask and trend of the cards on the page shown. What is on screen
   * stays until the new answer arrives, so nothing flashes back to "checking".
   */
  async function refresh() {
    if (!mounted) return;
    const pending = [];
    for (const row of container.querySelectorAll('.item')) {
      const key = row.getAttribute('data-key');
      const ask = row.getAttribute('data-ask-key');
      // Still being asked for the first time: leave that request to finish.
      if (isSettled(trends[key])) { inflight.delete(key); pending.push(requestTrend(key)); }
      if (isSettled(asks[ask])) { askInflight.delete(ask); pending.push(requestAsk(ask)); }
    }
    await Promise.all(pending);
    if (!mounted || !pending.length) return;
    // An order that depends on prices may have changed with them.
    const state = await loadLists(storage);
    const shown = resolveSelection(state.lists, selectedId);
    if (shown && (needsAsk(listSort(shown).key) || needsHistory(listSort(shown).key)) && !editing) await draw();
  }

  draw();

  return {
    unmount: () => {
      mounted = false;
      observer.disconnect();
      api.storage.onChanged.removeListener(onChanged);
      api.runtime.onMessage.removeListener(onRetryNotice);
    },
    refresh,
  };
}
