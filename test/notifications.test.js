import test from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier, normalizeNotification } from '../src/lib/notifications.js';

const channel = (name, behaviour = async () => {}) => {
  const sent = [];
  return { name, sent, send: async (n) => { sent.push(n); return behaviour(n); } };
};
const NOTE = { title: 'Price target reached', message: 'Ask $9.79 is at or below $10.00', url: 'https://www.tcgplayer.com/product/1' };

test('a notification goes to every channel', async () => {
  const a = channel('a');
  const b = channel('b');
  const result = await createNotifier({ channels: [a, b] }).notify(NOTE);
  assert.equal(result.ok, true);
  assert.deepEqual(result.results, [{ channel: 'a', ok: true, error: '' }, { channel: 'b', ok: true, error: '' }]);
  assert.equal(a.sent.length, 1);
  assert.equal(b.sent[0].title, 'Price target reached');
});

test('one channel failing does not stop the others, and nothing is thrown', async () => {
  const bad = channel('bad', async () => { throw new Error('server down'); });
  const good = channel('good');
  const result = await createNotifier({ channels: [bad, good] }).notify(NOTE);
  assert.equal(result.ok, true, 'it was delivered somewhere');
  assert.deepEqual(result.results[0], { channel: 'bad', ok: false, error: 'server down' });
  assert.equal(good.sent.length, 1);
});

test('when every channel fails the result says so, with each reason', async () => {
  const result = await createNotifier({ channels: [channel('a', async () => { throw new Error('x'); }), channel('b', async () => { throw 'y'; })] }).notify(NOTE);
  assert.equal(result.ok, false);
  assert.deepEqual(result.results.map((r) => r.error), ['x', 'y']);
});

test('with no channel set up, it says so instead of pretending', async () => {
  const result = await createNotifier({ channels: [] }).notify(NOTE);
  assert.equal(result.ok, false);
  assert.match(result.results[0].error, /No notification channel/);
  assert.equal((await createNotifier().notify(NOTE)).ok, false);
});

test('an empty notification is not sent', async () => {
  const a = channel('a');
  const notifier = createNotifier({ channels: [a] });
  for (const nothing of [null, undefined, {}, { title: '  ', message: '' }, 'text']) {
    assert.equal((await notifier.notify(nothing)).ok, false);
  }
  assert.equal(a.sent.length, 0);
});

test('the notifier names its channels', () => {
  assert.deepEqual(createNotifier({ channels: [channel('ntfy')] }).channels, ['ntfy']);
});

test('a notification is tidied before any channel sees it', () => {
  const n = normalizeNotification({
    title: '  Price   target\nreached ', message: 'm', url: 'https://x.test/p', tags: ['ok_tag', 'bad tag', 5, 'x'.repeat(50), '+1'], priority: 9,
  });
  assert.equal(n.title, 'Price target reached');
  assert.deepEqual(n.tags, ['ok_tag', '+1']);
  assert.equal(n.priority, 3, 'out of range is ordinary');
  assert.equal(normalizeNotification({ title: 't', priority: 5 }).priority, 5);
  assert.equal(normalizeNotification({ title: 't', priority: 1 }).priority, 1);
});

test('only an https link is passed on', () => {
  for (const url of ['javascript:alert(1)', 'http://plain.test', 'ftp://x', '', 7, undefined]) {
    assert.equal(normalizeNotification({ title: 't', url }).url, '', String(url));
  }
  assert.equal(normalizeNotification({ title: 't', url: 'https://ok.test/a' }).url, 'https://ok.test/a');
});

test('very long text is cut, not refused', () => {
  const n = normalizeNotification({ title: 't'.repeat(999), message: 'm'.repeat(9999) });
  assert.equal(n.title.length, 250);
  assert.equal(n.message.length, 2000);
});
