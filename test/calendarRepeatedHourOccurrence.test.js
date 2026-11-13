/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarRepeatedHourOccurrence.test.js: the night the clocks go back
// (America/Los_Angeles, 1 November 2099: 01:00-02:00 happens twice), an
// occurrence is named by its start as the read tools print it, whichever pass
// of the repeated hour it starts in. Through the real tools and bridge on
// Thunderbird's own dates.
//   I1 an occurrence starting in the first pass (a series stored in UTC at
//      08:30Z, which is 01:30 before the clocks go back) is named by the
//      01:30 the tools print: it can be deleted on its own, excluded with
//      exdates_add and edited on its own, and only it changes; a split or a
//      following delete there cuts at its slot, and a whole-series time
//      change named at it (the first occurrence) moves every occurrence;
//   I2 an occurrence starting in the second pass (a series stored in the
//      user's zone at 01:30) is still named by its printed 01:30;
//   I3 a bare time that two occurrences share (one in each pass) names
//      neither: the assistant is told, word for word, both printed values and
//      to ask the user which one, before the card, and nothing is written;
//   I4 calendar_event_read finds an occurrence by the start_iso it prints,
//      in either pass: a printed value with its offset finds exactly that
//      occurrence, a bare time both.
// Inside the repeated hour a time is printed with its UTC offset,
// "2099-11-01T01:30:00 (UTC-7)" before the clocks go back and "(UTC-8)"
// after; every other time without one:
//   I5 every value the read prints, given back, names exactly that
//      occurrence, for a delete of it alone or of it and the following ones,
//      an excluded date, an edit of it alone, a split there, and a time
//      change of the whole series named at its first occurrence;
//   I6 a printed value that only restates the occurrence's time is no change;
//   I7 a printed value as a new time is that moment, through the event's own
//      zone, which refuses the first pass it cannot store;
//   I8 the confirmation card shows such a time with its offset.

process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi } from 'vitest';

globalThis.browser = {
  tmCalendar: {},
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined) },
};
globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));
globalThis.window = globalThis.window || {};

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/helpers.js', async () => {
  const actual = await vi.importActual('../chat/modules/helpers.js');
  return { ...actual, streamText: vi.fn() };
});
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chatlink/modules/fsm.js', () => ({ relayFsmConfirmation: vi.fn(async () => {}) }));
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

const { onCalendar, seriesOf, edit, remove, occurrencesOf, readOccurrence, readSeries, timeChange } = await import('./helpers/seriesEditFlow.js');
const { digits, at, dateOn } = await import('./helpers/nativeCalendarDates.js');
const { fakeEvent, fakeRecurrenceInfo, recurrenceItem } = await import('./helpers/calendarBridgeHarness.js');
const { toNaiveIso } = await import('../chat/modules/helpers.js');
const { instantsNamedBy } = await import('../chat/tools/calendar_event_read.js');

const LA = 'America/Los_Angeles';
const NIGHT = '2099-11-01';
const PRINTED = `${NIGHT}T01:30:00`;
const FIRST_PASS = `${PRINTED} (UTC-7)`;
const SECOND_PASS = `${PRINTED} (UTC-8)`;
const FROM = '2099-10-29';
const TO = '2099-11-04';

// The start the read tools print for each occurrence, by its slot.
const printed = (item) => occurrencesOf(item, FROM, TO).map(({ occ }) => [digits(occ.recurrenceId), toNaiveIso(occ.startDate.nativeTime / 1000)]);
const stored = (loaded) => loaded.calendar.items.find((it) => it.id === 'ser');
const slotsOf = (item) => occurrencesOf(item, FROM, TO).map(({ occ }) => digits(occ.recurrenceId));

// 07:30Z hourly: 00:30 PDT, 01:30 PDT (the first pass), 01:30 PST (the
// second pass), 02:30 PST. Each occurrence's slot (UTC) and the start the read
// tools print for it, written by hand.
const hourlySeries = () => seriesOf({ tzid: 'UTC', day: NIGHT, hour: 7, minute: 30, rule: 'FREQ=HOURLY;COUNT=4' });
const HOURLY = [
  [`${NIGHT}T07:30:00`, `${NIGHT}T00:30:00`],
  [`${NIGHT}T08:30:00`, FIRST_PASS],
  [`${NIGHT}T09:30:00`, SECOND_PASS],
  [`${NIGHT}T10:30:00`, `${NIGHT}T02:30:00`],
];
const HOURLY_SLOTS = HOURLY.map(([slot]) => slot);
// 08:30Z hourly: its first occurrence is in the first pass.
const firstPassHourly = () => seriesOf({ tzid: 'UTC', day: NIGHT, hour: 8, minute: 30, rule: 'FREQ=HOURLY;COUNT=3' });

// Every recurrence_id calendar_event_read prints for the night, read by each
// bare time an occurrence starts at.
async function recurrenceIdsRead() {
  const out = [];
  for (const bare of [`${NIGHT}T00:30:00`, PRINTED, `${NIGHT}T02:30:00`]) {
    const { text } = await readOccurrence(bare);
    out.push(...[...String(text).matchAll(/^recurrence_id: (.*)$/gm)].map((m) => m[1]));
  }
  return out;
}

// The answer to a bare time two occurrences share, as the assistant gets it.
const ASK_WHICH = (field) => `${field} ${PRINTED} names two occurrences of this series: the clocks go back that night, so 01:30 happens twice. `
  + `One starts at ${FIRST_PASS}, before the clocks go back, and one at ${SECOND_PASS}, after. Nothing was changed. `
  + `Ask the user which one they mean, then pass that value, offset included, ${field === 'exdates_add' ? 'in exdates_add' : `as ${field}`}.`;
// The text the card states wraps a failed read of the event in.
const READ_FAILURE_WRAPPER = ['Failed to read event details', 'may not refer to a calendar event'];

describe('an occurrence in the first pass of the repeated hour is named by its printed start (I1)', () => {
  // 08:30Z every day: 01:30 on the user's clock, in the first pass on NIGHT.
  const firstPassSeries = () => seriesOf({ tzid: 'UTC', day: '2099-10-30', hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=4' });
  const FIRST_PASS_SLOT = `${NIGHT}T08:30:00`;

  it('the read tools print it at 01:30, the start it is named by', () => {
    const loaded = onCalendar([firstPassSeries()], LA);
    expect(printed(stored(loaded))).toContainEqual([FIRST_PASS_SLOT, PRINTED]);
  });

  it('deleting just that occurrence removes it and nothing else', async () => {
    const loaded = onCalendar([firstPassSeries()], LA);
    const before = printed(stored(loaded));
    const run = await remove({ event_id: 'ser', delete_scope: 'this_only', recurrence_id: PRINTED });
    expect(run.failReason).toBeUndefined();
    expect(run.card).not.toBeNull();
    expect(printed(stored(loaded))).toEqual(before.filter(([slot]) => slot !== FIRST_PASS_SLOT));
  });

  it('exdates_add with its printed start excludes it and nothing else', async () => {
    const loaded = onCalendar([firstPassSeries()], LA);
    const before = printed(stored(loaded));
    const run = await edit({ event_id: 'ser', edit_scope: 'all', title: 'Retro', exdates_add: [PRINTED] });
    expect(run.failReason).toBeUndefined();
    expect(printed(stored(loaded))).toEqual(before.filter(([slot]) => slot !== FIRST_PASS_SLOT));
  });

  it('a title edit of just that occurrence changes it and nothing else', async () => {
    const loaded = onCalendar([firstPassSeries()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: PRINTED, title: 'Retro' });
    expect(run.failReason).toBeUndefined();
    const titles = occurrencesOf(stored(loaded), FROM, TO).map(({ occ }) => [digits(occ.recurrenceId), occ.title]);
    expect(titles).toEqual(titles.map(([slot]) => [slot, slot === FIRST_PASS_SLOT ? 'Retro' : 'Night shift']));
  });
});

describe('a first-pass occurrence names the cut of a split, a following delete and a whole-series change (I1)', () => {
  const firstPassSeries = () => seriesOf({ tzid: 'UTC', day: '2099-10-30', hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=4' });
  const FIRST_PASS_SLOT = `${NIGHT}T08:30:00`;

  it('this_and_following with a new title: the parts together are the series, the first-pass slot and later in the new part', async () => {
    const loaded = onCalendar([firstPassSeries()], LA);
    const before = printed(stored(loaded));
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: PRINTED, title: 'Retro' });
    expect(run.failReason).toBeUndefined();
    const parts = loaded.calendar.items.map((item) => ({ title: item.title, shown: printed(item).map(([, shown]) => shown) }));
    expect(parts).toHaveLength(2);
    const byTitle = Object.fromEntries(parts.map((p) => [p.title, p.shown]));
    const at = before.findIndex(([slot]) => slot === FIRST_PASS_SLOT);
    expect(at).toBeGreaterThan(0);
    expect(byTitle['Night shift']).toEqual(before.slice(0, at).map(([, shown]) => shown));
    expect(byTitle.Retro).toEqual(before.slice(at).map(([, shown]) => shown));
  });

  it('a this_and_following delete removes exactly the first-pass slot and every later one', async () => {
    const loaded = onCalendar([firstPassSeries()], LA);
    const before = printed(stored(loaded));
    const run = await remove({ event_id: 'ser', delete_scope: 'this_and_following', recurrence_id: PRINTED });
    expect(run.failReason).toBeUndefined();
    const at = before.findIndex(([slot]) => slot === FIRST_PASS_SLOT);
    expect(at).toBeGreaterThan(0);
    expect(printed(stored(loaded))).toEqual(before.slice(0, at));
  });

  it('a whole-series time change named at a first occurrence in the first pass moves every occurrence', async () => {
    const loaded = onCalendar([seriesOf({ tzid: 'UTC', day: NIGHT, hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=3' })], LA);
    expect(printed(stored(loaded))[0]).toEqual([FIRST_PASS_SLOT, PRINTED]);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: PRINTED, start_iso: `${NIGHT}T03:00:00`, end_iso: `${NIGHT}T04:00:00` });
    expect(run.failReason).toBeUndefined();
    expect(printed(stored(loaded)).map(([, shown]) => shown)).toEqual(['2099-11-01T03:00:00', '2099-11-02T03:00:00', '2099-11-03T03:00:00']);
  });
});

describe('an occurrence in the second pass is still named by its printed start (I2)', () => {
  it('a series at 01:30 in the user\'s zone: deleting the occurrence that night removes only it', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-10-30', hour: 1, minute: 30, rule: 'FREQ=DAILY;COUNT=4' })], LA);
    const before = printed(stored(loaded));
    const slot = before.find(([, shown]) => shown === PRINTED)?.[0];
    expect(slot).toBeTruthy();
    const run = await remove({ event_id: 'ser', delete_scope: 'this_only', recurrence_id: PRINTED });
    expect(run.failReason).toBeUndefined();
    expect(printed(stored(loaded))).toEqual(before.filter(([s]) => s !== slot));
  });
});

describe('a bare time two occurrences share is a question for the user (I3)', () => {
  // Each call names 01:30 with no offset; one occurrence starts there in each
  // pass. `series` is the stored series, `args` the call.
  const cases = [
    ['an edit of one occurrence', hourlySeries, edit, { edit_scope: 'this_only', recurrence_id: PRINTED, title: 'Retro' }, 'recurrence_id'],
    ['a split', hourlySeries, edit, { edit_scope: 'this_and_following', recurrence_id: PRINTED, title: 'Retro' }, 'recurrence_id'],
    ['a time change of the whole series named at its first occurrence', firstPassHourly, edit,
      { edit_scope: 'all', recurrence_id: PRINTED, start_iso: `${NIGHT}T03:00:00`, end_iso: `${NIGHT}T04:00:00` }, 'recurrence_id'],
    ['an excluded date', hourlySeries, edit, { edit_scope: 'all', title: 'Retro', exdates_add: [PRINTED] }, 'exdates_add'],
    ['a delete of one occurrence', hourlySeries, remove, { delete_scope: 'this_only', recurrence_id: PRINTED }, 'recurrence_id'],
    ['a delete of it and the following ones', hourlySeries, remove, { delete_scope: 'this_and_following', recurrence_id: PRINTED }, 'recurrence_id'],
  ];
  for (const [name, series, tool, args, field] of cases) {
    it(`${name}: the assistant is told both printed values and to ask, word for word; no card, nothing written`, async () => {
      const loaded = onCalendar([series()], LA);
      const before = printed(stored(loaded));
      expect(before.filter(([, shown]) => shown === PRINTED)).toHaveLength(2);
      const run = await tool({ event_id: 'ser', ...args });
      expect(run.card).toBeNull();
      expect(run.failReason).toBe(ASK_WHICH(field));
      expect(run.result.error).toBe(ASK_WHICH(field));
      for (const wrapper of READ_FAILURE_WRAPPER) expect(run.result.error).not.toContain(wrapper);
      expect(loaded.modifications).toEqual([]);
      expect(printed(stored(loaded))).toEqual(before);
      expect(stored(loaded).recurrenceInfo.getExceptionIds?.() || []).toHaveLength(0);
    });
  }

  it('the two values are named in the order they happen, whatever order the series keeps them in', async () => {
    // 09:30Z hourly: 01:30 in the second pass, then the 10:30Z slot, moved on
    // its own to 08:30Z, 01:30 in the first pass.
    const series = seriesOf({ tzid: 'UTC', day: NIGHT, hour: 9, minute: 30, rule: 'FREQ=HOURLY;COUNT=2',
      changed: [{ rid: at('UTC', NIGHT, 10, 30), start: at('UTC', NIGHT, 8, 30), end: at('UTC', NIGHT, 9, 30) }] });
    const loaded = onCalendar([series], LA);
    const run = await remove({ event_id: 'ser', delete_scope: 'this_only', recurrence_id: PRINTED });
    expect(run.card).toBeNull();
    expect(run.failReason).toBe(ASK_WHICH('recurrence_id'));
    expect(loaded.modifications).toEqual([]);
  });
});

describe('calendar_event_read finds an occurrence by its printed start in either pass (I4)', () => {
  it('the second pass: a series at 01:30 in the user\'s zone, printed with the offset after the change', async () => {
    onCalendar([seriesOf({ tzid: LA, day: '2099-10-30', hour: 1, minute: 30, rule: 'FREQ=DAILY;COUNT=4' })], LA);
    const read = await readOccurrence(PRINTED);
    expect(read.start_iso).toBe(SECOND_PASS);
    expect(read.text).toContain('Night shift');
  });

  it('the first pass: a series stored in UTC at 08:30Z, printed with the offset before the change', async () => {
    onCalendar([seriesOf({ tzid: 'UTC', day: '2099-10-30', hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=4' })], LA);
    expect((await readOccurrence(PRINTED)).start_iso).toBe(FIRST_PASS);
  });

  it('both passes of an hourly series are found by the bare time, each printed with its own offset', async () => {
    onCalendar([hourlySeries()], LA);
    const read = await readOccurrence(PRINTED);
    const starts = [...read.text.matchAll(/^start_iso: (.*)$/gm)].map((m) => m[1]);
    expect(starts.sort()).toEqual([FIRST_PASS, SECOND_PASS]);
  });

  it('a printed value with its offset finds exactly that occurrence', async () => {
    onCalendar([hourlySeries()], LA);
    for (const value of [FIRST_PASS, SECOND_PASS]) {
      const read = await readOccurrence(value);
      expect(read.text.split('\n-----\n'), value).toHaveLength(1);
      expect(read.start_iso).toBe(value);
      expect(read.text).toContain(`recurrence_id: ${value}`);
    }
  });

  it('instantsNamedBy: both passes inside the repeated hour, one instant elsewhere and for a time with a zone', () => {
    const passes = (iso) => instantsNamedBy(iso, new Date(iso)).sort((a, b) => a - b).map((ms) => new Date(ms).toISOString());
    expect(passes(PRINTED)).toEqual([`${NIGHT}T08:30:00.000Z`, `${NIGHT}T09:30:00.000Z`]);
    expect(passes(`${NIGHT}T02:30:00`)).toEqual([`${NIGHT}T10:30:00.000Z`]);
    expect(passes(`${NIGHT}T00:30:00`)).toEqual([`${NIGHT}T07:30:00.000Z`]);
    expect(passes(`${NIGHT}T01:30:00Z`)).toEqual([`${NIGHT}T01:30:00.000Z`]);
    // The skipped hour of the spring change prints as no instant: JavaScript's reading only.
    expect(passes('2099-03-08T02:30:00')).toEqual([new Date('2099-03-08T02:30:00').toISOString()]);
  });
});

describe('every value the read prints, given back, names exactly that occurrence (I5)', () => {
  it('the read prints each occurrence of the night by a value of its own', async () => {
    onCalendar([hourlySeries()], LA);
    expect((await recurrenceIdsRead()).sort()).toEqual(HOURLY.map(([, shown]) => shown).sort());
  });

  for (const [slot, shown] of HOURLY) {
    it(`a delete of ${shown} alone removes the occurrence at ${slot} and nothing else`, async () => {
      const loaded = onCalendar([hourlySeries()], LA);
      const run = await remove({ event_id: 'ser', delete_scope: 'this_only', recurrence_id: shown });
      expect(run.failReason).toBeUndefined();
      expect(slotsOf(stored(loaded))).toEqual(HOURLY_SLOTS.filter((s) => s !== slot));
    });

    it(`exdates_add ${shown} excludes the occurrence at ${slot} and nothing else`, async () => {
      const loaded = onCalendar([hourlySeries()], LA);
      const run = await edit({ event_id: 'ser', edit_scope: 'all', title: 'Retro', exdates_add: [shown] });
      expect(run.failReason).toBeUndefined();
      expect(slotsOf(stored(loaded))).toEqual(HOURLY_SLOTS.filter((s) => s !== slot));
    });

    it(`an edit of ${shown} alone changes the occurrence at ${slot} and nothing else, and names it by that value`, async () => {
      const loaded = onCalendar([hourlySeries()], LA);
      const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: shown, title: 'Retro' });
      expect(run.failReason).toBeUndefined();
      const titles = occurrencesOf(stored(loaded), FROM, TO).map(({ occ }) => [digits(occ.recurrenceId), occ.title]);
      expect(titles).toEqual(HOURLY_SLOTS.map((s) => [s, s === slot ? 'Retro' : 'Night shift']));
      expect(run.result.recurrence_id).toBe(shown);
      expect(run.result.result).toContain(`only the occurrence on ${shown};`);
    });
  }

  for (const [i, [slot, shown]] of HOURLY.entries()) {
    if (i === 0) continue; // the first occurrence: a split or a following delete there is the whole series
    it(`a split at ${shown} starts the new part at the occurrence at ${slot}`, async () => {
      const loaded = onCalendar([hourlySeries()], LA);
      const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: shown, title: 'Retro' });
      expect(run.failReason).toBeUndefined();
      const byTitle = Object.fromEntries(loaded.calendar.items.map((item) => [item.title, slotsOf(item)]));
      expect(byTitle['Night shift']).toEqual(HOURLY_SLOTS.slice(0, i));
      expect(byTitle.Retro).toEqual(HOURLY_SLOTS.slice(i));
      expect(run.result.recurrence_id).toBe(shown);
    });

    it(`a delete of ${shown} and the following ones removes the occurrence at ${slot} and every later one`, async () => {
      const loaded = onCalendar([hourlySeries()], LA);
      const run = await remove({ event_id: 'ser', delete_scope: 'this_and_following', recurrence_id: shown });
      expect(run.failReason).toBeUndefined();
      expect(slotsOf(stored(loaded))).toEqual(HOURLY_SLOTS.slice(0, i));
    });
  }

  it('a time change of the whole series named at its first occurrence by its printed value moves every occurrence', async () => {
    const loaded = onCalendar([firstPassHourly()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: FIRST_PASS, start_iso: `${NIGHT}T03:00:00`, end_iso: `${NIGHT}T04:00:00` });
    expect(run.failReason).toBeUndefined();
    expect(printed(stored(loaded)).map(([, shown]) => shown)).toEqual([`${NIGHT}T03:00:00`, `${NIGHT}T04:00:00`, `${NIGHT}T05:00:00`]);
  });

  it('a value with a note in parentheses that is not the printed form names nothing, and nothing is written', async () => {
    // A daily series: 01:30 names one occurrence, the first pass on NIGHT.
    const loaded = onCalendar([seriesOf({ tzid: 'UTC', day: '2099-10-30', hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=4' })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', title: 'Retro', exdates_add: [`${NIGHT} 01:30:00 (UTC-7)`] });
    expect(run.card).toBeNull();
    expect(run.failReason).toBe('invalid exdates_add format (expected ISO8601)');
    expect(loaded.modifications).toEqual([]);
  });

  it('a value with its offset at a moment no occurrence starts names nothing, and nothing is written', async () => {
    // A daily series at 08:30Z: on NIGHT only the first pass has an occurrence.
    const loaded = onCalendar([seriesOf({ tzid: 'UTC', day: '2099-10-30', hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=4' })], LA);
    const run = await remove({ event_id: 'ser', delete_scope: 'this_only', recurrence_id: SECOND_PASS });
    expect(run.card).toBeNull();
    expect(run.failReason).toBe(`recurrence_id ${SECOND_PASS} is not the start of an occurrence of this series; pass the occurrence's start_iso as the read tools show it`);
    expect(loaded.modifications).toEqual([]);
  });

  it('a value with its offset names no day of an all-day series, and nothing is written', async () => {
    const leave = fakeEvent({ id: 'ser', title: 'Leave', startDate: dateOn('2099-10-30'), endDate: dateOn('2099-10-31') });
    leave.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=4')]);
    leave.recurrenceInfo.item = leave;
    const loaded = onCalendar([leave], LA);
    const run = await remove({ event_id: 'ser', delete_scope: 'this_only', recurrence_id: FIRST_PASS });
    expect(run.card).toBeNull();
    expect(run.failReason).toBe(`recurrence_id ${FIRST_PASS} is not the start of an occurrence of this series; pass the occurrence's start_iso as the read tools show it`);
    expect(loaded.modifications).toEqual([]);
  });
});

describe('a printed value that only restates the occurrence\'s time is no change (I6)', () => {
  it('a title edit of one occurrence that restates its printed start and end: no time line, its times kept', async () => {
    const loaded = onCalendar([hourlySeries()], LA);
    const times = () => occurrencesOf(stored(loaded), FROM, TO).map((o) => [digits(o.occ.recurrenceId), o.start, o.end]);
    const before = times();
    // The occurrence in the first pass lasts an hour: it ends at 01:30 in the second pass.
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: FIRST_PASS, title: 'Retro', start_iso: FIRST_PASS, end_iso: SECOND_PASS });
    expect(run.failReason).toBeUndefined();
    expect(run.card).toBeTruthy();
    expect(timeChange(run.changes, 'Start')).toBeNull();
    expect(timeChange(run.changes, 'End')).toBeNull();
    expect(times()).toEqual(before);
    const titles = occurrencesOf(stored(loaded), FROM, TO).map(({ occ }) => occ.title);
    expect(titles).toEqual(['Night shift', 'Retro', 'Night shift', 'Night shift']);
  });

  it('a time change of the whole series that restates its first occurrence\'s printed start: nothing changed, its excluded date kept', async () => {
    // 08:30Z every day from NIGHT, the first occurrence in the first pass; the third excluded.
    const loaded = onCalendar([seriesOf({ tzid: 'UTC', day: NIGHT, hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=4', exdates: [at('UTC', '2099-11-03', 8, 30)] })], LA);
    const before = slotsOf(stored(loaded));
    expect(before.slice(0, 2)).toEqual([`${NIGHT}T08:30:00`, '2099-11-02T08:30:00']);
    expect(before).not.toContain('2099-11-03T08:30:00');
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: FIRST_PASS, start_iso: FIRST_PASS });
    expect(run.card).toBeNull();
    expect(run.result.result).toMatch(/^Nothing changed/);
    expect(loaded.modifications).toEqual([]);
    expect(slotsOf(stored(loaded))).toEqual(before);
  });

  it('a time change of the whole series that restates its printed start and gives a new end changes only the length: its excluded date kept', async () => {
    // A restated start is no new start, so the series' excluded dates and changed occurrences stay.
    const loaded = onCalendar([seriesOf({ tzid: 'UTC', day: NIGHT, hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=4', exdates: [at('UTC', '2099-11-03', 8, 30)] })], LA);
    const before = slotsOf(stored(loaded));
    expect(before).not.toContain('2099-11-03T08:30:00');
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: FIRST_PASS, start_iso: FIRST_PASS, end_iso: `${NIGHT}T03:00:00` });
    expect(run.failReason).toBeUndefined();
    expect(run.card).toBeTruthy();
    expect(timeChange(run.changes, 'Start')).toBeNull();
    expect(slotsOf(stored(loaded))).toEqual(before);
  });
});

describe('a printed value as a new time is that moment (I7)', () => {
  // A one-hour event the evening before, in `tzid`.
  const oneOff = (tzid) => fakeEvent({ id: 'one', title: 'Call', startDate: at(tzid, '2099-10-31', 20), endDate: at(tzid, '2099-10-31', 21) });
  const one = (loaded) => loaded.calendar.items.find((it) => it.id === 'one');

  it('an event stored in UTC is moved to the moment the value names, in its own zone', async () => {
    const loaded = onCalendar([oneOff('UTC')], LA);
    const run = await edit({ event_id: 'one', start_iso: FIRST_PASS });
    expect(run.failReason).toBeUndefined();
    expect(one(loaded).startDate.timezone.tzid).toBe('UTC');
    expect(digits(one(loaded).startDate)).toBe(`${NIGHT}T08:30:00`);
    expect(digits(one(loaded).endDate)).toBe(`${NIGHT}T09:30:00`);
    expect((await readSeries('one')).start_iso).toBe(FIRST_PASS);
  });

  it('an event in the user\'s zone takes the second pass, which its zone stores', async () => {
    const loaded = onCalendar([oneOff(LA)], LA);
    const run = await edit({ event_id: 'one', start_iso: SECOND_PASS });
    expect(run.failReason).toBeUndefined();
    expect(one(loaded).startDate.timezone.tzid).toBe(LA);
    expect(digits(one(loaded).startDate)).toBe(PRINTED);
    expect((await readSeries('one')).start_iso).toBe(SECOND_PASS);
  });

  it('an event in the user\'s zone refuses the first pass, naming the value as given; nothing is written', async () => {
    const loaded = onCalendar([oneOff(LA)], LA);
    const run = await edit({ event_id: 'one', start_iso: FIRST_PASS });
    expect(run.card).toBeNull();
    expect(run.failReason).toContain(`${FIRST_PASS} falls in the first of the two passes of the hour the clocks repeat in this event's time zone (${LA}) that night, which the calendar cannot store for this event; ask the user for a time outside that hour`);
    expect(loaded.modifications).toEqual([]);
  });

  it('an all-day edit given a printed value takes its date, as it takes a bare time\'s', async () => {
    const loaded = onCalendar([fakeEvent({ id: 'one', title: 'Leave', startDate: dateOn('2099-10-30'), endDate: dateOn('2099-10-31') })], LA);
    const run = await edit({ event_id: 'one', all_day: true, start_iso: FIRST_PASS, end_iso: '2099-11-02' });
    expect(run.failReason).toBeUndefined();
    expect(one(loaded).startDate.isDate).toBe(true);
    expect(one(loaded).endDate.isDate).toBe(true);
    expect(digits(one(loaded).startDate)).toBe(`${NIGHT}T00:00:00`);
    expect(digits(one(loaded).endDate)).toBe('2099-11-02T00:00:00');
  });
});

describe('the confirmation card shows a time in the repeated hour with its offset (I8)', () => {
  it('a new time: the Start and End lines name each pass by its offset', async () => {
    onCalendar([fakeEvent({ id: 'one', title: 'Call', startDate: at('UTC', '2099-10-31', 20), endDate: at('UTC', '2099-10-31', 21) })], LA);
    const run = await edit({ event_id: 'one', start_iso: FIRST_PASS }, { confirm: false });
    expect(run.failReason).toBeUndefined();
    expect(timeChange(run.changes, 'Start')?.to).toBe('Sunday 2099/11/01 01:30:00 PT (UTC-7)');
    expect(timeChange(run.changes, 'End')?.to).toBe('Sunday 2099/11/01 01:30:00 PT (UTC-8)');
  });

  it('the occurrence an edit names: its Start and End lines', async () => {
    onCalendar([hourlySeries()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: FIRST_PASS, title: 'Retro' }, { confirm: false });
    expect(run.failReason).toBeUndefined();
    expect(run.header).toContain('Start: Sunday 2099/11/01 01:30:00 PT (UTC-7)\n');
    expect(run.header).toContain('End: Sunday 2099/11/01 01:30:00 PT (UTC-8)\n');
  });

  it('an occurrence moved off a slot in the first pass: the card names the slot with its offset', async () => {
    const moved = { rid: at('UTC', NIGHT, 8, 30), start: at('UTC', NIGHT, 11, 0), end: at('UTC', NIGHT, 12, 0) };
    onCalendar([seriesOf({ tzid: 'UTC', day: NIGHT, hour: 7, minute: 30, rule: 'FREQ=HOURLY;COUNT=4', changed: [moved] })], LA);
    const run = await remove({ event_id: 'ser', delete_scope: 'this_and_following', recurrence_id: `${NIGHT}T03:00:00` }, { confirm: false });
    expect(run.failReason).toBeUndefined();
    expect(run.card).toContain('This and every later occurrence will be deleted (from Sunday 2099/11/01 03:00:00 PT, originally Sunday 2099/11/01 01:30:00 PT (UTC-7)); earlier ones stay.');
  });
});
