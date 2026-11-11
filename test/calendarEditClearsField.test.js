/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEditClearsField.test.js: an edit that gives an empty location or
// empty notes ("") removes them, on every scope. From the edit tool's `run`
// (with its check before the card), through the confirmation card, into the
// real bridge (tmCalendar.sys.mjs in node:vm over the calendar harness), read
// back through the bridge's own read path (queryCalendarItems), as the read
// tools print it, and through the tool's result to the assistant.
//
// Invariant, for an edit giving "" for a field F (location or description):
// - every occurrence the edit covers reads F as empty, and the stored item
//   holds no F property (for the notes, no HTML copy either: Thunderbird shows
//   X-ALT-DESC over DESCRIPTION);
// - every other field, and every occurrence the edit does not cover, reads as
//   before;
// - the card the user confirms shows a line for F with its old value;
// - the result the assistant reports (ok, "modified successfully") matches
//   what was stored: a success is never reported over a field left as it was.
//
// The empty value is how a clear is expressed on this tool: the schema's
// "Omit to keep existing" makes omission the keep, the bridge writes a string
// field as given (Thunderbird's setProperty deletes an empty value), and the
// iOS app on the same schema clears on "".

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

const { loadCalendarBridge, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem } = await import('./helpers/calendarBridgeHarness.js');
const { run: editRun, completeExecution } = await import('../chat/tools/calendar_event_edit.js');
const { runStateEditCalendarEventExec, runStateEditCalendarEventList } = await import('../chat/fsm/calendarEdit.js');
const { streamText } = await import('../chat/modules/helpers.js');
const { ctx } = await import('../chat/modules/context.js');

const bridgeUrl = fileURLToPath(new URL('../chat/experiments/tmCalendar/tmCalendar.sys.mjs', import.meta.url));

// Days relative to today (no hardcoded dates): events start a week from now.
const pad = (n) => String(n).padStart(2, '0');
const dayFromNow = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 7 + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const DAYS = 10;
const ridValue = (n) => `${dayFromNow(n).replace(/-/g, '')}T170000`;
const naiveAt = (n, hour) => `${dayFromNow(n)}T${pad(hour)}:00:00`;

const HTML = { 'X-ALT-DESC': '<p>Bring the forms</p>', 'X-MOZ-HTML': 'true', 'X-MOZ-ALT-DESC': '<p>Bring the forms</p>' };

// A one-off event: "Checkup" at 10:00 for an hour, in "Room A", with notes.
function oneOff(properties = {}) {
  return fakeEvent({
    id: 'checkup', title: 'Checkup',
    startDate: fakeDateTime(dayFromNow(0), 10), endDate: fakeDateTime(dayFromNow(0), 11),
    properties: { LOCATION: 'Room A', DESCRIPTION: 'Bring the forms', TRANSP: 'OPAQUE', ...properties },
  });
}

// A series: daily "Standup" 17:00 to 17:30 in "Room A", with notes; `changed`
// adds occurrences changed on their own, each at its slot `n` with its own
// fields. A property given as null is not stored (an empty field).
function withoutNulls(ev, properties) {
  for (const [k, v] of Object.entries(properties)) if (v === null) ev.deleteProperty(k);
  return ev;
}
function series({ changed = [], properties: own = {} } = {}) {
  const masterProperties = { LOCATION: 'Room A', DESCRIPTION: 'Daily notes', TRANSP: 'OPAQUE', ...own };
  const master = withoutNulls(fakeEvent({
    id: 'standup', title: 'Standup',
    startDate: fakeDateTime(dayFromNow(0), 17), endDate: fakeDateTime(dayFromNow(0), 17, 30),
    properties: masterProperties,
  }), masterProperties);
  const exceptions = changed.map(({ n, title = 'Standup', properties = {} }) => {
    const all = { ...masterProperties, ...properties };
    return withoutNulls(fakeEvent({
      id: 'standup', title,
      startDate: fakeDateTime(dayFromNow(n), 17), endDate: fakeDateTime(dayFromNow(n), 17, 30),
      recurrenceId: fakeDateTime(dayFromNow(n), 17),
      properties: all,
    }), all);
  });
  master.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')], { exceptions });
  master.recurrenceInfo.item = master;
  return master;
}

// Every item the calendar shows over the first DAYS days, as the bridge's read
// path prints it, keyed by its slot (RECURRENCE-ID; a split's following part
// is a new series whose occurrences keep their slots), or by its id for a
// one-off event.
async function shown(api) {
  const rows = await api.queryCalendarItems(`${dayFromNow(-1)}T00:00:00`, `${dayFromNow(DAYS)}T00:00:00`, ['cal1']);
  const out = new Map();
  for (const r of rows) {
    out.set(r.recurrenceId || r.id, {
      title: r.title, location: r.location, description: r.description, transparency: r.transparency,
      startDate: r.startDate, endDate: r.endDate,
    });
  }
  return out;
}
const oneOffKey = 'checkup';
const slotKey = (n) => ridValue(n);

// From the edit tool's `run`, through the card the user confirms, into the
// bridge; returns the card, what the calendar shows before and after, the
// stored items and the tool's result to the assistant.
let nextPid = 0;
async function confirmEdit(item, edit) {
  const loaded = loadCalendarBridge(bridgeUrl, { items: [item] });
  globalThis.browser.tmCalendar = loaded.api;
  const before = await shown(loaded.api);
  const pid = `pid-clear-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  streamText.mockClear();
  await editRun({ event_id: item.id, calendar_id: 'cal1', ...edit }, { callId: pid });
  await new Promise((r) => setTimeout(r, 5));
  const sess = ctx.fsmSessions[pid];
  expect(sess.failReason).toBeUndefined();
  const was = ctx.activePid;
  ctx.activePid = pid;
  let reported;
  try {
    await runStateEditCalendarEventList();
    await runStateEditCalendarEventExec();
    reported = await completeExecution(ctx.state, 'calendar_event_edit_exec');
  } finally {
    ctx.activePid = was;
  }
  expect(sess.failReason).toBeUndefined();
  const text = streamText.mock.calls.map((c) => String(c[1])).find((t) => t.includes('Proposed changes:'));
  expect(text).toBeTruthy();
  return { card: String(text).split('Proposed changes:')[1], before, after: await shown(loaded.api), stored: loaded.calendar.items, reported };
}

// The tool reported the edit as made.
function expectReportedDone(reported) {
  expect(reported).toMatchObject({ ok: true });
  expect(reported.result).toContain('modified successfully');
}

describe('a one-off event: "" removes the location or the notes', () => {
  it('location "": the event has no location, the card shows the old one going, and the reported success matches the calendar', async () => {
    const { card, before, after, stored, reported } = await confirmEdit(oneOff(), { location: '' });
    expectReportedDone(reported);
    // Not vacuous: the event had a place.
    expect(before.get(oneOffKey).location).toBe('Room A');
    expect(after.get(oneOffKey)).toEqual({ ...before.get(oneOffKey), location: '' });
    expect(stored[0].getProperty('LOCATION')).toBeNull();
    expect(card).toMatch(/\*\*Location:\*\*\n\s+Room A → \*\*\(cleared\)\*\*/);
  });

  it('description "": the event has no notes, the card shows the old ones going, and the reported success matches the calendar', async () => {
    const { card, before, after, stored, reported } = await confirmEdit(oneOff(), { description: '' });
    expectReportedDone(reported);
    expect(before.get(oneOffKey).description).toBe('Bring the forms');
    expect(after.get(oneOffKey)).toEqual({ ...before.get(oneOffKey), description: '' });
    expect(stored[0].getProperty('DESCRIPTION')).toBeNull();
    expect(card).toMatch(/\*\*Description:\*\*\n\s+Bring the forms → \*\*\(cleared\)\*\*/);
  });

  it('description "" on notes with HTML copies: no copy is left for Thunderbird to show', async () => {
    const { after, stored, reported } = await confirmEdit(oneOff(HTML), { description: '' });
    expectReportedDone(reported);
    expect(after.get(oneOffKey).description).toBe('');
    for (const name of ['DESCRIPTION', ...Object.keys(HTML)]) expect(stored[0].getProperty(name), name).toBeNull();
  });

  it('a new title with location "": both are made, and the card shows both', async () => {
    const { card, before, after, stored, reported } = await confirmEdit(oneOff(), { title: 'Checkup (follow-up)', location: '' });
    expectReportedDone(reported);
    expect(after.get(oneOffKey)).toEqual({ ...before.get(oneOffKey), title: 'Checkup (follow-up)', location: '' });
    expect(stored[0].getProperty('LOCATION')).toBeNull();
    expect(card).toContain('**Title:**');
    expect(card).toMatch(/\*\*Location:\*\*\n\s+Room A → /);
  });

  it('control: a new location is written, so the harness sees a field edit', async () => {
    const { card, before, after, reported } = await confirmEdit(oneOff(), { location: 'Room C' });
    expectReportedDone(reported);
    expect(after.get(oneOffKey)).toEqual({ ...before.get(oneOffKey), location: 'Room C' });
    expect(card).toContain('Room A → **Room C**');
  });
});

describe('a repeating event: "" removes the field from every occurrence the edit covers', () => {
  it('"All events", location "": every occurrence has no location, one with its own place included', async () => {
    const master = series({ changed: [{ n: 2, title: 'Standup (demo)', properties: { LOCATION: 'Room B' } }] });
    const { card, before, after, reported } = await confirmEdit(master, { edit_scope: 'all', location: '' });
    expectReportedDone(reported);
    expect(before.get(slotKey(2)).location).toBe('Room B');
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, was] of before) expect(after.get(key), key).toEqual({ ...was, location: '' });
    expect(card).toMatch(/\*\*Location:\*\*\n\s+Room A → /);
  });

  it('"All events", description "": every occurrence has no notes', async () => {
    const master = series({ changed: [{ n: 3, properties: { DESCRIPTION: 'Demo prep' } }] });
    const { before, after, reported } = await confirmEdit(master, { edit_scope: 'all', description: '' });
    expectReportedDone(reported);
    for (const [key, was] of before) expect(after.get(key), key).toEqual({ ...was, description: '' });
  });

  it('"this_only", location "": that occurrence has no location, and no other changes', async () => {
    const { before, after, reported } = await confirmEdit(series(), { edit_scope: 'this_only', recurrence_id: naiveAt(2, 17), location: '' });
    expectReportedDone(reported);
    for (const [key, was] of before) {
      expect(after.get(key), key).toEqual(key === slotKey(2) ? { ...was, location: '' } : was);
    }
  });

  it('"this_and_following", location "": that occurrence and every later one have no location, the earlier ones keep it', async () => {
    const { before, after, stored, reported } = await confirmEdit(series(), { edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17), location: '' });
    expectReportedDone(reported);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, was] of before) {
      expect(after.get(key), key).toEqual(key >= slotKey(3) ? { ...was, location: '' } : was);
    }
    // The following part, a new series, holds no location.
    const following = stored.find((it) => it.id !== 'standup');
    expect(following).toBeTruthy();
    expect(following.getProperty('LOCATION')).toBeNull();
  });
});

// Guards for the one comparison (restatedFields): "" over a field that is
// already empty only restates it, so the card shows no line for it and the
// write changes nothing for it.
describe('"" over a location that is already empty is no change', () => {
  it('"All events": no Location line, and an occurrence with its own place keeps it', async () => {
    const master = series({ properties: { LOCATION: null }, changed: [{ n: 2, properties: { LOCATION: 'Room B' } }] });
    const { card, before, after, reported } = await confirmEdit(master, { edit_scope: 'all', title: 'Standup (new)', location: '' });
    expectReportedDone(reported);
    // Not vacuous: the series has no place, one occurrence has its own.
    expect(before.get(slotKey(1)).location).toBe('');
    expect(before.get(slotKey(2)).location).toBe('Room B');
    expect(card).toContain('**Title:**');
    expect(card).not.toContain('**Location:**');
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, was] of before) expect(after.get(key), key).toEqual({ ...was, title: 'Standup (new)' });
  });

  it('a split at an occurrence with no place of its own: "" is restated there, and the later ones keep the series\' place', async () => {
    const master = series({ changed: [{ n: 3, properties: { LOCATION: null } }] });
    const { card, before, after, reported } = await confirmEdit(master, {
      edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17), title: 'Standup (new)', location: '',
    });
    expectReportedDone(reported);
    expect(before.get(slotKey(3)).location).toBe('');
    expect(before.get(slotKey(4)).location).toBe('Room A');
    expect(card).toContain('**Title:**');
    expect(card).not.toContain('**Location:**');
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [key, was] of before) {
      expect(after.get(key), key).toEqual(key >= slotKey(3) ? { ...was, title: 'Standup (new)' } : was);
    }
  });
});
