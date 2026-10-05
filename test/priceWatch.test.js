import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTargets, runExclusive, WATCH_LOCK } from '../src/lib/priceWatch.js';
import { setTarget } from '../src/lib/targets.js';

const NOW = '2026-10-04T12:00:00.000Z';
const item = (id, name) => ({ key: `${id}:english`, productId: String(id), language: 'English', name, url: `https://www.tcgplayer.com/product/${id}`, priceAtSave: { condition: 'Near Mint Holofoil' } });
const MAUSHOLD = item(716228, 'Maushold - 146/128');
const LAPRAS = item(696683, 'Lapras - 131/128');
const lists = (...items) => ({ version: 1, lists: [{ id: 'w', name: 'Watching', createdAt: '', updatedAt: '', items }] });
const ask = (price, shipping = 0) => ({ status: 'ok', price, shipping, seller: 'Shop', count: 3 });

function memoryStorage(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  return {
    data, writes,
    async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
    async set(items) { writes.push(Object.keys(items)); Object.assign(data, structuredClone(items)); },
  };
}

/** A watch with targets set, a table of Asks by product id, and a record of what was sent. */
function setup({ items = [MAUSHOLD], targets = {}, prices = {}, notifyOk = true } = {}) {
  let t = {};
  for (const [key, spec] of Object.entries(targets)) t = setTarget(t, key, spec, { now: NOW });
  const storage = memoryStorage({ lists: lists(...items), targets: t });
  const sent = [];
  const looked = [];
  const world = { prices: { ...prices }, notifyOk };
  const deps = {
    storage,
    lookupAsk: async (it) => { looked.push(it.productId); return world.prices[it.productId] ?? { status: 'none' }; },
    notify: async (n) => { sent.push(n); return { ok: world.notifyOk }; },
    now: () => '2026-10-04T13:00:00.000Z',
  };
  return { storage, sent, looked, world, check: () => checkTargets(deps), target: (key) => storage.data.targets[key] };
}

test('with no targets there is nothing to look up and nothing sent', async () => {
  const w = setup();
  assert.deepEqual(await w.check(), { checked: 0, met: 0, notified: 0, failed: 0 });
  assert.deepEqual(w.looked, []);
  assert.deepEqual(w.sent, []);
});

test('a target that is not met yet is checked and nothing is sent', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 8 } }, prices: { 716228: ask(9, 0.99) } });
  assert.deepEqual(await w.check(), { checked: 1, met: 0, notified: 0, failed: 0 });
  assert.deepEqual(w.looked, ['716228']);
  assert.equal(w.target(MAUSHOLD.key).met, false);
});

test('when the Ask reaches the target one notification is sent and the target is marked met', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(8.8, 0.99) } });
  assert.deepEqual(await w.check(), { checked: 1, met: 1, notified: 1, failed: 0 });
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].title, 'Price target reached: Maushold - 146/128');
  assert.match(w.sent[0].message, /Ask \$9\.79 is at or below \$10\.00/);
  assert.equal(w.sent[0].url, MAUSHOLD.url);
  const t = w.target(MAUSHOLD.key);
  assert.deepEqual([t.met, t.pending, t.notifiedAt], [true, false, '2026-10-04T13:00:00.000Z']);
});

test('it is not announced again on the next check while it stays met', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(8.8, 0.99) } });
  await w.check();
  assert.deepEqual(await w.check(), { checked: 1, met: 1, notified: 0, failed: 0 });
  await w.check();
  assert.equal(w.sent.length, 1);
});

test('when the price moves back out of range it re-arms, and announces the next time it is met', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(9) } });
  await w.check();
  w.world.prices[716228] = ask(12);
  assert.deepEqual(await w.check(), { checked: 1, met: 0, notified: 0, failed: 0 });
  assert.equal(w.target(MAUSHOLD.key).met, false);
  w.world.prices[716228] = ask(9.5);
  assert.deepEqual(await w.check(), { checked: 1, met: 1, notified: 1, failed: 0 });
  assert.equal(w.sent.length, 2);
});

test('a seller\'s target fires when the Ask rises to it', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 20, direction: 'above' } }, prices: { 716228: ask(15) } });
  assert.equal((await w.check()).notified, 0);
  w.world.prices[716228] = ask(19.5, 0.99);
  assert.equal((await w.check()).notified, 1);
  assert.match(w.sent[0].message, /Ask \$20\.49 is at or above \$20\.00/);
});

test('nothing listed, or a lookup that failed, changes nothing', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(9) } });
  await w.check();
  for (const gone of [{ status: 'none' }, { status: 'unavailable' }, null]) {
    w.world.prices[716228] = gone;
    assert.deepEqual(await w.check(), { checked: 1, met: 1, notified: 0, failed: 0 });
  }
  w.world.prices[716228] = ask(9);
  await w.check();
  assert.equal(w.sent.length, 1, 'it never left the range, so it is not announced again');
});

test('a lookup that throws is treated as no answer, and the other targets are still checked', async () => {
  const w = setup({ items: [MAUSHOLD, LAPRAS], targets: { [MAUSHOLD.key]: { price: 10 }, [LAPRAS.key]: { price: 10 } } });
  const storage = w.storage;
  const sent = [];
  const result = await checkTargets({
    storage,
    lookupAsk: async (it) => { if (it.productId === '716228') throw new Error('boom'); return ask(9); },
    notify: async (n) => { sent.push(n); return { ok: true }; },
  });
  assert.deepEqual(result, { checked: 2, met: 1, notified: 1, failed: 0 });
  assert.match(sent[0].title, /Lapras/);
});

test('a target with notifications off becomes met without sending anything', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10, notify: false } }, prices: { 716228: ask(9) } });
  assert.deepEqual(await w.check(), { checked: 1, met: 1, notified: 0, failed: 0 });
  assert.equal(w.target(MAUSHOLD.key).met, true);
  assert.deepEqual(w.sent, []);
});

test('the result is saved before the notification is sent', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(9) } });
  let metWhenSent = null;
  await checkTargets({
    storage: w.storage, lookupAsk: async () => ask(9),
    notify: async () => { metWhenSent = w.storage.data.targets[MAUSHOLD.key].met; return { ok: true }; },
  });
  assert.equal(metWhenSent, true);
});

test('a notification that fails to send stays owed and is sent on the next check', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(9) }, notifyOk: false });
  assert.deepEqual(await w.check(), { checked: 1, met: 1, notified: 0, failed: 1 });
  assert.deepEqual([w.target(MAUSHOLD.key).met, w.target(MAUSHOLD.key).pending, w.target(MAUSHOLD.key).notifiedAt], [true, true, '']);
  w.world.notifyOk = true;
  assert.deepEqual(await w.check(), { checked: 1, met: 1, notified: 1, failed: 0 });
  assert.equal(w.target(MAUSHOLD.key).pending, false);
  await w.check();
  assert.equal(w.sent.length, 2, 'the failed attempt and the one that got through, and no more');
});

test('a notifier that throws counts as a failure and is retried later', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(9) } });
  const result = await checkTargets({ storage: w.storage, lookupAsk: async () => ask(9), notify: async () => { throw new Error('x'); } });
  assert.deepEqual(result, { checked: 1, met: 1, notified: 0, failed: 1 });
  assert.equal(w.target(MAUSHOLD.key).pending, true);
});

test('an owed notification is dropped if the price has left the range before it could be sent', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(9) }, notifyOk: false });
  await w.check();
  w.world.notifyOk = true;
  w.world.prices[716228] = ask(15);
  assert.deepEqual(await w.check(), { checked: 1, met: 0, notified: 0, failed: 0 });
  assert.equal(w.target(MAUSHOLD.key).pending, false);
  assert.equal(w.sent.length, 1, 'only the failed attempt');
});

test('turning notifications off cancels one that was owed', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } }, prices: { 716228: ask(9) }, notifyOk: false });
  await w.check();
  w.storage.data.targets[MAUSHOLD.key].notify = false;
  w.world.notifyOk = true;
  await w.check();
  assert.equal(w.target(MAUSHOLD.key).pending, false);
  assert.equal(w.sent.length, 1);
});

test('several targets met at once each get their own notification', async () => {
  const w = setup({
    items: [MAUSHOLD, LAPRAS], targets: { [MAUSHOLD.key]: { price: 10 }, [LAPRAS.key]: { price: 12 } },
    prices: { 716228: ask(9), 696683: ask(11) },
  });
  assert.deepEqual(await w.check(), { checked: 2, met: 2, notified: 2, failed: 0 });
  assert.deepEqual(w.sent.map((n) => n.title).sort(), ['Price target reached: Lapras - 131/128', 'Price target reached: Maushold - 146/128']);
});

test('a card in two lists is looked up once and announced once', async () => {
  const storage = memoryStorage({
    lists: { version: 1, lists: [
      { id: 'a', name: 'A', createdAt: '', updatedAt: '', items: [MAUSHOLD] },
      { id: 'b', name: 'B', createdAt: '', updatedAt: '', items: [MAUSHOLD] },
    ] },
    targets: setTarget({}, MAUSHOLD.key, { price: 10 }, { now: NOW }),
  });
  const looked = [];
  const sent = [];
  await checkTargets({ storage, lookupAsk: async (it) => { looked.push(it.productId); return ask(9); }, notify: async (n) => { sent.push(n); return { ok: true }; } });
  assert.equal(looked.length, 1);
  assert.equal(sent.length, 1);
});

test('a target whose product is in no list any more is removed, not checked', async () => {
  const w = setup({ items: [LAPRAS], targets: { [MAUSHOLD.key]: { price: 10 }, [LAPRAS.key]: { price: 5 } }, prices: { 696683: ask(9) } });
  assert.deepEqual(await w.check(), { checked: 1, met: 0, notified: 0, failed: 0 });
  assert.deepEqual(Object.keys(w.storage.data.targets), [LAPRAS.key]);
  assert.deepEqual(w.looked, ['696683']);
});

test('a target the user edits while a check is running is not overwritten by that check', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 10 } } });
  const result = await checkTargets({
    storage: w.storage,
    lookupAsk: async () => {
      // The user changes the target while the price is being looked up.
      w.storage.data.targets = setTarget(w.storage.data.targets, MAUSHOLD.key, { price: 5 }, { now: '2026-10-04T12:30:00.000Z' });
      return ask(9);
    },
    notify: async (n) => { w.sent.push(n); return { ok: true }; },
  });
  assert.equal(w.target(MAUSHOLD.key).price, 5, 'the edit stands');
  assert.equal(w.target(MAUSHOLD.key).met, false, 'the old verdict was not written over it');
  assert.equal(w.sent.length, 0, 'and nothing was announced for a target that no longer exists');
  assert.equal(result.notified, 0);
});

test('nothing is written when nothing changed', async () => {
  const w = setup({ targets: { [MAUSHOLD.key]: { price: 5 } }, prices: { 716228: ask(9) } });
  await w.check();
  assert.deepEqual(w.storage.writes, []);
});

// ---- one dashboard tab at a time -----------------------------------------------

test('without the Web Locks API the check just runs', async () => {
  assert.equal(await runExclusive(async () => 'ran', undefined), 'ran');
  assert.equal(await runExclusive(() => 'sync', {}), 'sync');
});

test('with the lock free the check runs under it; with another tab holding it, it is skipped', async () => {
  const requests = [];
  const free = { request: async (name, options, fn) => { requests.push([name, options]); return fn({ name }); } };
  assert.equal(await runExclusive(async () => 'ran', free), 'ran');
  assert.deepEqual(requests, [[WATCH_LOCK, { ifAvailable: true }]]);
  const taken = { request: async (name, options, fn) => fn(null) };
  let ran = false;
  assert.deepEqual(await runExclusive(async () => { ran = true; }, taken), { skipped: true });
  assert.equal(ran, false);
});
