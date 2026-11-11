/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEditCardOccurrence.test.js: an edit of one occurrence (#369) is
// shown and compared against that occurrence as Thunderbird shows it, its own
// times, kind and fields when it was changed on its own: the card's header,
// its old Start and End, its All-day line, and whether a field is a change.
// An edit of the whole series still compares with the series. The read tool
// prints a series as Thunderbird shows its first occurrence.

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
const { onCalendar, seriesOf, edit, iso, timeChange, cardChange, field, asCard, readSeries, readOccurrence } = flow;
const { at, dateOn, digits } = await import('./helpers/nativeCalendarDates.js');

const LA = 'America/Los_Angeles';
const la = (day, hour, minute = 0) => at(LA, day, hour, minute);
const NOTHING_CHANGED = 'Nothing changed: the event already has every time and value this edit gives, so nothing was written and no confirmation was shown.';

const withMoved = () => seriesOf({
  tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10',
  changed: [{ rid: la('2099-01-12', 10), start: la('2099-01-12', 14), end: la('2099-01-12', 14, 30), title: 'Moved', location: 'Room 9' }],
});
const withAllDay = () => seriesOf({
  tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10',
  changed: [{ rid: la('2099-01-12', 10), start: dateOn('2099-01-12'), end: dateOn('2099-01-13') }],
});
// The occurrence an edit names, by its start as the read tools print it.
const MOVED = iso('2099-01-12', 14);
const exceptionAt = (loaded, rid) => loaded.calendar.items[0].recurrenceInfo.getExceptionFor(rid);

describe('the card of an edit of one occurrence shows that occurrence', () => {
  it('one occurrence moved on its own: the card\'s old start and end are its own', async () => {
    onCalendar([withMoved()], LA);
    const end = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: MOVED, end_iso: iso('2099-01-12', 15) }, { confirm: false });
    expect(timeChange(end.changes, 'Start')).toBeNull();
    expect(timeChange(end.changes, 'End')).toEqual({ from: await asCard(iso('2099-01-12', 14, 30)), to: await asCard(iso('2099-01-12', 15)) });
    onCalendar([withMoved()], LA);
    const start = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: MOVED, start_iso: iso('2099-01-12', 13) }, { confirm: false });
    expect(timeChange(start.changes, 'Start')).toEqual({ from: await asCard(iso('2099-01-12', 14)), to: await asCard(iso('2099-01-12', 13)) });
  });

  it('one occurrence made all-day on its own: labels and the All-day line use its kind', async () => {
    const loaded = onCalendar([withAllDay()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: '2099-01-12', start_iso: iso('2099-01-12', 9), end_iso: iso('2099-01-12', 10), all_day: false });
    expect(run.failReason).toBeUndefined();
    expect(field(run.header, 'All-day')).toBe('yes');
    expect(cardChange(run.changes, 'All-day event')).toEqual({ from: 'yes', to: 'no' });
    expect(cardChange(run.changes, 'Start time')).toEqual({ from: await asCard('2099-01-12', { allDay: true }), to: await asCard(iso('2099-01-12', 9)) });
    const ex = exceptionAt(loaded, la('2099-01-12', 10));
    expect([ex.startDate.isDate, digits(ex.startDate), digits(ex.endDate)]).toEqual([false, '2099-01-12T09:00:00', '2099-01-12T10:00:00']);
  });

  it('the card header shows the occurrence', async () => {
    onCalendar([withMoved()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: MOVED, location: 'Room 10' }, { confirm: false });
    expect(field(run.header, 'Title')).toBe('Moved');
    expect(field(run.header, 'Start')).toBe(await asCard(iso('2099-01-12', 14)));
    expect(field(run.header, 'End')).toBe(await asCard(iso('2099-01-12', 14, 30), { endAfter: iso('2099-01-12', 14) }));
    expect(cardChange(run.changes, 'Location')).toEqual({ from: 'Room 9', to: 'Room 10' });
  });

  it('a title the occurrence already has is no change; one equal to the series\' but not the occurrence\'s is shown and written', async () => {
    let loaded = onCalendar([withMoved()], LA);
    const same = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: MOVED, title: 'Moved' });
    expect(same.card).toBeNull();
    expect(same.result).toEqual({ ok: true, result: NOTHING_CHANGED });
    expect(loaded.modifications).toHaveLength(0);
    loaded = onCalendar([withMoved()], LA);
    const back = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: MOVED, title: 'Night shift' });
    expect(cardChange(back.changes, 'Title')).toEqual({ from: 'Moved', to: 'Night shift' });
    const ex = exceptionAt(loaded, la('2099-01-12', 10));
    expect([ex.title, digits(ex.startDate), ex.getProperty('LOCATION')]).toEqual(['Night shift', '2099-01-12T14:00:00', 'Room 9']);
  });

  it('all still compares fields with the series', async () => {
    const loaded = onCalendar([withMoved()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', title: 'Moved' });
    expect(cardChange(run.changes, 'Title')).toEqual({ from: 'Night shift', to: 'Moved' });
    expect(loaded.calendar.items[0].title).toBe('Moved');
  });

  it('calendar_event_read prints a series whose first night spans a change as Thunderbird shows it', async () => {
    // Stored 22:00 to 07:00 across the autumn night: ten hours elapsed, so
    // Thunderbird shows that night (and every other) ending 08:00.
    onCalendar([seriesOf({ tzid: LA, day: '2099-10-31', end: la('2099-11-01', 7) })], LA);
    const series = await readSeries();
    const first = await readOccurrence(iso('2099-10-31', 22));
    expect([series.start_iso, series.end_iso]).toEqual([iso('2099-10-31', 22), iso('2099-11-01', 8)]);
    expect([first.start_iso, first.end_iso]).toEqual([series.start_iso, series.end_iso]);
  });
});
