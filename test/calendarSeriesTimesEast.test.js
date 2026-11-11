/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesTimesEast.test.js: a time change of a whole repeating series,
// the user east of UTC (Australia/Sydney: the clocks repeat 02:00-03:00 on
// 5 April 2099 and skip 02:00-03:00 on 4 October 2099), through the real
// edit tool, card and bridge on Thunderbird's own dates. A series' length is
// wall-clock: the digits between the end given and the start of the
// occurrence the edit names. Every occurrence takes it as Thunderbird builds
// one (its start plus the length by the clock), so every night ends at the
// time given, also the night of a clock change (I1-I4, see seriesRow).
// Restating a time the read tools print is no change (I5), and a floating
// series keeps the digits it is given (I6).

process.env.TZ = 'Australia/Sydney';

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
const end = (day, hour, minute = 0) => at(SYDNEY, day, hour, minute);
const moved = (rid, start, finish) => ({ rid, start, end: finish });

describe('a whole-series time change, east of UTC: every night ends at the end given', () => {
  it('an ordinary night, end 07:00', async () => {
    const loaded = onCalendar([seriesOf({ tzid: SYDNEY, day: '2099-06-10' })], SYDNEY);
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-06-10', 22), end_iso: iso('2099-06-11', 7) },
      { W: 9 * H, namedStart: iso('2099-06-10', 22), namedEnd: iso('2099-06-11', 7), fromDay: '2099-06-10', toDay: '2099-06-20' });
  });

  it('the named night spans the autumn change, end 07:00: every night ends 07:00', async () => {
    const loaded = onCalendar([seriesOf({ tzid: SYDNEY, day: '2099-04-04' })], SYDNEY);
    const { stored } = await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-04-04', 22), end_iso: iso('2099-04-05', 7) },
      { W: 9 * H, namedStart: iso('2099-04-04', 22), namedEnd: iso('2099-04-05', 7), fromDay: '2099-04-04', toDay: '2099-04-14' });
    expect(digits(stored.endDate)).toBe('2099-04-05T06:00:00');
  });

  it('the named night spans the spring change, end 07:00', async () => {
    const loaded = onCalendar([seriesOf({ tzid: SYDNEY, day: '2099-10-03' })], SYDNEY);
    const { stored } = await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-03', 22), end_iso: iso('2099-10-04', 7) },
      { W: 9 * H, namedStart: iso('2099-10-03', 22), namedEnd: iso('2099-10-04', 7), fromDay: '2099-10-03', toDay: '2099-10-13' });
    expect(digits(stored.endDate)).toBe('2099-10-04T08:00:00');
  });

  it('end 01:30 just before the spring gap', async () => {
    const loaded = onCalendar([seriesOf({ tzid: SYDNEY, day: '2099-10-03', minute: 30 })], SYDNEY);
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-03', 22, 30), end_iso: iso('2099-10-04', 1, 30) },
      { W: 3 * H, namedStart: iso('2099-10-03', 22, 30), namedEnd: iso('2099-10-04', 1, 30), fromDay: '2099-10-03', toDay: '2099-10-13' });
  });

  it('moved named occurrence spanning spring, end 08:00', async () => {
    const series = seriesOf({ tzid: SYDNEY, day: '2099-09-29', rule: 'FREQ=WEEKLY;COUNT=8', changed: [moved(end('2099-09-29', 22), end('2099-10-03', 22), end('2099-10-03', 23))] });
    const loaded = onCalendar([series], SYDNEY);
    await seriesRow(loaded, { event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-10-03', 22), end_iso: iso('2099-10-04', 8) },
      { W: 10 * H, namedStart: iso('2099-10-03', 22), namedEnd: iso('2099-10-04', 8), fromDay: '2099-09-28', toDay: '2099-11-20' });
  });

  it('a title-only split on the Sunday of the autumn change: the part ends at the series\' end time', async () => {
    const loaded = onCalendar([seriesOf({ tzid: SYDNEY, day: '2099-03-30', hour: 9 })], SYDNEY);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-04-05', 9), title: 'Late shift' });
    expect(run.failReason).toBeUndefined();
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    expect(digits(part.startDate)).toBe('2099-04-05T09:00:00');
    expect(digits(part.endDate)).toBe('2099-04-05T10:00:00');
    expect(part.endDate.subtractDate(part.startDate).inSeconds).toBe(H);
  });

  it('a floating series 02:30 to 03:30 on the spring day, end 04:30: start kept, end 04:30', async () => {
    const loaded = onCalendar([seriesOf({ tzid: 'floating', day: '2099-10-04', hour: 2, minute: 30 })], SYDNEY);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', end_iso: iso('2099-10-04', 4, 30) });
    expect(run.failReason).toBeUndefined();
    const [stored] = loaded.calendar.items;
    expect(stored.startDate.timezone.tzid).toBe('floating');
    expect(digits(stored.startDate)).toBe('2099-10-04T02:30:00');
    expect(digits(stored.endDate)).toBe('2099-10-04T04:30:00');
  });
});

// Every stored time within three days of each change, every 15 minutes, held
// in UTC, in another zone and in the user's: printed by the read tools,
// given back with a new title, the check reports no time and the write keeps
// the stored start and end.
// The I5 sweeps run every stored time through the bridge twice.
const SWEEP_TIMEOUT_MS = 120_000;

describe('I5: restating the printed times is no change', () => {
  const CHANGES = [Date.UTC(2099, 3, 4, 16), Date.UTC(2099, 9, 3, 16)];
  const stored = [];
  for (const change of CHANGES) {
    for (let ms = change - 72 * HOUR; ms <= change + 72 * HOUR; ms += 15 * MINUTE) {
      for (const frame of ['UTC', LA, SYDNEY]) {
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
  const nameable = ({ ms }) => !inFirstPass(SYDNEY, ms);

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
      const loaded = onCalendar(items, SYDNEY);
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
      const loaded = onCalendar([ev], SYDNEY);
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
      const ev = seriesOf({ tzid: 'floating', day: '2099-10-04', hour: h, minute: m });
      const loaded = onCalendar([ev], SYDNEY);
      const [eh, em] = [Math.floor((minute + 120) / 60), (minute + 120) % 60];
      // A time the user's clock skips cannot be typed on it (the tool reads
      // it on the system clock, which moves it); every other end can.
      if (eh === 2) continue;
      const given = iso('2099-10-04', eh, em);
      const res = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', end_iso: given });
      const [stored] = loaded.calendar.items;
      const got = [res.ok, digits(stored.startDate), digits(stored.endDate), stored.endDate.timezone.tzid];
      const want = [true, iso('2099-10-04', h, m), given, 'floating'];
      if (got.join() !== want.join()) misses.push(`${want.join(' ')} != ${got.join(' ')} ${res.error || ''}`);
    }
    expect(misses).toEqual([]);
  });
});
