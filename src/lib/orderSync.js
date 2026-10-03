/*
 * TCGPlayer+ — reading your orders from TCGplayer.
 *
 * Does what the Order History page itself does: load it, optionally choose a
 * date range (the same form post its own dropdown makes), then page through the
 * results. The network is injected, so all of it is testable without a browser.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseOrders, parsePager, parseFilterForm, looksSignedOut } from './orderParse.js';

export const ORDER_HISTORY_URL = 'https://store.tcgplayer.com/myaccount/orderhistory';
const FILTER_POST_URL = 'https://store.tcgplayer.com/MyAccount/OrderHistory';
/** Where to sign in; TCGplayer sends you on to your order history afterwards. */
export const SIGN_IN_URL = 'https://www.tcgplayer.com/login/revalidate?returnUrl=/myaccount/orderhistory';
/** A safety stop, not a limit anyone should meet: 10 orders a page. */
export const MAX_PAGES = 60;

const pageUrl = (n) => (n <= 1 ? ORDER_HISTORY_URL : `${ORDER_HISTORY_URL}?PageNumber=${n}`);

/** A redirect to the login page is how TCGplayer says "not signed in". */
function wasSentToLogin(response) {
  return /\/login\b|\/account\/login/i.test(String(response && response.url));
}

/**
 * @param {{range?: string}} options  a TCGplayer range label ("Last 90 Days", "2025"); omit to read
 *   whatever range the account currently shows
 * @param {{getText: (url: string) => Promise<{ok: boolean, status: number, url: string, text: string}>,
 *   postForm: (url: string, body: string, token: string) => Promise<{ok: boolean, status: number}>,
 *   parseHtml: (html: string) => Document}} deps
 * @returns {Promise<{status: 'ok'|'partial'|'signed-out'|'error', orders: object[], range: string,
 *   pages: number, rangeApplied: boolean, error?: string}>}
 */
export async function syncOrders({ range } = {}, deps) {
  const result = { status: 'ok', orders: [], range: '', pages: 0, rangeApplied: true };
  const fetchPage = async (n) => {
    const response = await deps.getText(pageUrl(n));
    if (wasSentToLogin(response)) return { signedOut: true };
    if (!response.ok) throw new Error(`TCGplayer responded ${response.status}`);
    return { doc: deps.parseHtml(response.text) };
  };

  try {
    let first = await fetchPage(1);
    if (first.signedOut || looksSignedOut(first.doc)) return { ...result, status: 'signed-out' };

    let form = parseFilterForm(first.doc);
    // A leftover search term would silently narrow every page, so it is cleared with the range.
    const needsPost = (range && form.range !== range) || (form.fields.SearchString || '').trim() !== '';
    if (needsPost) {
      const body = new URLSearchParams({ ...form.fields, SearchString: '', DateRange: range || form.range, ClearSessionFilters: 'true' });
      const posted = await deps.postForm(FILTER_POST_URL, body.toString(), form.token);
      if (!posted.ok) throw new Error(`TCGplayer would not change the range (${posted.status})`);
      first = await fetchPage(1);
      if (first.signedOut || looksSignedOut(first.doc)) return { ...result, status: 'signed-out' };
      form = parseFilterForm(first.doc);
    }
    result.range = form.range;
    result.rangeApplied = !range || form.range === range;

    const { pages } = parsePager(first.doc);
    result.orders.push(...parseOrders(first.doc));
    result.pages = 1;

    for (let n = 2; n <= Math.min(pages, MAX_PAGES); n += 1) {
      try {
        const next = await fetchPage(n);
        if (next.signedOut) return { ...result, status: 'partial', error: 'You were signed out part-way through.' };
        result.orders.push(...parseOrders(next.doc));
        result.pages = n;
      } catch (err) {
        // Keep what was read; the archive should not lose pages 1..n-1 to a failure at n.
        return { ...result, status: 'partial', error: err && err.message ? err.message : String(err) };
      }
    }
    return result;
  } catch (err) {
    return { ...result, status: 'error', error: err && err.message ? err.message : String(err) };
  }
}
