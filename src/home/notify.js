/*
 * TCGPlayer+ — the dashboard's way of sending a notification.
 * Builds the notifier from the user's settings each time, so a changed topic is used at once.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createNotifier } from '../lib/notifications.js';
import { ntfyChannel } from '../lib/ntfy.js';
import { loadSettings, hasTopic } from '../lib/settings.js';
import { hasConsent, CONSENT_NEEDED } from '../lib/consent.js';
import { api } from '../lib/runtime.js';

export const TOPIC_NEEDED = 'Notifications are not set up yet. Choose a secret word in Settings.';

/**
 * @param {{title: string, message: string, url?: string, tags?: string[], priority?: number}} notification
 * @returns {Promise<{ok: boolean, results: {channel: string, ok: boolean, error: string}[]}>}
 */
export async function sendNotification(notification) {
  // Nothing leaves the browser until the user has agreed to it (Firefox asks; see consent.js).
  if (!(await hasConsent(api))) return { ok: false, results: [{ channel: 'ntfy', ok: false, error: CONSENT_NEEDED }] };
  const settings = await loadSettings(api.storage.local);
  if (!hasTopic(settings)) return { ok: false, results: [{ channel: 'ntfy', ok: false, error: TOPIC_NEEDED }] };
  const notifier = createNotifier({
    channels: [ntfyChannel({ fetch: (...args) => window.fetch(...args), topic: settings.notifications.topic })],
  });
  return notifier.notify(notification);
}
