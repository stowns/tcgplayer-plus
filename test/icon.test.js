import test from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { readFile, access } from 'node:fs/promises';
import { STRIPES, ICON_SIZES, ICON_VARIANTS, DEFAULT_VARIANT, iconPng, iconSvg, iconPixels } from '../scripts/icon.js';
import { parseBuildArgs } from '../scripts/buildArgs.js';
import { loadManifest, TARGETS } from '../scripts/manifest.js';

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** Decode our own PNGs: 8-bit RGBA, every row unfiltered. */
function decode(png) {
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  let at = 8;
  const chunks = {};
  while (at < png.length) {
    const length = png.readUInt32BE(at);
    chunks[png.toString('ascii', at + 4, at + 8)] = png.subarray(at + 8, at + 8 + length);
    at += 12 + length;
  }
  const width = chunks.IHDR.readUInt32BE(0);
  const height = chunks.IHDR.readUInt32BE(4);
  assert.deepEqual([...chunks.IHDR.subarray(8)], [8, 6, 0, 0, 0]);
  const raw = inflateSync(chunks.IDAT);
  assert.equal(raw.length, height * (width * 4 + 1));
  const pixel = (x, y) => [...raw.subarray(y * (width * 4 + 1) + 1 + x * 4, y * (width * 4 + 1) + 5 + x * 4)];
  return { width, height, pixel, chunks };
}

test('the stripes are the logo\'s colours in the logo\'s order, none of them black or white', () => {
  assert.deepEqual(STRIPES, ['#3CC14E', '#FFBD14', '#0968F6', '#F02D2D', '#FF8806']);
  for (const c of STRIPES) assert.ok(!['#000000', '#ffffff'].includes(c.toLowerCase()), c);
});

test('every size the manifest uses is one we draw, and it is a valid PNG of that size', () => {
  for (const size of ICON_SIZES) {
    const { width, height, chunks } = decode(iconPng(size));
    assert.deepEqual([width, height], [size, size]);
    assert.ok(chunks.IEND, 'ends properly');
  }
});

test('the icon is five equal vertical stripes, left to right', () => {
  const { pixel } = decode(iconPng(100, 'stripes'));
  STRIPES.forEach((colour, i) => {
    const [r, g, b, a] = pixel(i * 20 + 10, 50);
    assert.deepEqual([r, g, b], hex(colour), `stripe ${i + 1}`);
    assert.equal(a, 255);
    assert.deepEqual(pixel(i * 20 + 10, 10).slice(0, 3), hex(colour), 'same colour top to bottom');
  });
});

test('the corners are rounded: transparent at the very corner, solid in the middle', () => {
  const { pixel } = decode(iconPng(128, 'stripes'));
  assert.equal(pixel(0, 0)[3], 0);
  assert.equal(pixel(127, 127)[3], 0);
  assert.equal(pixel(64, 0)[3], 255, 'the straight edge is solid');
  assert.equal(pixel(64, 64)[3], 255);
});

test('even the smallest icon keeps all five stripes distinct', () => {
  const px = iconPixels(16, 'stripes');
  const rowColours = [];
  for (let x = 0; x < 16; x += 1) rowColours.push([...px.subarray((8 * 16 + x) * 4, (8 * 16 + x) * 4 + 3)].join());
  assert.equal(new Set(rowColours).size, 5);
});

test('the SVG draws the same five colours in the same order', () => {
  const svg = iconSvg('stripes');
  assert.deepEqual([...svg.matchAll(/fill="(#[0-9A-F]{6})"/g)].map((m) => m[1]), STRIPES);
});

for (const target of TARGETS) {
  test(`the ${target} build contains every icon its manifest names`, async () => {
    const manifest = await loadManifest(target);
    const named = new Set([...Object.values(manifest.icons), ...Object.values(manifest.action.default_icon)]);
    assert.ok(named.size >= 4);
    for (const file of named) await access(`dist/${target}/${file}`);
    for (const size of ICON_SIZES) assert.ok(Object.hasOwn(manifest.icons, String(size)), `${size}px listed`);
  });
}

test('the home page uses the icon as its page icon, and the files exist in both builds', async () => {
  const html = await readFile('src/home/home.html', 'utf8');
  const links = [...html.matchAll(/<link rel="icon"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(links, ['../icons/icon.svg', '../icons/icon-32.png']);
  for (const target of TARGETS) {
    for (const link of links) await access(`dist/${target}/home/${link}`);
  }
});

// ---- the alternate icon, with a white + in the middle --------------------------

test('there are two variants, and the one with the plus is the default', () => {
  assert.deepEqual(ICON_VARIANTS, ['stripes', 'plus']);
  assert.equal(DEFAULT_VARIANT, 'plus');
  assert.deepEqual(iconPng(48), iconPng(48, 'plus'));
  assert.deepEqual(iconPng(48), iconPng(48, 'not-a-variant'), 'anything unknown is the default');
  assert.notDeepEqual(iconPng(48), iconPng(48, 'stripes'));
});

test('the plain stripes are still available, with no white in them', () => {
  const px = iconPixels(100, 'stripes');
  for (let i = 0; i < px.length; i += 4) {
    assert.equal(px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255 && px[i + 3] === 255, false);
  }
});

test('the plus variant has a white plus in the centre and the same stripes elsewhere', () => {
  const plain = decode(iconPng(100, 'stripes'));
  const plus = decode(iconPng(100, 'plus'));
  assert.deepEqual(plus.pixel(50, 50), [255, 255, 255, 255], 'centre');
  assert.deepEqual(plus.pixel(50, 28), [255, 255, 255, 255], 'top arm');
  assert.deepEqual(plus.pixel(50, 72), [255, 255, 255, 255], 'bottom arm');
  assert.deepEqual(plus.pixel(28, 50), [255, 255, 255, 255], 'left arm');
  assert.deepEqual(plus.pixel(72, 50), [255, 255, 255, 255], 'right arm');
  for (const [x, y] of [[10, 10], [90, 10], [10, 90], [90, 90], [30, 30], [70, 70], [30, 70], [70, 30]]) {
    assert.deepEqual(plus.pixel(x, y), plain.pixel(x, y), `(${x}, ${y}) is untouched`);
  }
});

test('the plus is centred and symmetric, whatever the size', () => {
  for (const size of ICON_SIZES) {
    const { pixel } = decode(iconPng(size, 'plus'));
    const white = (x, y) => pixel(x, y).slice(0, 3).every((c) => c === 255);
    for (let i = 0; i < size; i += 1) {
      for (let j = 0; j < size; j += 1) {
        assert.equal(white(i, j), white(size - 1 - i, j), `${size}px mirrored left-right at ${i},${j}`);
        assert.equal(white(i, j), white(i, size - 1 - j), `${size}px mirrored top-bottom at ${i},${j}`);
        assert.equal(white(i, j), white(j, i), `${size}px the arms are the same length`);
      }
    }
    assert.equal(white(Math.floor(size / 2), Math.floor(size / 2)), true, `${size}px has a white centre`);
  }
});

test('the plus still shows at the smallest size', () => {
  const px = iconPixels(16, 'plus');
  const whites = [];
  for (let i = 0; i < px.length; i += 4) if (px[i] === 255 && px[i + 1] === 255 && px[i + 2] === 255 && px[i + 3] === 255) whites.push(i);
  assert.ok(whites.length >= 20, `${whites.length} white pixels`);
});

test('the plus variant keeps the rounded corners', () => {
  const { pixel } = decode(iconPng(128, 'plus'));
  assert.equal(pixel(0, 0)[3], 0);
  assert.equal(pixel(127, 0)[3], 0);
});

test('the plus SVG is the stripes with two white bars over them', () => {
  const svg = iconSvg('plus');
  assert.deepEqual([...svg.matchAll(/fill="(#[0-9A-F]{6})"/g)].map((m) => m[1]), [...STRIPES, '#FFFFFF', '#FFFFFF']);
  assert.equal(iconSvg(), svg);
  assert.doesNotMatch(iconSvg('stripes'), /FFFFFF/);
});

test('the build command takes a target and an icon, with sensible defaults', () => {
  assert.deepEqual(parseBuildArgs([]), { targets: ['firefox', 'chrome'], icon: 'plus' });
  assert.deepEqual(parseBuildArgs(['chrome']), { targets: ['chrome'], icon: 'plus' });
  assert.deepEqual(parseBuildArgs(['all', '--icon=stripes']), { targets: ['firefox', 'chrome'], icon: 'stripes' });
  assert.deepEqual(parseBuildArgs(['--icon=stripes', 'firefox']), { targets: ['firefox'], icon: 'stripes' });
});

test('the build command refuses what it does not know', () => {
  assert.throws(() => parseBuildArgs(['safari']), /Unknown target "safari"/);
  assert.throws(() => parseBuildArgs(['--icon=neon']), /Unknown icon "neon"\. Use stripes or plus/);
  assert.throws(() => parseBuildArgs(['--fast']), /Unknown option "--fast"/);
});
