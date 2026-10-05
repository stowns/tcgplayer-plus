/*
 * TCGPlayer+ — sending the user a notification.
 *
 * One interface for anything that needs to tell the user something while they
 * are not looking at the dashboard. What is being said (a notification) is kept
 * apart from how it gets there (a channel), so another kind of notification, or
 * another way of delivering one, needs no change here.
 *
 *   notification: { title, message, url?, tags?, priority? }
 *   channel:      { name, send(notification) => Promise<void> }   throws if it could not deliver
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const text = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');

/** A notification with everything in the shape channels can rely on; null if there is nothing to say. */
export function normalizeNotification(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title, 250);
  const message = text(raw.message, 2000);
  if (!title && !message) return null;
  const priority = Math.floor(Number(raw.priority));
  return {
    title,
    message,
    url: typeof raw.url === 'string' && /^https:\/\//.test(raw.url) ? raw.url.slice(0, 2000) : '',
    tags: (Array.isArray(raw.tags) ? raw.tags : []).filter((t) => typeof t === 'string' && /^[\w+-]{1,40}$/.test(t)).slice(0, 5),
    // 1 (lowest) to 5 (highest); 3 is ordinary.
    priority: priority >= 1 && priority <= 5 ? priority : 3,
  };
}

/**
 * @param {{channels: {name: string, send: (n: object) => Promise<void>}[]}} options
 */
export function createNotifier({ channels = [] } = {}) {
  /**
   * Send to every channel. One channel failing does not stop the others, and
   * nothing is thrown: the caller gets a result per channel.
   * @returns {Promise<{ok: boolean, results: {channel: string, ok: boolean, error: string}[]}>}
   *   `ok` when at least one channel delivered it
   */
  async function notify(raw) {
    const notification = normalizeNotification(raw);
    if (!notification) return { ok: false, results: [{ channel: '', ok: false, error: 'There was nothing to send' }] };
    if (!channels.length) return { ok: false, results: [{ channel: '', ok: false, error: 'No notification channel is set up' }] };
    const results = await Promise.all(channels.map(async (channel) => {
      try {
        await channel.send(notification);
        return { channel: channel.name, ok: true, error: '' };
      } catch (err) {
        return { channel: channel.name, ok: false, error: String(err && err.message ? err.message : err) };
      }
    }));
    return { ok: results.some((r) => r.ok), results };
  }

  return { notify, channels: channels.map((c) => c.name) };
}
