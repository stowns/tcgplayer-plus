// A search page's results as TCGplayer draws them in grid view, cut down from the live
// markup of /search/pokemon/sv-scarlet-and-violet-151 (product data only).
const card = ({ id, slug, name, number, rarity, set = 'SV: Scarlet &amp; Violet 151', from = '$13.74', market = '$16.30', listings = 338 }) => `
<div class="search-result"><div class="search-result__content" tabindex="0"><div class="search-result__product">
  <div class="product-card"><div class="product-card__content" tabindex="0">
    <a href="/product/${id}/${slug}?page=1" data-testid="product-card__image--0" tabindex="-1">
      <section class="product-card__product product-card__product-variant-a">
        <section class="product-card__image"><div class="lazy-image__wrapper"><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="${name} - ${number}" loading="lazy" class="v-lazy-image"></div></section>
        <h4 class="product-card__set-name"><div class="product-card__set-name__variant">${set}</div></h4>
        <section class="product-card__rarity bottom-margin"><div class="product-card__rarity__variant"><span>${rarity}, </span><span>#${number}</span></div></section>
        <span class="product-card__title truncate">${name} - ${number}</span>
        <div class="inventory"><div class="inventory__container"><span class="inventory__listing-count inventory__listing-count-block"><span>${listings} listings</span> from </span><span class="inventory__price"><span class="inventory__price-with-shipping">${from}</span></span></div></div>
        <section class="product-card__market-price"><section><span>Market Price:</span><span class="product-card__market-price--value" tabindex="-1">${market}</span></section></section>
      </section>
    </a>
  </div></div>
</div></div></div>`;

export const CATERPIE = { id: '517016', slug: 'pokemon-sv-scarlet-and-violet-151-caterpie-172-165', name: 'Caterpie', number: '172/165', rarity: 'Illustration Rare' };
export const BULBASAUR = { id: '502445', slug: 'pokemon-sv-scarlet-and-violet-151-bulbasaur-001-165', name: 'Bulbasaur', number: '001/165', rarity: 'Common', from: '$0.10', market: '$0.18', listings: 912 };

export const SEARCH_URL = 'https://www.tcgplayer.com/search/pokemon/sv-scarlet-and-violet-151?productLineName=pokemon&page=1&view=grid';
export const searchPage = (cards = [CATERPIE, BULBASAUR]) => `<!doctype html><html><head><title>SV: Scarlet &amp; Violet 151 | Pokemon | TCGplayer</title></head>
<body><div class="search-layout"><section class="search-results">${cards.map(card).join('')}</section></div></body></html>`;
export const searchCard = card;
