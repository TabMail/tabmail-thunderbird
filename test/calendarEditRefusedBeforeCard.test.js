/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEditRefusedBeforeCard.test.js: the confirmation card is never shown
// for an edit the write then refuses (#339).
//
// The property: for every refusal the bridge's two write paths can make
// (modifyCalendarEvent, and splitRecurringEvent for "this and following"), the
// edit tool's `run`, against the real bridge, refuses before the card: it
// fails with the bridge's own message, no card is prepared, and nothing is
// written (no item modified or added, the stored series unchanged). The tool
// checks every edit (check_only), and the bridge's check returns only at its
// first write, so every refusal is made by it.
//
// The table follows the census of the refusals in the two functions, in
// source order. A refusal no edit from the tool can reach is listed at the end
// with the reason. A few rows show the check refusing nothing the write would
// make, including a new rule with a move that is another date in the user's
// zone but the same day in the series' own zone.

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
  loadCalendarBridge, fakeAttendee, fakeDate, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem, recurrenceDate,
  fixedZone, FLOATING_ZONE, LOCAL_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');
const { run } = await import('../chat/tools/calendar_event_edit.js');
const { runStateEditCalendarEventExec } = await import('../chat/fsm/calendarEdit.js');
const { ctx } = await import('../chat/modules/context.js');

// 2099 is the dated-test exception: it never goes stale. 2099-10-01 is a
// Thursday; every date here stays inside one daylight-saving period.
const pad2 = (n) => String(n).padStart(2, '0');
const DAY = (n) => `2099-10-${pad2(n)}`;
const isoAt = (n, hour = 17) => `${DAY(n)}T${pad2(hour)}:00:00`;
const EAST = fixedZone('Test/East+0900', 9 * 60);
const hourAfter = (start) => {
  const end = start.clone();
  end.addDuration({ inSeconds: 3600, isNegative: false });
  return end;
};
// A start_iso as the read tools show it: in the user's zone (floating time by
// its digits, an all-day value as its date at midnight).
const startIsoOf = (dt) => {
  if (dt.isDate) return `${dt.year}-${pad2(dt.month + 1)}-${pad2(dt.day)}T00:00:00`;
  const d = dt.timezone === FLOATING_ZONE ? dt : dt.getInTimezone(LOCAL_ZONE);
  return `${d.year}-${pad2(d.month + 1)}-${pad2(d.day)}T${pad2(d.hour)}:${pad2(d.minute)}:${pad2(d.second)}`;
};
const guest = (name) => fakeAttendee({ id: `mailto:${name}@example.com`, participationStatus: 'ACCEPTED', rsvp: 'FALSE' });

// A one-off event at 17:00 on day 1, or all day on day 6.
const oneOff = ({ attendees = [] } = {}) => fakeEvent({ id: 'ser', title: 'Sync', startDate: fakeDateTime(DAY(1), 17), endDate: hourAfter(fakeDateTime(DAY(1), 17)), attendees });
const allDayOneOff = () => fakeEvent({ id: 'ser', title: 'Holiday', startDate: fakeDate(DAY(6)), endDate: fakeDate(DAY(7)) });
// A series from `start` (17:00 on day 1 in the user's zone unless given) by
// `rules`, with further recurrence items and changed occurrences.
function series({ rules = ['FREQ=DAILY;COUNT=10'], start = fakeDateTime(DAY(1), 17), items = [], exceptions = [], attendees = [] } = {}) {
  const end = start.isDate ? fakeDate(`${start.year}-${pad2(start.month + 1)}-${pad2(start.day + 1)}`) : hourAfter(start);
  const ev = fakeEvent({ id: 'ser', title: 'Sync', startDate: start, endDate: end, attendees });
  ev.recurrenceInfo = fakeRecurrenceInfo([...rules.map((r) => recurrenceItem('RRULE', r)), ...items], { exceptions });
  ev.recurrenceInfo.item = ev;
  return ev;
}
// An occurrence changed on its own: at its slot on day `n`, or starting at `startOn` ([day, hour]).
function changed(n, { title = 'Planning', startOn = null } = {}) {
  const start = startOn ? fakeDateTime(DAY(startOn[0]), startOn[1]) : fakeDateTime(DAY(n), 17);
  return fakeEvent({ id: 'ser', title, startDate: start, endDate: hourAfter(start), recurrenceId: fakeDateTime(DAY(n), 17) });
}
const exrule = () => ({ isNegative: true, icalProperty: { propertyName: 'EXRULE', value: 'FREQ=WEEKLY;BYDAY=SA' } });
const eastSeries = () => series({ rules: ['FREQ=WEEKLY;BYDAY=TH;COUNT=5'], start: fakeDateTime(DAY(1), 17, 0, EAST) });

// Thunderbird refusing to write a rule (an immutable rule item throws): the
// `n`th rule written throws, every earlier one is written.
const ruleWriteThrowsAt = (n) => (loaded) => {
  const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
  let calls = 0;
  const create = cal.icsService.createIcalProperty;
  cal.icsService.createIcalProperty = (name) => {
    calls += 1;
    if (calls >= n) throw new Error('NS_ERROR_OBJECT_IS_IMMUTABLE');
    return create(name);
  };
};
const noCalendarManager = (loaded) => {
  const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
  cal.manager = null;
};

const EVENT_NOT_FOUND = "event not found: the event_id may not refer to a calendar event on the user's calendars (it could be stale, deleted, or a different kind of id). Use calendar_search or calendar_read to look up a valid event_id, then retry — do not retry with the same event_id.";
const SCOPE_NEEDS_RID = (scope) => `edit_scope='${scope}' requires recurrence_id (the start_iso of the target occurrence — use calendar_event_read or calendar_read to find it). Retry the call including recurrence_id.`;
const NO_OCCURRENCE = (field, iso) => `${field} ${iso} is not the start of an occurrence of this series; pass the occurrence's start_iso as the read tools show it`;
const KIND_CHANGE = 'changing these occurrences between all-day and timed would leave their excluded or added dates or end date in the other form; change it in the calendar app';
const KIND_CHANGE_UNTIL = 'changing these occurrences between all-day and timed would leave their end date (UNTIL) in the other form; give the repeat rule again, its end included, in the same edit (a move to another day goes first, in its own edit)';
const SET_HOURS = 'this series repeats at set hours or minutes, so its time cannot be moved here; tell the user to change it in their calendar app';
const NEW_RULE_MOVE = 'a new repeat rule cannot be given with a move of the series to another day; make the move first, then change the repeat in a second edit (calendar_event_read then shows the moved end)';
const EXRULE_MOVE = 'this series cancels occurrences by a rule (EXRULE), which a move to another day cannot carry; tell the user to move it in their calendar app';
const RULE_DAYS = 'this series repeats on days its rule names in a way a move cannot carry (for example the second Tuesday, or the last day of the month), so it cannot be moved to another day here; move only its time of day, or tell the user to change its days in their calendar app';
const ALL_DAY_TIME = /^this is an all-day event, and the edit gives a time of day without all_day\. Ask the user/;
const ALL_DAY_END = /^this is an all-day event, so its end_iso is the day after its last day and must be later than start_iso\. Ask the user/;
const END_BEFORE = /^the event would end before it starts\. An end_iso alone changes only the end/;
// The bridge's check before the card failing: the tool refuses the edit.
const checkThrows = (loaded) => {
  const modify = loaded.api.modifyCalendarEvent;
  loaded.api.modifyCalendarEvent = async (details) => {
    if (details.check_only) throw new Error('calendar busy');
    return modify(details);
  };
};

// Each row: the refusal (as the census names it), the stored event (none for
// an event that does not exist), the edit, a setup of the calendar, and the
// refusal expected (the exact message, or a pattern when it carries an
// exception's text).
const REFUSALS = [
  // modifyCalendarEvent
  ['no calendar manager', oneOff, { title: 'Renamed' }, noCalendarManager, 'calendar manager unavailable'],
  ['no event_id (the tool\'s own argument check)', oneOff, { event_id: '', title: 'Renamed' }, null, /^event_id is required\. Use calendar_search or calendar_read/],
  ['this_only with no recurrence_id', series, { edit_scope: 'this_only', title: 'Renamed' }, null, SCOPE_NEEDS_RID('this_only')],
  ['this_and_following with no recurrence_id', series, { edit_scope: 'this_and_following', title: 'Renamed' }, null, SCOPE_NEEDS_RID('this_and_following')],
  ['an event that does not exist', null, { title: 'Renamed' }, null, EVENT_NOT_FOUND],
  ['one occurrence named by a time that is no occurrence', series, { edit_scope: 'this_only', recurrence_id: isoAt(4, 18), title: 'Renamed' }, null, NO_OCCURRENCE('recurrence_id', isoAt(4, 18))],
  ['one occurrence named by a time two occurrences start at', () => series({ exceptions: [changed(4, { startOn: [5, 17] })] }),
    { edit_scope: 'this_only', recurrence_id: isoAt(5), title: 'Renamed' }, null,
    `recurrence_id ${isoAt(5)} is the start of more than one occurrence of this series; change it in the calendar app`],
  ['an excluded date that names no occurrence, whole series', series, { exdates_add: [isoAt(4, 18)] }, null, NO_OCCURRENCE('exdates_add', isoAt(4, 18))],
  ['an excluded date that names no occurrence, one occurrence', series, { edit_scope: 'this_only', recurrence_id: isoAt(3), exdates_add: [isoAt(4, 18)] }, null, NO_OCCURRENCE('exdates_add', isoAt(4, 18))],
  ['an excluded date that is not a date', series, { exdates_add: ['next week'] }, null, 'invalid exdates_add format (expected ISO8601)'],
  ['an excluded date on an event that does not repeat', oneOff, { exdates_add: [isoAt(1)] }, null, `exdates_add ${isoAt(1)} is not the start of an occurrence of this series`],
  ['a whole-series time change named by a time that is no occurrence', series, { edit_scope: 'all', recurrence_id: isoAt(1, 18), start_iso: isoAt(1, 19) }, null, NO_OCCURRENCE('recurrence_id', isoAt(1, 18))],
  ['an all-day event given a time of day without all_day', allDayOneOff, { start_iso: `${DAY(8)}T15:00:00` }, null, ALL_DAY_TIME],
  ['an all-day end on its start', allDayOneOff, { start_iso: `${DAY(8)}T00:00:00`, end_iso: `${DAY(8)}T00:00:00` }, null, ALL_DAY_END],
  ['a timed end before its start', oneOff, { end_iso: isoAt(1, 16) }, null, END_BEFORE],
  ['an all-day event given a timed end alone', allDayOneOff, { all_day: false, end_iso: `${DAY(6)}T15:00:00` }, null, /^the edit would leave the start all-day and the end timed/],
  ['a whole series named from its first occurrence, changed on its own, given an end before that occurrence starts', () => series({ exceptions: [changed(1, { startOn: [1, 19] })] }),
    { edit_scope: 'all', recurrence_id: isoAt(1, 19), end_iso: `${DAY(1)}T18:30:00` }, null, END_BEFORE],
  ['a whole series made all-day with an added date', () => series({ items: [recurrenceDate('RDATE', fakeDateTime(DAY(6), 19))] }),
    { edit_scope: 'all', recurrence_id: isoAt(1), start_iso: `${DAY(1)}T00:00:00`, end_iso: `${DAY(2)}T00:00:00`, all_day: true }, null, KIND_CHANGE],
  ['a whole series made all-day keeping an UNTIL', () => series({ rules: ['FREQ=DAILY;UNTIL=20991011T065959Z'] }),
    { edit_scope: 'all', recurrence_id: isoAt(1), start_iso: `${DAY(1)}T00:00:00`, end_iso: `${DAY(2)}T00:00:00`, all_day: true }, null, KIND_CHANGE_UNTIL],
  ['a time change of a rule with set hours', () => series({ rules: ['FREQ=DAILY;BYHOUR=17,20;COUNT=8'] }), { edit_scope: 'all', recurrence_id: isoAt(1), start_iso: isoAt(1, 18) }, null, SET_HOURS],
  ['a new rule with a move to another day in the series\' zone, the same date in the user\'s', eastSeries,
    { edit_scope: 'all', recurrence_id: startIsoOf(fakeDateTime(DAY(1), 17, 0, EAST)), start_iso: startIsoOf(fakeDateTime(DAY(2), 1, 0, EAST)), recurrence: { freq: 'WEEKLY', byDay: ['FR'], count: 3 } },
    null, NEW_RULE_MOVE],
  ['a move to another day of a series with an EXRULE', () => series({ rules: ['FREQ=WEEKLY;BYDAY=TH,SA;COUNT=6'], items: [exrule()] }),
    { edit_scope: 'all', recurrence_id: isoAt(1), start_iso: isoAt(2) }, null, EXRULE_MOVE],
  ['a move to another day the rule\'s days cannot follow', () => series({ rules: ['FREQ=MONTHLY;BYDAY=1TH;COUNT=6'] }), { edit_scope: 'all', recurrence_id: isoAt(1), start_iso: isoAt(2) }, null, RULE_DAYS],
  ['invitations for an event with no guests', oneOff, { title: 'Renamed', send_invitations: true }, null, 'send_invitations=true requires at least one attendee'],
  ['invitations for one occurrence with no guests', series, { edit_scope: 'this_only', recurrence_id: isoAt(3), title: 'Renamed', send_invitations: true }, null, 'send_invitations=true requires at least one attendee'],
  ['invitations for a whole series once everyone is removed', () => series({ attendees: [guest('ana')] }), { remove_attendees: [{ email: '*' }], send_invitations: true }, null, 'send_invitations=true requires at least one attendee'],

  // splitRecurringEvent (edit_scope 'this_and_following')
  ['a split of an event that does not exist', null, { edit_scope: 'this_and_following', recurrence_id: isoAt(4), title: 'Renamed' }, null, EVENT_NOT_FOUND],
  ['a split of an event that does not repeat', oneOff, { edit_scope: 'this_and_following', recurrence_id: isoAt(1), title: 'Renamed' }, null, 'event is not recurring — use modifyCalendarEvent for one-off events'],
  ['a split at a time that is no occurrence', series, { edit_scope: 'this_and_following', recurrence_id: isoAt(4, 18), title: 'Renamed' }, null, NO_OCCURRENCE('recurrence_id', isoAt(4, 18))],
  ['a split at the first occurrence', series, { edit_scope: 'this_and_following', recurrence_id: isoAt(1), title: 'Renamed' }, null,
    "recurrence_id is the series' first occurrence: to change every occurrence, edit the whole series (edit_scope 'all')"],
  ['a split with an excluded date that names no occurrence', series, { edit_scope: 'this_and_following', recurrence_id: isoAt(4), exdates_add: [isoAt(6, 18)] }, null, NO_OCCURRENCE('exdates_add', isoAt(6, 18))],
  ['a split of a series with an EXRULE', () => series({ rules: ['FREQ=WEEKLY;BYDAY=TH,SA;COUNT=6'], items: [exrule()] }), { edit_scope: 'this_and_following', recurrence_id: isoAt(8), title: 'Renamed' }, null,
    'this series cancels occurrences by a rule (EXRULE), which a split cannot keep; change it in the calendar app'],
  ['a split of a series that repeats by added dates alone', () => series({ rules: [], items: [recurrenceItem('RDATE', '20991003T170000'), recurrenceItem('RDATE', '20991005T170000')] }),
    { edit_scope: 'this_and_following', recurrence_id: isoAt(5), title: 'Renamed' }, null, 'master event has no parseable RRULE (its recurrenceInfo holds no FREQ=… rule)'],
  ['a split of a rule whose end cannot be read', () => series({ rules: ['FREQ=DAILY;UNTIL=20991010T1700'] }), { edit_scope: 'this_and_following', recurrence_id: isoAt(4), title: 'Renamed' }, null,
    "this series' end cannot be read (UNTIL=20991010T1700)"],
  ['a split at an added date the rule does not make', () => series({ rules: ['FREQ=WEEKLY;COUNT=6'], items: [recurrenceItem('RDATE', '20991003T170000')] }),
    { edit_scope: 'this_and_following', recurrence_id: isoAt(3), title: 'Renamed' }, null,
    /^recurrence_id 2099-10-03T17:00:00 is not an occurrence of this series' rule FREQ=WEEKLY;COUNT=6, so the part from there on cannot keep its dates/],
  ['a split whose earlier part\'s rule cannot be written', series, { edit_scope: 'this_and_following', recurrence_id: isoAt(4), title: 'Renamed' }, ruleWriteThrowsAt(1), /^failed to apply capped RRULE: Error: NS_ERROR_OBJECT_IS_IMMUTABLE/],
  ['a split whose following part\'s rule cannot be written', series, { edit_scope: 'this_and_following', recurrence_id: isoAt(4), title: 'Renamed' }, ruleWriteThrowsAt(2), /^failed to build the new series' recurrence: Error: NS_ERROR_OBJECT_IS_IMMUTABLE/],
  ['a split of an all-day series given a time of day without all_day', () => series({ start: fakeDate(DAY(1)) }),
    { edit_scope: 'this_and_following', recurrence_id: `${DAY(4)}T00:00:00`, start_iso: `${DAY(4)}T09:00:00` }, null, ALL_DAY_TIME],
  ['a split made all-day whose following part has an added date', () => series({ items: [recurrenceDate('RDATE', fakeDateTime(DAY(7), 19))] }),
    { edit_scope: 'this_and_following', recurrence_id: isoAt(4), start_iso: `${DAY(4)}T00:00:00`, end_iso: `${DAY(5)}T00:00:00`, all_day: true }, null, KIND_CHANGE],
  ['a split at an occurrence changed on its own, given an end before it starts', () => series({ exceptions: [changed(4, { startOn: [4, 19] })] }),
    { edit_scope: 'this_and_following', recurrence_id: isoAt(4, 19), end_iso: `${DAY(4)}T18:30:00` }, null, END_BEFORE],
  ['a split with a new rule and a move to another day', series, { edit_scope: 'this_and_following', recurrence_id: isoAt(4), start_iso: isoAt(5), recurrence: { freq: 'DAILY', count: 3 } }, null, NEW_RULE_MOVE],
  ['a split asking for invitations once everyone is removed', () => series({ attendees: [guest('ana')] }),
    { edit_scope: 'this_and_following', recurrence_id: isoAt(4), remove_attendees: [{ email: '*' }], send_invitations: true }, null,
    'send_invitations=true requires at least one attendee on the new series'],
  // The two refusals that sat after the check before #339.
  ['a split whose new rule cannot be written', () => series({ rules: ['FREQ=DAILY;COUNT=3'], items: [recurrenceItem('RDATE', '20991005T170000')] }),
    { edit_scope: 'this_and_following', recurrence_id: isoAt(5), recurrence: { freq: 'DAILY', count: 2 } }, ruleWriteThrowsAt(1),
    /^failed to apply the new series' recurrence: Error: NS_ERROR_OBJECT_IS_IMMUTABLE/],
  ['stopping the repeat at an occurrence changed on its own', () => series({ exceptions: [changed(4)] }),
    { edit_scope: 'this_and_following', recurrence_id: isoAt(4), recurrence: {} }, null,
    `the occurrence at ${isoAt(4)} was changed on its own, and ending the series there would lose its changes; change it in the calendar app`],
  ['stopping the repeat at an occurrence changed on its own, with new times', () => series({ exceptions: [changed(4)] }),
    { edit_scope: 'this_and_following', recurrence_id: isoAt(4), start_iso: isoAt(4, 18), recurrence: {} }, null,
    `the occurrence at ${isoAt(4)} was changed on its own, and ending the series there would lose its changes; change it in the calendar app`],

  // The edit tool
  ['the check before the card failing', oneOff, { title: 'Renamed' }, checkThrows, 'the calendar could not check this edit (Error: calendar busy); try again'],
];

// The refusals of the two functions no edit from the tool reaches, and why:
//   - modifyCalendarEvent "event_id is required", splitRecurringEvent "event_id
//     is required" and "recurrence_id is required for splitRecurringEvent": the
//     tool refuses a missing event_id first (row above), and modifyCalendarEvent
//     refuses a split with no recurrence_id before it calls the split;
//   - splitRecurringEvent "calendar manager unavailable": modifyCalendarEvent
//     makes that refusal first (row above);
//   - "invalid recurrence_id format" (occurrenceNamedBy): the tool refuses a
//     value it cannot read as a date before the check (calendarToolDates);
//   - modifyCalendarEvent "is a later occurrence": the tool routes a time change
//     named from a later occurrence to this_and_following first;
//   - "failed to compute UNTIL value" and "failed to compute new start/end":
//     computed from an occurrence the series has, with its own end;
//   - "this series' count cannot be read": the same branch as an end that cannot
//     be read (row above);
//   - "failed to cap master series" and "failed to create new series", and an
//     exception from a write: the write itself failing, after every check.

let nextPid = 0;
const settle = () => new Promise((r) => setTimeout(r, 20));
// The tool's `run`, against the real bridge, up to the card or the refusal.
async function runTool(build, args, setup) {
  const stored = build ? [build()] : [];
  const loaded = loadCalendarBridge(bridgeUrl, { items: [...stored] });
  const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
  cal.timezoneService.getTimezone = (tzid) => (tzid === EAST.tzid ? EAST : null);
  if (setup) setup(loaded);
  globalThis.browser.tmCalendar = loaded.api;
  const pid = `pid-precard-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  await run({ event_id: 'ser', calendar_id: 'cal1', ...args }, { callId: pid });
  await settle();
  return { sess: ctx.fsmSessions[pid], loaded, stored, pid };
}

// What a stored item is, in every field an edit could change.
const keyOf = (dt) => (dt ? `${dt.toString()}@${dt.timezone?.tzid}` : null);
function snapshot(item) {
  const info = item.recurrenceInfo;
  return JSON.stringify({
    title: item.title, start: keyOf(item.startDate), end: keyOf(item.endDate),
    location: item.getProperty('LOCATION'),
    attendees: item.getAttendees().map((a) => [a.id, a.participationStatus, a.rsvp]),
    items: (info?.getRecurrenceItems() || []).map((r) => [r.icalProperty.propertyName, r.icalProperty.value]),
    exceptions: (info?.getExceptionIds() || []).map((rid) => {
      const ex = info.getExceptionFor(rid);
      return [keyOf(rid), ex.title, keyOf(ex.startDate), ex.getAttendees().map((a) => [a.id, a.participationStatus])];
    }),
  });
}

describe('every refusal of the write is made before the confirmation card, and nothing is written', () => {
  for (const [name, build, args, setup, error] of REFUSALS) {
    it(name, async () => {
      // The stored event as it was, from a second copy built the same way.
      const before = build ? snapshot(build()) : null;
      const { sess, loaded, stored } = await runTool(build, args, setup);
      if (error instanceof RegExp) expect(sess.failReason).toMatch(error);
      else expect(sess.failReason).toBe(error);
      expect(ctx.state).toBe('exec_fail');
      expect(sess.editEventArgs).toBeUndefined();
      expect(loaded.modifications).toEqual([]);
      expect(loaded.calendar.items).toHaveLength(stored.length);
      if (loaded.calendar.items.length !== stored.length) return;
      loaded.calendar.items.forEach((item, i) => expect(item).toBe(stored[i]));
      if (before) expect(snapshot(stored[0])).toBe(before);
    });
  }
});

// The bridge's two refusals of an event_id that names no event (stale, deleted,
// or another kind of id) tell the assistant to look the event up again, not to
// retry it as it is (#339: until then an edit giving no times got this guidance
// from the read before the card). The tool's own reads of the event before the
// check still answer "try again" (#347).
describe('an event_id that names no event is refused with the way to find the event', () => {
  for (const [name, args] of [
    ['an edit of the event or the whole series', { title: 'Renamed' }],
    ['a split from an occurrence', { edit_scope: 'this_and_following', recurrence_id: isoAt(4), title: 'Renamed' }],
  ]) {
    it(name, async () => {
      const { sess } = await runTool(series, { ...args, event_id: 'gone' });
      expect(sess.failReason).toMatch(/^event not found: /);
      expect(sess.failReason).toMatch(/Use calendar_search or calendar_read to look up a valid event_id/);
      expect(sess.failReason).toMatch(/do not retry with the same event_id\.$/);
      expect(sess.editEventArgs).toBeUndefined();
    });
  }
});

// The check refuses nothing the write would make: these reach the card, and
// the confirmed edit is then written.
describe('an edit the write makes reaches the card and is written', () => {
  async function confirm(pid) {
    const was = ctx.activePid;
    ctx.activePid = pid;
    try {
      await runStateEditCalendarEventExec();
    } finally {
      ctx.activePid = was;
    }
  }
  const ruleValues = (item) => (item.recurrenceInfo?.getRecurrenceItems() || [])
    .filter((r) => r.icalProperty.propertyName === 'RRULE').map((r) => r.icalProperty.value);
  // The tool's run up to the card: the check passes and, on its own, changes
  // nothing (no item modified, the stored event as a second copy built the same
  // way), before the edit is confirmed.
  async function toCard(build, args) {
    const before = snapshot(build());
    const out = await runTool(build, args);
    expect(out.sess.failReason).toBeUndefined();
    expect(out.loaded.modifications).toEqual([]);
    expect(out.loaded.calendar.items).toHaveLength(1);
    expect(snapshot(out.stored[0])).toBe(before);
    return out;
  }

  it('a new rule with a move to another date in the user\'s zone that is the same day in the series\' zone', async () => {
    // 17:00 east of UTC is 01:00 in the user's zone; 15:00 there the same day
    // is 23:00 the day before in the user's zone. The series' days do not move.
    const first = fakeDateTime(DAY(1), 17, 0, EAST);
    const movedTo = fakeDateTime(DAY(1), 15, 0, EAST);
    expect(startIsoOf(first).slice(0, 10)).not.toBe(startIsoOf(movedTo).slice(0, 10));
    const { sess, loaded, pid } = await toCard(eastSeries, {
      edit_scope: 'all', recurrence_id: startIsoOf(first), start_iso: startIsoOf(movedTo), recurrence: { freq: 'WEEKLY', byDay: ['TH'], count: 3 },
    });
    expect(sess.editEventArgs).toMatchObject({ edit_scope: 'all', recurrence: { freq: 'WEEKLY', byDay: ['TH'], count: 3 } });
    await confirm(pid);
    expect(sess.failReason).toBeUndefined();
    expect(loaded.calendar.items).toHaveLength(1);
    if (loaded.calendar.items.length !== 1) return;
    const [saved] = loaded.calendar.items;
    expect(saved.startDate.timezone).toBe(EAST);
    expect(saved.startDate.toString()).toBe(movedTo.toString());
    expect(ruleValues(saved)).toEqual(['FREQ=WEEKLY;COUNT=3;BYDAY=TH']);
  });

  it('stopping the repeat at an occurrence not changed on its own', async () => {
    const { sess, loaded, pid } = await toCard(() => series({ exceptions: [changed(4)] }), { edit_scope: 'this_and_following', recurrence_id: isoAt(6), recurrence: {} });
    await confirm(pid);
    expect(sess.failReason).toBeUndefined();
    expect(loaded.calendar.items).toHaveLength(2);
    const following = loaded.calendar.items.find((it) => it.id !== 'ser');
    expect(following).toBeTruthy();
    expect(following?.recurrenceInfo).toBeFalsy();
  });

  // An edit of one occurrence writes its excluded date to the series, and only
  // after the confirmation: the modifications and the snapshot in toCard catch
  // a check that writes it. This row stops at the card (the confirmed write of
  // that excluded date to the series is not modelled here).
  it('a new title for one occurrence that also excludes another, up to the card', async () => {
    const { sess } = await toCard(series, { edit_scope: 'this_only', recurrence_id: isoAt(3), exdates_add: [isoAt(5)], title: 'Renamed' });
    expect(sess.editEventArgs).toMatchObject({ edit_scope: 'this_only', exdates_add: [isoAt(5)], title: 'Renamed' });
  });

  it('a new title for the whole series', async () => {
    const { sess, loaded, pid } = await toCard(series, { title: 'Renamed' });
    await confirm(pid);
    expect(sess.failReason).toBeUndefined();
    expect(loaded.calendar.items).toHaveLength(1);
    expect(loaded.calendar.items[0]?.title).toBe('Renamed');
  });
});
