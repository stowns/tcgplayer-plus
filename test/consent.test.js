import test from 'node:test';
import assert from 'node:assert/strict';
import { needsConsent, hasConsent, requestConsent, NOTIFICATION_DATA, CONSENT_NEEDED } from '../src/lib/consent.js';
import { loadManifest } from '../scripts/manifest.js';

/** A Firefox whose user has (or has not) agreed, and answers the prompt as told. */
function firefox({ granted = false, answer = true, optional = ['websiteContent'] } = {}) {
  const state = { granted, asked: [], checked: [] };
  return {
    state,
    runtime: { getManifest: () => ({ browser_specific_settings: { gecko: { data_collection_permissions: { required: ['none'], optional } } } }) },
    permissions: {
      contains: async (what) => { state.checked.push(what); return state.granted; },
      request: async (what) => { state.asked.push(what); if (answer) state.granted = true; return answer; },
    },
  };
}
const chrome = () => ({ runtime: { getManifest: () => ({ manifest_version: 3, background: { service_worker: 'background.js' } }) } });

test('a notification sends website content, in Firefox\'s terms', () => {
  assert.deepEqual(NOTIFICATION_DATA, ['websiteContent']);
});

test('the built manifests agree: Firefox declares it as optional, Chrome has no such section', async () => {
  const ff = await loadManifest('firefox');
  assert.deepEqual(ff.browser_specific_settings.gecko.data_collection_permissions.optional, ['websiteContent']);
  assert.equal(needsConsent({ runtime: { getManifest: () => ff } }), true);
  assert.equal(needsConsent({ runtime: { getManifest: () => loadManifest } }), false);
  const ch = await loadManifest('chrome');
  assert.equal(needsConsent({ runtime: { getManifest: () => ch } }), false);
});

test('Chrome, and anything without the consent system, needs no consent and is never asked', async () => {
  for (const api of [chrome(), { runtime: {} }, { runtime: { getManifest: () => null } }, { runtime: { getManifest: () => { throw new Error('x'); } } }]) {
    assert.equal(needsConsent(api), false);
    assert.equal(await hasConsent(api), true);
    assert.equal(await requestConsent(api), true);
  }
});

test('a manifest that does not list website content as optional needs no consent step', () => {
  assert.equal(needsConsent(firefox({ optional: [] })), false);
  assert.equal(needsConsent(firefox({ optional: ['technicalAndInteraction'] })), false);
});

test('Firefox before the user has agreed: consent is needed and not yet given', async () => {
  const api = firefox();
  assert.equal(needsConsent(api), true);
  assert.equal(await hasConsent(api), false);
  assert.deepEqual(api.state.checked, [{ data_collection: ['websiteContent'] }]);
  assert.deepEqual(api.state.asked, [], 'checking does not prompt');
});

test('asking shows Firefox\'s prompt for exactly that data, and yes means yes from then on', async () => {
  const api = firefox();
  assert.equal(await requestConsent(api), true);
  assert.deepEqual(api.state.asked, [{ data_collection: ['websiteContent'] }]);
  assert.equal(await hasConsent(api), true);
});

test('a refusal is respected', async () => {
  const api = firefox({ answer: false });
  assert.equal(await requestConsent(api), false);
  assert.equal(await hasConsent(api), false);
});

test('the prompt is requested straight away, before anything is awaited (the browser needs the click)', () => {
  const api = firefox();
  requestConsent(api);
  assert.equal(api.state.asked.length, 1, 'asked synchronously');
});

test('a browser that throws, or rejects, is treated as no', async () => {
  const throws = firefox();
  throws.permissions.request = () => { throw new Error('not allowed'); };
  throws.permissions.contains = () => { throw new Error('not allowed'); };
  assert.equal(await requestConsent(throws), false);
  assert.equal(await hasConsent(throws), false);
  const rejects = firefox();
  rejects.permissions.request = async () => { throw new Error('no gesture'); };
  assert.equal(await requestConsent(rejects), false);
});

test('the message for a missing permission says how to fix it', () => {
  assert.match(CONSENT_NEEDED, /Send test notification/);
});
