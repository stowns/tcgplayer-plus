/*
 * TCGPlayer+ — build.
 * Bundles the ES modules into the flat files the manifest points at.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';

const OUT = 'dist';

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await build({
  entryPoints: {
    background: 'src/background.js',
    'content/tcgplayerProduct': 'src/content/tcgplayerProduct.js',
    'content/tcgplayerOrders': 'src/content/tcgplayerOrders.js',
    'home/home': 'src/home/home.js',
    'popup/popup': 'src/popup/popup.js',
  },
  outdir: OUT,
  bundle: true,
  format: 'iife',
  target: ['firefox142'],
  legalComments: 'inline',
});

await cp('manifest.json', `${OUT}/manifest.json`);
await cp('src/content/lists.css', `${OUT}/content/lists.css`);
await cp('src/content/orders.css', `${OUT}/content/orders.css`);
await cp('src/home/home.html', `${OUT}/home/home.html`);
await cp('src/home/home.css', `${OUT}/home/home.css`);
await cp('src/home/lists.css', `${OUT}/home/lists.css`);
await cp('src/home/orders.css', `${OUT}/home/orders.css`);
await cp('src/popup/popup.html', `${OUT}/popup/popup.html`);
await cp('src/popup/popup.css', `${OUT}/popup/popup.css`);
await cp('icons', `${OUT}/icons`, { recursive: true });
await cp('LICENSE', `${OUT}/LICENSE`);

console.log(`built -> ${OUT}/`);
