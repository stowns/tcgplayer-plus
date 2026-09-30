import test from 'node:test';
import assert from 'node:assert/strict';
import { onMessage } from '../src/lib/runtime.js';

/**
 * Chrome's protocol, strictly: the listener's return value is only a flag ("I
 * will call sendResponse later"); a returned promise is ignored. Anything that
 * relies on Firefox's promise replies gets nothing back.
 */
function chromeRuntime() {
  const listeners = [];
  return {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    send(message) {
      return new Promise((resolve) => {
        let answered = false;
        const respond = (value) => { answered = true; resolve(value); };
        const keepOpen = listeners[0](message, { id: 'sender' }, respond);
        if (keepOpen !== true && !answered) resolve(undefined);
      });
    },
  };
}

test('a promise reply reaches the sender through sendResponse (Chrome\'s protocol)', async () => {
  const runtime = chromeRuntime();
  onMessage(async (m) => ({ echoed: m.value }), runtime);
  assert.deepEqual(await runtime.send({ value: 7 }), { echoed: 7 });
});

test('a reply that arrives later still arrives, because the channel is kept open', async () => {
  const runtime = chromeRuntime();
  onMessage(() => new Promise((resolve) => setTimeout(() => resolve('late'), 40)), runtime);
  assert.equal(await runtime.send({}), 'late');
});

test('a plain value is a reply too', async () => {
  const runtime = chromeRuntime();
  onMessage(() => ({ ok: true }), runtime);
  assert.deepEqual(await runtime.send({}), { ok: true });
});

test('a rejected promise replies with the error instead of leaving the sender waiting', async () => {
  const runtime = chromeRuntime();
  onMessage(async () => { throw new Error('TCGplayer is down'); }, runtime);
  assert.deepEqual(await runtime.send({}), { error: 'TCGplayer is down' });
});

test('a handler that throws replies with the error', async () => {
  const runtime = chromeRuntime();
  onMessage(() => { throw new Error('bad message'); }, runtime);
  assert.deepEqual(await runtime.send({}), { error: 'bad message' });
});

test('a non-Error rejection is still reported as text', async () => {
  const runtime = chromeRuntime();
  onMessage(() => Promise.reject('plain string'), runtime);
  assert.deepEqual(await runtime.send({}), { error: 'plain string' });
});

test('a message the handler does not know is left unanswered, so other listeners may take it', async () => {
  const runtime = chromeRuntime();
  onMessage(() => undefined, runtime);
  assert.equal(await runtime.send({ type: 'unknown' }), undefined);
});

test('the listener tells the browser whether it will reply', () => {
  const listeners = [];
  onMessage((m) => (m.reply ? Promise.resolve(1) : undefined), { onMessage: { addListener: (fn) => listeners.push(fn) } });
  assert.equal(listeners[0]({ reply: true }, {}, () => {}), true);
  assert.equal(listeners[0]({ reply: false }, {}, () => {}), false);
});

test('the handler receives the message and the sender', async () => {
  const runtime = chromeRuntime();
  let seen;
  onMessage((m, s) => { seen = [m, s]; return 1; }, runtime);
  await runtime.send({ type: 'x' });
  assert.deepEqual(seen, [{ type: 'x' }, { id: 'sender' }]);
});

test('a Firefox-style sender, which also understands sendResponse, gets the same answer', async () => {
  // Firefox supports both styles; the adapter uses the one Chrome needs.
  const listeners = [];
  onMessage(async () => 'fx', { onMessage: { addListener: (fn) => listeners.push(fn) } });
  const answer = await new Promise((resolve) => { listeners[0]({}, {}, resolve); });
  assert.equal(answer, 'fx');
});
