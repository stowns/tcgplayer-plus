import test from 'node:test';
import assert from 'node:assert/strict';
import { retryingState, isRetrying, isSettled, retryText, retryTitle } from '../src/lib/retryState.js';

test('a retrying state says which retry, of how many', () => {
  const s = retryingState({ retry: 2, retries: 4, delayMs: 700 });
  assert.deepEqual({ ...s }, { retrying: true, retry: 2, retries: 4 });
  assert.equal(retryText(s), 'Retrying (2 of 4)…');
  assert.match(retryTitle(s), /TCGplayer did not answer\. Trying again automatically \(retry 2 of 4\)/);
});

test('only a retrying state is retrying; only a real answer is settled', () => {
  const s = retryingState({ retry: 1, retries: 4 });
  assert.equal(isRetrying(s), true);
  assert.equal(isSettled(s), false);
  for (const real of [{ status: 'ok' }, { direction: 'up' }, { status: 'unavailable' }]) {
    assert.equal(isRetrying(real), false);
    assert.equal(isSettled(real), true);
  }
  for (const nothing of [null, undefined, 0, '']) {
    assert.equal(isRetrying(nothing), false);
    assert.equal(isSettled(nothing), false, 'not asked yet is not settled either');
  }
});
