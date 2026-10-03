/*
 * TCGPlayer+ — today's price beside what you paid, on TCGplayer's
 * Order History page. The page is only visible when signed in, so this reads
 * the tables already on screen and never touches an account.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseOrderItems, showNow, showTotal, isPending, isOrderHistoryPath } from '../lib/orderHistoryDom.js';
import { parseOrders } from '../lib/orderParse.js';
import { archiveOrders } from '../lib/ordersArchive.js';
import { costLine } from '../lib/orderCost.js';
import { api } from '../lib/runtime.js';
import { retryingState, isRetrying } from '../lib/retryState.js';


const UNAVAILABLE = { status: 'unavailable' };

/**
 * Whatever this page shows also goes into the archive, so orders are kept even
 * if the Order History view's own read is ever refused. Merging is idempotent.
 */
let archivedSignature = '';
async function snapshot() {
  const orders = parseOrders(document);
  const signature = JSON.stringify(orders);
  if (!orders.length || signature === archivedSignature) return;
  archivedSignature = signature;
  try {
    await archiveOrders(api.storage.local, orders);
  } catch {
    archivedSignature = '';
  }
}

// Every line seen so far, with its answer once it arrives, for the page total.
const lines = new Map();

function refreshTotal() {
  for (const [row] of lines) if (!row.isConnected) lines.delete(row);
  if (lines.size) showTotal(document, [...lines.values()].map(({ item, result }) => costLine(item, item.shippingShare, result)));
}

// Rows still waiting for a price, by what was asked (product and condition), so a
// retry notice from the background can reach every row it concerns.
const waiting = new Map();
const refOf = (item) => `${item.productId}|${item.condition}`;

api.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== 'lookup-retry' || message.kind !== 'listing-price') return;
  for (const item of waiting.get(message.ref) || []) {
    const line = lines.get(item.row);
    // A line that already has its real answer is not still waiting.
    if (!line || (line.result && !isRetrying(line.result))) continue;
    line.result = retryingState(message);
    showNow(document, item, line.result);
  }
  refreshTotal();
});

async function annotate() {
  if (!isOrderHistoryPath(location.pathname)) return;
  const items = parseOrderItems(document).filter((item) => isPending(item.row));
  // Only when rows are new to us: reading the whole page on every page change would be wasteful.
  if (items.length) snapshot();
  for (const item of items) {
    if (item.productId && item.paid !== null) {
      showNow(document, item, null);
      lines.set(item.row, { item, result: null });
      const ref = refOf(item);
      if (!waiting.has(ref)) waiting.set(ref, new Set());
      waiting.get(ref).add(item);
    } else {
      item.row.setAttribute('data-ptcg-now', 'skipped');
    }
  }
  // Only when something new arrived: drawing the total is itself a page change,
  // and redrawing it on every change would never settle.
  if (items.length) refreshTotal();
  await Promise.all(items
    .filter((item) => item.productId && item.paid !== null)
    .map(async (item) => {
      let result;
      try {
        result = await api.runtime.sendMessage({
          type: 'listing-price',
          ref: refOf(item),
          item: { productId: item.productId, condition: item.condition },
        });
      } catch {
        result = UNAVAILABLE;
      }
      const answer = result && result.status ? result : UNAVAILABLE;
      const stillWaiting = waiting.get(refOf(item));
      if (stillWaiting) {
        stillWaiting.delete(item);
        if (!stillWaiting.size) waiting.delete(refOf(item));
      }
      showNow(document, item, answer);
      if (lines.has(item.row)) lines.get(item.row).result = answer;
      refreshTotal();
    }));
}

let queued = false;
new MutationObserver(() => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; annotate(); });
}).observe(document.documentElement, { childList: true, subtree: true });

annotate();
