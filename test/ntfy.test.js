import test from 'node:test';
import assert from 'node:assert/strict';
import { ntfyChannel, ntfyPayload, topicUrl, NTFY_SERVER } from '../src/lib/ntfy.js';
import { createNotifier } from '../src/lib/notifications.js';

const TOPIC = 'tcgplayer-plus-0b9f3c1e-6a53-4d0e-9a3b-7a0f6b1d2c33';
const instant = { run: (task) => task() };
const quick = { random: () => 0, sleep: async () => {} };
const reply = (status) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => ({}), text: async () => '' });
function recorder(...statuses) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const step = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (step instanceof Error) throw step;
    return reply(step);
  };
  return { fetch, calls };
}
const channel = (fetch, extra = {}) => ntfyChannel({ fetch, topic: TOPIC, throttle: instant, retry: quick, ...extra });
const NOTE = { title: 'Price target reached: Maushold', message: 'Ask $9.79 is at or below $10.00', url: 'https://www.tcgplayer.com/product/716228', tags: ['chart_with_downwards_trend'], priority: 4 };

test('it publishes to ntfy.sh as JSON, with the topic in the body', async () => {
  const r = recorder(200);
  await channel(r.fetch).send(NOTE);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].url, 'https://ntfy.sh/');
  assert.equal(r.calls[0].init.method, 'POST');
  assert.equal(r.calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(r.calls[0].init.body), {
    topic: TOPIC, title: NOTE.title, message: NOTE.message, click: NOTE.url, tags: NOTE.tags, priority: 4,
  });
  assert.equal(NTFY_SERVER, 'https://ntfy.sh');
});

test('nothing but the notification is sent: no cookies, no other headers', async () => {
  const r = recorder(200);
  await channel(r.fetch).send(NOTE);
  assert.deepEqual(Object.keys(r.calls[0].init.headers), ['Content-Type']);
  assert.equal(r.calls[0].init.credentials, undefined);
});

test('names that are not plain ASCII go through intact', async () => {
  const r = recorder(200);
  await channel(r.fetch).send({ title: 'Price target reached: Pokémon ポケモン', message: 'Flabébé — $1.00', priority: 3 });
  const body = JSON.parse(r.calls[0].init.body);
  assert.equal(body.title, 'Price target reached: Pokémon ポケモン');
  assert.equal(body.message, 'Flabébé — $1.00');
});

test('optional parts are left out when there is nothing to say', () => {
  assert.deepEqual(ntfyPayload(TOPIC, { title: '', message: 'just this', url: '', tags: [], priority: 3 }), { topic: TOPIC, message: 'just this' });
  assert.deepEqual(ntfyPayload(TOPIC, { title: 'only a title', message: '', url: '', tags: [], priority: 3 }), { topic: TOPIC, message: 'only a title' });
});

test('a topic\'s page is on the server, under its name', () => {
  assert.equal(topicUrl(TOPIC), `https://ntfy.sh/${TOPIC}`);
  assert.equal(topicUrl('t', 'https://example.test'), 'https://example.test/t');
});

test('a brief failure is retried and then delivered', async () => {
  const r = recorder(503, 200);
  await channel(r.fetch).send(NOTE);
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[1].init.body, r.calls[0].init.body, 'the same notification');
});

test('being told to slow down (429) is retried', async () => {
  const r = recorder(429, 200);
  await channel(r.fetch).send(NOTE);
  assert.equal(r.calls.length, 2);
});

test('a refusal that will not pass is reported, saying it was ntfy', async () => {
  const r = recorder(403);
  await assert.rejects(channel(r.fetch).send(NOTE), /^Error: ntfy responded 403$/);
  assert.equal(r.calls.length, 1);
});

test('a server that keeps failing is given up on, with ntfy named', async () => {
  const r = recorder(500);
  await assert.rejects(channel(r.fetch).send(NOTE), /ntfy responded 500/);
  assert.equal(r.calls.length, 5);
});

test('no connection is reported plainly', async () => {
  const r = recorder(new TypeError('Failed to fetch'));
  await assert.rejects(channel(r.fetch).send(NOTE), /Could not reach ntfy \(Failed to fetch\)/);
});

test('a server that never answers times out', async () => {
  const never = () => new Promise(() => {});
  await assert.rejects(channel(never, { timeoutMs: 15 }).send(NOTE), /ntfy did not respond within 0\.015 seconds/);
});

test('without a valid topic nothing is sent', async () => {
  for (const topic of ['', 'has space', null, undefined]) {
    const r = recorder(200);
    await assert.rejects(ntfyChannel({ fetch: r.fetch, topic, throttle: instant }).send(NOTE), /No notification topic/);
    assert.equal(r.calls.length, 0);
  }
});

test('it works as a channel of the notifier, which reports a failure instead of throwing', async () => {
  const ok = recorder(200);
  const sent = await createNotifier({ channels: [channel(ok.fetch)] }).notify(NOTE);
  assert.deepEqual(sent, { ok: true, results: [{ channel: 'ntfy', ok: true, error: '' }] });
  const down = recorder(403);
  const failed = await createNotifier({ channels: [channel(down.fetch)] }).notify(NOTE);
  assert.deepEqual(failed, { ok: false, results: [{ channel: 'ntfy', ok: false, error: 'ntfy responded 403' }] });
});

test('another server can be used', async () => {
  const r = recorder(200);
  await channel(r.fetch, { server: 'https://ntfy.example.test' }).send(NOTE);
  assert.equal(r.calls[0].url, 'https://ntfy.example.test/');
});
