# TCGPlayer+

A Firefox extension that adds what TCGplayer is missing:

- **Saved Lists.** Keep products for later in your own lists (separate from
  Firefox bookmarks), each with a price trend and a 30-day chart.
- **Order History.** Your purchases laid out for reading, kept in this browser
  after TCGplayer stops listing them, with what each card would cost today and
  your total gain or loss, counting shipping on both sides.
- **Prices on TCGplayer's own order page**, right under what you paid.

The toolbar popup has one **Dashboard** button, which opens the **TCGPlayer+**
home page: one tab per view, opening on the one you used last.

## Install (temporary, for development)

```bash
npm install
npm run build
```

Then in Firefox: `about:debugging` → **This Firefox** → **Load Temporary
Add-on…** → pick `dist/manifest.json`.

**Firefox does not turn on site access for you.** After installing, open
`about:addons` → **TCGPlayer+** → **Permissions** and switch on access for
`www.tcgplayer.com` and `store.tcgplayer.com` (and the two `tcgplayer.com` API
hosts it lists). Without it the buttons and prices silently do not appear.

To produce a zip for signing or for `about:addons`:

```bash
npm run package
```

## Saved Lists

TCGplayer has no way to keep a product for later. On any product page the
extension adds a **Save to list** button beside the card name. Click it to tick
the lists it belongs in, or type a name to start a new one — creating a list
from that panel saves the card into it straight away. The button then reads
"Saved in 2 lists", so you can see at a glance what you have already kept.

**Manage lists** opens the Saved Lists tab of TCGPlayer+, where you
can rename and delete lists, remove items, and export everything as JSON.

These lists are deliberately separate from Firefox bookmarks: they live in the
extension's own storage, in this browser and profile only.

What is saved with each product:

- card name, set, collector number and rarity
- the language printing — the same product page serves several, priced
  differently, so English and Japanese count as different saves
- the image, and a clean link back (tracking parameters stripped)
- **the price at the time you saved it** — TCGplayer's Market Price, the lowest
  listing and its condition — so you can see later what has moved

Saving the same card twice is a no-op rather than a duplicate, and the original
save time is kept.

### Market Price versus Ask

Two different numbers are kept apart on purpose:

- **Market** is TCGplayer's own "Market Price": a figure it calculates from past
  sales. Here it is the value recorded when you saved the card, and is labelled
  as such.
- **Ask** is what buying the card costs today: the cheapest live listing
  in the card's condition and printing, **price plus shipping** (TCGplayer's
  featured `spotlight__listing`, with the breakdown: "Ask $10.49 ($9.50 +
  $0.99 shipping)"). It sits just after Market on every card, and is fetched as
  the card scrolls into view (cached for ten minutes). It is the price used for
  every gain or loss, and for sorting, because it is what you would actually pay.
  Listings that are "custom" (a seller's photo of one copy) are ignored, as they
  are on the product page.

The trend chart's "Recent sales" figure is a third thing again: what the card
has just been selling for. It is labelled that way, so it is never mistaken for
either of the others.

### Sorting

Every list has its own sort, in its header: **Date added** (the default, newest
first), **Ask** or **Volatility**, with a button to reverse the order.
Lists are ordered independently (Watching by volatility, Buy by Ask,
say), the choice is saved with the list, and a list with a single card has no
control because there is nothing to order.

- **Ask** orders by what each card costs to buy today, shipping included,
  so a $1 card with $20 postage does not look cheap. There is no stand-in while
  an ask loads (TCGplayer's Market Price is a different figure): a card whose ask
  is not known yet, or with nothing listed, sorts last whichever way round the
  list is.
- **Volatility** is how much the price typically moves from one day of sales to
  the next: "±4.5% a day" means it usually changes by about that much. A steady
  slide scores low and a choppy card scores high, which is the point: the
  direction is what the trend arrow is for. The junk outlier days are left out,
  and a card with fewer than five sale-days has no volatility and sorts last.
- What each order is based on is shown on the card.
- Choosing either sort looks up every card in that list, not only the ones on
  screen (two at a time, shared with any other list holding the same card). The
  page says how many it is loading, and re-sorts when they arrive. There is no
  sort by TCGplayer's Market Price, because it is not what buying costs.

### Price trend

Each saved item shows whether its price is moving **▲ up**, **▼ down** or
**▬ flat**, with the percentage change and a 30-day sparkline. Hover it for the
numbers behind it.

The trend is the **median daily sold price over the last 7 days compared with
the 7 days before**, read from the same price-history feed TCGplayer's own
product page draws its chart from. It deliberately does *not* use the
`spotlight__price`: that is the current lowest *asking* price, so comparing it
with sales says whether a listing is cheap, not which way the market is going.
Nor does it use the single latest sale, which is one noisy point (five sales in
eight hours spanned $71-$87 on one card).

The details that make it trustworthy:

- **Days with no sales are ignored.** TCGplayer repeats the previous price on a
  day nothing sold, so those days carry no information.
- **Medians, not averages.** Real days like $13.05 on 262 units (junk bulk
  sales) or a single $440 sale on a card that trades around $75-97 would wreck a
  mean. Such days are also left off the chart, and the tooltip says so.
- **Within ±3% is called flat.**
- **Quiet cards widen to 14 days vs 14.** Each period needs at least 5 sales on
  3 different days; if even 14 days is too thin it says "Not enough recent
  sales" rather than guessing.
- **A trend that has already turned is flagged.** A week-on-week median lags: a
  card that spiked to $120 and fell back to $75 still reads "up" for the week
  while dropping today. When the newest three days of sales are moving against
  the arrow by 5% or more, it adds "but falling in the last 3 days".
- **Colour.** Rising is green and falling is red, as on the order pages. A flat
  or unknown trend stays grey. The colour says which way it moved, not whether
  that is good news for you.

Trends are fetched only for items that scroll into view, at most two requests at
a time, and cached for six hours (the popup's **Clear price cache** removes them). If
TCGplayer's feed is unreachable the row says "Trend unavailable" and nothing else
is affected. The feed is undocumented, so it could change without notice.

## The TCGPlayer+ home page

The toolbar popup's **Dashboard** button opens a page with one tab per view: **Saved Lists** (above) and **Order History**. It opens on the tab you used last.

### Order History tab

Your TCGplayer purchases, laid out for reading: for each order the date, order number, seller, channel, shipping status and totals, and for each item its name (linked to the product page), set, rarity, condition, the price you paid, and what it would cost today (same method, colours and caveats as on TCGplayer's own order page, below). At the top, the **total gain or loss** across the orders shown, and each order's own.

- **Not shown, and never stored:** SHIP TO, BILL TO, your name, addresses, and the Contact Seller / Rate Transaction buttons. The reader names the fields it wants rather than filtering out the ones it does not; a test proves no address text can reach storage.
- **Where it comes from.** Opening the tab reads your Order History from TCGplayer using your signed-in session (only if the last read is over ten minutes old; **Refresh** forces it). Visiting TCGplayer's own Order History page also saves what it shows.
- **Kept here.** Every order read is added to the extension's local storage, keyed by order number, and never removed by a later read. TCGplayer only lists the last 120 days by default, so this is how older orders are still here. **Clear saved orders** deletes them (they can be read again only while TCGplayer still lists them). Only order details are kept, never addresses or payment information.
- **Range picker.** Last 30 / 90 / 120 days, or a year, or **All saved** (everything kept here; reads nothing). Choosing a TCGplayer range also changes the range on TCGplayer's own Order History page, exactly as its dropdown does, because TCGplayer keeps that choice on your account. A leftover search on that page is cleared too, or it would silently hide orders.
- **If it says you are not signed in.** Sign in at TCGplayer, come back, and press Refresh. If Firefox does not send your login to the extension, visiting the real Order History page still fills the archive.
- Text and URLs from TCGplayer are only ever shown as text or as checked http(s) links.

## Today's price on TCGplayer's own Order History page

On `store.tcgplayer.com/myaccount/orderhistory`, each item you bought gets a line under the price you paid:

```
$13.99
Ask $10.81
▼ −$3.18 (−23%)
```

- **What "Ask" means, and what "paid" means: price plus shipping, on both sides.** **Ask** (not TCGplayer's calculated Market Price) is the cheapest live listing in the *same condition and printing* you bought (Near Mint Holofoil, say), ranked by price plus shipping as TCGplayer's own default sort does, and shown as that total ($9.50 + $0.99 shipping = $10.49). What you paid is the item price plus its share of that order's shipping (shipping is charged per parcel, so it is spread across the items in proportion to their price). The gain or loss compares those two totals. Tax is left out: it depends on where you live, not on the card. The order page keeps TCGplayer's own PRICE column as it is and puts the totals beneath it; hover for the breakdown. Custom listings (a seller's photo of one particular copy) are ignored, as the product page's headline price does.
- **Green and red.** ▲ in green means it is worth more now than you paid, ▼ in red less, ▬ in grey about the same (within 1%). This treats you as a holder; the Ask is what it would cost to buy today, not what you would get selling it.
- **A total at the top of the page.** Above the first order, the combined change for every item on the page: what you paid, their Ask, and the difference in dollars and percent, in green or red. Items with no live listing or no readable price are left out and counted separately ("6 without a price") so the total is never mistaken for the whole page. Quantities are multiplied in. Both sides include shipping (see above); tax is excluded.
- **Custom listings are ignored** (a seller's photo of one particular copy), as the product page's headline price does.
- **No account access.** The extension reads the item tables already on the page you are looking at, and asks TCGplayer's public listings service for prices. Nothing about your account or orders is sent anywhere.
- **Limits.** Prices are cached for 10 minutes, because cheap listings sell within the hour. In the TCGPlayer+ tab each price also shows its shipping, seller and how long ago it was checked, so it can be compared with the product page's featured listing; **Refresh** there re-checks every price. "No ask" means no live listing matches that condition. The listings service is undocumented, so a change on TCGplayer's side shows as "Price unavailable" rather than breaking the page. Quantities above one are compared per item, as the page's PRICE column is per item.

## Development

```bash
npm test          # builds, then runs the unit + integration tests
npm run build     # bundle src/ into dist/
```

- `src/lib/` — the logic, dependency-injected and unit tested, with no browser
  globals: parsing the order pages, the price-plus-shipping cost, the trend
  maths, the archive, the views as pure DOM builders.
- `src/content/` — thin glue on TCGplayer's own pages (the Save button on
  product pages, the prices on the order page).
- `src/background.js` — owns every network request, the caches and the request
  pacing.
- `src/home/` — the TCGPlayer+ home page: tabs, and one module per view
  (`views/lists.js`, `views/orders.js`). An extension page, not a content script.
- `src/popup/` — the toolbar popup.
- `test/` — `node:test` + jsdom. The `*Integration` tests run the *built*
  bundles together (background, home page, content scripts) with a stubbed
  WebExtension API and a stubbed TCGplayer.
- `test/fixtures/` holds real TCGplayer responses and order markup, with names,
  addresses and order numbers replaced by fakes.

## Caveats

- TCGplayer's price-history, listings and order pages are not a public API.
  If they change, the affected feature shows "unavailable" rather than breaking
  the page; `src/lib/tcgplayerHistory.js`, `tcgplayerListings.js` and
  `orderParse.js` are where to look, and the fixtures are where to start.
- Whether Firefox sends your TCGplayer login when the extension reads your order
  pages cannot be assumed. If the Order History tab says you are not signed in
  when you are, visiting TCGplayer's own Order History page still saves what it
  shows.
- The Ask is what a card would cost to buy today, not what you would get selling
  it. The green and red are a holder's view of that.
- This is a decision aid, not investment advice. Condition, centering,
  population and provenance all move real prices in ways a median cannot see.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
