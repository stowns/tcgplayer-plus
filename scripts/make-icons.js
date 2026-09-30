/*
 * TCGPlayer+ — generates the toolbar icons.
 * Drawn from scratch here so the repo carries no third-party artwork.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const GREEN = [22, 163, 74];
const WHITE = [255, 255, 255];

function crc32(buf) {
  let c;
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixel) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y += 1) {
    raw[o] = 0; // no filter
    o += 1;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y, size);
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; raw[o + 3] = a;
      o += 4;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Rounded green tile with a white "good value" up-arrow. */
function icon(x, y, size) {
  const u = (v) => v / size;
  const radius = 0.22;
  const px = u(x + 0.5);
  const py = u(y + 0.5);

  // Rounded-square mask.
  const dx = Math.max(Math.abs(px - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(py - 0.5) - (0.5 - radius), 0);
  if (Math.hypot(dx, dy) > radius) return [0, 0, 0, 0];

  // Arrow head: triangle pointing up.
  const inHead = py >= 0.24 && py <= 0.5 && Math.abs(px - 0.5) <= (py - 0.24) * 1.35;
  // Arrow stem.
  const inStem = py > 0.46 && py <= 0.76 && Math.abs(px - 0.5) <= 0.1;
  const [r, g, b] = inHead || inStem ? WHITE : GREEN;
  return [r, g, b, 255];
}

mkdirSync('icons', { recursive: true });
for (const size of [48, 96]) {
  writeFileSync(`icons/icon-${size}.png`, png(size, icon));
}
console.log('wrote icons/icon-48.png icons/icon-96.png');
