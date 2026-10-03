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
import { createClient } from './httpClient.js';
import { HttpError } from './retry.js';
import { syncOrders } from './orderSync.js';
import { archiveOrders } from './ordersArchive.js';

/** One order page at a time, a beat apart: this is somebody's account, not an API. */
export const ORDER_PACE = { concurrency: 1, minIntervalMs: 250 };

/**
 * @param {{range?: string}} options a TCGplayer range label, or none to read the range the account shows
 * @param {{fetch: typeof fetch, parseHtml: (html: string) => Document, storage: object,
 *   throttle?: {run: Function}, now?: () => string, retry?: object, timeoutMs?: number,
 *   onRetry?: (info: {retry: number, retries: number, delayMs: number}) => void}} deps
 *   `onRetry` is told before each wait when TCGplayer did not answer and a page is about to be asked for again
 * @returns {Promise<{status: 'ok'|'partial'|'signed-out'|'error', error: string, range: string,
 *   rangeApplied: boolean, pages: number, count: number, added: number, updated: number}>}
 */
export async function readOrders({ range } = {}, deps) {
  const throttle = deps.throttle || createThrottle(ORDER_PACE);
  const client = createClient({ fetch: deps.fetch, throttle, retry: deps.retry, timeoutMs: deps.timeoutMs });
  const hooks = { onRetry: deps.onRetry };

  // A page that keeps failing after the retries is reported as a failed page, so a read
  // that got part of the way is kept as "partial" rather than thrown away.
  const exhausted = (err) => {
    if (err instanceof HttpError) return { ok: false, status: err.status, url: '', text: '' };
    throw err;
  };

  const getText = async (url) => {
    try {
      return await client.request(
        url,
        { credentials: 'include', redirect: 'follow', headers: { Accept: 'text/html' } },
        hooks,
        async (response) => ({ ok: response.ok, status: response.status, url: response.url, text: await response.text() }),
      );
    } catch (err) {
      return exhausted(err);
    }
  };

  // What TCGplayer's own date-range dropdown sends: an AJAX form post carrying the page's token.
  const postForm = async (url, body, token) => {
    try {
      const response = await client.request(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          __RequestVerificationToken: token,
        },
        body,
      }, hooks);
      return { ok: response.ok, status: response.status };
    } catch (err) {
      return exhausted(err);
    }
  };

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
