/*
 * TCGPlayer+ — the Settings view: where notifications go, and how to receive them.
 * Copyright (C) 2026  Simon Townsend
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
  loadSettings, updateSettings, toggleTrendDuration, createTopic, parseSecretWord, hasTopic,
  SETTINGS_KEY, SECRET_WORD_MAX, SECRET_WORD_RULE,
} from '../../lib/settings.js';
import { TREND } from '../../lib/priceTrend.js';
import { topicUrl, NTFY_ANDROID_URL, NTFY_IOS_URL } from '../../lib/ntfy.js';
import { sendNotification } from '../notify.js';
import { requestConsent } from '../../lib/consent.js';
import { api } from '../../lib/runtime.js';

const storage = api.storage.local;

function make(tag, props = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** @returns {{unmount: () => void, refresh: () => Promise<void>}} */
export function mount(root) {
  let mounted = true;

  const header = make('div', { className: 'page-header' });
  const intro = make('div');
  intro.append(
    make('h2', {}, 'Settings'),
    make('p', { className: 'intro' }, 'Which price trends each card shows, and how TCGPlayer+ tells you when a price target is reached.'),
  );
  header.append(intro);

  // ---- which price trends to show ------------------------------------------------
  const trendSection = make('section', { className: 'settings-section settings-trends' });
  trendSection.append(make('h3', {}, 'Price trends'));
  trendSection.append(make('p', {}, 'Choose which trends each card shows in Watch Lists and Order History. '
    + 'Each compares what the card sold for over that many days with the same number of days before. Click a trend on a card to see its chart.'));
  const trendChoices = make('div', { className: 'settings-trends__choices' });
  const trendBoxes = new Map();
  // Shortest first to read naturally; they are shown on a card longest first.
  for (const days of [...TREND.DURATIONS].sort((a, b) => a - b)) {
    const label = make('label', { className: 'settings-trends__choice' });
    const box = make('input', { type: 'checkbox', className: 'settings-trends__box', value: String(days) });
    label.append(box, ` ${days} day${days === 1 ? '' : 's'}`);
    trendChoices.append(label);
    trendBoxes.set(days, box);
    box.addEventListener('change', async () => {
      const wanted = box.checked;
      const settings = await updateSettings(storage, (s) => toggleTrendDuration(s, days, wanted));
      if (!mounted) return;
      drawTrendChoices(settings);
      // Unticking the only one left is refused, and the box goes back.
      trendStatus.textContent = settings.trendDurations.includes(days) === wanted ? '' : 'At least one trend is always shown.';
    });
  }
  const trendStatus = make('p', { className: 'settings-trends__status' });
  trendStatus.setAttribute('role', 'status');
  trendSection.append(trendChoices, trendStatus, make('p', { className: 'settings-trends__note' },
    `A trend needs at least ${TREND.MIN_SALES} sales in each period, so short ones often read "not enough sales" for cards that sell slowly. `
    + 'TCGplayer reports sales by the day, and today\u2019s are still coming in, so the 1-day trend moves the most.'));

  function drawTrendChoices(settings) {
    for (const [days, box] of trendBoxes) box.checked = settings.trendDurations.includes(days);
  }

  const section = make('section', { className: 'settings-section' });
  section.append(make('h3', {}, 'Notifications'));
  section.append(make('p', {}, 'Notifications are sent through ntfy, a free notification service that needs no account. '
    + 'You subscribe to your topic on the phone or computer where you want price-target alerts to arrive.'));

  // How to subscribe, step by step; shown once there is a topic to subscribe to.
  const outside = (text, href) => make('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  const how = make('div', { className: 'settings-how' });
  const steps = make('ol', { className: 'settings-how__steps' });
  const phone = make('li');
  const phoneTopic = make('code', { className: 'settings-how__topic' });
  phone.append(
    make('strong', {}, 'On a phone: '), 'install the ntfy app (',
    outside('Android', NTFY_ANDROID_URL), ' or ', outside('iPhone', NTFY_IOS_URL),
    '), press +, type the topic ', phoneTopic, ' and press Subscribe.',
  );
  const computer = make('li');
  const pageLink = outside('its page', '');
  pageLink.className = 'settings-how__page';
  computer.append(
    make('strong', {}, 'On a computer: '), 'open ', pageLink,
    ', and allow notifications when the page asks. Alerts appear while that page is open in a tab.',
  );
  const check = make('li');
  check.append(make('strong', {}, 'Check it: '), 'press Send test notification below. It should arrive within a few seconds.');
  steps.append(phone, computer, check);
  how.append(make('h4', {}, 'How to receive notifications'), steps);

  // Shown until a topic exists, and again when the user asks to change it.
  const setup = make('form', { className: 'settings-setup' });
  const setupIntro = make('p', { className: 'settings-setup__intro' });
  const wordLabel = make('label', { className: 'settings-setup__label' }, 'Secret word ');
  const word = make('input', { type: 'text', className: 'settings-setup__word', maxLength: SECRET_WORD_MAX, autocomplete: 'off', spellcheck: false });
  wordLabel.append(word);
  const create = make('button', { type: 'submit', className: 'settings-setup__save' });
  const cancel = make('button', { type: 'button', className: 'settings-setup__cancel secondary' }, 'Cancel');
  const setupRow = make('div', { className: 'settings-setup__row' });
  setupRow.append(wordLabel, create, cancel);
  setup.append(setupIntro, setupRow, make('p', { className: 'settings-setup__note' },
    `${SECRET_WORD_RULE} A dash and five random letters and digits are added to it to make your topic.`));

  const topicRow = make('p', { className: 'settings-topic' });
  const topicLabel = make('span', { className: 'settings-topic__label' }, 'Your topic: ');
  const topicCode = make('code', { className: 'settings-topic__name' });
  topicRow.append(topicLabel, topicCode);

  const linkRow = make('p', { className: 'settings-topic__link' });
  const link = make('a', { target: '_blank', rel: 'noopener noreferrer' });
  linkRow.append(make('span', {}, 'Its page: '), link);

  const actions = make('div', { className: 'settings-actions' });
  const copy = make('button', { type: 'button', className: 'secondary' }, 'Copy topic');
  const test = make('button', { type: 'button' }, 'Send test notification');
  const regenerate = make('button', { type: 'button', className: 'secondary' }, 'Change secret word');
  actions.append(test, copy, regenerate);

  const status = make('p', { className: 'settings-status' });
  status.setAttribute('role', 'status');

  const privacy = make('p', { className: 'settings-note' },
    'A topic is not protected by a password: anyone who knows its name can read what is sent to it, so do not share it, and choose a word others would not guess. '
    + 'A notification contains the card’s name, its Ask and your target, and nothing about you or your orders. '
    + 'Targets are checked in this browser while the dashboard is open and auto-refresh is on.');

  section.append(setup, topicRow, linkRow, how, actions, status, privacy);
  root.append(header, trendSection, section);

  function say(message, isError = false) {
    status.textContent = message;
    status.setAttribute('data-error', isError ? '1' : '0');
  }

  let topic = '';
  let changing = false;
  async function draw() {
    const settings = await loadSettings(storage);
    if (!mounted) return;
    drawTrendChoices(settings);
    const ready = hasTopic(settings);
    topic = settings.notifications.topic;
    topicCode.textContent = topic;
    link.href = ready ? topicUrl(topic) : '';
    link.textContent = ready ? topicUrl(topic) : '';
    phoneTopic.textContent = topic;
    pageLink.href = ready ? topicUrl(topic) : '';
    for (const node of [topicRow, linkRow, how, actions]) node.hidden = !ready;
    setup.hidden = ready && !changing;
    cancel.hidden = !ready;
    create.textContent = ready ? 'Save new topic' : 'Set up notifications';
    setupIntro.textContent = ready
      ? 'Choose a new secret word. Notifications will stop arriving until you subscribe to the new topic.'
      : 'Choose a secret word to set up notifications. It becomes the start of your topic.';
  }

  setup.addEventListener('submit', async (event) => {
    event.preventDefault();
    const parsed = parseSecretWord(word.value);
    if (!parsed.ok) { say(parsed.error, true); return; }
    const replacing = Boolean(topic);
    await createTopic(storage, parsed.word);
    changing = false;
    word.value = '';
    await draw();
    say(replacing
      ? 'New topic made. Subscribe to it to keep receiving notifications.'
      : 'Notifications are set up. Follow the steps below to receive them.');
  });
  cancel.addEventListener('click', () => { changing = false; word.value = ''; say(''); draw(); });

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(topic);
      say('Copied the topic.');
    } catch {
      say('Could not copy; select the topic and copy it by hand.', true);
    }
  });

  test.addEventListener('click', async () => {
    // First, while the click still counts: the browser may need to ask before anything is sent.
    const allowed = await requestConsent(api);
    if (!allowed) {
      say('Firefox was not given permission to send notifications, so nothing was sent. Press the button again to be asked.', true);
      return;
    }
    test.disabled = true;
    say('Sending…');
    const result = await sendNotification({
      title: 'TCGPlayer+ test notification',
      message: 'Notifications are working. Price-target alerts will arrive here.',
      tags: ['white_check_mark'],
    });
    if (!mounted) return;
    test.disabled = false;
    if (result.ok) say('Sent. If it did not arrive, check that you are subscribed to the topic above.');
    else say(`Could not send (${result.results.map((r) => r.error).filter(Boolean).join('; ') || 'unknown error'}).`, true);
  });

  regenerate.addEventListener('click', async () => {
    changing = true;
    await draw();
    word.focus();
  });

  const onChanged = (changes, area) => {
    if (area === 'local' && changes[SETTINGS_KEY]) draw();
  };
  api.storage.onChanged.addListener(onChanged);

  draw();

  return {
    unmount: () => {
      mounted = false;
      api.storage.onChanged.removeListener(onChanged);
    },
    // Nothing here depends on prices.
    refresh: async () => {},
  };
}
