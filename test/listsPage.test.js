import test from 'node:test';
import assert from 'node:assert/strict';
import { pageOf, parsePageSize, resolveSelection, PAGE_SIZES, DEFAULT_PAGE_SIZE } from '../src/lib/listsPage.js';

const range = (n) => Array.from({ length: n }, (_, i) => i + 1);

test('the page sizes are 25, 50, 75 and all, and 25 is the default', () => {
  assert.deepEqual(PAGE_SIZES, [25, 50, 75, 'all']);
  assert.equal(DEFAULT_PAGE_SIZE, 25);
});

test('parsePageSize accepts what is offered and falls back to the default', () => {
  assert.equal(parsePageSize('50'), 50);
  assert.equal(parsePageSize(75), 75);
  assert.equal(parsePageSize('all'), 'all');
  for (const bad of [null, undefined, '', '10', 'lots', 0, -25, NaN]) assert.equal(parsePageSize(bad), 25, String(bad));
});

test('the first page holds the first cards, in order', () => {
  const p = pageOf(range(140), { page: 1, size: 25 });
  assert.deepEqual(p.items, range(25));
  assert.deepEqual({ page: p.page, pages: p.pages, from: p.from, to: p.to, total: p.total }, { page: 1, pages: 6, from: 1, to: 25, total: 140 });
});

test('a middle page and a partial last page', () => {
  const mid = pageOf(range(140), { page: 2, size: 50 });
  assert.deepEqual([mid.from, mid.to, mid.items[0], mid.items.at(-1)], [51, 100, 51, 100]);
  const last = pageOf(range(140), { page: 6, size: 25 });
  assert.deepEqual([last.from, last.to, last.items.length], [126, 140, 15]);
});

test('an exact multiple has no empty page after it', () => {
  const p = pageOf(range(50), { page: 3, size: 25 });
  assert.equal(p.pages, 2);
  assert.equal(p.page, 2, 'clamped to the last page');
});

test('a list that fits on one page is a single page', () => {
  const p = pageOf(range(10), { page: 1, size: 25 });
  assert.deepEqual([p.pages, p.from, p.to, p.items.length], [1, 1, 10, 10]);
});

test('"all" shows everything on one page', () => {
  const p = pageOf(range(140), { page: 4, size: 'all' });
  assert.deepEqual([p.items.length, p.page, p.pages, p.from, p.to], [140, 1, 1, 1, 140]);
});

test('an empty list has nothing to page', () => {
  const p = pageOf([], { page: 3, size: 25 });
  assert.deepEqual([p.items.length, p.page, p.pages, p.from, p.to, p.total], [0, 1, 1, 0, 0, 0]);
});

test('a page number out of range, or not a number, is clamped', () => {
  assert.equal(pageOf(range(100), { page: 99, size: 25 }).page, 4);
  assert.equal(pageOf(range(100), { page: 0, size: 25 }).page, 1);
  assert.equal(pageOf(range(100), { page: -2, size: 25 }).page, 1);
  assert.equal(pageOf(range(100), { page: 'x', size: 25 }).page, 1);
  assert.equal(pageOf(range(100), { page: 2.7, size: 25 }).page, 2);
});

test('it does not change the list it is given', () => {
  const items = range(30);
  pageOf(items, { page: 2, size: 25 }).items.push(99);
  pageOf(items, { size: 'all' }).items.push(99);
  assert.equal(items.length, 30);
});

test('resolveSelection keeps the chosen list, else the first, else null', () => {
  const lists = [{ id: 'a' }, { id: 'b' }];
  assert.equal(resolveSelection(lists, 'b').id, 'b');
  assert.equal(resolveSelection(lists, 'gone').id, 'a');
  assert.equal(resolveSelection(lists, undefined).id, 'a');
  assert.equal(resolveSelection([], 'a'), null);
});
