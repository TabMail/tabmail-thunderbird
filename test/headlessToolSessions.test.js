/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #171: a headless run (proactive check-in, reply generation, compose edit)
// runs its tools through executeToolsHeadless with its own isolated context.
// The search tools keep the results they fetched in sessions, so the next page
// of the same call comes from the same results. A run must never be answered
// from another run's sessions: a later run that repeats a call sees what is
// there now, and a run that starts while another is paging leaves that run's
// pages alone. The chat window's turn keeps its own sessions, reset per turn.
//
// This runs the real search tools (memory_search, email_search, inbox_read,
// calendar_search, calendar_read) through the real executeToolsHeadless, over
// stand-ins for the index, the inbox and the calendar that change between runs.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const world = vi.hoisted(() => ({ memory: [], mail: [], inbox: [], events: [] }));

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn(t => t),
  resolveUniqueMessageKey: vi.fn(async id => id),
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugMode: false } }));
vi.mock('../chat/modules/chatConfig.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, CHAT_SETTINGS: { ...original.CHAT_SETTINGS, ftsReadinessTimeoutMs: 200, ftsReadinessRetryDelayMs: 10 } };
});
vi.mock('../chat/modules/context.js', () => ({
  ctx: { rawUserTexts: [], fsmSessions: {}, state: '', activePid: 0, activeToolCallId: null, awaitingPid: 0, idTranslation: { idMap: new Map(), nextNumericId: 1, freeIds: [] } },
  initFsmSession: vi.fn(),
}));
vi.mock('../chat/modules/persistentChatStore.js', () => ({
  loadIdMap: vi.fn(async () => null),
  saveIdMap: vi.fn(),
  saveIdMapImmediate: vi.fn(async () => {}),
}));
// A list shows each item's subject, one per line.
vi.mock('../chat/modules/helpers.js', () => ({
  formatMailList: vi.fn(items => items.map(i => i.subject).join('\n')),
  toNaiveIso: vi.fn(s => s),
  toIsoNoMs: vi.fn((d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')),
  initialiseEmailCompose: vi.fn(),
  streamText: vi.fn(),
}));
vi.mock('../chat/modules/entityResolver.js', () => ({
  resolveEmailSubject: vi.fn(async () => null),
  resolveEventDetails: vi.fn(async () => null),
  resolveContactDetails: vi.fn(async () => null),
}));
vi.mock('../agent/modules/inboxContext.js', () => ({
  buildInboxContext: vi.fn(async () => JSON.stringify(world.inbox)),
}));
vi.mock('../fts/attachmentFlags.js', () => ({
  accountIdOfMsgId: vi.fn(() => 'account1'),
  getAttachmentRepairedAccounts: vi.fn(async () => new Set(['account1'])),
}));
// The index answers as the background's FTS handler does.
vi.mock('../fts/ftsRequest.js', () => ({
  ftsRequest: vi.fn((cmd, fields) => browser.runtime.sendMessage({ type: 'fts', cmd, ...fields })),
}));

// Tools without search sessions are not under test.
const otherTool = { run: vi.fn(async () => ({ ok: true })), resetPaginationSessions: vi.fn() };
for (const name of [
  'attachment_read_pdf', 'calendar_event_create', 'calendar_event_delete', 'calendar_event_edit', 'calendar_event_read',
  'contacts_add', 'contacts_delete', 'contacts_edit', 'contacts_search', 'email_archive', 'email_compose', 'email_delete',
  'email_forward', 'email_move_to_inbox', 'email_read', 'email_reply', 'kb_add', 'kb_del', 'memory_read', 'web_read',
  'reminder_add', 'reminder_del', 'task_add', 'task_del', 'task_edit', 'change_setting', 'template_read', 'template_create',
  'template_edit', 'template_delete', 'template_share', 'template_search', 'template_download', 'template_toggle',
]) {
  vi.doMock(`../chat/tools/${name}.js`, () => otherTool);
}

const words = q => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const matches = (q, text) => words(q).length === 0 || words(q).some(w => text.toLowerCase().includes(w));

globalThis.browser = {
  storage: { local: { get: vi.fn(async d => ({ ...(d || {}) })), set: vi.fn(async () => {}) } },
  runtime: {
    getURL: vi.fn(() => ''),
    sendMessage: vi.fn(async message => {
      if (message?.type !== 'fts') return undefined;
      if (message.cmd === 'memorySearch') {
        return world.memory
          .filter(r => matches(message.q, r.content))
          .sort((a, b) => b.dateMs - a.dateMs)
          .slice(0, message.limit)
          .map(r => ({ ...r }));
      }
      if (message.cmd === 'search') {
        return world.mail.filter(m => matches(message.q, m.subject)).slice(0, message.limit).map(m => ({ ...m }));
      }
      return undefined;
    }),
  },
  tmCalendar: {
    listCalendars: vi.fn(async () => [{ id: 'cal1', name: 'Calendar' }]),
    queryCalendarItems: vi.fn(async () => world.events.map(e => ({ ...e }))),
  },
};

const HOUR_MS = 60 * 60 * 1000;
let core;
let createIsolatedContext;

beforeAll(async () => {
  core = await import('../chat/tools/core.js');
  ({ createIsolatedContext } = await import('../chat/modules/idTranslator.js'));
});

let nextId = 0;
function call(name, args) {
  nextId += 1;
  return { id: `call_${nextId}`, function: { name, arguments: JSON.stringify(args) } };
}

/** One batch of a headless run: the tool's output, as the model reads it. */
async function runTool(run, name, args) {
  const [result] = await core.executeToolsHeadless([call(name, args)], null, run);
  return JSON.parse(result.output);
}

// Adds one more of what each tool lists, newer than all before it.
let added = 0;
function addEverywhere(label) {
  added += 1;
  const dateMs = Date.now() - HOUR_MS + added * 1000;
  world.memory.push({ memId: `turn:${label}`, sessionId: 'persistent_chat', role: 'exchange', content: `[USER]: the ${label} plan`, dateMs });
  world.mail.push({ uniqueId: `account1:/INBOX:${label}@example.com`, subject: `${label} plan`, author: 'sender@example.com', dateMs, hasAttachments: false });
  world.inbox.unshift({ uniqueId: `account1:/INBOX:${label}@example.com`, subject: `${label} plan`, from: 'sender@example.com', date: '' });
  world.events.push({ id: `event-${label}`, calendarId: 'cal1', title: `${label} plan`, startMs: Date.now() + added * HOUR_MS, endMs: Date.now() + added * HOUR_MS + HOUR_MS / 2 });
}

const SEARCHES = {
  'memory_search (a query)': ['memory_search', { query: 'plan' }],
  'memory_search (a listing)': ['memory_search', { query: '' }],
  email_search: ['email_search', { query: 'plan' }],
  inbox_read: ['inbox_read', {}],
  calendar_search: ['calendar_search', { query: 'plan' }],
  calendar_read: ['calendar_read', {}],
};

beforeEach(() => {
  world.memory.length = 0;
  world.mail.length = 0;
  world.inbox.length = 0;
  world.events.length = 0;
  core.resetToolPaginationSessions();
});

describe('a headless run is never answered from another run (#171)', () => {
  for (const [what, [name, args]] of Object.entries(SEARCHES)) {
    it(`${what}: a later run sees what was added after an earlier run`, async () => {
      addEverywhere('harbour');
      const first = await runTool(createIsolatedContext(), name, args);
      expect(first.error).toBeUndefined();
      expect(first.results).toContain('harbour');

      addEverywhere('lantern');
      const later = await runTool(createIsolatedContext(), name, args);
      expect(later.error).toBeUndefined();
      expect(later.results).toContain('harbour');
      expect(later.results).toContain('lantern');
    });
  }

  it('a headless batch without a run context shares sessions with nothing', async () => {
    addEverywhere('harbour');
    expect((await runTool(undefined, 'inbox_read', {})).results).toContain('harbour');
    addEverywhere('lantern');
    expect((await runTool(undefined, 'inbox_read', {})).results).toContain('lantern');
    expect((await core.executeToolByName('inbox_read', {})).results).toContain('lantern');
  });

  it("a run that starts while another is paging leaves that run's pages alone", async () => {
    for (let i = 0; i < 55; i += 1) addEverywhere(`item${i}`);
    const snapshot = world.inbox.map(m => m.subject);
    const run = createIsolatedContext();
    const page1 = (await runTool(run, 'inbox_read', { page_index: 1 })).results;

    addEverywhere('interloper');
    const other = await runTool(createIsolatedContext(), 'inbox_read', { page_index: 1 });
    expect(other.results).toContain('interloper');

    const page2 = (await runTool(run, 'inbox_read', { page_index: 2 })).results;
    const listed = [page1, page2].map(text => text.split('\n').filter(line => line.endsWith(' plan'))).flat();
    expect(listed).toEqual(snapshot);
  });

  it("a new chat turn leaves a headless run's pages alone", async () => {
    for (let i = 0; i < 55; i += 1) addEverywhere(`item${i}`);
    const snapshot = world.inbox.map(m => m.subject);
    const run = createIsolatedContext();
    const page1 = (await runTool(run, 'inbox_read', { page_index: 1 })).results;

    addEverywhere('interloper');
    core.resetToolPaginationSessions();

    const page2 = (await runTool(run, 'inbox_read', { page_index: 2 })).results;
    const listed = [page1, page2].map(text => text.split('\n').filter(line => line.endsWith(' plan'))).flat();
    expect(listed).toEqual(snapshot);
  });

  it("a headless run neither reads nor clears the chat window's turn", async () => {
    for (let i = 0; i < 55; i += 1) addEverywhere(`item${i}`);
    const snapshot = world.inbox.map(m => m.subject);
    const page1 = (await core.executeToolByName('inbox_read', { page_index: 1 })).results;

    addEverywhere('interloper');
    const headless = await runTool(createIsolatedContext(), 'inbox_read', { page_index: 1 });
    expect(headless.results).toContain('interloper');

    const page2 = (await core.executeToolByName('inbox_read', { page_index: 2 })).results;
    const listed = [page1, page2].map(text => text.split('\n').filter(line => line.endsWith(' plan'))).flat();
    expect(listed).toEqual(snapshot);
  });
});
