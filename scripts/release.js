/*
 * TCGPlayer+ — what both stores check before they will take an upload.
 * Pure, so it is tested and runs before anything is zipped.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** The Chrome Web Store's limits; Firefox's are looser, so one set serves both. */
export const LIMITS = { nameChars: 45, descriptionChars: 132 };

/** 1 to 4 dot-separated integers: what both stores accept as a version. */
const VERSION = /^\d+(\.\d+){0,3}$/;

/** The 128 px icon the Chrome Web Store asks for, and the sizes the toolbar uses. */
const REQUIRED_ICONS = ['16', '32', '48', '96', '128'];

/**
 * @param {{manifest: object, pkg: {version: string}}} input  one built manifest, and package.json
 * @returns {string[]} what is wrong, in words; empty when the manifest can be uploaded
 */
export function releaseProblems({ manifest, pkg }) {
  const problems = [];
  const m = manifest || {};
  if (!m.name) problems.push('The manifest has no name.');
  else if (m.name.length > LIMITS.nameChars) problems.push(`The name is ${m.name.length} characters; the limit is ${LIMITS.nameChars}.`);
  if (!m.description) problems.push('The manifest has no description.');
  else if (m.description.length > LIMITS.descriptionChars) {
    problems.push(`The description is ${m.description.length} characters; Chrome allows ${LIMITS.descriptionChars}.`);
  }
  if (!VERSION.test(String(m.version || ''))) problems.push(`The version "${m.version}" is not 1 to 4 dot-separated numbers.`);
  else if (pkg && m.version !== pkg.version) problems.push(`The manifest version ${m.version} does not match package.json (${pkg.version}).`);
  for (const size of REQUIRED_ICONS) {
    if (!(m.icons && m.icons[size])) problems.push(`The manifest has no ${size} px icon.`);
  }
  return problems;
}

/** e.g. tcgplayer-plus-1.0.0-firefox.zip */
export const archiveName = (version, kind) => `tcgplayer-plus-${version}-${kind}.zip`;

/**
 * Paths that never go into the source archive, however git sees them. `examples/` holds
 * saved copies of real TCGplayer pages, which carry a person's name and address;
 * `store/` holds the store listing's images, which are not source.
 */
export const SOURCE_EXCLUDED = ['examples/', 'store/', 'release/', 'dist/', 'node_modules/', '.git/'];

/** The files for the source archive, from a list of repository paths. */
export function sourceFiles(paths) {
  return paths.filter((f) => f
    && !f.endsWith('.DS_Store')
    && !f.endsWith('.zip')
    && !SOURCE_EXCLUDED.some((dir) => f === dir.slice(0, -1) || f.startsWith(dir)));
}
