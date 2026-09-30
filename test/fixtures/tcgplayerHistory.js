// Real responses from
//   GET https://infinite-api.tcgplayer.com/price/history/{id}/detailed?range=month
// captured 30 Sep 2026, trimmed to the fields the extension reads. Buckets are
// newest first, one per day. The awkward days are genuine, not invented:
//   * Pikachu 26 Sep: $13.05 on 262 units, low sale $1 (junk bulk sales)
//   * Pikachu 15 Sep: a single $440 sale
//   * days with no sales repeat the previous price (Genesect) — and Pikachu's
//     14 Sep even carries a stray $5.94 with no sales at all.

// [date, marketPrice, quantitySold, transactionCount, lowSale, highSale]
const row = ([d, mp, q, tx, lo, hi]) => ({
  marketPrice: String(mp),
  quantitySold: String(q),
  lowSalePrice: String(lo),
  highSalePrice: String(hi),
  transactionCount: String(tx),
  bucketStartDate: `2026-${d}`,
});
const quiet = (d) => [d, 0, 0, 0, 0, 0];

const PIKACHU_NM = [
  ['09-30', 72.91, 4, 4, 71.22, 75.61], ['09-29', 72.54, 43, 39, 67, 86.92],
  ['09-28', 73.62, 58, 56, 67.5, 82.72], ['09-27', 75.54, 40, 38, 45.62, 81],
  ['09-26', 13.05, 262, 80, 1, 123.3], ['09-25', 81.36, 27, 27, 75, 105],
  ['09-24', 82.87, 26, 26, 62.8, 97.2], ['09-23', 80.84, 34, 34, 75.99, 86.99],
  ['09-22', 81.86, 31, 29, 74.96, 87], ['09-21', 92.3, 44, 43, 80, 275],
  ['09-20', 87.53, 28, 28, 83, 149], ['09-19', 97.08, 28, 27, 90, 135.24],
  ['09-18', 96.98, 48, 48, 67.5, 113.72], ['09-17', 86.41, 99, 98, 70, 127.49],
  ['09-16', 88.4, 113, 113, 75, 299], ['09-15', 440, 1, 1, 440, 440],
  ['09-14', 5.94, 0, 0, 0, 0],
  ...['09-13', '09-12', '09-11', '09-10', '09-09', '09-08', '09-07', '09-06',
    '09-05', '09-04', '09-03', '09-02', '09-01'].map(quiet),
];

const GENESECT_NM = [
  ['09-30', 45.59, 1, 1, 42.85, 42.85], ['09-29', 45.74, 0, 0, 0, 0],
  ['09-28', 45.74, 1, 1, 49.8, 49.8], ['09-27', 45.56, 0, 0, 0, 0],
  ['09-26', 45.56, 1, 1, 46.97, 46.97], ['09-25', 45.54, 1, 1, 44.39, 44.39],
  ['09-24', 45.58, 0, 0, 0, 0], ['09-23', 45.58, 3, 3, 42.72, 43.95],
  ['09-22', 45.82, 1, 1, 42.45, 42.45], ['09-21', 46.03, 1, 1, 49.98, 49.98],
  ['09-20', 45.85, 1, 1, 41.99, 41.99], ['09-19', 46.05, 0, 0, 0, 0],
  ['09-18', 46.05, 0, 0, 0, 0], ['09-17', 46.05, 0, 0, 0, 0],
  ['09-16', 46.05, 0, 0, 0, 0], ['09-15', 46.05, 0, 0, 0, 0],
  ['09-14', 46.05, 0, 0, 0, 0], ['09-13', 46.05, 5, 5, 43.71, 45.91],
  ['09-12', 45.91, 0, 0, 0, 0], ['09-11', 45.91, 1, 1, 45, 45],
  ['09-10', 45.99, 2, 2, 45, 51.85], ['09-09', 45.85, 0, 0, 0, 0],
  ['09-08', 45.85, 3, 3, 44.5, 45.98], ['09-07', 45.88, 0, 0, 0, 0],
  ['09-06', 45.88, 2, 2, 44.72, 45.99], ['09-05', 45.85, 1, 1, 45.61, 45.61],
  ['09-04', 45.93, 2, 1, 50, 50], ['09-03', 45.69, 1, 1, 46.6, 46.6],
  ['09-02', 45.62, 1, 1, 45.22, 45.22], ['09-01', 45.61, 3, 3, 45.36, 46.49],
];

const sku = (skuId, condition, variant, total, buckets, language = 'English') => ({
  skuId, variant, language, condition,
  averageDailyQuantitySold: '0',
  totalQuantitySold: String(total),
  totalTransactionCount: String(total),
  trendingMarketPricePercentages: {},
  buckets: buckets.map(row),
});

/** Pikachu ex 149/128 (product 712953): a busy, brand-new card. */
export const PIKACHU_HISTORY = {
  count: 2,
  result: [
    sku('9465652', 'Near Mint', 'Holofoil', 886, PIKACHU_NM),
    // LP is trimmed to the newest days; only its identity matters to the tests.
    sku('9465653', 'Lightly Played', 'Holofoil', 17, [
      ['09-30', 84.03, 0, 0, 0, 0], ['09-29', 84.03, 3, 3, 68.99, 68.99],
    ]),
  ],
};

/** Genesect ex 169/086 (product 642621): about one sale a day. */
export const GENESECT_HISTORY = {
  count: 2,
  result: [
    sku('8816227', 'Near Mint', 'Holofoil', 37, GENESECT_NM),
    sku('8816228', 'Lightly Played', 'Holofoil', 2, [['09-30', 44.35, 0, 0, 0, 0]]),
  ],
};

/**
 * SYNTHETIC — a product with several printings, to exercise SKU choice. Real
 * multi-variant responses have exactly this shape; only the numbers are made up.
 */
export const MULTI_VARIANT_HISTORY = {
  count: 6,
  result: [
    sku('1', 'Near Mint', 'Normal', 900, [['09-30', 1, 1, 1, 1, 1]]),
    sku('2', 'Near Mint', 'Reverse Holofoil', 300, [['09-30', 2, 1, 1, 2, 2]]),
    sku('3', 'Near Mint', 'Holofoil', 120, [['09-30', 3, 1, 1, 3, 3]]),
    sku('4', 'Lightly Played', 'Reverse Holofoil', 40, [['09-30', 4, 1, 1, 4, 4]]),
    sku('5', 'Near Mint', 'Normal', 50, [['09-30', 5, 1, 1, 5, 5]], 'Japanese'),
    sku('6', 'Damaged', 'Holofoil', 0, [['09-30', 6, 0, 0, 0, 0]]),
  ],
};

export { row as historyRow };
