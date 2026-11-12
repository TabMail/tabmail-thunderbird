/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarGuestsAlwaysNotified.test.js: guests are always told (#423). Every
// write to an event that has guests, before or after the write (create, edit
// of an event, an occurrence or a series, delete of an event, an occurrence or
// the following occurrences, and both writes of a "this and following" split),
// is handed to Thunderbird's own scheduling (cal.itip.checkAndSend, the entry
// point its transactions use) with the notify flag set, without asking again,
// and with no argument asking for it. Thunderbird then leaves the message to a
// calendar that schedules itself or mails it. An event without guests is
// written without a notice. The retired `send_invitations` argument is gone
// from the bridge's schema and from every tool's bridge call, and it refuses
// nothing any more.
//
// Run through the real bridge (calendarBridgeHarness.js). Dates are in 2099,
// the dated-test exception: they never go stale.

process.env.TZ = 'America/Vancouver';

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');
const schemaUrl = resolve(__dirname, '../chat/experiments/tmCalendar/schema.json');

const {
  loadCalendarBridge, fakeAttendee, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem,
} = await import('./helpers/calendarBridgeHarness.js');

const START_DAY = '2099-10-01';
const OCCURRENCE = '2099-10-15T17:00:00';
const GUESTS = ['mailto:ana@example.com', 'mailto:ben@example.com'];

const guests = () => GUESTS.map((id) => fakeAttendee({ id, participationStatus: 'ACCEPTED', rsvp: 'FALSE' }));
const organizer = () => fakeAttendee({ id: 'mailto:organizer@example.com', isOrganizer: true });

function oneOff({ withGuests = true } = {}) {
  const start = fakeDateTime('2099-10-20', 9);
  const end = start.clone();
  end.addDuration({ inSeconds: 3600, isNegative: false });
  return fakeEvent({ id: 'one', title: 'Review', startDate: start, endDate: end, attendees: withGuests ? guests() : [], organizer: withGuests ? organizer() : null });
}

function series({ withGuests = true } = {}) {
  const start = fakeDateTime(START_DAY, 17);
  const end = start.clone();
  end.addDuration({ inSeconds: 3600, isNegative: false });
  const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: start, endDate: end, attendees: withGuests ? guests() : [], organizer: withGuests ? organizer() : null });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')]);
  ev.recurrenceInfo.item = ev;
  return ev;
}

// Every notice was handed to Thunderbird flagged, without a second question.
function expectFlaggedAuto(notices) {
  for (const n of notices) {
    expect(n.sendInvitations).toBe('TRUE');
    expect(n.responseMode).toBe('AUTO');
  }
}

describe('a write to an event with guests notifies them, with no argument asking for it', () => {
  it('create: the new event is handed to scheduling as an ADD, with its guests', async () => {
    const { api, notices } = loadCalendarBridge(bridgeUrl);
    const res = await api.createCalendarEvent({
      calendar_id: 'cal1', title: 'Kickoff', start_iso: '2099-10-20T09:00:00', end_iso: '2099-10-20T10:00:00',
      attendees: [{ email: 'ana@example.com' }, { email: 'ben@example.com' }], organizer_email: 'organizer@example.com',
    });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['ADD']);
    expect(notices[0]?.guests).toEqual(GUESTS);
    expectFlaggedAuto(notices);
  });

  it('edit of a one-off event: a MODIFY against the stored event', async () => {
    const stored = oneOff();
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [stored] });
    const res = await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Review, moved' });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['MODIFY']);
    expect(notices[0]?.oldItem).toBe(stored);
    expect(notices[0]?.item.title).toBe('Review, moved');
    expectFlaggedAuto(notices);
  });

  it('edit of the whole series: a MODIFY of the series', async () => {
    const stored = series();
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [stored] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', title: 'Sync, renamed' });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['MODIFY']);
    expect(notices[0]?.oldItem).toBe(stored);
    expectFlaggedAuto(notices);
  });

  it('edit of one occurrence: a MODIFY of that occurrence', async () => {
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [series()] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: OCCURRENCE, title: 'Sync, once' });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['MODIFY']);
    expect(notices[0]?.item.recurrenceId).toBeTruthy();
    expectFlaggedAuto(notices);
  });

  it('removing every guest still tells the removed guests (the old item had them)', async () => {
    const stored = oneOff();
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [stored] });
    const res = await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', remove_attendees: [{ email: '*' }] });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['MODIFY']);
    expect(notices[0]?.guests).toEqual([]);
    expect(notices[0]?.oldItem.getAttendees().map((a) => a.id)).toEqual(GUESTS);
    expectFlaggedAuto(notices);
  });

  it('this and following: both writes are handed to scheduling, the earlier part and the new series', async () => {
    const stored = series();
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [stored] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: OCCURRENCE, title: 'Sync, later' });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['MODIFY', 'ADD']);
    expect(notices[0]?.oldItem).toBe(stored);
    expect(notices[1]?.item.title).toBe('Sync, later');
    expect(notices[1]?.guests).toEqual(GUESTS);
    expectFlaggedAuto(notices);
  });

  it('delete of an event: a DELETE (a cancellation) for its guests', async () => {
    const { api, notices, deletions } = loadCalendarBridge(bridgeUrl, { items: [oneOff()] });
    const res = await api.deleteCalendarEvent({ event_id: 'one', calendar_id: 'cal1' });
    expect(res.ok).toBe(true);
    expect(deletions.length).toBe(1);
    expect(notices.map((n) => n.op)).toEqual(['DELETE']);
    expect(notices[0]?.guests).toEqual(GUESTS);
    expectFlaggedAuto(notices);
  });

  it('delete of a whole series: a DELETE', async () => {
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [series()] });
    const res = await api.deleteCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', delete_scope: 'all' });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['DELETE']);
    expectFlaggedAuto(notices);
  });

  for (const scope of ['this_only', 'this_and_following']) {
    it(`delete ${scope}: the series written without those occurrences is a MODIFY against the stored series`, async () => {
      const stored = series();
      const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [stored] });
      const res = await api.deleteCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', delete_scope: scope, recurrence_id: OCCURRENCE });
      expect(res.ok).toBe(true);
      expect(notices.map((n) => n.op)).toEqual(['MODIFY']);
      expect(notices[0]?.oldItem).toBe(stored);
      expectFlaggedAuto(notices);
    });
  }
});

describe('an event without guests is written with no notice', () => {
  it('create, edit and delete of a guestless event call no scheduling and set no flag', async () => {
    const stored = oneOff({ withGuests: false });
    const { api, notices, modifications, calendar } = loadCalendarBridge(bridgeUrl, { items: [stored] });
    expect((await api.createCalendarEvent({ calendar_id: 'cal1', title: 'Focus', start_iso: '2099-10-21T09:00:00', end_iso: '2099-10-21T10:00:00' })).ok).toBe(true);
    expect((await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Solo' })).ok).toBe(true);
    expect(modifications[0]?.newItem.getProperty('X-MOZ-SEND-INVITATIONS')).toBe(null);
    expect(calendar.items.every((it) => it.getProperty('X-MOZ-SEND-INVITATIONS') === null)).toBe(true);
    expect((await api.deleteCalendarEvent({ event_id: 'one', calendar_id: 'cal1' })).ok).toBe(true);
    expect(notices).toEqual([]);
  });
});

describe('the retired send_invitations argument refuses nothing', () => {
  it('create with no guests is written, not refused', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl);
    const res = await api.createCalendarEvent({ calendar_id: 'cal1', title: 'Focus', start_iso: '2099-10-21T09:00:00', end_iso: '2099-10-21T10:00:00', send_invitations: true });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
    expect(calendar.items.length).toBe(1);
  });

  it('edit of an event with no guests is written, not refused', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [oneOff({ withGuests: false })] });
    const res = await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Solo', send_invitations: true });
    expect(res.ok).toBe(true);
  });

  it('a split whose new series ends with no guests is written, not refused', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series()] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: OCCURRENCE, remove_attendees: [{ email: '*' }], send_invitations: true });
    expect(res.ok).toBe(true);
  });

  it('the argument alone is no change: the check before the card says nothing changes', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [oneOff()] });
    const res = await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', send_invitations: true, check_only: true });
    expect(res).toMatchObject({ ok: true, changes: false });
  });
});

describe('send_invitations is gone from the add-on', () => {
  it('the bridge schema declares it nowhere', () => {
    expect(readFileSync(schemaUrl, 'utf8')).not.toMatch(/send_invitations/);
  });

  for (const tool of ['calendar_event_create', 'calendar_event_edit', 'calendar_event_delete']) {
    it(`${tool} reads it nowhere`, () => {
      const src = readFileSync(resolve(__dirname, `../chat/tools/${tool}.js`), 'utf8');
      expect(src).not.toMatch(/send_invitations/);
    });
  }

  it('the delete flow passes it nowhere', () => {
    const src = readFileSync(resolve(__dirname, '../chat/fsm/calendarDelete.js'), 'utf8');
    expect(src).not.toMatch(/send_invitations/);
  });
});
