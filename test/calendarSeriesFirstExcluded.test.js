/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesFirstExcluded.test.js (#386): a series whose first date is
// excluded starts, as the user sees it, at its first remaining occurrence. A
// time change of every occurrence named there is a whole-series edit, not a
// split: it leaves ONE series, moved by the named occurrence's change from its
// slot, and, as every new start does (ADR-031), brings every excluded date
// back, the first one included. The card shows the named occurrence moving,
// and a split there is refused (it would leave no occurrence before it). The
// read tools show the series at that occurrence, so the documented path (read
// the event, name the start_iso it shows) reaches it, and an edit with no
// recurrence_id is read against it too (#404).
// Through the real edit tool, card and bridge on Thunderbird's own dates;
// every date is relative to today.

process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi } from 'vitest';

globalThis.browser = {
  tmCalendar: {},
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined) },
};
globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/helpers.js', async () => {
  const actual = await vi.importActual('../chat/modules/helpers.js');
  return { ...actual, streamText: vi.fn() };
});
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chatlink/modules/fsm.js', () => ({ relayFsmConfirmation: vi.fn() }));
vi.mock('../chat/modules/context.js', () => ({
  ctx: {
    activePid: 0, awaitingPid: 0, activeToolCallId: null,
    fsmSessions: Object.create(null), state: null, toolExecutionMode: null, rawUserTexts: ['original request'],
  },
  initFsmSession: vi.fn(),
}));
vi.mock('../chat/modules/markdown.js', () => ({ attachSpecialLinkListeners: vi.fn(), renderMarkdown: vi.fn() }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn(async () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } })) }));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: vi.fn(async () => {}) }));

const flow = await import('./helpers/seriesEditFlow.js');
const { onCalendar, seriesOf, edit, remove, iso, occurrencesOf, dayPlus, readSeries } = flow;
const { at, dateOn, digits } = await import('./helpers/nativeCalendarDates.js');
const { fakeEvent, fakeRecurrenceInfo, recurrenceItem, recurrenceDate } = await import('./helpers/calendarBridgeHarness.js');

const LA = 'America/Los_Angeles';
const la = (day, hour, minute = 0) => at(LA, day, hour, minute);
const today = (() => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
})();
// Day 0 of each series: a month from today, so every date is in the future.
const d = (n) => dayPlus(today, 30 + n);
const exdatesOf = (item) => (item.recurrenceInfo?.getRecurrenceItems() || []).filter((r) => r.date && r.isNegative);
const all = (item) => occurrencesOf(item, d(-3), d(20));

// A daily morning series at 10:00 from day 0, five days by `rule`, whose
// first date (day 0) is excluded: the user sees it start on day 1.
const firstExcluded = (rule) => seriesOf({ tzid: LA, day: d(0), hour: 10, rule, exdates: [la(d(0), 10)] });
// UNTIL as Thunderbird's edit tool writes a last day: its end, in the zone, as UTC.
const untilDay4 = () => {
  const end = at(LA, d(4), 23, 59, 59);
  const utc = new Date(end.nativeTime / 1000);
  return utc.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
};

describe('a series whose first date is excluded starts at its first remaining occurrence (#386)', () => {
  for (const [name, rule] of [['COUNT', () => 'FREQ=DAILY;COUNT=5'], ['UNTIL', () => `FREQ=DAILY;UNTIL=${untilDay4()}`]]) {
    it(`an "all" time change named at the first visible occurrence leaves one series, every date at the new time, the excluded first one back (${name} rule)`, async () => {
      const loaded = onCalendar([firstExcluded(rule())], LA);
      expect(all(loaded.calendar.items[0]).map((o) => o.start)).toEqual([1, 2, 3, 4].map((n) => iso(d(n), 10)));
      const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso(d(1), 10), start_iso: iso(d(1), 11) });
      expect(run.failReason).toBeUndefined();
      expect(loaded.calendar.items).toHaveLength(1);
      const [stored] = loaded.calendar.items;
      expect(stored.id).toBe('ser');
      expect(exdatesOf(stored)).toEqual([]);
      const occ = all(stored);
      expect(occ.map((o) => [o.start, o.end])).toEqual([0, 1, 2, 3, 4].map((n) => [iso(d(n), 11), iso(d(n), 12)]));
    });
  }

  it('the card shows the named occurrence moving, and the whole series as the scope', async () => {
    onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso(d(1), 10), start_iso: iso(d(1), 11) }, { confirm: false });
    expect(run.failReason).toBeUndefined();
    expect(flow.timeChange(run.changes, 'Start')).toEqual({ from: await flow.asCard(iso(d(1), 10)), to: await flow.asCard(iso(d(1), 11)) });
    expect(flow.timeChange(run.changes, 'End')).toEqual({ from: await flow.asCard(iso(d(1), 11)), to: await flow.asCard(iso(d(1), 12)) });
    expect(run.changes).toContain('**Scope:** Entire recurring series');
  });

  it('a move to another day, named at the first visible occurrence of an all-day series, moves every date by that day', async () => {
    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn(d(0)), endDate: dateOn(d(1)) });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=5'), recurrenceDate('EXDATE', dateOn(d(0)))]);
    ev.recurrenceInfo.item = ev;
    const loaded = onCalendar([ev], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: d(1), start_iso: d(2), end_iso: d(3), all_day: true });
    expect(run.failReason).toBeUndefined();
    expect(loaded.calendar.items).toHaveLength(1);
    const [stored] = loaded.calendar.items;
    expect(all(stored).map((o) => [o.isDate, o.start])).toEqual([1, 2, 3, 4, 5].map((n) => [true, `${d(n)}T00:00:00`]));
  });

  it('a split at the first remaining occurrence is refused, nothing written', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso(d(1), 10), start_iso: iso(d(1), 11) });
    expect(run.failReason).toMatch(/first occurrence/);
    expect(run.card).toBeNull();
    expect(loaded.calendar.items).toHaveLength(1);
    expect(all(loaded.calendar.items[0]).map((o) => o.start)).toEqual([1, 2, 3, 4].map((n) => iso(d(n), 10)));
  });

  it('a split at a later occurrence is still made (control)', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso(d(2), 10), start_iso: iso(d(2), 11) });
    expect(run.failReason).toBeUndefined();
    expect(loaded.calendar.items).toHaveLength(2);
    const [earlier, following] = [loaded.calendar.items.find((it) => it.id === 'ser'), loaded.calendar.items.find((it) => it.id !== 'ser')];
    expect(all(earlier).map((o) => o.start)).toEqual([iso(d(1), 10)]);
    expect(all(following).map((o) => o.start)).toEqual([2, 3, 4].map((n) => iso(d(n), 11)));
  });

  it('an "all" time change named at a later occurrence still becomes a split from it (control)', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso(d(2), 10), start_iso: iso(d(2), 11) });
    expect(run.failReason).toBeUndefined();
    expect(run.changes).toContain('This occurrence and all future occurrences');
    expect(loaded.calendar.items).toHaveLength(2);
  });

  it('getCalendarEventDetails names the first remaining occurrence first, and not a later one', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const first = await loaded.api.getCalendarEventDetails('ser', 'cal1', iso(d(1), 10));
    const later = await loaded.api.getCalendarEventDetails('ser', 'cal1', iso(d(2), 10));
    expect([first.ok, first.recurrenceIdIsFirst, later.ok, later.recurrenceIdIsFirst]).toEqual([true, true, true, false]);
  });

  it('the documented path: calendar_event_read shows the first visible occurrence, and an "all" edit naming that start_iso moves every date', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const shown = await readSeries();
    expect([shown.start_iso, shown.end_iso]).toEqual([iso(d(1), 10), iso(d(1), 11)]);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: shown.start_iso, start_iso: iso(d(1), 11) });
    expect(run.failReason).toBeUndefined();
    expect(loaded.calendar.items).toHaveLength(1);
    expect(all(loaded.calendar.items[0]).map((o) => o.start)).toEqual([0, 1, 2, 3, 4].map((n) => iso(d(n), 11)));
  });

  it('an "all" time change with no recurrence_id on the first visible date moves every date, with no question (#404)', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', start_iso: iso(d(1), 11) });
    expect(run.failReason).toBeUndefined();
    expect(flow.timeChange(run.changes, 'Start')).toEqual({ from: await flow.asCard(iso(d(1), 10)), to: await flow.asCard(iso(d(1), 11)) });
    expect(loaded.calendar.items).toHaveLength(1);
    const [stored] = loaded.calendar.items;
    expect(exdatesOf(stored)).toEqual([]);
    expect(all(stored).map((o) => [o.start, o.end])).toEqual([0, 1, 2, 3, 4].map((n) => [iso(d(n), 11), iso(d(n), 12)]));
  });

  it('with no recurrence_id, a new date other than the first visible one still asks which occurrences (#404 control)', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', start_iso: iso(d(2), 11) });
    expect(run.card).toBeNull();
    expect(String(run.failReason)).toMatch(/just that date, or that date and every later one/);
    expect(loaded.modifications).toHaveLength(0);
  });

  // A first occurrence moved on its own: the read shows it at its own times,
  // and an end alone with no recurrence_id is still a new length for the WHOLE
  // series, measured from the start the read showed, which every occurrence
  // takes from its own start (ADR-031).
  it('a first occurrence moved on its own: the read shows it, and an end alone with no recurrence_id gives every occurrence the new length', async () => {
    const series = seriesOf({ tzid: LA, day: d(0), hour: 10, rule: 'FREQ=DAILY;COUNT=5', changed: [{ rid: la(d(0), 10), start: la(d(0), 11), end: la(d(0), 12) }] });
    const loaded = onCalendar([series], LA);
    const shown = await readSeries();
    expect([shown.start_iso, shown.end_iso]).toEqual([iso(d(0), 11), iso(d(0), 12)]);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', end_iso: iso(d(0), 13) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(all(stored).map((o) => [o.start, o.end])).toEqual([
      [iso(d(0), 11), iso(d(0), 13)],
      ...[1, 2, 3, 4].map((n) => [iso(d(n), 10), iso(d(n), 12)]),
    ]);
  });

  // Known limit: a first occurrence made all-day on its own in a timed series
  // cannot measure the series' new length, so an end alone with no
  // recurrence_id is refused before the card, nothing written.
  it('a first occurrence made all-day on its own: an end alone with no recurrence_id is refused, nothing written', async () => {
    const series = seriesOf({ tzid: LA, day: d(0), hour: 10, rule: 'FREQ=DAILY;COUNT=5', changed: [{ rid: la(d(0), 10), start: dateOn(d(0)), end: dateOn(d(1)) }] });
    const loaded = onCalendar([series], LA);
    const before = all(loaded.calendar.items[0]).map((o) => [o.start, o.end, o.isDate]);
    // The read shows that occurrence all-day, ending (exclusive) on day 1, so
    // an end on that day is not a question about another date.
    const run = await edit({ event_id: 'ser', edit_scope: 'all', end_iso: iso(d(1), 13) });
    expect(run.card).toBeNull();
    expect(String(run.failReason)).toMatch(/was made all-day or timed on its own, so the new length of the other occurrences cannot be measured from it/);
    expect(loaded.modifications).toHaveLength(0);
    expect(all(loaded.calendar.items[0]).map((o) => [o.start, o.end, o.isDate])).toEqual(before);
  });

  // A calendar that stores RECURRENCE-IDs in UTC (as Google Calendar does)
  // names the first visible occurrence by a value in another frame than the
  // series' start. Its slot is read in the series' frame (the same instant),
  // so the series moves by the named occurrence's change only, not by the
  // zone's offset from UTC.
  it('a first visible occurrence whose RECURRENCE-ID is stored in UTC: an "all" time change moves every date by the change only', async () => {
    const { UTC } = await import('./helpers/nativeCalendarDates.js');
    const ridUtc = la(d(1), 10).getInTimezone(UTC);
    expect(ridUtc.timezone.tzid).toBe('UTC');
    const series = seriesOf({ tzid: LA, day: d(0), hour: 10, rule: 'FREQ=DAILY;COUNT=5', exdates: [la(d(0), 10)],
      changed: [{ rid: ridUtc, start: la(d(1), 10), end: la(d(1), 11), location: 'Ward B' }] });
    const loaded = onCalendar([series], LA);
    expect(all(loaded.calendar.items[0]).map((o) => o.start)).toEqual([1, 2, 3, 4].map((n) => iso(d(n), 10)));
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso(d(1), 10), start_iso: iso(d(1), 11) });
    expect(run.failReason).toBeUndefined();
    expect(loaded.calendar.items).toHaveLength(1);
    const [stored] = loaded.calendar.items;
    expect(digits(stored.startDate)).toBe(iso(d(0), 11));
    expect(all(stored).map((o) => [o.start, o.end])).toEqual([0, 1, 2, 3, 4].map((n) => [iso(d(n), 11), iso(d(n), 12)]));
  });

  // The excluded first date before a daylight saving change, the first
  // visible one after it: the day between them is 23 or 25 hours long, but
  // the series moves by the named occurrence's change on the clock, so every
  // date keeps the new wall-clock time.
  it('the excluded first date and the first visible one on either side of a daylight saving change: every date at the new wall-clock time', async () => {
    const offsetOn = (day) => new Date(`${day}T12:00:00`).getTimezoneOffset();
    let change = null;
    for (let i = 1; i <= 400 && !change; i++) {
      if (offsetOn(dayPlus(today, i)) !== offsetOn(dayPlus(today, i - 1))) change = dayPlus(today, i);
    }
    expect(change).not.toBeNull();
    const t = (n) => dayPlus(change, n);
    const series = seriesOf({ tzid: LA, day: t(-1), hour: 10, rule: 'FREQ=DAILY;COUNT=5', exdates: [la(t(-1), 10)] });
    const loaded = onCalendar([series], LA);
    const around = (item) => occurrencesOf(item, t(-3), t(8));
    expect(around(loaded.calendar.items[0]).map((o) => o.start)).toEqual([0, 1, 2, 3].map((n) => iso(t(n), 10)));
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso(t(0), 10), start_iso: iso(t(0), 11) });
    expect(run.failReason).toBeUndefined();
    expect(loaded.calendar.items).toHaveLength(1);
    const [stored] = loaded.calendar.items;
    expect(exdatesOf(stored)).toEqual([]);
    expect(around(stored).map((o) => [o.start, o.end])).toEqual([-1, 0, 1, 2, 3].map((n) => [iso(t(n), 11), iso(t(n), 12)]));
  });

  // The delete scope (#373) asks the same question: "this and every later
  // occurrence" from the first visible one is the whole series, never an
  // earlier part with no occurrence left.
  it('a "this and following" delete from the first visible occurrence deletes the whole series', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const run = await remove({ event_id: 'ser', delete_scope: 'this_and_following', recurrence_id: iso(d(1), 10) });
    expect(run.failReason).toBeUndefined();
    expect(run.state).toBe('exec_success');
    expect(loaded.deletions.map((it) => it.id)).toEqual(['ser']);
    expect(loaded.modifications).toEqual([]);
    expect(loaded.calendar.items).toEqual([]);
  });

  // The bridge itself, called with that scope at the first visible occurrence
  // (the tool sends the whole series instead), refuses it: an earlier part
  // there would keep no occurrence.
  it('the bridge refuses a "this and following" delete at the first visible occurrence, nothing written', async () => {
    const loaded = onCalendar([firstExcluded('FREQ=DAILY;COUNT=5')], LA);
    const res = await loaded.api.deleteCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', delete_scope: 'this_and_following', recurrence_id: iso(d(1), 10) });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/first occurrence: to delete every occurrence, use delete_scope 'all'/);
    expect(loaded.deletions).toEqual([]);
    expect(loaded.modifications).toEqual([]);
    expect(all(loaded.calendar.items[0]).map((o) => o.start)).toEqual([1, 2, 3, 4].map((n) => iso(d(n), 10)));
  });
});
