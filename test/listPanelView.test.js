import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import {
  saveButtonLabel, renderSaveControl, PANEL_CLASS, BUTTON_CLASS,
} from '../src/lib/listPanelView.js';

const doc = () => new JSDOM('<body><div class="product-details__header"><h1>Card</h1></div></body>').window.document;
const lists = [
  { id: 'a', name: 'Watchlist', items: [] },
  { id: 'b', name: 'Trades', items: [] },
];

test('saveButtonLabel says what will happen, or what already has', () => {
  assert.equal(saveButtonLabel(0), 'Add to watch list');
  assert.equal(saveButtonLabel(1), 'On 1 watch list');
  assert.equal(saveButtonLabel(3), 'On 3 watch lists');
});

test('renderSaveControl builds a button that reflects saved state', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: ['a'], handlers: {} });
  d.body.append(control);
  const button = control.querySelector(`.${BUTTON_CLASS}`);
  assert.equal(button.textContent, 'On 1 watch list');
  assert.equal(button.getAttribute('aria-expanded'), 'false');
  assert.equal(control.querySelector(`.${PANEL_CLASS}`).hidden, true, 'the panel starts closed');
});

test('clicking the button opens the panel with a row per list', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: ['b'], handlers: {} });
  d.body.append(control);
  control.querySelector(`.${BUTTON_CLASS}`).click();

  const panel = control.querySelector(`.${PANEL_CLASS}`);
  assert.equal(panel.hidden, false);
  const boxes = [...panel.querySelectorAll('input[type="checkbox"]')];
  assert.deepEqual(boxes.map((b) => b.value), ['a', 'b']);
  assert.deepEqual(boxes.map((b) => b.checked), [false, true]);
  assert.deepEqual([...panel.querySelectorAll('.ptcg-list-row span')].map((s) => s.textContent), ['Watchlist', 'Trades']);
});

test('ticking a list asks to save, unticking asks to remove', () => {
  const d = doc();
  const calls = [];
  const control = renderSaveControl(d, {
    lists, savedIn: ['b'], handlers: { onToggle: (id, checked) => calls.push([id, checked]) },
  });
  d.body.append(control);
  control.querySelector(`.${BUTTON_CLASS}`).click();
  const [watchlist, trades] = control.querySelectorAll('input[type="checkbox"]');

  watchlist.checked = true;
  watchlist.dispatchEvent(new d.defaultView.Event('change'));
  trades.checked = false;
  trades.dispatchEvent(new d.defaultView.Event('change'));
  assert.deepEqual(calls, [['a', true], ['b', false]]);
});

test('a new list can be created from the panel, and blank names are refused', () => {
  const d = doc();
  const created = [];
  const control = renderSaveControl(d, {
    lists, savedIn: [], handlers: { onCreate: (name) => created.push(name) },
  });
  d.body.append(control);
  control.querySelector(`.${BUTTON_CLASS}`).click();

  const form = control.querySelector('form');
  const input = form.querySelector('input[type="text"]');
  input.value = '   ';
  form.dispatchEvent(new d.defaultView.Event('submit', { cancelable: true }));
  assert.deepEqual(created, [], 'a blank name creates nothing');

  input.value = '  Buy soon  ';
  form.dispatchEvent(new d.defaultView.Event('submit', { cancelable: true }));
  assert.deepEqual(created, ['Buy soon']);
  assert.equal(input.value, '', 'the field is cleared for the next one');
});

test('with no lists yet, the panel explains rather than showing nothing', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists: [], savedIn: [], handlers: {} });
  d.body.append(control);
  control.querySelector(`.${BUTTON_CLASS}`).click();
  assert.match(control.querySelector(`.${PANEL_CLASS}`).textContent, /No lists yet/i);
});

test('the panel offers a way through to managing lists', () => {
  const d = doc();
  const opened = [];
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: { onManage: () => opened.push(1) } });
  d.body.append(control);
  control.querySelector(`.${BUTTON_CLASS}`).click();
  control.querySelector('.ptcg-list-manage').click();
  assert.equal(opened.length, 1);
});

test('an error is shown in the panel instead of being swallowed', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  d.body.append(control);
  control.querySelector(`.${BUTTON_CLASS}`).click();
  control.showError('"Trades" is full (500 items)');
  assert.match(control.querySelector('.ptcg-list-error').textContent, /is full/);
});

test('the control refreshes in place when lists change', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  d.body.append(control);
  control.querySelector(`.${BUTTON_CLASS}`).click();
  control.update({ lists: [...lists, { id: 'c', name: 'Grails', items: [] }], savedIn: ['c'] });

  assert.equal(control.querySelector(`.${BUTTON_CLASS}`).textContent, 'On 1 watch list');
  assert.equal(control.querySelectorAll('input[type="checkbox"]').length, 3);
  assert.equal(control.querySelector(`.${PANEL_CLASS}`).hidden, false, 'it stays open while you work');
});

const open = (d, control) => {
  d.body.append(control);
  control.querySelector(`.${BUTTON_CLASS}`).click();
  return control.querySelector(`.${PANEL_CLASS}`);
};

test('clicking outside the panel closes it', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  const panel = open(d, control);
  assert.equal(panel.hidden, false);

  d.body.click();
  assert.equal(panel.hidden, true);
  assert.equal(control.querySelector(`.${BUTTON_CLASS}`).getAttribute('aria-expanded'), 'false');
});

test('clicking inside the panel leaves it open', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  const panel = open(d, control);

  panel.querySelector('input[type="checkbox"]').click();
  panel.querySelector('input[type="text"]').click();
  panel.click();
  assert.equal(panel.hidden, false, 'ticking a list must not dismiss the panel mid-task');
});

test('pressing Escape closes the panel and returns focus to the button', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  const panel = open(d, control);
  const button = control.querySelector(`.${BUTTON_CLASS}`);

  d.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.hidden, true);
  assert.equal(d.activeElement, button);
});

test('other keys do not close the panel', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  const panel = open(d, control);
  d.dispatchEvent(new d.defaultView.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  assert.equal(panel.hidden, false);
});

test('the button still toggles the panel, and is not closed by its own click', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  const panel = open(d, control);
  const button = control.querySelector(`.${BUTTON_CLASS}`);
  assert.equal(panel.hidden, false, 'opening click is not treated as an outside click');
  button.click();
  assert.equal(panel.hidden, true);
  button.click();
  assert.equal(panel.hidden, false);
});

test('a closed panel keeps no listeners on the page', () => {
  const d = doc();
  const added = [];
  const removed = [];
  const realAdd = d.addEventListener.bind(d);
  const realRemove = d.removeEventListener.bind(d);
  d.addEventListener = (type, fn, opts) => { added.push(type); return realAdd(type, fn, opts); };
  d.removeEventListener = (type, fn, opts) => { removed.push(type); return realRemove(type, fn, opts); };

  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  open(d, control);
  d.body.click();
  assert.deepEqual([...added].sort(), [...removed].sort(), 'everything added while open is removed on close');
});
