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
