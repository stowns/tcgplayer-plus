/*
 * TCGPlayer+ — build.
 * Bundles the ES modules into the flat files each manifest points at and writes
 * one unpacked extension per browser: dist/firefox and dist/chrome.
 *
 *   node scripts/build.js [firefox|chrome|all]
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { loadManifest, TARGETS } from './manifest.js';

const arg = process.argv[2] || 'all';
const targets = arg === 'all' ? TARGETS : [arg];
for (const t of targets) {
  if (!TARGETS.includes(t)) {
    console.error(`Unknown target "${t}". Use firefox, chrome or all.`);
    process.exit(1);
  }
}

const STATIC = [
  ['src/content/lists.css', 'content/lists.css'],
  ['src/content/orders.css', 'content/orders.css'],
  ['src/home/home.html', 'home/home.html'],
  ['src/home/home.css', 'home/home.css'],
  ['src/home/lists.css', 'home/lists.css'],
  ['src/home/orders.css', 'home/orders.css'],
  ['src/popup/popup.html', 'popup/popup.html'],
  ['src/popup/popup.css', 'popup/popup.css'],
  ['LICENSE', 'LICENSE'],
];

await rm('dist', { recursive: true, force: true });

for (const target of targets) {
  const out = `dist/${target}`;
  await mkdir(out, { recursive: true });

  await build({
    entryPoints: {
      background: 'src/background.js',
      'content/tcgplayerProduct': 'src/content/tcgplayerProduct.js',
      'content/tcgplayerOrders': 'src/content/tcgplayerOrders.js',
      'home/home': 'src/home/home.js',
      'popup/popup': 'src/popup/popup.js',
    },
    outdir: out,
    bundle: true,
    format: 'iife',
    target: ['firefox142', 'chrome120'],
    legalComments: 'inline',
  });

  await writeFile(`${out}/manifest.json`, `${JSON.stringify(await loadManifest(target), null, 2)}\n`);
  for (const [from, to] of STATIC) await cp(from, `${out}/${to}`);
  await cp('icons', `${out}/icons`, { recursive: true });
  console.log(`built -> ${out}/`);
}
