/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSplitKeepsProperties.test.js: a "this and following" split makes the
// following part a copy of the series, as Thunderbird copies an event. Pinned
// here, through the real bridge:
//   - the following part keeps every property and parameter the series has, its
//     reminders, categories, attachments and organizer, and each attendee with
//     their answer and details; it gets an id of its own;
//   - the edit's fields change only what they name, and a new description
//     replaces the series' in every form;
//   - a changed attendee list keeps the series' entry for everyone still on it
//     and adds the others, who have not answered yet;
//   - the attendees' answers are kept unless the split moves the following
//     occurrences (start, end, all-day or timed, another zone, another rule) or
//     changes their location; then everyone but the organizer is asked again
//     (Thunderbird asks again on such a change; RFC 6638 3.2.8). A value the
//     split only restates changes nothing; a time relabelled into another zone
//     moves the later occurrences that zone's daylight saving time reaches;
//   - the series' organizer stays, whatever organizer_email the edit carries;
//   - the earlier part keeps its properties and attendees as they were.

// West of UTC, so the user's zone is not UTC.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

const {
  loadCalendarBridge, fakeAttendee, fakeDate, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem, fixedZone,
  seriesOccurrences, FLOATING_ZONE, UTC_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');

// A far-future series (2099 is the dated-test exception: never goes stale),
// split at its occurrence on the 15th.
const START_DAY = '2099-10-01';
const SPLIT_AT = '2099-10-15T17:00:00';
const EAST = fixedZone('Test/East+0900', 9 * 60);

const SERIES_PROPERTIES = {
  LOCATION: 'Room 4',
  DESCRIPTION: 'Agenda in the notes',
  'X-ALT-DESC': '<p>Agenda in the <b>notes</b></p>',
  'X-MOZ-HTML': 'true',
  'X-MOZ-ALT-DESC': '<p>Agenda</p>',
  STATUS: 'CONFIRMED',
  CLASS: 'PRIVATE',
  URL: 'https://example.com/meeting',
  PRIORITY: '1',
  TRANSP: 'TRANSPARENT',
  'X-MICROSOFT-CDO-BUSYSTATUS': 'OOF',
  'X-GOOGLE-CONFERENCE': 'https://example.com/join/abc',
  'X-MOZ-SEND-INVITATIONS': 'TRUE',
};
const SERIES_PARAMS = {
  DESCRIPTION: { ALTREP: 'data:text/html,%3Cp%3EAgenda%3C%2Fp%3E' },
  'X-ALT-DESC': { FMTTYPE: 'text/html' },
};
const ORGANIZER = 'mailto:Organizer@Example.com';
const copyable = (fields) => ({ ...fields, clone() { return copyable(fields); } });

function seriesAttendees() {
  return [
    // The organizer is also listed as an attendee, in another case.
    fakeAttendee({ id: 'mailto:organizer@example.com', commonName: 'Org', participationStatus: 'ACCEPTED', role: 'CHAIR', rsvp: 'FALSE' }),
    fakeAttendee({ id: 'mailto:ana@example.com', commonName: 'Ana', participationStatus: 'ACCEPTED', role: 'REQ-PARTICIPANT', rsvp: 'FALSE', userType: 'INDIVIDUAL', properties: { 'X-NUM-GUESTS': '1' } }),
    fakeAttendee({ id: 'mailto:ben@example.com', commonName: 'Ben', participationStatus: 'DECLINED', role: 'OPT-PARTICIPANT', rsvp: 'FALSE' }),
    fakeAttendee({ id: 'mailto:room@example.com', commonName: 'Room 4', participationStatus: 'TENTATIVE', role: 'NON-PARTICIPANT', userType: 'ROOM', properties: { 'SCHEDULE-AGENT': 'SERVER' } }),
  ];
}

function series({ rule = 'FREQ=DAILY', start = fakeDateTime(START_DAY, 17) } = {}) {
  const end = start.clone();
  end.addDuration(start.isDate ? { inSeconds: 86400, isNegative: false } : { inSeconds: 3600, isNegative: false });
  const ev = fakeEvent({
    id: 'ser', title: 'Sync', startDate: start, endDate: end,
    properties: SERIES_PROPERTIES, propertyParams: SERIES_PARAMS,
    attendees: seriesAttendees(),
    organizer: fakeAttendee({ id: ORGANIZER, commonName: 'Org', isOrganizer: true, properties: { 'SENT-BY': 'mailto:assistant@example.com' } }),
    alarms: [copyable({ related: 'START', offset: '-PT15M' }), copyable({ related: 'START', offset: '-P1D' })],
    categories: ['Work', 'Team'],
    attachments: [copyable({ uri: 'https://example.com/agenda.pdf', formatType: 'application/pdf' })],
  });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', rule)]);
  ev.recurrenceInfo.item = ev;
  return ev;
}

async function split(master, patch, { recurrenceId = SPLIT_AT } = {}) {
  const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
  const res = await api.splitRecurringEvent({ event_id: 'ser', calendar_id: 'cal1', recurrence_id: recurrenceId, patch });
  return {
    res,
    capped: calendar.items.find((it) => it.id === 'ser'),
    fresh: calendar.items.find((it) => it.id !== 'ser'),
  };
}

// The same split through the edit tool's bridge call, which also names the
// organizer (the edit tool fills in the calendar's own address).
async function editFollowing(master, args, { recurrenceId = SPLIT_AT } = {}) {
  const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
  const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: recurrenceId, ...args });
  return {
    res,
    capped: calendar.items.find((it) => it.id === 'ser'),
    fresh: calendar.items.find((it) => it.id !== 'ser'),
  };
}

// Everything an attendee carries: their address, name, answer and details.
const entry = (a) => ({
  id: a.id, commonName: a.commonName, participationStatus: a.participationStatus, rsvp: a.rsvp,
  role: a.role, userType: a.userType, properties: a.properties,
});
const entries = (item) => item.getAttendees().map(entry);
const SERIES_ENTRIES = seriesAttendees().map(entry);
// The series' entries with everyone but the organizer asked again.
const ASKED_AGAIN = SERIES_ENTRIES.map((e) => (e.id === 'mailto:organizer@example.com' ? e : { ...e, participationStatus: 'NEEDS-ACTION', rsvp: 'TRUE' }));

describe('the following part of a split keeps the series\' properties', () => {
  it('has every property and parameter, reminder, category, attachment, the organizer and each attendee the series has, and an id of its own', async () => {
    const { res, capped, fresh } = await split(series(), { title: 'Renamed' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(fresh.id).toBeTruthy();
    expect(fresh.id).not.toBe('ser');
    expect(res.event_id).toBe(fresh.id);
    expect(fresh.title).toBe('Renamed');
    for (const [name, value] of Object.entries(SERIES_PROPERTIES)) expect(fresh.getProperty(name), name).toBe(value);
    for (const [name, bucket] of Object.entries(SERIES_PARAMS)) {
      for (const [param, value] of Object.entries(bucket)) expect(fresh.getPropertyParameter(name, param), `${name};${param}`).toBe(value);
    }
    expect(fresh.getAlarms().map((a) => a.offset)).toEqual(['-PT15M', '-P1D']);
    expect(fresh.getCategories()).toEqual(['Work', 'Team']);
    expect(fresh.getAttachments().map((a) => a.uri)).toEqual(['https://example.com/agenda.pdf']);
    expect(entry(fresh.organizer)).toEqual(entry(capped.organizer));
    expect(fresh.organizer.properties).toEqual([['SENT-BY', 'mailto:assistant@example.com']]);
    expect(entries(fresh)).toEqual(SERIES_ENTRIES);
  });

  it('the earlier part keeps its properties and its attendees\' answers, even when the following part is moved', async () => {
    const { res, capped, fresh } = await split(series(), { start_iso: '2099-10-15T19:00:00' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(entries(fresh)).toEqual(ASKED_AGAIN);
    expect(capped.title).toBe('Sync');
    for (const [name, value] of Object.entries(SERIES_PROPERTIES)) expect(capped.getProperty(name), name).toBe(value);
    expect(entries(capped)).toEqual(SERIES_ENTRIES);
  });

  // The edit tool fills organizer_email with the calendar's own address, which
  // is not always the series' organizer (an invitation from someone else).
  for (const [label, address] of [['another address', 'me@example.com'], ['the organizer\'s address in another case', 'organizer@example.com']]) {
    it(`keeps the series' organizer with its details when the edit names ${label}, and asks again everyone but that organizer`, async () => {
      const { res, capped, fresh } = await editFollowing(series(), { organizer_email: address, start_iso: '2099-10-15T19:00:00' });
      expect(res, res.error).toMatchObject({ ok: true });
      expect(entry(fresh.organizer)).toEqual(entry(capped.organizer));
      expect(fresh.organizer.properties).toEqual([['SENT-BY', 'mailto:assistant@example.com']]);
      expect(entries(fresh)).toEqual(ASKED_AGAIN);
    });
  }

  // At an occurrence changed on its own, an edit that only excludes dates keeps
  // that occurrence as it was; the organizer the edit tool fills in is no
  // change, and the series' stays.
  it('keeps the series\' organizer on a this-and-following edit at an occurrence changed on its own that only excludes dates', async () => {
    const master = series();
    const moved = fakeEvent({ id: 'ser', title: 'Moved', startDate: fakeDateTime('2099-10-15', 19), endDate: fakeDateTime('2099-10-15', 20), recurrenceId: fakeDateTime('2099-10-15', 17) });
    master.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')], { exceptions: [moved] });
    master.recurrenceInfo.item = master;
    const { res, capped, fresh } = await editFollowing(master, { organizer_email: 'me@example.com', exdates_add: ['2099-10-20T17:00:00'] }, { recurrenceId: '2099-10-15T19:00:00' });
    expect(res, res.error).toMatchObject({ ok: true });
    const starts = seriesOccurrences(fresh, fakeDate('2099-10-01'), fakeDate('2099-11-01')).map(({ start }) => start.toString());
    expect(starts).toContain('20991015T190000');
    expect(starts).toContain('20991021T170000');
    expect(starts).not.toContain('20991020T170000');
    expect(entry(fresh.organizer)).toEqual(entry(capped.organizer));
    expect(fresh.organizer.properties).toEqual([['SENT-BY', 'mailto:assistant@example.com']]);
  });

  it('the edit\'s fields change only what they name', async () => {
    const { res, fresh } = await split(series(), { location: 'Room 9', transparency: 'busy' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(fresh.title).toBe('Sync');
    expect(fresh.getProperty('LOCATION')).toBe('Room 9');
    expect(fresh.getProperty('TRANSP')).toBe('OPAQUE');
    for (const name of ['DESCRIPTION', 'X-ALT-DESC', 'STATUS', 'CLASS', 'URL', 'X-GOOGLE-CONFERENCE']) {
      expect(fresh.getProperty(name), name).toBe(SERIES_PROPERTIES[name]);
    }
  });

  it('a new description replaces the series\' in every form, its HTML versions included', async () => {
    const { res, fresh } = await split(series(), { description: 'New agenda' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(fresh.getProperty('DESCRIPTION')).toBe('New agenda');
    expect(fresh.getPropertyParameter('DESCRIPTION', 'ALTREP')).toBeNull();
    for (const name of ['X-ALT-DESC', 'X-MOZ-HTML', 'X-MOZ-ALT-DESC']) expect(fresh.getProperty(name), name).toBeNull();
  });

  it('an empty location or description removes it', async () => {
    const { res, fresh } = await split(series(), { location: '', description: '' });
    expect(res, res.error).toMatchObject({ ok: true });
    for (const name of ['LOCATION', 'DESCRIPTION', 'X-ALT-DESC', 'X-MOZ-HTML', 'X-MOZ-ALT-DESC']) expect(fresh.getProperty(name), name).toBeNull();
    expect(fresh.getPropertyParameter('DESCRIPTION', 'ALTREP')).toBeNull();
  });
});

describe('a changed attendee list on the following part', () => {
  const CHANGE = { remove_attendees: [{ email: 'BEN@example.com' }, { email: 'room@example.com' }], add_attendees: [{ email: 'cleo@example.com', name: 'Cleo' }] };

  it('keeps the series\' entry for everyone still on it, matched without regard to case, and adds the others unanswered', async () => {
    const { res, fresh } = await split(series(), CHANGE);
    expect(res, res.error).toMatchObject({ ok: true });
    expect(entries(fresh)).toEqual([
      SERIES_ENTRIES[0],
      SERIES_ENTRIES[1],
      { id: 'mailto:cleo@example.com', commonName: 'Cleo', participationStatus: 'NEEDS-ACTION', rsvp: 'TRUE', role: undefined, userType: undefined, properties: undefined },
    ]);
  });

  it('and a moved part asks again everyone it keeps but the organizer', async () => {
    const { res, fresh } = await split(series(), { ...CHANGE, start_iso: '2099-10-15T19:00:00' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(entries(fresh).map((e) => [e.id, e.participationStatus, e.rsvp])).toEqual([
      ['mailto:organizer@example.com', 'ACCEPTED', 'FALSE'],
      ['mailto:ana@example.com', 'NEEDS-ACTION', 'TRUE'],
      ['mailto:cleo@example.com', 'NEEDS-ACTION', 'TRUE'],
    ]);
  });
});

describe('the attendees\' answers on the following part', () => {
  const KEPT = {
    'a new title': { title: 'Renamed' },
    'a new description': { description: 'New agenda' },
    'a new busy/free': { transparency: 'busy' },
    'an occurrence removed': { exdates_add: ['2099-10-20T17:00:00'] },
    'its start restated': { start_iso: SPLIT_AT },
    'its start and end restated': { start_iso: SPLIT_AT, end_iso: '2099-10-15T18:00:00' },
    'its location restated': { location: 'Room 4' },
    'its rule restated': { recurrence: { freq: 'DAILY' } },
  };
  for (const [label, patch] of Object.entries(KEPT)) {
    it(`are kept for ${label}`, async () => {
      const { res, fresh } = await split(series(), patch);
      expect(res, res.error).toMatchObject({ ok: true });
      expect(entries(fresh)).toEqual(SERIES_ENTRIES);
    });
  }

  const ASKED = {
    'a moved start': { start_iso: '2099-10-15T19:00:00' },
    'a moved end': { end_iso: '2099-10-15T19:00:00' },
    'a later end with its start restated': { start_iso: SPLIT_AT, end_iso: '2099-10-15T19:00:00' },
    'an earlier start with its end restated': { start_iso: '2099-10-15T16:30:00', end_iso: '2099-10-15T18:00:00' },
    'all-day occurrences': { all_day: true, start_iso: '2099-10-15T00:00:00', end_iso: '2099-10-16T00:00:00' },
    'another rule': { recurrence: { freq: 'WEEKLY' } },
    'a rule that stops repeating': { recurrence: {} },
    'a new location': { location: 'Room 9' },
    'a removed location': { location: '' },
  };
  for (const [label, patch] of Object.entries(ASKED)) {
    it(`are asked again of everyone but the organizer for ${label}`, async () => {
      const { res, fresh } = await split(series(), patch);
      expect(res, res.error).toMatchObject({ ok: true });
      expect(entries(fresh)).toEqual(ASKED_AGAIN);
    });
  }

  // A start restated in the user's zone is written in the series' own zone at
  // the same instant, so its later occurrences stay where the answers were
  // given for them, across the user's daylight saving change on 2099-11-01.
  const RANGE = [fakeDateTime('2099-09-01', 0, 0, UTC_ZONE), fakeDateTime('2100-01-01', 0, 0, UTC_ZONE)];
  const instants = (item) => seriesOccurrences(item, ...RANGE).map(({ start }) => start.nativeTime);
  it('are kept for a series in another zone when the start is restated in the user\'s zone, and no later occurrence moves', async () => {
    const start = fakeDateTime(START_DAY, 17, 0, EAST);
    const seriesInstants = new Set(instants(series({ start })));
    // 17:00 at UTC+9 is 08:00 UTC: 01:00 in Vancouver (daylight time in October).
    const { res, fresh } = await split(series({ start }), { start_iso: '2099-10-15T01:00:00' }, { recurrenceId: '2099-10-15T01:00:00' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(fresh.startDate.timezone).toBe(EAST);
    expect(instants(fresh).length).toBeGreaterThan(10);
    expect(instants(fresh).filter((t) => !seriesInstants.has(t))).toEqual([]);
    expect(entries(fresh)).toEqual(SERIES_ENTRIES);
  });

  // An all-day series is split and named by its date; a floating one by its
  // own digits, and a start restated in the user's zone keeps it floating.
  for (const [label, makeStart, recurrenceId, patch, expected] of [
    ['kept for an all-day series whose day is restated', () => fakeDate(START_DAY), '2099-10-15T00:00:00',
      { all_day: true, start_iso: '2099-10-15T00:00:00', end_iso: '2099-10-16T00:00:00' }, () => SERIES_ENTRIES],
    ['asked again for an all-day series moved a day', () => fakeDate(START_DAY), '2099-10-15T00:00:00',
      { all_day: true, start_iso: '2099-10-16T00:00:00', end_iso: '2099-10-17T00:00:00' }, () => ASKED_AGAIN],
    ['kept for a floating series given a new title', () => fakeDateTime(START_DAY, 17, 0, FLOATING_ZONE), SPLIT_AT,
      { title: 'Renamed' }, () => SERIES_ENTRIES],
    ['kept for a floating series whose start is restated in the user\'s zone', () => fakeDateTime(START_DAY, 17, 0, FLOATING_ZONE), SPLIT_AT,
      { start_iso: SPLIT_AT }, () => SERIES_ENTRIES],
  ]) {
    it(`are ${label}`, async () => {
      const { res, fresh } = await split(series({ start: makeStart() }), patch, { recurrenceId });
      expect(res, res.error).toMatchObject({ ok: true });
      expect(entries(fresh)).toEqual(expected());
    });
  }

  it('are asked again for a series in another zone when the start keeps its digits in the user\'s zone, another instant', async () => {
    const start = fakeDateTime(START_DAY, 17, 0, EAST);
    const { res, fresh } = await split(series({ start }), { start_iso: '2099-10-15T17:00:00' }, { recurrenceId: '2099-10-15T01:00:00' });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(entries(fresh)).toEqual(ASKED_AGAIN);
  });
});
