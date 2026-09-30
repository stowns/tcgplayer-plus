import test from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyState, createList, renameList, deleteList, addItem, removeItem,
  listsContaining, itemKey, countItems, LIST_LIMITS, setListSort, listSort,
} from '../src/lib/lists.js';

const ITEM = {
  productId: '642621',
  language: 'English',
  name: 'Genesect ex - 169/086',
  setName: 'SV: Black Bolt',
  url: 'https://www.tcgplayer.com/product/642621/pokemon-sv-black-bolt-genesect-ex-169-086',
};
const at = (n) => new Date(Date.UTC(2026, 8, 30, 12, n)).toISOString();

test('a fresh state has no lists', () => {
  const s = emptyState();
  assert.deepEqual(s.lists, []);
  assert.equal(countItems(s), 0);
});

test('createList adds a named list and returns its id', () => {
  const { state, list } = createList(emptyState(), 'Watchlist', { now: at(0) });
  assert.equal(state.lists.length, 1);
  assert.equal(list.name, 'Watchlist');
  assert.equal(list.createdAt, at(0));
  assert.deepEqual(list.items, []);
  assert.ok(list.id);
});

test('createList trims the name and rejects an empty one', () => {
  assert.equal(createList(emptyState(), '  Trades  ').list.name, 'Trades');
  assert.throws(() => createList(emptyState(), '   '), /name/i);
  assert.throws(() => createList(emptyState(), null), /name/i);
});

test('createList refuses a name already in use, whatever the case', () => {
  const { state } = createList(emptyState(), 'Watchlist');
  assert.throws(() => createList(state, 'watchlist'), /already/i);
});

test('createList gives every list a distinct id', () => {
  let s = emptyState();
  const ids = new Set();
  for (const name of ['A', 'B', 'C']) {
    const r = createList(s, name);
    s = r.state;
    ids.add(r.list.id);
  }
  assert.equal(ids.size, 3);
});

test('renameList renames, and still refuses a clash', () => {
  let { state, list } = createList(emptyState(), 'Watchlist');
  ({ state } = createList(state, 'Trades'));
  state = renameList(state, list.id, 'Buy soon', { now: at(1) });
  assert.equal(state.lists[0].name, 'Buy soon');
  assert.equal(state.lists[0].updatedAt, at(1));
  assert.throws(() => renameList(state, list.id, 'trades'), /already/i);
  assert.throws(() => renameList(state, 'nope', 'x'), /not found/i);
});

test('deleteList removes only that list', () => {
  let { state, list } = createList(emptyState(), 'Watchlist');
  ({ state } = createList(state, 'Trades'));
  state = deleteList(state, list.id);
  assert.deepEqual(state.lists.map((l) => l.name), ['Trades']);
  assert.throws(() => deleteList(state, 'nope'), /not found/i);
});

test('itemKey identifies a product and its language, not the URL', () => {
  assert.equal(itemKey(ITEM), '642621:english');
  // The same card in another language is a different thing to save.
  assert.notEqual(itemKey({ ...ITEM, language: 'Japanese' }), itemKey(ITEM));
  // Tracking parameters on the URL must not create a second entry.
  assert.equal(itemKey({ ...ITEM, url: `${ITEM.url}?page=3&utm=x` }), itemKey(ITEM));
});

test('addItem saves an item with the time it was saved', () => {
  const { state, list } = createList(emptyState(), 'Watchlist');
  const r = addItem(state, list.id, ITEM, { now: at(2) });
  assert.equal(r.added, true);
  const saved = r.state.lists[0].items[0];
  assert.equal(saved.name, ITEM.name);
  assert.equal(saved.savedAt, at(2));
  assert.equal(saved.key, '642621:english');
});

test('addItem is idempotent — saving twice does not duplicate', () => {
  const { state, list } = createList(emptyState(), 'Watchlist');
  const once = addItem(state, list.id, ITEM, { now: at(2) });
  const twice = addItem(once.state, list.id, ITEM, { now: at(9) });
  assert.equal(twice.added, false);
  assert.equal(twice.state.lists[0].items.length, 1);
  assert.equal(twice.state.lists[0].items[0].savedAt, at(2), 'the original save time is kept');
});

test('addItem puts the newest save first', () => {
  const { state, list } = createList(emptyState(), 'Watchlist');
  const a = addItem(state, list.id, ITEM, { now: at(1) });
  const b = addItem(a.state, list.id, { ...ITEM, productId: '999', name: 'Pikachu' }, { now: at(2) });
  assert.deepEqual(b.state.lists[0].items.map((i) => i.name), ['Pikachu', 'Genesect ex - 169/086']);
});

test('addItem rejects an unusable item or an unknown list', () => {
  const { state, list } = createList(emptyState(), 'Watchlist');
  assert.throws(() => addItem(state, 'nope', ITEM), /not found/i);
  assert.throws(() => addItem(state, list.id, { name: 'no id' }), /product/i);
});

test('addItem caps a list rather than growing without limit', () => {
  let { state, list } = createList(emptyState(), 'Watchlist');
  for (let i = 0; i < LIST_LIMITS.maxItemsPerList; i += 1) {
    state = addItem(state, list.id, { ...ITEM, productId: String(i) }).state;
  }
  assert.throws(() => addItem(state, list.id, { ...ITEM, productId: 'over' }), /full/i);
});

test('removeItem takes one item out by key', () => {
  const { state, list } = createList(emptyState(), 'Watchlist');
  const withItem = addItem(state, list.id, ITEM).state;
  const after = removeItem(withItem, list.id, itemKey(ITEM));
  assert.equal(after.lists[0].items.length, 0);
  // Removing something already gone is not an error.
  assert.equal(removeItem(after, list.id, itemKey(ITEM)).lists[0].items.length, 0);
});

test('listsContaining reports where a product is already saved', () => {
  let { state, list } = createList(emptyState(), 'Watchlist');
  const second = createList(state, 'Trades');
  state = addItem(second.state, list.id, ITEM).state;
  assert.deepEqual(listsContaining(state, itemKey(ITEM)), [list.id]);
  assert.deepEqual(listsContaining(state, 'nothing:english'), []);
});

test('every operation leaves the previous state untouched', () => {
  const before = emptyState();
  const { state, list } = createList(before, 'Watchlist');
  addItem(state, list.id, ITEM);
  assert.equal(before.lists.length, 0);
  assert.equal(state.lists[0].items.length, 0, 'addItem returned a new state, not a mutation');
});

const twoLists = () => {
  const a = createList(emptyState(), 'Watching', { now: at(1) });
  return createList(a.state, 'Buy', { now: at(2) });
};

test('a list that has never been sorted is newest first', () => {
  const { state } = twoLists();
  assert.deepEqual(listSort(state.lists[0]), { key: 'added', dir: 'desc' });
  assert.deepEqual(listSort(undefined), { key: 'added', dir: 'desc' });
});

test('setListSort sets one list\'s order and leaves the other list alone', () => {
  const { state } = twoLists();
  const next = setListSort(state, state.lists[0].id, { key: 'ask', dir: 'asc' });
  assert.deepEqual(listSort(next.lists[0]), { key: 'ask', dir: 'asc' });
  assert.deepEqual(listSort(next.lists[1]), { key: 'added', dir: 'desc' });
  assert.equal('sort' in next.lists[1], false, 'an untouched list stores nothing');
});

test('setListSort is a display choice, not an edit: updatedAt is unchanged', () => {
  const { state } = twoLists();
  const next = setListSort(state, state.lists[0].id, { key: 'volatility', dir: 'desc' });
  assert.equal(next.lists[0].updatedAt, state.lists[0].updatedAt);
});

test('setListSort repairs a nonsense sort instead of storing it', () => {
  const { state } = twoLists();
  assert.deepEqual(listSort(setListSort(state, state.lists[0].id, { key: 'nope', dir: 'up' }).lists[0]), { key: 'added', dir: 'desc' });
  assert.deepEqual(listSort(setListSort(state, state.lists[0].id, { key: 'ask', dir: 'sideways' }).lists[0]), { key: 'ask', dir: 'desc' });
});

test('setListSort refuses a list that does not exist, and never mutates the old state', () => {
  const { state } = twoLists();
  assert.throws(() => setListSort(state, 'missing', { key: 'ask', dir: 'asc' }), /no longer exists/);
  setListSort(state, state.lists[0].id, { key: 'ask', dir: 'asc' });
  assert.equal('sort' in state.lists[0], false);
});
