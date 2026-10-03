import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseProblems, archiveName, sourceFiles, LIMITS, SOURCE_EXCLUDED } from '../scripts/release.js';
import { loadManifest, TARGETS } from '../scripts/manifest.js';
import { readFile } from 'node:fs/promises';

const pkg = { version: '1.0.0' };
const good = {
  name: 'TCGPlayer+', description: 'Short and fine.', version: '1.0.0',
  icons: { 16: 'a', 32: 'b', 48: 'c', 96: 'd', 128: 'e' },
};

test('a good manifest has no problems', () => {
  assert.deepEqual(releaseProblems({ manifest: good, pkg }), []);
});

test('the real manifests, for both stores, are ready to upload', async () => {
  const real = JSON.parse(await readFile('package.json', 'utf8'));
  for (const target of TARGETS) {
    assert.deepEqual(releaseProblems({ manifest: await loadManifest(target), pkg: real }), [], target);
  }
});

test('a description over Chrome\'s limit is reported with its length', () => {
  const long = 'x'.repeat(LIMITS.descriptionChars + 1);
  const [problem] = releaseProblems({ manifest: { ...good, description: long }, pkg });
  assert.match(problem, /133 characters; Chrome allows 132/);
  assert.deepEqual(releaseProblems({ manifest: { ...good, description: 'x'.repeat(132) }, pkg }), []);
});

test('a name that is too long, or missing, is reported', () => {
  assert.match(releaseProblems({ manifest: { ...good, name: 'n'.repeat(46) }, pkg })[0], /name is 46 characters/);
  assert.match(releaseProblems({ manifest: { ...good, name: '' }, pkg })[0], /no name/);
  assert.match(releaseProblems({ manifest: { ...good, description: '' }, pkg })[0], /no description/);
});

test('a version both stores would refuse is reported', () => {
  for (const version of ['', '1', '1.0.0.0.0', 'v1.0', '1.0-beta', '1..0']) {
    const problems = releaseProblems({ manifest: { ...good, version }, pkg: { version } });
    if (version === '1') assert.deepEqual(problems, [], 'a single number is allowed');
    else assert.match(problems.join(' '), /not 1 to 4 dot-separated numbers/, version);
  }
});

test('a manifest version that differs from package.json is reported', () => {
  assert.match(releaseProblems({ manifest: { ...good, version: '1.0.1' }, pkg })[0], /1\.0\.1 does not match package\.json \(1\.0\.0\)/);
});

test('every icon size the stores want must be present', () => {
  const { 128: _gone, ...without } = good.icons;
  assert.deepEqual(releaseProblems({ manifest: { ...good, icons: without }, pkg }), ['The manifest has no 128 px icon.']);
  assert.equal(releaseProblems({ manifest: { ...good, icons: undefined }, pkg }).length, 5);
});

test('every problem is reported at once, not just the first', () => {
  const problems = releaseProblems({ manifest: { name: '', version: 'x', icons: {} }, pkg });
  assert.ok(problems.length >= 4);
  assert.deepEqual(releaseProblems({ manifest: undefined, pkg }).length > 0, true);
});

test('archives are named by version and what they are for', () => {
  assert.equal(archiveName('1.2.3', 'firefox'), 'tcgplayer-plus-1.2.3-firefox.zip');
  assert.equal(archiveName('1.2.3', 'chrome'), 'tcgplayer-plus-1.2.3-chrome.zip');
  assert.equal(archiveName('1.2.3', 'source'), 'tcgplayer-plus-1.2.3-source.zip');
});

test('the source archive never contains saved pages of real orders, build output, or other junk', () => {
  const paths = [
    'src/background.js', 'README.md', 'package.json', 'test/fixtures/orderHistory.js',
    'store/screenshots/01.png', 'examples/orderhistory/Order History.html', 'examples/orderhistory/Order History_files/x.js', 'examples',
    'dist/firefox/manifest.json', 'release/a.zip', 'node_modules/esbuild/x.js', '.git/config',
    'src/.DS_Store', '.DS_Store', 'tcgplayer-plus-firefox.zip', '', 'scripts/package.js',
  ];
  assert.deepEqual(sourceFiles(paths), ['src/background.js', 'README.md', 'package.json', 'test/fixtures/orderHistory.js', 'scripts/package.js']);
  assert.ok(SOURCE_EXCLUDED.includes('examples/'));
});

test('a path that merely starts with an excluded name is kept', () => {
  assert.deepEqual(sourceFiles(['examples-of-things.md', 'distance.js', 'src/examples/a.js']), ['examples-of-things.md', 'distance.js', 'src/examples/a.js']);
});
