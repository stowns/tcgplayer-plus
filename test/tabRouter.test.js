import test from 'node:test';
import assert from 'node:assert/strict';
import { viewFromHash, nextTabId } from '../src/lib/tabRouter.js';

const IDS = ['lists', 'orders'];

test('the fragment names the tab, with or without the #, in any case', () => {
  assert.equal(viewFromHash('#orders', IDS), 'orders');
  assert.equal(viewFromHash('orders', IDS), 'orders');
  assert.equal(viewFromHash('#ORDERS', IDS), 'orders');
});

test('no or unknown fragment falls back to the remembered tab, then the first', () => {
  assert.equal(viewFromHash('', IDS, 'orders'), 'orders');
  assert.equal(viewFromHash('#nope', IDS, 'orders'), 'orders');
  assert.equal(viewFromHash('#nope', IDS, 'gone'), 'lists');
  assert.equal(viewFromHash(undefined, IDS), 'lists');
  assert.equal(viewFromHash(null, IDS, undefined), 'lists');
});

test('a fragment beats the remembered tab', () => {
  assert.equal(viewFromHash('#lists', IDS, 'orders'), 'lists');
});

test('arrow keys move between tabs and wrap', () => {
  assert.equal(nextTabId('lists', 'ArrowRight', IDS), 'orders');
  assert.equal(nextTabId('orders', 'ArrowRight', IDS), 'lists');
  assert.equal(nextTabId('lists', 'ArrowLeft', IDS), 'orders');
  assert.equal(nextTabId('orders', 'ArrowLeft', IDS), 'lists');
});

test('Home and End jump to the ends', () => {
  assert.equal(nextTabId('orders', 'Home', IDS), 'lists');
  assert.equal(nextTabId('lists', 'End', IDS), 'orders');
});

test('other keys, and an unknown current tab, are ignored', () => {
  assert.equal(nextTabId('lists', 'Enter', IDS), null);
  assert.equal(nextTabId('lists', 'a', IDS), null);
  assert.equal(nextTabId('nope', 'ArrowRight', IDS), null);
});
