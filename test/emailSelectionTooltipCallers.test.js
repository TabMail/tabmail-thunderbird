/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The email selection list's tooltip, as its callers show it: the archive and
// delete flows list emails to select. Hovering one email, then another, then
// the first again shows each email's own todos and summary, as written, in the
// one tooltip the list shares, and selection keeps working.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

const h = vi.hoisted(() => ({ headers: [], inbox: vi.fn(), summary: vi.fn() }));

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKey: vi.fn(async header => 'u' + header.id),
  getArchiveFolderForHeader: vi.fn(),
  getTrashFolderForHeader: vi.fn(),
}));
vi.mock('../agent/modules/inboxContext.js', () => ({ buildInboxContext: h.inbox }));
vi.mock('../agent/modules/summaryGenerator.js', () => ({ getSummary: h.summary }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/markdown.js', () => ({ attachSpecialLinkListeners: vi.fn(), renderMarkdown: vi.fn(async t => t) }));
vi.mock('../chat/modules/toolCollapse.js', () => ({ isToolCollapseEnabled: () => false, addToolBubbleToGroup: vi.fn() }));
vi.mock('../chat/modules/helpers.js', async original => ({ ...await original(), streamText: vi.fn() }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn(async () => document.createElement('div')) }));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chatlink/modules/fsm.js', () => ({ relayFsmConfirmation: vi.fn(), buildEmailListSummary: vi.fn(() => '') }));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: vi.fn() }));

const { ctx } = await import('../chat/modules/context.js');
const { renderEmailSelectionList } = await import('../chat/modules/helpers.js');
const { runStateArchiveListEmails } = await import('../chat/fsm/emailArchive.js');
const { runStateDeleteListEmails } = await import('../chat/fsm/emailDelete.js');

let dom;

beforeEach(() => {
  dom = new JSDOM('<body><div id="chat-container"></div></body>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  h.headers = [
    { id: 1, subject: '<span>First</span>', author: 'one@example.com', date: new Date(Date.now() + 1000), blurb: '<span data-note="a">First</span> &amp; &#60; &apos;', todos: '• first task • second task' },
    { id: 2, subject: 'Second &amp; subject', author: 'two@example.com', date: new Date(), blurb: 'Second row summary', todos: '• other task • next task' },
  ];
  globalThis.browser = { messages: { get: vi.fn(async id => h.headers.find(header => header.id === id)) } };
  h.summary.mockImplementation(async header => ({ blurb: header.blurb, todos: header.todos }));
  h.inbox.mockImplementation(async () => JSON.stringify(h.headers.map(header => ({
    uniqueId: 'u' + header.id, internalId: header.id, subject: header.subject, from: header.author,
    date: header.date, action: ctx.reviewAction, blurb: header.blurb, todos: header.todos,
  }))));
  Object.assign(ctx, { activePid: 'review', fsmSessions: { review: {} }, selectedEmailList: [], reviewAction: '' });
  window.selectedEmailList = ctx.selectedEmailList;
});

afterEach(() => {
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.browser;
  vi.restoreAllMocks();
});

// Hovers the first row, the second, then the first again: each time the one
// tooltip shows that row's own summary and todos as text, placed by its row.
function hoverEachRow() {
  const rows = [...document.querySelectorAll('.email-item-row')];
  expect(rows).toHaveLength(2);
  const tooltip = document.querySelector('.email-item-tooltip');
  tooltip.getBoundingClientRect = () => ({ width: 100, height: 40 });
  for (const index of [0, 1, 0]) {
    const row = rows[index];
    const expected = h.headers[index];
    row.getBoundingClientRect = () => ({ top: index ? 600 : 20, bottom: index ? 620 : 40, height: 20, right: 300 });
    row.dispatchEvent(new window.MouseEvent('mouseenter'));
    expect(document.querySelectorAll('.email-item-tooltip')).toHaveLength(1);
    expect(tooltip.querySelector('.tooltip-summary').textContent).toBe(expected.blurb);
    expect([...tooltip.querySelectorAll('li')].map(li => li.textContent)).toEqual(expected.todos.split('•').map(s => s.trim()).filter(Boolean));
    expect([...tooltip.querySelectorAll('*')].map(el => el.tagName)).toEqual(['STRONG', 'UL', 'LI', 'LI', 'STRONG', 'DIV']);
    expect(row.querySelector('.subject-col').textContent).toBe(expected.subject);
    expect(row.querySelector('.from-col').textContent).toBe(expected.author);
    expect(tooltip.style.display).toBe('block');
    expect(row.classList.contains('hovered')).toBe(true);
    expect(tooltip.style.left).toBe('192px');
    expect(tooltip.style.top).toBe(index ? '556px' : '44px');
    row.dispatchEvent(new window.MouseEvent('mouseleave'));
    expect(tooltip.style.display).toBe('none');
    expect(row.classList.contains('hovered')).toBe(false);
  }
}

describe('the email selection tooltip in the lists its callers show', () => {
  it.each([
    ['a list to select from', false],
    ['a list only shown', true],
  ])('%s shows each row its own tooltip text', async (_label, displayOnly) => {
    const items = h.headers.map(header => ({ ...header, uniqueId: 'u' + header.id, messageId: header.id, from: header.author }));
    await renderEmailSelectionList(document.getElementById('chat-container'), items, { delay: 0, displayOnly });
    hoverEachRow();
    if (!displayOnly) {
      const inputs = [...document.querySelectorAll('input')];
      expect(inputs.every(input => input.checked)).toBe(true);
      inputs[0].closest('.email-item-row').click();
      expect(window.selectedEmailList.map(item => item.uniqueId)).toEqual(['u2']);
    }
  });

  it.each([
    ['archive', runStateArchiveListEmails],
    ['delete', runStateDeleteListEmails],
  ])('the %s list shows each row its own tooltip text and keeps selection, from the inbox or a given list', async (action, run) => {
    for (const source of ['inbox', 'given']) {
      document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'chat-container' }));
      ctx.reviewAction = action;
      ctx.fsmSessions.review.overrideInternalIds = source === 'given' ? [1, 2] : [];
      await run();
      hoverEachRow();
      expect(window.selectedEmailList).toBe(ctx.selectedEmailList);
      expect(ctx.selectedEmailList.map(item => item.uniqueId)).toEqual(['u1', 'u2']);
      document.querySelector('.email-item-row').click();
      expect(ctx.selectedEmailList.map(item => item.uniqueId)).toEqual(['u2']);
    }
  });
});
