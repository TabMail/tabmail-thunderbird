/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarAttendeeChangeKeepsEntries.test.js: an edit that adds or removes
// attendees keeps everyone still on the list as they were stored (their answer,
// role and other details), as Thunderbird's own event dialog does, and adds the
// others unanswered with a request to respond. Pinned through the real bridge
// for every kind of edit that writes an attendee list: the whole series, one
// occurrence, and "this and following" (whose following part, not moved here,
// keeps the answers).

// West of UTC, so the user's zone is not UTC.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

const {
  loadCalendarBridge, fakeAttendee, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem,
} = await import('./helpers/calendarBridgeHarness.js');

// A far-future daily series (2099 is the dated-test exception: never goes stale).
const START_DAY = '2099-10-01';
const OCCURRENCE = '2099-10-15T17:00:00';

function seriesAttendees() {
  return [
    fakeAttendee({ id: 'mailto:organizer@example.com', commonName: 'Org', participationStatus: 'ACCEPTED', role: 'CHAIR', rsvp: 'FALSE' }),
    fakeAttendee({ id: 'mailto:ana@example.com', commonName: 'Ana', participationStatus: 'ACCEPTED', role: 'REQ-PARTICIPANT', rsvp: 'FALSE', userType: 'INDIVIDUAL', properties: { 'X-NUM-GUESTS': '1' } }),
    fakeAttendee({ id: 'mailto:ben@example.com', commonName: 'Ben', participationStatus: 'DECLINED', role: 'OPT-PARTICIPANT', rsvp: 'FALSE' }),
    fakeAttendee({ id: 'mailto:room@example.com', commonName: 'Room 4', participationStatus: 'TENTATIVE', role: 'NON-PARTICIPANT', userType: 'ROOM', properties: { 'SCHEDULE-AGENT': 'SERVER' } }),
  ];
}

function series() {
  const start = fakeDateTime(START_DAY, 17);
  const end = start.clone();
  end.addDuration({ inSeconds: 3600, isNegative: false });
  const ev = fakeEvent({
    id: 'ser', title: 'Sync', startDate: start, endDate: end,
    attendees: seriesAttendees(),
    organizer: fakeAttendee({ id: 'mailto:organizer@example.com', commonName: 'Org', isOrganizer: true }),
  });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')]);
  ev.recurrenceInfo.item = ev;
  return ev;
}

// Each kind of edit, and the item it saved with the new attendee list.
const EDITS = {
  'the whole series': {
    args: {},
    saved: ({ calendar }) => calendar.items.find((it) => it.id === 'ser'),
  },
  'one occurrence': {
    args: { edit_scope: 'this_only', recurrence_id: OCCURRENCE },
    saved: ({ master }) => {
      const ids = master.recurrenceInfo.getExceptionIds();
      expect(ids.length).toBe(1);
      return ids.length === 1 ? master.recurrenceInfo.getExceptionFor(ids[0]) : null;
    },
  },
  'this and following': {
    args: { edit_scope: 'this_and_following', recurrence_id: OCCURRENCE },
    saved: ({ calendar }) => calendar.items.find((it) => it.id !== 'ser'),
  },
};

// Everything an attendee carries: their address, name, answer and details.
const entry = (a) => ({
  id: a.id, commonName: a.commonName, participationStatus: a.participationStatus, rsvp: a.rsvp,
  role: a.role, userType: a.userType, properties: a.properties,
});
const SERIES_ENTRIES = seriesAttendees().map(entry);
const added = (id, commonName) => ({ id, commonName, participationStatus: 'NEEDS-ACTION', rsvp: 'TRUE', role: undefined, userType: undefined, properties: undefined });

async function edit(kind, attendees) {
  const master = series();
  const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
  const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...EDITS[kind].args, attendees });
  expect(res, res.error).toMatchObject({ ok: true });
  return EDITS[kind].saved({ master, calendar }).getAttendees().map(entry);
}

describe('an attendee change keeps everyone still on the list as stored', () => {
  for (const kind of Object.keys(EDITS)) {
    it(`adding an attendee keeps everyone else's answer and details, and adds them unanswered (${kind})`, async () => {
      const list = [...SERIES_ENTRIES.map((e) => ({ email: e.id.replace('mailto:', ''), name: e.commonName })), { email: 'dana@example.com', name: 'Dana' }];
      expect(await edit(kind, list)).toEqual([...SERIES_ENTRIES, added('mailto:dana@example.com', 'Dana')]);
    });

    it(`removing attendees keeps the others' answers and details, matched without regard to case, in the list's order (${kind})`, async () => {
      const list = [{ email: 'ANA@example.com' }, { email: 'cleo@example.com', name: 'Cleo' }, { email: 'organizer@example.com' }];
      expect(await edit(kind, list)).toEqual([SERIES_ENTRIES[1], added('mailto:cleo@example.com', 'Cleo'), SERIES_ENTRIES[0]]);
    });
  }

  // An occurrence already changed on its own carries its own answers: here Ana
  // declined and Ben accepted just this one. An attendee change to it keeps
  // those, not the series' answers.
  it('an attendee change to an occurrence already changed on its own keeps that occurrence\'s answers', async () => {
    const ownAttendees = () => [
      fakeAttendee({ id: 'mailto:organizer@example.com', commonName: 'Org', participationStatus: 'ACCEPTED', role: 'CHAIR', rsvp: 'FALSE' }),
      fakeAttendee({ id: 'mailto:ana@example.com', commonName: 'Ana', participationStatus: 'DECLINED', role: 'REQ-PARTICIPANT', rsvp: 'FALSE', properties: { 'X-RESPONSE-COMMENT': 'Away that day' } }),
      fakeAttendee({ id: 'mailto:ben@example.com', commonName: 'Ben', participationStatus: 'ACCEPTED', role: 'OPT-PARTICIPANT', rsvp: 'FALSE' }),
    ];
    const start = fakeDateTime('2099-10-15', 17);
    const end = start.clone();
    end.addDuration({ inSeconds: 3600, isNegative: false });
    const changed = fakeEvent({ id: 'ser', title: 'Sync', startDate: start, endDate: end, recurrenceId: start.clone(), attendees: ownAttendees() });
    const master = series();
    master.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')], { exceptions: [changed] });
    master.recurrenceInfo.item = master;
    const own = ownAttendees().map(entry);
    expect(own).not.toEqual(SERIES_ENTRIES.slice(0, 3));

    const { api } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const list = [...own.map((e) => ({ email: e.id.replace('mailto:', '') })), { email: 'dana@example.com' }];
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', ...EDITS['one occurrence'].args, attendees: list });
    expect(res, res.error).toMatchObject({ ok: true });

    const saved = EDITS['one occurrence'].saved({ master });
    // Dana was added without a name, so none is set.
    expect(saved.getAttendees().map(entry)).toEqual([...own, added('mailto:dana@example.com', undefined)]);
  });
});
