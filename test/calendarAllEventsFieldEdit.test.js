/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarAllEventsFieldEdit.test.js: an "All events" edit (edit_scope "all")
// writes each non-time field it names over every occurrence of the series,
// the occurrences changed on their own included, as Google Calendar's "All
// events" edit does. Through the real bridge (tmCalendar.sys.mjs in node:vm
// over the calendar harness), read back through its own read path
// (queryCalendarItems), the rows the read tools print.
//
// Invariant, for an "all" edit naming fields F: every occurrence the series
// shows reads each field in F as given; every other field of every occurrence
// (its title, place, notes, busy/free) is what that occurrence had before;
// every occurrence keeps its start and end; and the set of occurrences is the
// same (an excluded one stays excluded, none is added).
//
// "this_and_following" does the same over the following part: every changed
// occurrence carried into it takes the fields the split names, and a new place
// asks its attendees again; the earlier part is untouched. Control:
// "this_only" changes one occurrence and no other.
//
// A field the edit only restates (its value is the series' own, or on a split
// the own value of the occurrence it starts at, as the confirmation card
// compares it) is no change: from the edit tool's `run`, through the card,
// into the bridge, the card shows no line for it and an occurrence changed on
// its own keeps its own value.

process.env.TZ = 'America/Vancouver';

import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

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

const { loadCalendarBridge, fakeAttendee, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem } = await import('./helpers/calendarBridgeHarness.js');
const { run: editRun, completeExecution } = await import('../chat/tools/calendar_event_edit.js');
const { runStateEditCalendarEventExec, runStateEditCalendarEventList } = await import('../chat/fsm/calendarEdit.js');
const { streamText } = await import('../chat/modules/helpers.js');
const { ctx } = await import('../chat/modules/context.js');

const bridgeUrl = fileURLToPath(new URL('../chat/experiments/tmCalendar/tmCalendar.sys.mjs', import.meta.url));

// Days relative to today (no hardcoded dates): the series starts a week from
// now and repeats daily at 17:00 for half an hour.
const pad = (n) => String(n).padStart(2, '0');
const dayFromNow = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 7 + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const DAYS = 10;
const FIRST = dayFromNow(0);
const ridValue = (n) => `${dayFromNow(n).replace(/-/g, '')}T170000`;
const naiveAt = (n, hour) => `${dayFromNow(n)}T${pad(hour)}:00:00`;

// The series: daily 17:00 to 17:30 in the user's zone, "Standup" in "Room A",
// with its own notes and busy (`properties` overrides them). `changed` adds
// occurrences changed on their own (each at its slot `n`, with its own fields,
// attendees and, when given, its own times); `excluded` adds EXDATEs at those
// slots.
function series({ changed = [], excluded = [], properties: seriesOwn = {} } = {}) {
  const master = fakeEvent({
    id: 'standup', title: 'Standup',
    startDate: fakeDateTime(FIRST, 17), endDate: fakeDateTime(FIRST, 17, 30),
    properties: { LOCATION: 'Room A', DESCRIPTION: 'Daily notes', TRANSP: 'OPAQUE', ...seriesOwn },
  });
  const exceptions = changed.map(({ n, title = 'Standup', properties = {}, start = [17, 0], end = [17, 30], attendees = [] }) => fakeEvent({
    id: 'standup', title,
    startDate: fakeDateTime(dayFromNow(n), ...start), endDate: fakeDateTime(dayFromNow(n), ...end),
    recurrenceId: fakeDateTime(dayFromNow(n), 17),
    properties: { LOCATION: 'Room A', DESCRIPTION: 'Daily notes', TRANSP: 'OPAQUE', ...properties },
    attendees,
  }));
  master.recurrenceInfo = fakeRecurrenceInfo([
    recurrenceItem('RRULE', 'FREQ=DAILY'),
    ...excluded.map((n) => recurrenceItem('EXDATE', ridValue(n))),
  ], { exceptions });
  master.recurrenceInfo.item = master;
  return master;
}

// Every occurrence the calendar shows over the series' first DAYS days, as the
// bridge's read path prints it, keyed by its slot (RECURRENCE-ID).
async function shown(api) {
  const rows = await api.queryCalendarItems(`${dayFromNow(-1)}T00:00:00`, `${dayFromNow(DAYS)}T00:00:00`, ['cal1']);
  const out = new Map();
  for (const r of rows) {
    out.set(r.recurrenceId, {
      title: r.title, location: r.location, description: r.description, transparency: r.transparency,
      startDate: r.startDate, endDate: r.endDate,
    });
  }
  return out;
}

const FIELDS = ['title', 'location', 'description', 'transparency'];

// Runs `edit` on `master` through the bridge and checks the invariant for the
// fields it names (`named`: field -> value as read back).
async function expectEveryOccurrenceTakes(master, edit, named) {
  const { api } = loadCalendarBridge(bridgeUrl, { items: [master] });
  const before = await shown(api);
  const res = await api.modifyCalendarEvent({ event_id: 'standup', calendar_id: 'cal1', edit_scope: 'all', ...edit });
  expect(res).toMatchObject({ ok: true });
  const after = await shown(api);
  // The same occurrences: none added, an excluded one still excluded.
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [rid, was] of before) {
    const now = after.get(rid);
    for (const f of FIELDS) {
      if (f in named) expect(now[f], `${rid} ${f}`).toBe(named[f]);
      else expect(now[f], `${rid} ${f} (not named)`).toBe(was[f]);
    }
    // Times are never changed by a field edit.
    expect(now.startDate, `${rid} start`).toBe(was.startDate);
    expect(now.endDate, `${rid} end`).toBe(was.endDate);
  }
  return { before, after };
}

describe('"All events" edit: each field it names is written over every occurrence', () => {
  it('one changed occurrence takes the new title', async () => {
    const master = series({ changed: [{ n: 2, properties: { LOCATION: 'Room B' } }] });
    const { before } = await expectEveryOccurrenceTakes(master, { title: 'Team sync' }, { title: 'Team sync' });
    // Not vacuous: the changed occurrence is shown, with its own place kept.
    expect(before.get(ridValue(2)).location).toBe('Room B');
  });

  it('an occurrence whose own title differed takes the new title, and keeps its other own fields', async () => {
    const master = series({ changed: [{ n: 3, title: 'Standup (planning)', properties: { DESCRIPTION: 'Bring the roadmap', TRANSP: 'TRANSPARENT' } }] });
    const { before, after } = await expectEveryOccurrenceTakes(master, { title: 'Team sync' }, { title: 'Team sync' });
    expect(before.get(ridValue(3)).title).toBe('Standup (planning)');
    expect(after.get(ridValue(3))).toMatchObject({ title: 'Team sync', description: 'Bring the roadmap', transparency: 'free' });
  });

  it('several changed occurrences, one at its slot and one moved to its own time, take the new place', async () => {
    const master = series({
      changed: [
        { n: 1, title: 'Standup (short)', end: [17, 15] },
        { n: 4, properties: { LOCATION: 'Room C' }, start: [19, 0], end: [20, 0] },
        { n: 6, title: 'Standup (remote)', properties: { LOCATION: 'Online' } },
      ],
    });
    const { after } = await expectEveryOccurrenceTakes(master, { location: 'Room D' }, { location: 'Room D' });
    // The moved one keeps its own time and title.
    expect(after.get(ridValue(4)).startDate).toBe(`${dayFromNow(4).replace(/-/g, '')}T190000`);
    expect(after.get(ridValue(6)).title).toBe('Standup (remote)');
  });

  it('an edit naming two fields writes both over every occurrence, and leaves the rest', async () => {
    const master = series({
      changed: [
        { n: 2, title: 'Standup (demo)', properties: { LOCATION: 'Room B', DESCRIPTION: 'Demo day' } },
        { n: 5, properties: { TRANSP: 'TRANSPARENT' }, start: [18, 0], end: [18, 30] },
      ],
    });
    await expectEveryOccurrenceTakes(master,
      { title: 'Team sync', description: 'New agenda' },
      { title: 'Team sync', description: 'New agenda' });
  });

  it('busy/free is written over every occurrence', async () => {
    const master = series({ changed: [{ n: 2, title: 'Standup (demo)', properties: { TRANSP: 'OPAQUE' } }, { n: 3, properties: { TRANSP: 'TRANSPARENT' } }] });
    await expectEveryOccurrenceTakes(master, { transparency: 'free' }, { transparency: 'free' });
  });

  it('an excluded occurrence stays excluded, and the changed ones take the edit', async () => {
    const master = series({ changed: [{ n: 2, title: 'Standup (demo)' }, { n: 7, properties: { LOCATION: 'Room B' } }], excluded: [4, 5] });
    const { before, after } = await expectEveryOccurrenceTakes(master, { title: 'Team sync', location: 'Room D' }, { title: 'Team sync', location: 'Room D' });
    for (const n of [4, 5]) {
      expect(before.has(ridValue(n))).toBe(false);
      expect(after.has(ridValue(n))).toBe(false);
    }
    expect(after.size).toBe(DAYS - 2);
  });
});

describe('control: "this_only"', () => {
  it('"this_only" changes the one occurrence it names, and no other', async () => {
    const master = series({ changed: [{ n: 2, title: 'Standup (demo)', properties: { LOCATION: 'Room B' } }] });
    const { api } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const before = await shown(api);
    const res = await api.modifyCalendarEvent({ event_id: 'standup', calendar_id: 'cal1', edit_scope: 'this_only', recurrence_id: naiveAt(3, 17), title: 'Team sync', location: 'Room D' });
    expect(res).toMatchObject({ ok: true });
    const after = await shown(api);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rid, was] of before) {
      if (rid === ridValue(3)) expect(after.get(rid)).toEqual({ ...was, title: 'Team sync', location: 'Room D' });
      else expect(after.get(rid), rid).toEqual(was);
    }
  });
});

// The stored changed occurrence at slot `n` of `item`, and its answers.
const changedAt = (item, n) => {
  const info = item.recurrenceInfo;
  const key = fakeDateTime(dayFromNow(n), 17).toString();
  const rid = (info?.getExceptionIds() || []).find((r) => r.toString() === key);
  return rid ? info.getExceptionFor(rid) : null;
};
const answers = (item) => item.getAttendees().map((a) => [a.id, a.participationStatus]);
const accepted = (name) => fakeAttendee({ id: `mailto:${name}@example.com`, participationStatus: 'ACCEPTED', rsvp: 'FALSE' });

describe('"this_and_following": every changed occurrence carried into the following part takes the fields the split names', () => {
  // Splits at slot 3 a series changed on its own at slot 1 (the earlier part)
  // and slot 5 (carried into the following part, with an attendee who
  // accepted), and checks every occurrence shown.
  async function split(edit, named) {
    const master = series({
      changed: [
        { n: 1, title: 'Standup (demo)', properties: { LOCATION: 'Room B' } },
        { n: 5, title: 'Standup (review)', properties: { LOCATION: 'Room C', DESCRIPTION: 'Review notes' }, attendees: [accepted('ana')] },
      ],
    });
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const before = await shown(api);
    const res = await api.modifyCalendarEvent({ event_id: 'standup', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17), ...edit });
    expect(res, res.error).toMatchObject({ ok: true });
    const after = await shown(api);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rid, was] of before) {
      // The earlier part, its changed occurrence included, is untouched; every
      // occurrence of the following part, plain or changed, takes each field
      // named and keeps the rest.
      if (rid >= ridValue(3)) expect(after.get(rid), rid).toEqual({ ...was, ...named });
      else expect(after.get(rid), rid).toEqual(was);
    }
    // Not vacuous: the carried occurrence had its own title and place.
    expect(before.get(ridValue(5))).toMatchObject({ title: 'Standup (review)', location: 'Room C' });
    const following = calendar.items.find((it) => it.id !== 'standup');
    const carried = changedAt(following, 5);
    expect(carried).toBeTruthy();
    return { carried };
  }

  it('a new title: the carried occurrence takes it, keeps its own place and notes, and its attendees keep their answers', async () => {
    const { carried } = await split({ title: 'Team sync' }, { title: 'Team sync' });
    expect(answers(carried)).toEqual([['mailto:ana@example.com', 'ACCEPTED']]);
  });

  it('a new title and place: the carried occurrence takes both, keeps its own notes, and the new place asks its attendees again', async () => {
    const { carried } = await split({ title: 'Team sync', location: 'Room D' }, { title: 'Team sync', location: 'Room D' });
    expect(carried.getProperty('DESCRIPTION')).toBe('Review notes');
    expect(answers(carried)).toEqual([['mailto:ana@example.com', 'NEEDS-ACTION']]);
  });
});

describe('the HTML copies of an occurrence\'s notes', () => {
  const HTML = { 'X-ALT-DESC': '<p>Old notes</p>', 'X-MOZ-HTML': '<p>Old notes</p>', 'X-MOZ-ALT-DESC': '<p>Old notes</p>' };
  const htmlOf = (ex) => Object.keys(HTML).filter((name) => ex.getProperty(name));
  async function edit(fields) {
    const master = series({ changed: [{ n: 2, title: 'Standup (demo)', properties: { DESCRIPTION: 'Old notes', ...HTML } }] });
    // Not vacuous: the changed occurrence holds all three.
    expect(htmlOf(changedAt(master, 2))).toEqual(Object.keys(HTML));
    const { api, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const res = await api.modifyCalendarEvent({ event_id: 'standup', calendar_id: 'cal1', edit_scope: 'all', ...fields });
    expect(res).toMatchObject({ ok: true });
    return changedAt(calendar.items[0], 2);
  }

  it('go with the notes an "All events" edit replaces on a changed occurrence', async () => {
    const ex = await edit({ description: 'New agenda' });
    expect(ex.getProperty('DESCRIPTION')).toBe('New agenda');
    expect(htmlOf(ex)).toEqual([]);
  });

  it('stay when the edit does not name the notes', async () => {
    const ex = await edit({ title: 'Team sync' });
    expect(ex.title).toBe('Team sync');
    expect(htmlOf(ex)).toEqual(Object.keys(HTML));
  });
});

describe('"All events" edits naming other fields', () => {
  it('busy is written over every occurrence of a free series, a free changed occurrence included', async () => {
    const master = series({ properties: { TRANSP: 'TRANSPARENT' }, changed: [{ n: 2, title: 'Standup (demo)', properties: { TRANSP: 'TRANSPARENT' } }] });
    const { before } = await expectEveryOccurrenceTakes(master, { transparency: 'busy' }, { transparency: 'busy' });
    // Not vacuous: every occurrence was free.
    for (const [rid, was] of before) expect(was.transparency, rid).toBe('free');
  });

  it('a new end and a title: a changed occurrence other than the first takes the title, keeps its own place and its own start', async () => {
    const master = series({ changed: [{ n: 3, title: 'Standup (planning)', properties: { LOCATION: 'Room B' } }] });
    const { api } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const before = await shown(api);
    const res = await api.modifyCalendarEvent({ event_id: 'standup', calendar_id: 'cal1', edit_scope: 'all', end_iso: naiveAt(0, 18), title: 'Team sync' });
    expect(res, res.error).toMatchObject({ ok: true });
    const after = await shown(api);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rid, was] of before) {
      expect(after.get(rid), rid).toMatchObject({ title: 'Team sync', location: was.location, startDate: was.startDate });
    }
    // Not vacuous: the end changed the series, and the occurrence had its own title and place.
    expect(after.get(ridValue(0)).endDate).not.toBe(before.get(ridValue(0)).endDate);
    expect(before.get(ridValue(3))).toMatchObject({ title: 'Standup (planning)', location: 'Room B' });
  });
});

// From the edit tool's `run` (with its check before the card), through the
// confirmation card, into the real bridge: the card is what the user confirms.
describe('a field the edit only restates is no change', () => {
  let nextPid = 0;
  async function confirmEdit(master, edit) {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [master] });
    globalThis.browser.tmCalendar = loaded.api;
    const before = await shown(loaded.api);
    const pid = `pid-restate-${nextPid += 1}`;
    ctx.fsmSessions[pid] = {};
    ctx.state = null;
    streamText.mockClear();
    await editRun({ event_id: 'standup', calendar_id: 'cal1', ...edit }, { callId: pid });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ctx.fsmSessions[pid];
    expect(sess.failReason).toBeUndefined();
    const was = ctx.activePid;
    ctx.activePid = pid;
    try {
      await runStateEditCalendarEventList();
      await runStateEditCalendarEventExec();
    } finally {
      ctx.activePid = was;
    }
    expect(sess.failReason).toBeUndefined();
    const text = streamText.mock.calls.map((c) => String(c[1])).find((t) => t.includes('Proposed changes:'));
    expect(text).toBeTruthy();
    return { card: String(text).split('Proposed changes:')[1], before, after: await shown(loaded.api), calendar: loaded.calendar };
  }
  const withOwnPlace = () => series({ changed: [{ n: 2, title: 'Standup (demo)', properties: { LOCATION: 'Room B' } }] });

  it('"All events" restating the series\' place with new notes: the card shows the notes alone, and the changed occurrence keeps its own place', async () => {
    const { card, before, after } = await confirmEdit(withOwnPlace(), { edit_scope: 'all', description: 'Bring updates', location: 'Room A' });
    expect(card).toContain('**Description:**');
    expect(card).not.toContain('**Location:**');
    expect(before.get(ridValue(2)).location).toBe('Room B');
    for (const [rid, was] of before) expect(after.get(rid), rid).toEqual({ ...was, description: 'Bring updates' });
  });

  it('"All events" giving a new place: the card shows it, and every occurrence takes it, the changed one included', async () => {
    const { card, before, after } = await confirmEdit(withOwnPlace(), { edit_scope: 'all', location: 'Room C' });
    expect(card).toContain('**Location:**');
    expect(card).toContain('Room C');
    for (const [rid, was] of before) expect(after.get(rid), rid).toEqual({ ...was, location: 'Room C' });
  });

  it('"All events" restating the place alone: no card is shown, nothing is written, and the assistant is told nothing changed', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [withOwnPlace()] });
    globalThis.browser.tmCalendar = loaded.api;
    const before = await shown(loaded.api);
    const pid = `pid-restate-${nextPid += 1}`;
    ctx.fsmSessions[pid] = {};
    ctx.state = null;
    streamText.mockClear();
    await editRun({ event_id: 'standup', calendar_id: 'cal1', edit_scope: 'all', location: 'Room A' }, { callId: pid });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ctx.fsmSessions[pid];
    expect(sess.failReason).toBeUndefined();
    expect(sess.editEventArgs).toBeUndefined();
    expect(ctx.state).toBe('exec_success');
    expect(streamText.mock.calls.some((c) => String(c[1]).includes('Proposed changes:'))).toBe(false);
    const was = ctx.activePid;
    ctx.activePid = pid;
    try {
      expect(await completeExecution(ctx.state, sess.fsmPrevState)).toMatchObject({ ok: true, result: expect.stringMatching(/^Nothing changed/) });
    } finally {
      ctx.activePid = was;
    }
    expect(loaded.modifications).toEqual([]);
    expect(await shown(loaded.api)).toEqual(before);
  });

  it('"All events" restating the series\' title with new notes: the changed occurrence keeps its own title, and the card shows no Title line', async () => {
    const { card, before, after } = await confirmEdit(withOwnPlace(), { edit_scope: 'all', title: 'Standup', description: 'Bring updates' });
    expect(card).not.toContain('**Title:**');
    expect(card).toContain('**Description:**');
    expect(before.get(ridValue(2)).title).toBe('Standup (demo)');
    for (const [rid, was] of before) expect(after.get(rid), rid).toEqual({ ...was, description: 'Bring updates' });
  });

  it('"All events" restating busy with new notes: a changed occurrence that is free stays free, and the card shows no Transparency line', async () => {
    const master = series({ changed: [{ n: 2, title: 'Standup (demo)', properties: { TRANSP: 'TRANSPARENT' } }] });
    const { card, before, after } = await confirmEdit(master, { edit_scope: 'all', transparency: 'busy', description: 'Bring updates' });
    expect(card).not.toContain('**Transparency:**');
    expect(before.get(ridValue(2)).transparency).toBe('free');
    for (const [rid, was] of before) expect(after.get(rid), rid).toEqual({ ...was, description: 'Bring updates' });
  });

  it('"All events" restating the series\' notes with a new title: a changed occurrence keeps its own notes, and the card shows no Description line', async () => {
    const master = series({ changed: [{ n: 2, title: 'Standup (demo)', properties: { DESCRIPTION: 'Demo prep' } }] });
    const { card, before, after } = await confirmEdit(master, { edit_scope: 'all', title: 'Team sync', description: 'Daily notes' });
    expect(card).toContain('**Title:**');
    expect(card).not.toContain('**Description:**');
    expect(before.get(ridValue(2)).description).toBe('Demo prep');
    for (const [rid, was] of before) expect(after.get(rid), rid).toEqual({ ...was, title: 'Team sync' });
  });

  it('"All events" giving new notes: every occurrence takes them, the changed one included, and the card shows the series\' notes as the old ones', async () => {
    const master = series({ changed: [{ n: 2, title: 'Standup (demo)', properties: { DESCRIPTION: 'Demo prep' } }] });
    const { card, before, after } = await confirmEdit(master, { edit_scope: 'all', description: 'New agenda' });
    expect(card).toContain('Daily notes → **New agenda**');
    for (const [rid, was] of before) expect(after.get(rid), rid).toEqual({ ...was, description: 'New agenda' });
  });

  it('"this_only" setting an occurrence that has its own place back to the series\' place: that occurrence takes it, and nothing else changes', async () => {
    const { before, after } = await confirmEdit(withOwnPlace(), { edit_scope: 'this_only', recurrence_id: naiveAt(2, 17), location: 'Room A' });
    expect(before.get(ridValue(2)).location).toBe('Room B');
    for (const [rid, was] of before) {
      expect(after.get(rid), rid).toEqual(rid === ridValue(2) ? { ...was, location: 'Room A' } : was);
    }
  });

  it('an edit naming a field, when the event cannot be read for the card, is refused before the card and writes nothing', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [withOwnPlace()] });
    globalThis.browser.tmCalendar = { ...loaded.api, getCalendarEventDetails: async () => ({ ok: false, error: 'read failed' }) };
    const before = await shown(loaded.api);
    const pid = `pid-restate-${nextPid += 1}`;
    ctx.fsmSessions[pid] = {};
    await editRun({ event_id: 'standup', calendar_id: 'cal1', edit_scope: 'all', location: 'Room C' }, { callId: pid });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ctx.fsmSessions[pid];
    expect(sess.failReason).toBe('could not read this event (read failed); try again');
    expect(sess.editEventArgs).toBeUndefined();
    expect(await shown(loaded.api)).toEqual(before);
  });

  it('"this_and_following" restating the series\' place with a new title: the carried changed occurrence takes the title and keeps its own place', async () => {
    const master = series({ changed: [{ n: 5, title: 'Standup (review)', properties: { LOCATION: 'Room C' } }] });
    const { card, before, after } = await confirmEdit(master, { edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17), title: 'Team sync', location: 'Room A' });
    expect(card).toContain('**Title:**');
    expect(card).not.toContain('**Location:**');
    for (const [rid, was] of before) {
      expect(after.get(rid), rid).toEqual(rid >= ridValue(3) ? { ...was, title: 'Team sync' } : was);
    }
    expect(after.get(ridValue(5)).location).toBe('Room C');
  });

  // The split names an occurrence: the comparison reads that occurrence's own
  // fields, so "from this one on, back in Room A" at an occurrence moved to
  // Room B on its own is a change.
  it('"this_and_following" at an occurrence with its own place, back to the series\' place: it and every carried occurrence take it, and their attendees are asked again', async () => {
    // Daily "Standup" in Room A; slots 3, 4 and 5 were each moved to Room B on
    // their own; the split is at slot 3.
    const roomB = (n) => ({ n, properties: { LOCATION: 'Room B' }, attendees: [accepted('ana')] });
    const master = series({ changed: [roomB(3), roomB(4), roomB(5)] });
    master.addAttendee(accepted('bo'));
    const { card, before, after, calendar } = await confirmEdit(master, { edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17), location: 'Room A' });
    expect(card).toContain('Room B → **Room A**');
    for (const n of [3, 4, 5]) expect(before.get(ridValue(n)).location, `slot ${n}`).toBe('Room B');
    for (const [rid, was] of before) {
      expect(after.get(rid), rid).toEqual(rid >= ridValue(3) ? { ...was, location: 'Room A' } : was);
    }
    // The plain occurrences of the following part keep their place, so their
    // attendees keep their answers; each moved back to Room A is asked again.
    const following = calendar.items.find((it) => it.id !== 'standup');
    expect(answers(following)).toEqual([['mailto:bo@example.com', 'ACCEPTED']]);
    for (const n of [3, 4, 5]) {
      const carried = changedAt(following, n);
      expect(carried, `slot ${n}`).toBeTruthy();
      expect(answers(carried), `slot ${n}`).toEqual([['mailto:ana@example.com', 'NEEDS-ACTION']]);
    }
  });

  it('"this_and_following" at an occurrence with its own notes: the card shows its notes as the old ones', async () => {
    const master = series({ changed: [{ n: 3, title: 'Standup (planning)', properties: { DESCRIPTION: 'Planning notes' } }] });
    const { card, before, after } = await confirmEdit(master, { edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17), description: 'New agenda' });
    expect(card).toContain('Planning notes → **New agenda**');
    for (const [rid, was] of before) {
      expect(after.get(rid), rid).toEqual(rid >= ridValue(3) ? { ...was, description: 'New agenda' } : was);
    }
  });

  // An "All events" edit compares with the series even when the call names an
  // occurrence: reading that occurrence's own values instead would keep a
  // restated series value and write it over every changed occurrence.
  it('"All events" naming an occurrence with its own place, restating the series\' place with new notes: the card shows no Location line, and every changed occurrence keeps its own place', async () => {
    const { card, before, after } = await confirmEdit(withOwnPlace(), { edit_scope: 'all', recurrence_id: naiveAt(2, 17), location: 'Room A', description: 'Bring updates' });
    expect(card).not.toContain('**Location:**');
    expect(card).toContain('Daily notes → **Bring updates**');
    expect(before.get(ridValue(2)).location).toBe('Room B');
    for (const [rid, was] of before) expect(after.get(rid), rid).toEqual({ ...was, description: 'Bring updates' });
  });

  // A split compares with the occurrence it starts at: restating that
  // occurrence's own title, place and busy/free is no change, so the following
  // plain occurrences keep the series' values and their answers, and the
  // changed ones keep their own.
  const ownAtSplit = () => {
    const master = series({
      changed: [
        { n: 3, title: 'Standup (planning)', properties: { LOCATION: 'Room B', TRANSP: 'TRANSPARENT' }, attendees: [accepted('ana')] },
        { n: 5, title: 'Standup (review)', properties: { LOCATION: 'Room C', TRANSP: 'TRANSPARENT' }, attendees: [accepted('ana')] },
      ],
    });
    master.addAttendee(accepted('bo'));
    return master;
  };

  it('"this_and_following" at an occurrence restating its own title, place and busy/free with new notes: only the notes change', async () => {
    const { card, before, after, calendar } = await confirmEdit(ownAtSplit(), {
      edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17),
      title: 'Standup (planning)', location: 'Room B', transparency: 'free', description: 'New agenda',
    });
    expect(card).not.toContain('**Title:**');
    expect(card).not.toContain('**Location:**');
    expect(card).not.toContain('**Transparency:**');
    expect(card).toContain('Daily notes → **New agenda**');
    // Not vacuous: the occurrence the split starts at had its own values, the
    // plain ones the series'.
    expect(before.get(ridValue(3))).toMatchObject({ title: 'Standup (planning)', location: 'Room B', transparency: 'free' });
    expect(before.get(ridValue(4))).toMatchObject({ title: 'Standup', location: 'Room A', transparency: 'busy' });
    for (const [rid, was] of before) {
      expect(after.get(rid), rid).toEqual(rid >= ridValue(3) ? { ...was, description: 'New agenda' } : was);
    }
    const following = calendar.items.find((it) => it.id !== 'standup');
    expect(answers(following)).toEqual([['mailto:bo@example.com', 'ACCEPTED']]);
    for (const n of [3, 5]) expect(answers(changedAt(following, n)), `slot ${n}`).toEqual([['mailto:ana@example.com', 'ACCEPTED']]);
  });

  it('"this_and_following" at an occurrence with its own title and busy/free, given the series\' title and busy: it and every carried occurrence take them', async () => {
    const { card, before, after } = await confirmEdit(ownAtSplit(), {
      edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17), title: 'Standup', transparency: 'busy',
    });
    expect(card).toContain('Standup (planning) → **Standup**');
    expect(card).toContain('**Transparency:**');
    for (const [rid, was] of before) {
      expect(after.get(rid), rid).toEqual(rid >= ridValue(3) ? { ...was, title: 'Standup', transparency: 'busy' } : was);
    }
    for (const n of [3, 5]) expect(after.get(ridValue(n)), `slot ${n}`).toMatchObject({ title: 'Standup', transparency: 'busy' });
  });
});
