/*
 * TCGPlayer+ — retrying a request that failed for a reason that may pass.
 *
 * The strategy is exponential backoff with full jitter, as described in
 * "Exponential Backoff And Jitter" (AWS Architecture Blog, Marc Brooker, 2015)
 * and the AWS Builders' Library article "Timeouts, retries and backoff with
 * jitter":
 *
 *     wait before retry n  =  random(0, min(cap, base * 2^(n - 1)))      n = 1, 2, 3 …
 *
 * - Exponential: each retry waits up to twice as long as the one before, so a
 *   server that is struggling gets more room, not a steady hammering.
 * - Capped: no single wait grows past `capMs`.
 * - Full jitter: the wait is a random point in that range rather than the range's
 *   end, so many clients that failed together do not all come back together.
 * - A server's own `Retry-After` (RFC 9110 §10.2.3, seconds or an HTTP date) is
 *   honoured as a minimum wait. If it asks for longer than `maxRetryAfterMs` we
 *   stop rather than hold the user waiting.
 * - Only failures that may pass are retried: a dropped connection, 408, 425, 429
 *   and 500, 502, 503, 504. A 400, 401, 403 or 404 would fail the same way again.
 * - A request that takes too long counts as failed, and is retried (see httpClient.js).
 * - A bounded number of retries, so there is always an answer in the end.
 *
 * Time and randomness are injected, so this is tested without waiting.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const RETRY = {
  /** Retries after the first attempt, so a request is tried at most `retries + 1` times. */
  retries: 4,
  /** The first retry waits up to this long... */
  baseMs: 500,
  /** ...and no retry waits up to more than this (waits then are at most 500, 1000, 2000, 4000 ms). */
  capMs: 8000,
  /** A `Retry-After` longer than this is not worth waiting for. */
  maxRetryAfterMs: 30000,
};

/** Statuses that are about the moment, not the request. */
export const RETRYABLE_STATUSES = [408, 425, 429, 500, 502, 503, 504];

/** A response with a status we may want to try again; carries any `Retry-After`. */
export class HttpError extends Error {
  constructor(status, { retryAfterMs = null, message } = {}) {
    super(message || `TCGplayer responded ${status}`);
    this.name = 'HttpError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A request that did not finish in time. Retried, like a dropped connection. */
export class TimeoutError extends Error {
  constructor(ms) {
    super(`TCGplayer did not respond within ${ms / 1000} seconds`);
    this.name = 'TimeoutError';
    this.timeoutMs = ms;
  }
}

/** `Retry-After` as milliseconds from now: a number of seconds, or an HTTP date. Null if absent or unreadable. */
export function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  // An HTTP date has a month name; this keeps odd strings such as "-3" from parsing as one.
  const date = /[a-z]/i.test(text) ? Date.parse(text) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Is this failure worth another go? Network failures, timeouts and the statuses above are; anything else is not. */
export function isRetryable(error) {
  if (!error) return false;
  if (error.name === 'AbortError') return false;
  if (error instanceof HttpError) return RETRYABLE_STATUSES.includes(error.status);
  if (error instanceof TimeoutError) return true;
  // fetch rejects with a TypeError when the connection fails; anything thrown by our own code is not a network problem.
  return error instanceof TypeError;
}

/** The longest the n-th retry (1-based) may wait: base * 2^(n-1), up to the cap. */
export function backoffCeiling(retry, { baseMs = RETRY.baseMs, capMs = RETRY.capMs } = {}) {
  return Math.min(capMs, baseMs * 2 ** (retry - 1));
}

/** How long to wait before the n-th retry (1-based): a random point from 0 to its ceiling. */
export function backoffDelay(retry, { baseMs, capMs, random = Math.random } = {}) {
  return Math.floor(random() * backoffCeiling(retry, { baseMs, capMs }));
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task`, and run it again after a backoff if it fails in a way that may pass.
 * @param {(attempt: number) => Promise<any>} task  `attempt` counts from 1
 * @param {object} [options]
 * @param {number} [options.retries]
 * @param {number} [options.baseMs]
 * @param {number} [options.capMs]
 * @param {number} [options.maxRetryAfterMs]
 * @param {(error: Error) => boolean} [options.shouldRetry]
 * @param {(info: {retry: number, retries: number, delayMs: number, error: Error}) => void} [options.onRetry]
 *   called before each wait, so something can tell the user the data is still coming
 * @param {() => number} [options.random]  0 up to (not including) 1
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<any>} what `task` returned; or throws the last error once retries run out
 */
export async function withRetry(task, options = {}) {
  const {
    retries = RETRY.retries, baseMs = RETRY.baseMs, capMs = RETRY.capMs, maxRetryAfterMs = RETRY.maxRetryAfterMs,
    shouldRetry = isRetryable, onRetry, random = Math.random, sleep = defaultSleep,
  } = options;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      const retry = attempt; // the retry this failure would lead to is number `attempt`
      if (retry > retries || !shouldRetry(error)) throw error;
      const asked = error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 0;
      if (asked > maxRetryAfterMs) throw error;
      const delayMs = Math.max(backoffDelay(retry, { baseMs, capMs, random }), asked);
      if (onRetry) onRetry({ retry, retries, delayMs, error });
      await sleep(delayMs);
    }
  }
}
