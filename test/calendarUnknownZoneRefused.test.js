/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarUnknownZoneRefused.test.js: a `timezone` the caller names is used or
// refused, never replaced. A create or an edit (whole event, one occurrence,
// this and following, and the edit tool's check before its card) that names a
// zone Thunderbird does not know fails with an error naming that zone, and
// nothing is saved; before, its times were read in the user's own zone and
// saved there. A known zone, and no zone at all, behave as before. Run through
// the real bridge, west of UTC, with the calendar knowing one other zone, so a
// refusal is about the zone named and not about zones in general.

// West of UTC, so the user's zone is not UTC.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');
const CAL_UTILS = 'resource:///modules/calendar/calUtils.sys.mjs';

const {
  loadCalendarBridge, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem, fixedZone, LOCAL_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');

// A far-future event (2099 is the dated-test exception: it never goes stale).
const EAST = fixedZone('Test/East+0900', 9 * 60);
const UNKNOWN = 'Test/Nowhere';
const NEW_START = '2099-10-05T09:00:00';
const NEW_END = '2099-10-05T10:00:00';
// 09:00 at +09:00 is midnight UTC; 09:00 for the user is 09:00 in their zone.
const IN_EAST_MS = Date.UTC(2099, 9, 5, 0, 0, 0);
const IN_USER_ZONE_MS = new Date(2099, 9, 5, 9, 0, 0).getTime();

const oneOff = () => fakeEvent({ id: 'ev', title: 'Sync', startDate: fakeDateTime('2099-10-01', 17), endDate: fakeDateTime('2099-10-01', 18) });
function series() {
  const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: fakeDateTime('2099-10-01', 17), endDate: fakeDateTime('2099-10-01', 18) });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=10')]);
  ev.recurrenceInfo.item = ev;
  return ev;
}

// The calendar knows EAST and no other zone.
function load(items = []) {
  const loaded = loadCalendarBridge(bridgeUrl, { items });
  const { cal } = loaded.ctx.ChromeUtils.importESModule(CAL_UTILS);
  cal.timezoneService.getTimezone = (tzid) => (tzid === EAST.tzid ? EAST : null);
  return loaded;
}
const ms = (dt) => dt.nativeTime / 1000;
const ruleValues = (item) => item.recurrenceInfo.getRecurrenceItems().map((r) => r.icalProperty.value);

function expectRefusedByName(res) {
  expect(res.ok).toBe(false);
  expect(String(res.error)).toContain(`"${UNKNOWN}"`);
}

describe('an unknown zone is refused by name, and nothing is saved', () => {
  it('create', async () => {
    const { api, calendar } = load();
    const res = await api.createCalendarEvent({ calendar_id: 'cal1', title: 'Call', start_iso: NEW_START, end_iso: NEW_END, timezone: UNKNOWN });
    expectRefusedByName(res);
    expect(calendar.items).toHaveLength(0);
  });

  it('edit of a whole event, new start and end', async () => {
    const { api, calendar, modifications } = load([oneOff()]);
    const res = await api.modifyCalendarEvent({ event_id: 'ev', calendar_id: 'cal1', start_iso: NEW_START, end_iso: NEW_END, timezone: UNKNOWN });
    expectRefusedByName(res);
    expect(modifications).toHaveLength(0);
    expect(calendar.items[0].startDate.toString()).toBe('20991001T170000');
  });

  it('edit of a whole event, new end alone', async () => {
    const { api, modifications } = load([oneOff()]);
    const res = await api.modifyCalendarEvent({ event_id: 'ev', calendar_id: 'cal1', end_iso: NEW_END, timezone: UNKNOWN });
    expectRefusedByName(res);
    expect(modifications).toHaveLength(0);
  });

  it('the edit tool\'s check before its card (check_only)', async () => {
    const { api, modifications } = load([oneOff()]);
    const res = await api.modifyCalendarEvent({ event_id: 'ev', calendar_id: 'cal1', start_iso: NEW_START, timezone: UNKNOWN, check_only: true });
    expectRefusedByName(res);
    expect(modifications).toHaveLength(0);
  });

  it('edit of one occurrence (this_only)', async () => {
    const { api, calendar, modifications } = load([series()]);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: '2099-10-03T17:00:00', start_iso: NEW_START, timezone: UNKNOWN });
    expectRefusedByName(res);
    expect(modifications).toHaveLength(0);
    expect(calendar.items[0].recurrenceInfo.getExceptionIds()).toHaveLength(0);
  });

  it('edit of this and the following occurrences (split)', async () => {
    const { api, calendar, modifications } = load([series()]);
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: '2099-10-03T17:00:00', start_iso: '2099-10-03T09:00:00', timezone: UNKNOWN });
    expectRefusedByName(res);
    expect(modifications).toHaveLength(0);
    expect(calendar.items).toHaveLength(1);
    expect(ruleValues(calendar.items[0])).toEqual(['FREQ=DAILY;COUNT=10']);
  });

  it('create naming "floating": Thunderbird\'s floating zone is not a time zone, so it is refused', async () => {
    const { api, calendar, ctx } = load();
    const { cal } = ctx.ChromeUtils.importESModule(CAL_UTILS);
    const FLOATING = fixedZone('floating', 0);
    cal.timezoneService.getTimezone = (tzid) => (tzid === EAST.tzid ? EAST : tzid === 'floating' ? FLOATING : null);
    const res = await api.createCalendarEvent({ calendar_id: 'cal1', title: 'Call', start_iso: NEW_START, end_iso: NEW_END, timezone: 'floating' });
    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain('"floating"');
    expect(calendar.items).toHaveLength(0);
  });
});

describe('a known zone, and no zone, behave as before', () => {
  it('create in a known zone: its times are that zone\'s', async () => {
    const { api, calendar } = load();
    const res = await api.createCalendarEvent({ calendar_id: 'cal1', title: 'Call', start_iso: NEW_START, end_iso: NEW_END, timezone: EAST.tzid });
    expect(res, res.error).toMatchObject({ ok: true });
    const [item] = calendar.items;
    expect(item.startDate.timezone).toBe(EAST);
    expect(ms(item.startDate)).toBe(IN_EAST_MS);
  });

  it('create with no zone: its times are the user\'s', async () => {
    const { api, calendar } = load();
    const res = await api.createCalendarEvent({ calendar_id: 'cal1', title: 'Call', start_iso: NEW_START, end_iso: NEW_END });
    expect(res, res.error).toMatchObject({ ok: true });
    const [item] = calendar.items;
    expect(item.startDate.timezone).toBe(LOCAL_ZONE);
    expect(ms(item.startDate)).toBe(IN_USER_ZONE_MS);
  });

  it('edit in a known zone: the new start is that instant', async () => {
    const { api, calendar } = load([oneOff()]);
    const res = await api.modifyCalendarEvent({ event_id: 'ev', calendar_id: 'cal1', start_iso: NEW_START, timezone: EAST.tzid });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(ms(calendar.items[0].startDate)).toBe(IN_EAST_MS);
  });

  it('edit with no zone: the new start is read in the user\'s zone', async () => {
    const { api, calendar } = load([oneOff()]);
    const res = await api.modifyCalendarEvent({ event_id: 'ev', calendar_id: 'cal1', start_iso: NEW_START });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(ms(calendar.items[0].startDate)).toBe(IN_USER_ZONE_MS);
  });
});
