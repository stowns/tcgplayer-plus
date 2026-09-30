/*
 * TCGPlayer+ — the one place that knows which browser it is running in.
 *
 * Firefox offers `browser`, Chrome offers `chrome`; both return promises from
 * storage, tabs and runtime calls. They differ in how a message listener
 * replies: Firefox accepts a returned promise, Chrome ignores it and needs
 * `sendResponse` with `return true`. `onMessage` below uses the form both
 * understand, so there is a single code path.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const api = globalThis.browser || globalThis.chrome;

const errorText = (err) => String(err && err.message ? err.message : err);

/**
 * Register the extension's single message handler.
 * @param {(message: object, sender: object) => Promise<any>|any} handler
 *   Return a promise (or a value) to reply; return `undefined` to leave the
 *   message unanswered. A rejected promise replies `{ error }` rather than
 *   leaving the sender waiting.
 * @param {{onMessage: {addListener: Function}}} [runtime] injectable for tests
 */
export function onMessage(handler, runtime = api.runtime) {
  runtime.onMessage.addListener((message, sender, sendResponse) => {
    let result;
    try {
      result = handler(message, sender);
    } catch (err) {
      sendResponse({ error: errorText(err) });
      return false;
    }
    if (result === undefined) return false;
    Promise.resolve(result).then(sendResponse, (err) => sendResponse({ error: errorText(err) }));
    // Keeping the channel open is what lets the reply arrive after this function returns.
    return true;
  });
}
