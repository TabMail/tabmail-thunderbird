/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarDayHeaderDateLine.test.js — the calendar listing's day header
// (calendar_search, and calendar_read through it) names the day it groups, in
// every zone, on both sides of the date line. The day key is already the
// user's local calendar day; the header is that date, iOS's
// "EEEE, MMMM d, yyyy". Before, the header formatted noon UTC of the key in
// the user's zone, which at UTC+12 and later is already the next day: a
// Thursday's events were listed under "Friday".

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    msPerDay: 86400000,
  },
}));

vi.mock('../chat/modules/helpers.js', () => ({
  toIsoNoMs: (d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
}));

globalThis.browser = {
  tmCalendar: {
    listCalendars: vi.fn(async () => [{ id: 'cal-1', name: 'Home' }]),
    queryCalendarItems: vi.fn(async () => []),
  },
};

const calendarSearch = await import('../chat/tools/calendar_search.js');
const { formatDayHeader } = calendarSearch._testExports;

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');

/** "Thursday, November 12, 2099" from a day's digits, never through Intl. */
function englishDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** A day `offset` days from today, as `YYYY-MM-DD` from the local clock. */
function dayKeyFromToday(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// At or east of UTC+12 (Chatham +12:45/+13:45, Kiritimati +14), then just
// west of the date line (Honolulu -10, Pago Pago -11) so the fix does not move
// the error west, and three ordinary zones.
const EAST_OF_UTC12 = ['Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Fiji', 'Pacific/Tongatapu', 'Pacific/Kiritimati', 'Asia/Kamchatka'];
const OTHER_ZONES = ['Pacific/Honolulu', 'Pacific/Pago_Pago', 'UTC', 'America/Los_Angeles', 'Australia/Sydney'];

describe('calendar_search day header names the day key in every zone', () => {
  it.each([...EAST_OF_UTC12, ...OTHER_ZONES])('2099-11-12 in %s is "Thursday, November 12, 2099"', (tz) => {
    const header = formatDayHeader('2099-11-12', tz);
    expect(header.prettyDate).toBe('Thursday, November 12, 2099');
    expect(header.timezone).toBe(tz);
  });

  it.each([...EAST_OF_UTC12, ...OTHER_ZONES])('every day of the coming year in %s', (tz) => {
    for (let offset = 0; offset < 366; offset += 1) {
      const dayKey = dayKeyFromToday(offset);
      expect(formatDayHeader(dayKey, tz).prettyDate).toBe(englishDay(dayKey));
    }
  });
});

describe('calendar_search run() lists a day under its own date east of UTC+12', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browser.tmCalendar.queryCalendarItems.mockReset();
    calendarSearch.resetPaginationSessions();
  });

  it.each(['Pacific/Kiritimati', 'Pacific/Auckland'])('a timed and an all-day event on 2099-11-12 in %s', async (timezone) => {
    // 10:00 on 2099-11-12 in the zone: the instant whose wall clock there reads so.
    const wallAsUtc = Date.UTC(2099, 10, 12, 10, 0, 0);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
    }).formatToParts(new Date(wallAsUtc));
    const get = (type) => Number(parts.find((p) => p.type === type).value);
    const offsetMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - wallAsUtc;
    const startMs = wallAsUtc - offsetMs;

    browser.tmCalendar.queryCalendarItems.mockResolvedValueOnce([
      { id: 'ev-timed', calendarId: 'cal-1', title: 'Planning review', isAllDay: false, startMs, endMs: startMs + 3600000 },
      { id: 'ev-day', calendarId: 'cal-1', title: 'Planning offsite', isAllDay: true, startDay: '2099-11-12', endDay: '2099-11-13', startMs: 0, endMs: 0 },
    ]);
    const result = await calendarSearch.run({ query: 'Planning', from_date: '2099-11-11', to_date: '2099-11-13', timezone }, {});
    expect(result.error).toBeUndefined();
    expect(result.results).toContain(`date: Thursday, November 12, 2099\ntimezone: ${timezone}\n`);
    expect(result.results).not.toContain('Friday');
    expect(result.results).toContain('All day: Planning offsite');
    expect(result.results).toContain('10:00 (10 a.m.) - 11:00 (11 a.m.): Planning review');
  });
});

describe('calendar_search run() never answers an unknown time zone with a wrong listing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    browser.tmCalendar.queryCalendarItems.mockReset();
    calendarSearch.resetPaginationSessions();
  });

  it('an unknown zone is an error naming it, and a corrected retry in the same turn lists the event', async () => {
    // 10:00 on 2099-11-12 in Auckland (NZDT, UTC+13) is 21:00 UTC the day before.
    const startMs = Date.UTC(2099, 10, 11, 21, 0, 0);
    browser.tmCalendar.queryCalendarItems.mockImplementation(async () => [
      { id: 'ev-timed', calendarId: 'cal-1', title: 'Planning review', isAllDay: false, startMs, endMs: startMs + 3600000 },
    ]);
    const range = { query: 'Planning', from_date: '2099-11-11', to_date: '2099-11-13' };

    const wrong = await calendarSearch.run({ ...range, timezone: 'NZDT' }, {});
    expect(wrong.error).toBe('Unknown time zone "NZDT". Use an IANA zone such as "Pacific/Auckland".');
    expect(wrong.results).toBeUndefined();

    const retry = await calendarSearch.run({ ...range, timezone: 'Pacific/Auckland' }, {});
    expect(retry.error).toBeUndefined();
    expect(retry.results).toContain('date: Thursday, November 12, 2099\ntimezone: Pacific/Auckland\n');
    expect(retry.results).toContain('10:00 (10 a.m.) - 11:00 (11 a.m.): Planning review');
  });
});
