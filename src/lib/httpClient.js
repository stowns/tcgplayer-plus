/*
 * TCGPlayer+ — the one way this extension talks to TCGplayer.
 *
 * Every request is paced by a throttle, given a time limit, and retried with
 * exponential backoff and jitter (see retry.js) when it fails in a way that may
 * pass. Each attempt goes through the throttle again, and the wait between
 * attempts is spent outside it, so a struggling server is not held a slot while
 * it recovers.
 *
 * Everything is injected, so this is tested without a network or a clock.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  HttpError, TimeoutError, RETRYABLE_STATUSES, parseRetryAfter, withRetry,
} from './retry.js';

/** How long one attempt may take, from when it starts to when its answer has been read. */
export const REQUEST_TIMEOUT_MS = 5000;

/**
 * Run `work(signal)` for at most `ms`. The signal is aborted when time runs out so a
 * real fetch is cancelled; the race means a fetch that ignores the signal still ends.
 */
function withTimeout(work, ms, { setTimer, clearTimer }) {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimer(() => {
      controller.abort();
      reject(new TimeoutError(ms));
    }, ms);
  });
  return Promise.race([work(controller.signal), expired]).finally(() => clearTimer(timer));
}

/**
 * @param {object} deps
 * @param {typeof fetch} deps.fetch
 * @param {{run: (task: () => Promise<any>) => Promise<any>}} deps.throttle
 * @param {number} [deps.timeoutMs]  per attempt
 * @param {object} [deps.retry]  overrides for retry.js: retries, baseMs, capMs, maxRetryAfterMs, random, sleep
 * @param {Function} [deps.setTimer]  setTimeout, replaceable for tests
 * @param {Function} [deps.clearTimer]
 */
export function createClient({
  fetch: doFetch, throttle, timeoutMs = REQUEST_TIMEOUT_MS, retry = {},
  setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t),
}) {
  /**
   * @param {string} url
   * @param {RequestInit} [init]
   * @param {{onRetry?: Function}} [hooks]  told before each wait, so the user can be
   * @param {(response: Response) => any} [read]  reads the answer; it runs inside the time limit,
   *   so a body that never finishes arriving counts as a timeout too
   * @returns {Promise<any>} what `read` returns (by default the Response itself, for any status that
   *   is not worth retrying, including a 404: check `ok`); throws HttpError if the server kept
   *   answering with a retryable status, TimeoutError or the network error if that kept happening
   */
  function request(url, init = {}, { onRetry } = {}, read = (response) => response) {
    return withRetry(() => throttle.run(() => withTimeout(async (signal) => {
      const response = await doFetch(url, { ...init, signal });
      if (!response.ok && RETRYABLE_STATUSES.includes(response.status)) {
        const header = response.headers && typeof response.headers.get === 'function' ? response.headers.get('Retry-After') : null;
        throw new HttpError(response.status, { retryAfterMs: parseRetryAfter(header) });
      }
      return read(response);
    }, timeoutMs, { setTimer, clearTimer })), { ...retry, onRetry });
  }

  const asJson = (response) => {
    if (!response.ok) throw new HttpError(response.status);
    return response.json();
  };

  /** GET and parse JSON; any failing status is an error. */
  function getJson(url, hooks) {
    return request(url, { headers: { Accept: 'application/json' } }, hooks, asJson);
  }

  /** POST a JSON body and parse the JSON answer; any failing status is an error. */
  function postJson(url, body, hooks) {
    return request(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, hooks, asJson);
  }

  return { request, getJson, postJson };
}
