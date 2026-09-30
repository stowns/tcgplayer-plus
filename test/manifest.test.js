import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));

test('the extension is TCGPlayer+', () => {
  assert.equal(manifest.name, 'TCGPlayer+');
  assert.equal(manifest.action.default_title, 'TCGPlayer+');
});

test('its ID is tcgplayer-plus@simontownsend', () => {
  assert.equal(manifest.browser_specific_settings.gecko.id, 'tcgplayer-plus@simontownsend');
});

test('it asks for TCGplayer sites only', () => {
  const hosts = [...manifest.host_permissions, ...manifest.content_scripts.flatMap((c) => c.matches)];
  assert.ok(hosts.length > 0);
  for (const h of hosts) assert.match(h, /^https:\/\/[a-z-]*\.?tcgplayer\.com\//, h);
});

test('every file the manifest points at is built', async () => {
  const { access } = await import('node:fs/promises');
  const files = [
    manifest.background.scripts, manifest.action.default_popup,
    manifest.content_scripts.flatMap((c) => [...c.js, ...(c.css || [])]),
    Object.values(manifest.icons),
  ].flat();
  for (const f of files) await access(`dist/${f}`);
});

test('the only stored data permission is storage', () => {
  assert.deepEqual(manifest.permissions, ['storage']);
});
