/*
 * TCGPlayer+ — delivering notifications through ntfy (https://docs.ntfy.sh/).
 *
 * ntfy is publish/subscribe over plain HTTP: whoever subscribes to a topic gets
 * what is published to it. There is no account, so the topic name is the only
 * secret, which is why ours is the user's secret word and a random code (see settings.js).
 *
 * Published as JSON to the server's root (docs.ntfy.sh/publish/#publish-as-json)
 * rather than with headers, because header values cannot carry names such as
 * "Pokémon". ntfy.sh answers cross-origin requests from any origin, so this needs
 * no extra permission.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createClient } from './httpClient.js';
import { createThrottle } from './throttle.js';
import { HttpError, TimeoutError } from './retry.js';
import { isValidTopic } from './settings.js';

export const NTFY_SERVER = 'https://ntfy.sh';
/** Where the ntfy apps are, for the instructions in Settings. */
export const NTFY_ANDROID_URL = 'https://play.google.com/store/apps/details?id=io.heckel.ntfy';
export const NTFY_IOS_URL = 'https://apps.apple.com/us/app/ntfy/id1625396347';

/** Where a person can read a topic in a browser, or subscribe to it from the ntfy app. */
export const topicUrl = (topic, server = NTFY_SERVER) => `${server}/${topic}`;

/** The JSON ntfy expects for a notification. */
export function ntfyPayload(topic, notification) {
  const payload = { topic, message: notification.message || notification.title };
  if (notification.title && notification.message) payload.title = notification.title;
  if (notification.url) payload.click = notification.url;
  if (notification.tags && notification.tags.length) payload.tags = notification.tags;
  if (notification.priority && notification.priority !== 3) payload.priority = notification.priority;
  return payload;
}

/**
 * @param {object} options
 * @param {typeof fetch} options.fetch
 * @param {string} options.topic
 * @param {string} [options.server]
 * @param {object} [options.throttle]
 * @param {object} [options.retry]  overrides for retry.js
 * @param {number} [options.timeoutMs]
 * @returns {{name: string, send: (notification: object) => Promise<void>}} a channel for notifications.js
 */
export function ntfyChannel({ fetch: doFetch, topic, server = NTFY_SERVER, throttle, retry, timeoutMs }) {
  const client = createClient({
    fetch: doFetch,
    throttle: throttle || createThrottle({ concurrency: 1, minIntervalMs: 250 }),
    retry,
    timeoutMs,
  });

  return {
    name: 'ntfy',
    async send(notification) {
      if (!isValidTopic(topic)) throw new Error('No notification topic is set up');
      let response;
      try {
        response = await client.request(`${server}/`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(ntfyPayload(topic, notification)),
        });
      } catch (err) {
        // The shared client words its errors for TCGplayer; say whose server this was.
        if (err instanceof HttpError) throw new Error(`ntfy responded ${err.status}`);
        if (err instanceof TimeoutError) throw new Error(`ntfy did not respond within ${err.timeoutMs / 1000} seconds`);
        throw new Error(`Could not reach ntfy (${err && err.message ? err.message : err})`);
      }
      if (!response.ok) throw new Error(`ntfy responded ${response.status}`);
    },
  };
}
