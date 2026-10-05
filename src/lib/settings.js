/*
 * TCGPlayer+ — the user's settings: auto-refresh and where notifications go.
 *
 * Kept under one storage key and read defensively: a damaged or missing value is
 * repaired to a working default rather than allowed to break the dashboard.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TREND, cleanDurations } from './priceTrend.js';

export const SETTINGS_KEY = 'settings';

/** Refreshing faster than this would overlap the lookups of an ordinary list. */
export const MIN_INTERVAL_SECONDS = 5;
export const DEFAULT_INTERVAL_SECONDS = 600;
/** Below this, TCGplayer may start refusing requests; the user is warned once. */
export const RATE_WARNING_BELOW_SECONDS = 600;
/** A day: longer than that is not "auto-refresh". */
export const MAX_INTERVAL_SECONDS = 86400;

/** ntfy topics are letters, digits, dashes and underscores, up to 64 long. */
const TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

export const isValidTopic = (topic) => typeof topic === 'string' && TOPIC.test(topic);

/** The user's part of the topic: short enough to remember and type on another device. */
export const SECRET_WORD_MIN = 3;
export const SECRET_WORD_MAX = 24;
const SECRET_WORD = new RegExp(`^[a-z0-9]{${SECRET_WORD_MIN},${SECRET_WORD_MAX}}$`);
export const SECRET_WORD_RULE = `Use ${SECRET_WORD_MIN} to ${SECRET_WORD_MAX} letters or digits, with no spaces.`;

/**
 * The secret word as it will be used: trimmed and in lower case, so it is typed the
 * same way everywhere.
 * @returns {{ok: true, word: string}|{ok: false, error: string}}
 */
export function parseSecretWord(raw) {
  const word = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!word) return { ok: false, error: `Choose a secret word for your notifications. ${SECRET_WORD_RULE}` };
  if (!SECRET_WORD.test(word)) return { ok: false, error: `That secret word cannot be used. ${SECRET_WORD_RULE}` };
  return { ok: true, word };
}

export const CODE_LENGTH = 5;
const CODE_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Five random letters and digits, so two people choosing the same word do not share a topic.
 * @param {(bytes: Uint8Array) => Uint8Array} randomValues
 */
export function randomCode(randomValues = (bytes) => crypto.getRandomValues(bytes)) {
  // Bytes past the last whole multiple of the alphabet are thrown away, so no character is favoured.
  const limit = 256 - (256 % CODE_ALPHABET.length);
  let code = '';
  while (code.length < CODE_LENGTH) {
    for (const byte of randomValues(new Uint8Array(CODE_LENGTH * 2))) {
      if (byte < limit && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
    }
  }
  return code;
}

/**
 * "<secret word>-<code>". On ntfy the topic name is the only secret: anyone who knows
 * it can read what is sent to it.
 * @throws {Error} when the word cannot be used
 */
export function newTopic(secretWord, code = randomCode()) {
  const parsed = parseSecretWord(secretWord);
  if (!parsed.ok) throw new Error(parsed.error);
  return `${parsed.word}-${code}`;
}

/** Whole seconds within the allowed range; anything unreadable is the default. */
export function clampInterval(value) {
  // An empty box is "not set", not zero.
  if (value === '' || value === null || value === undefined) return DEFAULT_INTERVAL_SECONDS;
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, n));
}

export function defaultSettings() {
  return {
    autoRefresh: { enabled: false, intervalSeconds: DEFAULT_INTERVAL_SECONDS },
    rateWarningDismissed: false,
    subscribeNoticeDismissed: false,
    trendDurations: [...TREND.DEFAULT_DURATIONS],
    notifications: { topic: '' },
  };
}

export function sanitizeSettings(raw) {
  const base = defaultSettings();
  if (!raw || typeof raw !== 'object') return base;
  const auto = raw.autoRefresh && typeof raw.autoRefresh === 'object' ? raw.autoRefresh : {};
  const notes = raw.notifications && typeof raw.notifications === 'object' ? raw.notifications : {};
  return {
    autoRefresh: {
      enabled: auto.enabled === true,
      intervalSeconds: 'intervalSeconds' in auto ? clampInterval(auto.intervalSeconds) : DEFAULT_INTERVAL_SECONDS,
    },
    rateWarningDismissed: raw.rateWarningDismissed === true,
    subscribeNoticeDismissed: raw.subscribeNoticeDismissed === true,
    trendDurations: cleanDurations(raw.trendDurations),
    notifications: { topic: isValidTopic(notes.topic) ? notes.topic : '' },
  };
}

export async function loadSettings(storage) {
  const bag = await storage.get(SETTINGS_KEY);
  return sanitizeSettings(bag ? bag[SETTINGS_KEY] : null);
}

export async function saveSettings(storage, settings) {
  const clean = sanitizeSettings(settings);
  await storage.set({ [SETTINGS_KEY]: clean });
  return clean;
}

/** Read, change, write. `change` gets the current settings and returns the new ones. */
export async function updateSettings(storage, change) {
  return saveSettings(storage, change(await loadSettings(storage)));
}

export const hasTopic = (settings) => Boolean(settings && settings.notifications && settings.notifications.topic);

/**
 * Make the notification topic from the user's secret word and keep it: the same
 * topic is then used for every notification.
 * @throws {Error} when the word cannot be used
 */
export async function createTopic(storage, secretWord, code) {
  const topic = newTopic(secretWord, code);
  return updateSettings(storage, (s) => ({ ...s, notifications: { ...s.notifications, topic } }));
}

/** Should the "you may be rate limited" notice be shown for this interval? */
export function shouldWarnAboutRate(settings) {
  return settings.autoRefresh.enabled
    && settings.autoRefresh.intervalSeconds < RATE_WARNING_BELOW_SECONDS
    && !settings.rateWarningDismissed;
}

/**
 * Should the watch list say where to subscribe? Once somebody wants to be notified,
 * until they have seen it: a notification goes nowhere until its topic is subscribed to.
 * @param {object} targets the saved targets, by item key
 */
export function shouldShowSubscribeNotice(settings, targets) {
  return hasTopic(settings)
    && !settings.subscribeNoticeDismissed
    && Object.values(targets || {}).some((target) => target && target.notify);
}

/**
 * Show or stop showing the price trend over `days`. At least one is always
 * shown, so the last cannot be switched off; an unknown duration changes nothing.
 */
export function toggleTrendDuration(settings, days, on) {
  const current = cleanDurations(settings.trendDurations);
  if (!TREND.DURATIONS.includes(days)) return { ...settings, trendDurations: current };
  const next = on ? [...current, days] : current.filter((d) => d !== days);
  return { ...settings, trendDurations: next.length ? cleanDurations(next) : current };
}
