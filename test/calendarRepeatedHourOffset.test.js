/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarRepeatedHourOffset.test.js: the night the clocks go back, the times
// of the hour they repeat happen twice, so their digits name two moments. The
// tools print such a time with its UTC offset, "2099-11-01T01:30:00 (UTC-7)"
// before the clocks go back and "(UTC-8)" after, and every other time exactly
// as before. With the user in Los Angeles, New York, Berlin, London, Sydney and
// Lord Howe (whose clocks move by 30 minutes):
//   P1 calendar_event_read prints each pass with its own offset, and every
//      time outside the repeated hour byte for byte as before;
//   P2 calendar_read lists both passes with their offsets, in the order they
//      happen;
//   P3 the confirmation card names the zone of the moment the offset names;
//   P4 the calendar bridge prints every instant of those nights exactly as
//      the tools do, judged by an offset table written without either, and a
//      spring night with no offset at all;
//   P5 the printed form is read back only as written: "UTC" and an offset in
//      hours (and minutes), with or without seconds, on a real date; anything
//      else in parentheses is not a time the calendar tools read.

process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

globalThis.browser = {
  tmCalendar: {},
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined) },
};
globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/context.js', () => ({
  ctx: { activePid: 0, awaitingPid: 0, activeToolCallId: null, fsmSessions: Object.create(null), state: null, toolExecutionMode: null, rawUserTexts: [] },
  initFsmSession: vi.fn(),
}));
vi.mock('../chat/modules/markdown.js', () => ({ attachSpecialLinkListeners: vi.fn(), renderMarkdown: vi.fn() }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn(async () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } })) }));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: vi.fn(async () => {}) }));

const read = await import('../chat/tools/calendar_event_read.js');
const listing = await import('../chat/tools/calendar_read.js');
const { formatCardTime, toNaiveIso } = await import('../chat/modules/helpers.js');
const { _testExports: editExports } = await import('../chat/tools/calendar_event_edit.js');
const { experimentFunctions } = await import('./helpers/experimentFunctions.js');
const { at, zone, UTC, FLOATING, NativeDateTime } = await import('./helpers/nativeCalendarDates.js');
const { offsetAt, clockAt, instantsOf } = await import('./helpers/zoneOffsetTable.js');

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

async function asUserIn(tzid, fn) {
  const was = process.env.TZ;
  process.env.TZ = tzid;
  try { return await fn(); } finally { process.env.TZ = was; }
}

// Each zone's fall-back change: its UTC instant, how far the clocks go back,
// and the offsets before and after, written by hand from the zone's rules.
const FALL_BACK = {
  'America/Los_Angeles': { at: Date.UTC(2099, 10, 1, 9), back: HOUR, before: 'UTC-7', after: 'UTC-8' },
  'America/New_York': { at: Date.UTC(2099, 10, 1, 6), back: HOUR, before: 'UTC-4', after: 'UTC-5' },
  'Europe/Berlin': { at: Date.UTC(2099, 9, 25, 1), back: HOUR, before: 'UTC+2', after: 'UTC+1' },
  'Europe/London': { at: Date.UTC(2099, 9, 25, 1), back: HOUR, before: 'UTC+1', after: 'UTC+0' },
  'Australia/Sydney': { at: Date.UTC(2099, 3, 4, 16), back: HOUR, before: 'UTC+11', after: 'UTC+10' },
  'Australia/Lord_Howe': { at: Date.UTC(2099, 3, 4, 15), back: 30 * MINUTE, before: 'UTC+11', after: 'UTC+10:30' },
};

// Starts through each fall-back night (UTC) and the start_iso the read prints
// for them, written by hand: before the repeated hour, its first pass, its
// second pass, after it.
const PRINTED = {
  'America/Los_Angeles': [
    ['2099-11-01T07:30:00Z', '2099-11-01T00:30:00'],
    ['2099-11-01T08:30:00Z', '2099-11-01T01:30:00 (UTC-7)'],
    ['2099-11-01T09:30:00Z', '2099-11-01T01:30:00 (UTC-8)'],
    ['2099-11-01T10:30:00Z', '2099-11-01T02:30:00'],
  ],
  'America/New_York': [
    ['2099-11-01T04:30:00Z', '2099-11-01T00:30:00'],
    ['2099-11-01T05:30:00Z', '2099-11-01T01:30:00 (UTC-4)'],
    ['2099-11-01T06:30:00Z', '2099-11-01T01:30:00 (UTC-5)'],
    ['2099-11-01T07:30:00Z', '2099-11-01T02:30:00'],
  ],
  'Europe/Berlin': [
    ['2099-10-24T23:30:00Z', '2099-10-25T01:30:00'],
    ['2099-10-25T00:30:00Z', '2099-10-25T02:30:00 (UTC+2)'],
    ['2099-10-25T01:30:00Z', '2099-10-25T02:30:00 (UTC+1)'],
    ['2099-10-25T02:30:00Z', '2099-10-25T03:30:00'],
  ],
  'Europe/London': [
    ['2099-10-24T23:30:00Z', '2099-10-25T00:30:00'],
    ['2099-10-25T00:30:00Z', '2099-10-25T01:30:00 (UTC+1)'],
    ['2099-10-25T01:30:00Z', '2099-10-25T01:30:00 (UTC+0)'],
    ['2099-10-25T02:30:00Z', '2099-10-25T02:30:00'],
  ],
  'Australia/Sydney': [
    ['2099-04-04T14:30:00Z', '2099-04-05T01:30:00'],
    ['2099-04-04T15:30:00Z', '2099-04-05T02:30:00 (UTC+11)'],
    ['2099-04-04T16:30:00Z', '2099-04-05T02:30:00 (UTC+10)'],
    ['2099-04-04T17:30:00Z', '2099-04-05T03:30:00'],
  ],
  'Australia/Lord_Howe': [
    ['2099-04-04T14:15:00Z', '2099-04-05T01:15:00'],
    ['2099-04-04T14:45:00Z', '2099-04-05T01:45:00 (UTC+11)'],
    ['2099-04-04T15:15:00Z', '2099-04-05T01:45:00 (UTC+10:30)'],
    ['2099-04-04T15:45:00Z', '2099-04-05T02:15:00'],
  ],
};

// Every quarter hour from three hours before `center` to three hours after.
const SWEEP_STEP = 15 * MINUTE;
const SWEEP_REACH = 3 * HOUR;
function sweep(center) {
  const out = [];
  for (let ms = center - SWEEP_REACH; ms <= center + SWEEP_REACH; ms += SWEEP_STEP) out.push(ms);
  return out;
}

const field = (text, label) => new RegExp(`^${label}: (.*)$`, 'm').exec(String(text))?.[1] ?? null;

describe('calendar_event_read prints each pass of the repeated hour with its own offset (P1)', () => {
  for (const [tzid, rows] of Object.entries(PRINTED)) {
    it(`${tzid}: an event and an occurrence in each pass, and before and after it`, async () => {
      await asUserIn(tzid, async () => {
        for (const [utc, shown] of rows) {
          const start = Date.parse(utc);
          browser.tmCalendar = {
            getCalendarEventDetails: vi.fn(async () => ({ ok: true, id: 'evt', calendarId: 'cal1', title: 'Night shift', start, end: start + HOUR, isAllDay: false })),
          };
          const res = await read.run({ event_id: 'evt' });
          expect(field(res.results, 'start_iso'), `${tzid} ${utc}`).toBe(shown);
          const occurrence = read._testExports.formatDetailed(
            { id: 'ser', title: 'Night shift', startMs: start, endMs: start + HOUR, isOccurrence: true, recurrenceId: 'rid' }, { id: 'cal1' });
          expect(field(occurrence, 'start_iso'), `${tzid} ${utc}`).toBe(shown);
          expect(field(occurrence, 'recurrence_id'), `${tzid} ${utc}`).toBe(shown);
        }
      });
    });

    it(`${tzid}: every quarter hour of the night, the offset exactly in the repeated hour, every other time as before`, async () => {
      const change = FALL_BACK[tzid];
      await asUserIn(tzid, async () => {
        for (const ms of sweep(change.at)) {
          const repeated = ms >= change.at - change.back && ms < change.at + change.back;
          const label = ms < change.at ? change.before : change.after;
          const expected = repeated ? `${toNaiveIso(ms)} (${label})` : toNaiveIso(ms);
          const text = read._testExports.formatFromDetails({ id: 'evt', title: 'Night shift', start: ms, end: ms + SWEEP_STEP, isAllDay: false });
          expect(field(text, 'start_iso'), `${tzid} ${new Date(ms).toISOString()}`).toBe(expected);
        }
      });
    });
  }

  it('an all-day event is printed by its own date, with no offset', async () => {
    await asUserIn('America/Los_Angeles', async () => {
      const text = read._testExports.formatFromDetails({ id: 'evt', title: 'Offsite', isAllDay: true, startDay: '2099-11-01', endDay: '2099-11-02', start: Date.UTC(2099, 10, 1), end: Date.UTC(2099, 10, 2) });
      expect(field(text, 'start_iso')).toBe('2099-11-01T00:00:00');
      expect(field(text, 'end_iso')).toBe('2099-11-02T00:00:00');
    });
  });
});

describe('calendar_read lists both passes with their offsets, in the order they happen (P2)', () => {
  // Rows the calendar returns out of order; `minutes` long each.
  async function listed(tzid, day, nextDay, rows) {
    return asUserIn(tzid, async () => {
      browser.tmCalendar = {
        listCalendars: vi.fn(async () => [{ id: 'cal1', name: 'Personal' }]),
        queryCalendarItems: vi.fn(async () => rows.map(([id, startUtc, minutes]) => ({
          id, calendarId: 'cal1', title: 'Night shift', startMs: Date.parse(startUtc), endMs: Date.parse(startUtc) + minutes * MINUTE, isAllDay: false,
        })).reverse()),
      };
      listing.resetPaginationSessions();
      const res = await listing.run({ from_date: day, to_date: nextDay });
      return String(res.results).split('\n').filter((l) => l.includes('\tevent_id: '));
    });
  }

  it('Los Angeles: 01:30 before the clocks go back, then 01:30 after', async () => {
    const lines = await listed('America/Los_Angeles', '2099-11-01', '2099-11-02', [
      ['e1', '2099-11-01T07:30:00Z', 30], ['e2', '2099-11-01T08:30:00Z', 30], ['e3', '2099-11-01T09:30:00Z', 30], ['e4', '2099-11-01T10:30:00Z', 30],
    ]);
    expect(lines).toEqual([
      '00:30 (12:30 a.m.) - 01:00 (UTC-7) (1 a.m.): Night shift\tevent_id: e1',
      '01:30 (UTC-7) (1:30 a.m.) - 01:00 (UTC-8) (1 a.m.): Night shift\tevent_id: e2',
      '01:30 (UTC-8) (1:30 a.m.) - 02:00 (2 a.m.): Night shift\tevent_id: e3',
      '02:30 (2:30 a.m.) - 03:00 (3 a.m.): Night shift\tevent_id: e4',
    ]);
  });

  it('Berlin: the first pass (UTC+2) is listed before the second (UTC+1)', async () => {
    const lines = await listed('Europe/Berlin', '2099-10-25', '2099-10-26', [
      ['b1', '2099-10-25T00:30:00Z', 60], ['b2', '2099-10-25T01:30:00Z', 60],
    ]);
    expect(lines).toEqual([
      '02:30 (UTC+2) (2:30 a.m.) - 02:30 (UTC+1) (2:30 a.m.): Night shift\tevent_id: b1',
      '02:30 (UTC+1) (2:30 a.m.) - 03:30 (3:30 a.m.): Night shift\tevent_id: b2',
    ]);
  });

  it('an ordinary day lists as before: by time, then by line', async () => {
    const lines = await listed('America/Los_Angeles', '2099-11-03', '2099-11-04', [
      ['z', '2099-11-03T17:00:00Z', 60], ['a', '2099-11-03T17:00:00Z', 30], ['m', '2099-11-03T16:00:00Z', 60],
    ]);
    expect(lines).toEqual([
      '08:00 (8 a.m.) - 09:00 (9 a.m.): Night shift\tevent_id: m',
      '09:00 (9 a.m.) - 09:30 (9:30 a.m.): Night shift\tevent_id: a',
      '09:00 (9 a.m.) - 10:00 (10 a.m.): Night shift\tevent_id: z',
    ]);
  });
});

describe('the confirmation card names the zone of the moment the offset names (P3)', () => {
  it('Los Angeles: each pass with its offset', async () => {
    await asUserIn('America/Los_Angeles', async () => {
      expect(formatCardTime('2099-11-01T01:30:00 (UTC-7)')).toBe('Sunday 2099/11/01 01:30:00 PT (UTC-7)');
      expect(formatCardTime('2099-11-01T01:30:00 (UTC-8)')).toBe('Sunday 2099/11/01 01:30:00 PT (UTC-8)');
    });
  });

  it('Berlin: the zone name agrees with the offset in each pass', async () => {
    await asUserIn('Europe/Berlin', async () => {
      expect(formatCardTime('2099-10-25T02:30:00 (UTC+2)')).toBe('Sunday 2099/10/25 02:30:00 GMT+2 (UTC+2)');
      expect(formatCardTime('2099-10-25T02:30:00 (UTC+1)')).toBe('Sunday 2099/10/25 02:30:00 GMT+1 (UTC+1)');
    });
  });

  it('a time with no offset is printed as before', async () => {
    await asUserIn('Europe/Berlin', async () => {
      expect(formatCardTime('2099-10-26T09:00:00')).toBe('Monday 2099/10/26 09:00:00 GMT+1');
    });
  });
});

// The bridge's own printer, loaded from its source, with the user in `tzid`.
const BRIDGE = fileURLToPath(new URL('../chat/experiments/tmCalendar/tmCalendar.sys.mjs', import.meta.url));
function bridgePrinter(tzid) {
  const tzService = { UTC, floating: FLOATING, defaultTimezone: zone(tzid), getTimezone: (id) => (id === 'UTC' ? UTC : zone(id)) };
  return experimentFunctions(BRIDGE, ['shownIso', 'shownNaiveIso', 'momentsOnUserClock', 'utcOffsetLabel', 'asShown', 'allDayNaiveIso', 'toDayString', 'pad2', 'parseShownIso'], {
    getTimezoneService: () => tzService,
  });
}
const utcValueAt = (ms) => {
  const d = new Date(ms);
  return at('UTC', d.toISOString().slice(0, 10), d.getUTCHours(), d.getUTCMinutes());
};
// The offset labels of the three zones Thunderbird's dates are set up for,
// written by hand (minutes east of UTC).
const LABEL = { '-480': 'UTC-8', '-420': 'UTC-7', 600: 'UTC+10', 630: 'UTC+10:30', 660: 'UTC+11' };
// Each zone's spring change, when the clocks skip and nothing repeats.
const SPRING = {
  'America/Los_Angeles': Date.UTC(2099, 2, 8, 10),
  'Australia/Sydney': Date.UTC(2099, 9, 3, 16),
  'Australia/Lord_Howe': Date.UTC(2099, 9, 3, 15, 30),
};

describe('the calendar bridge prints every instant as the tools do (P4)', () => {
  for (const tzid of Object.keys(SPRING)) {
    it(`${tzid}: the fall-back night, judged by the offset table`, async () => {
      const { toShownIso } = await import('../chat/modules/repeatedHour.js');
      await asUserIn(tzid, async () => {
        const { shownIso } = bridgePrinter(tzid);
        for (const ms of sweep(FALL_BACK[tzid].at)) {
          const clock = clockAt(tzid, ms);
          const expected = instantsOf(tzid, clock).length === 2 ? `${clock} (${LABEL[offsetAt(tzid, ms)]})` : clock;
          const when = `${tzid} ${new Date(ms).toISOString()}`;
          expect(toShownIso(ms), when).toBe(expected);
          expect(shownIso(utcValueAt(ms)), when).toBe(expected);
        }
      });
    });

    it(`${tzid}: the spring night prints no offset`, async () => {
      const { toShownIso } = await import('../chat/modules/repeatedHour.js');
      await asUserIn(tzid, async () => {
        const { shownIso } = bridgePrinter(tzid);
        for (const ms of sweep(SPRING[tzid])) {
          const when = `${tzid} ${new Date(ms).toISOString()}`;
          expect(toShownIso(ms), when).toBe(clockAt(tzid, ms));
          expect(shownIso(utcValueAt(ms)), when).toBe(clockAt(tzid, ms));
        }
      });
    });
  }

  it('a value in the event\'s own zone and a floating one print as the read tools print them', async () => {
    await asUserIn('America/Los_Angeles', async () => {
      const { shownIso } = bridgePrinter('America/Los_Angeles');
      // Thunderbird reads 01:30 in Los Angeles that night as the second pass.
      expect(shownIso(at('America/Los_Angeles', '2099-11-01', 1, 30))).toBe('2099-11-01T01:30:00 (UTC-8)');
      expect(shownIso(at('floating', '2099-11-01', 1, 30))).toBe('2099-11-01T01:30:00 (UTC-8)');
      expect(shownIso(at('America/Los_Angeles', '2099-11-01', 2, 30))).toBe('2099-11-01T02:30:00');
      const date = new NativeDateTime();
      date.resetTo(2099, 10, 1, 0, 0, 0, FLOATING);
      date.isDate = true;
      expect(shownIso(date)).toBe('2099-11-01T00:00:00');
    });
  });
});

describe('the printed form is read back only as written (P5)', () => {
  // A value, its canonical printed form, and the moment it names.
  const ACCEPTED = [
    ['2099-11-01T01:30:00 (UTC-4)', '2099-11-01T01:30:00 (UTC-4)', Date.UTC(2099, 10, 1, 5, 30)],
    ['2099-11-01T01:30 (UTC-4)', '2099-11-01T01:30:00 (UTC-4)', Date.UTC(2099, 10, 1, 5, 30)],
    ['2099-10-25T01:30:00 (UTC+0)', '2099-10-25T01:30:00 (UTC+0)', Date.UTC(2099, 9, 25, 1, 30)],
    ['2099-04-05T01:45:00 (UTC+10:30)', '2099-04-05T01:45:00 (UTC+10:30)', Date.UTC(2099, 3, 4, 15, 15)],
    ['2099-04-05T01:45 (UTC+10:30)', '2099-04-05T01:45:00 (UTC+10:30)', Date.UTC(2099, 3, 4, 15, 15)],
    ['2099-11-01T01:30:00(UTC-7)', '2099-11-01T01:30:00 (UTC-7)', Date.UTC(2099, 10, 1, 8, 30)],
  ];
  const REFUSED = [
    '2099-11-01T01:30:00 (UTC-07:00)',
    '2099-11-01T01:30:00 (PDT)',
    '2099-11-01T01:30:00 (UTC+15)',
    '2099-11-01T01:30:00 (UTC-14:30)',
    '2099-02-30T01:30:00 (UTC-8)',
    '2099-11-01T24:30:00 (UTC-8)',
    '2099-11-01 01:30:00 (UTC-7)',
    '2099-11-01T01:30:00 (UTC-7) (UTC-8)',
  ];

  it('the edit tool takes each accepted value in its printed form, as recurrence_id, start_iso and end_iso', () => {
    for (const [value, canonical] of ACCEPTED) {
      const norm = editExports.normalizeArgs({ recurrence_id: value, start_iso: value, end_iso: value, timezone: 'Asia/Tokyo' });
      expect([norm.recurrence_id, norm.start_iso, norm.end_iso], value).toEqual([canonical, canonical, canonical]);
    }
  });

  it('the edit tool reads no other value in parentheses', () => {
    for (const value of REFUSED) {
      const norm = editExports.normalizeArgs({ recurrence_id: value, start_iso: value, end_iso: value });
      expect([norm.recurrence_id, norm.start_iso, norm.end_iso], value).toEqual([null, null, null]);
      expect(toNaiveIso(value), value).toBeNull();
    }
  });

  it('a value with a numeric offset keeps today\'s reading: its digits', () => {
    expect(editExports.normalizeArgs({ recurrence_id: '2099-11-01T01:30:00-07:00' }).recurrence_id).toBe('2099-11-01T01:30:00');
  });

  it('the tool layer and the bridge read each value to the same moment, or both refuse it', async () => {
    const { parseShownIso } = await import('../chat/modules/repeatedHour.js');
    const bridge = bridgePrinter('America/Los_Angeles');
    for (const [value, canonical, ms] of ACCEPTED) {
      const shown = parseShownIso(value);
      expect(shown?.ms, value).toBe(ms);
      expect(shown?.digits, value).toBe(canonical.slice(0, 19));
      expect(bridge.parseShownIso(value), value).toEqual(shown);
    }
    for (const value of [...REFUSED, '2099-11-01T01:30:00', '2099-11-01T01:30:00-07:00', '']) {
      expect(parseShownIso(value), value).toBeNull();
      expect(bridge.parseShownIso(value), value).toBeNull();
    }
  });

  it('no value, a value that is not a time, or no moment names nothing and prints no offset', async () => {
    const { parseShownIso, instantsOnClock, repeatedHourOffset } = await import('../chat/modules/repeatedHour.js');
    expect(parseShownIso(undefined)).toBeNull();
    expect(parseShownIso(null)).toBeNull();
    expect(instantsOnClock('2099-11-01T01:30')).toEqual([]);
    expect(instantsOnClock('next tuesday')).toEqual([]);
    expect(repeatedHourOffset(NaN)).toBeNull();
    expect(repeatedHourOffset(undefined)).toBeNull();
  });
});
