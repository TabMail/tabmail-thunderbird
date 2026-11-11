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
// Controls: "this_only" changes one occurrence and no other; "this_and_following"
// keeps its behaviour (the earlier part untouched; a changed occurrence carried
// into the following part keeps its own fields unless the split names it).

process.env.TZ = 'America/Vancouver';

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { loadCalendarBridge, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem } from './helpers/calendarBridgeHarness.js';

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
// with its own notes and busy. `changed` adds occurrences changed on their own
// (each at its slot `n`, with its own fields and, when given, its own times);
// `excluded` adds EXDATEs at those slots.
function series({ changed = [], excluded = [] } = {}) {
  const master = fakeEvent({
    id: 'standup', title: 'Standup',
    startDate: fakeDateTime(FIRST, 17), endDate: fakeDateTime(FIRST, 17, 30),
    properties: { LOCATION: 'Room A', DESCRIPTION: 'Daily notes', TRANSP: 'OPAQUE' },
  });
  const exceptions = changed.map(({ n, title = 'Standup', properties = {}, start = [17, 0], end = [17, 30] }) => fakeEvent({
    id: 'standup', title,
    startDate: fakeDateTime(dayFromNow(n), ...start), endDate: fakeDateTime(dayFromNow(n), ...end),
    recurrenceId: fakeDateTime(dayFromNow(n), 17),
    properties: { LOCATION: 'Room A', DESCRIPTION: 'Daily notes', TRANSP: 'OPAQUE', ...properties },
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

describe('controls: the other scopes', () => {
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

  it('"this_and_following" keeps its behaviour: the earlier part is untouched, and a changed occurrence it does not name keeps its own fields', async () => {
    const master = series({
      changed: [
        { n: 1, title: 'Standup (demo)', properties: { LOCATION: 'Room B' } },
        { n: 5, title: 'Standup (review)', properties: { LOCATION: 'Room C' } },
      ],
    });
    const { api } = loadCalendarBridge(bridgeUrl, { items: [master] });
    const before = await shown(api);
    const res = await api.modifyCalendarEvent({ event_id: 'standup', calendar_id: 'cal1', edit_scope: 'this_and_following', recurrence_id: naiveAt(3, 17), title: 'Team sync' });
    expect(res).toMatchObject({ ok: true });
    const after = await shown(api);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rid, was] of before) {
      const following = rid >= ridValue(3);
      // The following part's plain occurrences take the title; the changed
      // occurrence carried into it (not the one named) keeps its own.
      if (following && rid !== ridValue(5)) expect(after.get(rid), rid).toEqual({ ...was, title: 'Team sync' });
      else expect(after.get(rid), rid).toEqual(was);
    }
  });
});
