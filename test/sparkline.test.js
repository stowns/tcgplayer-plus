import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildSparkline, renderSparkline } from '../src/lib/sparkline.js';
import { computeTrend, normalizeBuckets } from '../src/lib/priceTrend.js';
import { PIKACHU_HISTORY } from './fixtures/tcgplayerHistory.js';

const S = (pairs) => pairs.map(([date, price]) => ({ date: `2026-09-${date}`, price }));
const OPTS = { width: 100, height: 30, pad: 3 };

test('buildSparkline keeps every point inside the drawing', () => {
  const g = buildSparkline(S([['01', 80], ['10', 100], ['20', 60], ['30', 90]]), OPTS);
  for (const p of g.points) {
    assert.ok(p.x >= 3 && p.x <= 97, `x ${p.x}`);
    assert.ok(p.y >= 3 && p.y <= 27, `y ${p.y}`);
  }
});

test('buildSparkline draws higher prices higher up, on one scale', () => {
  const g = buildSparkline(S([['20', 60], ['25', 100], ['30', 80]]), OPTS);
  const [low, high, mid] = g.points;
  assert.ok(high.y < mid.y && mid.y < low.y, 'SVG y grows downward, so a higher price has a smaller y');
  assert.equal(high.y, 3, 'the maximum touches the top padding');
  assert.equal(low.y, 27, 'the minimum touches the bottom padding');
  assert.equal(g.min, 60);
  assert.equal(g.max, 100);
});

test('buildSparkline places days on a shared 30-day time axis, so a gap is visible as a gap', () => {
  const g = buildSparkline(S([['02', 50], ['03', 50], ['30', 50]]), OPTS);
  const [a, b, c] = g.points;
  assert.ok(b.x - a.x < 5, 'adjacent days sit close together');
  assert.ok(c.x - b.x > 80, 'a four-week gap is drawn as a four-week gap');
  assert.equal(c.x, 97, 'the newest day is at the right edge');
});

test('a card with little history starts partway across rather than being stretched', () => {
  const g = buildSparkline(S([['25', 70], ['30', 75]]), OPTS);
  assert.ok(g.points[0].x > 60, 'only the last few days have data');
});

test('buildSparkline marks the most recent point', () => {
  const g = buildSparkline(S([['25', 70], ['30', 75]]), OPTS);
  assert.deepEqual(g.end, { x: g.points[1].x, y: g.points[1].y });
});

test('a flat series is drawn as a level line, not divided by zero', () => {
  const g = buildSparkline(S([['20', 45.5], ['25', 45.5], ['30', 45.5]]), OPTS);
  assert.ok(g.points.every((p) => p.y === 15), 'centred vertically');
  assert.ok(!g.path.includes('NaN'));
});

test('a single sale is a dot with no line', () => {
  const g = buildSparkline(S([['30', 80]]), OPTS);
  assert.equal(g.path, '');
  assert.equal(g.points.length, 1);
  assert.ok(g.end);
});

test('no data gives an empty graphic', () => {
  for (const input of [[], null, undefined]) {
    const g = buildSparkline(input, OPTS);
    assert.equal(g.empty, true);
    assert.equal(g.path, '');
    assert.equal(g.end, null);
  }
});

test('the path is a plain polyline through the points, in order', () => {
  const g = buildSparkline(S([['20', 60], ['25', 100], ['30', 80]]), OPTS);
  assert.match(g.path, /^M[\d.]+ [\d.]+ L[\d.]+ [\d.]+ L[\d.]+ [\d.]+$/);
});

const doc = () => new JSDOM('<body></body>').window.document;

test('renderSparkline builds an accessible SVG with explicit fills', () => {
  const svg = renderSparkline(doc(), S([['20', 60], ['25', 100], ['30', 80]]), OPTS);
  assert.equal(svg.namespaceURI, 'http://www.w3.org/2000/svg');
  assert.equal(svg.getAttribute('viewBox'), '0 0 100 30');
  assert.equal(svg.getAttribute('role'), 'img');
  assert.match(svg.getAttribute('aria-label'), /\$60\.00.*\$80\.00/, 'says where the line starts and ends');
  const path = svg.querySelector('path');
  assert.equal(path.getAttribute('fill'), 'none');
  assert.equal(path.getAttribute('stroke'), 'currentColor', 'takes its colour from the theme');
  assert.equal(svg.querySelector('circle').getAttribute('fill'), 'currentColor');
});

test('renderSparkline returns null when there is nothing to draw', () => {
  assert.equal(renderSparkline(doc(), [], OPTS), null);
});

test('real data: an outlier-filtered series draws inside its bounds', () => {
  const t = computeTrend(normalizeBuckets(PIKACHU_HISTORY.result[0].buckets));
  const g = buildSparkline(t.series, OPTS);
  assert.ok(g.max < 120, `the $440 sale must not stretch the scale (max ${g.max})`);
  assert.ok(g.min > 60, `nor the $13.05 junk day (min ${g.min})`);
  assert.ok(g.points.every((p) => p.y >= 3 && p.y <= 27));
});

// ---- the periods a trend compares, shaded ---------------------------------------------

test('no periods are shaded unless asked for', () => {
  assert.deepEqual(buildSparkline(S([['01', 80], ['30', 90]]), OPTS).bands, []);
  assert.deepEqual(buildSparkline([], { ...OPTS, highlightDays: 7 }).bands, []);
  for (const bad of [0, -1, NaN, 'x']) assert.deepEqual(buildSparkline(S([['30', 90]]), { ...OPTS, highlightDays: bad }).bands, [], String(bad));
});

test('the newest N days and the N before are two strips that meet, ending at the right edge', () => {
  const g = buildSparkline(S([['01', 80], ['30', 90]]), { ...OPTS, highlightDays: 7 });
  const [prior, recent] = g.bands;
  assert.deepEqual([prior.name, recent.name], ['prior', 'recent']);
  assert.ok(Math.abs(prior.x + prior.width - recent.x) < 0.02, 'they meet');
  assert.ok(Math.abs(prior.width - recent.width) < 0.5, 'and are the same length');
  // The newest day sits at x = 97; its strip runs half a day past it.
  assert.ok(recent.x + recent.width > 97 && recent.x + recent.width <= 100);
  // Seven of twenty-nine day-steps across 94 units.
  assert.ok(Math.abs(recent.width - (7 / 29) * 94) < 0.05, String(recent.width));
});

test('one day is still a visible strip, and fourteen days twice over stay inside the drawing', () => {
  const one = buildSparkline(S([['29', 80], ['30', 90]]), { ...OPTS, highlightDays: 1 }).bands;
  assert.ok(one[1].width > 3, String(one[1].width));
  const wide = buildSparkline(S([['01', 80], ['30', 90]]), { ...OPTS, highlightDays: 14 }).bands;
  for (const b of wide) assert.ok(b.x >= 0 && b.x + b.width <= 100.01, JSON.stringify(b));
});

test('the right edge can be a day later than the last sale, so the strips line up with the trend', () => {
  const series = S([['20', 80], ['28', 90]]);
  const loose = buildSparkline(series, OPTS);
  const anchored = buildSparkline(series, { ...OPTS, endDate: '2026-09-30' });
  assert.equal(loose.end.x, 97, 'without it, the last sale is the right edge');
  assert.ok(anchored.end.x < 97, 'with it, the last sale sits two days in');
  assert.equal(buildSparkline(series, { ...OPTS, endDate: 'junk' }).end.x, 97, 'a bad date is ignored');
});

test('renderSparkline draws the strips behind the line and names them', () => {
  const d = new JSDOM('<body></body>').window.document;
  const svg = renderSparkline(d, S([['01', 80], ['15', 70], ['30', 90]]), { ...OPTS, highlightDays: 1 });
  const kids = [...svg.children].map((n) => n.tagName);
  assert.deepEqual(kids, ['rect', 'rect', 'path', 'circle']);
  assert.deepEqual([...svg.querySelectorAll('rect')].map((r) => r.getAttribute('class')), ['sparkline__band sparkline__band--prior', 'sparkline__band sparkline__band--recent']);
  assert.ok(Number(svg.querySelector('.sparkline__band--recent').getAttribute('fill-opacity')) > Number(svg.querySelector('.sparkline__band--prior').getAttribute('fill-opacity')));
  assert.match(svg.getAttribute('aria-label'), /Shaded: the last 1 day, and the 1 before$/);
  assert.doesNotMatch(renderSparkline(d, S([['01', 80], ['30', 90]]), OPTS).getAttribute('aria-label'), /Shaded/);
});
