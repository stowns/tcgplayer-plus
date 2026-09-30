import test from 'node:test';
import assert from 'node:assert/strict';
import { LISTS_KEY, sanitizeState, loadLists, saveLists } from '../src/lib/listsStorage.js';
import { emptyState, createList, addItem } from '../src/lib/lists.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) { return key in data ? { [key]: data[key] } : {}; },
    async set(items) { Object.assign(data, items); },
  };
}

test('sanitizeState accepts a good state unchanged', () => {
  const { state, list } = createList(emptyState(), 'Watchlist');
  const full = addItem(state, list.id, { productId: '1', name: 'Pikachu' }).state;
  assert.deepEqual(sanitizeState(full), full);
});

test('sanitizeState repairs anything unusable rather than throwing it all away', () => {
  const messy = {
    lists: [
      { id: 'a', name: 'Keep', items: [{ key: '1:english', productId: '1', name: 'Pikachu' }, null, 'junk'] },
      { id: '', name: 'No id' },
      { name: 'No id either' },
      null,
      { id: 'b', name: '', items: [] },
    ],
  };
  const clean = sanitizeState(messy);
  assert.deepEqual(clean.lists.map((l) => l.name), ['Keep']);
  assert.equal(clean.lists[0].items.length, 1);
  assert.equal(clean.lists[0].items[0].name, 'Pikachu');
});

test('sanitizeState turns junk into an empty state', () => {
  for (const junk of [null, undefined, 'nope', 42, {}, { lists: 'no' }]) {
    assert.deepEqual(sanitizeState(junk), emptyState());
  }
});

test('sanitizeState gives items a key when an old save lacks one', () => {
  const clean = sanitizeState({
    lists: [{ id: 'a', name: 'L', items: [{ productId: '7', language: 'Japanese', name: 'X' }] }],
  });
  assert.equal(clean.lists[0].items[0].key, '7:japanese');
});

test('load and save round-trip through storage', async () => {
  const storage = memoryStorage();
  assert.deepEqual(await loadLists(storage), emptyState());

  const { state, list } = createList(emptyState(), 'Watchlist');
  const withItem = addItem(state, list.id, { productId: '642621', name: 'Genesect ex' }).state;
  await saveLists(storage, withItem);

  assert.equal(storage.data[LISTS_KEY].lists[0].items[0].productId, '642621');
  assert.deepEqual(await loadLists(storage), withItem);
});

test('loading survives a corrupted value in storage', async () => {
  const storage = memoryStorage({ [LISTS_KEY]: 'not an object' });
  assert.deepEqual(await loadLists(storage), emptyState());
});

test('a list\'s chosen sort is kept, and a list with none stays without one', () => {
  const base = { id: 'a', name: 'Watching', items: [] };
  const state = sanitizeState({ lists: [{ ...base, sort: { key: 'ask', dir: 'asc' } }, { ...base, id: 'b', name: 'Buy' }] });
  assert.deepEqual(state.lists[0].sort, { key: 'ask', dir: 'asc' });
  assert.equal('sort' in state.lists[1], false);
});

test('a damaged sort is repaired rather than trusted', () => {
  const base = { id: 'a', name: 'Watching', items: [] };
  for (const [bad, expected] of [
    [{ key: 'price', dir: 'asc' }, { key: 'added', dir: 'desc' }],
    [{ key: 'volatility', dir: 'up' }, { key: 'volatility', dir: 'desc' }],
    ['market', { key: 'added', dir: 'desc' }],
    [[1, 2], { key: 'added', dir: 'desc' }],
  ]) {
    const kept = sanitizeState({ lists: [{ ...base, sort: bad }] }).lists[0].sort;
    assert.deepEqual([kept.key, kept.dir], [expected.key, expected.dir], JSON.stringify(bad));
  }
});

test('a sort survives saving and loading', async () => {
  const data = {};
  const storage = { get: async (k) => ({ [k]: data[k] }), set: async (o) => Object.assign(data, o) };
  await saveLists(storage, { version: 1, lists: [{ id: 'a', name: 'W', items: [], sort: { key: 'volatility', dir: 'asc' } }] });
  assert.deepEqual((await loadLists(storage)).lists[0].sort, { key: 'volatility', dir: 'asc' });
});
