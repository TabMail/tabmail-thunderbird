/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The summary bubble above a message shows the email's todos and summary, or a
// notice, as written: text, never markup, as the message list's tooltip does.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { JSDOM } from 'jsdom';

const read = name => readFileSync(resolve(__dirname, '../theme/modules', name), 'utf8');
const CONFIG = read('summaryBubbleConfig.js');
const BUBBLE = read('summaryBubble.js');

afterEach(() => vi.restoreAllMocks());

function openMessage() {
  const dom = new JSDOM('<body><p>Message body</p></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  dom.window.console.log = () => {};
  dom.window.console.warn = () => {};
  dom.window.eval(CONFIG);
  dom.window.eval(BUBBLE);
  const bubble = dom.window.TabMailSummaryBubble;
  const content = () => {
    const host = dom.window.document.getElementById(dom.window.TabMailSummaryBubbleConfig.bubbleId);
    return host.shadowRoot.querySelector('.tm-container, .tm-warning').parentElement;
  };
  return { bubble, content };
}

// The content's element structure, each element with its class and text.
const shape = node => [...node.childNodes]
  .filter(c => c.nodeType === 1 || c.textContent.trim())
  .map(c => c.nodeType === 3 ? ['#text', c.textContent.trim()] : [c.nodeName, c.className, c.children.length ? shape(c) : c.textContent]);

const markupTexts = [
  ['a span with attributes', '<span data-x="1" style="color: red">moved</span> to Friday'],
  ['an image', 'Moved <img src="https://example.com/a.png"> to Friday'],
  ['an anchor', '<a href="https://example.com/">Friday</a>'],
  ['bold and line break tags', '<b>Moved</b><br>to Friday'],
  ['angle brackets, quotes and ampersands', 'a < b > c "d" \'e\' & f &amp; g'],
];

describe('the summary bubble shows todos and summary as written', () => {
  it('a plain summary and todos show as before', () => {
    const { bubble, content } = openMessage();
    bubble.displaySummary('Budget review moved to Friday.', '• Send the deck • Book a room', false);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-container', [
        ['STRONG', '', 'Todos:'],
        ['UL', 'tm-list', [['LI', '', 'Send the deck'], ['LI', '', 'Book a room']]],
        ['STRONG', '', 'Summary:'],
        ['DIV', 'tm-summary', 'Budget review moved to Friday.'],
      ]],
    ]);
  });

  it('only a summary shows only the summary; none shows that it is analyzing', () => {
    const { bubble, content } = openMessage();
    bubble.displaySummary('Just this', '', false);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-container', [['STRONG', '', 'Summary:'], ['DIV', 'tm-summary', 'Just this']]],
    ]);
    bubble.displaySummary('', '   ', false);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-container', [['STRONG', '', 'Summary:'], ['DIV', 'tm-summary', 'Analyzing email…']]],
    ]);
  });

  it('todos of separators only show as written', () => {
    const { bubble, content } = openMessage();
    bubble.displaySummary('Plan', '• •', false);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-container', [
        ['STRONG', '', 'Todos:'],
        ['#text', '• •'],
        ['STRONG', '', 'Summary:'],
        ['DIV', 'tm-summary', 'Plan'],
      ]],
    ]);
    // They sit inline between the two headings, set apart by a space each side.
    const container = content().querySelector('.tm-container');
    const inline = [...container.childNodes].filter(c => c.nodeName !== 'DIV').map(c => c.textContent).join('');
    expect(inline.replace(/\s+/g, ' ').trim()).toBe('Todos: • • Summary:');
  });

  it('only the bullet separates todos; an asterisk inside a todo stays in it', () => {
    const { bubble, content } = openMessage();
    bubble.displaySummary('Plan', '• Calculate 2 * 3 • Reply', false);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-container', [
        ['STRONG', '', 'Todos:'],
        ['UL', 'tm-list', [['LI', '', 'Calculate 2 * 3'], ['LI', '', 'Reply']]],
        ['STRONG', '', 'Summary:'],
        ['DIV', 'tm-summary', 'Plan'],
      ]],
    ]);
  });

  it('a notice shows its icon and text', () => {
    const { bubble, content } = openMessage();
    bubble.displaySummary('Not logged in, please sign in', '', true);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-warning', [['SPAN', 'tm-warning-icon', '⚠️'], ['SPAN', 'tm-warning-text', 'Not logged in, please sign in']]],
    ]);
  });

  it.each(markupTexts)('a summary, todo and notice holding %s show as that text', (_label, text) => {
    const { bubble, content } = openMessage();
    bubble.displaySummary(text, `• ${text}`, false);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-container', [
        ['STRONG', '', 'Todos:'],
        ['UL', 'tm-list', [['LI', '', text]]],
        ['STRONG', '', 'Summary:'],
        ['DIV', 'tm-summary', text],
      ]],
    ]);
    expect(content().querySelectorAll('span, img, a, b, br')).toHaveLength(0);
    bubble.displaySummary(text, '', true);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-warning', [['SPAN', 'tm-warning-icon', '⚠️'], ['SPAN', 'tm-warning-text', text]]],
    ]);
    expect(content().querySelectorAll('img, a, b, br')).toHaveLength(0);
  });

  it('a later summary replaces the earlier one', () => {
    const { bubble, content } = openMessage();
    bubble.displaySummary('First', '• one', false);
    bubble.displaySummary('Second', '', false);
    expect(shape(content())).toEqual([
      ['DIV', 'tm-container', [['STRONG', '', 'Summary:'], ['DIV', 'tm-summary', 'Second']]],
    ]);
  });
});

// The background sends the bubble its content through the message display's
// renderer, which may arrive before the message body exists.
function openMessageWithRenderer({ bodyLater = false } = {}) {
  const dom = new JSDOM('<body><p>Message body</p></body>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  const doc = win.document;
  win.console.log = () => {};
  win.console.warn = () => {};
  win.console.error = () => {};
  const listeners = [];
  win.browser = {
    runtime: {
      onMessage: { addListener: fn => listeners.push(fn), removeListener: () => {} },
      sendMessage: () => Promise.resolve(),
    },
  };
  const ready = [];
  win.addEventListener('tabmail:summaryBubbleReady', e => ready.push(e.detail.reason));
  if (bodyLater) doc.body.remove();
  win.eval(CONFIG);
  win.eval(BUBBLE);
  win.eval(read('bubblesRenderer.js'));
  expect(listeners).toHaveLength(1);
  const send = msg => listeners[0](msg);
  const host = () => doc.getElementById(win.TabMailSummaryBubbleConfig.bubbleId);
  const content = () => host().shadowRoot.querySelector('.tm-container, .tm-warning').parentElement;
  const addBody = () => {
    const body = doc.createElement('body');
    body.innerHTML = '<p>Message body</p>';
    doc.documentElement.append(body);
    doc.dispatchEvent(new win.Event('DOMContentLoaded'));
  };
  const isReady = () => win.__tmDisplayGateFlags?.summaryReady === true;
  return { send, host, content, addBody, ready, isReady };
}

describe('the summary bubble shows what the background sends', () => {
  it('a summary and its todos sent to the message show, and the bubble is ready', () => {
    const page = openMessageWithRenderer();
    expect(page.isReady()).toBe(false);
    page.send({ command: 'displaySummary', blurb: 'Moved <b>to</b> Friday', todos: '• Send the deck • Book a room', isWarning: false });
    expect(shape(page.content())).toEqual([
      ['DIV', 'tm-container', [
        ['STRONG', '', 'Todos:'],
        ['UL', 'tm-list', [['LI', '', 'Send the deck'], ['LI', '', 'Book a room']]],
        ['STRONG', '', 'Summary:'],
        ['DIV', 'tm-summary', 'Moved <b>to</b> Friday'],
      ]],
    ]);
    expect(page.isReady()).toBe(true);
    expect(page.ready).toEqual(['content']);
  });

  it('a notice sent to the message shows, and the bubble is ready', () => {
    const page = openMessageWithRenderer();
    page.send({ command: 'displaySummary', blurb: 'Not logged in, please sign in', todos: '', isWarning: true });
    expect(shape(page.content())).toEqual([
      ['DIV', 'tm-warning', [['SPAN', 'tm-warning-icon', '⚠️'], ['SPAN', 'tm-warning-text', 'Not logged in, please sign in']]],
    ]);
    expect(page.isReady()).toBe(true);
    expect(page.ready).toEqual(['warning']);
  });

  it.each([
    ['a summary', { blurb: 'Second', todos: '• Reply', isWarning: false }, 'content',
      [['DIV', 'tm-container', [['STRONG', '', 'Todos:'], ['UL', 'tm-list', [['LI', '', 'Reply']]], ['STRONG', '', 'Summary:'], ['DIV', 'tm-summary', 'Second']]]]],
    ['a notice', { blurb: 'Please sign in', todos: '', isWarning: true }, 'warning',
      [['DIV', 'tm-warning', [['SPAN', 'tm-warning-icon', '⚠️'], ['SPAN', 'tm-warning-text', 'Please sign in']]]]],
  ])('%s sent before the message body exists shows, the latest one, once the body arrives', (_label, latest, reason, expected) => {
    const page = openMessageWithRenderer({ bodyLater: true });
    page.send({ command: 'displaySummary', blurb: 'First', todos: '• Earlier', isWarning: false });
    page.send({ command: 'displaySummary', ...latest });
    expect(page.host()).toBeNull();
    expect(page.isReady()).toBe(false);
    page.addBody();
    expect(shape(page.content())).toEqual(expected);
    expect(page.isReady()).toBe(true);
    expect(page.ready).toEqual([reason]);
  });
});
