// Real response shape from
//   POST https://mp-search-api.tcgplayer.com/v1/product/696683/listings
// captured 30 Sep 2026 (Lapras 131/128, Near Mint), trimmed to the fields read.
// The cheapest row is a "custom" listing (a seller's own photo of one copy),
// which the page's headline price ignores, so the extension must too.
const listing = (price, listingType, sellerName, shippingPrice = 1.49) => ({
  price, listingType, sellerName, shippingPrice, quantity: 1, condition: 'Near Mint', printing: 'Holofoil',
});

export const LAPRAS_LISTINGS = {
  errors: [],
  results: [{
    totalResults: 205,
    results: [
      listing(7, 'custom', 'Holyshirtpro', 1.25),
      listing(9.32, 'standard', 'Xerneas'),
      listing(9.5, 'standard', 'Simple Needs Gaming'),
      listing(9.5, 'standard', 'Dynamic Pulls TCG'),
    ],
  }],
};

export const NO_LISTINGS = { errors: [], results: [{ totalResults: 0, results: [] }] };
