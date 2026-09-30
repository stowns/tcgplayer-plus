import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { productImageUrl, imageCandidates, loadFirstWorking } from '../src/lib/productImage.js';

const img = () => new JSDOM('<body><img></body>').window.document.querySelector('img');
const fail = (el) => el.dispatchEvent(new el.ownerDocument.defaultView.Event('error'));

test('the picture is built from the product id alone', () => {
  assert.equal(productImageUrl('716226'), 'https://tcgplayer-cdn.tcgplayer.com/product/716226_in_200x200.jpg');
  assert.equal(productImageUrl(696683), 'https://tcgplayer-cdn.tcgplayer.com/product/696683_in_200x200.jpg');
});

test('a missing or non-numeric id gives no picture, and cannot be used to build a path', () => {
  for (const bad of ['', null, undefined, 'abc', '12/../3', '1 2', '../x']) assert.equal(productImageUrl(bad), '');
});

test('candidates: the reliable picture first, the saved one as a fallback, no repeats', () => {
  const big = 'https://tcgplayer-cdn.tcgplayer.com/product/716226_in_1000x1000.jpg';
  assert.deepEqual(imageCandidates('716226', big), [productImageUrl('716226'), big]);
  assert.deepEqual(imageCandidates('716226', productImageUrl('716226')), [productImageUrl('716226')]);
});

test('an item saved with no picture still gets one; an item with no id keeps its saved one', () => {
  assert.deepEqual(imageCandidates('716226', ''), [productImageUrl('716226')]);
  assert.deepEqual(imageCandidates(null, 'https://x/y.jpg'), ['https://x/y.jpg']);
  assert.deepEqual(imageCandidates(null, ''), []);
});

test('only https pictures are ever used', () => {
  assert.deepEqual(imageCandidates(null, 'http://x/y.jpg'), []);
  assert.deepEqual(imageCandidates(null, 'javascript:alert(1)'), []);
  assert.deepEqual(imageCandidates(null, 'data:image/png;base64,AAAA'), []);
  assert.deepEqual(imageCandidates(null, 5), []);
});

test('loading starts with the first candidate', () => {
  const el = img();
  loadFirstWorking(el, ['https://a/1.jpg', 'https://a/2.jpg']);
  assert.equal(el.getAttribute('src'), 'https://a/1.jpg');
});

test('a picture that fails to load is replaced by the next candidate', () => {
  const el = img();
  loadFirstWorking(el, ['https://a/1.jpg', 'https://a/2.jpg']);
  fail(el);
  assert.equal(el.getAttribute('src'), 'https://a/2.jpg');
  assert.equal(el.hidden, false);
});

test('when every candidate fails the picture is hidden, not left as a broken icon', () => {
  const el = img();
  loadFirstWorking(el, ['https://a/1.jpg', 'https://a/2.jpg']);
  fail(el);
  fail(el);
  assert.equal(el.hidden, true);
  assert.equal(el.getAttribute('data-failed'), '1');
  assert.equal(el.hasAttribute('src'), false);
  fail(el); // a stray extra event changes nothing
  assert.equal(el.hidden, true);
});
