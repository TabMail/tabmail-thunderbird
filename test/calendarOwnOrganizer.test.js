/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarOwnOrganizer.test.js: an event the assistant saves with guests names
// the calendar's own address (calendar.getProperty("organizerId"), what
// Thunderbird's event dialog uses) as its organizer, so a scheduling server
// notifies the guests.
//
// The invariant: every item the bridge writes that has guests names the
// calendar's own address as organizer unless it already named one, which is
// kept with every parameter; an item without guests gets none; an address the
// model gives is never used; a calendar with no address saves the event
// without an organizer and the reply says so, never that anyone was emailed.

process.env.TZ = 'America/Vancouver';

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

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

const {
  loadCalendarBridge, fakeAttendee, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem,
} = await import('./helpers/calendarBridgeHarness.js');
const { runStateCreateCalendarEventExec } = await import('../chat/fsm/calendarCreate.js');
const { completeExecution } = await import('../chat/tools/calendar_event_create.js');
const { streamText } = await import('../chat/modules/helpers.js');
const { ctx } = await import('../chat/modules/context.js');

const OWN = 'mailto:me@example.com';
const WITH_ADDRESS = { organizerId: OWN, organizerCN: 'Me Example' };
// The model's own idea of the organizer: never used.
const MODEL_ADDRESS = 'model@example.com';

const dayAt = (n) => fakeDateTime(`2099-10-${String(n).padStart(2, '0')}`, 17);
const isoAt = (n) => `2099-10-${String(n).padStart(2, '0')}T17:00:00`;
const hourAfter = (start) => {
  const end = start.clone();
  end.addDuration({ inSeconds: 3600, isNegative: false });
  return end;
};
const guest = (name) => fakeAttendee({ id: `mailto:${name}@example.com`, participationStatus: 'ACCEPTED', rsvp: 'FALSE' });
const otherOrganizer = () => fakeAttendee({
  id: 'mailto:boss@example.com', commonName: 'Boss', isOrganizer: true,
  properties: { 'SENT-BY': 'mailto:assistant@example.com', 'SCHEDULE-STATUS': '1.2' },
});
const oneOff = (guests, organizer = null) => fakeEvent({ id: 'ser', title: 'Sync', startDate: dayAt(1), endDate: hourAfter(dayAt(1)), attendees: guests, organizer });
function series(guests, organizer = null) {
  const ev = oneOff(guests, organizer);
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=10')]);
  ev.recurrenceInfo.item = ev;
  return ev;
}

// The bridge on one calendar; a created event keeps the attendees added to it
// (the harness' new event drops them otherwise).
function bridge(items, calendarProperties) {
  const loaded = loadCalendarBridge(bridgeUrl, { items, calendarProperties });
  const cc = loaded.ctx.Cc;
  loaded.ctx.Cc = new Proxy({}, {
    get(_t, key) {
      if (key === '@mozilla.org/calendar/event;1') return { createInstance: () => fakeEvent({ id: null, title: '', startDate: null, endDate: null }) };
      return cc[key];
    },
  });
  return loaded;
}
const createArgs = (extra = {}) => ({
  calendar_id: 'cal1', title: 'Sync', start_iso: isoAt(1), end_iso: '2099-10-01T18:00:00', ...extra,
});
const organizerOf = (item) => (item?.organizer ? { id: item.organizer.id, isOrganizer: item.organizer.isOrganizer } : null);

describe('create', () => {
  it('a create with guests names the calendar\'s own address, without send_invitations', async () => {
    const { api, calendar } = bridge([], WITH_ADDRESS);
    const res = await api.createCalendarEvent(createArgs({ attendees: [{ email: 'ana@example.com' }] }));
    expect(res.ok).toBe(true);
    const stored = calendar.items[0];
    expect(organizerOf(stored)).toEqual({ id: OWN, isOrganizer: true });
    expect(stored.organizer.commonName).toBe('Me Example');
    expect(res.guest_notice).toBeUndefined();
  });

  it('a create with no guests gets no organizer', async () => {
    const { api, calendar } = bridge([], WITH_ADDRESS);
    expect((await api.createCalendarEvent(createArgs())).ok).toBe(true);
    expect(calendar.items[0].organizer).toBeFalsy();
  });

  it('an address the model gives is never used', async () => {
    const { api, calendar } = bridge([], WITH_ADDRESS);
    await api.createCalendarEvent(createArgs({ attendees: [{ email: 'ana@example.com' }], send_invitations: true, organizer_email: MODEL_ADDRESS }));
    expect(organizerOf(calendar.items[0])).toEqual({ id: OWN, isOrganizer: true });
  });

  it('a calendar with no address saves without an organizer, even when the model gives one, and says so', async () => {
    const { api, calendar } = bridge([], {});
    const res = await api.createCalendarEvent(createArgs({ attendees: [{ email: 'ana@example.com' }], send_invitations: true, organizer_email: MODEL_ADDRESS }));
    expect(res.ok).toBe(true);
    expect(calendar.items[0].getAttendees()).toHaveLength(1);
    expect(calendar.items[0].organizer).toBeFalsy();
    expect(res.guest_notice).toMatch(/no email address of its own/);
    expect(res.guest_notice).not.toMatch(/sent|emailed|notified them|invited/i);
  });

  it('the reply the user and the model see says the calendar has no address', async () => {
    const { api } = bridge([], {});
    globalThis.browser.tmCalendar = api;
    ctx.activePid = 7;
    ctx.fsmSessions[7] = { createEventArgs: createArgs({ attendees: [{ email: 'ana@example.com' }] }) };
    streamText.mockClear();
    await runStateCreateCalendarEventExec();
    const shown = streamText.mock.calls.map((c) => String(c[1])).join('\n');
    expect(shown).toMatch(/no email address of its own/);
    expect(shown).not.toMatch(/(invitations?|updates?) sent|emailed/i);
    const done = await completeExecution({ activePid: 7, fsmSessions: ctx.fsmSessions, rawUserTexts: [] }, 'calendar_event_create_exec');
    expect(String(done.guest_notice || '')).toMatch(/no email address of its own/);
  });
});

// Each write of an existing event, with the item(s) it writes.
const EDITS = {
  'a one-off edit': {
    build: (o) => oneOff([guest('ana')], o),
    run: (api) => api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', title: 'Renamed' }),
    written: ({ calendar }) => [calendar.items[0]],
  },
  'an edit of the whole series': {
    build: (o) => series([guest('ana')], o),
    run: (api) => api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'all', title: 'Renamed' }),
    written: ({ calendar }) => [calendar.items[0]],
  },
  'an edit of one occurrence': {
    build: (o) => series([guest('ana')], o),
    run: (api) => api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: isoAt(4), title: 'Renamed' }),
    written: ({ modifications }) => [modifications.at(-1).newItem],
  },
  'a split (both parts)': {
    build: (o) => series([guest('ana')], o),
    run: (api) => api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: isoAt(4), location: 'Room 2' }),
    written: ({ calendar }) => {
      expect(calendar.items).toHaveLength(2);
      return calendar.items;
    },
  },
  'a delete of one occurrence': {
    build: (o) => series([guest('ana')], o),
    run: (api) => api.deleteCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', delete_scope: 'this_only', recurrence_id: isoAt(4) }),
    written: ({ modifications }) => [modifications.at(-1).newItem],
  },
  'a delete of this and following': {
    build: (o) => series([guest('ana')], o),
    run: (api) => api.deleteCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', delete_scope: 'this_and_following', recurrence_id: isoAt(4) }),
    written: ({ modifications }) => [modifications.at(-1).newItem],
  },
};

describe.each(Object.entries(EDITS))('%s', (_name, c) => {
  it('a stored event with guests and no organizer is written with the calendar\'s own address', async () => {
    const loaded = bridge([c.build(null)], WITH_ADDRESS);
    const res = await c.run(loaded.api);
    expect(res.ok, res.error).toBe(true);
    const items = c.written(loaded);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(organizerOf(item)).toEqual({ id: OWN, isOrganizer: true });
  });

  it('an existing organizer (someone else) is kept with every parameter', async () => {
    const loaded = bridge([c.build(otherOrganizer())], WITH_ADDRESS);
    const res = await c.run(loaded.api);
    expect(res.ok, res.error).toBe(true);
    for (const item of c.written(loaded)) {
      expect(item.organizer.id).toBe('mailto:boss@example.com');
      expect(item.organizer.commonName).toBe('Boss');
      expect(Object.fromEntries(item.organizer.properties)).toEqual({ 'SENT-BY': 'mailto:assistant@example.com', 'SCHEDULE-STATUS': '1.2' });
    }
  });

  it('a calendar with no address writes no organizer and says so', async () => {
    const loaded = bridge([c.build(null)], {});
    const res = await c.run(loaded.api);
    expect(res.ok, res.error).toBe(true);
    for (const item of c.written(loaded)) expect(item.organizer).toBeFalsy();
    expect(res.guest_notice).toMatch(/no email address of its own/);
  });
});

describe('a split', () => {
  it('the new series\' organizer is not asked again when the split reschedules', async () => {
    const own = fakeAttendee({ id: OWN, participationStatus: 'ACCEPTED', rsvp: 'FALSE' });
    const loaded = bridge([series([guest('ana'), own])], WITH_ADDRESS);
    const res = await loaded.api.modifyCalendarEvent({ event_id: 'ser', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: isoAt(4), location: 'Room 2' });
    expect(res.ok, res.error).toBe(true);
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    const me = part.getAttendees().find((a) => a.id === OWN);
    expect(me.participationStatus).toBe('ACCEPTED');
    expect(part.getAttendees().find((a) => a.id !== OWN).participationStatus).toBe('NEEDS-ACTION');
  });
});

describe('a whole-event delete', () => {
  it('deletes the stored item as it is', async () => {
    const stored = oneOff([guest('ana')]);
    const loaded = bridge([stored], WITH_ADDRESS);
    expect((await loaded.api.deleteCalendarEvent({ event_id: 'ser', calendar_id: 'cal1' })).ok).toBe(true);
    expect(loaded.deletions).toEqual([stored]);
    expect(stored.organizer).toBeFalsy();
    expect(loaded.modifications).toHaveLength(0);
  });
});
