/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesTimeRefusals.test.js: the time edits the calendar refuses,
// each before the confirmation card and with nothing written, through the
// real edit tool and bridge on Thunderbird's own dates: an end before the
// start (measured from the occurrence the edit names), an end alone named at
// an occurrence of the other kind, a first occurrence that would end inside
// the hour the clocks repeat (no stored end gives that length), a time given
// in another zone that falls in the first pass of that hour in the event's
// zone, and digits the given zone skips.

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
const { onCalendar, seriesOf, edit, iso } = flow;
const { at, dateOn } = await import('./helpers/nativeCalendarDates.js');
const { fakeEvent, fakeRecurrenceInfo, recurrenceItem } = await import('./helpers/calendarBridgeHarness.js');

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';
const la = (day, hour, minute = 0) => at(LA, day, hour, minute);

const FIRST_NIGHT_REPEATED_HOUR = 'the first occurrence would end inside the hour the clocks repeat that night, which the calendar cannot store as the length asked; ask the user for another end time, or to start the change from another occurrence';
const OTHER_KIND = 'the occurrence this edit names was made all-day or timed on its own, so the new length of the other occurrences cannot be measured from it; give start_iso too, or name another occurrence';
const skipped = (digitsIso, tzid) => `${digitsIso} does not exist in ${tzid}: the clocks skip that time that day; ask the user for another time`;

// Refused before the card: no card, nothing written, the assistant told why.
async function refused(loaded, args, text) {
  const run = await edit(args);
  expect(run.card).toBeNull();
  expect(run.state).toBe('exec_fail');
  expect(run.failReason).toContain(text);
  expect(run.result).toMatchObject({ ok: false });
  expect(loaded.modifications).toHaveLength(0);
  expect(loaded.calendar.items.map((it) => it.id)).toEqual(loaded.ids);
  return run;
}
function calendarOf(items, userTzid = LA) {
  const loaded = onCalendar(items, userTzid);
  loaded.ids = items.map((it) => it.id);
  return loaded;
}
// The user in another zone for one test: the process clock and Thunderbird's.
async function asUserIn(tzid, fn) {
  const was = process.env.TZ;
  process.env.TZ = tzid;
  try { return await fn(); } finally { process.env.TZ = was; }
}

describe('series time edits refused before the card', () => {
  it('an end before the start is refused with the usual text, timed and all-day (zero days)', async () => {
    const timed = calendarOf([seriesOf({ tzid: LA, day: '2099-01-10', hour: 10 })]);
    await refused(timed, { event_id: 'ser', edit_scope: 'all', end_iso: iso('2099-01-10', 9) }, 'the event would end before it starts.');
    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn('2099-01-10'), endDate: dateOn('2099-01-12') });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')]);
    ev.recurrenceInfo.item = ev;
    const allDay = calendarOf([ev]);
    await refused(allDay, { event_id: 'ser', edit_scope: 'all', recurrence_id: '2099-01-10', end_iso: '2099-01-10' }, 'this is an all-day event, so its end_iso is the day after its last day and must be later than start_iso.');
  });

  it('an end before the start of a named occurrence moved on its own gets the usual text', async () => {
    const series = seriesOf({ tzid: LA, day: '2099-01-10', changed: [{ rid: la('2099-01-10', 22), start: la('2099-01-10', 23), end: la('2099-01-10', 23, 30) }] });
    const loaded = calendarOf([series]);
    const run = await refused(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 23), end_iso: iso('2099-01-10', 22, 30) }, 'the event would end before it starts.');
    expect(run.failReason).not.toContain('changed on its own');
  });

  it('an end alone named at an occurrence made all-day on its own, and one made timed on its own, is refused', async () => {
    const timedSeries = seriesOf({ tzid: LA, day: '2099-01-10', changed: [{ rid: la('2099-01-10', 22), start: dateOn('2099-01-10'), end: dateOn('2099-01-11') }] });
    await refused(calendarOf([timedSeries]), { event_id: 'ser', edit_scope: 'all', recurrence_id: '2099-01-10', end_iso: iso('2099-01-11', 7) }, OTHER_KIND);
    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn('2099-01-10'), endDate: dateOn('2099-01-11') });
    const ex = fakeEvent({ id: 'ser', title: 'Retreat', startDate: la('2099-01-10', 9), endDate: la('2099-01-10', 10), recurrenceId: dateOn('2099-01-10') });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=5')], { exceptions: [ex] });
    ev.recurrenceInfo.item = ev;
    await refused(calendarOf([ev]), { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 9), end_iso: '2099-01-12' }, OTHER_KIND);
  });

  it('an end inside the repeated autumn hour on the first occurrence is refused (west)', async () => {
    const loaded = calendarOf([seriesOf({ tzid: LA, day: '2099-10-31' })]);
    await refused(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-31', 22), end_iso: iso('2099-11-01', 1, 30) }, FIRST_NIGHT_REPEATED_HOUR);
  });

  it('an end inside the repeated autumn hour on the first occurrence is refused (east)', async () => {
    await asUserIn(SYDNEY, async () => {
      const loaded = calendarOf([seriesOf({ tzid: SYDNEY, day: '2099-04-04' })], SYDNEY);
      await refused(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-04-04', 22), end_iso: iso('2099-04-05', 2, 30) }, FIRST_NIGHT_REPEATED_HOUR);
    });
  });

  it('a title-only split on that night of a series ending in the repeated hour is refused', async () => {
    const loaded = calendarOf([seriesOf({ tzid: LA, day: '2099-10-25', end: la('2099-10-26', 1, 30) })]);
    await refused(loaded, { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-10-31', 22), title: 'Late shift' }, FIRST_NIGHT_REPEATED_HOUR);
  });

  it('a time with timezone Australia/Sydney that is the first 01:30 in Los Angeles is refused', async () => {
    const loaded = calendarOf([seriesOf({ tzid: LA, day: '2099-10-20', hour: 17 })]);
    await refused(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-20', 17), start_iso: iso('2099-11-01', 19, 30), timezone: SYDNEY },
      `${iso('2099-11-01', 19, 30)} in ${SYDNEY} falls in the first of the two passes of the hour the clocks repeat in this event's time zone (${LA}) that night, which the calendar cannot store for this event; ask the user for a time outside that hour`);
  });

  it('a time at digits the given zone skips is refused: series, single event, one occurrence', async () => {
    const text = skipped(iso('2099-10-04', 2, 30), SYDNEY);
    const series = calendarOf([seriesOf({ tzid: LA, day: '2099-10-01', hour: 10 })]);
    await refused(series, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-01', 10), start_iso: iso('2099-10-04', 2, 30), timezone: SYDNEY }, text);
    const single = calendarOf([fakeEvent({ id: 'one', title: 'Call', startDate: la('2099-10-01', 10), endDate: la('2099-10-01', 11) })]);
    await refused(single, { event_id: 'one', start_iso: iso('2099-10-04', 2, 30), timezone: SYDNEY }, text);
    const occurrence = calendarOf([seriesOf({ tzid: LA, day: '2099-10-01', hour: 10 })]);
    await refused(occurrence, { event_id: 'ser', edit_scope: 'this_only', recurrence_id: iso('2099-10-02', 10), start_iso: iso('2099-10-04', 2, 30), timezone: SYDNEY }, text);
  });

  it('a start alone switched to all-day keeps the mixed-kinds refusal', async () => {
    const loaded = calendarOf([seriesOf({ tzid: LA, day: '2099-01-10', hour: 10 })]);
    await refused(loaded, { event_id: 'ser', edit_scope: 'all', start_iso: '2099-01-10', all_day: true }, 'the edit would leave the start all-day and the end timed');
  });

  it('an all-day series given a time of day without all_day is refused before an end-before-start', async () => {
    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn('2099-01-10'), endDate: dateOn('2099-01-12') });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')]);
    ev.recurrenceInfo.item = ev;
    await refused(calendarOf([ev]), { event_id: 'ser', edit_scope: 'all', recurrence_id: '2099-01-10', end_iso: iso('2099-01-09', 10) }, 'this is an all-day event, and the edit gives a time of day without all_day.');
  });
});
