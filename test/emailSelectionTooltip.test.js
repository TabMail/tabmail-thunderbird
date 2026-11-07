/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The chat's email selection list shows an email's todos and summary in a
// tooltip on hover. They show as written, as the message list's own tooltip
// shows them: text, never markup.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/context.js', () => ({ ctx: {} }));
vi.mock('../chat/modules/markdown.js', () => ({ attachSpecialLinkListeners: vi.fn(), renderMarkdown: vi.fn(async t => t) }));
vi.mock('../chat/modules/toolCollapse.js', () => ({ isToolCollapseEnabled: () => false, addToolBubbleToGroup: vi.fn() }));

afterEach(() => {
  delete globalThis.window;
  delete globalThis.document;
  vi.restoreAllMocks();
});

async function hover(item) {
  const dom = new JSDOM('<body><div id="chat"></div></body>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const { renderEmailSelectionList } = await import('../chat/modules/helpers.js');
  const container = document.getElementById('chat');
  await renderEmailSelectionList(container, [{ uniqueId: 'u1', subject: 'Plan', from: 'sam@example.com', date: '', ...item }], { delay: 0, displayOnly: true });
  const row = container.querySelector('.email-item-row');
  row.dispatchEvent(new dom.window.MouseEvent('mouseenter'));
  return document.querySelector('.email-item-tooltip');
}

// The tooltip's element structure, each element with its text.
const shape = tooltip => [...tooltip.childNodes].map(node =>
  node.nodeType === 3 ? ['#text', node.textContent] : [node.nodeName, node.className, [...node.childNodes].map(c => [c.nodeName, c.textContent])],
);

describe('the email selection tooltip shows todos and summary as written', () => {
  it('a plain summary and todos render as before', async () => {
    const tooltip = await hover({ blurb: 'Budget review moved to Friday.', todos: '• Send the deck • Book a room' });
    expect(tooltip.innerHTML).toBe(
      '<strong>Todos:</strong><ul class="tooltip-todos"><li>Send the deck</li><li>Book a room</li></ul>'
      + '<strong>Summary:</strong><div class="tooltip-summary">Budget review moved to Friday.</div>',
    );
  });

  it.each([
    ['a span with attributes', '<span data-x="1" style="color: red">moved</span> to Friday'],
    ['an image', 'Moved <img src="https://example.com/a.png"> to Friday'],
    ['an anchor', '<a href="https://example.com/">Friday</a>'],
    ['bold and line break tags', '<b>Moved</b><br>to Friday'],
    ['angle brackets, quotes and ampersands', 'a < b > c "d" \'e\' & f &amp; g'],
  ])('a summary and todo holding %s show as that text', async (_label, text) => {
    const tooltip = await hover({ blurb: text, todos: `• ${text}` });
    expect(shape(tooltip)).toEqual([
      ['STRONG', '', [['#text', 'Todos:']]],
      ['UL', 'tooltip-todos', [['LI', text]]],
      ['STRONG', '', [['#text', 'Summary:']]],
      ['DIV', 'tooltip-summary', [['#text', text]]],
    ]);
    expect(tooltip.querySelectorAll('span, img, a, b, br')).toHaveLength(0);
  });

  it('only a summary shows only the summary, and only todos only the todos', async () => {
    expect(shape(await hover({ blurb: 'Just this' }))).toEqual([
      ['STRONG', '', [['#text', 'Summary:']]],
      ['DIV', 'tooltip-summary', [['#text', 'Just this']]],
    ]);
    expect(shape(await hover({ todos: '- first • * second' }))).toEqual([
      ['STRONG', '', [['#text', 'Todos:']]],
      ['UL', 'tooltip-todos', [['LI', 'first'], ['LI', 'second']]],
    ]);
  });

  it('only the bullet separates todos; an asterisk inside a todo stays in it', async () => {
    expect(shape(await hover({ todos: '• Calculate 2 * 3 • Reply' }))).toEqual([
      ['STRONG', '', [['#text', 'Todos:']]],
      ['UL', 'tooltip-todos', [['LI', 'Calculate 2 * 3'], ['LI', 'Reply']]],
    ]);
  });

  it('hovering again shows the same tooltip once, not twice', async () => {
    const tooltip = await hover({ blurb: 'Once' });
    const row = document.querySelector('.email-item-row');
    row.dispatchEvent(new window.MouseEvent('mouseleave'));
    row.dispatchEvent(new window.MouseEvent('mouseenter'));
    expect(shape(tooltip)).toEqual([
      ['STRONG', '', [['#text', 'Summary:']]],
      ['DIV', 'tooltip-summary', [['#text', 'Once']]],
    ]);
  });

  it('with neither, it says there are no details', async () => {
    for (const item of [{}, { blurb: '', todos: '   ' }, { todos: '• •' }]) {
      const tooltip = await hover(item);
      expect(tooltip.innerHTML).toBe('(No details)');
    }
  });
});
