/*
 * TCGPlayer+ — a tiny price chart.
 *
 * One scale places every mark: x is calendar time over a fixed window (so a
 * gap in sales is drawn as a gap, and a new card starts partway across instead
 * of being stretched to fill the space), y is price between the series' own
 * minimum and maximum.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { formatMoney } from './money.js';

const SVG = 'http://www.w3.org/2000/svg';
const DAY_MS = 86400000;
const dayNumber = (date) => Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
const round = (n) => Math.round(n * 100) / 100;

/**
 * @param {{date: string, price: number}[]} series sale-days, oldest first
 * @param {{width?: number, height?: number, pad?: number, spanDays?: number}} [options]
 */
export function buildSparkline(series, { width = 96, height = 28, pad = 3, spanDays = 30 } = {}) {
  const data = Array.isArray(series) ? series.filter((p) => p && Number.isFinite(p.price)) : [];
  if (data.length === 0) {
    return { width, height, path: '', points: [], end: null, min: null, max: null, empty: true };
  }

  const prices = data.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const newest = dayNumber(data[data.length - 1].date);
  const innerW = width - 2 * pad;
  const innerH = height - 2 * pad;

  const points = data.map((p) => {
    const age = Math.min(Math.max(newest - dayNumber(p.date), 0), spanDays - 1);
    const x = pad + (1 - age / (spanDays - 1)) * innerW;
    const y = max === min ? height / 2 : pad + (1 - (p.price - min) / (max - min)) * innerH;
    return { x: round(x), y: round(y), date: p.date, price: p.price };
  });

  const path = points.length > 1
    ? points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ')
    : '';
  const last = points[points.length - 1];
  return { width, height, path, points, end: { x: last.x, y: last.y }, min, max, empty: false };
}

/** @returns {SVGSVGElement|null} */
export function renderSparkline(doc, series, options) {
  const g = buildSparkline(series, options);
  if (g.empty) return null;

  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', `0 0 ${g.width} ${g.height}`);
  svg.setAttribute('width', String(g.width));
  svg.setAttribute('height', String(g.height));
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('role', 'img');
  const first = g.points[0];
  const last = g.points[g.points.length - 1];
  svg.setAttribute(
    'aria-label',
    `Sold price over the last 30 days, from ${formatMoney(first.price)} to ${formatMoney(last.price)}`,
  );

  if (g.path) {
    const line = doc.createElementNS(SVG, 'path');
    line.setAttribute('d', g.path);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.5');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.append(line);
  }
  const dot = doc.createElementNS(SVG, 'circle');
  dot.setAttribute('cx', String(g.end.x));
  dot.setAttribute('cy', String(g.end.y));
  dot.setAttribute('r', '2.5');
  dot.setAttribute('fill', 'currentColor');
  svg.append(dot);
  return svg;
}
