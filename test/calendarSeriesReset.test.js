/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesReset.test.js: a time change of a repeating series works as
// Google Calendar's "All events": a new start resets the series, so every
// occurrence changed on its own goes back to the series' times and fields and
// every deleted occurrence comes back (the dates the same edit excludes stay
// excluded); an end alone is a new length, which every occurrence changed on
// its own takes from its own start, keeping its start and fields, and deleted
// occurrences stay deleted. A split does the same to its following part only.
// The card says when the edit resets anything. Through the real edit tool,
// card and bridge on Thunderbird's own dates.

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
const { onCalendar, seriesOf, edit, iso, occurrencesOf } = flow;
const { at, dateOn, digits } = await import('./helpers/nativeCalendarDates.js');
const { fakeEvent, fakeRecurrenceInfo, recurrenceItem, recurrenceDate } = await import('./helpers/calendarBridgeHarness.js');

const LA = 'America/Los_Angeles';
const H = 3600;
const la = (day, hour, minute = 0) => at(LA, day, hour, minute);
const NOTE = '**Note:** Occurrences you changed individually will be reset, and deleted ones will come back.';

const exceptionsOf = (item) => (item.recurrenceInfo?.getExceptionIds() || []).map((rid) => item.recurrenceInfo.getExceptionFor(rid));
const exdatesOf = (item) => (item.recurrenceInfo?.getRecurrenceItems() || []).filter((r) => r.date && r.isNegative).map((r) => digits(r.date));
const ruleOf = (item) => item.recurrenceInfo.getRecurrenceItems().find((r) => r.icalProperty?.propertyName === 'RRULE').icalProperty.value;
const starts = (item, from, to) => occurrencesOf(item, from, to).map((o) => o.start);

// A morning series with a changed first occurrence (its title only), an
// occurrence moved on its own with its own title and place, and a deleted one.
function busySeries() {
  return seriesOf({
    tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10',
    changed: [
      { rid: la('2099-01-10', 10), start: la('2099-01-10', 10), end: la('2099-01-10', 11), title: 'Kickoff' },
      { rid: la('2099-01-12', 10), start: la('2099-01-12', 14), end: la('2099-01-12', 14, 30), title: 'Moved', location: 'Room 9' },
    ],
    exdates: [la('2099-01-14', 10)],
  });
}

describe('a series time change resets like Google Calendar', () => {
  it('a new series start resets every changed occurrence and brings back every deleted one, the named one included', async () => {
    const loaded = onCalendar([busySeries()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), start_iso: iso('2099-01-10', 9) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(exceptionsOf(stored)).toEqual([]);
    expect(exdatesOf(stored)).toEqual([]);
    const occ = occurrencesOf(stored, '2099-01-01', '2099-02-01');
    expect(occ.map((o) => o.start)).toEqual(Array.from({ length: 10 }, (_, i) => iso(`2099-01-${String(10 + i).padStart(2, '0')}`, 9)));
    for (const o of occ) expect([o.occ.title, o.end.slice(11)]).toEqual(['Night shift', '10:00:00']);
  });

  it('the dates the same edit excludes stay excluded', async () => {
    const loaded = onCalendar([busySeries()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), start_iso: iso('2099-01-10', 9), exdates_add: [iso('2099-01-15', 10)] });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(starts(stored, '2099-01-01', '2099-02-01')).not.toContain(iso('2099-01-15', 9));
    expect(starts(stored, '2099-01-01', '2099-02-01')).toContain(iso('2099-01-16', 9));
  });

  it('a move to another day resets as well and moves the rule\'s days', async () => {
    const series = seriesOf({
      tzid: LA, day: '2099-01-12', hour: 10, rule: 'FREQ=WEEKLY;BYDAY=MO;COUNT=6',
      changed: [{ rid: la('2099-01-19', 10), start: la('2099-01-19', 15), end: la('2099-01-19', 16), title: 'Moved' }],
      exdates: [la('2099-01-26', 10)],
    });
    const loaded = onCalendar([series], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-12', 10), start_iso: iso('2099-01-13', 10) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(ruleOf(stored)).toContain('BYDAY=TU');
    expect(exceptionsOf(stored)).toEqual([]);
    expect(exdatesOf(stored)).toEqual([]);
    expect(starts(stored, '2099-01-01', '2099-03-01')).toEqual(['2099-01-13', '2099-01-20', '2099-01-27', '2099-02-03', '2099-02-10', '2099-02-17'].map((d) => iso(d, 10)));
  });

  it('an end alone keeps every changed occurrence\'s start and fields, gives it the new length, and keeps deleted ones deleted', async () => {
    const loaded = onCalendar([busySeries()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), end_iso: iso('2099-01-10', 12) });
    expect(run.failReason).toBeUndefined();
    expect(run.changes).not.toContain(NOTE);
    const [stored] = loaded.calendar.items;
    const moved = stored.recurrenceInfo.getExceptionFor(la('2099-01-12', 10));
    expect([digits(moved.startDate), digits(moved.endDate), moved.title, moved.getProperty('LOCATION')])
      .toEqual(['2099-01-12T14:00:00', '2099-01-12T16:00:00', 'Moved', 'Room 9']);
    const first = stored.recurrenceInfo.getExceptionFor(la('2099-01-10', 10));
    expect([digits(first.startDate), digits(first.endDate), first.title]).toEqual(['2099-01-10T10:00:00', '2099-01-10T12:00:00', 'Kickoff']);
    expect(exdatesOf(stored)).toEqual(['2099-01-14T10:00:00']);
  });

  it('an occurrence made all-day or timed on its own keeps its times on an end alone', async () => {
    const series = seriesOf({ tzid: LA, day: '2099-01-10', hour: 10, changed: [{ rid: la('2099-01-12', 10), start: dateOn('2099-01-12'), end: dateOn('2099-01-13') }] });
    const loaded = onCalendar([series], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), end_iso: iso('2099-01-10', 12) });
    expect(run.failReason).toBeUndefined();
    const ex = loaded.calendar.items[0].recurrenceInfo.getExceptionFor(la('2099-01-12', 10));
    expect([ex.startDate.isDate, digits(ex.startDate), digits(ex.endDate)]).toEqual([true, '2099-01-12T00:00:00', '2099-01-13T00:00:00']);
  });

  it('stopping the repeat resets nothing', async () => {
    const loaded = onCalendar([busySeries()], LA);
    const check = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', recurrence: {}, start_iso: iso('2099-01-10', 9), check_only: true });
    expect(check.ok).toBe(true);
    expect(check.resetsChangedOccurrences === true).toBe(false);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence: {}, start_iso: iso('2099-01-10', 9) });
    expect(run.changes || '').not.toContain(NOTE);
  });

  function splitSeries() {
    return seriesOf({
      tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10',
      changed: [
        { rid: la('2099-01-11', 10), start: la('2099-01-11', 14), end: la('2099-01-11', 14, 30), title: 'Early' },
        { rid: la('2099-01-16', 10), start: la('2099-01-16', 15), end: la('2099-01-16', 15, 30), title: 'Late' },
      ],
      exdates: [la('2099-01-12', 10), la('2099-01-17', 10)],
    });
  }

  it('a split keeps the earlier part\'s changed occurrences; the following part\'s take the new length', async () => {
    const loaded = onCalendar([splitSeries()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-01-14', 10), end_iso: iso('2099-01-14', 12) });
    expect(run.failReason).toBeUndefined();
    const earlier = loaded.calendar.items.find((it) => it.id === 'ser');
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    const early = earlier.recurrenceInfo.getExceptionFor(la('2099-01-11', 10));
    expect([digits(early.startDate), digits(early.endDate)]).toEqual(['2099-01-11T14:00:00', '2099-01-11T14:30:00']);
    const late = part.recurrenceInfo.getExceptionFor(la('2099-01-16', 10));
    expect([digits(late.startDate), digits(late.endDate), late.title]).toEqual(['2099-01-16T15:00:00', '2099-01-16T17:00:00', 'Late']);
    expect(exdatesOf(part)).toEqual(['2099-01-17T10:00:00']);
  });

  it('a split with a new start resets the following part only', async () => {
    const loaded = onCalendar([splitSeries()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-01-14', 10), start_iso: iso('2099-01-14', 9) });
    expect(run.failReason).toBeUndefined();
    expect(run.changes).toContain(NOTE);
    const earlier = loaded.calendar.items.find((it) => it.id === 'ser');
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    expect(exceptionsOf(earlier).map((ex) => ex.title)).toEqual(['Early']);
    expect(exdatesOf(earlier)).toEqual(['2099-01-12T10:00:00']);
    expect(exceptionsOf(part)).toEqual([]);
    expect(exdatesOf(part)).toEqual([]);
    expect(starts(part, '2099-01-01', '2099-02-01')).toEqual(['14', '15', '16', '17', '18', '19'].map((d) => iso(`2099-01-${d}`, 9)));
  });

  it('the card carries the reset note only when the check reports something reset', async () => {
    onCalendar([busySeries()], LA);
    const start = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), start_iso: iso('2099-01-10', 9) }, { confirm: false });
    expect(start.changes).toContain(NOTE);
    expect(start.sess.editResetsChangedOccurrences).toBe(true);
    onCalendar([busySeries()], LA);
    const endOnly = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), end_iso: iso('2099-01-10', 12) }, { confirm: false });
    expect(endOnly.card).toBeTruthy();
    expect(endOnly.changes).not.toContain(NOTE);
    onCalendar([seriesOf({ tzid: LA, day: '2099-01-10', hour: 10 })], LA);
    const plain = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), start_iso: iso('2099-01-10', 9) }, { confirm: false });
    expect(plain.card).toBeTruthy();
    expect(plain.changes).not.toContain(NOTE);
  });

  it('a series with changed occurrences and excluded dates switches between all-day and timed (#326)', async () => {
    const timed = onCalendar([busySeries()], LA);
    const toAllDay = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), start_iso: '2099-01-10', end_iso: '2099-01-11', all_day: true });
    expect(toAllDay.failReason).toBeUndefined();
    const [a] = timed.calendar.items;
    expect([a.startDate.isDate, digits(a.startDate), digits(a.endDate)]).toEqual([true, '2099-01-10T00:00:00', '2099-01-11T00:00:00']);
    expect(exceptionsOf(a)).toEqual([]);
    expect(exdatesOf(a)).toEqual([]);

    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn('2099-01-10'), endDate: dateOn('2099-01-11') });
    const ex = fakeEvent({ id: 'ser', title: 'Offsite', startDate: dateOn('2099-01-12'), endDate: dateOn('2099-01-14'), recurrenceId: dateOn('2099-01-12') });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=5'), recurrenceDate('EXDATE', dateOn('2099-01-13'))], { exceptions: [ex] });
    ev.recurrenceInfo.item = ev;
    const allDay = onCalendar([ev], LA);
    const toTimed = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: '2099-01-10', start_iso: iso('2099-01-10', 9), end_iso: iso('2099-01-10', 10), all_day: false });
    expect(toTimed.failReason).toBeUndefined();
    const [b] = allDay.calendar.items;
    expect([b.startDate.isDate, digits(b.startDate), digits(b.endDate)]).toEqual([false, '2099-01-10T09:00:00', '2099-01-10T10:00:00']);
    expect(exceptionsOf(b)).toEqual([]);
    expect(exdatesOf(b)).toEqual([]);
  });

  it('a zero-length series keeps its zero length on a start move (series, #352)', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-01-10', hour: 10, hours: 0 })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), start_iso: iso('2099-01-10', 11) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect([digits(stored.startDate), digits(stored.endDate)]).toEqual(['2099-01-10T11:00:00', '2099-01-10T11:00:00']);
  });

  // Zero days is no all-day length: the move keeps it, so the edit is the
  // all-day end refusal, asking the user, and is never stretched over the
  // days between the new start and the old one.
  it('a zero-length all-day series given an earlier start is refused before the card, never stretched (series, #317)', async () => {
    const ev = fakeEvent({ id: 'ser', title: 'Deadline', startDate: dateOn('2099-01-12'), endDate: dateOn('2099-01-12') });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')]);
    ev.recurrenceInfo.item = ev;
    const loaded = onCalendar([ev], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: '2099-01-12', start_iso: '2099-01-10', all_day: true });
    expect(run.failReason).toMatch(/^this is an all-day event, so its end_iso is the day after its last day and must be later than start_iso/);
    expect(run.card).toBeNull();
    expect(loaded.modifications).toHaveLength(0);
    const [stored] = loaded.calendar.items;
    expect([digits(stored.startDate), digits(stored.endDate)]).toEqual(['2099-01-12T00:00:00', '2099-01-12T00:00:00']);
  });

  // One day, stored as a DATE in the user's zone, on the spring change: the
  // day is 23 hours by instant.
  it('a one-day all-day series whose first day is the spring change keeps one day on a split and on a start move (#330)', async () => {
    const oneDay = () => {
      const ev = fakeEvent({ id: 'ser', title: 'Holiday', startDate: dateOn('2099-03-08', LA), endDate: dateOn('2099-03-09', LA) });
      ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')]);
      ev.recurrenceInfo.item = ev;
      return ev;
    };
    let loaded = onCalendar([oneDay()], LA);
    let run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: '2099-03-15', title: 'Holiday (moved)' });
    expect(run.failReason).toBeUndefined();
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    expect([digits(part.startDate), digits(part.endDate)]).toEqual(['2099-03-15T00:00:00', '2099-03-16T00:00:00']);

    loaded = onCalendar([oneDay()], LA);
    run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: '2099-03-08', start_iso: '2099-03-09', all_day: true });
    expect(run.failReason).toBeUndefined();
    const [moved] = loaded.calendar.items;
    expect([digits(moved.startDate), digits(moved.endDate)]).toEqual(['2099-03-09T00:00:00', '2099-03-10T00:00:00']);
    for (const o of occurrencesOf(moved, '2099-03-01', '2099-04-10')) expect(flow.clockDiff(o.end, o.start), o.start).toBe(86400);
  });

  it('a split of a multi-day all-day series across a change keeps its days (#368)', async () => {
    // Three days, stored as DATEs in the user's zone (as older versions wrote
    // them): across the spring change they are three days less an hour apart.
    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn('2099-03-07', LA), endDate: dateOn('2099-03-10', LA) });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')]);
    ev.recurrenceInfo.item = ev;
    const loaded = onCalendar([ev], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: '2099-03-14', title: 'Retreat (new venue)' });
    expect(run.failReason).toBeUndefined();
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    expect([digits(part.startDate), digits(part.endDate)]).toEqual(['2099-03-14T00:00:00', '2099-03-17T00:00:00']);
    for (const o of occurrencesOf(part, '2099-03-01', '2099-04-10')) expect(flow.clockDiff(o.end, o.start), o.start).toBe(3 * 86400);
  });
});
