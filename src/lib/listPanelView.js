/*
 * TCGPlayer+ — the "Add to watch list" control on a product page, and on each
 * product card of a search page.
 *
 * Builds DOM and calls back; it knows nothing about storage or the extension
 * APIs, so the whole interaction is testable in jsdom.
 *
 * On a search page the card does not say which printing it is (Holofoil, Reverse
 * Holofoil), so the control first asks: opening it looks up the printings the
 * product is listed in and, when there is more than one, offers them before the
 * lists. A product page shows one printing, and skips that step.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const CONTROL_CLASS = 'ptcg-list-control';
export const BUTTON_CLASS = 'ptcg-list-button';
export const PANEL_CLASS = 'ptcg-list-panel';

export function saveButtonLabel(savedCount) {
  if (!savedCount) return 'Add to watch list';
  return `On ${savedCount} watch list${savedCount === 1 ? '' : 's'}`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * @param {Document} doc
 * @param {{lists: Array, savedIn: string[], choosePrinting?: boolean,
 *   handlers: {onToggle?, onCreate?, onManage?, onLoadPrintings?, onChoosePrinting?}}} options
 *   `choosePrinting` adds the printing step: opening calls `onLoadPrintings()`, which resolves
 *   to `{status: 'ok', printings: [{name, listings}]}` or `{status: 'unavailable'}`, and the
 *   printing settled on is passed to `onChoosePrinting(name)` ('' when none could be told)
 * @returns {HTMLElement} with `update({lists, savedIn, buttonCount?})` and `showError(text)`;
 *   `buttonCount` is how many lists the button should say (all printings), when not `savedIn`'s.
 *   `floating` opens the panel on the page itself, placed under the button, for a control that
 *   sits inside something that cuts off what overflows it (a search result card).
 */
export function renderSaveControl(doc, { lists, savedIn, handlers = {}, choosePrinting = false, floating = false }) {
  const control = doc.createElement('div');
  control.className = CONTROL_CLASS;

  const button = doc.createElement('button');
  button.type = 'button';
  button.className = BUTTON_CLASS;
  button.setAttribute('aria-expanded', 'false');

  const panel = doc.createElement('div');
  panel.className = PANEL_CLASS;
  panel.hidden = true;

  const rows = doc.createElement('div');
  rows.className = 'ptcg-list-rows';

  const error = doc.createElement('p');
  error.className = 'ptcg-list-error';
  error.hidden = true;
  error.setAttribute('role', 'alert');

  const form = doc.createElement('form');
  const input = doc.createElement('input');
  input.type = 'text';
  input.placeholder = 'New list name';
  input.setAttribute('aria-label', 'New list name');
  const add = doc.createElement('button');
  add.type = 'submit';
  add.textContent = 'Create';
  form.append(input, add);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) return;
    input.value = '';
    if (handlers.onCreate) handlers.onCreate(name);
  });

  const manage = doc.createElement('button');
  manage.type = 'button';
  manage.className = 'ptcg-list-manage';
  manage.textContent = 'Manage watch lists';
  manage.addEventListener('click', () => handlers.onManage && handlers.onManage());

  // ---- the printing step (search pages) ----------------------------------------------
  const printingStep = doc.createElement('div');
  printingStep.className = 'ptcg-printing';
  printingStep.hidden = true;
  const printingHeader = doc.createElement('div');
  printingHeader.className = 'ptcg-printing-chosen';
  printingHeader.hidden = true;
  const listsStep = doc.createElement('div');
  listsStep.className = 'ptcg-list-step';
  listsStep.append(rows, error, form, manage);
  panel.append(printingStep, printingHeader, listsStep);
  control.append(button);
  if (!floating) control.append(panel);

  // null until a printing has been settled on; '' when the product's printings could not be told.
  let chosen = choosePrinting ? null : '';
  let offered = [];

  function showStep(step) {
    printingStep.hidden = step === 'lists';
    listsStep.hidden = step !== 'lists';
    printingHeader.hidden = step !== 'lists' || !choosePrinting;
  }

  function stepMessage(className, message, withRetry) {
    printingStep.textContent = '';
    const line = doc.createElement('p');
    line.className = className;
    line.textContent = message;
    printingStep.append(line);
    if (withRetry) {
      const retry = doc.createElement('button');
      retry.type = 'button';
      retry.className = 'ptcg-printing-retry';
      retry.textContent = 'Try again';
      retry.addEventListener('click', loadPrintings);
      printingStep.append(retry);
    }
  }

  function settle(name, note = '') {
    chosen = name;
    printingHeader.textContent = '';
    const label = doc.createElement('span');
    label.textContent = name ? `Printing: ${name}` : 'Printing: any';
    printingHeader.append(label);
    if (offered.length > 1) {
      const change = doc.createElement('button');
      change.type = 'button';
      change.className = 'ptcg-printing-change';
      change.textContent = 'Change printing';
      change.addEventListener('click', () => offer(offered));
      printingHeader.append(' \u00B7 ', change);
    }
    if (note) {
      const why = doc.createElement('small');
      why.className = 'ptcg-printing-note';
      why.textContent = note;
      printingHeader.append(why);
    }
    showStep('lists');
    if (handlers.onChoosePrinting) handlers.onChoosePrinting(name);
  }

  function offer(printings) {
    printingStep.textContent = '';
    const ask = doc.createElement('p');
    ask.className = 'ptcg-printing-ask';
    ask.textContent = 'Which printing?';
    const choices = doc.createElement('div');
    choices.className = 'ptcg-printing-choices';
    for (const printing of printings) {
      const choice = doc.createElement('button');
      choice.type = 'button';
      choice.className = 'ptcg-printing-choice';
      choice.setAttribute('data-printing', printing.name);
      const name = doc.createElement('span');
      name.textContent = printing.name;
      const count = doc.createElement('small');
      count.textContent = plural(printing.listings, 'listing');
      choice.append(name, count);
      if (printing.name === chosen) choice.setAttribute('aria-current', 'true');
      choice.addEventListener('click', () => settle(printing.name));
      choices.append(choice);
    }
    printingStep.append(ask, choices);
    showStep('printing');
  }

  async function loadPrintings() {
    printingStep.textContent = '';
    const spinner = doc.createElement('p');
    spinner.className = 'ptcg-printing-loading';
    spinner.setAttribute('role', 'status');
    const wheel = doc.createElement('span');
    wheel.className = 'ptcg-spinner';
    wheel.setAttribute('aria-hidden', 'true');
    spinner.append(wheel, ' Checking printings\u2026');
    printingStep.append(spinner);
    showStep('printing');
    let answer;
    try {
      answer = handlers.onLoadPrintings ? await handlers.onLoadPrintings() : { status: 'ok', printings: [] };
    } catch {
      answer = null;
    }
    if (!answer || answer.status !== 'ok' || !Array.isArray(answer.printings)) {
      stepMessage('ptcg-list-error', 'Could not find out which printings this card comes in.', true);
      return;
    }
    offered = answer.printings;
    if (offered.length > 1) offer(offered);
    else if (offered.length === 1) settle(offered[0].name);
    else settle('', 'Nothing is listed to tell its printings apart, so it is watched as Near Mint in any printing.');
  }


  // Listeners on the page exist only while the panel is open, so a control that
  // is thrown away (TCGplayer swaps pages without reloading) leaves nothing behind.
  const onOutsideClick = (event) => {
    // composedPath is the path at dispatch time, so a row that was redrawn (and
    // so detached) while handling this very click is still recognised as inside.
    const path = event.composedPath();
    if (!path.includes(control) && !path.includes(panel)) setOpen(false);
  };
  // A floating panel lives on the page, under the button, and follows it as the page moves.
  const view = doc.defaultView;
  const place = () => {
    const at = button.getBoundingClientRect();
    const width = Math.max(panel.offsetWidth || 0, 240);
    const room = (view ? view.innerWidth : 0) - width - 8;
    panel.style.left = `${Math.max(8, Math.min(at.left, room > 8 ? room : at.left)) + (view ? view.scrollX : 0)}px`;
    panel.style.top = `${at.bottom + 6 + (view ? view.scrollY : 0)}px`;
  };
  if (floating) panel.classList.add(`${PANEL_CLASS}--floating`);
  const onKeydown = (event) => {
    if (event.key !== 'Escape') return;
    setOpen(false);
    button.focus();
  };

  function setOpen(open) {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      doc.addEventListener('click', onOutsideClick);
      doc.addEventListener('keydown', onKeydown);
      if (floating) {
        doc.body.append(panel);
        place();
        if (view) { view.addEventListener('resize', place); view.addEventListener('scroll', place, true); }
      }
    } else {
      doc.removeEventListener('click', onOutsideClick);
      doc.removeEventListener('keydown', onKeydown);
      if (floating) {
        if (view) { view.removeEventListener('resize', place); view.removeEventListener('scroll', place, true); }
        panel.remove();
      }
    }
  }
  /** Close it, and take a floating panel off the page: for when the control itself goes. */
  control.close = () => { if (!panel.hidden) setOpen(false); };
  control.panel = panel;

  button.addEventListener('click', (event) => {
    // On a search page the control sits on a card that is one big link; it must not follow it.
    event.preventDefault();
    event.stopPropagation();
    const opening = panel.hidden;
    setOpen(opening);
    if (opening && choosePrinting && chosen === null) loadPrintings();
  });
  // Nor may anything else inside it (a tick, the form, a printing).
  panel.addEventListener('click', (event) => event.stopPropagation());
  if (!choosePrinting) showStep('lists');

  function drawRows(currentLists, currentSaved) {
    rows.textContent = '';
    if (currentLists.length === 0) {
      const empty = doc.createElement('p');
      empty.className = 'ptcg-list-empty';
      empty.textContent = 'No lists yet — name one below to start.';
      rows.append(empty);
      return;
    }
    for (const list of currentLists) {
      const row = doc.createElement('label');
      row.className = 'ptcg-list-row';
      const box = doc.createElement('input');
      box.type = 'checkbox';
      box.value = list.id;
      box.checked = currentSaved.includes(list.id);
      box.addEventListener('change', () => {
        if (handlers.onToggle) handlers.onToggle(list.id, box.checked);
      });
      const name = doc.createElement('span');
      name.textContent = list.name;
      const count = doc.createElement('small');
      count.textContent = `${list.items.length}`;
      row.append(box, name, count);
      rows.append(row);
    }
  }

  control.update = ({ lists: nextLists, savedIn: nextSaved, buttonCount }) => {
    const count = Number.isInteger(buttonCount) ? buttonCount : nextSaved.length;
    button.textContent = saveButtonLabel(count);
    control.setAttribute('data-saved', count ? 'true' : 'false');
    drawRows(nextLists, nextSaved);
  };
  /** The printing settled on: null until then; '' when none could be told. */
  control.printing = () => chosen;

  control.showError = (message) => {
    error.textContent = message;
    error.hidden = !message;
  };

  control.update({ lists, savedIn });
  return control;
}
