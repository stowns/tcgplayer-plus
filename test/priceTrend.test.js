import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeBuckets, computeTrend, TREND, volatility, currentPrice, MIN_VOLATILITY_POINTS, selectTrendLines, cleanDurations,
} from '../src/lib/priceTrend.js';
import { parseHistory } from '../src/lib/tcgplayerHistory.js';
import { PIKACHU_HISTORY, GENESECT_HISTORY, historyRow } from './fixtures/tcgplayerHistory.js';

const pikachu = () => normalizeBuckets(PIKACHU_HISTORY.result[0].buckets);
const genesect = () => normalizeBuckets(GENESECT_HISTORY.result[0].buckets);

/** Build daily buckets (newest first) ending 30 Sep: [price, transactions] per day. */
function daily(pairs) {
  return pairs.map(([price, tx], i) => historyRow([
    `09-${String(30 - i).padStart(2, '0')}`, price, tx, tx, price, price,
  ]));
}
const flatRun = (price, tx, n) => Array.from({ length: n }, () => [price, tx]);

test('normalizeBuckets returns numbers, oldest first', () => {
  const days = pikachu();
  assert.equal(days.length, 30);
  assert.equal(days[0].date, '2026-09-01');
  assert.equal(days.at(-1).date, '2026-09-30');
  assert.equal(days.at(-1).price, 72.91);
  assert.equal(days.at(-1).transactions, 4);
  assert.equal(typeof days[0].price, 'number');
});

test('normalizeBuckets tolerates junk rather than throwing', () => {
  assert.deepEqual(normalizeBuckets(null), []);
  assert.deepEqual(normalizeBuckets([null, {}, { bucketStartDate: 'nope' }]), []);
  const days = normalizeBuckets([{ bucketStartDate: '2026-09-30T00:00:00Z', marketPrice: '5', transactionCount: '2' }]);
  assert.equal(days[0].date, '2026-09-30', 'a timestamp is reduced to its date');
});

test('a busy card falling from its launch highs is reported as down', () => {
  const t = computeTrend(pikachu());
  assert.equal(t.direction, 'down');
  assert.equal(t.windowDays, 7);
  assert.equal(t.recent.median, 73.62);
  assert.equal(t.prior.median, 87.53);
  assert.ok(Math.abs(t.pct - -0.1589) < 0.0005, `pct was ${t.pct}`);
});

test('the $13.05 junk-sale day does not decide the answer', () => {
  // Same week with that day removed entirely must land on the same direction.
  const days = pikachu().filter((d) => d.date !== '2026-09-26');
  assert.equal(computeTrend(days).direction, 'down');
  assert.equal(computeTrend(pikachu()).direction, 'down');
});

test('a quiet card widens to 14 days and reads as flat', () => {
  // Only four sales in the last week is too few to judge, so it looks further back.
  const t = computeTrend(genesect());
  assert.equal(t.direction, 'flat');
  assert.equal(t.windowDays, 14);
  assert.ok(Math.abs(t.pct) < 0.03);
  // Medians of an even count average the two middle prices, so compare to a cent.
  assert.ok(Math.abs(t.recent.median - 45.665) < 0.005, `recent ${t.recent.median}`);
  assert.ok(Math.abs(t.prior.median - 45.895) < 0.005, `prior ${t.prior.median}`);
});

test('days with no sales are ignored, however they are priced', () => {
  // Pikachu's 14 Sep bucket carries a stray $5.94 with no transactions.
  const t = computeTrend(pikachu());
  assert.ok(t.series.every((p) => p.price !== 5.94));
  const zeros = computeTrend(normalizeBuckets(daily([...flatRun(0, 0, 30)])));
  assert.equal(zeros.direction, 'unknown');
  assert.equal(zeros.reason, 'no-data');
});

test('direction bands: 1% either way is a move, anything less is flat', () => {
  const build = (recent, prior) => normalizeBuckets(daily([
    ...flatRun(recent, 3, 7), ...flatRun(prior, 3, 7),
  ]));
  assert.equal(computeTrend(build(101, 100)).direction, 'up');
  assert.equal(computeTrend(build(101.3, 100)).direction, 'up');
  assert.equal(computeTrend(build(99, 100)).direction, 'down');
  assert.equal(computeTrend(build(100.9, 100)).direction, 'flat');
  assert.equal(computeTrend(build(99.1, 100)).direction, 'flat');
  assert.equal(computeTrend(build(100, 100)).direction, 'flat');
  assert.equal(TREND.FLAT_BAND, 0.01);
});

test('a rising card is reported as up, with the change as a fraction', () => {
  const days = normalizeBuckets(daily([...flatRun(120, 4, 7), ...flatRun(100, 4, 7)]));
  const t = computeTrend(days);
  assert.equal(t.direction, 'up');
  assert.equal(t.pct, 0.2);
});

test('too few sales gives no verdict instead of a guess', () => {
  const t = computeTrend(normalizeBuckets(daily([
    [50, 1], [0, 0], [51, 1], ...flatRun(0, 0, 27),
  ])));
  assert.equal(t.direction, 'unknown');
  assert.equal(t.pct, null);
  assert.equal(t.reason, 'not-enough-sales');
});

test('a card too new to have a prior period gives no verdict', () => {
  // All of its sales are in the last five days: nothing to compare against.
  const t = computeTrend(normalizeBuckets(daily([...flatRun(80, 20, 5), ...flatRun(0, 0, 25)])));
  assert.equal(t.direction, 'unknown');
  assert.equal(t.reason, 'not-enough-sales');
});

test('empty and malformed input is unknown, never an exception', () => {
  for (const input of [[], null, undefined]) {
    const t = computeTrend(input);
    assert.equal(t.direction, 'unknown');
    assert.equal(t.reason, 'no-data');
    assert.deepEqual(t.series, []);
  }
});

test('the series is sale-days only, oldest first, with outlier days left out', () => {
  const t = computeTrend(pikachu());
  const prices = t.series.map((p) => p.price);
  assert.ok(!prices.includes(13.05), 'the junk-sale day would flatten the chart');
  assert.ok(!prices.includes(440), 'so would the single $440 sale');
  assert.equal(t.outliersHidden, 2);
  assert.equal(t.series[0].date < t.series.at(-1).date, true);
  assert.equal(t.series.at(-1).price, 72.91);
});

test('a well-behaved card hides nothing from its chart', () => {
  const t = computeTrend(genesect());
  assert.equal(t.outliersHidden, 0);
  assert.equal(t.series.length, genesect().filter((d) => d.transactions > 0).length);
});

test('the trend counts what it was based on', () => {
  const t = computeTrend(pikachu());
  assert.equal(t.recent.days, 7);
  assert.equal(t.recent.sales, 270);
  assert.equal(t.prior.days, 7);
  assert.equal(t.prior.sales, 98 + 48 + 27 + 28 + 43 + 29 + 34);
});

// ---- a spike that has already faded -----------------------------------------
// Real, seen live (product 716232): ~$120 for four days, then back to ~$75.
// The week as a whole is far above the week before, so the headline is "up" —
// but the card is falling right now, and the arrow alone would mislead.

const spike = () => normalizeBuckets(daily([
  [75.1, 11], [75.13, 43], [81.6, 34],            // last three days: crashing back
  [112.82, 18], [117.14, 23], [116.32, 64], [122.67, 64], // the spike
  ...flatRun(75, 40, 7),                          // the week before
]));

test('a spike that has already faded is flagged as turning down, though the week is up', () => {
  const t = computeTrend(spike());
  assert.equal(t.direction, 'up');
  assert.ok(t.pct > 0.3);
  assert.equal(t.turning, 'down');
  assert.equal(t.latest.days, 3);
  assert.ok(Math.abs(t.latest.median - 75.13) < 0.005);
});

test('the mirror image: a slide that has already bounced is flagged as turning up', () => {
  const days = normalizeBuckets(daily([
    [90, 20], [88, 20], [86, 20],
    [60, 30], [62, 30], [61, 30], [63, 30],
    ...flatRun(90, 30, 7),
  ]));
  const t = computeTrend(days);
  assert.equal(t.direction, 'down');
  assert.equal(t.turning, 'up');
});

test('an ordinary trend is not flagged', () => {
  assert.equal(computeTrend(pikachu()).turning, null);
  const steady = normalizeBuckets(daily([...flatRun(120, 4, 7), ...flatRun(100, 4, 7)]));
  assert.equal(computeTrend(steady).turning, null);
});

test('a flat or unknown card has nothing to turn', () => {
  assert.equal(computeTrend(genesect()).turning, null);
  assert.equal(computeTrend([]).turning, null);
});

test('a small wobble in the last three days is not a turn', () => {
  // Three days 3% away from the week's median is inside the noise.
  const days = normalizeBuckets(daily([
    [97, 20], [97, 20], [97, 20],
    ...flatRun(100, 20, 4),
    ...flatRun(80, 20, 7),
  ]));
  const t = computeTrend(days);
  assert.equal(t.direction, 'up');
  assert.equal(t.turning, null);
});

const pts = (...prices) => prices.map((price, i) => ({ date: `2026-09-${String(i + 1).padStart(2, '0')}`, price }));

test('volatility is the mean absolute day-to-day change', () => {
  // 10 -> 11 (+10%), 11 -> 10 (-9.09%), 10 -> 11 (+10%), 11 -> 10 (-9.09%): mean 9.55%.
  assert.ok(Math.abs(volatility(pts(10, 11, 10, 11, 10)) - 0.0954545) < 1e-6);
});

test('a steady slide is calm, and a choppy card is volatile', () => {
  const slide = volatility(pts(100, 99, 98, 97, 96, 95));
  const choppy = volatility(pts(100, 110, 95, 112, 94, 111));
  assert.ok(slide < 0.011, `slide ${slide}`);
  assert.ok(choppy > 0.15, `choppy ${choppy}`);
  assert.equal(volatility(pts(10, 10, 10, 10, 10)), 0);
});

test('volatility needs enough sale-days, and ignores junk points', () => {
  assert.equal(MIN_VOLATILITY_POINTS, 5);
  assert.equal(volatility(pts(10, 11, 12, 13)), null);
  assert.equal(volatility(pts(10, 11, 12, 13, 14)) > 0, true);
  assert.equal(volatility([]), null);
  assert.equal(volatility(null), null);
  assert.equal(volatility(undefined), null);
  assert.equal(volatility([null, { price: 'x' }, { price: 0 }, { price: -1 }, {}]), null);
});

test('volatility on real data: a busy falling card swings a few percent a day, a quiet flat one hardly at all', () => {
  const pika = computeTrend(parseHistory(PIKACHU_HISTORY, { condition: 'Near Mint Holofoil' }).days);
  const gen = computeTrend(parseHistory(GENESECT_HISTORY, { condition: 'Near Mint Holofoil' }).days);
  assert.ok(volatility(pika.series) > 0.03 && volatility(pika.series) < 0.07, String(volatility(pika.series)));
  assert.ok(volatility(gen.series) < 0.01, String(volatility(gen.series)));
});

test('the junk $13.05 and $440 days do not make a card look volatile', () => {
  const pika = computeTrend(parseHistory(PIKACHU_HISTORY, { condition: 'Near Mint Holofoil' }).days);
  assert.ok(volatility(pika.series) < 0.07, 'outlier days are already out of the series');
});

test('the current price is the median of the newest days\' sales', () => {
  const pika = computeTrend(parseHistory(PIKACHU_HISTORY, { condition: 'Near Mint Holofoil' }).days);
  assert.equal(currentPrice(pika), 72.91);
});

test('the current price falls back to the chart when the trend could not be called', () => {
  assert.equal(currentPrice({ latest: null, series: pts(10, 20, 30, 40, 50) }), 40);
  assert.equal(currentPrice({ latest: null, series: pts(7) }), 7);
});

test('no current price without any sales', () => {
  for (const t of [null, undefined, {}, { latest: null, series: [] }, { series: [{ price: 0 }] }]) assert.equal(currentPrice(t), null);
});

// ---- several durations -------------------------------------------------------------

/** Thirty days ending 30 Sep, newest first: today, yesterday, then steady. */
const stepped = (today, yesterday, rest = [10, 6]) => normalizeBuckets(daily([today, yesterday, ...Array.from({ length: 28 }, () => rest)]));

test('every duration on offer is worked out, each from its own two periods', () => {
  assert.deepEqual(TREND.DURATIONS, [1, 3, 7, 14]);
  assert.deepEqual(TREND.DEFAULT_DURATIONS, [7]);
  const t = computeTrend(stepped([12, 6], [10, 6]));
  assert.deepEqual(Object.keys(t.windows).map(Number), [1, 3, 7, 14]);
  assert.equal(t.asOf, '2026-09-30', 'the day the periods are measured back from');
  // 1 day: today 12 against yesterday 10.
  assert.deepEqual([t.windows[1].direction, t.windows[1].pct, t.windows[1].windowDays], ['up', 0.2, 1]);
  assert.deepEqual([t.windows[1].recent.days, t.windows[1].prior.days], [1, 1]);
  // Longer periods are medians, so one day at 12 does not move them.
  for (const n of [3, 7, 14]) assert.deepEqual([t.windows[n].direction, t.windows[n].pct, t.windows[n].reason], ['flat', 0, 'ok'], String(n));
  assert.deepEqual([t.windows[14].recent.days, t.windows[14].prior.days], [14, 14]);
});

test('the headline fields are what they were: 7 days, or 14 for a quiet card', () => {
  const t = computeTrend(pikachu());
  assert.equal(t.windowDays, 7);
  assert.equal(t.direction, t.windows[7].direction);
  assert.equal(t.pct, t.windows[7].pct);
  assert.deepEqual(t.recent, t.windows[7].recent);
});

test('a short period needs five sales and a sale on each of its days, up to three', () => {
  // Four sales today: not enough for 1 day, however clear the move.
  assert.equal(computeTrend(stepped([12, 4], [10, 6])).windows[1].reason, 'not-enough-sales');
  assert.equal(computeTrend(stepped([12, 5], [10, 5])).windows[1].reason, 'ok');
  // Nothing sold yesterday: nothing to compare today with.
  const gap = computeTrend(stepped([12, 6], [10, 0]));
  assert.equal(gap.windows[1].reason, 'not-enough-sales');
  assert.equal(gap.windows[1].direction, 'unknown');
  assert.equal(gap.windows[1].pct, null);
  // 3 days needs all three; a missing day leaves two.
  assert.equal(gap.windows[3].reason, 'not-enough-sales');
  assert.equal(gap.windows[7].reason, 'ok', 'a week still has plenty');
});

test('a card with no sales has no windows to show', () => {
  const none = computeTrend([]);
  assert.equal(none.windows, undefined);
  assert.deepEqual(selectTrendLines(none, [7, 1]), []);
  assert.deepEqual(selectTrendLines(null, [7]), []);
});

test('the durations asked for are cleaned: known ones only, once each, longest first, never none', () => {
  assert.deepEqual(cleanDurations([1, 7]), [7, 1]);
  assert.deepEqual(cleanDurations(['3', 14, 14, 2, 'x', null]), [14, 3]);
  for (const bad of [[], undefined, null, 'seven', [30, 0]]) assert.deepEqual(cleanDurations(bad), [7]);
  assert.notEqual(cleanDurations(null), TREND.DEFAULT_DURATIONS, 'a copy, so nothing can change the default');
});

test('one line per chosen duration, longest first, and the first is the headline', () => {
  const t = computeTrend(stepped([12, 6], [10, 6]));
  const lines = selectTrendLines(t, [1, 7]);
  assert.deepEqual(lines.map((l) => [l.days, l.shownDays, l.direction, l.headline]), [[7, 7, 'flat', true], [1, 1, 'up', false]]);
  assert.equal(lines[1].pct, 0.2);
  assert.deepEqual(selectTrendLines(t).map((l) => l.days), [7], 'seven days when nothing is chosen');
  assert.deepEqual(selectTrendLines(t, [14, 7, 3, 1]).map((l) => l.days), [14, 7, 3, 1]);
});

test('a quiet card\'s 7 days widen to 14, unless 14 has a line of its own', () => {
  // One sale every other day: 4 sale-days a week (too few sales), 7 a fortnight.
  const quiet = computeTrend(normalizeBuckets(daily(Array.from({ length: 30 }, (_, i) => [10, i % 2 === 0 ? 1 : 0]))));
  assert.equal(quiet.windows[7].reason, 'not-enough-sales');
  assert.equal(quiet.windows[14].reason, 'ok');
  const [alone] = selectTrendLines(quiet, [7]);
  assert.deepEqual([alone.days, alone.shownDays, alone.reason], [7, 14, 'ok']);
  const both = selectTrendLines(quiet, [14, 7]);
  assert.deepEqual(both.map((l) => [l.days, l.shownDays, l.reason]), [[14, 14, 'ok'], [7, 7, 'not-enough-sales']]);
  assert.deepEqual(selectTrendLines(quiet, [1]).map((l) => [l.shownDays, l.reason, l.direction]), [[1, 'not-enough-sales', 'unknown']]);
});

test('a trend made without windows still gives its headline line', () => {
  const old = { direction: 'down', pct: -0.16, windowDays: 7, recent: { median: 1 }, prior: { median: 2 } };
  assert.deepEqual(selectTrendLines(old, [1, 3]).map((l) => [l.days, l.shownDays, l.direction, l.headline]), [[7, 7, 'down', true]]);
  assert.deepEqual(selectTrendLines({ direction: 'unknown', reason: 'unavailable' }, [7]), []);
});

test('the rules version changed with the windows, so cached trends are worked out again', () => {
  assert.equal(TREND.VERSION, 3);
});
