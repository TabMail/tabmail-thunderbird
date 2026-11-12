/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEditNoChange.test.js: an edit that gives only what the event
// already has changes nothing. The tool asks the calendar first (the check
// before the card); when the check finds nothing to write, the assistant is
// told "Nothing changed" and no card is shown and nothing is written. A time
// is restated when it is the time the read tools print for the occurrence the
// edit names; a field when it is that occurrence's (for the whole series, the
// series'). Through the real edit tool, card and bridge on Thunderbird's own
// dates.

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
const { onCalendar, seriesOf, edit, iso, timeChange, cardChange } = flow;
const { at, digits } = await import('./helpers/nativeCalendarDates.js');
const { fakeEvent, fakeAttendee } = await import('./helpers/calendarBridgeHarness.js');
const schemaCheck = await import('./helpers/calendarSchemaCheck.js');

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';
const la = (day, hour, minute = 0) => at(LA, day, hour, minute);
const NOTHING_CHANGED = 'Nothing changed: the event already has every time and value this edit gives, so nothing was written and no confirmation was shown.';

// A morning series whose first occurrence was moved on its own to 11:00. An
// occurrence is named by its start as the read tools print it.
const movedFirst = () => seriesOf({
  tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10',
  changed: [{ rid: la('2099-01-10', 10), start: la('2099-01-10', 11), end: la('2099-01-10', 12) }],
});

function nothingChanged(loaded, run) {
  expect(run.failReason).toBeUndefined();
  expect(run.card).toBeNull();
  expect(run.result).toEqual({ ok: true, result: NOTHING_CHANGED });
  expect(loaded.modifications).toHaveLength(0);
}

describe('an edit that only restates the event changes nothing', () => {
  it('all, named at the moved first occurrence, the series\' own start: Nothing changed, no card, the occurrence keeps its time', async () => {
    const loaded = onCalendar([movedFirst()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 11), start_iso: iso('2099-01-10', 10) });
    nothingChanged(loaded, run);
    const ex = loaded.calendar.items[0].recurrenceInfo.getExceptionFor(la('2099-01-10', 10));
    expect([digits(ex.startDate), digits(ex.endDate)]).toEqual(['2099-01-10T11:00:00', '2099-01-10T12:00:00']);
  });

  it('all, named at the moved first occurrence, its own start: no change', async () => {
    const loaded = onCalendar([movedFirst()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 11), start_iso: iso('2099-01-10', 11) });
    nothingChanged(loaded, run);
    expect(digits(loaded.calendar.items[0].startDate)).toBe('2099-01-10T10:00:00');
  });

  it('every time and field restated on the series, one occurrence, a single event and from an occurrence on: no card, no write, no split', async () => {
    const series = () => seriesOf({
      tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10',
      changed: [{ rid: la('2099-01-12', 10), start: la('2099-01-12', 14), end: la('2099-01-12', 14, 30), title: 'Moved', location: 'Room 9' }],
    });
    let loaded = onCalendar([series()], LA);
    nothingChanged(loaded, await edit({ event_id: 'ser', edit_scope: 'all', start_iso: iso('2099-01-10', 10), end_iso: iso('2099-01-10', 11), title: 'Night shift', location: 'Ward A' }));

    loaded = onCalendar([series()], LA);
    nothingChanged(loaded, await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: iso('2099-01-12', 14), start_iso: iso('2099-01-12', 14), end_iso: iso('2099-01-12', 14, 30), title: 'Moved', location: 'Room 9' }));

    loaded = onCalendar([fakeEvent({ id: 'one', title: 'Review', startDate: la('2099-01-10', 15), endDate: la('2099-01-10', 16), properties: { LOCATION: 'Room 1' } })], LA);
    nothingChanged(loaded, await edit({ event_id: 'one', start_iso: iso('2099-01-10', 15), end_iso: iso('2099-01-10', 16), title: 'Review', location: 'Room 1' }));

    loaded = onCalendar([series()], LA);
    nothingChanged(loaded, await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-01-14', 10), start_iso: iso('2099-01-14', 10), end_iso: iso('2099-01-14', 11), title: 'Night shift' }));
    expect(loaded.calendar.items).toHaveLength(1);
  });

  it('a restated time with a new title shows and writes only the title', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10' })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', start_iso: iso('2099-01-10', 10), end_iso: iso('2099-01-10', 11), title: 'Day shift' });
    expect(run.failReason).toBeUndefined();
    expect(timeChange(run.changes, 'Start')).toBeNull();
    expect(timeChange(run.changes, 'End')).toBeNull();
    expect(cardChange(run.changes, 'Title')).toEqual({ from: 'Night shift', to: 'Day shift' });
    const [stored] = loaded.calendar.items;
    expect([stored.title, digits(stored.startDate), digits(stored.endDate)]).toEqual(['Day shift', '2099-01-10T10:00:00', '2099-01-10T11:00:00']);
  });

  // "Start at 9:30 instead, still ending at 11:00": the assistant sends both
  // times. The end it restates is the end asked, so the length is not kept.
  it('a new start with the stored end restated keeps that end: single event, one occurrence, the series and from an occurrence on', async () => {
    const series = () => seriesOf({ tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10' });
    const cases = [
      { items: () => [fakeEvent({ id: 'one', title: 'Review', startDate: la('2099-01-10', 10), endDate: la('2099-01-10', 11) })],
        args: { event_id: 'one', start_iso: iso('2099-01-10', 9, 30), end_iso: iso('2099-01-10', 11) },
        written: (items) => items[0] },
      { items: () => [series()],
        args: { event_id: 'ser', edit_scope: 'this_only', recurrence_id: iso('2099-01-12', 10), start_iso: iso('2099-01-12', 9, 30), end_iso: iso('2099-01-12', 11) },
        written: (items) => items[0].recurrenceInfo.getExceptionFor(la('2099-01-12', 10)) },
      { items: () => [series()],
        args: { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 10), start_iso: iso('2099-01-10', 9, 30), end_iso: iso('2099-01-10', 11) },
        written: (items) => items[0] },
      { items: () => [series()],
        args: { event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-01-14', 10), start_iso: iso('2099-01-14', 9, 30), end_iso: iso('2099-01-14', 11) },
        written: (items) => items.find((it) => it.id !== 'ser') },
    ];
    for (const { items, args, written } of cases) {
      const loaded = onCalendar(items(), LA);
      const run = await edit(args);
      expect(run.failReason, args.edit_scope).toBeUndefined();
      expect(timeChange(run.changes, 'Start'), args.edit_scope).toEqual({ from: await flow.asCard(args.start_iso.replace('09:30', '10:00')), to: await flow.asCard(args.start_iso) });
      expect(timeChange(run.changes, 'End'), args.edit_scope).toBeNull();
      const item = written(loaded.calendar.items);
      expect([digits(item.startDate), digits(item.endDate)], args.edit_scope).toEqual([args.start_iso, args.end_iso]);
    }
  });

  // A time given in another zone that is the stored instant restates it.
  it('a series start restated in another zone, with a new title, changes only the title and resets nothing', async () => {
    const series = seriesOf({
      tzid: SYDNEY, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10',
      changed: [{ rid: at(SYDNEY, '2099-01-12', 10), start: at(SYDNEY, '2099-01-12', 14), end: at(SYDNEY, '2099-01-12', 15) }],
    });
    const loaded = onCalendar([series], LA);
    // The first occurrence as the read tools print it, on the user's clock.
    const first = await flow.readSeries();
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: first.start_iso, start_iso: iso('2099-01-10', 10), timezone: SYDNEY, title: 'Day shift' });
    expect(run.failReason).toBeUndefined();
    expect(timeChange(run.changes, 'Start')).toBeNull();
    expect(timeChange(run.changes, 'End')).toBeNull();
    expect(run.changes).not.toContain('will be reset');
    expect(run.sess.editResetsChangedOccurrences === true).toBe(false);
    const [stored] = loaded.calendar.items;
    expect([stored.title, digits(stored.startDate), digits(stored.endDate)]).toEqual(['Day shift', '2099-01-10T10:00:00', '2099-01-10T11:00:00']);
    const ex = stored.recurrenceInfo.getExceptionFor(at(SYDNEY, '2099-01-12', 10));
    expect(ex && [digits(ex.startDate), digits(ex.endDate)]).toEqual(['2099-01-12T14:00:00', '2099-01-12T15:00:00']);
  });

  it('a real change still shows the card', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-01-10', hour: 10 })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', title: 'Day shift' });
    expect(run.card).toBeTruthy();
    expect(run.state).toBe('exec_success');
    expect(loaded.calendar.items[0].title).toBe('Day shift');
  });

  it('a check that throws refuses before the card', async () => {
    for (const fail of [async () => { throw new Error('calendar busy'); }, async () => undefined]) {
      const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-01-10', hour: 10 })], LA);
      const real = globalThis.browser.tmCalendar.modifyCalendarEvent;
      globalThis.browser.tmCalendar.modifyCalendarEvent = (a) => (a.check_only ? fail() : real(a));
      const run = await edit({ event_id: 'ser', edit_scope: 'all', title: 'Day shift' });
      expect(run.card).toBeNull();
      expect(run.state).toBe('exec_fail');
      expect(run.failReason).toContain('the calendar could not check this edit (');
      expect(run.failReason).toContain('; try again');
      expect(loaded.modifications).toHaveLength(0);
    }
  });
});

describe('the check\'s answer is what the experiment declares', () => {
  const { SCHEMA_FUNCTIONS, checkNames } = schemaCheck;
  const returnsOf = (name) => SCHEMA_FUNCTIONS.find((f) => f.name === name).returns;

  it('a check of a new series start answers changes, times and resetsChangedOccurrences, every name declared, on the series and from an occurrence on', async () => {
    const series = () => seriesOf({
      tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10',
      changed: [{ rid: la('2099-01-14', 10), start: la('2099-01-14', 14), end: la('2099-01-14', 15) }],
    });
    for (const [name, args] of [
      ['modifyCalendarEvent', { event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', start_iso: iso('2099-01-10', 9) }],
      ['splitRecurringEvent', { event_id: 'ser', calendar_id: 'cal1', recurrence_id: iso('2099-01-12', 10), patch: { start_iso: iso('2099-01-12', 9) }, check_only: true }],
    ]) {
      const loaded = onCalendar([series()], LA);
      const res = await loaded.api[name](name === 'modifyCalendarEvent' ? { ...args, check_only: true } : args);
      expect(res, res.error).toMatchObject({ ok: true, changes: true, resetsChangedOccurrences: true });
      expect(Object.keys(res.times)).toEqual(['from', 'to']);
      expect(() => checkNames(returnsOf(name), res, name)).not.toThrow();
      expect(loaded.modifications).toHaveLength(0);
    }
  });

  it('a name the experiment does not declare is refused', () => {
    expect(() => checkNames(returnsOf('modifyCalendarEvent'), { ok: true, changed: true }, 'modifyCalendarEvent')).toThrow(/changed: not declared/);
    expect(() => checkNames(returnsOf('modifyCalendarEvent'), { ok: true, times: { from: { start: '' } } }, 'modifyCalendarEvent')).toThrow(/times\.from\.start: not declared/);
  });
});
