/*
 * TCGPlayer+ — polite request pacing.
 * A watch list or an order history can hold dozens of cards; asking about all of
 * them at once is rude to the server and risks being blocked, so requests are
 * queued and spaced out.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export function createThrottle({ concurrency = 2, minIntervalMs = 400, sleep = defaultSleep } = {}) {
  const queue = [];
  let active = 0;
  let lastStart = 0;

  function pump() {
    if (active >= concurrency || queue.length === 0) return;
    const job = queue.shift();
    active += 1;
    const wait = Math.max(0, lastStart + minIntervalMs - Date.now());
    lastStart = Date.now() + wait;
    const settle = (fn) => (value) => {
      // Free the slot *before* settling, so a caller awaiting this job never
      // observes the throttle as still busy on its behalf.
      active -= 1;
      pump();
      fn(value);
    };
    sleep(wait)
      .then(job.task)
      .then(settle(job.resolve), settle(job.reject));
  }

  return {
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        pump();
      });
    },
    get pending() { return queue.length; },
    get active() { return active; },
  };
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
