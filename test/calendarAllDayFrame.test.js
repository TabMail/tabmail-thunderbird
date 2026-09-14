/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarAllDayFrame.test.js — #47: an all-day event is an RFC 5545 DATE with
// no zone. The bridge carries its epoch as UTC midnight, so any consumer that
// re-expresses that epoch in a zone west of UTC names the PREVIOUS day. These
// tests pin the invariant that every consumer keys an all-day item by its own
// calendar date, under a zone where the epoch path is provably wrong.

// Pin the process zone west of UTC BEFORE any Date arithmetic happens. Node
// re-reads TZ on assignment, and ESM imports below run before the tests do, so
// every `new Date(...)` in the modules under test sees this zone.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { experimentFunctions } from './helpers/experimentFunctions.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

// A day one week out, as the calendar's own digits.
function dayDigits(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  const pad2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const DAY = dayDigits(7);
const NEXT_DAY = dayDigits(8);
const PREV_DAY = dayDigits(6);
// What the bridge actually carries for a DATE: UTC midnight of that date.
const utcMidnight = (day) => { const [y, m, d] = day.split('-').map(Number); return Date.UTC(y, m - 1, d); };

globalThis.browser = {
  tmCalendar: {
    listCalendars: vi.fn(async () => [{ id: 'cal1', name: 'Personal' }]),
    queryCalendarItems: vi.fn(async () => []),
    getCalendarEventDetails: vi.fn(async () => ({ ok: false, error: 'not found' })),
  },
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined) },
};
globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    calendarEntryMatchToleranceMs: 60000,
    calendarPageSizeDefault: 100,
    calendarPageSizeMax: 100,
    msPerDay: 86400000,
    middayHourForDateHeader: 12,
    calendarQueryLogPreviewChars: 120,
    calendarQueryLogTermsPreviewCount: 5,
    searchDefaultDaysBack: 365,
  },
}));
// The REAL toNaiveIso/toIsoNoMs — the shift under test lives in their local-zone
// rendering, so a UTC-based mock would hide the bug this file exists to pin.
vi.mock('../chat/modules/helpers.js', async () => {
  const actual = await vi.importActual('../chat/modules/helpers.js');
  return { toNaiveIso: actual.toNaiveIso, toIsoNoMs: actual.toIsoNoMs, streamText: vi.fn() };
});
vi.mock('../chat/modules/context.js', () => ({ ctx: { activePid: 0, awaitingPid: 0, activeToolCallId: null } }));
vi.mock('../chat/modules/markdown.js', () => ({ attachSpecialLinkListeners: vi.fn(), renderMarkdown: vi.fn() }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn(async () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } })) }));

const { run: calendarReadRun, resetPaginationSessions } = await import('../chat/tools/calendar_read.js');
const { run: calendarEventReadRun, _testExports: readExports } = await import('../chat/tools/calendar_event_read.js');
const { _testExports: searchExports } = await import('../chat/tools/calendar_search.js');

describe('precondition: the process zone is west of UTC', () => {
  it('renders UTC midnight of DAY on the previous local day', () => {
    expect(new Date(utcMidnight(DAY)).getDate()).not.toBe(Number(DAY.slice(8, 10)));
  });
});

describe('bridge: toDayString / allDayNaiveIso', () => {
  const fns = experimentFunctions(bridgeUrl, ['toDayString', 'allDayNaiveIso']);

  it('renders a calIDateTime DATE from its own digits (0-based month)', () => {
    const [y, m, d] = DAY.split('-').map(Number);
    expect(fns.toDayString({ year: y, month: m - 1, day: d, isDate: true })).toBe(DAY);
  });

  it('returns empty for a missing or malformed value', () => {
    expect(fns.toDayString(null)).toBe('');
    expect(fns.toDayString({ year: 'x', month: 1, day: 1 })).toBe('');
  });

  it('shapes an all-day recurrence id so the tool layer round-trips it unchanged', async () => {
    const { toNaiveIso } = await vi.importActual('../chat/modules/helpers.js');
    const rid = fns.allDayNaiveIso(DAY);
    expect(rid).toBe(`${DAY}T00:00:00`);
    // calendar_event_edit normalizes recurrence_id through toNaiveIso; the naive
    // shape must survive it, whereas a bare date is shifted a day west of UTC.
    expect(toNaiveIso(rid)).toBe(rid);
    expect(toNaiveIso(DAY)).not.toBe(`${DAY}T00:00:00`);
  });
});

describe('calendar_read: all-day items are grouped under their own calendar date', () => {
  beforeEach(() => { resetPaginationSessions(); vi.clearAllMocks(); });

  it('keys the day from startDay, not from the UTC-midnight epoch', async () => {
    browser.tmCalendar.queryCalendarItems.mockResolvedValueOnce([
      { id: 'ad', calendarId: 'cal1', title: 'Holiday', startMs: utcMidnight(DAY), endMs: utcMidnight(NEXT_DAY), isAllDay: true, startDay: DAY, endDay: NEXT_DAY, attendeeList: [] },
    ]);
    const result = await calendarReadRun({ calendar_ids: ['cal1'], from_date: PREV_DAY, to_date: NEXT_DAY });
    const days = result.results.split('\n\n');
    const holidayBlock = days.find((b) => b.includes('Holiday'));
    expect(holidayBlock).toBeDefined();
    const prettyOf = (day) => searchExports.formatDayHeader(day, 'America/Vancouver').prettyDate;
    expect(holidayBlock).toContain(`date: ${prettyOf(DAY)}`);
    expect(holidayBlock).not.toContain(`date: ${prettyOf(PREV_DAY)}`);
  });

  it('localMidnightOfDay orders an all-day item at the start of its own day', () => {
    const m = searchExports.localMidnightOfDay(DAY);
    expect([m.getFullYear(), m.getMonth() + 1, m.getDate(), m.getHours()]).toEqual([...DAY.split('-').map(Number), 0]);
  });
});

describe('calendar_event_read: all-day start_iso/end_iso are the date digits', () => {
  beforeEach(() => vi.clearAllMocks());

  it('formatDetailed renders the DATE, never the epoch re-expressed locally', () => {
    const out = readExports.formatDetailed(
      { id: 'ad', title: 'Holiday', startMs: utcMidnight(DAY), endMs: utcMidnight(NEXT_DAY), isAllDay: true, startDay: DAY, endDay: NEXT_DAY },
      { id: 'cal1' },
    );
    expect(out).toContain(`start_iso: ${DAY}T00:00:00`);
    expect(out).toContain(`end_iso: ${NEXT_DAY}T00:00:00`);
    expect(out).toContain('all_day: yes');
    expect(out).not.toContain(PREV_DAY);
  });

  it('formatDetailed leaves timed events on the epoch path', () => {
    const [y, m, d] = DAY.split('-').map(Number);
    const startMs = new Date(y, m - 1, d, 17, 0, 0).getTime();
    const out = readExports.formatDetailed({ id: 't', title: 'Sync', startMs, endMs: startMs + 3600000, isAllDay: false }, { id: 'cal1' });
    expect(out).toContain(`start_iso: ${DAY}T17:00:00`);
  });

  it('formatFromDetails renders the DATE for the direct-lookup path', () => {
    const out = readExports.formatFromDetails({ calendarId: 'cal1', id: 'ad', title: 'Holiday', start: utcMidnight(DAY), end: utcMidnight(NEXT_DAY), isAllDay: true, startDay: DAY, endDay: NEXT_DAY });
    expect(out).toContain(`start_iso: ${DAY}T00:00:00`);
    expect(out).toContain(`end_iso: ${NEXT_DAY}T00:00:00`);
    expect(out).not.toContain(PREV_DAY);
  });

  it('search by the all-day start_iso the summary showed finds the item', async () => {
    browser.tmCalendar.queryCalendarItems.mockResolvedValue([
      { id: 'ad', calendarId: 'cal1', title: 'Holiday', startMs: utcMidnight(DAY), endMs: utcMidnight(NEXT_DAY), isAllDay: true, startDay: DAY, endDay: NEXT_DAY, attendeeList: [] },
    ]);
    const result = await calendarEventReadRun({ start_iso: `${DAY}T00:00:00` });
    expect(result.ok).toBe(true);
    expect(result.results).toContain('Holiday');
    expect(result.results).toContain(`start_iso: ${DAY}T00:00:00`);
  });
});
