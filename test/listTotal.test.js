import test from 'node:test';
import assert from 'node:assert/strict';
import { listTotal } from '../src/lib/listTotal.js';
import { askKey } from '../src/lib/listsSort.js';
import { retryingState } from '../src/lib/retryState.js';

const card = (productId) => ({ key: `${productId}:english`, productId, priceAtSave: { condition: 'Near Mint Holofoil' } });
const ok = (price, shipping = 0) => ({ status: 'ok', price, shipping });
const A = card('1');
const B = card('2');
const C = card('3');

test('the total is each card\'s Ask, price plus shipping, added up to the cent', () => {
  const asks = { [askKey(A)]: ok(9.5, 0.99), [askKey(B)]: ok(0.1, 0.2), [askKey(C)]: ok(85.99) };
  assert.deepEqual(listTotal([A, B, C], asks), { total: 96.78, items: 3, priced: 3, pending: 0, missing: 0 });
});

test('cards still being looked up, or being retried, are pending and not counted in', () => {
  const asks = { [askKey(A)]: ok(10), [askKey(B)]: retryingState({ retry: 1, retries: 4 }) };
  assert.deepEqual(listTotal([A, B, C], asks), { total: 10, items: 3, priced: 1, pending: 2, missing: 0 });
});

test('cards with nothing listed, or whose Ask could not be read, are counted apart', () => {
  const asks = { [askKey(A)]: ok(10), [askKey(B)]: { status: 'none' }, [askKey(C)]: { status: 'unavailable' } };
  assert.deepEqual(listTotal([A, B, C], asks), { total: 10, items: 3, priced: 1, pending: 0, missing: 2 });
});

test('an empty list, or nothing to go on, totals nothing', () => {
  assert.deepEqual(listTotal([], {}), { total: 0, items: 0, priced: 0, pending: 0, missing: 0 });
  assert.deepEqual(listTotal(null), { total: 0, items: 0, priced: 0, pending: 0, missing: 0 });
  assert.deepEqual(listTotal([A]), { total: 0, items: 1, priced: 0, pending: 1, missing: 0 });
});

test('a sealed product is priced as Unopened, a card as Near Mint: two different Asks for one product id', () => {
  const sealed = { ...card('1'), key: '1:english:sealed', priceAtSave: { condition: 'Unopened' } };
  const asks = { [askKey(A)]: ok(10), [askKey(sealed)]: ok(7) };
  assert.equal(listTotal([A, sealed], asks).total, 17);
});
