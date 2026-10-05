/*
 * TCGPlayer+ — consent to sending a notification.
 *
 * A notification carries a card's name and price to ntfy, which is outside the
 * browser. Firefox asks the user before an add-on may do that: the manifest
 * declares it as an optional data collection permission ("website content"), and
 * the user is asked the first time notifications are used. Browsers without that
 * system (Chrome) need no step here.
 *
 * The browser API is injected, so this is tested without a browser.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** What a notification sends, in Firefox's terms: text that was visible on a website. */
export const NOTIFICATION_DATA = ['websiteContent'];

/** The data collection this add-on's manifest marks as optional; empty where the browser has no such thing. */
function optionalData(api) {
  try {
    const manifest = api.runtime.getManifest();
    const gecko = manifest && manifest.browser_specific_settings && manifest.browser_specific_settings.gecko;
    const optional = gecko && gecko.data_collection_permissions && gecko.data_collection_permissions.optional;
    return Array.isArray(optional) ? optional : [];
  } catch {
    return [];
  }
}

/** Does this browser need to ask the user before a notification may be sent? */
export function needsConsent(api) {
  const optional = optionalData(api);
  return NOTIFICATION_DATA.some((kind) => optional.includes(kind));
}

/** Has the user already agreed? True where no consent is needed. */
export async function hasConsent(api) {
  if (!needsConsent(api)) return true;
  try {
    return Boolean(await api.permissions.contains({ data_collection: NOTIFICATION_DATA }));
  } catch {
    return false;
  }
}

/**
 * Ask the user, if they have not been asked or said no before. The browser only
 * shows its prompt in answer to a click, so call this first thing in a click or
 * submit handler, before anything else is awaited.
 * @returns {Promise<boolean>} whether notifications may be sent
 */
export function requestConsent(api) {
  if (!needsConsent(api)) return Promise.resolve(true);
  let asking;
  try {
    asking = api.permissions.request({ data_collection: NOTIFICATION_DATA });
  } catch {
    return Promise.resolve(false);
  }
  return Promise.resolve(asking).then(Boolean, () => false);
}

export const CONSENT_NEEDED = 'Firefox has not been given permission to send notifications. Press "Send test notification" in Settings to allow it.';
