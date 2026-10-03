/*
 * TCGPlayer+ — what a screen shows while a lookup is being retried.
 *
 * A retrying lookup is represented as a pseudo-result, `{retrying: true, retry, retries}`,
 * in the place where the lookup's result would go. Anything that draws a result
 * can then draw "still loading, and here is why", without a second code path.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/** @param {{retry: number, retries: number}} info  the n-th retry of at most `retries` */
export function retryingState({ retry, retries }) {
  return { retrying: true, retry, retries };
}

export const isRetrying = (value) => Boolean(value && value.retrying === true);

/** True once a lookup has its real answer, rather than being unasked or being retried. */
export const isSettled = (value) => Boolean(value) && !isRetrying(value);

/** Short, for a cell: "Retrying (2 of 4)…". */
export function retryText(state) {
  return `Retrying (${state.retry} of ${state.retries})…`;
}

/** Longer, for a tooltip, saying why it is taking a while. */
export function retryTitle(state) {
  return `TCGplayer did not answer. Trying again automatically (retry ${state.retry} of ${state.retries}).`;
}
