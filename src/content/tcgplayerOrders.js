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

const api = globalThis.browser || globalThis.chrome;

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

async function annotate() {
  if (!isOrderHistoryPath(location.pathname)) return;
  const items = parseOrderItems(document).filter((item) => isPending(item.row));
  // Only when rows are new to us: reading the whole page on every page change would be wasteful.
  if (items.length) snapshot();
  for (const item of items) {
    if (item.productId && item.paid !== null) {
      showNow(document, item, null);
      lines.set(item.row, { item, result: null });
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
          item: { productId: item.productId, condition: item.condition },
        });
      } catch {
        result = UNAVAILABLE;
      }
      const answer = result && result.status ? result : UNAVAILABLE;
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
