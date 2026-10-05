import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_KEY, MIN_INTERVAL_SECONDS, DEFAULT_INTERVAL_SECONDS, RATE_WARNING_BELOW_SECONDS, MAX_INTERVAL_SECONDS,
  defaultSettings, sanitizeSettings, clampInterval, isValidTopic, newTopic, parseSecretWord, randomCode, hasTopic, createTopic, shouldShowSubscribeNotice, toggleTrendDuration,
  loadSettings, saveSettings, updateSettings, shouldWarnAboutRate,
} from '../src/lib/settings.js';

function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    writes: 0,
    async get(key) { return key in data ? { [key]: data[key] } : {}; },
    async set(items) { this.writes += 1; Object.assign(data, items); },
  };
}

test('auto-refresh is off by default, at ten minutes once enabled', () => {
  const s = defaultSettings();
  assert.equal(s.autoRefresh.enabled, false);
  assert.equal(s.autoRefresh.intervalSeconds, 600);
  assert.equal(DEFAULT_INTERVAL_SECONDS, 600);
  assert.equal(s.rateWarningDismissed, false);
  assert.equal(s.notifications.topic, '');
});

test('the interval is whole seconds, at least five, at most a day', () => {
  assert.equal(MIN_INTERVAL_SECONDS, 5);
  assert.equal(clampInterval(90), 90);
  assert.equal(clampInterval('45'), 45);
  assert.equal(clampInterval(12.9), 12, 'whole seconds');
  assert.equal(clampInterval(1), 5);
  assert.equal(clampInterval(0), 5);
  assert.equal(clampInterval(-30), 5);
  assert.equal(clampInterval(10 ** 9), MAX_INTERVAL_SECONDS);
  for (const bad of ['', 'soon', null, undefined, NaN, {}]) assert.equal(clampInterval(bad), 600, `unreadable (${String(bad)}) is the default`);
});

test('damaged settings are repaired to something that works', () => {
  for (const junk of [null, undefined, 'x', 7, [], { autoRefresh: 'yes' }, { notifications: 5 }]) {
    assert.deepEqual(sanitizeSettings(junk), defaultSettings(), JSON.stringify(junk));
  }
  const repaired = sanitizeSettings({ autoRefresh: { enabled: 'true', intervalSeconds: 2 }, rateWarningDismissed: 1, notifications: { topic: 'has spaces' } });
  assert.equal(repaired.autoRefresh.enabled, false, 'only a real true turns it on');
  assert.equal(repaired.autoRefresh.intervalSeconds, 5);
  assert.equal(repaired.rateWarningDismissed, false);
  assert.equal(repaired.notifications.topic, '');
});

test('good settings pass through unchanged, and nothing else is kept', () => {
  const good = { autoRefresh: { enabled: true, intervalSeconds: 120 }, rateWarningDismissed: true, subscribeNoticeDismissed: true, trendDurations: [14, 1], notifications: { topic: 'tcgplayer-plus-abc' } };
  assert.deepEqual(sanitizeSettings({ ...good, extra: 'x', autoRefresh: { ...good.autoRefresh, junk: 1 } }), good);
});

test('a topic is ntfy-safe: letters, digits, dashes and underscores, up to 64', () => {
  assert.equal(isValidTopic('tcgplayer-plus-0b9f3c1e-6a53-4d0e-9a3b-7a0f6b1d2c33'), true);
  assert.equal(isValidTopic('a_b-C9'), true);
  for (const bad of ['', 'has space', 'slash/inside', 'dot.inside', 'ü', 'x'.repeat(65), null, 5]) assert.equal(isValidTopic(bad), false, String(bad));
});

test('a secret word is trimmed and lower-cased; anything but 3 to 24 letters or digits is refused', () => {
  assert.deepEqual(parseSecretWord('  Lapras '), { ok: true, word: 'lapras' });
  assert.deepEqual(parseSecretWord('abc'), { ok: true, word: 'abc' });
  assert.deepEqual(parseSecretWord('a'.repeat(24)), { ok: true, word: 'a'.repeat(24) });
  for (const empty of ['', '   ', null, undefined, 5]) {
    const r = parseSecretWord(empty);
    assert.equal(r.ok, false);
    assert.match(r.error, /^Choose a secret word/);
  }
  for (const bad of ['ab', 'a'.repeat(25), 'two words', 'dash-ed', 'under_score', 'pokémon', 'a/b', '<b>x</b>']) {
    const r = parseSecretWord(bad);
    assert.equal(r.ok, false, bad);
    assert.match(r.error, /cannot be used\. Use 3 to 24 letters or digits, with no spaces\./);
  }
});

test('the code is five lower-case letters and digits, drawn evenly from the random bytes', () => {
  for (let i = 0; i < 200; i += 1) assert.match(randomCode(), /^[a-z0-9]{5}$/);
  assert.notEqual(randomCode(), randomCode());
  // 0 -> a, 25 -> z, 26 -> 0, 35 -> 9, 36 -> a again.
  const fixed = (values) => (bytes) => { bytes.set(values.slice(0, bytes.length)); return bytes; };
  assert.equal(randomCode(fixed([0, 25, 26, 35, 36, 1, 1, 1, 1, 1])), 'az09a');
  // 252 and above would favour the first letters, so they are skipped.
  assert.equal(randomCode(fixed([252, 255, 0, 1, 2, 3, 4, 5, 5, 5])), 'abcde');
  // Too few usable bytes in one draw: it draws again rather than returning a short code.
  let draws = 0;
  const stingy = (bytes) => { draws += 1; bytes.fill(255); bytes[0] = draws; return bytes; };
  assert.equal(randomCode(stingy), 'bcdef');
  assert.equal(draws, 5);
});

test('a topic is the secret word, a dash and the code, and valid for ntfy', () => {
  assert.equal(newTopic('Lapras', 'k3x9q'), 'lapras-k3x9q');
  assert.equal(isValidTopic(newTopic('a'.repeat(24), 'k3x9q')), true);
  assert.match(newTopic('lapras'), /^lapras-[a-z0-9]{5}$/);
  assert.notEqual(newTopic('lapras'), newTopic('lapras'), 'the same word gives different topics');
  assert.throws(() => newTopic('no good'), /cannot be used/);
  assert.throws(() => newTopic(''), /Choose a secret word/);
});

test('settings are stored under one key and read back repaired', async () => {
  const storage = memoryStorage({ [SETTINGS_KEY]: { autoRefresh: { enabled: true, intervalSeconds: 1 } } });
  const loaded = await loadSettings(storage);
  assert.equal(loaded.autoRefresh.intervalSeconds, 5);
  assert.deepEqual(await loadSettings(memoryStorage()), defaultSettings());
  await saveSettings(storage, { ...loaded, rateWarningDismissed: true });
  assert.equal(storage.data.settings.rateWarningDismissed, true);
});

test('updateSettings reads, changes and writes', async () => {
  const storage = memoryStorage();
  const next = await updateSettings(storage, (s) => ({ ...s, autoRefresh: { enabled: true, intervalSeconds: 30 } }));
  assert.deepEqual(next.autoRefresh, { enabled: true, intervalSeconds: 30 });
  assert.deepEqual(storage.data.settings.autoRefresh, { enabled: true, intervalSeconds: 30 });
});

test('no topic exists until a secret word is given', async () => {
  const storage = memoryStorage();
  assert.equal(hasTopic(await loadSettings(storage)), false);
  assert.equal(hasTopic(null), false);
  const made = await createTopic(storage, 'Lapras', 'k3x9q');
  assert.equal(made.notifications.topic, 'lapras-k3x9q');
  assert.equal(hasTopic(made), true);
  assert.equal((await loadSettings(storage)).notifications.topic, 'lapras-k3x9q', 'kept');
});

test('making the topic keeps the other settings, and a new word replaces the topic', async () => {
  const storage = memoryStorage({ settings: { autoRefresh: { enabled: true, intervalSeconds: 60 }, rateWarningDismissed: true } });
  const s = await createTopic(storage, 'lapras', 'k3x9q');
  assert.deepEqual(s.autoRefresh, { enabled: true, intervalSeconds: 60 });
  assert.equal(s.rateWarningDismissed, true);
  assert.equal((await createTopic(storage, 'eevee', 'aaaaa')).notifications.topic, 'eevee-aaaaa');
});

test('a word that cannot be used makes no topic and writes nothing', async () => {
  const storage = memoryStorage();
  await assert.rejects(createTopic(storage, 'no good'), /cannot be used/);
  assert.equal(storage.writes, 0);
});

test('the rate warning shows only when refreshing faster than ten minutes, and never once dismissed', () => {
  assert.equal(RATE_WARNING_BELOW_SECONDS, 600);
  const at = (enabled, intervalSeconds, rateWarningDismissed = false) => shouldWarnAboutRate({ ...defaultSettings(), autoRefresh: { enabled, intervalSeconds }, rateWarningDismissed });
  assert.equal(at(true, 599), true);
  assert.equal(at(true, 5), true);
  assert.equal(at(true, 600), false, 'ten minutes is fine');
  assert.equal(at(true, 3600), false);
  assert.equal(at(false, 30), false, 'nothing is refreshing');
  assert.equal(at(true, 30, true), false, 'already dismissed');
});

test('the subscribe notice shows once a target asks for notifications, until it is dismissed', () => {
  const withTopic = { ...defaultSettings(), notifications: { topic: 'lapras-k3x9q' } };
  const wants = { 'a:english': { price: 5, notify: true } };
  assert.equal(defaultSettings().subscribeNoticeDismissed, false);
  assert.equal(shouldShowSubscribeNotice(withTopic, wants), true);
  assert.equal(shouldShowSubscribeNotice(withTopic, { 'a:english': { price: 5, notify: false } }), false, 'nobody wants a notification');
  assert.equal(shouldShowSubscribeNotice(withTopic, {}), false);
  assert.equal(shouldShowSubscribeNotice(withTopic, null), false);
  assert.equal(shouldShowSubscribeNotice(defaultSettings(), wants), false, 'no topic to subscribe to yet');
  assert.equal(shouldShowSubscribeNotice({ ...withTopic, subscribeNoticeDismissed: true }, wants), false);
  assert.equal(sanitizeSettings({ subscribeNoticeDismissed: true }).subscribeNoticeDismissed, true);
  assert.equal(sanitizeSettings({ subscribeNoticeDismissed: 'yes' }).subscribeNoticeDismissed, false);
});

test('the 7-day trend is shown by default, and a damaged choice is repaired to it', () => {
  assert.deepEqual(defaultSettings().trendDurations, [7]);
  assert.deepEqual(sanitizeSettings({}).trendDurations, [7]);
  assert.deepEqual(sanitizeSettings({ trendDurations: [1, 7, 7, 99, 'x'] }).trendDurations, [7, 1]);
  for (const bad of [[], 'all', null, [0]]) assert.deepEqual(sanitizeSettings({ trendDurations: bad }).trendDurations, [7]);
});

test('a trend duration can be added and removed, but never the last one', () => {
  let s = defaultSettings();
  s = toggleTrendDuration(s, 1, true);
  assert.deepEqual(s.trendDurations, [7, 1]);
  s = toggleTrendDuration(s, 14, true);
  assert.deepEqual(s.trendDurations, [14, 7, 1], 'longest first');
  s = toggleTrendDuration(s, 14, true);
  assert.deepEqual(s.trendDurations, [14, 7, 1], 'not twice');
  s = toggleTrendDuration(toggleTrendDuration(s, 14, false), 7, false);
  assert.deepEqual(s.trendDurations, [1]);
  assert.deepEqual(toggleTrendDuration(s, 1, false).trendDurations, [1], 'the last one stays');
  assert.deepEqual(toggleTrendDuration(s, 30, true).trendDurations, [1], 'not a duration on offer');
  assert.deepEqual(toggleTrendDuration(s, 3, true).autoRefresh, s.autoRefresh, 'the rest is untouched');
});
