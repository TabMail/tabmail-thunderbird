/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarGuestChange.test.js: a guest change (add_attendees and
// remove_attendees), from the edit tool's `run` through the edit flow into the
// real calendar bridge, for every scope of edit.
//
// The property: for one guest change, started from the same guests, every item
// the edit covers ends with the same guest list (the event, one occurrence,
// the series and each occurrence of it changed on its own, the following part
// of a split and the changed occurrences it carries), and the items the edit
// does not cover keep theirs. An occurrence that began with guests of its own
// keeps its own differences apart from what the change names.
//
// Every call the flow makes to the bridge is checked against the experiment's
// schema.json, as Thunderbird checks it.

// West of UTC, so the user's zone is not UTC.
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
const { run } = await import('../chat/tools/calendar_event_edit.js');
const { runStateEditCalendarEventExec, runStateEditCalendarEventList } = await import('../chat/fsm/calendarEdit.js');
const { streamText } = await import('../chat/modules/helpers.js');
const { ctx } = await import('../chat/modules/context.js');

// What the flow sends must be what the experiment declares (see
// helpers/calendarSchemaCheck.js); each bridge call is checked first.
const { SCHEMA_FUNCTIONS, checkAgainst, checked } = await import('./helpers/calendarSchemaCheck.js');
const modifyDetails = SCHEMA_FUNCTIONS.find((f) => f.name === 'modifyCalendarEvent').parameters[0];
const schemaErrors = [];

// A far-future daily series, ten days long (2099 is the dated-test exception:
// it never goes stale).
const dayAt = (n) => fakeDateTime(`2099-10-${String(n).padStart(2, '0')}`, 17);
const isoAt = (n) => `2099-10-${String(n).padStart(2, '0')}T17:00:00`;
const hourAfter = (start) => {
  const end = start.clone();
  end.addDuration({ inSeconds: 3600, isNegative: false });
  return end;
};
const mail = (name) => `mailto:${name}@example.com`;
const NAMES = { ana: 'Ana', bo: 'Bo', cy: 'Cy' };
const guest = (name, id = mail(name)) => fakeAttendee({ id, commonName: NAMES[name] || null, participationStatus: 'ACCEPTED', rsvp: 'FALSE' });

const oneOff = (guests) => fakeEvent({ id: 'ser', title: 'Sync', startDate: dayAt(1), endDate: hourAfter(dayAt(1)), attendees: guests });
// An occurrence changed on its own, at its slot, with its own guest list.
const changed = (n, guests) => fakeEvent({ id: 'ser', title: 'Planning', startDate: dayAt(n), endDate: hourAfter(dayAt(n)), recurrenceId: dayAt(n), attendees: guests });
function series(guests, exceptions = []) {
  const ev = oneOff(guests);
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=10')], { exceptions });
  ev.recurrenceInfo.item = ev;
  return ev;
}
const exceptionsOf = (item) => {
  const info = item?.recurrenceInfo;
  return info ? info.getExceptionIds().map((rid) => info.getExceptionFor(rid)) : [];
};
const original = (calendar) => calendar.items.find((it) => it.id === 'ser');
const following = (calendar) => calendar.items.find((it) => it.id !== 'ser');

// Each scope of edit: the event it starts from (`guests` on the series or
// event, `own` on the occurrence changed before), the arguments naming the
// scope, and what the edit covers: the items that carry the series' list
// (`main`), the occurrences changed on their own (`own`), and the items it
// leaves alone (`untouched`).
const CHANGED_DAY = 4;
const SCOPES = {
  'a one-off event': {
    build: (guests) => oneOff(guests),
    args: {},
    items: (calendar) => ({ main: [original(calendar)], own: [], untouched: [] }),
  },
  'one occurrence, not changed before': {
    build: (guests) => series(guests),
    args: { edit_scope: 'this_only', recurrence_id: isoAt(CHANGED_DAY) },
    items: (calendar) => ({ main: exceptionsOf(original(calendar)), own: [], untouched: [original(calendar)] }),
    count: { main: 1 },
  },
  'one occurrence, changed before': {
    build: (guests, own) => series(guests, [changed(CHANGED_DAY, own)]),
    args: { edit_scope: 'this_only', recurrence_id: isoAt(CHANGED_DAY) },
    items: (calendar) => ({ main: [], own: exceptionsOf(original(calendar)), untouched: [original(calendar)] }),
    count: { own: 1 },
  },
  'the whole series': {
    build: (guests, own) => series(guests, [changed(CHANGED_DAY, own)]),
    args: { edit_scope: 'all' },
    items: (calendar) => ({ main: [original(calendar)], own: exceptionsOf(original(calendar)), untouched: [] }),
    count: { own: 1 },
  },
  'this and following, from before a changed occurrence': {
    build: (guests, own) => series(guests, [changed(CHANGED_DAY, own)]),
    args: { edit_scope: 'this_and_following', recurrence_id: isoAt(CHANGED_DAY - 1) },
    items: (calendar) => ({ main: [following(calendar)], own: exceptionsOf(following(calendar)), untouched: [original(calendar)] }),
    count: { own: 1 },
  },
  'this and following, from a changed occurrence': {
    build: (guests, own) => series(guests, [changed(CHANGED_DAY, own)]),
    args: { edit_scope: 'this_and_following', recurrence_id: isoAt(CHANGED_DAY) },
    items: (calendar) => ({ main: [following(calendar)], own: exceptionsOf(following(calendar)), untouched: [original(calendar)] }),
    count: { own: 1 },
  },
};

let nextPid = 0;
// The tool's `run` (which stores the edit for the confirmation card), then the
// edit flow's write, against the real bridge.
async function edit(scopeName, guests, own, change) {
  const scope = SCOPES[scopeName];
  const loaded = loadCalendarBridge(bridgeUrl, { items: [scope.build(guests, own)] });
  globalThis.browser.tmCalendar = checked(loaded.api, schemaErrors);
  schemaErrors.length = 0;
  const pid = `pid-guests-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  await run({ event_id: 'ser', calendar_id: 'cal1', ...scope.args, ...change }, { callId: pid });
  await new Promise((r) => setTimeout(r, 5));
  const sess = ctx.fsmSessions[pid];
  if (sess.editEventArgs) {
    const was = ctx.activePid;
    ctx.activePid = pid;
    try {
      await runStateEditCalendarEventExec();
    } finally {
      ctx.activePid = was;
    }
  }
  const items = sess.failReason ? null : scope.items(loaded.calendar);
  if (items) {
    for (const [part, n] of Object.entries(scope.count || {})) expect(items[part], `${part} items`).toHaveLength(n);
    for (const it of [...items.main, ...items.own, ...items.untouched]) expect(it).toBeTruthy();
  }
  return { sess, items, loaded, schemaErrors: [...schemaErrors] };
}
const ids = (item) => item.getAttendees().map((a) => a.id);
const add = (...emails) => ({ add_attendees: emails.map((email) => ({ email })) });
const remove = (...emails) => ({ remove_attendees: emails.map((email) => ({ email })) });

// The tool checks every edit against the bridge before the card, with the
// guest change and send_invitations in it: what the write would refuse is
// refused there, with no card and nothing written.
describe('an edit of the times that would leave no one to invite is refused before the card', () => {
  for (const scopeName of Object.keys(SCOPES)) {
    it(`${scopeName}: everyone removed, with invitations asked for`, async () => {
      const day = (SCOPES[scopeName].args.recurrence_id || isoAt(1)).slice(0, 10);
      const stored = [guest('ana'), guest('bo')];
      const own = [guest('cy')];
      const r = await edit(scopeName, stored, own, { end_iso: `${day}T19:00:00`, ...remove('*'), send_invitations: true });
      expect(r.schemaErrors).toEqual([]);
      expect(r.sess.failReason).toMatch(/send_invitations=true requires at least one attendee/);
      expect(ctx.state).toBe('exec_fail');
      expect(r.sess.editEventArgs).toBeUndefined();
      expect(r.loaded.modifications).toHaveLength(0);
      expect(r.loaded.calendar.items).toHaveLength(1);
      const series = original(r.loaded.calendar);
      expect(ids(series)).toEqual([mail('ana'), mail('bo')]);
      for (const ex of exceptionsOf(series)) expect(ids(ex)).toEqual([mail('cy')]);
    });
  }
});

describe('the schema check refuses what Thunderbird refuses', () => {
  it('takes a declared guest change and refuses an undeclared, missing or mistyped value', () => {
    expect(() => checkAgainst(modifyDetails, { event_id: 'ser', add_attendees: [{ email: 'x@example.com' }], remove_attendees: [{ email: '*' }] }, 'details')).not.toThrow();
    expect(() => checkAgainst(modifyDetails, { event_id: 'ser', add_attendees: [{ email: 'x@example.com', name: 'X' }] }, 'details')).not.toThrow();
    expect(() => checkAgainst(modifyDetails, { event_id: 'ser', add_attendees: [{ email: 'x@example.com', role: 'x' }] }, 'details')).toThrow(/unexpected/);
    expect(() => checkAgainst(modifyDetails, { event_id: 'ser', remove_attendees: [{ email: 'x@example.com', name: 'X' }] }, 'details')).toThrow(/unexpected/);
    expect(() => checkAgainst(modifyDetails, { event_id: 'ser', remove_attendees: [{}] }, 'details')).toThrow(/missing/);
    expect(() => checkAgainst(modifyDetails, { event_id: 'ser', add_attendees: 'x@example.com' }, 'details')).toThrow(/declared array/);
    expect(() => checkAgainst(modifyDetails, { event_id: 'ser', attendees: [{ email: 'x@example.com' }] }, 'details')).toThrow(/unexpected/);
    expect(() => checkAgainst(modifyDetails, { calendar_id: 'cal1' }, 'details')).toThrow(/missing/);
    expect(() => checkAgainst(modifyDetails, { event_id: 'ser', location: null }, 'details')).not.toThrow();
  });
});

// Everything starts with Ana, Bo and Cy, on the series or event and on the
// occurrence changed before.
const CHANGES = [
  ['a guest added', add('dee@example.com'), ['ana', 'bo', 'cy', 'dee']],
  ['a guest added twice, in two cases', add('dee@example.com', 'DEE@Example.com'), ['ana', 'bo', 'cy', 'dee']],
  ['a guest added who is already there, in capitals', add('BO@EXAMPLE.COM'), ['ana', 'bo', 'cy']],
  ['a guest added with mailto: and spaces', add(' MAILTO:dee@example.com '), ['ana', 'bo', 'cy', 'dee']],
  ['a guest added with a space after mailto:', add('mailto: dee@example.com'), ['ana', 'bo', 'cy', 'dee']],
  ['a guest added with mailto: twice', add('mailto:mailto:dee@example.com'), ['ana', 'bo', 'cy', 'dee']],
  ['a guest added with mailto: three times', add('mailto:MAILTO: mailto:dee@example.com'), ['ana', 'bo', 'cy', 'dee']],
  ['an addition of *, with spaces or mailto:, beside a guest', add(' * ', 'mailto:*', 'mailto: *', 'dee@example.com'), ['ana', 'bo', 'cy', 'dee']],
  ['an empty addition beside a guest', add('', '   ', 'mailto:', 'dee@example.com'), ['ana', 'bo', 'cy', 'dee']],
  ['a new guest keeps the case their address was written in', add('Dee.Lee@example.com'), ['ana', 'bo', 'cy', 'Dee.Lee']],
  ['two guests added, in the order given', add('eve@example.com', 'dee@example.com'), ['ana', 'bo', 'cy', 'eve', 'dee']],
  ['a guest removed', remove('bo@example.com'), ['ana', 'cy']],
  ['a guest removed in capitals', remove('BO@EXAMPLE.COM'), ['ana', 'cy']],
  ['a guest removed with mailto: and spaces', remove(' MAILTO:bo@example.com '), ['ana', 'cy']],
  ['a guest removed with a space after mailto:', remove('mailto: bo@example.com'), ['ana', 'cy']],
  ['a guest removed with mailto: twice', remove('mailto:mailto:bo@example.com'), ['ana', 'cy']],
  ['a guest removed twice', remove('bo@example.com', 'Bo@example.com'), ['ana', 'cy']],
  ['a removal of someone who is not a guest, beside a guest', remove('zed@example.com', 'bo@example.com'), ['ana', 'cy']],
  ['everyone removed', remove('*'), []],
  ['everyone removed, with spaces', remove(' * '), []],
  ['a removal of mailto:*, which names no one, beside a guest', remove('mailto:*', 'bo@example.com'), ['ana', 'cy']],
  ['a removal of mailto: *, which names no one, beside a guest', remove('mailto: *', 'bo@example.com'), ['ana', 'cy']],
  ['a guest removed and added in one edit', { ...remove('bo@example.com'), ...add('bo@example.com') }, ['ana', 'cy', 'bo']],
  ['a guest removed and another added', { ...remove('bo@example.com'), ...add('dee@example.com') }, ['ana', 'cy', 'dee']],
  ['everyone removed and a guest added', { ...remove('*'), ...add('dee@example.com') }, ['dee']],
  ['everyone removed and a former guest added', { ...remove('*', 'ana@example.com'), ...add('ana@example.com') }, ['ana']],
];
const START = ['ana', 'bo', 'cy'];
const all = () => START.map((n) => guest(n));

for (const scopeName of Object.keys(SCOPES)) {
  describe(`a guest change, ${scopeName}: every item the edit covers ends with the same guests`, () => {
    for (const [name, change, left] of CHANGES) {
      it(name, async () => {
        const { sess, items, schemaErrors: errors } = await edit(scopeName, all(), all(), change);
        expect(errors).toEqual([]);
        expect(sess.failReason).toBeUndefined();
        for (const it of [...items.main, ...items.own]) expect(ids(it)).toEqual(left.map(mail));
        for (const it of items.untouched) expect(ids(it)).toEqual(START.map(mail));
      });
    }

    it('a guest added with a name carries the name; those who stay keep their stored name and answer', async () => {
      const change = { add_attendees: [{ email: 'dee@example.com', name: 'Dee' }, { email: 'bo@example.com', name: 'Robert' }] };
      const { sess, items } = await edit(scopeName, all(), all(), change);
      expect(sess.failReason).toBeUndefined();
      for (const it of [...items.main, ...items.own]) {
        expect(it.getAttendees().map((a) => [a.id, a.commonName, a.participationStatus, a.rsvp])).toEqual([
          [mail('ana'), 'Ana', 'ACCEPTED', 'FALSE'], [mail('bo'), 'Bo', 'ACCEPTED', 'FALSE'], [mail('cy'), 'Cy', 'ACCEPTED', 'FALSE'],
          [mail('dee'), 'Dee', 'NEEDS-ACTION', 'TRUE'],
        ]);
      }
    });

    // A guest the change removes and adds back is still the guest who was
    // there: the stored entry, answer and name included, not a new one.
    for (const [name, change, left] of [
      ['a guest removed and added in one edit', { ...remove('bo@example.com'), add_attendees: [{ email: 'BO@example.com', name: 'Robert' }] }, ['ana', 'cy', 'bo']],
      ['everyone removed and the list restated with a new guest', { ...remove('*'), ...add('cy@example.com', 'dee@example.com', 'ana@example.com') }, ['cy', 'dee', 'ana']],
    ]) {
      it(`${name} keeps the stored entry of each guest who was there`, async () => {
        const { sess, items } = await edit(scopeName, all(), all(), change);
        expect(sess.failReason).toBeUndefined();
        const entry = (n) => (NAMES[n] ? [mail(n), NAMES[n], 'ACCEPTED', 'FALSE'] : [mail(n), null, 'NEEDS-ACTION', 'TRUE']);
        for (const it of [...items.main, ...items.own]) {
          expect(it.getAttendees().map((a) => [a.id, a.commonName ?? null, a.participationStatus, a.rsvp])).toEqual(left.map(entry));
        }
      });
    }

    // A stored address is matched however it was stored: in capitals, with a
    // space after mailto:, or with mailto: repeated.
    for (const stored of ['mailto:Bo@Example.com', 'mailto: bo@example.com', 'mailto:mailto:mailto:bo@example.com', 'MAILTO:BO@EXAMPLE.COM']) {
      const withStored = () => [guest('ana'), guest('bo', stored), guest('cy')];
      it(`a guest stored as "${stored}" is removed by the plain address`, async () => {
        const { sess, items } = await edit(scopeName, withStored(), withStored(), remove('bo@example.com'));
        expect(sess.failReason).toBeUndefined();
        for (const it of [...items.main, ...items.own]) expect(ids(it)).toEqual([mail('ana'), mail('cy')]);
      });
      it(`a guest stored as "${stored}" is not added a second time, and keeps the stored entry`, async () => {
        const { sess, items } = await edit(scopeName, withStored(), withStored(), add('bo@example.com', 'dee@example.com'));
        expect(sess.failReason).toBeUndefined();
        for (const it of [...items.main, ...items.own]) {
          expect(it.getAttendees().map((a) => [a.id, a.participationStatus])).toEqual([
            [mail('ana'), 'ACCEPTED'], [stored, 'ACCEPTED'], [mail('cy'), 'ACCEPTED'], [mail('dee'), 'NEEDS-ACTION'],
          ]);
        }
      });
    }
  });
}

// The series has Ana and Bo; the occurrence changed on its own dropped Bo and
// added Cy. A change is made on each list as it stands.
describe('an occurrence with guests of its own keeps its own differences', () => {
  const OWN_ROWS = [
    ['adding a guest', add('dee@example.com'), ['ana', 'bo', 'dee'], ['ana', 'cy', 'dee']],
    ['removing a guest only that occurrence has', remove('cy@example.com'), ['ana', 'bo'], ['ana']],
    ['adding back a guest that occurrence removed on its own', add('bo@example.com'), ['ana', 'bo'], ['ana', 'cy', 'bo']],
    ['adding a guest that occurrence already has', add('cy@example.com'), ['ana', 'bo', 'cy'], ['ana', 'cy']],
    ['removing everyone', remove('*'), [], []],
  ];
  for (const scopeName of Object.keys(SCOPES).filter((n) => /changed/.test(n) && !/not changed/.test(n) || n === 'the whole series')) {
    for (const [name, change, seriesLeft, occurrenceLeft] of OWN_ROWS) {
      it(`${name} (${scopeName})`, async () => {
        const { sess, items, schemaErrors: errors } = await edit(scopeName, [guest('ana'), guest('bo')], [guest('ana'), guest('cy')], change);
        expect(errors).toEqual([]);
        expect(sess.failReason).toBeUndefined();
        expect(items.own).toHaveLength(1);
        for (const it of items.main) expect(ids(it)).toEqual(seriesLeft.map(mail));
        for (const it of items.own) expect(ids(it)).toEqual(occurrenceLeft.map(mail));
        for (const it of items.untouched) expect(ids(it)).toEqual(['ana', 'bo'].map(mail));
      });
    }

    it(`those who stay keep their answer, and the new guest has none (${scopeName})`, async () => {
      const declined = fakeAttendee({ id: mail('cy'), participationStatus: 'DECLINED', rsvp: 'FALSE' });
      const { items } = await edit(scopeName, [guest('ana'), guest('bo')], [guest('ana'), declined], add('dee@example.com'));
      expect(items.own).toHaveLength(1);
      expect(items.own[0].getAttendees().map((a) => [a.id, a.participationStatus])).toEqual([
        [mail('ana'), 'ACCEPTED'], [mail('cy'), 'DECLINED'], [mail('dee'), 'NEEDS-ACTION'],
      ]);
    });
  }
});

describe('sending invitations with an edit', () => {
  for (const scopeName of Object.keys(SCOPES)) {
    it(`an event with guests is edited without the guests restated (${scopeName})`, async () => {
      const { sess, schemaErrors: errors } = await edit(scopeName, all(), all(), { ...add('dee@example.com'), send_invitations: true });
      expect(errors).toEqual([]);
      expect(sess.failReason).toBeUndefined();
    });
  }

  // The list read is the edited item's own, after the change. Here the series
  // has guests and the occurrence changed before has none of its own left, or
  // the reverse.
  for (const scopeName of Object.keys(SCOPES)) {
    it(`an edit that ends with no guests is refused, and nothing is written (${scopeName})`, async () => {
      const { sess, loaded } = await edit(scopeName, all(), all(), { ...remove('*'), send_invitations: true });
      expect(sess.failReason).toMatch(/send_invitations/);
      expect(loaded.modifications).toHaveLength(0);
      expect(loaded.calendar.items).toHaveLength(1);
      expect(ids(loaded.calendar.items[0])).toEqual(START.map(mail));
    });

    it(`an edit that adds the first guest is made (${scopeName})`, async () => {
      const { sess, items } = await edit(scopeName, [], [], { ...add('dee@example.com'), send_invitations: true });
      expect(sess.failReason).toBeUndefined();
      for (const it of [...items.main, ...items.own]) expect(ids(it)).toEqual([mail('dee')]);
    });
  }

  it('one occurrence with no guests of its own is refused, though its series has guests', async () => {
    const { sess, loaded } = await edit('one occurrence, changed before', all(), [], { title: 'Review', send_invitations: true });
    expect(sess.failReason).toMatch(/send_invitations/);
    expect(loaded.modifications).toHaveLength(0);
  });

  it('one occurrence with guests of its own is edited, though its series has none', async () => {
    const { sess, items } = await edit('one occurrence, changed before', [], all(), { title: 'Review', send_invitations: true });
    expect(sess.failReason).toBeUndefined();
    expect(items.own[0].title).toBe('Review');
  });

  // #302: invitations go to the guests the event already has. An edit that
  // names no guest at all is made on every scope, and leaves the guests as
  // they were.
  it('an edit that names no guest sends invitations to the guests the event has, on every scope', async () => {
    for (const scopeName of Object.keys(SCOPES)) {
      const { sess, items, schemaErrors: errors } = await edit(scopeName, all(), all(), { title: 'Review', send_invitations: true });
      expect(errors, scopeName).toEqual([]);
      expect(sess.failReason, scopeName).toBeUndefined();
      const edited = [...items.main, ...items.own];
      expect(edited.length, scopeName).toBeGreaterThan(0);
      for (const it of edited) {
        expect(it.title, scopeName).toBe('Review');
        expect(ids(it), scopeName).toEqual(START.map(mail));
      }
    }
  });

  it('an edit that restates no guest is made when the event has guests', async () => {
    const { sess, items } = await edit('a one-off event', all(), all(), { title: 'Review', send_invitations: true });
    expect(sess.failReason).toBeUndefined();
    expect(items.main[0].title).toBe('Review');
  });

  it('an edit that adds the first guest is made', async () => {
    const { sess, items } = await edit('a one-off event', [], [], { ...add('dee@example.com'), send_invitations: true });
    expect(sess.failReason).toBeUndefined();
    expect(ids(items.main[0])).toEqual([mail('dee')]);
  });

  for (const [name, guests, change] of [
    ['an event with no guests', [], { title: 'Review' }],
    ['an edit that removes everyone', all(), remove('*')],
  ]) {
    it(`${name} is refused, and nothing is written`, async () => {
      const { sess, loaded } = await edit('a one-off event', guests, guests, { ...change, send_invitations: true });
      expect(sess.failReason).toMatch(/send_invitations/);
      expect(loaded.modifications).toHaveLength(0);
      expect(ids(loaded.calendar.items[0])).toEqual(guests.map((g) => g.id));
    });
  }
});

// The confirmation card is what the user confirms: it names the people added
// and removed, and shows no count (the lists an edit covers can differ).
describe('the confirmation card for a guest change', () => {
  async function card(change) {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [oneOff(all())] });
    globalThis.browser.tmCalendar = checked(loaded.api, schemaErrors);
    const pid = `pid-card-${nextPid += 1}`;
    ctx.fsmSessions[pid] = { editEventArgs: { event_id: 'ser', calendar_id: 'cal1', ...change } };
    const was = ctx.activePid;
    ctx.activePid = pid;
    streamText.mockClear();
    try {
      await runStateEditCalendarEventList();
    } finally {
      ctx.activePid = was;
    }
    const text = streamText.mock.calls.map((c) => String(c[1])).find((t) => t.includes('Proposed changes:'));
    expect(text).toBeTruthy();
    return String(text).split('Proposed changes:')[1];
  }

  it('names each guest added (by name when given) and each removed', async () => {
    const text = await card({ add_attendees: [{ email: 'dee@example.com', name: 'Dee' }, { email: 'eve@example.com' }], remove_attendees: [{ email: 'bo@example.com' }] });
    expect(text).toContain('**Attendees:**');
    expect(text).toContain('+ Dee');
    expect(text).toContain('+ eve@example.com');
    expect(text).toContain('− bo@example.com');
    expect(text).not.toMatch(/invitee/i);
    expect(text).not.toMatch(/\d+\s*→/);
  });

  it('says when everyone is removed', async () => {
    const text = await card({ remove_attendees: [{ email: '*' }] });
    expect(text).toContain('− (all attendees)');
    expect(text).not.toMatch(/invitee/i);
  });

  it('shows no attendee lines for an edit that changes no guest', async () => {
    const text = await card({ title: 'Review' });
    expect(text).not.toContain('**Attendees:**');
  });
});
