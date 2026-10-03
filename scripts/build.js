/*
 * TCGPlayer+ — build.
 * Bundles the ES modules into the flat files each manifest points at and writes
 * one unpacked extension per browser: dist/firefox and dist/chrome.
 *
 *   node scripts/build.js [firefox|chrome|all] [--icon=plus|stripes]
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { build } from 'esbuild';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { loadManifest } from './manifest.js';
import { parseBuildArgs } from './buildArgs.js';
import { iconPng, iconSvg, ICON_SIZES } from './icon.js';

let options;
try {
  options = parseBuildArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const { targets, icon } = options;

const STATIC = [
  ['src/content/lists.css', 'content/lists.css'],
  ['src/content/orders.css', 'content/orders.css'],
  ['src/home/home.html', 'home/home.html'],
  ['src/home/home.css', 'home/home.css'],
  ['src/home/lists.css', 'home/lists.css'],
  ['src/home/orders.css', 'home/orders.css'],
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
    },
    outdir: out,
    bundle: true,
    format: 'iife',
    target: ['firefox142', 'chrome120'],
    legalComments: 'inline',
  });

  await writeFile(`${out}/manifest.json`, `${JSON.stringify(await loadManifest(target), null, 2)}\n`);
  for (const [from, to] of STATIC) await cp(from, `${out}/${to}`);
  await mkdir(`${out}/icons`, { recursive: true });
  for (const size of ICON_SIZES) await writeFile(`${out}/icons/icon-${size}.png`, iconPng(size, icon));
  await writeFile(`${out}/icons/icon.svg`, iconSvg(icon));
  console.log(`built -> ${out}/ (${icon} icon)`);
}
