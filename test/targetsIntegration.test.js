/*
 * Auto-refresh, price targets and notifications, end to end: the *built*
 * background and dashboard for each browser, a stubbed TCGplayer and a stubbed
 * ntfy. Time in the dashboard runs fast, so "every 5 seconds" takes 50 ms.
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dist, apiName, messageBus, forEachBrowser } from './helpers/extensionApi.js';
import { JSDOM, VirtualConsole } from 'jsdom';
import { PIKACHU_HISTORY } from './fixtures/tcgplayerHistory.js';
import { ORDERS, orderPage } from './fixtures/orderHistoryFull.js';
import { parseOrders } from '../src/lib/orderParse.js';
import { emptyArchive, mergeOrders } from '../src/lib/ordersArchive.js';

const SPEED = 100;
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const until = async (check, limit = 8000) => {
  const start = Date.now();
  while (!check() && Date.now() - start < limit) await settle(15);
  return check();
};

const item = (productId, name) => ({
  key: `${productId}:english`, productId: String(productId), language: 'English', name, setName: 'ME: 30th Celebration', number: '', rarity: '',
  imageUrl: '', url: `https://www.tcgplayer.com/product/${productId}?Language=English`, note: '', savedAt: '2026-09-20T00:00:00.000Z',
  priceAtSave: { market: 10, lowest: 10, condition: 'Near Mint Holofoil', asLowAs: 10 },
});
const LAPRAS = item(696683, 'Lapras - 131/128');
const MEOWTH = item(714358, 'Meowth - 144/128');
const LISTS = () => ({ version: 1, lists: [{ id: 'w', name: 'Watching', createdAt: '', updatedAt: '', items: [LAPRAS, MEOWTH] }] });

function storageArea(initial = {}) {
  const data = structuredClone(initial);
  const listeners = [];
  const changed = (keys, of) => listeners.slice().forEach((fn) => fn(Object.fromEntries(keys.map((k) => [k, of(k)])), 'local'));
  return {
    data, listeners,
    async get(keys) {
      if (keys === null) return structuredClone(data);
      return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(items) { Object.assign(data, structuredClone(items)); changed(Object.keys(items), (k) => ({ newValue: data[k] })); },
    async remove(keys) { const list = [].concat(keys); list.forEach((k) => delete data[k]); changed(list, () => ({})); },
  };
}

/** TCGplayer (prices can be changed mid-test) and ntfy (records what is published). */
function fakeWorld({ prices = { 696683: [9.32, 1.49] }, ntfyStatus = 200 } = {}) {
  const world = { prices: { ...prices }, ntfyStatus, ntfy: [], requests: [] };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, url: '', headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) });
  world.fetch = async (url, init = {}) => {
    world.requests.push({ url, method: init.method || 'GET' });
    if (url === 'https://ntfy.sh/') {
      if (world.ntfyStatus !== 200) return reply(world.ntfyStatus, {});
      world.ntfy.push(JSON.parse(init.body));
      return reply(200, { id: 'x' });
    }
    const listing = /product\/(\d+)\/listings/.exec(url);
    if (listing) {
      const p = world.prices[listing[1]];
      const rows = p ? [{ price: p[0], shippingPrice: p[1], listingType: 'standard', sellerName: 'Shop' }] : [];
      return reply(200, { errors: [], results: [{ totalResults: rows.length, results: rows }] });
    }
    if (/price\/history\/\d+\/detailed/.test(url)) return reply(200, PIKACHU_HISTORY);
    return reply(404, {});
  };
  world.asked = (id) => world.requests.filter((r) => r.url.includes(`/product/${id}/listings`)).length;
  return world;
}

const pages = [];
afterEach(() => { while (pages.length) pages.pop().close(); });

async function startBackground(world, local = storageArea({ lists: LISTS() })) {
  const { window } = new JSDOM('<body></body>', { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  pages.push(window);
  const bus = messageBus();
  window.fetch = world.fetch;
  window.Math.random = () => 0;
  window[apiName()] = {
    storage: { local },
    runtime: bus.runtime,
    action: bus.action,
    tabs: { create: async () => ({}), sendMessage: bus.tabs.sendMessage },
  };
  window.eval(await readFile(dist('background.js'), 'utf8'));
  await settle();
  return { local, world, pageRuntime: bus.pageRuntime };
}

/** One lock shared by every dashboard opened with it, as the browser's Web Locks are. */
function sharedLocks() {
  const held = new Set();
  return {
    request: async (name, options, fn) => {
      if (held.has(name)) return fn(null);
      held.add(name);
      try { return await fn({ name }); } finally { held.delete(name); }
    },
  };
}

async function openDashboard(bg, hash = '#lists', { locks, remembered = {}, consent } = {}) {
  const html = await readFile('src/home/home.html', 'utf8');
  const { window } = new JSDOM(html, {
    url: `http://localhost/home/home.html${hash}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: new VirtualConsole(),
  });
  pages.push(window);
  // Time runs SPEED times faster here: the clock and the timers together.
  const Real = window.Date;
  const started = Real.now();
  const fast = () => started + (Real.now() - started) * SPEED;
  window.Date = class extends Real {
    constructor(...args) { super(...(args.length ? args : [fast()])); }
    static now() { return fast(); }
  };
  const realInterval = window.setInterval.bind(window);
  window.setInterval = (fn, ms) => realInterval(fn, Math.max(1, ms / SPEED));
  window.Math.random = () => 0; // retries do not wait
  window.fetch = bg.world.fetch;
  window.confirm = () => true;
  if (locks) Object.defineProperty(window.navigator, 'locks', { value: locks, configurable: true });
  for (const [k, v] of Object.entries(remembered)) window.localStorage.setItem(k, v);
  // Every row counts as on screen straight away.
  window.IntersectionObserver = class {
    constructor(cb) { this.cb = cb; }
    observe(target) { Promise.resolve().then(() => this.cb([{ isIntersecting: true, target }])); }
    unobserve() {}
    disconnect() {}
  };
  window[apiName()] = {
    storage: { local: bg.local, onChanged: {
      addListener: (fn) => bg.local.listeners.push(fn),
      removeListener: (fn) => { const i = bg.local.listeners.indexOf(fn); if (i >= 0) bg.local.listeners.splice(i, 1); },
    } },
    // `consent` makes this a Firefox that asks before data may leave the browser.
    runtime: consent ? { ...bg.pageRuntime(), getManifest: () => FIREFOX_MANIFEST } : bg.pageRuntime(),
    ...(consent ? { permissions: {
      contains: async () => consent.granted,
      request: async (what) => { consent.asked.push(what); if (consent.answer) consent.granted = true; return consent.answer; },
    } } : {}),
  };
  window.eval(await readFile(dist('home/home.js'), 'utf8'));
  await settle(60);
  const d = window.document;
  const fire = (node, type) => node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));
  const row = (name) => [...d.querySelectorAll('.item')].find((r) => r.textContent.includes(name));
  return {
    window, document: d, row,
    toggle: d.getElementById('autoRefreshOn'),
    seconds: d.getElementById('autoRefreshSeconds'),
    next: () => d.getElementById('autoRefreshNext').textContent,
    warning: d.getElementById('rateWarning'),
    setSeconds: async (value) => { const f = d.getElementById('autoRefreshSeconds'); f.value = String(value); fire(f, 'change'); await settle(40); },
    turnOn: async () => { const t = d.getElementById('autoRefreshOn'); if (!t.checked) t.click(); await settle(40); },
    turnOff: async () => { const t = d.getElementById('autoRefreshOn'); if (t.checked) t.click(); await settle(40); },
    /** Open the target form on a card, fill it in and save. */
    setTarget: async (name, { price, direction, notify, word = 'secret' } = {}) => {
      const open = row(name).querySelector('.item__target-set, .item__target-edit');
      open.click();
      await settle(20);
      const form = row(name).querySelector('form.target-form');
      if (direction) { form.querySelector('.target-form__direction').value = direction; fire(form.querySelector('.target-form__direction'), 'change'); }
      if (price !== undefined) { form.querySelector('.target-form__price').value = String(price); fire(form.querySelector('.target-form__price'), 'input'); }
      if (notify !== undefined && form.querySelector('.target-form__notify').checked !== notify) form.querySelector('.target-form__notify').click();
      // Asked for only when notifications are wanted and no topic exists yet.
      const wordField = form.querySelector('.target-form__word');
      if (!form.querySelector('.target-form__setup').hidden) { wordField.value = word; fire(wordField, 'input'); }
      fire(form, 'submit');
      await settle(60);
    },
  };
}

const FIREFOX_MANIFEST = { browser_specific_settings: { gecko: { data_collection_permissions: { required: ['none'], optional: ['websiteContent'] } } } };
/** A Firefox user's consent to notifications: not yet given, and how they will answer when asked. */
const consentState = ({ granted = false, answer = true } = {}) => ({ granted, answer, asked: [] });
const settings = (bg) => bg.local.data.settings;
const topicOf = (bg) => (settings(bg) && settings(bg).notifications ? settings(bg).notifications.topic : '');
const targetOf = (bg, it = LAPRAS) => (bg.local.data.targets || {})[it.key];
const preset = (extra = {}) => storageArea({ lists: LISTS(), ...extra });
const ON = (intervalSeconds = 5) => ({ autoRefresh: { enabled: true, intervalSeconds }, rateWarningDismissed: true, notifications: { topic: 'lapras-k3x9q' } });
const TARGET = (price, extra = {}) => ({ price, direction: 'below', notify: true, met: false, pending: false, updatedAt: '2026-10-01T00:00:00.000Z', notifiedAt: '', ...extra });

forEachBrowser(() => {

// ---- auto-refresh ---------------------------------------------------------------

test('auto-refresh is off at first, set to ten minutes, and nothing is counting down', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  assert.equal(page.toggle.checked, false);
  assert.equal(page.seconds.value, '600');
  assert.equal(page.next(), '');
  assert.equal(page.warning.hidden, true);
  assert.equal(settings(bg), undefined, 'nothing is written until something is changed');
});

test('the control sits in the header beside Clear price cache', async () => {
  const bg = await startBackground(fakeWorld());
  const { document } = await openDashboard(bg);
  const tools = document.querySelector('.app-header__tools');
  assert.ok(tools.querySelector('#autoRefreshOn'));
  assert.ok(tools.querySelector('#autoRefreshSeconds'));
  assert.ok(tools.querySelector('#clearCache'));
  assert.ok(tools.querySelector('.auto-refresh').compareDocumentPosition(tools.querySelector('#clearCache')) & 4, 'just before it');
});

test('while it is off, prices are asked for once and not again', async () => {
  const world = fakeWorld();
  const page = await openDashboard(await startBackground(world));
  await until(() => world.asked(696683) === 1);
  await settle(400); // forty seconds of dashboard time
  assert.equal(world.asked(696683), 1);
  void page;
});

test('turning it on is remembered, starts the countdown, and prices are asked for again every interval', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world);
  const page = await openDashboard(bg);
  await until(() => world.asked(696683) === 1);
  await page.setSeconds(5);
  await page.turnOn();
  assert.equal(settings(bg).autoRefresh.enabled, true);
  assert.match(page.next(), /^next in \d+:\d\d$/);
  assert.ok(await until(() => world.asked(696683) >= 4), 'asked again and again');
  assert.equal(world.requests.some((r) => /mp-search-api|listings/.test(r.url)), true);
});

test('turning it off stops the refreshing and the countdown', async () => {
  const world = fakeWorld();
  const page = await openDashboard(await startBackground(world, preset({ settings: ON(5) })));
  await until(() => world.asked(696683) >= 3);
  await page.turnOff();
  await settle(100);
  const at = world.asked(696683);
  await settle(400);
  assert.equal(world.asked(696683), at);
  assert.equal(page.next(), '');
});

test('the interval is in seconds, at least five, and nonsense goes back to ten minutes', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  await page.setSeconds(90);
  assert.equal(settings(bg).autoRefresh.intervalSeconds, 90);
  await page.setSeconds(2);
  assert.equal(page.seconds.value, '5');
  assert.equal(settings(bg).autoRefresh.intervalSeconds, 5);
  await page.setSeconds('');
  assert.equal(page.seconds.value, '600');
  assert.equal(settings(bg).autoRefresh.intervalSeconds, 600);
});

test('the setting survives closing and reopening the dashboard', async () => {
  const bg = await startBackground(fakeWorld());
  const first = await openDashboard(bg);
  await first.setSeconds(45);
  await first.turnOn();
  const again = await openDashboard(bg);
  assert.equal(again.toggle.checked, true);
  assert.equal(again.seconds.value, '45');
  assert.match(again.next(), /next in/);
});

test('a second dashboard tab follows a change made in the first', async () => {
  const bg = await startBackground(fakeWorld());
  const a = await openDashboard(bg);
  const b = await openDashboard(bg);
  await a.setSeconds(120);
  await a.turnOn();
  await settle(60);
  assert.equal(b.toggle.checked, true);
  assert.equal(b.seconds.value, '120');
});

// ---- the rate-limit warning --------------------------------------------------------

test('refreshing faster than ten minutes warns about rate limits; ten minutes or slower does not', async () => {
  const page = await openDashboard(await startBackground(fakeWorld()));
  await page.turnOn();
  assert.equal(page.warning.hidden, true, 'ten minutes is fine');
  await page.setSeconds(599);
  assert.equal(page.warning.hidden, false);
  assert.match(page.warning.textContent, /rate limited by TCGplayer/);
  assert.match(page.warning.textContent, /raise the interval/);
  await page.setSeconds(600);
  assert.equal(page.warning.hidden, true);
});

test('with auto-refresh off there is nothing to warn about', async () => {
  const page = await openDashboard(await startBackground(fakeWorld()));
  await page.setSeconds(30);
  assert.equal(page.warning.hidden, true);
  await page.turnOn();
  assert.equal(page.warning.hidden, false);
});

test('once dismissed the warning is recorded and never shown again', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  await page.turnOn();
  await page.setSeconds(30);
  page.document.getElementById('rateWarningDismiss').click();
  await settle(40);
  assert.equal(page.warning.hidden, true);
  assert.equal(settings(bg).rateWarningDismissed, true);
  await page.setSeconds(10);
  assert.equal(page.warning.hidden, true, 'not for a faster interval');
  await page.turnOff();
  await page.turnOn();
  assert.equal(page.warning.hidden, true, 'not after turning it off and on');
  const reopened = await openDashboard(bg);
  assert.equal(reopened.warning.hidden, true, 'not after reopening the dashboard');
});

// ---- setting a target ---------------------------------------------------------------

test('each watch-list item offers to set a price target', async () => {
  const page = await openDashboard(await startBackground(fakeWorld()));
  assert.equal(page.document.querySelectorAll('.item .item__target-set').length, 2);
  assert.equal(page.row('Lapras').querySelector('.item__target-set').textContent, 'Set price target');
});

test('with auto-refresh off, the target form says tracking needs it and can turn it on in place', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  page.row('Lapras').querySelector('.item__target-set').click();
  await settle(20);
  const alert = () => page.row('Lapras').querySelector('.target-form__alert');
  assert.equal(page.row('Lapras').querySelector('.target-form__notify').checked, true, 'notifications are on by default');
  assert.equal(alert().hidden, false);
  assert.match(alert().textContent, /Price tracking runs in your browser while this dashboard is open/);
  page.row('Lapras').querySelector('.target-form__price').value = '11';
  page.row('Lapras').querySelector('.target-form__price').dispatchEvent(new page.window.Event('input', { bubbles: true }));

  alert().querySelector('.target-form__enable').click();
  await settle(80);
  assert.equal(settings(bg).autoRefresh.enabled, true);
  assert.equal(page.toggle.checked, true, 'the header control shows it');
  assert.match(page.next(), /next in/);
  assert.equal(alert().hidden, true);
  assert.equal(page.row('Lapras').querySelector('.target-form__price').value, '11', 'what was typed is still there');
});

test('saving a target stores it against the product and shows it with Edit', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  await page.setTarget('Lapras', { price: '8.50' });
  assert.deepEqual([targetOf(bg).price, targetOf(bg).direction, targetOf(bg).notify], [8.5, 'below', true]);
  assert.equal(page.row('Lapras').querySelector('form'), null);
  assert.equal(page.row('Lapras').querySelector('.item__target-text').textContent, 'Target: at or below $8.50');
  assert.equal(page.row('Lapras').querySelector('.item__target-notify').textContent, 'notifications on');
  assert.ok(page.row('Lapras').querySelector('.item__target-edit'));
  assert.equal(page.row('Meowth').querySelector('.item__target-set').hidden, false, 'other cards are untouched');
});

test('a target can be edited, and removed', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  await page.setTarget('Lapras', { price: 8 });
  await page.setTarget('Lapras', { price: 20, direction: 'above', notify: false });
  assert.deepEqual([targetOf(bg).price, targetOf(bg).direction, targetOf(bg).notify], [20, 'above', false]);
  assert.equal(page.row('Lapras').querySelector('.item__target-text').textContent, 'Target: at or above $20.00');
  assert.equal(page.row('Lapras').querySelector('.item__target-notify').textContent, 'notifications off');

  page.row('Lapras').querySelector('.item__target-edit').click();
  await settle(20);
  page.row('Lapras').querySelector('.target-form__remove').click();
  await settle(60);
  assert.equal(targetOf(bg), undefined);
  assert.equal(page.row('Lapras').querySelector('.item__target-set').hidden, false);
});

test('a price that is not a price is refused in the form and nothing is saved', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  await page.setTarget('Lapras', { price: 'cheap' });
  assert.match(page.row('Lapras').querySelector('.target-form__error').textContent, /Enter a price above zero/);
  assert.equal(page.row('Lapras').querySelector('.target-form__price').value, 'cheap');
  assert.equal(targetOf(bg), undefined);
  page.row('Lapras').querySelector('.target-form__cancel').click();
  await settle(20);
  assert.equal(page.row('Lapras').querySelector('.item__target-set').hidden, false);
});

test('removing the card from its last list removes its target', async () => {
  const bg = await startBackground(fakeWorld(), preset({ targets: { [LAPRAS.key]: TARGET(5), [MEOWTH.key]: TARGET(5) } }));
  const page = await openDashboard(bg);
  page.row('Lapras').querySelector('.item__remove').click();
  await settle(80);
  assert.deepEqual(Object.keys(bg.local.data.targets), [MEOWTH.key]);
});

// ---- being told ---------------------------------------------------------------------

test('when the Ask reaches the target one notification is published to the user\'s ntfy topic', async () => {
  const world = fakeWorld(); // Lapras: $9.32 + $1.49 = $10.81
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11) } }));
  const page = await openDashboard(bg);
  assert.ok(await until(() => world.ntfy.length === 1));
  assert.deepEqual(world.ntfy[0], {
    topic: 'lapras-k3x9q',
    title: 'Price target reached: Lapras - 131/128',
    message: 'Ask $10.81 is at or below $11.00, your target ($9.32 + $1.49 shipping).',
    click: LAPRAS.url,
    tags: ['chart_with_downwards_trend'],
    priority: 4,
  });
  assert.ok(await until(() => page.row('Lapras').querySelector('.item__target-met')), 'the list shows it as met');
  assert.equal(targetOf(bg).met, true);
  assert.ok(targetOf(bg).notifiedAt);
});

test('it is not announced again on later refreshes while it stays met', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11) } }));
  await openDashboard(bg);
  await until(() => world.ntfy.length === 1);
  const asked = world.asked(696683);
  assert.ok(await until(() => world.asked(696683) >= asked + 4), 'several more refreshes happen');
  assert.equal(world.ntfy.length, 1);
});

test('a target that is not reached sends nothing', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(10) } }));
  await openDashboard(bg);
  await until(() => world.asked(696683) >= 4);
  assert.equal(world.ntfy.length, 0);
  assert.equal(targetOf(bg).met, false);
});

test('when the price leaves the range and comes back, it is announced again', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11) } }));
  const page = await openDashboard(bg);
  await until(() => world.ntfy.length === 1);
  world.prices[696683] = [14, 1];
  assert.ok(await until(() => targetOf(bg).met === false));
  assert.ok(await until(() => !page.row('Lapras').querySelector('.item__target-met')), 'the marker goes');
  world.prices[696683] = [8, 1];
  assert.ok(await until(() => world.ntfy.length === 2));
  assert.match(world.ntfy[1].message, /Ask \$9\.00 is at or below \$11\.00/);
});

test('a seller\'s target fires when the Ask rises to it', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(20, { direction: 'above' }) } }));
  await openDashboard(bg);
  await until(() => world.asked(696683) >= 3);
  assert.equal(world.ntfy.length, 0);
  world.prices[696683] = [19.5, 0.99];
  assert.ok(await until(() => world.ntfy.length === 1));
  assert.equal(world.ntfy[0].message, 'Ask $20.49 is at or above $20.00, your target ($19.50 + $0.99 shipping).');
  assert.deepEqual(world.ntfy[0].tags, ['chart_with_upwards_trend']);
});

test('a target with notifications off is marked met but nothing is sent', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11, { notify: false }) } }));
  const page = await openDashboard(bg);
  assert.ok(await until(() => page.row('Lapras').querySelector('.item__target-met')));
  await settle(200);
  assert.equal(world.ntfy.length, 0);
});

test('with auto-refresh off nothing is checked and nothing is sent', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ targets: { [LAPRAS.key]: TARGET(11) } }));
  const page = await openDashboard(bg);
  await settle(400);
  assert.equal(world.ntfy.length, 0);
  assert.equal(targetOf(bg).met, false);
  assert.match(page.row('Lapras').querySelector('.item__target-paused').textContent, /auto-refresh is off/);
});

test('a target that is already met when it is set is announced at once, not an interval later', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(86400) }));
  const page = await openDashboard(bg);
  await page.setTarget('Lapras', { price: 11 });
  assert.ok(await until(() => world.ntfy.length === 1, 3000));
});

test('turning auto-refresh on checks the targets straight away', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ targets: { [LAPRAS.key]: TARGET(11) }, settings: { ...ON(86400), autoRefresh: { enabled: false, intervalSeconds: 86400 } } }));
  const page = await openDashboard(bg);
  await settle(100);
  assert.equal(world.ntfy.length, 0);
  await page.turnOn();
  assert.ok(await until(() => world.ntfy.length === 1, 3000));
});

test('targets are checked whichever tab is showing', async () => {
  const world = fakeWorld();
  const orders = mergeOrders(emptyArchive(), parseOrders(new JSDOM(orderPage({ orders: ORDERS })).window.document)).archive;
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11) }, orders }));
  await openDashboard(bg, '#orders', { remembered: { 'ptcg.ordersRange': 'All saved' } });
  assert.ok(await until(() => world.ntfy.length === 1));
  const settingsTab = await startBackground(fakeWorld(), preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11) } }));
  await openDashboard(settingsTab, '#settings');
  assert.ok(await until(() => settingsTab.world.ntfy.length === 1), 'and on the Settings tab');
});

test('two dashboard tabs open at once send one notification, not two', async () => {
  const world = fakeWorld();
  const locks = sharedLocks();
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11) } }));
  await openDashboard(bg, '#lists', { locks });
  await openDashboard(bg, '#lists', { locks });
  await until(() => world.ntfy.length >= 1);
  await until(() => world.asked(696683) >= 8);
  assert.equal(world.ntfy.length, 1);
});

test('if ntfy is down the notification is not lost: it is sent once ntfy is back', async () => {
  const world = fakeWorld({ ntfyStatus: 500 });
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11) } }));
  await openDashboard(bg);
  assert.ok(await until(() => targetOf(bg).met === true && targetOf(bg).pending === true, 10000), 'met, and still owed');
  assert.equal(world.ntfy.length, 0);
  world.ntfyStatus = 200;
  assert.ok(await until(() => world.ntfy.length === 1, 10000));
  assert.ok(await until(() => targetOf(bg).pending === false));
});

// ---- Order History refreshes too ------------------------------------------------------

test('on Order History, auto-refresh asks for prices again but does not read the orders again', async () => {
  const world = fakeWorld();
  const orders = mergeOrders(emptyArchive(), parseOrders(new JSDOM(orderPage({ orders: ORDERS })).window.document)).archive;
  const bg = await startBackground(world, preset({ settings: ON(5), orders }));
  const page = await openDashboard(bg, '#orders', { remembered: { 'ptcg.ordersRange': 'All saved' } });
  assert.ok(await until(() => page.document.querySelectorAll('.order').length === 6));
  assert.ok(await until(() => world.asked(696683) >= 3, 12000), 'the Lapras price is asked for again and again');
  assert.equal(world.requests.filter((r) => /orderhistory/i.test(r.url)).length, 0, 'the orders themselves are not read again');
  assert.equal(page.document.querySelectorAll('.order').length, 6);
});

// ---- Settings: where notifications go ----------------------------------------------------

const button = (document, text) => [...document.querySelectorAll('.settings-section button')].find((b) => b.textContent === text);
const fire = (window, node, type) => node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true }));

test('opening the dashboard makes no topic: Settings asks for a secret word first', async () => {
  const bg = await startBackground(fakeWorld());
  const { document } = await openDashboard(bg, '#settings');
  assert.equal(topicOf(bg), '');
  assert.equal(document.querySelector('.settings-setup').hidden, false);
  assert.equal(button(document, 'Set up notifications').type, 'submit');
  assert.equal(document.querySelector('.settings-setup__cancel').hidden, true, 'nothing to go back to');
  for (const cls of ['.settings-topic', '.settings-topic__link', '.settings-how', '.settings-actions']) assert.equal(document.querySelector(cls).hidden, true, cls);
});

test('a secret word in Settings makes the topic: the word, a dash and five random characters', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world);
  const { document, window } = await openDashboard(bg, '#settings');
  document.querySelector('.settings-setup__word').value = ' Lapras ';
  fire(window, document.querySelector('.settings-setup'), 'submit');
  assert.ok(await until(() => settings(bg) && settings(bg).notifications.topic));
  const topic = settings(bg).notifications.topic;
  assert.match(topic, /^lapras-[a-z0-9]{5}$/);
  assert.ok(await until(() => document.querySelector('.settings-topic__name').textContent === topic));
  assert.equal(document.querySelector('.settings-setup').hidden, true);
  assert.equal(document.querySelector('.settings-actions').hidden, false);
  assert.equal(document.querySelector('.settings-topic__link a').href, `https://ntfy.sh/${topic}`);
  assert.match(document.querySelector('.settings-status').textContent, /Notifications are set up\. Follow the steps below/);
  assert.equal(document.querySelector('.settings-how').hidden, false);
  assert.equal(world.ntfy.length, 0, 'setting it up sends nothing');
  await openDashboard(bg, '#settings');
  assert.equal(settings(bg).notifications.topic, topic, 'the same one next time');
});

test('a secret word that cannot be used is refused, with the rule', async () => {
  const bg = await startBackground(fakeWorld());
  const { document, window } = await openDashboard(bg, '#settings');
  for (const [bad, message] of [['', /Choose a secret word/], ['two words', /cannot be used\. Use 3 to 24 letters or digits/]]) {
    document.querySelector('.settings-setup__word').value = bad;
    fire(window, document.querySelector('.settings-setup'), 'submit');
    assert.ok(await until(() => message.test(document.querySelector('.settings-status').textContent)), bad);
    assert.equal(document.querySelector('.settings-status').getAttribute('data-error'), '1');
  }
  assert.equal(topicOf(bg), '');
});

test('the target form asks for the secret word the first time notifications are wanted, and makes the topic on Save', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: { autoRefresh: { enabled: true, intervalSeconds: 5 }, rateWarningDismissed: true } }));
  const page = await openDashboard(bg);
  page.row('Lapras').querySelector('.item__target-set').click();
  await settle(20);
  const setup = () => page.row('Lapras').querySelector('.target-form__setup');
  assert.equal(setup().hidden, false);
  assert.match(setup().textContent, /Secret word for your notifications/);
  page.row('Lapras').querySelector('.target-form__notify').click();
  assert.equal(setup().hidden, true, 'not needed without notifications');
  page.row('Lapras').querySelector('.target-form__notify').click();
  page.row('Lapras').querySelector('.target-form__cancel').click();
  await settle(20);

  await page.setTarget('Lapras', { price: 11, word: 'not ok' });
  assert.match(page.row('Lapras').querySelector('.target-form__error').textContent, /cannot be used/);
  assert.equal(page.row('Lapras').querySelector('.target-form__price').value, '11', 'what was typed is still there');
  assert.equal(page.row('Lapras').querySelector('.target-form__word').value, 'not ok');
  assert.equal(targetOf(bg), undefined, 'nothing saved');
  assert.equal(topicOf(bg), '');

  const form = page.row('Lapras').querySelector('form.target-form');
  form.querySelector('.target-form__word').value = 'Eevee';
  fire(page.window, form.querySelector('.target-form__word'), 'input');
  fire(page.window, form, 'submit');
  assert.ok(await until(() => targetOf(bg)));
  const topic = settings(bg).notifications.topic;
  assert.match(topic, /^eevee-[a-z0-9]{5}$/);
  assert.equal(page.row('Lapras').querySelector('.item__target-how').getAttribute('href'), '#settings');
  assert.ok(await until(() => world.ntfy.length === 1), 'the target was already met, and goes to the new topic');
  assert.equal(world.ntfy[0].topic, topic);

  page.row('Meowth').querySelector('.item__target-set').click();
  await settle(20);
  assert.equal(page.row('Meowth').querySelector('.target-form__setup').hidden, true, 'not asked again');
});

test('the first target with notifications brings up a notice pointing at the Settings tab, until dismissed', async () => {
  const bg = await startBackground(fakeWorld(), preset({ settings: ON(600) }));
  const page = await openDashboard(bg);
  const notice = () => page.document.querySelector('.subscribe-notice');
  assert.equal(notice().hidden, true, 'nothing to be notified of yet');

  await page.setTarget('Meowth', { price: 1, notify: false });
  assert.equal(notice().hidden, true, 'a target without notifications does not need it');

  await page.setTarget('Lapras', { price: 5 });
  assert.ok(await until(() => !notice().hidden));
  assert.match(notice().textContent, /One more step to get notifications\. Alerts are sent to your topic lapras-k3x9q, and arrive only on a phone or computer that is subscribed to it\. Open the Settings tab to see how to subscribe/);
  assert.equal(notice().querySelector('a').getAttribute('href'), '#settings');

  const again = await openDashboard(bg);
  assert.equal(again.document.querySelector('.subscribe-notice').hidden, false, 'still there on the next visit');

  again.document.querySelector('.subscribe-notice__dismiss').click();
  assert.ok(await until(() => again.document.querySelector('.subscribe-notice').hidden));
  assert.equal(settings(bg).subscribeNoticeDismissed, true);
  assert.ok(await until(() => notice().hidden), 'and in the other tab');
  await page.setTarget('Meowth', { price: 1, notify: true });
  assert.equal(notice().hidden, true, 'never shown again');
});

test('following the notice to Settings counts as having seen it', async () => {
  const bg = await startBackground(fakeWorld(), preset({ settings: ON(600), targets: { [LAPRAS.key]: TARGET(5) } }));
  const page = await openDashboard(bg);
  assert.equal(page.document.querySelector('.subscribe-notice').hidden, false);
  page.document.querySelector('.subscribe-notice__link').click();
  assert.ok(await until(() => settings(bg).subscribeNoticeDismissed === true));
});

test('the notice also follows a topic made in the target form', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  await page.setTarget('Lapras', { price: 5, word: 'eevee' });
  assert.ok(await until(() => !page.document.querySelector('.subscribe-notice').hidden));
  assert.equal(page.document.querySelector('.subscribe-notice__topic').textContent, topicOf(bg));
  assert.match(topicOf(bg), /^eevee-[a-z0-9]{5}$/);
});

test('a target without notifications needs no secret word', async () => {
  const bg = await startBackground(fakeWorld());
  const page = await openDashboard(bg);
  await page.setTarget('Lapras', { price: 11, notify: false, word: '' });
  assert.ok(targetOf(bg));
  assert.equal(topicOf(bg), '');
});

test('with no topic, a met target sends nothing and stays owed', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: { autoRefresh: { enabled: true, intervalSeconds: 5 }, rateWarningDismissed: true }, targets: { [LAPRAS.key]: TARGET(11) } }));
  await openDashboard(bg);
  assert.ok(await until(() => targetOf(bg).met));
  assert.equal(world.requests.filter((r) => r.url.includes('ntfy')).length, 0);
  assert.equal(targetOf(bg).pending, true);
});

test('the Settings tab shows the topic and where to subscribe to it', async () => {
  const bg = await startBackground(fakeWorld(), preset({ settings: ON(600) }));
  const { document } = await openDashboard(bg, '#settings');
  assert.match(document.title, /Settings/);
  assert.equal(document.querySelector('.settings-topic__name').textContent, 'lapras-k3x9q');
  const link = document.querySelector('.settings-topic__link a');
  assert.equal(link.href, 'https://ntfy.sh/lapras-k3x9q');
  assert.equal(link.target, '_blank');
  assert.match(link.rel, /noopener/);
  assert.match(document.querySelector('.settings-note').textContent, /anyone who knows its name can read/);
  // How to subscribe: on a phone, on a computer, then a test.
  const how = document.querySelector('.settings-how');
  assert.equal(how.hidden, false);
  assert.equal(how.querySelector('h4').textContent, 'How to receive notifications');
  const steps = [...how.querySelectorAll('li')].map((li) => li.textContent);
  assert.equal(steps.length, 3);
  assert.match(steps[0], /^On a phone: install the ntfy app \(Android or iPhone\), press \+, type the topic lapras-k3x9q and press Subscribe\.$/);
  assert.match(steps[1], /^On a computer: open its page, and allow notifications/);
  assert.match(steps[2], /^Check it: press Send test notification/);
  assert.deepEqual([...how.querySelectorAll('a')].map((a) => a.href), [
    'https://play.google.com/store/apps/details?id=io.heckel.ntfy',
    'https://apps.apple.com/us/app/ntfy/id1625396347',
    'https://ntfy.sh/lapras-k3x9q',
  ]);
  for (const a of how.querySelectorAll('a')) { assert.equal(a.target, '_blank'); assert.match(a.rel, /noopener/); }
});

test('Send test notification publishes to the topic and says it was sent', async () => {
  const world = fakeWorld();
  const { document } = await openDashboard(await startBackground(world, preset({ settings: ON(600) })), '#settings');
  [...document.querySelectorAll('.settings-actions button')].find((b) => b.textContent === 'Send test notification').click();
  assert.ok(await until(() => world.ntfy.length === 1));
  assert.equal(world.ntfy[0].topic, 'lapras-k3x9q');
  assert.equal(world.ntfy[0].title, 'TCGPlayer+ test notification');
  assert.ok(await until(() => /^Sent\./.test(document.querySelector('.settings-status').textContent)));
  assert.equal(document.querySelector('.settings-status').getAttribute('data-error'), '0');
});

test('if the test cannot be sent, it says why', async () => {
  const world = fakeWorld({ ntfyStatus: 403 });
  const { document } = await openDashboard(await startBackground(world, preset({ settings: ON(600) })), '#settings');
  [...document.querySelectorAll('.settings-actions button')].find((b) => b.textContent === 'Send test notification').click();
  assert.ok(await until(() => /Could not send \(ntfy responded 403\)/.test(document.querySelector('.settings-status').textContent)));
  assert.equal(document.querySelector('.settings-status').getAttribute('data-error'), '1');
});

test('Change secret word makes a new topic, and notifications go to the new one', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(600) }));
  const { document, window } = await openDashboard(bg, '#settings');
  assert.equal(document.querySelector('.settings-setup').hidden, true);
  button(document, 'Change secret word').click();
  assert.ok(await until(() => !document.querySelector('.settings-setup').hidden));
  assert.equal(button(document, 'Save new topic').type, 'submit');

  button(document, 'Cancel').click();
  assert.ok(await until(() => document.querySelector('.settings-setup').hidden));
  assert.equal(settings(bg).notifications.topic, 'lapras-k3x9q', 'cancelling changes nothing');

  button(document, 'Change secret word').click();
  await until(() => !document.querySelector('.settings-setup').hidden);
  document.querySelector('.settings-setup__word').value = 'eevee';
  fire(window, document.querySelector('.settings-setup'), 'submit');
  assert.ok(await until(() => settings(bg).notifications.topic !== 'lapras-k3x9q'));
  const fresh = settings(bg).notifications.topic;
  assert.match(fresh, /^eevee-[a-z0-9]{5}$/);
  assert.ok(await until(() => document.querySelector('.settings-topic__name').textContent === fresh));
  assert.ok(await until(() => document.querySelector('.settings-setup').hidden));
  assert.deepEqual(settings(bg).autoRefresh, { enabled: true, intervalSeconds: 600 }, 'the other settings are kept');
  button(document, 'Send test notification').click();
  assert.ok(await until(() => world.ntfy.length === 1));
  assert.equal(world.ntfy[0].topic, fresh);
});

test('nothing is sent to ntfy unless a target is met or a test is asked for', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(5) }));
  await openDashboard(bg);
  await openDashboard(bg, '#settings');
  await until(() => world.asked(696683) >= 4);
  assert.equal(world.requests.filter((r) => r.url.includes('ntfy')).length, 0);
});

// ---- no Ask cache ---------------------------------------------------------------------

test('Asks left in storage under the old cache prefix are cleared when the background starts; trends are kept', async () => {
  const local = preset({ 'ls:696683|near mint|holofoil': { storedAt: 1, value: {} }, 'ls:x': 1, 'tr:696683|english|near mint|holofoil': { storedAt: 1, value: {} } });
  await startBackground(fakeWorld(), local);
  await until(() => !Object.keys(local.data).some((k) => k.startsWith('ls:')));
  assert.deepEqual(Object.keys(local.data).filter((k) => /^(ls|tr):/.test(k)), ['tr:696683|english|near mint|holofoil']);
  assert.ok(local.data.lists, 'the lists are untouched');
});

test('no Ask is written to storage', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(5) }));
  await openDashboard(bg);
  await until(() => world.asked(696683) >= 3);
  assert.equal(Object.keys(bg.local.data).some((k) => k.startsWith('ls:')), false);
});


// ---- Firefox asks before anything is sent ------------------------------------------------

test('in Firefox, saving a target with notifications on asks for permission once, then notifications flow', async () => {
  const world = fakeWorld();
  const consent = consentState();
  const bg = await startBackground(world, preset({ settings: ON(5) }));
  const page = await openDashboard(bg, '#lists', { consent });
  await page.setTarget('Lapras', { price: 11 });
  // Compared as text: the object was made in the page's own JavaScript realm.
  assert.equal(JSON.stringify(consent.asked), JSON.stringify([{ data_collection: ['websiteContent'] }]), 'asked for exactly what a notification sends');
  assert.ok(await until(() => world.ntfy.length === 1));
  await page.setTarget('Meowth', { price: 1 });
  assert.equal(consent.asked.length, 2, 'asking again is harmless: Firefox does not prompt for what is already granted');
});

test('in Firefox, nothing is sent until permission has been given, and it is sent once it is', async () => {
  const world = fakeWorld();
  const consent = consentState();
  const bg = await startBackground(world, preset({ settings: ON(5), targets: { [LAPRAS.key]: TARGET(11) } }));
  await openDashboard(bg, '#lists', { consent });
  assert.ok(await until(() => targetOf(bg).met === true && targetOf(bg).pending === true), 'met, and the notification is owed');
  await until(() => world.asked(696683) >= 4);
  assert.equal(world.requests.filter((r) => r.url.includes('ntfy')).length, 0, 'ntfy was not contacted at all');
  assert.deepEqual(consent.asked, [], 'and no prompt appears without a click');
  consent.granted = true;
  assert.ok(await until(() => world.ntfy.length === 1), 'sent on the next refresh after permission');
});

test('in Firefox, if permission is refused the target is still saved and the page says it will not notify', async () => {
  const world = fakeWorld();
  const consent = consentState({ answer: false });
  const bg = await startBackground(world, preset({ settings: ON(5) }));
  const page = await openDashboard(bg, '#lists', { consent });
  await page.setTarget('Lapras', { price: 11 });
  assert.equal(targetOf(bg).price, 11);
  assert.match(page.document.querySelector('#status').textContent, /saved, but Firefox was not given permission/);
  await until(() => world.asked(696683) >= 4);
  assert.equal(world.ntfy.length, 0);
});

test('in Firefox, a target with notifications off never asks', async () => {
  const consent = consentState();
  const bg = await startBackground(fakeWorld(), preset({ settings: ON(600) }));
  const page = await openDashboard(bg, '#lists', { consent });
  await page.setTarget('Lapras', { price: 11, notify: false });
  assert.deepEqual(consent.asked, []);
  assert.equal(targetOf(bg).notify, false);
});

test('in Firefox, Send test notification asks first; refused sends nothing, allowed sends', async () => {
  const world = fakeWorld();
  const consent = consentState({ answer: false });
  const { document } = await openDashboard(await startBackground(world, preset({ settings: ON(600) })), '#settings', { consent });
  const send = [...document.querySelectorAll('.settings-actions button')].find((b) => b.textContent === 'Send test notification');
  send.click();
  assert.ok(await until(() => /not given permission/.test(document.querySelector('.settings-status').textContent)));
  assert.equal(world.requests.filter((r) => r.url.includes('ntfy')).length, 0);
  consent.answer = true;
  send.click();
  assert.ok(await until(() => world.ntfy.length === 1));
  assert.equal(consent.asked.length, 2);
});

test('where the browser has no consent system (Chrome), nothing is asked and notifications just work', async () => {
  const world = fakeWorld();
  const bg = await startBackground(world, preset({ settings: ON(5) }));
  const page = await openDashboard(bg);
  await page.setTarget('Lapras', { price: 11 });
  assert.ok(await until(() => world.ntfy.length === 1));
});

});
