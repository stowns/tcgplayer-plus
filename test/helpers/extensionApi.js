/*
 * Runs the integration suites once per browser.
 *
 * Each suite loads the *built* extension for the flavour under test (dist/firefox
 * or dist/chrome) and hands it the API object that browser provides: `browser`
 * in Firefox, `chrome` in Chrome. The message bus follows each browser's rules.
 * Chrome ignores a promise returned from an onMessage listener and only honours
 * sendResponse plus `return true`; Firefox accepts either.
 */

import { describe, beforeEach } from 'node:test';

export const FLAVOURS = ['firefox', 'chrome'];

let current = 'firefox';

export const flavour = () => current;

/** The built file for the flavour under test, e.g. dist('home/home.js'). */
export const dist = (file) => `dist/${current}/${file}`;

/** The global the page sees its API on. */
export const apiName = () => (current === 'firefox' ? 'browser' : 'chrome');

/** Register `defineTests` once per browser, each set labelled with the browser. */
export function forEachBrowser(defineTests) {
  for (const name of FLAVOURS) {
    describe(name, () => {
      beforeEach(() => { current = name; });
      defineTests(name);
    });
  }
}

/**
 * Stand-in for the messaging between extension pages and the background.
 * `runtime` is what the background registers its listener on; `send` is what a
 * page's sendMessage does. Always returns a promise.
 */
export function messageBus() {
  let listener = null;
  return {
    runtime: { onMessage: { addListener: (fn) => { listener = fn; }, removeListener: () => { listener = null; } } },
    send(message) {
      return new Promise((resolve) => {
        const handled = listener(message, {}, resolve);
        if (handled === true) return;                                  // the listener will call sendResponse later
        if (handled && typeof handled.then === 'function' && current === 'firefox') {
          handled.then(resolve);                                       // Firefox also takes a returned promise
          return;
        }
        resolve(undefined);                                            // nobody answers: the channel closes
      });
    },
  };
}
