/*
 * TCGPlayer+ — the local archive of purchases.
 *
 * TCGplayer only shows the last 120 days by default, so what we have read is
 * kept here and only ever added to: an order that ages out of TCGplayer's
 * window is still here. Every read is defensive (a damaged entry is dropped,
 * never allowed to take the rest with it), and only the fields named below are
 * kept, so nothing else a page happens to carry can end up in storage.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const ORDERS_KEY = 'orders';
export const ORDERS_VERSION = 1;
export const ALL_SAVED = 'All saved';

export function emptyArchive() {
  return { version: ORDERS_VERSION, orders: {}, syncedAt: {} };
}

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const money = (v) => (Number.isFinite(v) ? v : null);
const link = (v) => (v && typeof v === 'object' && str(v.name) ? { name: str(v.name, 120), url: str(v.url, 500) } : null);

function sanitizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const quantity = Number(raw.quantity);
  return {
    productId: /^\d+$/.test(String(raw.productId ?? '')) ? String(raw.productId) : null,
    name: str(raw.name, 200) || 'Unknown product',
    url: str(raw.url, 500),
    setName: str(raw.setName, 120),
    rarity: str(raw.rarity, 80),
    condition: str(raw.condition, 80),
    paid: money(raw.paid),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    imageUrl: str(raw.imageUrl, 500),
    seller: link(raw.seller),
  };
}

export function sanitizeOrder(raw) {
  if (!raw || typeof raw !== 'object' || !str(raw.orderNumber).trim()) return null;
  const s = raw.summary && typeof raw.summary === 'object' ? raw.summary : {};
  return {
    orderNumber: str(raw.orderNumber, 60).trim(),
    kind: raw.kind === 'direct' ? 'direct' : 'marketplace',
    date: /^\d{4}-\d{2}-\d{2}$/.test(str(raw.date)) ? raw.date : '',
    channel: str(raw.channel, 80),
    seller: link(raw.seller),
    shippingStatus: str(raw.shippingStatus, 120),
    shippingMethod: str(raw.shippingMethod, 200),
    summary: {
      quantity: Number.isFinite(s.quantity) ? s.quantity : null,
      subtotal: money(s.subtotal), shipping: money(s.shipping), tax: money(s.tax), total: money(s.total),
    },
    items: (Array.isArray(raw.items) ? raw.items : []).map(sanitizeItem).filter(Boolean).slice(0, 200),
    firstSeen: str(raw.firstSeen, 40),
    lastSeen: str(raw.lastSeen, 40),
  };
}

export function sanitizeArchive(raw) {
  if (!raw || typeof raw !== 'object' || !raw.orders || typeof raw.orders !== 'object' || Array.isArray(raw.orders)) {
    return emptyArchive();
  }
  const orders = {};
  for (const value of Object.values(raw.orders)) {
    const order = sanitizeOrder(value);
    if (order) orders[order.orderNumber] = order;
  }
  const syncedAt = {};
  for (const [range, at] of Object.entries(raw.syncedAt && typeof raw.syncedAt === 'object' ? raw.syncedAt : {})) {
    if (typeof at === 'string') syncedAt[range.slice(0, 40)] = at.slice(0, 40);
  }
  return { version: ORDERS_VERSION, orders, syncedAt };
}

/**
 * Add what was just read. A newer read of the same order replaces the older one
 * (its shipping status moves on), and nothing is ever removed.
 * @returns {{archive: object, added: number, updated: number}}
 */
export function mergeOrders(archive, incoming, { now = new Date().toISOString() } = {}) {
  const orders = { ...archive.orders };
  let added = 0;
  let updated = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    const order = sanitizeOrder(raw);
    if (!order) continue;
    const existing = orders[order.orderNumber];
    orders[order.orderNumber] = { ...order, firstSeen: existing ? existing.firstSeen || now : now, lastSeen: now };
    if (!existing) added += 1;
    else if (JSON.stringify({ ...existing, lastSeen: '' }) !== JSON.stringify({ ...orders[order.orderNumber], lastSeen: '' })) updated += 1;
  }
  return { archive: { ...archive, orders }, added, updated };
}

export function recordSync(archive, range, now = new Date().toISOString()) {
  return { ...archive, syncedAt: { ...archive.syncedAt, [range]: now } };
}

/** Newest first; undated orders last. */
export function sortOrders(orders) {
  return [...orders].sort((a, b) => (b.date || '').localeCompare(a.date || '')
    || b.orderNumber.localeCompare(a.orderNumber));
}

const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * The dates a range label covers, as inclusive ISO dates; null for "all".
 * TCGplayer's own labels: "Last 30 Days", "Last 90 Days", "Last 120 Days", "2025".
 */
export function rangeWindow(label, today) {
  const days = /^Last (\d+) Days$/i.exec(String(label || ''));
  if (days) {
    const end = Date.parse(`${today}T00:00:00Z`);
    return { from: ymd(end - Number(days[1]) * 86400000), to: today };
  }
  if (/^\d{4}$/.test(String(label || ''))) return { from: `${label}-01-01`, to: `${label}-12-31` };
  return null;
}

/** The choices TCGplayer's own dropdown offers, plus the archive as a whole. */
export function rangeChoices(year) {
  const years = [];
  for (let y = year; y >= 2016; y -= 1) years.push(String(y));
  return ['Last 30 Days', 'Last 90 Days', 'Last 120 Days', ...years, ALL_SAVED];
}

export function ordersInRange(archive, label, today) {
  const all = Object.values(archive.orders);
  const window = rangeWindow(label, today);
  const picked = window ? all.filter((o) => o.date && o.date >= window.from && o.date <= window.to) : all;
  return sortOrders(picked);
}

// --- storage ---------------------------------------------------------------

export async function loadArchive(storage) {
  try {
    const bag = await storage.get(ORDERS_KEY);
    return sanitizeArchive(bag && bag[ORDERS_KEY]);
  } catch {
    return emptyArchive();
  }
}

export async function saveArchive(storage, archive) {
  await storage.set({ [ORDERS_KEY]: archive });
}

/** Read, merge, write; the one place a sync and the order-page snapshot both use. */
export async function archiveOrders(storage, orders, options = {}) {
  const { archive, added, updated } = mergeOrders(await loadArchive(storage), orders, options);
  const next = options.range ? recordSync(archive, options.range, options.now) : archive;
  await saveArchive(storage, next);
  return { archive: next, added, updated };
}
