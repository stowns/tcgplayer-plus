/*
 * TCGPlayer+ — the "Save to list" control on a product page.
 *
 * Builds DOM and calls back; it knows nothing about storage or the extension
 * APIs, so the whole interaction is testable in jsdom.
 *
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const CONTROL_CLASS = 'ptcg-list-control';
export const BUTTON_CLASS = 'ptcg-list-button';
export const PANEL_CLASS = 'ptcg-list-panel';

export function saveButtonLabel(savedCount) {
  if (!savedCount) return 'Save to list';
  return `Saved in ${savedCount} list${savedCount === 1 ? '' : 's'}`;
}

/**
 * @param {Document} doc
 * @param {{lists: Array, savedIn: string[], handlers: {onToggle?, onCreate?, onManage?}}} options
 * @returns {HTMLElement} with `update({lists, savedIn})` and `showError(text)`
 */
export function renderSaveControl(doc, { lists, savedIn, handlers = {} }) {
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
  manage.textContent = 'Manage lists';
  manage.addEventListener('click', () => handlers.onManage && handlers.onManage());

  panel.append(rows, error, form, manage);
  control.append(button, panel);

  // Listeners on the page exist only while the panel is open, so a control that
  // is thrown away (TCGplayer swaps pages without reloading) leaves nothing behind.
  const onOutsideClick = (event) => {
    // composedPath is the path at dispatch time, so a row that was redrawn (and
    // so detached) while handling this very click is still recognised as inside.
    if (!event.composedPath().includes(control)) setOpen(false);
  };
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
    } else {
      doc.removeEventListener('click', onOutsideClick);
      doc.removeEventListener('keydown', onKeydown);
    }
  }

  button.addEventListener('click', () => setOpen(panel.hidden));

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

  control.update = ({ lists: nextLists, savedIn: nextSaved }) => {
    button.textContent = saveButtonLabel(nextSaved.length);
    control.setAttribute('data-saved', nextSaved.length ? 'true' : 'false');
    drawRows(nextLists, nextSaved);
  };

  control.showError = (message) => {
    error.textContent = message;
    error.hidden = !message;
  };

  control.update({ lists, savedIn });
  return control;
}
