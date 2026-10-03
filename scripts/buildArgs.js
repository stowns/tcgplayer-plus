/*
 * TCGPlayer+ — build command line.
 *
 *   node scripts/build.js [firefox|chrome|all] [--icon=plus|stripes]
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TARGETS } from './manifest.js';
import { ICON_VARIANTS, DEFAULT_VARIANT } from './icon.js';

/** @returns {{targets: string[], icon: string}}; throws a message fit to print for anything unrecognised */
export function parseBuildArgs(argv) {
  let target = 'all';
  let icon = DEFAULT_VARIANT;
  for (const arg of argv) {
    if (arg.startsWith('--icon=')) {
      icon = arg.slice('--icon='.length);
      if (!ICON_VARIANTS.includes(icon)) throw new Error(`Unknown icon "${icon}". Use ${ICON_VARIANTS.join(' or ')}.`);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option "${arg}".`);
    } else {
      target = arg;
    }
  }
  if (target !== 'all' && !TARGETS.includes(target)) throw new Error(`Unknown target "${target}". Use firefox, chrome or all.`);
  return { targets: target === 'all' ? TARGETS : [target], icon };
}
