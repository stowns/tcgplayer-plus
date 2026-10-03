import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RETRY, RETRYABLE_STATUSES, HttpError, TimeoutError, parseRetryAfter, isRetryable, backoffCeiling, backoffDelay, withRetry,
} from '../src/lib/retry.js';

const noSleep = () => Promise.resolve();
const failing = (...errors) => {
  let calls = 0;
  const task = async () => { const e = errors[calls]; calls += 1; if (e) throw e; return 'ok'; };
  return { task, calls: () => calls };
};

test('the ceiling doubles with each retry and stops at the cap', () => {
  const opts = { baseMs: 500, capMs: 8000 };
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => backoffCeiling(n, opts)), [500, 1000, 2000, 4000, 8000, 8000]);
  assert.deepEqual([1, 2, 3, 4].map((n) => backoffCeiling(n)), [500, 1000, 2000, 4000], 'the defaults');
});

test('the wait is a random point from zero to the ceiling (full jitter)', () => {
  const opts = { baseMs: 500, capMs: 8000 };
  assert.equal(backoffDelay(3, { ...opts, random: () => 0 }), 0);
  assert.equal(backoffDelay(3, { ...opts, random: () => 0.5 }), 1000);
  assert.equal(backoffDelay(3, { ...opts, random: () => 0.999999 }), 1999);
  for (let i = 0; i < 200; i += 1) {
    const d = backoffDelay(4, { ...opts, random: Math.random });
    assert.ok(d >= 0 && d < 4000, String(d));
  }
});

test('Retry-After is read as seconds or as an HTTP date', () => {
  assert.equal(parseRetryAfter('5'), 5000);
  assert.equal(parseRetryAfter(' 0 '), 0);
  const now = Date.parse('2026-10-02T12:00:00Z');
  assert.equal(parseRetryAfter('Fri, 02 Oct 2026 12:00:30 GMT', now), 30000);
  assert.equal(parseRetryAfter('Fri, 02 Oct 2026 11:00:00 GMT', now), 0, 'a date in the past is no wait');
  for (const bad of [null, undefined, '', 'soon', '-3']) assert.equal(parseRetryAfter(bad, now), null, String(bad));
});

test('only failures that may pass are retried', () => {
  for (const status of RETRYABLE_STATUSES) assert.equal(isRetryable(new HttpError(status)), true, String(status));
  assert.deepEqual(RETRYABLE_STATUSES, [408, 425, 429, 500, 502, 503, 504]);
  for (const status of [400, 401, 403, 404, 410, 422]) assert.equal(isRetryable(new HttpError(status)), false, String(status));
  assert.equal(isRetryable(new TypeError('Failed to fetch')), true, 'a dropped connection');
  assert.equal(isRetryable(new TimeoutError(5000)), true, 'a request that took too long');
  assert.equal(isRetryable(new Error('bug')), false);
  assert.equal(isRetryable(Object.assign(new Error('aborted'), { name: 'AbortError' })), false);
  assert.equal(isRetryable(null), false);
});

test('a request that works the first time is not retried and not waited for', async () => {
  const t = failing();
  const slept = [];
  assert.equal(await withRetry(t.task, { sleep: (ms) => { slept.push(ms); return Promise.resolve(); } }), 'ok');
  assert.equal(t.calls(), 1);
  assert.deepEqual(slept, []);
});

test('a transient failure is retried after a jittered wait, and the answer is returned', async () => {
  const t = failing(new HttpError(503), new TypeError('offline'));
  const slept = [];
  const events = [];
  const result = await withRetry(t.task, {
    random: () => 0.5, sleep: (ms) => { slept.push(ms); return Promise.resolve(); }, onRetry: (e) => events.push([e.retry, e.retries, e.delayMs]),
  });
  assert.equal(result, 'ok');
  assert.equal(t.calls(), 3);
  assert.deepEqual(slept, [250, 500], 'half of 500 and half of 1000');
  assert.deepEqual(events, [[1, 4, 250], [2, 4, 500]], 'the caller is told before each wait');
});

test('the task is told which attempt it is on, from 1', async () => {
  const seen = [];
  await withRetry(async (attempt) => { seen.push(attempt); if (attempt < 3) throw new HttpError(500); }, { sleep: noSleep });
  assert.deepEqual(seen, [1, 2, 3]);
});

test('after the last retry the last error is thrown', async () => {
  const errors = Array.from({ length: 10 }, (_, i) => new HttpError(503, { message: `failure ${i + 1}` }));
  const t = failing(...errors);
  await assert.rejects(withRetry(t.task, { sleep: noSleep }), /failure 5/);
  assert.equal(t.calls(), RETRY.retries + 1, 'one attempt plus four retries');
});

test('the number of retries can be set', async () => {
  const t = failing(...Array.from({ length: 5 }, () => new HttpError(500)));
  await assert.rejects(withRetry(t.task, { retries: 1, sleep: noSleep }), HttpError);
  assert.equal(t.calls(), 2);
  const none = failing(new HttpError(500));
  await assert.rejects(withRetry(none.task, { retries: 0, sleep: noSleep }));
  assert.equal(none.calls(), 1);
});

test('a failure that would fail the same way again is thrown at once', async () => {
  for (const error of [new HttpError(404), new HttpError(403), new Error('bug')]) {
    const t = failing(error);
    let told = false;
    await assert.rejects(withRetry(t.task, { sleep: noSleep, onRetry: () => { told = true; } }), error.constructor);
    assert.equal(t.calls(), 1);
    assert.equal(told, false, 'nobody is told to wait for a retry that is not coming');
  }
});

test('a Retry-After is honoured as a minimum wait', async () => {
  const slept = [];
  const t = failing(new HttpError(429, { retryAfterMs: 3000 }));
  await withRetry(t.task, { random: () => 0, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
  assert.deepEqual(slept, [3000], 'jitter alone would have said 0');
  const longer = [];
  await withRetry(failing(new HttpError(503, { retryAfterMs: 100 })).task, { random: () => 0.99, sleep: (ms) => { longer.push(ms); return Promise.resolve(); } });
  assert.deepEqual(longer, [495], 'the backoff is longer than the ask, so it stands');
});

test('a Retry-After longer than we will wait gives up instead of making the user wait', async () => {
  const t = failing(new HttpError(429, { retryAfterMs: RETRY.maxRetryAfterMs + 1 }));
  await assert.rejects(withRetry(t.task, { sleep: noSleep }), /429/);
  assert.equal(t.calls(), 1);
});

test('each retry waits up to twice as long as the one before, then levels off', async () => {
  const slept = [];
  const t = failing(...Array.from({ length: 4 }, () => new HttpError(503)));
  await withRetry(t.task, { random: () => 0.9999, retries: 4, sleep: (ms) => { slept.push(ms); return Promise.resolve(); } });
  assert.deepEqual(slept, [499, 999, 1999, 3999]);
  const levelled = [];
  await withRetry(failing(...Array.from({ length: 7 }, () => new HttpError(503))).task, {
    random: () => 0.9999, retries: 8, sleep: (ms) => { levelled.push(ms); return Promise.resolve(); },
  });
  assert.equal(Math.max(...levelled), 7999, 'never past the cap');
});

test('it really waits, using the real timer when none is given', async () => {
  const started = Date.now();
  await withRetry(failing(new HttpError(503)).task, { baseMs: 40, capMs: 40, random: () => 0.99 });
  assert.ok(Date.now() - started >= 30);
});

test('a timeout says how long it waited', () => {
  const e = new TimeoutError(5000);
  assert.equal(e.name, 'TimeoutError');
  assert.equal(e.message, 'TCGplayer did not respond within 5 seconds');
  assert.equal(e.timeoutMs, 5000);
});
