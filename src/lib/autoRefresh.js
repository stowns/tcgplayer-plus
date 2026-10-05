/*
 * TCGPlayer+ — refreshing on a timer while the dashboard is open.
 *
 * A one-second heartbeat drives it, so the interval can be any number of seconds
 * and the countdown on screen is always right. Time and timers are injected, so
 * this is tested without waiting.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const HEARTBEAT_MS = 1000;

/**
 * @param {object} options
 * @param {number} options.intervalSeconds
 * @param {() => (void|Promise<void>)} options.onTick  the refresh itself
 * @param {(secondsLeft: number|null) => void} [options.onCountdown]  told every second; null when stopped
 * @param {(error: Error) => void} [options.onError]  a refresh that threw; the timer carries on
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => any} [options.setTimer]  like setInterval
 * @param {(handle: any) => void} [options.clearTimer]
 */
export function createAutoRefresh({
  intervalSeconds, onTick, onCountdown = () => {}, onError = () => {},
  now = Date.now, setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = (h) => clearInterval(h),
}) {
  let interval = intervalSeconds;
  let handle = null;
  let dueAt = 0;
  let running = false;

  const secondsUntilNext = () => (handle === null ? null : Math.max(0, Math.ceil((dueAt - now()) / 1000)));

  function fire() {
    // A refresh still under way is not joined by another: the next one waits its turn.
    if (running) return Promise.resolve();
    running = true;
    let result;
    try {
      result = onTick();
    } catch (error) {
      running = false;
      onError(error);
      return Promise.resolve();
    }
    if (!result || typeof result.then !== 'function') {
      running = false;
      return Promise.resolve();
    }
    return result.then(() => { running = false; }, (error) => { running = false; onError(error); });
  }

  function beat() {
    if (now() >= dueAt) {
      // The next is measured from when this one was due to start, not from when it finishes.
      dueAt = now() + interval * 1000;
      fire();
    }
    onCountdown(secondsUntilNext());
  }

  return {
    /** Start counting; the first refresh comes one full interval from now. */
    start() {
      if (handle !== null) return;
      dueAt = now() + interval * 1000;
      handle = setTimer(beat, HEARTBEAT_MS);
      onCountdown(secondsUntilNext());
    },
    stop() {
      if (handle === null) return;
      clearTimer(handle);
      handle = null;
      onCountdown(null);
    },
    /** Change how often; the countdown restarts from the new interval. */
    setIntervalSeconds(seconds) {
      interval = seconds;
      if (handle !== null) {
        dueAt = now() + interval * 1000;
        onCountdown(secondsUntilNext());
      }
    },
    /** Refresh now, and count the next one from now. */
    async refreshNow() {
      if (handle !== null) dueAt = now() + interval * 1000;
      await fire();
      onCountdown(secondsUntilNext());
    },
    secondsUntilNext,
    get isRunning() { return handle !== null; },
    get isRefreshing() { return running; },
  };
}

/** "4:32" or "0:09" for the countdown; "" when there is nothing to count. */
export function formatCountdown(seconds) {
  if (!Number.isFinite(seconds) || seconds === null) return '';
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}
