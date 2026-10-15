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

// ---- choosing a printing first (search pages) -------------------------------------------------

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise((r) => setTimeout(r, 0));
const printingControl = (answer, extra = {}) => {
  const d = doc();
  const calls = { loads: 0, chosen: [] };
  const control = renderSaveControl(d, {
    lists, savedIn: [], choosePrinting: true,
    handlers: {
      onLoadPrintings: () => { calls.loads += 1; return typeof answer === 'function' ? answer() : answer; },
      onChoosePrinting: (name) => calls.chosen.push(name),
      ...extra,
    },
  });
  return { d, control, calls };
};
const step = (control) => ({
  printing: control.querySelector('.ptcg-printing'),
  chosen: control.querySelector('.ptcg-printing-chosen'),
  lists: control.querySelector('.ptcg-list-step'),
});
const TWO = { status: 'ok', printings: [{ name: 'Holofoil', listings: 279 }, { name: 'Reverse Holofoil', listings: 1 }] };

test('opening shows a spinner while the printings are fetched, then the choice, most-listed first', async () => {
  const wait = deferred();
  const { d, control, calls } = printingControl(() => wait.promise);
  open(d, control);
  assert.equal(calls.loads, 1);
  assert.equal(step(control).printing.hidden, false);
  assert.equal(step(control).lists.hidden, true, 'no lists until a printing is chosen');
  const loading = control.querySelector('.ptcg-printing-loading');
  assert.match(loading.textContent, /Checking printings…/);
  assert.equal(loading.getAttribute('role'), 'status');
  assert.ok(loading.querySelector('.ptcg-spinner'));

  wait.resolve(TWO);
  await tick();
  assert.equal(control.querySelector('.ptcg-printing-ask').textContent, 'Which printing?');
  assert.deepEqual([...control.querySelectorAll('.ptcg-printing-choice')].map((b) => b.textContent), ['Holofoil279 listings', 'Reverse Holofoil1 listing']);
  assert.equal(calls.chosen.length, 0, 'waiting for a choice');
});

test('choosing a printing shows the lists, headed by it, with a way back', async () => {
  const { d, control, calls } = printingControl(TWO);
  open(d, control);
  await tick();
  control.querySelector('.ptcg-printing-choice[data-printing="Reverse Holofoil"]').click();
  assert.deepEqual(calls.chosen, ['Reverse Holofoil']);
  assert.equal(control.printing(), 'Reverse Holofoil');
  assert.equal(step(control).lists.hidden, false);
  assert.equal(step(control).printing.hidden, true);
  assert.match(step(control).chosen.textContent, /^Printing: Reverse Holofoil · Change printing$/);
  assert.equal(control.querySelectorAll('.ptcg-list-row').length, 2);

  control.querySelector('.ptcg-printing-change').click();
  assert.equal(step(control).printing.hidden, false, 'back to the choice');
  assert.equal(control.querySelector('.ptcg-printing-choice[aria-current="true"]').getAttribute('data-printing'), 'Reverse Holofoil');
  control.querySelector('.ptcg-printing-choice[data-printing="Holofoil"]').click();
  assert.deepEqual(calls.chosen, ['Reverse Holofoil', 'Holofoil']);
  assert.equal(calls.loads, 1, 'not fetched again');
});

test('one printing needs no choice; none listed is saved as any printing, and says so', async () => {
  const one = printingControl({ status: 'ok', printings: [{ name: 'Holofoil', listings: 279 }] });
  open(one.d, one.control);
  await tick();
  assert.deepEqual(one.calls.chosen, ['Holofoil']);
  assert.equal(step(one.control).lists.hidden, false);
  assert.equal(step(one.control).chosen.textContent, 'Printing: Holofoil', 'nothing to change to');

  const none = printingControl({ status: 'ok', printings: [] });
  open(none.d, none.control);
  await tick();
  assert.deepEqual(none.calls.chosen, ['']);
  assert.equal(none.control.printing(), '');
  assert.match(step(none.control).chosen.textContent, /^Printing: any.*watched as Near Mint in any printing\./);
});

test('when the printings cannot be found it says so, and Try again asks again', async () => {
  let answer = { status: 'unavailable' };
  const { d, control, calls } = printingControl(() => answer);
  open(d, control);
  await tick();
  assert.match(control.querySelector('.ptcg-printing .ptcg-list-error').textContent, /Could not find out which printings/);
  assert.equal(step(control).lists.hidden, true);
  answer = TWO;
  control.querySelector('.ptcg-printing-retry').click();
  await tick();
  assert.equal(calls.loads, 2);
  assert.equal(control.querySelectorAll('.ptcg-printing-choice').length, 2);

  const throwing = printingControl(() => Promise.reject(new Error('gone')));
  open(throwing.d, throwing.control);
  await tick();
  assert.ok(throwing.control.querySelector('.ptcg-printing-retry'), 'a failed message is a failure, not a crash');
});

test('closing and opening again keeps the printing chosen, and does not fetch again', async () => {
  const { d, control, calls } = printingControl(TWO);
  open(d, control);
  await tick();
  control.querySelector('.ptcg-printing-choice').click();
  const button = control.querySelector(`.${BUTTON_CLASS}`);
  button.click();
  button.click();
  assert.equal(calls.loads, 1);
  assert.equal(step(control).lists.hidden, false);
});

test('the button can count every printing of the product while the ticks are for one', () => {
  const { control } = printingControl(TWO);
  control.update({ lists, savedIn: [], buttonCount: 2 });
  assert.equal(control.querySelector(`.${BUTTON_CLASS}`).textContent, 'On 2 watch lists');
  assert.equal(control.getAttribute('data-saved'), 'true');
});

test('clicks on the control never reach the card link it sits on', () => {
  const d = doc();
  const link = d.createElement('a');
  link.href = '/product/1';
  const reached = [];
  link.addEventListener('click', () => reached.push('link'));
  d.body.append(link);
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  link.append(control);
  const event = new d.defaultView.MouseEvent('click', { bubbles: true, cancelable: true });
  control.querySelector(`.${BUTTON_CLASS}`).dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  control.querySelector('.ptcg-list-row input').click();
  assert.deepEqual(reached, []);
});

test('a product page\'s control has no printing step', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {} });
  open(d, control);
  assert.equal(step(control).printing.hidden, true);
  assert.equal(step(control).chosen.hidden, true);
  assert.equal(step(control).lists.hidden, false);
  assert.equal(control.printing(), '');
});

test('a floating panel opens on the page under its button, and closing takes it off the page', () => {
  const d = doc();
  const control = renderSaveControl(d, { lists, savedIn: [], handlers: {}, floating: true });
  d.body.append(control);
  assert.equal(control.querySelector(`.${PANEL_CLASS}`), null, 'not inside the control');
  control.querySelector(`.${BUTTON_CLASS}`).click();
  assert.equal(control.panel.parentElement, d.body);
  assert.equal(control.panel.hidden, false);
  assert.match(control.panel.style.left, /^\d+px$/);
  // A click inside the floating panel is not a click outside it.
  control.panel.querySelector('.ptcg-list-row input').click();
  assert.equal(control.panel.hidden, false);
  d.body.click();
  assert.equal(control.panel.isConnected, false, 'gone when it closes');
  control.querySelector(`.${BUTTON_CLASS}`).click();
  control.close();
  assert.equal(control.panel.isConnected, false);
  assert.doesNotThrow(() => control.close(), 'closing a closed one is fine');
});
