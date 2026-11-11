/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesTimesWest.test.js: a time change of a whole repeating series,
// the user west of UTC (America/Los_Angeles: the clocks skip 02:00-03:00 on
// 8 March 2099 and repeat 01:00-02:00 on 1 November 2099), through the real
// edit tool, card and bridge on Thunderbird's own dates. A series' length is
// wall-clock: the digits between the end given and the start of the
// occurrence the edit names. Every occurrence takes it as Thunderbird builds
// one (its start plus the length by the clock), so every night ends at the
// time given, also the night of a clock change (I1-I4, see seriesRow).
// Restating a time the read tools print is no change (I5), and a floating
// series keeps the digits it is given (I6).

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
const { onCalendar, seriesOf, edit, seriesRow, readSeries, readOccurrence, occurrencesOf, clockDiff, timeChange, iso } = flow;
const { at, dateOn, digits } = await import('./helpers/nativeCalendarDates.js');
const { fakeEvent, fakeRecurrenceInfo, recurrenceItem } = await import('./helpers/calendarBridgeHarness.js');
const { clockAt, inFirstPass, HOUR, MINUTE } = await import('./helpers/zoneOffsetTable.js');
const { shownEventTimesIso } = await import('../chat/tools/calendar_event_read.js');

const LA = 'America/Los_Angeles';
const SYDNEY = 'Australia/Sydney';
const H = 3600;
const end = (day, hour, minute = 0) => at(LA, day, hour, minute);
const moved = (rid, start, finish) => ({ rid, start, end: finish });

describe('a whole-series time change, west of UTC: every night ends at the end given', () => {
  it('row 1: an ordinary night, end 07:00', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-01-10' })], LA);
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-10', 22), end_iso: iso('2099-01-11', 7) },
      { W: 9 * H, namedStart: iso('2099-01-10', 22), namedEnd: iso('2099-01-11', 7), fromDay: '2099-01-10', toDay: '2099-01-20' });
  });

  it('row 2: the named night spans the autumn change, end 07:00: every night ends 07:00', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-10-31' })], LA);
    const { stored } = await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-31', 22), end_iso: iso('2099-11-01', 7) },
      { W: 9 * H, namedStart: iso('2099-10-31', 22), namedEnd: iso('2099-11-01', 7), fromDay: '2099-10-31', toDay: '2099-11-10' });
    // Thunderbird's own length of the series is 9 hours, so its stored end
    // that night is 06:00 (limit: another app may show that night ending 06:00).
    expect(digits(stored.endDate)).toBe('2099-11-01T06:00:00');
  });

  it('row 3: the named night spans the spring change, end 07:00', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-03-07' })], LA);
    const { stored } = await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-03-07', 22), end_iso: iso('2099-03-08', 7) },
      { W: 9 * H, namedStart: iso('2099-03-07', 22), namedEnd: iso('2099-03-08', 7), fromDay: '2099-03-07', toDay: '2099-03-17' });
    expect(digits(stored.endDate)).toBe('2099-03-08T08:00:00');
  });

  it('row 4: the first slot spans the autumn change, named occurrence moved to an ordinary evening', async () => {
    const series = seriesOf({ tzid: LA, day: '2099-10-31', changed: [moved(end('2099-10-31', 22), end('2099-10-30', 21), end('2099-10-30', 22))] });
    const loaded = onCalendar([series], LA);
    const { stored } = await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-30', 21), end_iso: iso('2099-10-31', 6) },
      { W: 9 * H, namedStart: iso('2099-10-30', 21), namedEnd: iso('2099-10-31', 6), fromDay: '2099-10-29', toDay: '2099-11-10' });
    expect(digits(stored.endDate)).toBe('2099-11-01T06:00:00');
  });

  it('row 5: first slot ordinary, named occurrence moved onto the autumn night, end 08:00', async () => {
    const series = seriesOf({ tzid: LA, day: '2099-10-27', rule: 'FREQ=WEEKLY;COUNT=8', changed: [moved(end('2099-10-27', 22), end('2099-10-31', 22), end('2099-10-31', 23))] });
    const loaded = onCalendar([series], LA);
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-31', 22), end_iso: iso('2099-11-01', 8) },
      { W: 10 * H, namedStart: iso('2099-10-31', 22), namedEnd: iso('2099-11-01', 8), fromDay: '2099-10-26', toDay: '2099-12-20' });
  });

  it('row 6: end 01:30 just before the spring gap', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-03-07', minute: 30 })], LA);
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-03-07', 22, 30), end_iso: iso('2099-03-08', 1, 30) },
      { W: 3 * H, namedStart: iso('2099-03-07', 22, 30), namedEnd: iso('2099-03-08', 1, 30), fromDay: '2099-03-07', toDay: '2099-03-17' });
  });

  it('row 7: end 03:30 just after the spring gap: every night 03:30', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-03-07', minute: 30 })], LA);
    const { stored } = await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-03-07', 22, 30), end_iso: iso('2099-03-08', 3, 30) },
      { W: 5 * H, namedStart: iso('2099-03-07', 22, 30), namedEnd: iso('2099-03-08', 3, 30), fromDay: '2099-03-07', toDay: '2099-03-17' });
    expect(digits(stored.endDate)).toBe('2099-03-08T04:30:00');
  });

  it('row 9: end 01:30 at an occurrence moved on its own, first slot ordinary', async () => {
    const series = seriesOf({ tzid: LA, day: '2099-10-27', rule: 'FREQ=WEEKLY;COUNT=8', changed: [moved(end('2099-10-27', 22), end('2099-10-31', 22), end('2099-10-31', 23))] });
    const loaded = onCalendar([series], LA);
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-31', 22), end_iso: iso('2099-11-01', 1, 30) },
      { W: 3.5 * H, namedStart: iso('2099-10-31', 22), namedEnd: iso('2099-11-01', 1, 30), fromDay: '2099-10-26', toDay: '2099-12-20' });
  });

  it('a stored series whose first night spans autumn, its printed end restated: nothing changes; end 08:00 is written', async () => {
    // Stored by another app as 22:00 to 06:00: nine hours, which Thunderbird
    // adds by the clock, so every night is shown 22:00 to 07:00.
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-10-31', end: end('2099-11-01', 6) })], LA);
    const shown = await readSeries();
    expect(shown.end_iso).toBe(iso('2099-11-01', 7));
    const same = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-31', 22), end_iso: shown.end_iso });
    expect(same.card).toBeNull();
    expect(same.result.result).toMatch(/^Nothing changed/);
    expect(loaded.modifications).toHaveLength(0);
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-31', 22), end_iso: iso('2099-11-01', 8) },
      { W: 10 * H, namedStart: iso('2099-10-31', 22), namedEnd: iso('2099-11-01', 8), fromDay: '2099-10-31', toDay: '2099-11-10' });
  });

  it('spring twin: end 07:00 gives every night 22:00 to 07:00', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-03-07', end: end('2099-03-08', 6) })], LA);
    expect((await readSeries()).end_iso).toBe(iso('2099-03-08', 5));
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-03-07', 22), end_iso: iso('2099-03-08', 7) },
      { W: 9 * H, namedStart: iso('2099-03-07', 22), namedEnd: iso('2099-03-08', 7), fromDay: '2099-03-07', toDay: '2099-03-17' });
  });

  for (const [name, day] of [['autumn', '2099-10-31'], ['spring', '2099-03-07']]) {
    it(`a title-only split on the eve of the ${name} change: the part ends at the series' end time`, async () => {
      const loaded = onCalendar([seriesOf({ tzid: LA, day: flow.dayPlus(day, -5), hour: 17 })], LA);
      const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso(day, 17), title: 'Late shift' });
      expect(run.failReason).toBeUndefined();
      const part = loaded.calendar.items.find((it) => it.id !== 'ser');
      expect(digits(part.startDate)).toBe(`${day}T17:00:00`);
      expect(digits(part.endDate)).toBe(`${day}T18:00:00`);
      expect(part.endDate.subtractDate(part.startDate).inSeconds).toBe(H);
      for (const o of occurrencesOf(part, day, flow.dayPlus(day, 5))) expect(clockDiff(o.end, o.start), o.start).toBe(H);
    });
  }

  it('end 19:00 on a series starting 10-31 17:00', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-10-31', hour: 17 })], LA);
    const { stored } = await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', end_iso: iso('2099-10-31', 19) },
      { W: 2 * H, namedStart: iso('2099-10-31', 17), namedEnd: iso('2099-10-31', 19), fromDay: '2099-10-31', toDay: '2099-11-10' });
    expect(digits(stored.endDate)).toBe('2099-10-31T19:00:00');
  });

  it('a first occurrence stored 00:00Z to 01:00Z: its printed end restated is no change; end 19:00 is written', async () => {
    const start = at('UTC', '2099-11-01', 0);
    const loaded = onCalendar([seriesOf({ tzid: 'UTC', day: '2099-11-01', hour: 0, end: at('UTC', '2099-11-01', 1) })], LA);
    expect(start.timezone.tzid).toBe('UTC');
    const shown = await readSeries();
    expect(shown).toMatchObject({ start_iso: iso('2099-10-31', 17), end_iso: iso('2099-10-31', 18) });
    const same = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: shown.start_iso, end_iso: shown.end_iso });
    expect(same.card).toBeNull();
    expect(same.result.result).toMatch(/^Nothing changed/);
    expect(loaded.modifications).toHaveLength(0);
    const { stored } = await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: shown.start_iso, end_iso: iso('2099-10-31', 19) },
      { W: 2 * H, namedStart: iso('2099-10-31', 17), namedEnd: iso('2099-10-31', 19), fromDay: '2099-10-30', toDay: '2099-11-10' });
    expect(stored.endDate.timezone.tzid).toBe('UTC');
    expect(digits(stored.endDate)).toBe('2099-11-01T02:00:00');
  });

  it('a floating series 02:30 to 03:30 on the spring day, end 04:30: start kept, end 04:30', async () => {
    const loaded = onCalendar([seriesOf({ tzid: 'floating', day: '2099-03-08', hour: 2, minute: 30 })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', end_iso: iso('2099-03-08', 4, 30) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(stored.startDate.timezone.tzid).toBe('floating');
    expect(digits(stored.startDate)).toBe('2099-03-08T02:30:00');
    expect(digits(stored.endDate)).toBe('2099-03-08T04:30:00');
    expect(timeChange(run.changes, 'End').to).toBe(await flow.asCard(iso('2099-03-08', 4, 30)));
  });

  it('a floating 23:00 to 02:30 series: the printed 01:30 restated is no change; 01:00 and 03:30 are written as given', async () => {
    const make = () => seriesOf({ tzid: 'floating', day: '2099-03-07', hour: 23, end: at('floating', '2099-03-08', 2, 30) });
    let loaded = onCalendar([make()], LA);
    const shown = await readSeries();
    expect(shown.end_iso).toBe(iso('2099-03-08', 1, 30));
    const same = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-03-07', 23), end_iso: shown.end_iso });
    expect(same.card).toBeNull();
    expect(same.result.result).toMatch(/^Nothing changed/);
    expect(loaded.modifications).toHaveLength(0);
    for (const [hour, minute] of [[1, 0], [3, 30]]) {
      loaded = onCalendar([make()], LA);
      const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-03-07', 23), end_iso: iso('2099-03-08', hour, minute) });
      expect(run.failReason).toBeUndefined();
      const [stored] = loaded.calendar.items;
      expect(digits(stored.startDate)).toBe('2099-03-07T23:00:00');
      expect(stored.endDate.timezone.tzid).toBe('floating');
      expect(digits(stored.endDate)).toBe(iso('2099-03-08', hour, minute));
    }
  });

  it('a Sydney series given a start on the user\'s clock lands at the same instant in Sydney', async () => {
    const loaded = onCalendar([seriesOf({ tzid: SYDNEY, day: '2099-09-30', hour: 12 })], LA);
    const shown = await readSeries();
    expect(shown.start_iso).toBe(iso('2099-09-29', 19));
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: shown.start_iso, start_iso: iso('2099-10-03', 10) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(stored.startDate.timezone.tzid).toBe(SYDNEY);
    expect(digits(stored.startDate)).toBe('2099-10-04T04:00:00');
    expect((await readSeries()).start_iso).toBe(iso('2099-10-03', 10));
  });

  it('a Los Angeles series given a time with timezone Australia/Sydney lands at the same instant', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-10-20', hour: 17 })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-20', 17), start_iso: iso('2099-11-01', 12), timezone: SYDNEY });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(stored.startDate.timezone.tzid).toBe(LA);
    expect(digits(stored.startDate)).toBe('2099-10-31T18:00:00');
    expect(digits(stored.endDate)).toBe('2099-10-31T19:00:00');
  });

  it('a UTC series, end given on the user\'s clock: stored in UTC, W 1.5 h', async () => {
    const loaded = onCalendar([seriesOf({ tzid: 'UTC', day: '2099-11-01', hour: 5 })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', end_iso: iso('2099-10-31', 23, 30) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(stored.endDate.timezone.tzid).toBe('UTC');
    expect(digits(stored.endDate)).toBe('2099-11-01T06:30:00');
    expect(stored.endDate.subtractDate(stored.startDate).inSeconds).toBe(1.5 * H);
  });

  it('all-day 03-07 to 03-09, end 03-10: three days by digits', async () => {
    const ev = fakeEvent({ id: 'ser', title: 'Retreat', startDate: dateOn('2099-03-07'), endDate: dateOn('2099-03-09') });
    ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')]);
    ev.recurrenceInfo.item = ev;
    const loaded = onCalendar([ev], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: '2099-03-07', end_iso: '2099-03-10' });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(stored.endDate.isDate).toBe(true);
    expect(digits(stored.endDate)).toBe('2099-03-10T00:00:00');
    for (const o of occurrencesOf(stored, '2099-03-01', '2099-04-10')) expect(clockDiff(o.end, o.start), o.start).toBe(3 * 86400);
  });

  it('a start alone onto the autumn night keeps every night\'s length (#365)', async () => {
    const loaded = onCalendar([seriesOf({ tzid: LA, day: '2099-10-20', hours: 9 })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-20', 22), start_iso: iso('2099-10-31', 22) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    for (const o of occurrencesOf(stored, '2099-10-31', '2099-11-10')) expect(clockDiff(o.end, o.start), o.start).toBe(9 * H);
    expect((await readOccurrence(iso('2099-10-31', 22))).end_iso).toBe(iso('2099-11-01', 7));
  });
});

// Every stored time within three days of each change, every 15 minutes, held
// in UTC, in another zone and in the user's: printed by the read tools,
// given back with a new title, the check reports no time and the write keeps
// the stored start and end.
// The I5 sweeps run every stored time through the bridge twice.
const SWEEP_TIMEOUT_MS = 120_000;

describe('I5: restating the printed times is no change', () => {
  const CHANGES = [Date.UTC(2099, 2, 8, 10), Date.UTC(2099, 10, 1, 9)];
  const stored = [];
  for (const change of CHANGES) {
    for (let ms = change - 72 * HOUR; ms <= change + 72 * HOUR; ms += 15 * MINUTE) {
      for (const frame of ['UTC', SYDNEY, LA]) {
        if (frame !== 'UTC' && inFirstPass(frame, ms)) continue;
        stored.push({ ms, frame });
      }
    }
  }
  const valueAt = (frame, ms) => {
    const digitsIso = frame === 'UTC' ? new Date(ms).toISOString().slice(0, 19) : clockAt(frame, ms);
    const [day, time] = digitsIso.split('T');
    const [h, m] = time.split(':').map(Number);
    return at(frame, day, h, m);
  };
  const shownTimes = async (api, id, rid) => shownEventTimesIso(await api.getCalendarEventDetails(id, 'cal1', rid));
  // An occurrence is named by its start as the read tools print it, and a
  // printed time inside the hour the user's clocks repeat is read as its later
  // pass (unchanged), so an occurrence starting in the first pass cannot be
  // named: those are left out of the rows that name one.
  const nameable = ({ ms }) => !inFirstPass(LA, ms);

  for (const kind of ['series', 'single event', 'one occurrence']) {
    it(`every stored start and end of the sweep, given back as printed with a new title, writes the title only (${kind})`, async () => {
      const rows = kind === 'one occurrence' ? stored.filter(nameable) : stored;
      const items = rows.map(({ ms, frame }, i) => {
        const start = valueAt(frame, ms);
        const finish = start.clone();
        finish.hour += 1;
        const ev = fakeEvent({ id: `e${i}`, title: 'Standup', startDate: start, endDate: finish });
        if (kind !== 'single event') {
          ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=3')]);
          ev.recurrenceInfo.item = ev;
        }
        return ev;
      });
      const loaded = onCalendar(items, LA);
      // As Thunderbird shows it: the event, or for one occurrence the first
      // occurrence as Thunderbird builds it (its start plus the series'
      // length by the clock), which an edit of it writes.
      const shownItem = (ev) => (kind === 'one occurrence' ? ev.createProxy(ev.startDate) : ev);
      const before = items.map((ev) => shownItem(ev)).map((ev) => [digits(ev.startDate), digits(ev.endDate), ev.startDate.timezone.tzid]);
      const misses = [];
      for (let i = 0; i < items.length; i++) {
        const shown = await shownTimes(loaded.api, `e${i}`);
        const args = { event_id: `e${i}`, calendar_id: 'cal1', title: 'Retro', start_iso: shown.start_iso, end_iso: shown.end_iso };
        if (kind === 'series') args.edit_scope = 'all';
        if (kind === 'one occurrence') Object.assign(args, { edit_scope: 'this_only', recurrence_id: shown.start_iso });
        const check = await loaded.api.modifyCalendarEvent({ ...args, check_only: true });
        const res = await loaded.api.modifyCalendarEvent(args);
        const item = loaded.calendar.items.find((it) => it.id === `e${i}`);
        const written = kind === 'one occurrence' ? item.recurrenceInfo.getExceptionFor(item.startDate) : item;
        const after = written ? [digits(written.startDate), digits(written.endDate), written.startDate.timezone.tzid] : ['(no occurrence written)'];
        if (!check.ok || check.times !== undefined || !res.ok || written?.title !== 'Retro' || after.join() !== before[i].join()) {
          misses.push(`${before[i].join(' ')}: ${check.error || res.error || ''} ${JSON.stringify(check.times)} -> ${after.join(' ')}`);
        }
      }
      expect(misses).toEqual([]);
      expect(items.length).toBeGreaterThan(3000);
    }, SWEEP_TIMEOUT_MS);
  }

  it('twenty of them through the whole tool: the card shows the title and no time line', async () => {
    const near = stored.filter((row) => nameable(row) && CHANGES.some((c) => Math.abs(row.ms - c) <= 75 * MINUTE)).slice(0, 20);
    expect(near).toHaveLength(20);
    for (const { ms, frame } of near) {
      const start = valueAt(frame, ms);
      const finish = start.clone();
      finish.hour += 1;
      const ev = fakeEvent({ id: 'ser', title: 'Standup', startDate: start, endDate: finish });
      ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=3')]);
      ev.recurrenceInfo.item = ev;
      const loaded = onCalendar([ev], LA);
      const shown = await readSeries();
      const was = [digits(start), digits(finish)];
      const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: shown.start_iso, title: 'Retro', start_iso: shown.start_iso, end_iso: shown.end_iso });
      const where = `${frame} ${new Date(ms).toISOString()}`;
      expect(run.failReason, where).toBeUndefined();
      expect(run.changes, where).toContain('**Title:**');
      expect(timeChange(run.changes, 'Start'), where).toBeNull();
      expect(timeChange(run.changes, 'End'), where).toBeNull();
      const [written] = loaded.calendar.items;
      expect([digits(written.startDate), digits(written.endDate)], where).toEqual(was);
    }
  });
});

describe('I6: a floating series keeps the digits it is given', () => {
  it('a floating series, every half hour of the user\'s spring day: DTSTART keeps its digits, DTEND has the digits given', async () => {
    const misses = [];
    for (let minute = 0; minute <= 21 * 60 + 30; minute += 30) {
      const [h, m] = [Math.floor(minute / 60), minute % 60];
      const ev = seriesOf({ tzid: 'floating', day: '2099-03-08', hour: h, minute: m });
      const loaded = onCalendar([ev], LA);
      const [eh, em] = [Math.floor((minute + 120) / 60), (minute + 120) % 60];
      // A time the user's clock skips cannot be typed on it (the tool reads
      // it on the system clock, which moves it); every other end can.
      if (eh === 2) continue;
      const given = iso('2099-03-08', eh, em);
      const res = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', end_iso: given });
      const [stored] = loaded.calendar.items;
      const got = [res.ok, digits(stored.startDate), digits(stored.endDate), stored.endDate.timezone.tzid];
      const want = [true, iso('2099-03-08', h, m), given, 'floating'];
      if (got.join() !== want.join()) misses.push(`${want.join(' ')} != ${got.join(' ')} ${res.error || ''}`);
    }
    expect(misses).toEqual([]);
  });
});
