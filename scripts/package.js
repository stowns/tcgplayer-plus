/*
 * TCGPlayer+ — package for the stores.
 *
 *   node scripts/package.js [firefox|chrome|all] [--icon=plus|stripes]
 *
 * Builds, checks each manifest against what the stores require, and writes to
 * release/:
 *   tcgplayer-plus-<version>-chrome.zip    upload to the Chrome Web Store
 *   tcgplayer-plus-<version>-firefox.zip   upload to addons.mozilla.org
 *   tcgplayer-plus-<version>-source.zip    also uploaded to addons.mozilla.org, which
 *                                          requires the source of anything that is bundled
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from 'node:child_process';
import { readFile, rm, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseBuildArgs } from './buildArgs.js';
import { loadManifest } from './manifest.js';
import { releaseProblems, archiveName, sourceFiles } from './release.js';

const OUT = 'release';

let options;
try {
  options = parseBuildArgs(process.argv.slice(2));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
const { targets, icon } = options;

const run = (command, args, opts = {}) => execFileSync(command, args, { stdio: 'inherit', ...opts });

const pkg = JSON.parse(await readFile('package.json', 'utf8'));

// Check every manifest before building anything, so a problem is reported at once.
let failed = false;
for (const target of targets) {
  for (const problem of releaseProblems({ manifest: await loadManifest(target), pkg })) {
    console.error(`${target}: ${problem}`);
    failed = true;
  }
}
if (failed) process.exit(1);

run('node', ['scripts/build.js', targets.length === 1 ? targets[0] : 'all', `--icon=${icon}`]);

await mkdir(OUT, { recursive: true });
const made = [];

// zip adds to an archive that already exists, so each one is removed first; other archives are left alone.
const fresh = async (file) => { await rm(file, { force: true }); return file; };

for (const target of targets) {
  const file = await fresh(path.resolve(OUT, archiveName(pkg.version, target)));
  // The manifest must be at the top of the zip, so zip from inside the build folder.
  run('zip', ['-qr', '-X', file, '.', '-x', '*.DS_Store'], { cwd: `dist/${target}` });
  made.push(file);
}

// Mozilla reviews the source of bundled code: the repository's files, less anything that
// must not be published (see SOURCE_EXCLUDED).
if (targets.includes('firefox')) {
  const files = sourceFiles(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n'));
  const file = await fresh(path.resolve(OUT, archiveName(pkg.version, 'source')));
  execFileSync('zip', ['-q', '-X', file, '-@'], { input: files.join('\n') });
  made.push(file);
}

console.log(`\nPackaged ${pkg.version} (${icon} icon):`);
for (const file of made) console.log(`  ${path.relative('.', file)}`);
