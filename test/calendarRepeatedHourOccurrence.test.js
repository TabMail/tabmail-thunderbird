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
//      exdates_add and edited on its own, and only it changes;
//   I2 an occurrence starting in the second pass (a series stored in the
//      user's zone at 01:30) is still named by its printed 01:30;
//   I3 a printed time that two occurrences share (one in each pass) names
//      neither: the edit is refused before the card and nothing is written;
//   I4 calendar_event_read finds an occurrence by the start_iso it prints,
//      in either pass (and both, when both start at that printed time).

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

const { onCalendar, seriesOf, edit, remove, occurrencesOf, readOccurrence } = await import('./helpers/seriesEditFlow.js');
const { digits } = await import('./helpers/nativeCalendarDates.js');
const { toNaiveIso } = await import('../chat/modules/helpers.js');
const { instantsNamedBy } = await import('../chat/tools/calendar_event_read.js');

const LA = 'America/Los_Angeles';
const NIGHT = '2099-11-01';
const PRINTED = `${NIGHT}T01:30:00`;
const FROM = '2099-10-29';
const TO = '2099-11-04';

// The start the read tools print for each occurrence, by its slot.
const printed = (item) => occurrencesOf(item, FROM, TO).map(({ occ }) => [digits(occ.recurrenceId), toNaiveIso(occ.startDate.nativeTime / 1000)]);
const stored = (loaded) => loaded.calendar.items.find((it) => it.id === 'ser');

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

describe('a printed time two occurrences share names neither (I3)', () => {
  it('an hourly series through the repeated hour: 01:30 is refused before the card and nothing is written', async () => {
    // 07:30Z hourly: 00:30 PDT, 01:30 PDT (first pass), 01:30 PST (second pass), 02:30 PST.
    const loaded = onCalendar([seriesOf({ tzid: 'UTC', day: NIGHT, hour: 7, minute: 30, rule: 'FREQ=HOURLY;COUNT=4' })], LA);
    const before = printed(stored(loaded));
    expect(before.filter(([, shown]) => shown === PRINTED)).toHaveLength(2);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: PRINTED, title: 'Retro' });
    expect(run.card).toBeNull();
    expect(String(run.failReason)).toContain(`recurrence_id ${PRINTED} is the start of more than one occurrence of this series`);
    expect(printed(stored(loaded))).toEqual(before);
    expect(stored(loaded).recurrenceInfo.getExceptionIds?.() || []).toHaveLength(0);
  });
});

describe('calendar_event_read finds an occurrence by its printed start in either pass (I4)', () => {
  it('the second pass: a series at 01:30 in the user\'s zone', async () => {
    onCalendar([seriesOf({ tzid: LA, day: '2099-10-30', hour: 1, minute: 30, rule: 'FREQ=DAILY;COUNT=4' })], LA);
    const read = await readOccurrence(PRINTED);
    expect(read.start_iso).toBe(PRINTED);
    expect(read.text).toContain('Night shift');
  });

  it('the first pass: a series stored in UTC at 08:30Z', async () => {
    onCalendar([seriesOf({ tzid: 'UTC', day: '2099-10-30', hour: 8, minute: 30, rule: 'FREQ=DAILY;COUNT=4' })], LA);
    expect((await readOccurrence(PRINTED)).start_iso).toBe(PRINTED);
  });

  it('both passes of an hourly series are found by the one printed time', async () => {
    onCalendar([seriesOf({ tzid: 'UTC', day: NIGHT, hour: 7, minute: 30, rule: 'FREQ=HOURLY;COUNT=4' })], LA);
    const read = await readOccurrence(PRINTED);
    expect(read.text.split('\n').filter((l) => l === `start_iso: ${PRINTED}`)).toHaveLength(2);
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
