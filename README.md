# TCGPlayer+

A Firefox and Chrome extension that adds what TCGplayer is missing:

- **Saved Lists.** Keep products for later in your own lists (separate from
  your bookmarks), each with a price trend and a 30-day chart.
- **Order History.** Your purchases laid out for reading, kept in this browser
  after TCGplayer stops listing them, with what each card would cost today and
  your total gain or loss, counting shipping on both sides.
- **Prices on TCGplayer's own order page**, right under what you paid.

Clicking the toolbar button opens the **TCGPlayer+** home page: one tab per
view, opening on the one you used last.

## Install (unpacked, for development)

```bash
npm install
npm run build
```

The build writes one unpacked extension per browser: `dist/firefox` and
`dist/chrome`.

**Firefox.** `about:debugging` → **This Firefox** → **Load Temporary Add-on…**
→ pick `dist/firefox/manifest.json`. Firefox does not turn on site access for
you: open `about:addons` → **TCGPlayer+** → **Permissions** and switch on access
for `www.tcgplayer.com` and `store.tcgplayer.com` (and the two `tcgplayer.com`
API hosts it lists). Without it the buttons and prices silently do not appear.

**Chrome.** `chrome://extensions` → switch on **Developer mode** → **Load
unpacked** → pick `dist/chrome`. Chrome grants the TCGplayer site access at
install, so there is nothing to switch on. Chrome shows a developer-mode
warning for unpacked extensions.

Each browser keeps its own lists and saved orders. Lists can be moved between
browsers with **Export JSON**; orders are read again from TCGplayer.

### Packaging for the stores

```bash
npm run package           # Chrome and Firefox, plus the source archive
npm run package:chrome    # just the Chrome zip
npm run package:firefox   # the Firefox zip and the source archive
```

Each writes to `release/`, named for the version in `package.json`:

- `tcgplayer-plus-<version>-chrome.zip` for the Chrome Web Store.
- `tcgplayer-plus-<version>-firefox.zip` for addons.mozilla.org.
- `tcgplayer-plus-<version>-source.zip`, also for addons.mozilla.org, which asks
  for the source of any bundled code. It is the repository's files (including
  ones not yet committed) without build output, `node_modules` or `examples/`,
  which holds saved pages of real orders and must never be published. To build
  it: `npm install && npm run build`.

Packaging stops before building if a manifest would be refused: a description
over Chrome's 132 characters, a name over 45, a version that is not 1 to 4
numbers or does not match `package.json`, or a missing icon size. Bump the
version in both `package.json` and `manifest/base.json` for each upload; the
stores refuse a version they already have.

## Saved Lists

TCGplayer has no way to keep a product for later. On any product page the
extension adds a **Save to list** button beside the card name. Click it to tick
the lists it belongs in, or type a name to start a new one — creating a list
from that panel saves the card into it straight away. The button then reads
"Saved in 2 lists", so you can see at a glance what you have already kept.

**Manage lists** opens the Saved Lists tab of TCGPlayer+, where you
can rename and delete lists, remove items, and export everything as JSON.

These lists are deliberately separate from your bookmarks: they live in the
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

### Choosing a list, and paging

The Saved Lists tab shows one list at a time. Pick it from the **List**
dropdown (each entry shows its card count). **Show** sets how many cards appear
at once: 25 (the default), 50, 75 or All. A list longer than that has a pager,
above and below its cards: "Showing 26–50 of 140" with **Previous** and
**Next**. Pages follow the list's own sort, so page 1 is always the top of the
order you chose.

The list you chose and the page size are remembered in this browser. Changing
the list, the page size or a sort returns to page 1, and a new list is shown as
soon as it is made. Prices are looked up only for the cards on the page you are
looking at; sorting by Ask or Volatility still loads every card in the list
shown, so the order is right across pages.

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
- **Within ±1% is called flat.**
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
a time, and cached for one hour, which is as long as TCGplayer's own response is
good for (**Clear price cache**, at the right of the dashboard's header, removes
them; saved lists and orders are never touched). TCGplayer's feed only accepts a
whole range (`month`, `quarter`, ...), not "just today", so a refresh fetches the
month again. If the feed stays unreachable the row says "Trend unavailable" and
nothing else is affected. The feed is undocumented, so it could change without
notice.

### When TCGplayer is slow or failing

Every request to TCGplayer (trends, asks, and reading your orders) goes through
one client that retries a failure that may pass, using **exponential backoff
with full jitter**
([AWS Architecture Blog, "Exponential Backoff And Jitter"](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)):

- The wait before retry *n* is a random time between 0 and
  `min(8 s, 0.5 s × 2^(n-1))`: up to 0.5, 1, 2, then 4 seconds. The randomness
  stops many requests that failed together from coming back together.
- Each attempt has five seconds, from when it starts until its answer has been
  read. If it takes longer it is cancelled and counts as failed, so it is retried
  like any other failure instead of leaving the screen waiting.
- At most four retries, so a request is tried at most five times.
- Retried: a dropped connection, a timeout, and HTTP 408, 425, 429, 500, 502, 503 and 504.
  Not retried: 400, 401, 403 and 404, which would fail the same way again.
- A server's `Retry-After` is honoured as a minimum wait; if it asks for more
  than 30 seconds the request is given up instead.
- Every attempt is still paced by the request throttle, and the wait between
  attempts does not hold a slot.

While a lookup is being retried the screen says so, so it never looks stuck: a
trend or an Ask shows "Retrying (2 of 4)…" in amber, with a tooltip saying
TCGplayer did not answer; a price on the Order History tab, or on TCGplayer's own
order page, does the same, and the totals above count it as still loading
("2 still loading (1 being retried)"); reading your orders says "TCGplayer did
not answer. Retrying (1 of 4)…". If it still fails after the last retry, the
usual "unavailable" wording appears, and a read of your orders keeps the pages it
did get and reports that it stopped part-way.

## The TCGPlayer+ home page

Clicking the toolbar button opens a page with one tab per view: **Saved Lists** (above) and **Order History**. It opens on the tab you used last. There is no popup in between.

### Order History tab

Your TCGplayer purchases, laid out for reading: for each order the date, order number, seller, channel, shipping status and totals, and for each item its name (linked to the product page), set, rarity, condition, the price you paid, and what it would cost today (same method, colours and caveats as on TCGplayer's own order page, below). At the top, the **total gain or loss** across the orders shown, and each order's own.

- **Not shown, and never stored:** SHIP TO, BILL TO, your name, addresses, and the Contact Seller / Rate Transaction buttons. The reader names the fields it wants rather than filtering out the ones it does not; a test proves no address text can reach storage.
- **Where it comes from.** Opening the tab reads your Order History from TCGplayer using your signed-in session (only if the last read is over ten minutes old; **Refresh** forces it). Visiting TCGplayer's own Order History page also saves what it shows.
- **Kept here.** Every order read is added to the extension's local storage, keyed by order number, and never removed by a later read. TCGplayer only lists the last 120 days by default, so this is how older orders are still here. **Clear saved orders** deletes them (they can be read again only while TCGplayer still lists them). Only order details are kept, never addresses or payment information.
- **Range picker.** Last 30 / 90 / 120 days, or a year, or **All saved** (everything kept here; reads nothing). Choosing a TCGplayer range also changes the range on TCGplayer's own Order History page, exactly as its dropdown does, because TCGplayer keeps that choice on your account. A leftover search on that page is cleared too, or it would silently hide orders.
- **If it says you are not signed in.** Sign in at TCGplayer, come back, and press Refresh. If the browser does not send your login to the extension, visiting the real Order History page still fills the archive.
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
npm test          # builds both browsers, then runs the unit + integration tests
npm run build     # bundle src/ into dist/firefox and dist/chrome (or: node scripts/build.js chrome)
npm run lint      # web-ext lint of the Firefox build
npm run build:stripes # the same, with the plain-stripes icon instead of the one with a +
```

- `src/lib/` — the logic, dependency-injected and unit tested, with no browser
  globals: parsing the order pages, the price-plus-shipping cost, the trend
  maths, the archive, the views as pure DOM builders.
- `src/content/` — thin glue on TCGplayer's own pages (the Save button on
  product pages, the prices on the order page).
- `src/background.js` — opens the dashboard when the toolbar button is clicked, and
  runs the price lookups, their caches and request pacing. It
  touches no DOM, because Chrome runs it as a service worker. Reading the order
  pages (which needs an HTML parser) happens in the Order History view instead,
  through `src/lib/orderReader.js`.
- `src/lib/retry.js`, `src/lib/httpClient.js` — the retry strategy (backoff with
  jitter) and the one client every request to TCGplayer goes through.
  `src/lib/retryState.js` is how a screen shows "retrying".
- `src/lib/runtime.js` — the one place that picks `browser` or `chrome` and
  answers messages in the way both browsers accept.
- `scripts/icon.js` — draws the icon (stripes in the TCGplayer logo's colours, in
  its order) as PNGs and an SVG, in two variants: `plus` (the default, a white + over
  the stripes) and `stripes` (the stripes alone).
  `node scripts/build.js [firefox|chrome|all] [--icon=plus|stripes]`.
- `manifest/` — `base.json` is shared; `firefox.json` and `chrome.json` hold the
  only differences (how the background is declared, and Firefox's add-on
  settings). `scripts/manifest.js` merges them into each build.
- `src/home/` — the TCGPlayer+ home page: tabs, and one module per view
  (`views/lists.js`, `views/orders.js`). An extension page, not a content script.
- `test/` — `node:test` + jsdom. The `*Integration` tests run the *built*
  bundles together (background, home page, content scripts) with a stubbed
  WebExtension API and a stubbed TCGplayer, once for each browser's build.
  `serviceWorker.test.js` runs the Chrome background with no DOM at all.
- `test/fixtures/` holds real TCGplayer responses and order markup, with names,
  addresses and order numbers replaced by fakes.

## Caveats

- TCGplayer's price-history, listings and order pages are not a public API.
  If they change, the affected feature shows "unavailable" rather than breaking
  the page; `src/lib/tcgplayerHistory.js`, `tcgplayerListings.js` and
  `orderParse.js` are where to look, and the fixtures are where to start.
- Whether the browser sends your TCGplayer login when the extension reads your order
  pages cannot be assumed. If the Order History tab says you are not signed in
  when you are, visiting TCGplayer's own Order History page still saves what it
  shows.
- The Ask is what a card would cost to buy today, not what you would get selling
  it. The green and red are a holder's view of that.
- This is a decision aid, not investment advice. Condition, centering,
  population and provenance all move real prices in ways a median cannot see.

## Licence

GPL-3.0-or-later. See [LICENSE](LICENSE).
