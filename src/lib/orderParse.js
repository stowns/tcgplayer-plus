/*
 * TCGPlayer+ — reading orders from TCGplayer's Order History markup.
 *
 * Takes a parsed document and returns plain data. It deliberately reads only the
 * parts it names: the SHIP TO and BILL TO blocks (a name and a home address) are
 * never touched, so they cannot leak into storage, however the page is laid out.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseMoney } from './money.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december'];

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();
const textOf = (el) => (el ? clean(el.textContent) : '');

/** "September 27, 2026" -> "2026-09-27", or '' when it is not a date. */
export function parseOrderDate(text) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/.exec(clean(text));
  if (!m) return '';
  const month = MONTHS.indexOf(m[1].toLowerCase());
  const day = Number(m[2]);
  if (month < 0 || day < 1 || day > 31) return '';
  return `${m[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The product id is not in the link (it is a slug) but is in the thumbnail's file name. */
export function productIdFromThumbnail(img) {
  if (!img) return null;
  for (const attr of ['data-original', 'src']) {
    const m = /\/product\/(\d+)_/.exec(img.getAttribute(attr) || '');
    if (m && m[1] !== '0') return m[1];
  }
  return null;
}

/** "Rarity: Holo Rare / Condition: Near Mint Holofoil" */
function readDetails(cell) {
  const plain = cell ? cell.innerHTML.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '') : '';
  const pick = (label) => {
    const m = new RegExp(`${label}:\\s*([^\\n]*)`, 'i').exec(plain);
    return m ? clean(m[1]) : '';
  };
  return { rarity: pick('Rarity'), condition: pick('Condition') };
}

/** The set name is the loose text beside the product link (not the link, not "Sold by"). */
function readSetName(cell) {
  const holder = cell && cell.querySelector('span');
  if (!holder) return '';
  return clean([...holder.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(' '));
}

const linkOf = (a) => (a ? { name: textOf(a), url: a.getAttribute('href') || '' } : null);

/** The price cell's text as TCGplayer wrote it, without anything this extension added beside it. */
function withoutOurs(cell) {
  const copy = cell.cloneNode(true);
  copy.querySelectorAll('.ptcg-now').forEach((node) => node.remove());
  return copy.textContent;
}

/**
 * One purchased line.
 * @param {Element} row a `tr` of an order's item table
 * @returns {object|null} null when the row is not an item (no price cell)
 */
export function parseItemRow(row) {
  const priceCell = row.querySelector('td.orderHistoryPrice');
  if (!priceCell) return null;
  const link = row.querySelector('td.orderHistoryItems a');
  const img = row.querySelector('img.orderThumbnail');
  const quantity = Number(textOf(row.querySelector('td.orderHistoryQuantity')));
  const { rarity, condition } = readDetails(row.querySelector('td.orderHistoryDetail'));
  return {
    productId: productIdFromThumbnail(img),
    name: link ? clean(link.getAttribute('title') || link.textContent) : '',
    url: link ? link.getAttribute('href') || '' : '',
    setName: readSetName(row.querySelector('td.orderHistoryItems')),
    rarity,
    condition,
    // The PRICE column is per item (an order's subtotal is price x quantity).
    paid: parseMoney(withoutOurs(priceCell)),
    quantity: Number.isFinite(quantity) && quantity > 0 ? quantity : 1,
    imageUrl: img ? img.getAttribute('data-original') || img.getAttribute('src') || '' : '',
    seller: linkOf(row.querySelector('.orderSoldby a')),
  };
}

const SUMMARY_FIELDS = [
  ['quantity', /^quantity/i], ['subtotal', /^subtotal/i], ['shipping', /^shipping/i],
  ['tax', /^sales tax/i], ['total', /^total/i],
];

export function parseSummary(wrap) {
  const summary = { quantity: null, subtotal: null, shipping: null, tax: null, total: null };
  const table = wrap.querySelector('table[data-aid="tbl-sellerorderwidget-productsinorder"]');
  for (const tr of table ? table.querySelectorAll('tr') : []) {
    const cells = tr.querySelectorAll('td');
    if (cells.length < 2) continue;
    const label = textOf(cells[0]);
    const match = SUMMARY_FIELDS.find(([, re]) => re.test(label));
    if (!match) continue;
    const value = textOf(cells[1]);
    summary[match[0]] = match[0] === 'quantity' ? (Number(value) || null) : parseMoney(value);
  }
  return summary;
}

/** The header spans are "Label / value" pairs; the number's label differs for TCGplayer Direct. */
function parseHeader(wrap) {
  const header = { number: '', kind: 'marketplace' };
  for (const span of wrap.querySelectorAll('.orderHeader > span')) {
    const title = span.querySelector('.orderTitle');
    if (!title) continue;
    const label = textOf(title);
    if (/order number|direct #/i.test(label)) {
      header.number = clean(textOf(span).replace(label, ''));
      if (/direct/i.test(label)) header.kind = 'direct';
    }
  }
  return header;
}

/** "SHIPPED AND SOLD BY" (or "SHIPPED BY" on Direct orders): who, and how it is travelling. */
function parseFulfilment(wrap) {
  const block = [...wrap.querySelectorAll('.orderSummary')]
    .find((el) => /^(shipped( and sold)? by|sold by)$/i.test(textOf(el.querySelector('.orderTitle'))));
  const out = { seller: null, shippingStatus: '', shippingMethod: '' };
  if (!block) return out;

  const vendor = block.querySelector('[data-aid="spn-sellerorderwidget-vendorname"] a');
  if (vendor) out.seller = linkOf(vendor);
  else if (/tcgplayer\s*direct/i.test(block.textContent)) out.seller = { name: 'TCGplayer Direct', url: '' };

  const status = block.querySelector('[data-aid="spn-sellerorderwidget-trackingnumber"]');
  if (status) {
    out.shippingStatus = textOf(status);
    // What follows the status line is the method: "Standard (est.delivery by ...) - $1.49".
    let node = status.nextSibling;
    const parts = [];
    while (node) {
      if (node.nodeType === 3) parts.push(node.textContent);
      node = node.nextSibling;
    }
    out.shippingMethod = clean(parts.join(' '));
  }
  return out;
}

/**
 * Every order on a page of Order History.
 * @returns {{orderNumber: string, kind: 'marketplace'|'direct', date: string, channel: string,
 *   seller: {name: string, url: string}|null, shippingStatus: string, shippingMethod: string,
 *   summary: object, items: object[]}[]}
 */
export function parseOrders(doc) {
  const orders = [];
  for (const wrap of doc.querySelectorAll('.orderWrap')) {
    const { number, kind } = parseHeader(wrap);
    // Without a number there is nothing to file it under, and nothing to update later.
    if (!number) continue;
    const fulfilment = parseFulfilment(wrap);
    orders.push({
      orderNumber: number,
      kind,
      date: parseOrderDate(textOf(wrap.querySelector('[data-aid="spn-sellerorderwidget-orderdate"]'))),
      channel: textOf(wrap.querySelector('[data-aid="spn-sellerorderwidget-orderchannel"]')),
      seller: fulfilment.seller,
      shippingStatus: fulfilment.shippingStatus,
      shippingMethod: fulfilment.shippingMethod,
      summary: parseSummary(wrap),
      items: [...wrap.querySelectorAll('table.orderTable tbody tr')].map(parseItemRow).filter(Boolean),
    });
  }
  return orders;
}

/** Which page of how many, and how many orders in the range in total. */
export function parsePager(doc) {
  const pager = doc.querySelector('.pager');
  let page = 1;
  let pages = 1;
  if (pager) {
    page = Number(textOf(pager.querySelector('.currentPage'))) || 1;
    pages = page;
    for (const a of pager.querySelectorAll('a[href]')) {
      const m = /[?&]PageNumber=(\d+)/i.exec(a.getAttribute('href'));
      if (m) pages = Math.max(pages, Number(m[1]));
    }
  }
  const viewing = /of\s+(\d+)\s+order/i.exec(textOf(doc.querySelector('.breadcrumbs')));
  return { page, pages, total: viewing ? Number(viewing[1]) : null };
}

/** The filter form the page's own date-range dropdown submits. */
export function parseFilterForm(doc) {
  const form = doc.querySelector('#OrderHistoryFilterForm');
  if (!form) return null;
  const fields = {};
  for (const input of form.querySelectorAll('input[name]')) {
    if (input.type === 'submit' || input.type === 'button') continue;
    fields[input.getAttribute('name')] = input.getAttribute('value') ?? '';
  }
  const options = [...form.querySelectorAll('select#DateRange option')].map((o) => clean(o.textContent));
  const selected = form.querySelector('select#DateRange option[selected]');
  return {
    action: form.getAttribute('action') || '/myaccount/orderhistory',
    token: fields.__RequestVerificationToken || '',
    fields,
    ranges: options,
    range: selected ? clean(selected.textContent) : options[0] || '',
  };
}

/** A signed-in account always has the filter form, even with no orders in the range. */
export function looksSignedOut(doc) {
  return !doc.querySelector('#OrderHistoryFilterForm');
}
