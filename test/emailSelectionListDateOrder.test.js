/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The archive and delete flows list the emails to select newest first, in any
// UI language. The order comes from each email's own time; a date written in
// the user's locale and parsed back sorts wrongly (in en-GB, 12 November reads
// back as 11 December and 5 December as 12 May; a Thai date carries the
// Buddhist year). The date column shows that time in the user's locale.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { stubDefaultLocale } from './helpers/defaultLocale.js';

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
const { formatTimestampForAgent } = await import('../chat/modules/helpers.js');
const { runStateArchiveListEmails } = await import('../chat/fsm/emailArchive.js');
const { runStateDeleteListEmails } = await import('../chat/fsm/emailDelete.js');

let dom;
let restoreLocale = () => {};

// Next year's 12 November and 5 December, 10:00 local: day and month both
// read as a month, so a day/month swap still parses, to the wrong order.
const year = new Date().getFullYear() + 1;
const november12 = new Date(year, 10, 12, 10, 0, 0);
const december5 = new Date(year, 11, 5, 10, 0, 0);

beforeEach(() => {
  dom = new JSDOM('<body><div id="chat-container"></div></body>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // Older first, as the inbox may hold them.
  h.headers = [
    { id: 1, subject: 'Older', author: 'one@example.com', date: november12 },
    { id: 2, subject: 'Newer', author: 'two@example.com', date: december5 },
  ];
  globalThis.browser = { messages: { get: vi.fn(async id => h.headers.find(header => header.id === id)) } };
  h.summary.mockImplementation(async () => ({ blurb: '', todos: '' }));
  // As buildInboxContext builds each entry: the assistant's timestamp and the header's time.
  h.inbox.mockImplementation(async () => JSON.stringify(h.headers.map(header => ({
    uniqueId: 'u' + header.id, internalId: header.id, subject: header.subject, from: header.author,
    date: formatTimestampForAgent(header.date), dateMs: header.date.getTime(), action: ctx.reviewAction, blurb: '', todos: '',
  }))));
  Object.assign(ctx, { activePid: 'review', fsmSessions: { review: {} }, selectedEmailList: [], reviewAction: '' });
  window.selectedEmailList = ctx.selectedEmailList;
});

afterEach(() => {
  restoreLocale();
  restoreLocale = () => {};
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.browser;
  vi.restoreAllMocks();
});

describe.each(['en-GB', 'th'])('with the default locale %s', (locale) => {
  it.each([
    ['archive', runStateArchiveListEmails],
    ['delete', runStateDeleteListEmails],
  ])('the %s list shows the newest email first, from the inbox or a given list', async (action, run) => {
    restoreLocale = stubDefaultLocale(locale);
    for (const source of ['inbox', 'given']) {
      document.body.replaceChildren(Object.assign(document.createElement('div'), { id: 'chat-container' }));
      ctx.reviewAction = action;
      ctx.fsmSessions.review.overrideInternalIds = source === 'given' ? [1, 2] : [];
      await run();
      const rows = [...document.querySelectorAll('.email-item-row')];
      expect(rows.map(row => row.querySelector('.subject-col').textContent), source).toEqual(['Newer', 'Older']);
      expect(rows.map(row => row.querySelector('.date-col').textContent), source)
        .toEqual([december5.toLocaleString(), november12.toLocaleString()]);
    }
  });
});
