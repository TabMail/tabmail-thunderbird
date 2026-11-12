/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// gregorianDay.test.js — formatGregorianDay prints a date-only value (a
// "YYYY-MM-DD" calendar day, which has no zone and no instant) as that same
// day, in English and the Gregorian calendar, whatever zone the caller is in
// and whatever zone the process runs in. A date-only value turned into an
// instant and formatted in a zone names the next day at UTC+12 and later, or
// the previous day west of UTC.

import { afterEach, describe, expect, it } from 'vitest';
import { stubDefaultLocale } from './helpers/defaultLocale.js';

const gregorianDate = await import('../agent/modules/gregorianDate.js');

const LONG = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const pad2 = (n) => String(n).padStart(2, '0');

/** "Thursday, November 12, 2026" from a day's digits, never through Intl. */
function englishDay(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${weekday}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** A day `offset` days from today, as `YYYY-MM-DD` from the UTC clock. */
function dayKeyFromToday(offset) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// Process zones from far west to far east of UTC, both sides of the date line.
const HOST_ZONES = ['Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Los_Angeles', 'UTC', 'Australia/Sydney', 'Pacific/Auckland', 'Pacific/Kiritimati'];

describe('formatGregorianDay', () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('is exported from gregorianDate.js', () => {
    expect(typeof gregorianDate.formatGregorianDay).toBe('function');
  });

  it('prints the day it is given, in the fields asked for', () => {
    const { formatGregorianDay } = gregorianDate;
    expect(formatGregorianDay('2026-11-12', LONG)).toBe('Thursday, November 12, 2026');
    expect(formatGregorianDay('2026-11-12', { year: 'numeric', month: 'numeric', day: 'numeric' })).toBe('11/12/2026');
    expect(formatGregorianDay('2026-11-12', { weekday: 'short', month: 'short', day: 'numeric' })).toBe('Thu, Nov 12');
    expect(formatGregorianDay('2028-02-29', LONG)).toBe('Tuesday, February 29, 2028');
    expect(formatGregorianDay('2099-12-31', LONG)).toBe('Thursday, December 31, 2099');
    expect(formatGregorianDay('2100-01-01', LONG)).toBe('Friday, January 1, 2100');
  });

  it.each(['Pacific/Kiritimati', 'Pacific/Auckland', 'Pacific/Chatham', 'Pacific/Pago_Pago', 'Pacific/Honolulu', 'America/Los_Angeles'])(
    'a timeZone among the options does not move the day (%s)',
    (timeZone) => {
      expect(gregorianDate.formatGregorianDay('2026-11-12', { ...LONG, timeZone })).toBe('Thursday, November 12, 2026');
    },
  );

  it.each(HOST_ZONES)('the process zone does not move the day (TZ=%s)', (tz) => {
    process.env.TZ = tz;
    expect(gregorianDate.formatGregorianDay('2026-11-12', LONG)).toBe('Thursday, November 12, 2026');
    for (let offset = 0; offset < 366; offset += 1) {
      const dayKey = dayKeyFromToday(offset);
      expect(gregorianDate.formatGregorianDay(dayKey, LONG)).toBe(englishDay(dayKey));
    }
  });

  it.each(['th', 'fa'])('a non-Gregorian default locale does not change it (%s)', (locale) => {
    const restore = stubDefaultLocale(locale);
    try {
      expect(gregorianDate.formatGregorianDay('2026-11-12', LONG)).toBe('Thursday, November 12, 2026');
    } finally {
      restore();
    }
  });
});
