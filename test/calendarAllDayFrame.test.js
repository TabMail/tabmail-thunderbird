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
const { run: calendarSearchRun, _testExports: searchExports } = await import('../chat/tools/calendar_search.js');

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
// carry, that the provider's bounded range query is the sole window filter,
// and that the recurrence token the read tool shows selects the same
// occurrence when it comes back through calendar_event_edit.
// ---------------------------------------------------------------------------
const { loadCalendarBridge, fakeDate, fakeDateTime, fakeEvent, UTC_ZONE } = await import('./helpers/calendarBridgeHarness.js');
const { _testExports: editExports } = await import('../chat/tools/calendar_event_edit.js');

const DAY_AFTER_NEXT = dayDigits(9);
const allDayEvent = (id, title, startDay, endDay, extra = {}) =>
  fakeEvent({ id, title, startDate: fakeDate(startDay), endDate: fakeDate(endDay), ...extra });
const timedEvent = (id, title, day, hour, extra = {}) =>
  fakeEvent({ id, title, startDate: fakeDateTime(day, hour), endDate: fakeDateTime(day, hour + 1), ...extra });
// A three-occurrence all-day series; the middle occurrence is the edit target.
function allDaySeries({ moved = false } = {}) {
  const occurrences = [
    allDayEvent('series', 'Holiday', PREV_DAY, DAY, { recurrenceId: fakeDate(PREV_DAY) }),
    moved
      ? allDayEvent('series', 'Holiday', NEXT_DAY, DAY_AFTER_NEXT, { recurrenceId: fakeDate(DAY) })
      : allDayEvent('series', 'Holiday', DAY, NEXT_DAY, { recurrenceId: fakeDate(DAY) }),
    allDayEvent('series', 'Holiday', DAY_AFTER_NEXT, dayDigits(10), { recurrenceId: fakeDate(DAY_AFTER_NEXT) }),
  ];
  return fakeEvent({ id: 'series', title: 'Holiday', startDate: fakeDate(PREV_DAY), endDate: fakeDate(DAY), occurrences });
}
const utcComponents = (iso) => { const d = new Date(iso); return [d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]; };
const dtComponents = (dt) => [dt.year, dt.month, dt.day, dt.hour, dt.minute, dt.second];
const tightWindow = () => {
  const mid = new Date(`${DAY}T00:00:00`).getTime();
  return { from: new Date(mid - 60000).toISOString(), to: new Date(mid + 60000).toISOString() };
};

describe('bridge producer: all-day items carry their calendar date, not an instant', () => {
  it('queryCalendarItems emits startDay/endDay from the DATE digits while startMs stays UTC midnight', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('ad', 'Holiday', DAY, NEXT_DAY)] });
    const [row] = await api.queryCalendarItems(`${PREV_DAY}T00:00:00`, `${NEXT_DAY}T23:59:59`, ['cal1']);
    expect(row).toMatchObject({ id: 'ad', isAllDay: true, startDay: DAY, endDay: NEXT_DAY, recurrenceId: '', isOccurrence: false });
    expect(row.startMs).toBe(utcMidnight(DAY));
    // The epoch alone names the previous day in this zone — the reason startDay exists.
    expect(new Date(row.startMs).getDate()).toBe(Number(PREV_DAY.slice(8, 10)));
  });

  it('a timed item gets no day digits', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [timedEvent('t', 'Sync', DAY, 17)] });
    const [row] = await api.queryCalendarItems(`${DAY}T00:00:00`, `${NEXT_DAY}T00:00:00`, ['cal1']);
    expect(row).toMatchObject({ isAllDay: false, startDay: '', endDay: '' });
    expect(row.startMs).toBe(new Date(`${DAY}T17:00:00`).getTime());
  });

  it('an all-day RECURRENCE-ID is emitted in the naive shape the edit tools round-trip', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDaySeries()] });
    const rows = await api.queryCalendarItems(`${DAY}T00:00:00`, `${NEXT_DAY}T00:00:00`, ['cal1']);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'series', isOccurrence: true, recurrenceId: `${DAY}T00:00:00`, startDay: DAY, endDay: NEXT_DAY, isRecurring: true });
  });

  it('a moved all-day occurrence keeps the original RECURRENCE-ID but reports its new day', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDaySeries({ moved: true })] });
    const rows = await api.queryCalendarItems(`${NEXT_DAY}T00:00:00`, `${DAY_AFTER_NEXT}T00:00:00`, ['cal1']);
    const moved = rows.find((r) => r.recurrenceId === `${DAY}T00:00:00`);
    expect(moved).toBeDefined();
    expect(moved).toMatchObject({ startDay: NEXT_DAY, endDay: DAY_AFTER_NEXT });
  });

  it('a timed RECURRENCE-ID passes through as the provider renders it', async () => {
    const series = fakeEvent({ id: 'standup', title: 'Standup', startDate: fakeDateTime(DAY, 9), endDate: fakeDateTime(DAY, 9, 30),
      occurrences: [timedEvent('standup', 'Standup', DAY, 9, { recurrenceId: fakeDateTime(DAY, 9) })] });
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series] });
    const [row] = await api.queryCalendarItems(`${DAY}T00:00:00`, `${NEXT_DAY}T00:00:00`, ['cal1']);
    expect(row.recurrenceId).toBe(fakeDateTime(DAY, 9).toString());
    expect(row.isAllDay).toBe(false);
  });

  it('getCalendarEventDetails carries startDay/endDay for a DATE and blanks for a date-time', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('ad', 'Holiday', DAY, NEXT_DAY), timedEvent('t', 'Sync', DAY, 17)] });
    const allDay = await api.getCalendarEventDetails('ad', 'cal1');
    expect(allDay).toMatchObject({ ok: true, isAllDay: true, startDay: DAY, endDay: NEXT_DAY, start: utcMidnight(DAY) });
    const details = await api.getCalendarEventDetails('t', 'cal1');
    expect(details).toMatchObject({ ok: true, isAllDay: false, startDay: '', endDay: '' });
  });
});

describe('bridge producer: the provider range query is the only window filter', () => {
  it('a tight window around the all-day start returns the item the provider returned', async () => {
    const { from, to } = tightWindow();
    const { api, getItemsCalls } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('ad', 'Holiday', DAY, NEXT_DAY)] });
    const rows = await api.queryCalendarItems(from, to, ['cal1']);
    expect(getItemsCalls).toHaveLength(1);
    // The bridge asks for events (with occurrences), bounded, over exactly the
    // caller's window: a Z-suffixed ISO is carried as UTC components in UTC.
    expect(getItemsCalls[0].filter & 1).toBe(1);
    expect(getItemsCalls[0].count).toBeGreaterThan(0);
    expect(dtComponents(getItemsCalls[0].start)).toEqual(utcComponents(from));
    expect(dtComponents(getItemsCalls[0].end)).toEqual(utcComponents(to));
    expect(getItemsCalls[0].start.timezone).toBe(UTC_ZONE);
    expect(getItemsCalls[0].end.timezone).toBe(UTC_ZONE);
    expect(rows.map((r) => r.id)).toEqual(['ad']);
  });

  it('an item outside the window is not returned', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('ad', 'Holiday', DAY, NEXT_DAY), timedEvent('t', 'Sync', DAY, 17)] });
    const before = await api.queryCalendarItems(`${dayDigits(3)}T00:00:00`, `${dayDigits(5)}T00:00:00`, ['cal1']);
    expect(before).toEqual([]);
    const after = await api.queryCalendarItems(`${dayDigits(10)}T00:00:00`, `${dayDigits(12)}T00:00:00`, ['cal1']);
    expect(after).toEqual([]);
  });

  it('the query stays bounded: a provider holding more items than the cap returns the cap', async () => {
    const items = Array.from({ length: 101 }, (_, i) => timedEvent(`t${i}`, `Slot ${i}`, DAY, 0));
    const { api, getItemsCalls } = loadCalendarBridge(bridgeUrl, { items });
    const rows = await api.queryCalendarItems(`${DAY}T00:00:00`, `${NEXT_DAY}T00:00:00`, ['cal1']);
    expect(rows).toHaveLength(getItemsCalls[0].count);
    expect(rows.length).toBeLessThan(items.length);
  });

  it('calendar_event_read by the all-day start_iso the summary showed finds the item through the real bridge', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('ad', 'Holiday', DAY, NEXT_DAY)] });
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

describe('calendar_event_read direct lookup: the DATE endpoints survive the public event_id path', () => {
  it('renders the all-day event by event_id + calendar_id with its own date digits', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('ad', 'Holiday', DAY, NEXT_DAY)] });
    browser.tmCalendar.getCalendarEventDetails.mockImplementation((...a) => api.getCalendarEventDetails(...a));
    try {
      const result = await calendarEventReadRun({ event_id: 'ad', calendar_id: 'cal1' });
      expect(result.ok).toBe(true);
      expect(result.results).toContain('Holiday');
      expect(result.results).toContain(`start_iso: ${DAY}T00:00:00`);
      expect(result.results).toContain(`end_iso: ${NEXT_DAY}T00:00:00`);
      expect(result.results).not.toContain(PREV_DAY);
    } finally {
      browser.tmCalendar.getCalendarEventDetails.mockReset();
      browser.tmCalendar.getCalendarEventDetails.mockResolvedValue({ ok: false, error: 'not found' });
    }
  });
});

describe('calendar_event_read: multi-day and timed events keep their exact endpoints through both public paths', () => {
  const THREE_DAYS_OUT = dayDigits(10);

  it('a three-day all-day event reports its exclusive end date, not start + 1 day', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('md', 'Retreat', DAY, THREE_DAYS_OUT)] });
    browser.tmCalendar.queryCalendarItems.mockImplementation((...a) => api.queryCalendarItems(...a));
    browser.tmCalendar.getCalendarEventDetails.mockImplementation((...a) => api.getCalendarEventDetails(...a));
    try {
      const byStart = await calendarEventReadRun({ start_iso: `${DAY}T00:00:00` });
      expect(byStart.ok).toBe(true);
      expect(byStart.results).toContain(`start_iso: ${DAY}T00:00:00`);
      expect(byStart.results).toContain(`end_iso: ${THREE_DAYS_OUT}T00:00:00`);
      expect(byStart.results).not.toContain(`end_iso: ${NEXT_DAY}T00:00:00`);
      const byId = await calendarEventReadRun({ event_id: 'md', calendar_id: 'cal1' });
      expect(byId.ok).toBe(true);
      expect(byId.results).toContain(`start_iso: ${DAY}T00:00:00`);
      expect(byId.results).toContain(`end_iso: ${THREE_DAYS_OUT}T00:00:00`);
      expect(byId.results).toContain('all_day: yes');
    } finally {
      browser.tmCalendar.queryCalendarItems.mockReset();
      browser.tmCalendar.queryCalendarItems.mockResolvedValue([]);
      browser.tmCalendar.getCalendarEventDetails.mockReset();
      browser.tmCalendar.getCalendarEventDetails.mockResolvedValue({ ok: false, error: 'not found' });
    }
  });

  it('a timed event looked up by event_id renders its wall-clock endpoints, never the DATE arm', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [timedEvent('t', 'Sync', DAY, 17)] });
    browser.tmCalendar.getCalendarEventDetails.mockImplementation((...a) => api.getCalendarEventDetails(...a));
    try {
      const byId = await calendarEventReadRun({ event_id: 't', calendar_id: 'cal1' });
      expect(byId.ok).toBe(true);
      expect(byId.results).toContain(`start_iso: ${DAY}T17:00:00`);
      expect(byId.results).toContain(`end_iso: ${DAY}T18:00:00`);
      expect(byId.results).toContain('all_day: no');
      expect(byId.results).not.toContain('T00:00:00');
    } finally {
      browser.tmCalendar.getCalendarEventDetails.mockReset();
      browser.tmCalendar.getCalendarEventDetails.mockResolvedValue({ ok: false, error: 'not found' });
    }
  });
});

describe('calendar_event_read by start_iso: an overlapping all-day item is not a match for a timed start', () => {
  it('a noon lookup returns the noon item and excludes the all-day item the provider also returned', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('ad', 'Holiday', DAY, NEXT_DAY), timedEvent('t', 'Lunch', DAY, 12)] });
    browser.tmCalendar.queryCalendarItems.mockImplementation((...a) => api.queryCalendarItems(...a));
    try {
      // The provider legitimately returns BOTH for the tool's tight noon window:
      // the all-day item spans it. Only the tolerance test separates them.
      const noon = new Date(`${DAY}T12:00:00`).getTime();
      const both = await api.queryCalendarItems(new Date(noon - 60000).toISOString(), new Date(noon + 60000).toISOString(), ['cal1']);
      expect(both.map((it) => it.id).sort()).toEqual(['ad', 't']);
      const result = await calendarEventReadRun({ start_iso: `${DAY}T12:00:00` });
      expect(result.ok).toBe(true);
      expect(result.results).toContain('Lunch');
      expect(result.results).toContain(`start_iso: ${DAY}T12:00:00`);
      expect(result.results).toContain(`end_iso: ${DAY}T13:00:00`);
      expect(result.results).toContain('all_day: no');
      expect(result.results).not.toContain('Holiday');
      // Positive control: the midnight lookup still finds the all-day item.
      const midnight = await calendarEventReadRun({ start_iso: `${DAY}T00:00:00` });
      expect(midnight.ok).toBe(true);
      expect(midnight.results).toContain('Holiday');
    } finally {
      browser.tmCalendar.queryCalendarItems.mockReset();
      browser.tmCalendar.queryCalendarItems.mockResolvedValue([]);
    }
  });
});

describe('edit round-trip: the recurrence token the read tool shows selects that occurrence in the bridge', () => {
  const field = (text, name) => (text.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1];

  async function readThenEdit({ moved, withCalendarHint }) {
    const { api, calendar, modifications } = loadCalendarBridge(bridgeUrl, { items: [allDaySeries({ moved })] });
    browser.tmCalendar.queryCalendarItems.mockImplementation((...a) => api.queryCalendarItems(...a));
    try {
      // Read the target by the day it is shown on (a moved occurrence sits on NEXT_DAY).
      const shownDay = moved ? NEXT_DAY : DAY;
      const read = await calendarEventReadRun({ start_iso: `${shownDay}T00:00:00` });
      expect(read.ok).toBe(true);
      const text = read.results;
      expect(field(text, 'start_iso')).toBe(`${shownDay}T00:00:00`);
      expect(field(text, 'recurrence_id')).toBe(`${DAY}T00:00:00`);
      // Feed the shown fields back through the edit tool's normalizer into the bridge.
      const args = editExports.normalizeArgs({
        event_id: field(text, 'event_id'),
        recurrence_id: field(text, 'recurrence_id'),
        edit_scope: 'this_only',
        title: 'Renamed',
        ...(withCalendarHint ? { calendar_id: field(text, 'calendar_id') } : {}),
      });
      const res = await api.modifyCalendarEvent(args);
      expect(res).toMatchObject({ ok: true, event_id: 'series', title: 'Renamed' });
    } finally {
      browser.tmCalendar.queryCalendarItems.mockReset();
      browser.tmCalendar.queryCalendarItems.mockResolvedValue([]);
    }
    return { calendar, modifications };
  }

  for (const withCalendarHint of [true, false]) {
    it(`renames only the ordinary occurrence (${withCalendarHint ? 'with' : 'without'} calendar hint)`, async () => {
      const { calendar, modifications } = await readThenEdit({ moved: false, withCalendarHint });
      expect(modifications).toHaveLength(1);
      expect(modifications[0].oldItem.recurrenceId.compare(fakeDate(DAY))).toBe(0);
      const occ = calendar.items[0].recurrenceInfo.occurrences;
      // Exactly the three original exceptions: a wrongly-typed lookup would have
      // persisted a fourth (proxy) exception and left the target untouched.
      expect(occ.map((o) => o.title)).toEqual(['Holiday', 'Renamed', 'Holiday']);
      expect(occ.map((o) => o.recurrenceId.toString())).toEqual([PREV_DAY, DAY, DAY_AFTER_NEXT].map((d) => d.replace(/-/g, '')));
      expect(calendar.items[0].title).toBe('Holiday');
      // The persisted occurrence keeps its DATE frame and RECURRENCE-ID.
      expect(occ[1].startDate.isDate).toBe(true);
      expect(occ[1].recurrenceId.compare(fakeDate(DAY))).toBe(0);
    });

    it(`renames only the moved occurrence (${withCalendarHint ? 'with' : 'without'} calendar hint)`, async () => {
      const { calendar, modifications } = await readThenEdit({ moved: true, withCalendarHint });
      expect(modifications).toHaveLength(1);
      const occ = calendar.items[0].recurrenceInfo.occurrences;
      expect(occ.map((o) => o.title)).toEqual(['Holiday', 'Renamed', 'Holiday']);
      expect(occ[1].recurrenceId.compare(fakeDate(DAY))).toBe(0);
      expect(occ[1].startDate.compare(fakeDate(NEXT_DAY))).toBe(0);
    });
  }
});

describe('public callers: bridge-produced all-day rows render and order correctly', () => {
  const items = () => [allDayEvent('ad', 'Holiday party', DAY, NEXT_DAY), timedEvent('t', 'Party planning', DAY, 8)];

  async function withBridge(fn) {
    const { api } = loadCalendarBridge(bridgeUrl, { items: items() });
    browser.tmCalendar.queryCalendarItems.mockImplementation((...a) => api.queryCalendarItems(...a));
    try { return await fn(); } finally {
      browser.tmCalendar.queryCalendarItems.mockReset();
      browser.tmCalendar.queryCalendarItems.mockResolvedValue([]);
    }
  }
  const dayBlockOf = (text, title) => text.split('\n\n').find((b) => b.includes(title));
  const prettyOf = (day) => searchExports.formatDayHeader(day, 'America/Vancouver').prettyDate;

  for (const [name, call] of [
    ['calendar_read', () => calendarReadRun({ calendar_ids: ['cal1'], from_date: PREV_DAY, to_date: NEXT_DAY })],
    ['calendar_search', () => calendarSearchRun({ query: 'party', from_date: PREV_DAY, to_date: NEXT_DAY })],
  ]) {
    it(`${name}: the all-day row spans its own day and precedes the 08:00 entry`, async () => {
      resetPaginationSessions();
      const result = await withBridge(call);
      const block = dayBlockOf(result.results, 'Holiday party');
      expect(block).toBeDefined();
      expect(block).toContain(`date: ${prettyOf(DAY)}`);
      expect(block).toContain('00:00 - 00:00: Holiday party\tevent_id: ad');
      expect(block).toContain('08:00 - 09:00: Party planning\tevent_id: t');
      expect(block.indexOf('Holiday party')).toBeLessThan(block.indexOf('Party planning'));
      expect(result.results).not.toContain(prettyOf(PREV_DAY));
    });
  }
});

describe('single-digit calendar dates survive the digits contract end to end', () => {
  // The first day of next month is always a "01" day, one to four weeks out.
  const firstOfNextMonth = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; })();
  const dayAfter = (() => { const [y, m] = firstOfNextMonth.split('-').map(Number); return `${y}-${String(m).padStart(2, '0')}-02`; })();

  it('is listed under its own day and found again by the start_iso it printed', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [allDayEvent('first', 'Kickoff', firstOfNextMonth, dayAfter)] });
    browser.tmCalendar.queryCalendarItems.mockImplementation((...a) => api.queryCalendarItems(...a));
    try {
      resetPaginationSessions();
      const listed = await calendarReadRun({ calendar_ids: ['cal1'], from_date: firstOfNextMonth, to_date: dayAfter });
      expect(listed.results).toContain(`date: ${searchExports.formatDayHeader(firstOfNextMonth, 'America/Vancouver').prettyDate}`);
      expect(listed.results).toContain('Kickoff');
      const found = await calendarEventReadRun({ start_iso: `${firstOfNextMonth}T00:00:00` });
      expect(found.ok).toBe(true);
      expect(found.results).toContain(`start_iso: ${firstOfNextMonth}T00:00:00`);
      expect(found.results).toContain(`end_iso: ${dayAfter}T00:00:00`);
    } finally {
      browser.tmCalendar.queryCalendarItems.mockReset();
      browser.tmCalendar.queryCalendarItems.mockResolvedValue([]);
    }
  });
});
