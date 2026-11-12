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

// The item before, as the sender gets it: a copy of the stored item carrying
// the notify flag (Thunderbird reads the flag of an excluded occurrence from it).
function expectFlaggedCopyOf(given, stored) {
  expect(given).toBeTruthy();
  expect(given).not.toBe(stored);
  expect(given.id).toBe(stored.id);
  expect(given.getProperty('X-MOZ-SEND-INVITATIONS')).toBe('TRUE');
}

// Every notice was handed to Thunderbird flagged, built, without a second question.
function expectFlaggedAuto(notices) {
  for (const n of notices) {
    expect(n.sendInvitations).toBe('TRUE');
    expect(n.built).toBe(1);
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
    expectFlaggedCopyOf(notices[0]?.oldItem, stored);
    expect(notices[0]?.item.title).toBe('Review, moved');
    expectFlaggedAuto(notices);
  });

  it('edit of the whole series: a MODIFY of the series', async () => {
    const stored = series();
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [stored] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', title: 'Sync, renamed' });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['MODIFY']);
    expectFlaggedCopyOf(notices[0]?.oldItem, stored);
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
    expectFlaggedCopyOf(notices[0]?.oldItem, stored);
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
      expectFlaggedCopyOf(notices[0]?.oldItem, stored);
      expectFlaggedAuto(notices);
    });
  }
});

describe('excluding several occurrences sends one cancellation per date', () => {
  const DATES = ['2099-10-05T17:00:00', '2099-10-09T17:00:00', '2099-10-12T17:00:00'];

  // Each notice is a step that excludes exactly one more date than the item
  // before it: Thunderbird's sender cancels that one occurrence.
  function expectOneCancellationPerDate(notices, count) {
    expect(notices.map((n) => n.op)).toEqual(Array(count).fill('MODIFY'));
    const added = notices.map((n) => {
      const before = new Set((n.oldItem.recurrenceInfo.getRecurrenceItems() || []).filter((r) => r.isNegative).map((r) => r.date.toString()));
      return n.exdates.filter((d) => !before.has(d));
    });
    for (const a of added) expect(a).toHaveLength(1);
    expect(new Set(added.flat()).size).toBe(count);
    expect(notices.map((n) => n.method)).toEqual(Array(count).fill('CANCEL'));
    expect(new Set(notices.map((n) => n.cancelled)).size).toBe(count);
    expectFlaggedAuto(notices);
  }

  it('three dates excluded from the whole series: three notices, one per date', async () => {
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [series()] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', exdates_add: DATES });
    expect(res.ok).toBe(true);
    expect(res.invitations).toEqual({ ok: true });
    expectOneCancellationPerDate(notices, 3);
  });

  it('dates excluded together with another change: one update that carries every date', async () => {
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [series()] });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', title: 'Sync, renamed', exdates_add: DATES });
    expect(res.ok).toBe(true);
    expect(notices.map((n) => n.op)).toEqual(['MODIFY']);
    expect(notices[0]?.exdates).toHaveLength(3);
    expect(notices[0]?.item.title).toBe('Sync, renamed');
  });
});

describe('a notice Thunderbird could not send is reported, the change kept', () => {
  for (const [name, guestNoticeSend] of [['send() answers false', () => false], ['send() throws', () => { throw new Error('no transport'); }]]) {
    it(`${name}: the write stands and the result says the guests were not told`, async () => {
      const stored = oneOff();
      const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [stored], guestNoticeSend });
      const res = await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Review, moved' });
      expect(res.ok).toBe(true);
      expect(calendar.items[0].title).toBe('Review, moved');
      expect(res.invitations?.ok).toBe(false);
      expect(res.invitations?.error).toBeTruthy();
    });
  }

  it('create and delete report it too', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [oneOff()], guestNoticeSend: () => false });
    const created = await loaded.api.createCalendarEvent({ calendar_id: 'cal1', title: 'Kickoff', start_iso: '2099-10-20T09:00:00', end_iso: '2099-10-20T10:00:00', attendees: [{ email: 'ana@example.com' }] });
    expect(created.ok).toBe(true);
    expect(created.invitations?.ok).toBe(false);
    const deleted = await loaded.api.deleteCalendarEvent({ event_id: 'one', calendar_id: 'cal1' });
    expect(deleted.ok).toBe(true);
    expect(deleted.invitations?.ok).toBe(false);
  });

  it('one failed date among several is reported', async () => {
    let n = 0;
    const { api } = loadCalendarBridge(bridgeUrl, { items: [series()], guestNoticeSend: () => (n += 1) !== 2 });
    const res = await api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', exdates_add: ['2099-10-05T17:00:00', '2099-10-09T17:00:00', '2099-10-12T17:00:00'] });
    expect(res.invitations?.ok).toBe(false);
  });
});

describe('a modification is sequenced as Thunderbird sequences it', () => {
  it('each write of an item with guests goes through cal.itip.prepareSequence against the stored item', async () => {
    const stored = oneOff();
    const { api, sequenced, modifications } = loadCalendarBridge(bridgeUrl, { items: [stored] });
    expect((await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', start_iso: '2099-10-20T11:00:00', end_iso: '2099-10-20T12:00:00' })).ok).toBe(true);
    expect(sequenced).toHaveLength(1);
    expect(sequenced[0]?.oldItem).toBe(stored);
    // prepareSequence returned a bumped copy: that copy is what is written.
    expect(sequenced[0]?.returned).not.toBe(sequenced[0]?.newItem);
    expect(modifications.at(-1)?.newItem).toBe(sequenced[0]?.returned);
    expect(modifications.at(-1)?.newItem.getProperty('SEQUENCE')).toBe('1');
  });
});

// A stored event synced from a server carries no X-MOZ-SEND-INVITATIONS.
// Removing one occurrence of it must still cancel that occurrence for the
// guests, and the result says so only when Thunderbird built the CANCEL.
describe('removing one occurrence of a stored series without the notify flag cancels it', () => {
  const unflagged = () => {
    const ev = series();
    expect(ev.getProperty('X-MOZ-SEND-INVITATIONS')).toBe(null);
    return ev;
  };
  const CASES = [
    ['delete this_only', (api) => api.deleteCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', delete_scope: 'this_only', recurrence_id: OCCURRENCE })],
    ['one date excluded from the whole series', (api) => api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', exdates_add: [OCCURRENCE] })],
    ['one date excluded with an edit of another occurrence', (api) => api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: '2099-10-20T17:00:00', title: 'Sync, once', exdates_add: [OCCURRENCE] })],
  ];
  for (const [name, write] of CASES) {
    it(`${name}: a CANCEL of that occurrence is built and sent, and the result says so`, async () => {
      const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [unflagged()] });
      const res = await write(api);
      expect(res.ok).toBe(true);
      const cancels = notices.filter((n) => n.method === 'CANCEL');
      expect(cancels).toHaveLength(1);
      expect(cancels[0]?.built).toBe(1);
      expect(cancels[0]?.sent).toBe(true);
      expect(res.invitations).toEqual({ ok: true });
    });
  }
});

describe('no message built is never reported as notified', () => {
  it('an event the user was invited to: the guests were not notified because the user is a guest', async () => {
    const { api, notices } = loadCalendarBridge(bridgeUrl, { items: [oneOff()], invitedAs: 'mailto:ana@example.com' });
    const res = await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Review, moved' });
    expect(res.ok).toBe(true);
    expect(notices[0]?.built).toBe(0);
    expect(res.invitations).toMatchObject({ ok: false, reason: 'not_organizer' });
  });

  it('a message Thunderbird does not build for another reason is reported as not notified, with why', async () => {
    // The sender builds nothing for an item without the notify flag; the
    // bridge always sets it, so stand in a sender that builds nothing.
    const loaded = loadCalendarBridge(bridgeUrl, { items: [oneOff()] });
    const real = loaded.ctx.ChromeUtils.importESModule;
    loaded.ctx.ChromeUtils.importESModule = (url) => (url.includes('CalItipMessageSender')
      ? { CalItipMessageSender: class { buildOutgoingMessages() { return 0; } send() { throw new Error('send without a message'); } } }
      : real(url));
    const res = await loaded.api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Review, moved' });
    expect(res.ok).toBe(true);
    expect(res.invitations).toMatchObject({ ok: false, reason: 'no_message' });
    expect(res.invitations.error).toMatch(/built no notice/);
  });
});

describe('create sets the organizer of an event with guests', () => {
  it('the created event carries the organizer it was given', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl);
    const res = await api.createCalendarEvent({
      calendar_id: 'cal1', title: 'Kickoff', start_iso: '2099-10-20T09:00:00', end_iso: '2099-10-20T10:00:00',
      attendees: [{ email: 'ana@example.com' }], organizer_email: 'organizer@example.com',
    });
    expect(res.ok).toBe(true);
    expect(calendar.items[0]?.organizer?.id).toBe('mailto:organizer@example.com');
    expect(calendar.items[0]?.organizer?.isOrganizer).toBe(true);
  });
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

describe('the words the user and the assistant get', () => {
  it('only a built and sent notice reads as handed to Thunderbird', async () => {
    const { guestNoticeResultText, guestNoticeBubbleText } = await import('../chat/modules/calendarGuestNotice.js');
    expect(guestNoticeResultText(null)).toBe('');
    expect(guestNoticeResultText({ ok: true })).toMatch(/handed to Thunderbird/);
    for (const reason of ['no_message', 'send_failed', undefined]) {
      const failed = { ok: false, reason, error: 'why it failed' };
      expect(guestNoticeResultText(failed)).toMatch(/could NOT be notified: why it failed/);
      expect(guestNoticeResultText(failed)).not.toMatch(/handed to Thunderbird/);
      expect(guestNoticeBubbleText(failed)).toMatch(/could not be notified \(why it failed\)/);
    }
    const guest = { ok: false, reason: 'not_organizer', error: 'x' };
    expect(guestNoticeResultText(guest)).toMatch(/NOT notified: the user is a guest of this event, not its organizer/);
    expect(guestNoticeResultText(guest)).not.toMatch(/handed to Thunderbird/);
    expect(guestNoticeBubbleText(guest)).toMatch(/you are a guest of this event, not its organizer/);
  });
});

// A CalDAV calendar whose server schedules (calendar-auto-schedule) with
// forceEmailScheduling on: Thunderbird emails the guests (canNotify is false),
// so its event dialog marks the attendees SCHEDULE-AGENT=CLIENT before saving
// and the server stays quiet. The bridge does the same, or guests get two notices.
describe('the scheduling agent is chosen as the event dialog chooses it', () => {
  const identity = { QueryInterface: () => ({ email: 'organizer@example.com' }) };
  const caldav = (force) => ({
    calendarType: 'caldav',
    calendarProperties: { 'capabilities.autoschedule.supported': true, forceEmailScheduling: force, 'imip.identity': identity },
  });
  const agents = (item) => item.getAttendees().map((a) => a.getProperty('SCHEDULE-AGENT'));

  it('forceEmailScheduling on: an organizer edit writes every attendee as CLIENT', async () => {
    const { api, modifications } = loadCalendarBridge(bridgeUrl, { items: [oneOff()], ...caldav(true) });
    expect((await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Review, moved' })).ok).toBe(true);
    expect(agents(modifications.at(-1).newItem)).toEqual(['CLIENT', 'CLIENT']);
  });

  it('forceEmailScheduling on: a created event with guests is written with CLIENT attendees', async () => {
    const { api, calendar } = loadCalendarBridge(bridgeUrl, caldav(true));
    const res = await api.createCalendarEvent({
      calendar_id: 'cal1', title: 'Kickoff', start_iso: '2099-10-20T09:00:00', end_iso: '2099-10-20T10:00:00',
      attendees: [{ email: 'ana@example.com' }], organizer_email: 'organizer@example.com',
    });
    expect(res.ok).toBe(true);
    expect(agents(calendar.items[0])).toEqual(['CLIENT']);
  });

  it('forceEmailScheduling off: the server schedules, and a CLIENT mark is cleared', async () => {
    const stored = oneOff();
    stored.getAttendees()[0].setProperty('SCHEDULE-AGENT', 'CLIENT');
    const { api, modifications } = loadCalendarBridge(bridgeUrl, { items: [stored], ...caldav(false) });
    expect((await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Review, moved' })).ok).toBe(true);
    expect(agents(modifications.at(-1).newItem)).toEqual([null, null]);
  });

  it('a calendar that is not CalDAV is left alone', async () => {
    const { api, modifications } = loadCalendarBridge(bridgeUrl, { items: [oneOff()] });
    expect((await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Review, moved' })).ok).toBe(true);
    expect(agents(modifications.at(-1).newItem)).toEqual([null, null]);
  });

  it("Thunderbird's own cal.itip.adaptScheduleAgent is used where it exists", async () => {
    const seen = [];
    const { api, modifications } = loadCalendarBridge(bridgeUrl, { items: [oneOff()], ...caldav(true), itipAdaptScheduleAgent: (item) => seen.push(item) });
    expect((await api.modifyCalendarEvent({ event_id: 'one', calendar_id: 'cal1', title: 'Review, moved' })).ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(agents(modifications.at(-1).newItem)).toEqual([null, null]);
  });
});

// An edit of one occurrence that also excludes dates of its series is ONE
// write of the series (the occurrence put in by modifyException, the EXDATEs
// added), as Thunderbird stores an occurrence change. Run on a calendar that
// behaves like CalMemoryCalendar: stored items immutable, a write replaces
// the stored series.
describe('an occurrence edit that excludes dates is one series write', () => {
  const OTHER = ['2099-10-05T17:00:00', '2099-10-09T17:00:00'];
  const edit = (api) => api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: OCCURRENCE, title: 'Sync, once', exdates_add: OTHER });

  it('the stored series has the occurrence change and every excluded date, from one write', async () => {
    const { api, calendar, modifications, notices } = loadCalendarBridge(bridgeUrl, { items: [series()], memoryCalendar: true });
    const res = await edit(api);
    expect(res.ok).toBe(true);
    expect(modifications).toHaveLength(1);
    const stored = await calendar.getItem('ser');
    const ids = stored.recurrenceInfo.getExceptionIds();
    expect(ids).toHaveLength(1);
    expect(stored.recurrenceInfo.getExceptionFor(ids[0]).title).toBe('Sync, once');
    const excluded = stored.recurrenceInfo.getRecurrenceItems().filter((r) => r.isNegative).map((r) => r.date.toString());
    expect(excluded).toHaveLength(2);
    // The occurrence's update, then one cancellation per excluded date.
    expect(notices.map((n) => n.method)).toEqual(['REQUEST', 'CANCEL', 'CANCEL']);
    expect(new Set(notices.slice(1).map((n) => n.cancelled)).size).toBe(2);
    expect(notices.every((n) => n.built === 1 && n.sent === true)).toBe(true);
    expect(res.invitations).toEqual({ ok: true });
  });

  it('a refused series write saves nothing, tells no one, and says the edit failed', async () => {
    const before = series();
    const { api, calendar, notices } = loadCalendarBridge(bridgeUrl, { items: [before], memoryCalendar: true, modifyItemFails: (newItem) => !newItem.recurrenceId });
    const res = await edit(api);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/refused/);
    expect(notices).toEqual([]);
    const stored = await calendar.getItem('ser');
    expect(stored).toBe(before);
    expect(stored.recurrenceInfo.getExceptionIds()).toHaveLength(0);
    expect(stored.recurrenceInfo.getRecurrenceItems().filter((r) => r.isNegative)).toHaveLength(0);
  });
});
