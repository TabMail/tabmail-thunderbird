/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesTimePrimitives.test.js: the calendar bridge's own time
// primitives, run on Thunderbird's own date and length code
// (test/fixtures/mozilla) and judged by an offset table written without it
// (helpers/zoneOffsetTable.js), around both 2099 clock changes of a zone west
// of UTC, one east of it, and one whose clocks move by 30 minutes:
//   - afterElapsed(start, W): the value Thunderbird reads W seconds after the
//     start, or null when no value is read there (the first pass of the hour
//     the clocks repeat, which ical.js reads as the second);
//   - atInstantInFrameOf(anchor, target): the target's instant in the
//     anchor's zone, or null for the same first pass;
//   - intoFrameOf: refuses digits the given zone skips, and nothing else;
//   - shownNaiveIso: prints a stored time exactly as the read tools do;
//   - applyNewLength: a changed occurrence takes W by the clock, which is how
//     Thunderbird builds a plain occurrence from the series' stored length.
// The functions are the bridge's own, loaded from its source.

process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/context.js', () => ({ ctx: {} }));
vi.mock('../chat/modules/markdown.js', () => ({ attachSpecialLinkListeners: vi.fn(), renderMarkdown: vi.fn() }));

const { experimentFunctions } = await import('./helpers/experimentFunctions.js');
const { at, dateOn, digits, zone, UTC, FLOATING, NativeDateTime, NativeDuration } = await import('./helpers/nativeCalendarDates.js');
const { fakeEvent, fakeRecurrenceInfo, recurrenceItem } = await import('./helpers/calendarBridgeHarness.js');
const { offsetAt, clockAt, instantsOf, isSkipped, inFirstPass, intlOffsetAt, HOUR, MINUTE } = await import('./helpers/zoneOffsetTable.js');
const { toNaiveIso } = await import('../chat/modules/helpers.js');

// The sweeps run thousands of rows through Thunderbird's own date code.
const SWEEP_TIMEOUT_MS = 120_000;

const BRIDGE = fileURLToPath(new URL('../chat/experiments/tmCalendar/tmCalendar.sys.mjs', import.meta.url));

// The bridge's functions, with the user in `userTzid` (Thunderbird's zone).
function primitives(userTzid, names = [
  'durationOf', 'clockSeconds', 'afterElapsed', 'atInstantInFrameOf', 'intoFrameOf', 'asShown',
  'shownNaiveIso', 'toDayString', 'allDayNaiveIso', 'applyNewLength', 'digitsOf', 'skippedTimeError',
  'repeatedHourError', 'pad2',
]) {
  const tzService = {
    UTC, floating: FLOATING, defaultTimezone: zone(userTzid),
    getTimezone: (tzid) => (tzid === 'UTC' ? UTC : zone(tzid)),
  };
  return experimentFunctions(BRIDGE, names, {
    Cc: {
      '@mozilla.org/calendar/duration;1': { createInstance: () => new NativeDuration() },
      '@mozilla.org/calendar/datetime;1': { createInstance: () => new NativeDateTime() },
    },
    Ci: { calIDuration: {}, calIDateTime: {} },
    getTimezoneService: () => tzService,
  });
}

// Each zone's two changes: the UTC instant, and digits inside the hour the
// clocks skip or repeat that night.
const CHANGES = {
  'America/Los_Angeles': [
    { name: 'spring', at: Date.UTC(2099, 2, 8, 10), inside: '2099-03-08T02:30:00' },
    { name: 'autumn', at: Date.UTC(2099, 10, 1, 9), inside: '2099-11-01T01:30:00' },
  ],
  'Australia/Sydney': [
    { name: 'autumn', at: Date.UTC(2099, 3, 4, 16), inside: '2099-04-05T02:30:00' },
    { name: 'spring', at: Date.UTC(2099, 9, 3, 16), inside: '2099-10-04T02:30:00' },
  ],
  'Australia/Lord_Howe': [
    { name: 'autumn', at: Date.UTC(2099, 3, 4, 15), inside: '2099-04-05T01:45:00' },
    { name: 'spring', at: Date.UTC(2099, 9, 3, 15, 30), inside: '2099-10-04T02:15:00' },
  ],
};
const OTHER_ZONE = { 'America/Los_Angeles': 'Australia/Sydney', 'Australia/Sydney': 'America/Los_Angeles', 'Australia/Lord_Howe': 'America/Los_Angeles' };

/** Thunderbird's value at `digits` ("YYYY-MM-DDTHH:MM:SS") in `tzid`. */
function valueAt(tzid, iso) {
  const [day, time] = iso.split('T');
  const [h, m, s] = time.split(':').map(Number);
  return at(tzid, day, h, m, s);
}
const instantOf = (dt) => dt.nativeTime / 1000;
/** The UTC instants from `from` to `to` (inclusive) every `step` ms. */
function* instants(from, to, step) { for (let ms = from; ms <= to; ms += step) yield ms; }

describe('the offset table the sweeps are judged by', () => {
  it('agrees with the system zone data (Intl) on every 15 minutes of 2099 near each change, west and east', () => {
    let rows = 0;
    for (const tzid of ['America/Los_Angeles', 'Australia/Sydney']) {
      for (const change of CHANGES[tzid]) {
        for (const ms of instants(change.at - 72 * HOUR, change.at + 72 * HOUR, 15 * MINUTE)) {
          expect(offsetAt(tzid, ms), `${tzid} ${new Date(ms).toISOString()}`).toBe(intlOffsetAt(tzid, ms));
          rows += 1;
        }
      }
    }
    expect(rows).toBe(4 * 577);
  });

  it('reads Thunderbird\'s own zones: each value outside the first pass of a repeated hour is at the instant the table gives', () => {
    for (const tzid of Object.keys(CHANGES)) {
      for (const change of CHANGES[tzid]) {
        for (const ms of instants(change.at - 72 * HOUR, change.at + 72 * HOUR, 15 * MINUTE)) {
          if (inFirstPass(tzid, ms)) continue;
          expect(instantOf(valueAt(tzid, clockAt(tzid, ms))), `${tzid} ${clockAt(tzid, ms)}`).toBe(ms);
        }
      }
    }
  }, SWEEP_TIMEOUT_MS);
});

describe('afterElapsed and atInstantInFrameOf on Thunderbird\'s own dates', () => {
  // Loaded when a test first uses it, so a missing function fails that test.
  let loaded = null;
  const p = new Proxy({}, { get: (_t, name) => (loaded ??= primitives('America/Los_Angeles'))[name] });

  it('afterElapsed reads back exactly W on every start and length of the sweep, null only in the repeated hour\'s first pass', () => {
    let rows = 0, nulls = 0;
    for (const tzid of Object.keys(CHANGES)) {
      for (const change of CHANGES[tzid]) {
        for (const startMs of instants(change.at - 48 * HOUR, change.at + 48 * HOUR, 30 * MINUTE)) {
          if (inFirstPass(tzid, startMs)) continue;
          const start = valueAt(tzid, clockAt(tzid, startMs));
          for (let w = 30 * 60; w <= 49 * 3600; w += 30 * 60) {
            const out = p.afterElapsed(start, w);
            const target = startMs + w * 1000;
            const where = `${tzid} from ${clockAt(tzid, startMs)} + ${w / 3600} h`;
            rows += 1;
            if (inFirstPass(tzid, target)) {
              expect(out, where).toBeNull();
              nulls += 1;
              continue;
            }
            expect(out, where).not.toBeNull();
            expect(digits(out), where).toBe(clockAt(tzid, target));
            expect(out.subtractDate(start).inSeconds, where).toBe(w);
            expect(out.timezone.tzid, where).toBe(tzid);
          }
        }
      }
    }
    expect(rows).toBeGreaterThan(100000);
    expect(nulls).toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);

  it('atInstantInFrameOf gives the offset table\'s digits on every row, null only in the repeated hour\'s first pass', () => {
    let rows = 0, nulls = 0;
    for (const tzid of Object.keys(CHANGES)) {
      for (const change of CHANGES[tzid]) {
        const day = (n) => clockAt(tzid, change.at + n * 24 * HOUR).slice(0, 10);
        // Before, after, on the change's day, inside its skipped or repeated hour.
        const anchors = [`${day(-30)}T09:00:00`, `${day(-3)}T09:00:00`, `${day(-1)}T23:30:00`, `${change.inside.slice(0, 10)}T00:00:00`,
          change.inside, `${day(1)}T03:00:00`, `${day(3)}T09:00:00`, `${day(30)}T09:00:00`];
        for (const anchorIso of anchors) {
          const anchor = valueAt(tzid, anchorIso);
          for (const ms of instants(change.at - 72 * HOUR, change.at + 72 * HOUR, 15 * MINUTE)) {
            for (const held of ['UTC', OTHER_ZONE[tzid]]) {
              const target = valueAt(held, held === 'UTC' ? new Date(ms).toISOString().slice(0, 19) : clockAt(held, ms));
              if (held !== 'UTC' && inFirstPass(held, ms)) continue;
              const out = p.atInstantInFrameOf(anchor, target);
              const where = `${tzid} anchor ${anchorIso}, target ${new Date(ms).toISOString()} held in ${held}`;
              rows += 1;
              if (inFirstPass(tzid, ms)) {
                expect(out, where).toBeNull();
                nulls += 1;
                continue;
              }
              expect(out, where).not.toBeNull();
              expect(digits(out), where).toBe(clockAt(tzid, ms));
              expect(out.timezone.tzid, where).toBe(tzid);
            }
          }
        }
      }
    }
    expect(rows).toBeGreaterThan(50000);
    expect(nulls).toBeGreaterThan(0);
  }, SWEEP_TIMEOUT_MS);

  it('in UTC and floating, afterElapsed is the plain clock add', () => {
    let rows = 0;
    for (const tzid of ['UTC', 'floating']) {
      for (const change of CHANGES['America/Los_Angeles']) {
        for (const ms of instants(change.at - 24 * HOUR, change.at + 24 * HOUR, HOUR)) {
          const iso = new Date(ms).toISOString().slice(0, 19);
          for (let w = 30 * 60; w <= 49 * 3600; w += 90 * 60) {
            const out = p.afterElapsed(valueAt(tzid, iso), w);
            expect(digits(out), `${tzid} ${iso} + ${w}`).toBe(new Date(ms + w * 1000).toISOString().slice(0, 19));
            expect(out.timezone.tzid).toBe(tzid);
            rows += 1;
          }
        }
      }
    }
    expect(rows).toBeGreaterThan(3000);
  });

  it('all-day lengths are whole days by digits', () => {
    let rows = 0;
    const days = ['2099-03-06', '2099-03-07', '2099-03-08', '2099-04-04', '2099-10-03', '2099-10-31', '2099-11-01'];
    for (const first of days) {
      for (const n of [1, 2, 3]) {
        const d = new Date(`${first}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() + n);
        const last = d.toISOString().slice(0, 10);
        // A plain DATE (as the edit path writes one, asAllDayItem): the length
        // is n days by digits, and afterElapsed gives the day n days on.
        expect(p.clockSeconds(dateOn(last), dateOn(first)), `${first} + ${n}`).toBe(n * 86400);
        const out = p.afterElapsed(dateOn(first), n * 86400);
        expect(digits(out), `${first} + ${n}`).toBe(`${last}T00:00:00`);
        expect(out.isDate).toBe(true);
        // A DATE in a zone across a change: digits, never the elapsed time.
        for (const tzid of ['America/Los_Angeles', 'Australia/Sydney']) {
          expect(p.clockSeconds(dateOn(last, tzid), dateOn(first, tzid)), `${tzid} ${first} + ${n}`).toBe(n * 86400);
        }
        rows += 1;
      }
    }
    expect(rows).toBeGreaterThanOrEqual(20);
  });
});

describe('intoFrameOf', () => {
  it('refuses exactly the digits the given zone skips, with the time and the zone', () => {
    const p = primitives('America/Los_Angeles');
    let typed = 0, skipped = 0;
    for (const tzid of Object.keys(CHANGES)) {
      for (const change of CHANGES[tzid]) {
        const day = change.inside.slice(0, 10);
        for (let minute = 0; minute < 24 * 60; minute += 15) {
          const iso = `${day}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`;
          const given = valueAt(tzid, iso);
          // A series stored in UTC: every instant has a UTC value, so only
          // the skipped check can refuse.
          const anchor = valueAt('UTC', '2099-01-05T18:00:00');
          typed += 1;
          if (isSkipped(tzid, iso)) {
            skipped += 1;
            expect(() => p.intoFrameOf(anchor, given), `${tzid} ${iso}`).toThrow(`${iso} does not exist in ${tzid}: the clocks skip that time that day; ask the user for another time`);
          } else {
            const out = p.intoFrameOf(anchor, given);
            expect(out.timezone.tzid, `${tzid} ${iso}`).toBe('UTC');
            expect(instantOf(out), `${tzid} ${iso}`).toBe(instantsOf(tzid, iso).at(-1));
          }
        }
      }
    }
    expect(typed).toBe(576);
    expect(skipped).toBe(10);
  });
});

describe('shownNaiveIso', () => {
  for (const userTzid of ['America/Los_Angeles', 'Australia/Sydney']) {
    it(`prints what toNaiveIso prints, the user in ${userTzid}`, () => {
      const was = process.env.TZ;
      process.env.TZ = userTzid;
      try {
        const p = primitives(userTzid, ['asShown', 'shownNaiveIso', 'toDayString', 'allDayNaiveIso', 'pad2']);
        let rows = 0;
        for (const change of CHANGES[userTzid]) {
          for (const ms of instants(change.at - 72 * HOUR, change.at + 72 * HOUR, 15 * MINUTE)) {
            // The value stored in UTC, and in another zone.
            for (const stored of [valueAt('UTC', new Date(ms).toISOString().slice(0, 19)), valueAt(OTHER_ZONE[userTzid], clockAt(OTHER_ZONE[userTzid], ms))]) {
              if (instantOf(stored) !== ms) continue; // the other zone's first pass: not storable
              expect(p.shownNaiveIso(stored), `${stored.timezone.tzid} ${new Date(ms).toISOString()}`).toBe(toNaiveIso(ms));
              rows += 1;
            }
          }
        }
        expect(rows).toBeGreaterThan(2000);
      } finally {
        process.env.TZ = was;
      }
    });
  }

  it('the sweeps have power: getInTimezone lands on another instant near the changes, west and east', () => {
    const landed = {};
    for (const tzid of ['America/Los_Angeles', 'Australia/Sydney']) {
      landed[tzid] = 0;
      for (const change of CHANGES[tzid]) {
        for (const ms of instants(change.at - 72 * HOUR, change.at + 72 * HOUR, 15 * MINUTE)) {
          const v = valueAt('UTC', new Date(ms).toISOString().slice(0, 19)).getInTimezone(zone(tzid));
          if (instantOf(v) !== ms) landed[tzid] += 1;
        }
      }
    }
    expect(landed['America/Los_Angeles']).toBeGreaterThan(0);
    expect(landed['Australia/Sydney']).toBeGreaterThan(0);
  });
});

describe('applyNewLength', () => {
  it('a changed occurrence\'s own start plus W by the clock equals Thunderbird\'s plain occurrence at that start', () => {
    const p = primitives('America/Los_Angeles');
    let rows = 0;
    for (const tzid of Object.keys(CHANGES)) {
      for (const change of CHANGES[tzid]) {
        for (let w = 30 * 60; w <= 13 * 3600; w += 90 * 60) {
          // A series whose stored end Thunderbird reads as W from its start.
          const seriesStart = valueAt(tzid, `${clockAt(tzid, change.at - 30 * 24 * HOUR).slice(0, 10)}T22:00:00`);
          const series = fakeEvent({ id: 's', title: 'Series', startDate: seriesStart, endDate: p.afterElapsed(seriesStart, w) });
          const changed = [];
          for (const ms of instants(change.at - 24 * HOUR, change.at + 24 * HOUR, 30 * MINUTE)) {
            if (inFirstPass(tzid, ms)) continue;
            const own = valueAt(tzid, clockAt(tzid, ms));
            const ex = fakeEvent({ id: 's', title: 'Moved', startDate: own, endDate: own.clone(), recurrenceId: own.clone() });
            changed.push(ex);
          }
          series.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')], { exceptions: changed });
          series.recurrenceInfo.item = series;
          p.applyNewLength(series, w);
          for (const rid of series.recurrenceInfo.getExceptionIds()) {
            const ex = series.recurrenceInfo.getExceptionFor(rid);
            const plain = series.createProxy(ex.startDate);
            expect(digits(ex.endDate), `${tzid} ${digits(ex.startDate)} + ${w}`).toBe(digits(plain.endDate));
            expect(digits(ex.startDate)).toBe(digits(plain.startDate));
            rows += 1;
          }
        }
      }
    }
    expect(rows).toBeGreaterThan(1000);
  }, SWEEP_TIMEOUT_MS);
});
