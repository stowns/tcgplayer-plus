/*
 * TCGPlayer+ — is a card's sold price trending up or down?
 *
 * Works from TCGplayer's daily price-history buckets. The design follows from
 * what that data actually looks like:
 *
 *   * A day with no sales repeats the previous day's price (and sometimes holds
 *     a stray leftover), so it carries no information. Only days that had
 *     transactions are evidence.
 *   * Single days are wild — a real card showed $13.05 on 262 units (junk bulk
 *     sales) and one $440 sale, against a normal $75-97 — so everything is a
 *     median, never a mean, and the chart drops such days.
 *   * Volume varies from ~30 sales a day to ~1, so the comparison window widens
 *     for quiet cards, and gives up honestly when even that is too thin.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { median } from './stats.js';

export const TREND = {
  /**
   * Bump when anything below changes what a trend says. Trends are cached with
   * the version they were worked out under, and an older one is recomputed
   * instead of being shown with the old rules.
   */
  VERSION: 3,
  /** Within this fraction either way, the price is called flat. */
  FLAT_BAND: 0.01,
  /** Each window needs at least this many days with sales... */
  MIN_DAYS: 3,
  /** ...and at least this many transactions in total. */
  MIN_SALES: 5,
  /** Window lengths tried in order for the headline: recent N days vs the N days before. */
  WINDOWS: [7, 14],
  /**
   * The durations a person can choose to see, each worked out the same way. All
   * fit inside the thirty daily points TCGplayer gives; nothing finer than a day exists.
   */
  DURATIONS: [1, 3, 7, 14],
  DEFAULT_DURATIONS: [7],
  /**
   * The newest few sale-days are compared with the rest of the recent window to
   * catch a card that has already reversed. Wider than FLAT_BAND because a
   * median of three days is noisier than a median of a week.
   */
  TURN_DAYS: 3,
  TURN_BAND: 0.05,
};

const DAY_MS = 86400000;

const toDay = (value) => {
  const text = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
};
const dayNumber = (day) => Math.floor(Date.parse(`${day}T00:00:00Z`) / DAY_MS);

/**
 * Turn raw API buckets (strings, newest first) into numbers, oldest first.
 * @returns {{date: string, price: number, quantity: number, transactions: number}[]}
 */
export function normalizeBuckets(buckets) {
  if (!Array.isArray(buckets)) return [];
  const days = [];
  for (const b of buckets) {
    const date = b && toDay(b.bucketStartDate);
    if (!date) continue;
    days.push({
      date,
      price: Number(b.marketPrice) || 0,
      quantity: Number(b.quantitySold) || 0,
      transactions: Number(b.transactionCount) || 0,
    });
  }
  return days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

const hadSales = (d) => d.transactions > 0 && d.price > 0;

function windowStats(days) {
  const sold = days.filter(hadSales);
  return {
    median: median(sold.map((d) => d.price)),
    days: sold.length,
    sales: sold.reduce((total, d) => total + d.transactions, 0),
  };
}

/** A window shorter than MIN_DAYS cannot have that many days of sales; it needs every one it has room for. */
const enough = (w, length) => w.days >= Math.min(TREND.MIN_DAYS, length) && w.sales >= TREND.MIN_SALES;

/**
 * The newest `length` days against the `length` before them.
 * @returns {{windowDays: number, direction: 'up'|'down'|'flat'|'unknown', pct: number|null,
 *   recent: object, prior: object, reason: 'ok'|'not-enough-sales'}}
 */
function windowTrend(between, length) {
  const recent = windowStats(between(0, length));
  const prior = windowStats(between(length, length * 2));
  if (!enough(recent, length) || !enough(prior, length)) {
    return { windowDays: length, direction: 'unknown', pct: null, recent, prior, reason: 'not-enough-sales' };
  }
  // Rounded so a move of exactly 1% is not lost to floating point.
  const pct = Math.round((recent.median / prior.median - 1) * 10000) / 10000;
  const direction = Math.abs(pct) >= TREND.FLAT_BAND ? (pct > 0 ? 'up' : 'down') : 'flat';
  return { windowDays: length, direction, pct, recent, prior, reason: 'ok' };
}

/**
 * A week-on-week median lags. A card that spiked and then fell back reads "up"
 * for the week even while it is dropping today (seen live: ~$120 for four days,
 * then back to ~$75). Compare the newest sale-days with the rest of the recent
 * window, and report when they are moving against the headline.
 *
 * @returns {{latest: {median: number, days: number}, turning: 'up'|'down'|null}}
 */
function checkTurn(recentDays, headline, recentMedian) {
  const sold = recentDays.filter(hadSales);
  const newest = sold.slice(-TREND.TURN_DAYS);
  const latest = { median: median(newest.map((d) => d.price)), days: newest.length };
  if (headline === 'flat' || newest.length < TREND.TURN_DAYS) return { latest, turning: null };
  const shift = Math.round((latest.median / recentMedian - 1) * 10000) / 10000;
  if (headline === 'up' && shift <= -TREND.TURN_BAND) return { latest, turning: 'down' };
  if (headline === 'down' && shift >= TREND.TURN_BAND) return { latest, turning: 'up' };
  return { latest, turning: null };
}

/**
 * Drop days whose price is wildly away from the rest, for drawing only. The
 * trend itself uses medians and needs no such filtering.
 */
function withoutOutliers(sold) {
  if (sold.length < 5) return { kept: sold, hidden: 0 };
  const prices = sold.map((d) => d.price);
  const mid = median(prices);
  const mad = median(prices.map((p) => Math.abs(p - mid)));
  // The floor stops a very tight cluster from calling ordinary noise an outlier.
  const limit = Math.max(3 * 1.4826 * mad, 0.25 * mid);
  const kept = sold.filter((d) => Math.abs(d.price - mid) <= limit);
  return { kept, hidden: sold.length - kept.length };
}

/**
 * @param {ReturnType<typeof normalizeBuckets>} days oldest first
 * @returns {{direction: 'up'|'down'|'flat'|'unknown', pct: number|null,
 *   windowDays: number|null, recent: object|null, prior: object|null,
 *   latest: object|null, turning: 'up'|'down'|null,
 *   series: {date: string, price: number}[], outliersHidden: number,
 *   reason: 'ok'|'no-data'|'not-enough-sales',
 *   windows?: Record<number, object>, asOf?: string}}  `windows` holds every duration in TREND.DURATIONS;
 *   `asOf` is the newest day in the data, which the windows are measured back from
 */
export function computeTrend(days) {
  const all = Array.isArray(days) ? days.filter((d) => d && toDay(d.date)) : [];
  const sold = all.filter(hadSales);
  if (sold.length === 0) {
    return {
      direction: 'unknown', pct: null, windowDays: null, recent: null, prior: null,
      latest: null, turning: null, series: [], outliersHidden: 0, reason: 'no-data',
    };
  }

  const { kept, hidden } = withoutOutliers(sold);
  const series = kept.map((d) => ({ date: d.date, price: d.price }));
  const base = { series, outliersHidden: hidden };

  // Windows are measured back from the newest day the data has.
  const newest = dayNumber(all[all.length - 1].date);
  const between = (from, to) => all.filter((d) => {
    const n = dayNumber(d.date);
    return n > newest - to && n <= newest - from;
  });

  // Every duration on offer, so choosing which to show never needs the history again.
  const windows = {};
  for (const length of TREND.DURATIONS) windows[length] = windowTrend(between, length);
  const shared = { ...base, windows, asOf: all[all.length - 1].date };

  let lastTried = null;
  for (const length of TREND.WINDOWS) {
    const found = windows[length] || windowTrend(between, length);
    lastTried = found;
    if (found.reason !== 'ok') continue;
    const { latest, turning } = checkTurn(between(0, length), found.direction, found.recent.median);
    return { ...shared, direction: found.direction, pct: found.pct, windowDays: length, recent: found.recent, prior: found.prior, latest, turning, reason: 'ok' };
  }

  return {
    ...shared, direction: 'unknown', pct: null, windowDays: null,
    recent: lastTried && lastTried.recent, prior: lastTried && lastTried.prior,
    latest: null, turning: null, reason: 'not-enough-sales',
  };
}

/** The durations asked for that exist, longest first; the default when none do. */
export function cleanDurations(durations) {
  const wanted = [...new Set((Array.isArray(durations) ? durations : []).map(Number))]
    .filter((d) => TREND.DURATIONS.includes(d))
    .sort((a, b) => b - a);
  return wanted.length ? wanted : [...TREND.DEFAULT_DURATIONS];
}

/**
 * One line per chosen duration, longest first; the first is the headline.
 * A quiet card's 7 days widen to 14, as the headline always has, unless 14 has
 * its own line. Empty when there is nothing to compare (no data, or unavailable).
 * @returns {{days: number, shownDays: number, direction: string, pct: number|null,
 *   recent: object|null, prior: object|null, reason: string, headline: boolean}[]}
 */
export function selectTrendLines(trend, durations) {
  if (!trend) return [];
  if (!trend.windows) {
    // A trend worked out without the per-duration windows still has its headline.
    if (trend.direction === 'unknown' || !Number.isFinite(trend.windowDays)) return [];
    return [{
      days: trend.windowDays, shownDays: trend.windowDays, direction: trend.direction, pct: trend.pct,
      recent: trend.recent, prior: trend.prior, reason: 'ok', headline: true,
    }];
  }
  const chosen = cleanDurations(durations);
  return chosen.map((days, index) => {
    let found = trend.windows[days];
    if (!found) return null;
    const wider = trend.windows[14];
    if (days === 7 && found.reason !== 'ok' && !chosen.includes(14) && wider && wider.reason === 'ok') found = wider;
    return {
      days, shownDays: found.windowDays, direction: found.direction, pct: found.pct,
      recent: found.recent, prior: found.prior, reason: found.reason, headline: index === 0,
    };
  }).filter(Boolean);
}

/** A card needs at least this many sale-days in the chart before its swings mean anything. */
export const MIN_VOLATILITY_POINTS = 5;

/**
 * How much the price typically jumps from one day of sales to the next, as a
 * fraction: 0.04 means "about 4% a day". It is the mean of the absolute
 * day-to-day changes over the chart's sale-days (outlier days already left out),
 * so a steady slide reads as calm and a choppy card as volatile. A quiet card's
 * gaps between sale-days make its jumps look a little bigger; that is honest,
 * since its price really is harder to pin down.
 * @param {{price: number}[]} series oldest first
 * @returns {number|null} null when there are too few sale-days
 */
export function volatility(series) {
  const prices = (Array.isArray(series) ? series : []).map((p) => p && p.price).filter((p) => Number.isFinite(p) && p > 0);
  if (prices.length < MIN_VOLATILITY_POINTS) return null;
  let total = 0;
  for (let i = 1; i < prices.length; i += 1) total += Math.abs(prices[i] / prices[i - 1] - 1);
  return total / (prices.length - 1);
}

/**
 * The card's market price now: the median of its newest few days of sales, which
 * is steadier than the last single day. Null when it has no sales in the chart.
 */
export function currentPrice(trend) {
  if (!trend) return null;
  if (trend.latest && Number.isFinite(trend.latest.median)) return trend.latest.median;
  const prices = (trend.series || []).map((p) => p && p.price).filter((p) => Number.isFinite(p) && p > 0);
  if (!prices.length) return null;
  return median(prices.slice(-TREND.TURN_DAYS));
}
