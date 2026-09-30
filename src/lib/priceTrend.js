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
  /** Within this fraction either way, the price is called flat. */
  FLAT_BAND: 0.03,
  /** Each window needs at least this many days with sales... */
  MIN_DAYS: 3,
  /** ...and at least this many transactions in total. */
  MIN_SALES: 5,
  /** Window lengths tried in order: recent N days vs the N days before. */
  WINDOWS: [7, 14],
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

const enough = (w) => w.days >= TREND.MIN_DAYS && w.sales >= TREND.MIN_SALES;

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
 *   reason: 'ok'|'no-data'|'not-enough-sales'}}
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

  let lastTried = null;
  for (const length of TREND.WINDOWS) {
    const recent = windowStats(between(0, length));
    const prior = windowStats(between(length, length * 2));
    lastTried = { recent, prior };
    if (!enough(recent) || !enough(prior)) continue;

    // Rounded so a move of exactly 3% is not lost to floating point.
    const pct = Math.round((recent.median / prior.median - 1) * 10000) / 10000;
    const direction = Math.abs(pct) >= TREND.FLAT_BAND ? (pct > 0 ? 'up' : 'down') : 'flat';
    const { latest, turning } = checkTurn(between(0, length), direction, recent.median);
    return { ...base, direction, pct, windowDays: length, recent, prior, latest, turning, reason: 'ok' };
  }

  return {
    ...base, direction: 'unknown', pct: null, windowDays: null,
    recent: lastTried && lastTried.recent, prior: lastTried && lastTried.prior,
    latest: null, turning: null, reason: 'not-enough-sales',
  };
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
