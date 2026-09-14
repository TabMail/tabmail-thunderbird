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

// ---------------------------------------------------------------------------
// Producer side: the REAL bridge, driven end to end in node:vm. A consumer test
// with a hand-written `startDay` proves nothing about whether the bridge emits
// one; these pin what queryCalendarItems/getCalendarEventDetails actually
// carry, and that the provider's range query is the sole window filter.
// ---------------------------------------------------------------------------
const { loadCalendarBridge, fakeDate, fakeDateTime } = await import('./helpers/calendarBridgeHarness.js');

function allDayItem(id, startDay, endDay, extra = {}) {
  return { id, title: 'Holiday', startDate: fakeDate(startDay), endDate: fakeDate(endDay), getProperty: () => '', getAttendees: () => [], ...extra };
}

describe('bridge producer: all-day items carry their calendar date, not an instant', () => {
  const tightWindow = () => {
    const mid = new Date(`${DAY}T00:00:00`).getTime();
    return { from: new Date(mid - 60000).toISOString(), to: new Date(mid + 60000).toISOString() };
  };

  it('queryCalendarItems emits startDay/endDay from the DATE digits while startMs stays UTC midnight', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayItem('ad', DAY, NEXT_DAY)] });
    const [row] = await api.queryCalendarItems(`${PREV_DAY}T00:00:00`, `${NEXT_DAY}T23:59:59`, ['cal1']);
    expect(row).toMatchObject({ id: 'ad', isAllDay: true, startDay: DAY, endDay: NEXT_DAY, recurrenceId: '', isOccurrence: false });
    expect(row.startMs).toBe(utcMidnight(DAY));
    // The epoch alone names the previous day in this zone — the reason startDay exists.
    expect(new Date(row.startMs).getDate()).toBe(Number(PREV_DAY.slice(8, 10)));
  });

  it('a timed item gets no day digits', async () => {
    const timed = { id: 't', title: 'Sync', startDate: fakeDateTime(DAY, 17), endDate: fakeDateTime(DAY, 18), getProperty: () => '', getAttendees: () => [] };
    const { api } = loadCalendarBridge(bridgeUrl, { items: [timed] });
    const [row] = await api.queryCalendarItems(`${DAY}T00:00:00`, `${NEXT_DAY}T00:00:00`, ['cal1']);
    expect(row).toMatchObject({ isAllDay: false, startDay: '', endDay: '' });
    expect(row.startMs).toBe(new Date(`${DAY}T17:00:00`).getTime());
  });

  it('an all-day RECURRENCE-ID is emitted in the naive shape the edit tools round-trip', async () => {
    const parent = allDayItem('series', DAY, NEXT_DAY, { recurrenceInfo: { getRecurrenceItems: () => [] } });
    const occ = allDayItem('series#occ', DAY, NEXT_DAY, { recurrenceId: fakeDate(DAY), parentItem: parent });
    const { api } = loadCalendarBridge(bridgeUrl, { items: [occ] });
    const [row] = await api.queryCalendarItems(`${PREV_DAY}T00:00:00`, `${NEXT_DAY}T23:59:59`, ['cal1']);
    expect(row).toMatchObject({ isOccurrence: true, recurrenceId: `${DAY}T00:00:00`, startDay: DAY, isRecurring: true });
  });

  it('a moved all-day occurrence keeps the original RECURRENCE-ID but reports its new day', async () => {
    const parent = allDayItem('series', DAY, NEXT_DAY, { recurrenceInfo: { getRecurrenceItems: () => [] } });
    const moved = allDayItem('series#occ', NEXT_DAY, dayDigits(9), { recurrenceId: fakeDate(DAY), parentItem: parent });
    const { api } = loadCalendarBridge(bridgeUrl, { items: [moved] });
    const [row] = await api.queryCalendarItems(`${PREV_DAY}T00:00:00`, `${dayDigits(9)}T23:59:59`, ['cal1']);
    expect(row.recurrenceId).toBe(`${DAY}T00:00:00`);
    expect(row.startDay).toBe(NEXT_DAY);
    expect(row.endDay).toBe(dayDigits(9));
  });

  it('a timed RECURRENCE-ID passes through as the provider renders it', async () => {
    const parent = { id: 'series', title: 'Standup', startDate: fakeDateTime(DAY, 9), endDate: fakeDateTime(DAY, 9, 30), getProperty: () => '', getAttendees: () => [], recurrenceInfo: { getRecurrenceItems: () => [] } };
    const occ = { ...parent, id: 'series#occ', recurrenceId: fakeDateTime(DAY, 9), parentItem: parent };
    const { api } = loadCalendarBridge(bridgeUrl, { items: [occ] });
    const [row] = await api.queryCalendarItems(`${DAY}T00:00:00`, `${NEXT_DAY}T00:00:00`, ['cal1']);
    expect(row.recurrenceId).toBe(fakeDateTime(DAY, 9).toString());
    expect(row.isAllDay).toBe(false);
  });

  it('getCalendarEventDetails carries startDay/endDay for a DATE and blanks for a date-time', async () => {
    const timed = { id: 't', title: 'Sync', startDate: fakeDateTime(DAY, 17), endDate: fakeDateTime(DAY, 18), getProperty: () => '', getAttendees: () => [] };
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayItem('ad', DAY, NEXT_DAY), timed] });
    const allDay = await api.getCalendarEventDetails('ad', 'cal1');
    expect(allDay).toMatchObject({ ok: true, isAllDay: true, startDay: DAY, endDay: NEXT_DAY, start: utcMidnight(DAY) });
    const details = await api.getCalendarEventDetails('t', 'cal1');
    expect(details).toMatchObject({ ok: true, isAllDay: false, startDay: '', endDay: '' });
  });

  it('a tight window around the all-day start returns the item the provider returned', async () => {
    const { from, to } = tightWindow();
    const { api, getItemsCalls } = loadCalendarBridge(bridgeUrl, { items: [allDayItem('ad', DAY, NEXT_DAY)] });
    const rows = await api.queryCalendarItems(from, to, ['cal1']);
    // The provider is the ONLY window filter: it was asked exactly once with
    // the bridge's own bounds, and its answer was not re-filtered.
    expect(getItemsCalls).toHaveLength(1);
    expect(getItemsCalls[0].start.toString()).toBe(new Date(from).toISOString().replace(/[-:]|\.\d{3}/g, ''));
    expect(getItemsCalls[0].end.toString()).toBe(new Date(to).toISOString().replace(/[-:]|\.\d{3}/g, ''));
    expect(rows.map((r) => r.id)).toEqual(['ad']);
  });

  it('calendar_event_read by the all-day start_iso the summary showed finds the item through the real bridge', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayItem('ad', DAY, NEXT_DAY)] });
    browser.tmCalendar.queryCalendarItems.mockImplementation((...a) => api.queryCalendarItems(...a));
    try {
      const result = await calendarEventReadRun({ start_iso: `${DAY}T00:00:00` });
      expect(result.ok).toBe(true);
      expect(result.results).toContain('Holiday');
      expect(result.results).toContain(`start_iso: ${DAY}T00:00:00`);
      expect(result.results).toContain(`end_iso: ${NEXT_DAY}T00:00:00`);
    } finally {
      browser.tmCalendar.queryCalendarItems.mockReset();
      browser.tmCalendar.queryCalendarItems.mockResolvedValue([]);
    }
  });
});
