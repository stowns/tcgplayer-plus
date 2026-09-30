/*
 * TCGPlayer+ — reading your orders from TCGplayer and keeping them.
 *
 * Runs in the Order History page, not the background: reading the pages needs an
 * HTML parser, and a Chrome background is a service worker with no DOM. Every
 * dependency is injected, so this is testable without a browser.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createThrottle } from './throttle.js';
import { syncOrders } from './orderSync.js';
import { archiveOrders } from './ordersArchive.js';

/** One order page at a time, a beat apart: this is somebody's account, not an API. */
export const ORDER_PACE = { concurrency: 1, minIntervalMs: 250 };

/**
 * @param {{range?: string}} options a TCGplayer range label, or none to read the range the account shows
 * @param {{fetch: typeof fetch, parseHtml: (html: string) => Document, storage: object,
 *   throttle?: {run: Function}, now?: () => string}} deps
 * @returns {Promise<{status: 'ok'|'partial'|'signed-out'|'error', error: string, range: string,
 *   rangeApplied: boolean, pages: number, count: number, added: number, updated: number}>}
 */
export async function readOrders({ range } = {}, deps) {
  const throttle = deps.throttle || createThrottle(ORDER_PACE);

  const getText = (url) => throttle.run(async () => {
    const response = await deps.fetch(url, { credentials: 'include', redirect: 'follow', headers: { Accept: 'text/html' } });
    return { ok: response.ok, status: response.status, url: response.url, text: await response.text() };
  });

  // What TCGplayer's own date-range dropdown sends: an AJAX form post carrying the page's token.
  const postForm = (url, body, token) => throttle.run(async () => {
    const response = await deps.fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        __RequestVerificationToken: token,
      },
      body,
    });
    return { ok: response.ok, status: response.status };
  });

  let result;
  try {
    result = await syncOrders({ range }, { getText, postForm, parseHtml: deps.parseHtml });
  } catch (err) {
    return { status: 'error', error: String(err && err.message ? err.message : err), range: '', rangeApplied: true, pages: 0, count: 0, added: 0, updated: 0 };
  }

  let added = 0;
  let updated = 0;
  if (result.orders.length) {
    try {
      // Only a complete read counts as having synced this range.
      ({ added, updated } = await archiveOrders(deps.storage, result.orders, {
        range: result.status === 'ok' && result.range ? result.range : undefined,
        ...(deps.now ? { now: deps.now() } : {}),
      }));
    } catch (err) {
      return {
        status: 'error', error: `Could not save the orders (${String(err && err.message ? err.message : err)})`,
        range: result.range, rangeApplied: result.rangeApplied, pages: result.pages, count: result.orders.length, added: 0, updated: 0,
      };
    }
  }
  return {
    status: result.status, error: result.error || '', range: result.range,
    rangeApplied: result.rangeApplied, pages: result.pages, count: result.orders.length, added, updated,
  };
}
