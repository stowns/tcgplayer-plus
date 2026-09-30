import test from 'node:test';
import assert from 'node:assert/strict';
import {
  historyUrl, splitConditionVariant, pickSku, parseHistory,
} from '../src/lib/tcgplayerHistory.js';
import { PIKACHU_HISTORY, GENESECT_HISTORY, MULTI_VARIANT_HISTORY } from './fixtures/tcgplayerHistory.js';

test('historyUrl points at the same feed the product page reads', () => {
  assert.equal(
    historyUrl('712953'),
    'https://infinite-api.tcgplayer.com/price/history/712953/detailed?range=month',
  );
  assert.equal(
    historyUrl('712953', 'quarter'),
    'https://infinite-api.tcgplayer.com/price/history/712953/detailed?range=quarter',
  );
});

test('historyUrl refuses anything that is not a numeric product id', () => {
  for (const bad of ['', 'abc', '12/../3', null, undefined, '1 2']) {
    assert.throws(() => historyUrl(bad), /product id/i, String(bad));
  }
});

test('splitConditionVariant separates the words TCGplayer joins together', () => {
  assert.deepEqual(splitConditionVariant('Near Mint Holofoil'), { condition: 'Near Mint', variant: 'Holofoil' });
  assert.deepEqual(splitConditionVariant('Lightly Played Reverse Holofoil'), {
    condition: 'Lightly Played', variant: 'Reverse Holofoil',
  });
  assert.deepEqual(splitConditionVariant('Near Mint 1st Edition Holofoil'), {
    condition: 'Near Mint', variant: '1st Edition Holofoil',
  });
  assert.deepEqual(splitConditionVariant('Near Mint'), { condition: 'Near Mint', variant: '' });
  assert.deepEqual(splitConditionVariant('  near mint   normal '), { condition: 'Near Mint', variant: 'normal' });
});

test('splitConditionVariant copes with nothing useful', () => {
  for (const input of [undefined, null, '', 'Holofoil']) {
    const r = splitConditionVariant(input);
    assert.equal(r.condition, '');
    assert.equal(typeof r.variant, 'string');
  }
  assert.equal(splitConditionVariant('Holofoil').variant, 'Holofoil', 'no condition, so the rest is the variant');
});

const skus = MULTI_VARIANT_HISTORY.result;

test('pickSku takes the exact condition and variant when it exists', () => {
  assert.equal(pickSku(skus, { condition: 'Lightly Played', variant: 'Reverse Holofoil' }).skuId, '4');
  assert.equal(pickSku(skus, { condition: 'Near Mint', variant: 'Holofoil' }).skuId, '3');
});

test('pickSku falls back to Near Mint of the same variant, then to the busiest Near Mint', () => {
  // No Moderately Played Reverse Holofoil exists, so use the Near Mint one.
  assert.equal(pickSku(skus, { condition: 'Moderately Played', variant: 'Reverse Holofoil' }).skuId, '2');
  // No variant known at all: the busiest English Near Mint printing.
  assert.equal(pickSku(skus, { condition: 'Near Mint', variant: '' }).skuId, '1');
  assert.equal(pickSku(skus, {}).skuId, '1');
});

test('pickSku keeps languages apart', () => {
  assert.equal(pickSku(skus, { condition: 'Near Mint', variant: 'Normal', language: 'Japanese' }).skuId, '5');
  assert.equal(pickSku(skus, { condition: 'Near Mint', variant: 'Normal', language: 'English' }).skuId, '1');
});

test('pickSku ignores a language it has no data for rather than returning nothing', () => {
  assert.equal(pickSku(skus, { condition: 'Near Mint', variant: 'Normal', language: 'Klingon' }).skuId, '1');
});

test('pickSku matches loosely on case and returns null for nothing', () => {
  assert.equal(pickSku(skus, { condition: 'near mint', variant: 'REVERSE HOLOFOIL' }).skuId, '2');
  assert.equal(pickSku([], { condition: 'Near Mint' }), null);
  assert.equal(pickSku(null, {}), null);
});

test('parseHistory returns the chosen SKU with its days, oldest first', () => {
  const h = parseHistory(PIKACHU_HISTORY, { language: 'English', condition: 'Near Mint Holofoil' });
  assert.equal(h.skuId, '9465652');
  assert.equal(h.condition, 'Near Mint');
  assert.equal(h.variant, 'Holofoil');
  assert.equal(h.days.length, 30);
  assert.equal(h.days.at(-1).date, '2026-09-30');
});

test('parseHistory reads the condition text a saved item actually holds', () => {
  const h = parseHistory(GENESECT_HISTORY, { language: 'English', condition: 'Lightly Played Holofoil' });
  assert.equal(h.skuId, '8816228');
});

test('parseHistory returns null for a response with nothing usable', () => {
  for (const bad of [null, {}, { result: [] }, { result: 'no' }, 'nope']) {
    assert.equal(parseHistory(bad, {}), null);
  }
});
