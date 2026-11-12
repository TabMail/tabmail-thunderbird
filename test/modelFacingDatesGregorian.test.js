/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// modelFacingDatesGregorian.test.js — every date the add-on shows the
// assistant is an English Gregorian date with Latin digits, whatever the
// user's language. Thunderbird's JS default locale is its UI language: a Thai
// Thunderbird formats a default-locale date in the Buddhist calendar (year
// 2569 for 2026), a Persian one in the Persian calendar (1405) in Persian
// digits. A date the assistant reads in another calendar can come back in its
// reply or in an event it writes, a year off on the server.
//
// Each case runs with the default locale set to Thai and to Persian
// (test/helpers/defaultLocale.js) and compares with an oracle built from the
// date's digits, not from Intl.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stubDefaultLocale } from './helpers/defaultLocale.js';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  saveChatLog: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { notifications: {}, events: {} },
}));

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    middayHourForDateHeader: 12,
    msPerDay: 86400000,
  },
}));

vi.mock('../chat/modules/helpers.js', () => ({
  toIsoNoMs: (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  formatTimestampForAgent: () => 'Thursday 2099/01/01 12:00:00 UTC',
  renderToPlainText: async (s) => s,
}));

const kbSessions = { list: [] };
vi.mock('../agent/modules/chatHistoryQueue.js', () => ({
  addChatToQueue: vi.fn(async () => 'session-1'),
  getUnrememberedSessions: vi.fn(async () => kbSessions.list),
  markSessionsAsRemembered: vi.fn(async () => {}),
}));

const sendChat = vi.fn(async () => ({}));
vi.mock('../agent/modules/llm.js', () => ({
  sendChat: (...args) => sendChat(...args),
}));

vi.mock('../agent/modules/promptStore.js', () => ({
  readBeforeAI: vi.fn(async () => ({ content: '' })),
  writeAfterRead: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../agent/modules/reminderStateStore.js', () => ({
  hashReminder: vi.fn(() => 'hash'),
}));

vi.mock('../chat/modules/chatWindowUtils.js', () => ({
  isChatWindowOpen: vi.fn(async () => true),
  openOrFocusChatWindow: vi.fn(async () => {}),
}));

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
  runtime: { sendMessage: vi.fn(async () => {}) },
  tmCalendar: {
    listCalendars: vi.fn(async () => [{ id: 'cal-1', name: 'Home' }]),
    queryCalendarItems: vi.fn(async () => []),
  },
};

const calendarSearch = await import('../chat/tools/calendar_search.js');
const { kbUpdate } = await import('../agent/modules/knowledgebase.js');
const { sendTestProactiveNudge } = await import('../agent/modules/proactiveCheckin.js');
const { formatGregorianDate } = await import('../agent/modules/gregorianDate.js');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const pad2 = (n) => String(n).padStart(2, '0');

/** A day `offset` days from today, as `YYYY-MM-DD` from the local clock. */
function dayKeyFromToday(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** "Thursday, November 12, 2026" from a day's digits. */
function englishDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "4:05:09 PM" from a date's local clock. */
function englishTime(date) {
  const h = date.getHours();
  return `${h % 12 || 12}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "11/12/2026, 4:05:09 PM" (an English date and time) from a date's local clock. */
function englishDateTime(date) {
  return `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}, ${englishTime(date)}`;
}

const LOCALES = ['th', 'fa'];

describe.each(LOCALES)('with the default locale %s', (locale) => {
  let restore;
  beforeEach(() => {
    restore = stubDefaultLocale(locale);
    vi.clearAllMocks();
    calendarSearch.resetPaginationSessions();
  });
  afterEach(() => restore());

  it('the stub really makes the default locale non-Gregorian (control)', () => {
    const dayKey = dayKeyFromToday(7);
    const [y, m, d] = dayKey.split('-').map(Number);
    const shown = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString(undefined, { year: 'numeric', timeZone: 'UTC' });
    expect(shown).not.toContain(String(y));
  });

  it('calendar_search prints each day header as an English Gregorian date', async () => {
    const dayKey = dayKeyFromToday(7);
    const nextDay = dayKeyFromToday(8);
    browser.tmCalendar.queryCalendarItems.mockResolvedValueOnce([{
      id: 'ev-1', calendarId: 'cal-1', title: 'Planning review', isAllDay: true,
      startDay: dayKey, endDay: nextDay, startMs: 0, endMs: 0,
    }]);
    const result = await calendarSearch.run({ query: 'Planning', from_date: dayKey, to_date: dayKey }, {});
    expect(result.error).toBeUndefined();
    expect(result.results).toContain(`date: ${englishDay(dayKey)}\n`);
    expect(result.results).toContain('All day: Planning review');
  });

  it('calendar_search day headers are English Gregorian for every month of the coming year', () => {
    for (let offset = 0; offset < 366; offset += 13) {
      const dayKey = dayKeyFromToday(offset);
      expect(calendarSearch._testExports.formatDayHeader(dayKey, 'UTC').prettyDate).toBe(englishDay(dayKey));
    }
  });

  it('the knowledge base refine reads each chat session date as an English Gregorian date', async () => {
    const when = new Date();
    when.setDate(when.getDate() - 3);
    when.setHours(16, 5, 9, 0);
    kbSessions.list = [{ id: 's-old', timestamp: when.getTime(), messages: [{ role: 'user', content: 'Remind me about the review' }] }];
    await kbUpdate([{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }]);
    expect(sendChat).toHaveBeenCalledTimes(1);
    const [[systemMsg]] = sendChat.mock.calls[0];
    expect(systemMsg.chat_history).toContain(`--- Session from ${englishDateTime(when)} ---`);
  });

  it('the test nudge written into the chat states its time in English with Latin digits', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const now = new Date();
      now.setHours(16, 5, 9, 0);
      vi.setSystemTime(now);
      await sendTestProactiveNudge();
      const sent = browser.runtime.sendMessage.mock.calls.find(([msg]) => msg?.command === 'proactive-checkin-message');
      expect(sent).toBeDefined();
      expect(sent[0].message).toContain(`_Sent at ${englishTime(now)}_`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('formatGregorianDate prints an English Gregorian date with Latin digits', () => {
    expect(typeof formatGregorianDate).toBe('function');
    const dayKey = dayKeyFromToday(30);
    const [y, m, d] = dayKey.split('-').map(Number);
    const noonUtc = new Date(Date.UTC(y, m - 1, d, 12));
    expect(formatGregorianDate(noonUtc, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }))
      .toBe(englishDay(dayKey));
    expect(formatGregorianDate(noonUtc, { year: 'numeric', month: 'numeric', day: 'numeric', timeZone: 'UTC' }))
      .toBe(`${m}/${d}/${y}`);
  });
});

// The same day header as the iOS twin prints (FixedDateFormat "EEEE, MMMM d, yyyy"), whatever the
// default locale, on both sides of the date line.
describe.each(['en-US', 'th', 'fa'])('calendar_search day header matches iOS with the default locale %s', (locale) => {
  let restore;
  beforeEach(() => { restore = stubDefaultLocale(locale); });
  afterEach(() => restore());

  it.each(['Pacific/Pago_Pago', 'America/Los_Angeles', 'UTC', 'Pacific/Auckland', 'Pacific/Kiritimati'])('2099-12-30 in %s is "Wednesday, December 30, 2099"', (tz) => {
    expect(calendarSearch._testExports.formatDayHeader('2099-12-30', tz).prettyDate).toBe('Wednesday, December 30, 2099');
  });
});
