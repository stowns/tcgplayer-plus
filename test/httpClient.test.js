import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, REQUEST_TIMEOUT_MS } from '../src/lib/httpClient.js';
import { createThrottle } from '../src/lib/throttle.js';
import { HttpError, TimeoutError } from '../src/lib/retry.js';

const instant = { run: (task) => task() };
const answer = (status, body = {}, headers = {}) => ({
  ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body),
  headers: { get: (name) => headers[name] ?? null },
});
/** A fetch that gives its answers in order, then repeats the last. */
function scripted(...steps) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const step = steps[Math.min(calls.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return step;
  };
  return { fetch, calls };
}
const client = (fetch, extra = {}) => {
  const slept = [];
  const c = createClient({
    fetch, throttle: instant,
    retry: { random: () => 0.5, sleep: (ms) => { slept.push(ms); return Promise.resolve(); }, ...extra },
  });
  return { ...c, slept };
};

test('a good answer comes straight back, with no retry', async () => {
  const s = scripted(answer(200, { a: 1 }));
  const c = client(s.fetch);
  assert.deepEqual(await c.getJson('https://x/a'), { a: 1 });
  assert.equal(s.calls.length, 1);
  assert.deepEqual(c.slept, []);
});

test('getJson asks for JSON, postJson sends one', async () => {
  const s = scripted(answer(200, { ok: true }));
  const c = client(s.fetch);
  await c.getJson('https://x/a');
  await c.postJson('https://x/b', { q: 1 });
  assert.equal(s.calls[0].init.headers.Accept, 'application/json');
  assert.equal(s.calls[1].init.method, 'POST');
  assert.equal(s.calls[1].init.headers['Content-Type'], 'application/json');
  assert.equal(s.calls[1].init.body, '{"q":1}');
});

test('a 503 then a good answer is retried after a backoff, and the user hook is told', async () => {
  const s = scripted(answer(503), answer(200, { done: true }));
  const c = client(s.fetch);
  const told = [];
  const result = await c.getJson('https://x/a', { onRetry: (e) => told.push([e.retry, e.retries, e.delayMs]) });
  assert.deepEqual(result, { done: true });
  assert.equal(s.calls.length, 2);
  assert.deepEqual(c.slept, [250]);
  assert.deepEqual(told, [[1, 4, 250]]);
});

test('a dropped connection is retried like a 503', async () => {
  const s = scripted(new TypeError('Failed to fetch'), new TypeError('Failed to fetch'), answer(200, { n: 3 }));
  const c = client(s.fetch);
  assert.deepEqual(await c.getJson('https://x/a'), { n: 3 });
  assert.equal(s.calls.length, 3);
  assert.deepEqual(c.slept, [250, 500]);
});

test('429 with Retry-After waits at least that long', async () => {
  const s = scripted(answer(429, {}, { 'Retry-After': '4' }), answer(200, {}));
  const c = client(s.fetch, { random: () => 0 });
  await c.getJson('https://x/a');
  assert.deepEqual(c.slept, [4000]);
});

test('it gives up after the retries, throwing the last status', async () => {
  const s = scripted(answer(503));
  const c = client(s.fetch);
  await assert.rejects(c.getJson('https://x/a'), (e) => e instanceof HttpError && e.status === 503);
  assert.equal(s.calls.length, 5, 'one attempt and four retries');
  assert.equal(c.slept.length, 4);
});

test('a 404 is not retried; request hands it back for the caller to judge, getJson throws', async () => {
  const s = scripted(answer(404));
  const c = client(s.fetch);
  const response = await c.request('https://x/a');
  assert.equal(response.status, 404);
  assert.equal(s.calls.length, 1);
  await assert.rejects(c.getJson('https://x/a'), (e) => e.status === 404);
  assert.deepEqual(c.slept, []);
});

test('postJson retries the same body each time', async () => {
  const s = scripted(answer(500), answer(200, { ok: 1 }));
  const c = client(s.fetch);
  await c.postJson('https://x/b', { filter: 'nm' });
  assert.deepEqual(s.calls.map((x) => x.init.body), ['{"filter":"nm"}', '{"filter":"nm"}']);
});

test('every attempt goes through the throttle, and the wait does not hold a slot', async () => {
  const log = [];
  const throttle = { run: async (task) => { log.push('start'); try { return await task(); } finally { log.push('end'); } } };
  const s = scripted(answer(503), answer(200, {}));
  const c = createClient({
    fetch: s.fetch, throttle,
    retry: { random: () => 0.5, sleep: async () => { log.push('sleep'); } },
  });
  await c.getJson('https://x/a');
  assert.deepEqual(log, ['start', 'end', 'sleep', 'start', 'end']);
});

test('with the real throttle, retries stay paced', async () => {
  const s = scripted(answer(503), answer(503), answer(200, {}));
  const starts = [];
  const fetch = async (...a) => { starts.push(Date.now()); return s.fetch(...a); };
  const c = createClient({ fetch, throttle: createThrottle({ concurrency: 1, minIntervalMs: 30 }), retry: { sleep: async () => {}, random: () => 0 } });
  await c.getJson('https://x/a');
  assert.equal(starts.length, 3);
  assert.ok(starts[1] - starts[0] >= 25 && starts[2] - starts[1] >= 25, 'a beat apart even with no backoff');
});

test('a response with no headers object is still handled', async () => {
  const s = scripted({ ok: false, status: 503 }, { ok: true, status: 200, json: async () => ({ ok: 1 }) });
  const c = client(s.fetch);
  assert.deepEqual(await c.getJson('https://x/a'), { ok: 1 });
});

// ---- the time limit -----------------------------------------------------------

/** A fetch that never answers; it does notice the abort, like a real one. */
const hanging = () => {
  const calls = [];
  const fetch = (url, init) => new Promise((_, reject) => {
    calls.push({ url, signal: init.signal });
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  return { fetch, calls };
};
const quick = (fetch, extra = {}) => client(fetch, { baseMs: 1, capMs: 1, random: () => 0, ...extra });

test('a request has five seconds', () => {
  assert.equal(REQUEST_TIMEOUT_MS, 5000);
});

test('the limit is set on the timer, from when the attempt starts', async () => {
  const timers = [];
  const s = scripted(answer(200, { a: 1 }));
  const c = createClient({
    fetch: s.fetch, throttle: instant,
    setTimer: (fn, ms) => { timers.push(ms); return 1; }, clearTimer: () => {},
  });
  await c.getJson('https://x/a');
  assert.deepEqual(timers, [5000]);
});

test('a request that answers in time clears its timer', async () => {
  const cleared = [];
  const s = scripted(answer(200, {}));
  const c = createClient({ fetch: s.fetch, throttle: instant, setTimer: () => 42, clearTimer: (t) => cleared.push(t) });
  await c.getJson('https://x/a');
  assert.deepEqual(cleared, [42]);
});

test('a request that takes too long is cancelled, counts as failed, and is retried', async () => {
  let n = 0;
  const signals = [];
  const fetch = (url, init) => {
    n += 1;
    signals.push(init.signal);
    if (n === 1) return new Promise(() => {}); // never answers, and ignores the signal
    return Promise.resolve(answer(200, { second: true }));
  };
  const c2 = createClient({ fetch, throttle: instant, timeoutMs: 20, retry: { random: () => 0, sleep: async () => {} } });
  const told = [];
  const result = await c2.getJson('https://x/a', { onRetry: (e) => told.push([e.retry, e.error.name]) });
  assert.deepEqual(result, { second: true });
  assert.equal(n, 2);
  assert.deepEqual(told, [[1, 'TimeoutError']], 'the user hook hears it was a timeout');
  assert.equal(signals[0].aborted, true, 'the slow attempt was cancelled');
  assert.equal(signals[1].aborted, false);
});

test('a request that never answers is tried five times, then fails with a timeout', async () => {
  const h = hanging();
  const c = createClient({ fetch: h.fetch, throttle: instant, timeoutMs: 15, retry: { random: () => 0, sleep: async () => {} } });
  await assert.rejects(c.getJson('https://x/a'), (e) => e instanceof TimeoutError && /within 0\.015 seconds/.test(e.message));
  assert.equal(h.calls.length, 5);
  assert.ok(h.calls.every((call) => call.signal.aborted));
});

test('an answer whose body never finishes arriving also times out', async () => {
  let n = 0;
  const fetch = async () => {
    n += 1;
    if (n === 1) return { ok: true, status: 200, json: () => new Promise(() => {}), headers: { get: () => null } };
    return answer(200, { body: 'ok' });
  };
  const c = createClient({ fetch, throttle: instant, timeoutMs: 20, retry: { random: () => 0, sleep: async () => {} } });
  assert.deepEqual(await c.getJson('https://x/a'), { body: 'ok' });
  assert.equal(n, 2);
});

test('the time limit starts when the attempt starts, not while it queues behind others', async () => {
  const { createThrottle } = await import('../src/lib/throttle.js');
  const throttle = createThrottle({ concurrency: 1, minIntervalMs: 0 });
  const slowFirst = async (url) => {
    if (url.endsWith('/slow')) await new Promise((r) => setTimeout(r, 60));
    return answer(200, { url });
  };
  const c = createClient({ fetch: slowFirst, throttle, timeoutMs: 100, retry: { sleep: async () => {} } });
  const results = await Promise.all([c.getJson('https://x/slow'), c.getJson('https://x/after')]);
  assert.deepEqual(results.map((r) => r.url), ['https://x/slow', 'https://x/after'], 'the second waited 60 ms in the queue and was not timed out');
});

test('a timeout does not hold the throttle slot while it waits to retry', async () => {
  const log = [];
  const throttle = { run: async (task) => { log.push('start'); try { return await task(); } finally { log.push('end'); } } };
  let n = 0;
  const fetch = (url, init) => {
    n += 1;
    if (n === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    return Promise.resolve(answer(200, {}));
  };
  const c = createClient({ fetch, throttle, timeoutMs: 15, retry: { random: () => 0, sleep: async () => { log.push('sleep'); } } });
  await c.getJson('https://x/a');
  assert.deepEqual(log, ['start', 'end', 'sleep', 'start', 'end']);
});

test('a slow answer to a post is retried with the same body', async () => {
  const bodies = [];
  const fetch = (url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) return new Promise(() => {});
    return Promise.resolve(answer(200, { ok: 1 }));
  };
  const c = createClient({ fetch, throttle: instant, timeoutMs: 15, retry: { random: () => 0, sleep: async () => {} } });
  await c.postJson('https://x/b', { q: 1 });
  assert.deepEqual(bodies, ['{"q":1}', '{"q":1}']);
});
