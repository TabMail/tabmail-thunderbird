/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarOccurrenceRoundTrip.test.js: the start the read tools print for an
// occurrence is the recurrence_id the edit tools take to name it. A series is
// read through the bridge's query and the read tool's own formatter, and the
// printed recurrence_id goes back through the edit tool's normalizer into the
// bridge. An edit of that occurrence alone, and a split there ("this and
// following"), each land on that occurrence, and a changed occurrence's printed
// start, given as an excluded date, removes it, for a series in the user's zone,
// in a zone east of UTC, in UTC, and floating (RFC 5545 local time, shown at
// its own digits on the user's clock).

// West of UTC, so an instant read in the user's zone has other digits than in
// UTC or in a zone east of UTC.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

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
// The real toNaiveIso: the read tool prints an instant in the user's zone with it.
vi.mock('../chat/modules/helpers.js', async () => {
  const actual = await vi.importActual('../chat/modules/helpers.js');
  return { toNaiveIso: actual.toNaiveIso, toIsoNoMs: actual.toIsoNoMs, streamText: vi.fn() };
});
vi.mock('../chat/modules/context.js', () => ({ ctx: { activePid: 0, awaitingPid: 0, activeToolCallId: null } }));
vi.mock('../chat/modules/markdown.js', () => ({ attachSpecialLinkListeners: vi.fn(), renderMarkdown: vi.fn() }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn(async () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } })) }));

const {
  loadCalendarBridge, fakeCalDateTime, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem, seriesOccurrences,
  fixedZone, FLOATING_ZONE, UTC_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');
const { run: calendarEventReadRun, _testExports: readExports } = await import('../chat/tools/calendar_event_read.js');
const { _testExports: editExports } = await import('../chat/tools/calendar_event_edit.js');

// A far-future series start: 2099 is the dated-test exception (never goes stale).
const START_DAY = '2099-10-01';
const TARGET_DAY = 15;
const pad2 = (n) => String(n).padStart(2, '0');
const EAST = fixedZone('Test/East+0900', 9 * 60);
const field = (text, name) => (text.match(new RegExp(`^${name}: (.*)$`, 'm')) || [])[1];
// An instant's wall clock in the user's zone, as a naive ISO string.
const localIso = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};

// Each kind of series, with the start of its 2099-10-15 occurrence as the user
// sees it, worked out independently of the bridge.
const KINDS = {
  "in the user's zone": { start: () => fakeDateTime(START_DAY, 17), shown: localIso(new Date(2099, 9, TARGET_DAY, 17).getTime()) },
  'in a zone east of UTC': { start: () => fakeDateTime(START_DAY, 17, 0, EAST), shown: localIso(Date.UTC(2099, 9, TARGET_DAY, 17 - 9)) },
  'in UTC': { start: () => fakeDateTime(START_DAY, 17, 0, UTC_ZONE), shown: localIso(Date.UTC(2099, 9, TARGET_DAY, 17)) },
  'floating': { start: () => fakeDateTime(START_DAY, 17, 0, FLOATING_ZONE), shown: `2099-10-${TARGET_DAY}T17:00:00` },
};

function dailySeries(start, { exceptions = [] } = {}) {
  const endDate = fakeCalDateTime({ ...start, hour: start.hour + 1 });
  const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: start, endDate });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')], { exceptions });
  ev.recurrenceInfo.item = ev;
  return ev;
}

// The occurrence's RECURRENCE-ID as Thunderbird prints it (its start's digits
// in the series' zone, with Z in UTC).
const ridOf = (start) => fakeCalDateTime({ ...start, day: TARGET_DAY }).toString();

const RANGE = [fakeDateTime('2099-09-01', 0, 0, UTC_ZONE), fakeDateTime('2100-01-01', 0, 0, UTC_ZONE)];
const instantKey = (dt) => new Date(dt.nativeTime / 1000).toISOString();
const occurrenceKeys = (item) => seriesOccurrences(item, ...RANGE).map(({ start }) => instantKey(start)).sort();

// The 2099-10-15 occurrence read through the bridge's query and printed by the
// read tool's formatter. The query covers the days around it: the in-memory
// provider, like CalMemoryCalendar, compares a floating time with a query
// bound in another zone by its digits, so a window of a minute either side of
// the shown time would not find a floating occurrence.
async function readOccurrence(api, start) {
  const rows = await api.queryCalendarItems('2099-10-14T00:00:00', '2099-10-17T00:00:00', ['cal1']);
  const row = rows.find((r) => r.recurrenceId === ridOf(start));
  expect(row, `no row for ${ridOf(start)} among ${rows.map((r) => r.recurrenceId).join(', ')}`).toBeTruthy();
  return readExports.formatDetailed(row, { id: 'cal1', name: 'Personal' });
}

describe('the recurrence_id the read tools print names that occurrence for an edit', () => {
  for (const [kind, { start: makeStart, shown }] of Object.entries(KINDS)) {
    it(`a series ${kind}: the read prints the occurrence's start, as the user sees it, as its recurrence_id`, async () => {
      const start = makeStart();
      const { api } = loadCalendarBridge(bridgeUrl, { items: [dailySeries(start)] });
      const text = await readOccurrence(api, start);
      expect(field(text, 'start_iso')).toBe(shown);
      expect(field(text, 'end_iso')).toBe(plusHours(shown, 1));
      expect(field(text, 'recurrence_id')).toBe(shown);
    });

    it(`a series ${kind}: an edit of the occurrence it names changes that occurrence alone`, async () => {
      const start = makeStart();
      const { api, calendar, modifications } = loadCalendarBridge(bridgeUrl, { items: [dailySeries(start)] });
      const text = await readOccurrence(api, start);
      const args = editExports.normalizeArgs({
        event_id: field(text, 'event_id'), recurrence_id: field(text, 'recurrence_id'), edit_scope: 'this_only', title: 'Renamed',
      });
      const res = await api.modifyCalendarEvent(args);
      expect(res, res.error).toMatchObject({ ok: true });
      expect(modifications).toHaveLength(1);
      const saved = calendar.items[0];
      expect(saved.title).toBe('Sync');
      expect(saved.recurrenceInfo.getExceptionIds().map(String)).toEqual([ridOf(start)]);
      const [rid] = saved.recurrenceInfo.getExceptionIds();
      expect(saved.recurrenceInfo.getExceptionFor(rid).title).toBe('Renamed');
    });

    it(`a series ${kind}: a split at the occurrence it names starts the following part there`, async () => {
      const start = makeStart();
      const master = dailySeries(start);
      const before = occurrenceKeys(master);
      const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
      const text = await readOccurrence(api, start);
      const args = editExports.normalizeArgs({
        event_id: field(text, 'event_id'), recurrence_id: field(text, 'recurrence_id'), edit_scope: 'this_and_following', title: 'Renamed',
      });
      const res = await api.modifyCalendarEvent(args);
      expect(res, res.error).toMatchObject({ ok: true });
      const capped = calendar.items.find((it) => it.id === 'ser');
      const fresh = calendar.items.find((it) => it.id !== 'ser');
      expect(fresh.title).toBe('Renamed');
      expect(fresh.startDate.toString()).toBe(ridOf(start));
      expect(fresh.startDate.timezone).toBe(start.timezone);
      expect([...occurrenceKeys(capped), ...occurrenceKeys(fresh)].sort()).toEqual(before);
    });
  }
});

// exdates_add takes an occurrence's start as the read prints it. A changed
// occurrence starts elsewhere than its RECURRENCE-ID, by which Thunderbird
// removes it.
const MOVED_HOURS = 2;
const plusHours = (naiveIso, hours) => localIso(new Date(naiveIso).getTime() + hours * 3600000);
const movedStart = (start) => fakeCalDateTime({ ...start, day: TARGET_DAY, hour: start.hour + MOVED_HOURS });
const movedOccurrence = (start) => fakeEvent({
  id: 'ser', title: 'Moved', startDate: movedStart(start),
  endDate: fakeCalDateTime({ ...start, day: TARGET_DAY, hour: start.hour + MOVED_HOURS + 1 }),
  recurrenceId: fakeCalDateTime({ ...start, day: TARGET_DAY }),
});

describe('the start the read tools print excludes that occurrence', () => {
  for (const [kind, { start: makeStart, shown }] of Object.entries(KINDS)) {
    it(`a series ${kind}: a changed occurrence, excluded by the start the read prints, is removed`, async () => {
      const start = makeStart();
      const master = dailySeries(start, { exceptions: [movedOccurrence(start)] });
      const before = occurrenceKeys(master);
      const movedKey = instantKey(movedStart(start));
      expect(before).toContain(movedKey);
      const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
      const text = await readOccurrence(api, start);
      expect(field(text, 'start_iso')).toBe(plusHours(shown, MOVED_HOURS));
      const args = editExports.normalizeArgs({ event_id: field(text, 'event_id'), edit_scope: 'all', exdates_add: [field(text, 'start_iso')] });
      const res = await api.modifyCalendarEvent(args);
      expect(res, res.error).toMatchObject({ ok: true });
      expect(occurrenceKeys(calendar.items[0])).toEqual(before.filter((k) => k !== movedKey));
    });
  }
});

// calendar_event_read itself, found by the start it printed: an occurrence's
// detailed read carries its recurrence_id, the same value as its start_iso.
describe('calendar_event_read prints a timed occurrence\'s recurrence_id', () => {
  for (const kind of ["in the user's zone", 'in a zone east of UTC']) {
    it(`a series ${kind}`, async () => {
      const { start: makeStart, shown } = KINDS[kind];
      const { api } = loadCalendarBridge(bridgeUrl, { items: [dailySeries(makeStart())] });
      browser.tmCalendar.queryCalendarItems.mockImplementation((...a) => api.queryCalendarItems(...a));
      try {
        const read = await calendarEventReadRun({ start_iso: shown });
        expect(read.ok).toBe(true);
        expect(field(read.results, 'event_id')).toBe('ser');
        expect(field(read.results, 'start_iso')).toBe(shown);
        expect(field(read.results, 'recurrence_id')).toBe(shown);
      } finally {
        browser.tmCalendar.queryCalendarItems.mockReset();
        browser.tmCalendar.queryCalendarItems.mockResolvedValue([]);
      }
    });
  }
});

// A read by event_id (getCalendarEventDetails) prints the series' start and
// end as the user sees them, as the query does, a floating time at its digits.
describe('calendar_event_read by event_id prints the series\' start and end as the user sees them', () => {
  for (const [kind, { start: makeStart, shown }] of Object.entries(KINDS)) {
    it(`a series ${kind}`, async () => {
      const { api } = loadCalendarBridge(bridgeUrl, { items: [dailySeries(makeStart())] });
      browser.tmCalendar.getCalendarEventDetails.mockImplementation((...a) => api.getCalendarEventDetails(...a));
      try {
        const read = await calendarEventReadRun({ event_id: 'ser', calendar_id: 'cal1' });
        expect(read.ok, read.error).toBe(true);
        // The series' first occurrence, 14 days before the shown one (no
        // daylight saving change between them).
        const first = plusHours(shown, -(TARGET_DAY - 1) * 24);
        expect(first.slice(0, 10)).toBe(START_DAY);
        expect(field(read.results, 'start_iso')).toBe(first);
        expect(field(read.results, 'end_iso')).toBe(plusHours(first, 1));
      } finally {
        browser.tmCalendar.getCalendarEventDetails.mockReset();
        browser.tmCalendar.getCalendarEventDetails.mockResolvedValue({ ok: false, error: 'not found' });
      }
    });
  }
});
