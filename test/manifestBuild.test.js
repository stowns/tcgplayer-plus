import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { merge, buildManifest, loadManifest, TARGETS } from '../scripts/manifest.js';

const manifests = Object.fromEntries(await Promise.all(TARGETS.map(async (t) => [t, await loadManifest(t)])));
const { firefox, chrome } = manifests;

test('merge combines objects key by key and lets an overlay replace arrays and values', () => {
  const base = { a: { x: 1, y: [1, 2] }, b: 'base', c: 1 };
  assert.deepEqual(merge(base, { a: { y: [9] }, b: 'over' }), { a: { x: 1, y: [9] }, b: 'over', c: 1 });
  assert.deepEqual(base, { a: { x: 1, y: [1, 2] }, b: 'base', c: 1 }, 'inputs are left alone');
});

test('an unknown target is refused', () => {
  assert.throws(() => buildManifest('safari', { base: {}, overlays: {} }), /Unknown target "safari"/);
});

test('both manifests are the TCGPlayer+ extension', () => {
  for (const m of Object.values(manifests)) {
    assert.equal(m.manifest_version, 3);
    assert.equal(m.name, 'TCGPlayer+');
    assert.equal(m.action.default_title, 'TCGPlayer+');
  }
});

test('everything but the background and browser settings is shared', () => {
  const strip = ({ background, browser_specific_settings, minimum_chrome_version, ...rest }) => rest;
  assert.deepEqual(strip(firefox), strip(chrome));
});

test('the only permission asked for is storage', () => {
  for (const m of Object.values(manifests)) assert.deepEqual(m.permissions, ['storage']);
});

test('only TCGplayer sites are asked for', () => {
  for (const m of Object.values(manifests)) {
    const hosts = [...m.host_permissions, ...m.content_scripts.flatMap((c) => c.matches)];
    assert.ok(hosts.length > 0);
    for (const h of hosts) assert.match(h, /^https:\/\/[a-z-]*\.?tcgplayer\.com\//, h);
  }
});

test('Firefox runs a background script and carries its add-on ID', () => {
  assert.deepEqual(firefox.background, { scripts: ['background.js'] });
  assert.equal(firefox.browser_specific_settings.gecko.id, 'tcgplayer-plus@simontownsend');
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, '142.0');
  assert.equal(firefox.minimum_chrome_version, undefined);
});

test('Chrome runs a service worker and has no Firefox-only settings', () => {
  assert.deepEqual(chrome.background, { service_worker: 'background.js' });
  assert.equal(chrome.minimum_chrome_version, '120');
  assert.equal(chrome.browser_specific_settings, undefined);
});

for (const target of TARGETS) {
  test(`every file the ${target} manifest points at is built`, async () => {
    const m = manifests[target];
    const files = [
      m.background.scripts || m.background.service_worker,
      m.content_scripts.flatMap((c) => [...c.js, ...(c.css || [])]),
      Object.values(m.icons), Object.values(m.action.default_icon),
    ].flat();
    for (const f of files) await access(`dist/${target}/${f}`);
  });
}

test('the toolbar button has no popup, so a click reaches the background', () => {
  for (const m of Object.values(manifests)) {
    assert.equal(m.action.default_popup, undefined);
    assert.equal(m.action.default_title, 'TCGPlayer+');
    assert.ok(m.action.default_icon, 'it still has its icon');
  }
});
