/*
 * TCGPlayer+ — manifest assembly.
 * One shared manifest plus a small overlay per browser: Firefox and Chrome
 * disagree only about how the background is declared and Firefox's add-on settings.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFile } from 'node:fs/promises';

export const TARGETS = ['firefox', 'chrome'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Objects merge key by key; anything else (arrays included) in the overlay replaces the base. */
export function merge(base, overlay) {
  const out = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = isObject(value) && isObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/** The manifest for one browser, from already-parsed base and overlay. */
export function buildManifest(target, { base, overlays }) {
  if (!TARGETS.includes(target)) throw new Error(`Unknown target "${target}" (expected ${TARGETS.join(' or ')})`);
  return merge(base, overlays[target]);
}

/** Reads manifest/base.json and manifest/<target>.json. */
export async function loadManifest(target, dir = 'manifest') {
  const read = async (name) => JSON.parse(await readFile(`${dir}/${name}.json`, 'utf8'));
  const base = await read('base');
  const overlays = { [target]: TARGETS.includes(target) ? await read(target) : undefined };
  return buildManifest(target, { base, overlays });
}
