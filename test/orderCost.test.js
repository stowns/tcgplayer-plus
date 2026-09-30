import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateShipping, landedNow, landedPaid, costLine } from '../src/lib/orderCost.js';
import { totalChange } from '../src/lib/priceCompare.js';

test('one item carries all of the order\'s shipping', () => {
  assert.deepEqual(allocateShipping({ shipping: 1.49 }, [{ paid: 0.9, quantity: 1 }]), [1.49]);
});

test('shipping is spread in proportion to what each item cost', () => {
  assert.deepEqual(allocateShipping({ shipping: 3 }, [{ paid: 10, quantity: 1 }, { paid: 20, quantity: 1 }]), [1, 2]);
});

test('per unit: a line of several units shares its portion between them', () => {
  // $10 x 2 and $20 x 1 = $40 of goods, $4 shipping: $0.10 per dollar, so $1 per $10 unit, $2 for the $20 one.
  assert.deepEqual(allocateShipping({ shipping: 4 }, [{ paid: 10, quantity: 2 }, { paid: 20, quantity: 1 }]), [1, 2]);
});

test('the shares add back up to the shipping, within rounding', () => {
  const items = [{ paid: 5.61, quantity: 1 }, { paid: 17.06, quantity: 1 }, { paid: 6.36, quantity: 1 }, { paid: 2.69, quantity: 1 }, { paid: 20.96, quantity: 1 }];
  const shares = allocateShipping({ shipping: 4.99 }, items);
  assert.ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 4.99) < 0.03);
});

test('free, missing or nonsense shipping adds nothing', () => {
  const items = [{ paid: 10, quantity: 1 }];
  for (const summary of [{ shipping: 0 }, { shipping: null }, { shipping: -2 }, {}, null, undefined, { shipping: 'x' }]) {
    assert.deepEqual(allocateShipping(summary, items), [0]);
  }
});

test('items with no readable price cannot be given a share, and do not break the others', () => {
  assert.deepEqual(allocateShipping({ shipping: 2 }, [{ paid: null }, { paid: 10, quantity: 1 }]), [0, 2]);
  assert.deepEqual(allocateShipping({ shipping: 2 }, [{ paid: null }]), [0]);
  assert.deepEqual(allocateShipping({ shipping: 2 }, []), []);
  assert.deepEqual(allocateShipping({ shipping: 2 }, null), []);
});

test('a missing or bad quantity counts as one', () => {
  assert.deepEqual(allocateShipping({ shipping: 2 }, [{ paid: 10 }, { paid: 10, quantity: 0 }]), [1, 1]);
});

test('today\'s cost is the listing price plus its shipping', () => {
  assert.equal(landedNow({ status: 'ok', price: 9.5, shipping: 0.99 }), 10.49);
  assert.equal(landedNow({ status: 'ok', price: 9.5, shipping: 0 }), 9.5);
  assert.equal(landedNow({ status: 'ok', price: 9.5 }), 9.5);
  assert.equal(landedNow({ status: 'ok', price: 9.5, shipping: -1 }), 9.5);
});

test('there is no cost today without a live listing', () => {
  for (const r of [null, undefined, { status: 'none' }, { status: 'unavailable' }, { status: 'ok' }, { status: 'ok', price: 'x' }]) {
    assert.equal(landedNow(r), null);
  }
});

test('what was paid is the price plus its share of shipping', () => {
  assert.equal(landedPaid(0.9, 1.49), 2.39);
  assert.equal(landedPaid(13.99), 13.99);
  assert.equal(landedPaid(13.99, undefined), 13.99);
  assert.equal(landedPaid(null, 1), null);
});

test('costLine puts both sides on price plus shipping for totalChange', () => {
  const line = costLine({ paid: 0.9, quantity: 2 }, 1.49, { status: 'ok', price: 0.5, shipping: 0.99 });
  assert.deepEqual([line.paid, line.quantity, line.result.price], [2.39, 2, 1.49]);
  const total = totalChange([line]);
  assert.deepEqual([total.paid, total.now, total.diff], [4.78, 2.98, -1.8]);
});

test('costLine leaves loading, missing and failed answers as they are', () => {
  assert.equal(costLine({ paid: 5, quantity: 1 }, 1, null).result, null);
  assert.deepEqual(costLine({ paid: 5, quantity: 1 }, 1, { status: 'none' }).result, { status: 'none' });
  assert.deepEqual(costLine({ paid: 5, quantity: 1 }, 1, { status: 'unavailable' }).result, { status: 'unavailable' });
});

test('the Galarian Meowth case: paid $13.00, listing $9.50 + $0.99 is $10.49, a loss of $2.51', () => {
  const total = totalChange([costLine({ paid: 13, quantity: 1 }, 0, { status: 'ok', price: 9.5, shipping: 0.99 })]);
  assert.equal(total.diff, -2.51);
  assert.equal(total.direction, 'lower');
});
