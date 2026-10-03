/*
 * TCGPlayer+ — the extension icon: vertical stripes in the colours of the
 * TCGplayer logo mark, left to right in the order they appear there (green,
 * yellow, blue, red, orange), with a white + in the middle. Drawn from this one
 * definition, as PNGs for the toolbar and the store, and as an SVG for the page
 * icon. The plain stripes without the + are kept as the `stripes` variant.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { deflateSync } from 'node:zlib';

export const STRIPES = ['#3CC14E', '#FFBD14', '#0968F6', '#F02D2D', '#FF8806'];
export const ICON_SIZES = [16, 32, 48, 96, 128];

/** `plus` (the default) is the logo colours with a white + in the middle; `stripes` is the colours alone. */
export const ICON_VARIANTS = ['stripes', 'plus'];
export const DEFAULT_VARIANT = 'plus';

/** The plus, in 0..100 icon units: arms this thick, and this long end to end, centred. */
const PLUS = { thickness: 17, length: 58 };

/** How round the corners are, as a fraction of the icon's width. */
const CORNER = 0.2;

const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

const variantOf = (variant) => (ICON_VARIANTS.includes(variant) ? variant : DEFAULT_VARIANT);

export function iconSvg(variant = DEFAULT_VARIANT) {
  const width = 100 / STRIPES.length;
  const bars = STRIPES.map((c, i) => `<rect x="${i * width}" width="${width}" height="100" fill="${c}"/>`).join('');
  let plus = '';
  if (variantOf(variant) === 'plus') {
    const { thickness, length } = PLUS;
    const near = (100 - length) / 2;
    const arm = (100 - thickness) / 2;
    plus = `<rect x="${near}" y="${arm}" width="${length}" height="${thickness}" fill="#FFFFFF"/><rect x="${arm}" y="${near}" width="${thickness}" height="${length}" fill="#FFFFFF"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><clipPath id="r"><rect width="100" height="100" rx="${CORNER * 100}"/></clipPath><g clip-path="url(#r)">${bars}</g>${plus}</svg>\n`;
}

/** Is the point (x, y), in 0..size, on the plus? */
function onPlus(x, y, size) {
  const unit = size / 100;
  const half = (PLUS.length / 2) * unit;
  const arm = (PLUS.thickness / 2) * unit;
  const dx = Math.abs(x - size / 2);
  const dy = Math.abs(y - size / 2);
  return (dx <= half && dy <= arm) || (dy <= half && dx <= arm);
}

/** Is the point (x, y), in 0..size, inside the rounded square? */
function inside(x, y, size) {
  const r = CORNER * size;
  const dx = Math.max(r - x, x - (size - r), 0);
  const dy = Math.max(r - y, y - (size - r), 0);
  return dx * dx + dy * dy <= r * r;
}

/** RGBA pixels, row by row, edges smoothed by sampling each pixel 4 x 4 times. */
export function iconPixels(size, variant = DEFAULT_VARIANT) {
  const withPlus = variantOf(variant) === 'plus';
  const colours = STRIPES.map(rgb);
  const out = Buffer.alloc(size * size * 4);
  const N = 4;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let covered = 0;
      let white = 0;
      for (let sy = 0; sy < N; sy += 1) {
        for (let sx = 0; sx < N; sx += 1) {
          const x = px + (sx + 0.5) / N;
          const y = py + (sy + 0.5) / N;
          if (inside(x, y, size)) {
            covered += 1;
            if (withPlus && onPlus(x, y, size)) white += 1;
          }
        }
      }
      const stripe = Math.min(STRIPES.length - 1, Math.floor(((px + 0.5) / size) * STRIPES.length));
      const at = (py * size + px) * 4;
      // The plus is blended over the stripe by how much of the pixel it covers.
      const mix = covered ? white / covered : 0;
      out.set(colours[stripe].map((c) => Math.round(c + (255 - c) * mix)), at);
      out[at + 3] = Math.round((covered / (N * N)) * 255);
    }
  }
  return out;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A PNG file (8-bit RGBA) of the icon at `size` pixels square, in one of the ICON_VARIANTS. */
export function iconPng(size, variant = DEFAULT_VARIANT) {
  const pixels = iconPixels(size, variant);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    const from = y * size * 4;
    pixels.copy(rows, y * (size * 4 + 1) + 1, from, from + size * 4); // filter byte 0 = none
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit, RGBA, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
