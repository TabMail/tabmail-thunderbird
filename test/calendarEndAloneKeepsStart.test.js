/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEndAloneKeepsStart.test.js: an edit that gives only a new end changes
// only the end, as Google Calendar does: the start stays and the event gets
// longer or shorter. The start kept is the item's own: the event's, one
// occurrence's current start (moved or not), a split's slot, and an occurrence
// changed on its own that the edit names keeps its own start. On a whole
// series (or a split's part) an end alone is a new length, measured from the
// start of the occurrence it names: the series' first occurrence and each
// occurrence changed on its own take that length from their own starts; it
// moves no start, so excluded dates stay excluded. Every item's new times
// are checked: an end before the start, a start and an end of different kinds,
// and an all-day end on or before the start are refused before the
// confirmation card, with nothing written. Through the real bridge and the
// real edit tool and card, west of UTC.

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
  loadCalendarBridge, fakeDate, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem, recurrenceDate, seriesOccurrences, fixedZone, LOCAL_ZONE,
} = await import('./helpers/calendarBridgeHarness.js');
const { run } = await import('../chat/tools/calendar_event_edit.js');
const { runStateEditCalendarEventList } = await import('../chat/fsm/calendarEdit.js');
const { streamText } = await import('../chat/modules/helpers.js');
const { ctx } = await import('../chat/modules/context.js');
// What the flow sends must be what the experiment declares.
const { checked } = await import('./helpers/calendarSchemaCheck.js');

// Days relative to today, a month out, so they never go stale.
const pad2 = (n) => String(n).padStart(2, '0');
function day(n) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + 30 + n);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
const at = (n, hour, minute = 0) => `${day(n)}T${pad2(hour)}:${pad2(minute)}:00`;
const RANGE = () => [fakeDate(day(-2)), fakeDate(day(20))];
// A time's digits, as the bridge writes it (user's zone).
const digits = (n, hour, minute = 0) => fakeDateTime(day(n), hour, minute).toString();

const oneOff = () => fakeEvent({ id: 'evt', title: 'Sync', startDate: fakeDateTime(day(0), 17), endDate: fakeDateTime(day(0), 18) });
const allDayEvent = (lastDay = 0) => fakeEvent({ id: 'evt', title: 'Holiday', startDate: fakeDate(day(0), LOCAL_ZONE), endDate: fakeDate(day(lastDay + 1), LOCAL_ZONE) });
// An occurrence of a daily 17:00 series (its slot on day `n`), changed on its own.
const changed = (n, title, start, end) => fakeEvent({ id: 'evt', title, startDate: start, endDate: end, recurrenceId: fakeDateTime(day(n), 17) });
function series({ endHour = 18, endMinute = 0, exceptions = [], extraItems = [] } = {}) {
  const ev = fakeEvent({ id: 'evt', title: 'Sync', startDate: fakeDateTime(day(0), 17), endDate: fakeDateTime(day(0), endHour, endMinute) });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=10'), ...extraItems], { exceptions });
  ev.recurrenceInfo.item = ev;
  return ev;
}
function allDaySeries(exceptions = []) {
  const ev = fakeEvent({ id: 'evt', title: 'Leave', startDate: fakeDate(day(0)), endDate: fakeDate(day(1)) });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=WEEKLY;COUNT=4')], { exceptions });
  ev.recurrenceInfo.item = ev;
  return ev;
}
// Each occurrence's start and end, and title when changed on its own.
const occurrences = (item) => seriesOccurrences(item, ...RANGE())
  .map(({ start, item: occ }) => `${start.toString()}-${(occ.recurrenceId ? occ.endDate : null)?.toString() || ''}${occ.recurrenceId ? ` ${occ.title}` : ''}`)
  .sort();
const changedOf = (item, n) => item.recurrenceInfo.getExceptionFor(fakeDateTime(day(n), 17));
// A zone east of the user's, and a time in it as the read tools show it (the user's zone).
const EAST = fixedZone('Test/East+0900', 9 * 60);
const shown = (dt) => {
  const d = dt.getInTimezone(LOCAL_ZONE);
  return `${d.year}-${pad2(d.month + 1)}-${pad2(d.day)}T${pad2(d.hour)}:${pad2(d.minute)}:${pad2(d.second)}`;
};

async function edit(item, args) {
  const loaded = loadCalendarBridge(bridgeUrl, { items: [item] });
  const res = await loaded.api.modifyCalendarEvent({ event_id: 'evt', calendar_id: 'cal1', ...args });
  return { res, loaded, saved: loaded.calendar.items };
}

// Refused by the bridge, by its check before the card, and by the tool: nothing
// is written and the tool never reaches the card.
async function expectRefused(makeItem, args, pattern) {
  const { res, loaded } = await edit(makeItem(), args);
  expect(res).toMatchObject({ ok: false });
  expect(res.error).toMatch(pattern);
  expect(loaded.modifications).toHaveLength(0);
  const check = await edit(makeItem(), { ...args, check_only: true });
  expect(check.res).toMatchObject({ ok: false, error: res.error });
  const { sess, loaded: viaTool } = await runTool(makeItem(), args);
  expect(sess.failReason).toBe(res.error);
  expect(sess.editEventArgs).toBeUndefined();
  expect(viaTool.modifications).toHaveLength(0);
}

let nextPid = 0;
async function runTool(item, args) {
  const loaded = loadCalendarBridge(bridgeUrl, { items: [item] });
  const { cal } = loaded.ctx.ChromeUtils.importESModule('resource:///modules/calendar/calUtils.sys.mjs');
  cal.timezoneService.getTimezone = (tzid) => (tzid === EAST.tzid ? EAST : null);
  globalThis.browser.tmCalendar = checked(loaded.api, []);
  const pid = `pid-end-alone-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  await run({ event_id: 'evt', calendar_id: 'cal1', ...args }, { callId: pid });
  await new Promise((r) => setTimeout(r, 5));
  return { sess: ctx.fsmSessions[pid], loaded, pid };
}

describe('an end alone keeps the start', () => {
  it('a timed event 17:00-18:00 given an end of 19:00 lasts 17:00-19:00', async () => {
    const { res, saved } = await edit(oneOff(), { end_iso: at(0, 19) });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(saved[0].startDate.toString()).toBe(digits(0, 17));
    expect(saved[0].endDate.toString()).toBe(digits(0, 19));
  });

  it('a timed event given an end at its start is written, a zero-length event', async () => {
    const { res, saved } = await edit(oneOff(), { end_iso: at(0, 17) });
    expect(res, res.error).toMatchObject({ ok: true });
    expect(saved[0].startDate.toString()).toBe(digits(0, 17));
    expect(saved[0].endDate.toString()).toBe(digits(0, 17));
  });

  it('one occurrence moved on its own to 19:00 (its slot 17:00) given an end of 21:00 lasts 19:00-21:00', async () => {
    const master = series({ exceptions: [changed(3, 'Moved', fakeDateTime(day(3), 19), fakeDateTime(day(3), 20))] });
    const { res } = await edit(master, { edit_scope: 'this_only', recurrence_id: at(3, 19), end_iso: at(3, 21) });
    expect(res, res.error).toMatchObject({ ok: true });
    const x = changedOf(master, 3);
    expect(x.startDate.toString()).toBe(digits(3, 19));
    expect(x.endDate.toString()).toBe(digits(3, 21));
  });

  it('an all-day occurrence moved on its own a day later, given an end after it, keeps its moved start', async () => {
    const moved = fakeEvent({ id: 'evt', title: 'Moved', startDate: fakeDate(day(8)), endDate: fakeDate(day(9)), recurrenceId: fakeDate(day(7)) });
    const master = allDaySeries([moved]);
    const { res } = await edit(master, { edit_scope: 'this_only', recurrence_id: `${day(8)}T00:00:00`, end_iso: `${day(10)}T00:00:00` });
    expect(res, res.error).toMatchObject({ ok: true });
    const x = master.recurrenceInfo.getExceptionFor(fakeDate(day(7)));
    expect(x.startDate.toString()).toBe(fakeDate(day(8)).toString());
    expect(x.endDate.toString()).toBe(fakeDate(day(10)).toString());
  });
});

describe('a whole series given an end alone keeps every start', () => {
  // At their slots: 'Kept' (renamed only), 'Long' (its own length, to 18:30);
  // 'Moved' given its own time; and an excluded date.
  const full = () => series({
    exceptions: [
      changed(3, 'Kept', fakeDateTime(day(3), 17), fakeDateTime(day(3), 18)),
      changed(4, 'Long', fakeDateTime(day(4), 17), fakeDateTime(day(4), 18, 30)),
      changed(5, 'Moved', fakeDateTime(day(5), 19), fakeDateTime(day(5), 20)),
    ],
    extraItems: [recurrenceDate('EXDATE', fakeDateTime(day(7), 17))],
  });

  it('every occurrence keeps its start and takes the new length, the ones changed on their own from their own starts; an excluded date stays excluded', async () => {
    const master = full();
    const starts = seriesOccurrences(master, ...RANGE()).map(({ start }) => start.toString());
    expect(starts).not.toContain(digits(7, 17));
    const { res, saved } = await edit(master, { end_iso: at(0, 19) });
    expect(res, res.error).toMatchObject({ ok: true });
    const item = saved[0];
    expect(item.startDate.toString()).toBe(digits(0, 17));
    expect(item.endDate.toString()).toBe(digits(0, 19));
    expect(seriesOccurrences(item, ...RANGE()).map(({ start }) => start.toString())).toEqual(starts);
    expect(item.recurrenceInfo.getRecurrenceItems().find((r) => r.icalProperty.propertyName === 'RRULE').icalProperty.value).toBe('FREQ=DAILY;COUNT=10');
    expect(changedOf(item, 3).endDate.toString()).toBe(digits(3, 19));
    expect(changedOf(item, 4).endDate.toString()).toBe(digits(4, 19));
    expect(changedOf(item, 5).startDate.toString()).toBe(digits(5, 19));
    expect(changedOf(item, 5).endDate.toString()).toBe(digits(5, 21));
    expect(occurrences(item).filter((k) => / (Kept|Long|Moved)$/.test(k))).toHaveLength(3);
  });

  it('named from its first occurrence, moved on its own to 19:00: the length is read from 19:00, so it ends at the end given and the series lasts as long', async () => {
    const master = series({ exceptions: [changed(0, 'Early', fakeDateTime(day(0), 19), fakeDateTime(day(0), 20))] });
    const { res, saved } = await edit(master, { edit_scope: 'all', recurrence_id: at(0, 19), end_iso: at(0, 21) });
    expect(res, res.error).toMatchObject({ ok: true });
    const item = saved[0];
    expect([item.startDate.toString(), item.endDate.toString()]).toEqual([digits(0, 17), digits(0, 19)]);
    const x = changedOf(item, 0);
    expect([x.startDate.toString(), x.endDate.toString(), x.title]).toEqual([digits(0, 19), digits(0, 21), 'Early']);
  });

  it('named from its first occurrence, moved on its own to 19:00, given an end before 19:00, is refused with nothing written', async () => {
    const master = () => series({ exceptions: [changed(0, 'Early', fakeDateTime(day(0), 19), fakeDateTime(day(0), 20))] });
    await expectRefused(master, { edit_scope: 'all', recurrence_id: at(0, 19), end_iso: at(0, 18, 30) }, /^the event would end before it starts\. An end_iso alone changes only the end/);
  });
});

describe('a split given an end alone starts at the slot', () => {
  const withMoved = () => series({ exceptions: [changed(5, 'Moved', fakeDateTime(day(5), 19), fakeDateTime(day(5), 20))] });

  it('at an occurrence moved on its own to 19:00 (its slot 17:00): the part starts at 17:00 and takes the length read from 19:00; that occurrence keeps 19:00 and takes the end', async () => {
    const { res, saved } = await edit(withMoved(), { edit_scope: 'this_and_following', recurrence_id: at(5, 19), end_iso: at(5, 21) });
    expect(res, res.error).toMatchObject({ ok: true });
    const part = saved.find((it) => it.id !== 'evt');
    expect([part.startDate.toString(), part.endDate.toString()]).toEqual([digits(5, 17), digits(5, 19)]);
    const x = changedOf(part, 5);
    expect([x.startDate.toString(), x.endDate.toString(), x.title]).toEqual([digits(5, 19), digits(5, 21), 'Moved']);
  });

  it('there, an end before 19:00 is refused with nothing written', async () => {
    await expectRefused(withMoved, { edit_scope: 'this_and_following', recurrence_id: at(5, 19), end_iso: at(5, 18, 30) }, /^the event would end before it starts\. An end_iso alone changes only the end/);
  });

  it('the card names that occurrence by the time the user sees and states its original time', async () => {
    const { sess, pid } = await runTool(withMoved(), { edit_scope: 'this_and_following', recurrence_id: at(5, 19), end_iso: at(5, 21) });
    expect(sess.failReason).toBeUndefined();
    expect(await card(pid)).toContain(`(starting ${at(5, 19)}, originally ${at(5, 17)})`);
  });

  it('a whole-series edit named from that later occurrence becomes a split, and its card states the original time too', async () => {
    const { sess, pid } = await runTool(withMoved(), { edit_scope: 'all', recurrence_id: at(5, 19), end_iso: at(5, 21) });
    expect(sess.failReason).toBeUndefined();
    expect(await card(pid)).toContain(`(starting ${at(5, 19)}, originally ${at(5, 17)})`);
  });

  it('in a series in a zone east of the user\'s, the card states both times in the user\'s zone', async () => {
    const slot = fakeDateTime(day(5), 10, 0, EAST);
    const movedTo = fakeDateTime(day(5), 12, 0, EAST);
    const eastSeries = () => {
      const ev = fakeEvent({ id: 'evt', title: 'Sync', startDate: fakeDateTime(day(0), 10, 0, EAST), endDate: fakeDateTime(day(0), 11, 0, EAST) });
      const moved = fakeEvent({ id: 'evt', title: 'Moved', startDate: movedTo.clone(), endDate: fakeDateTime(day(5), 13, 0, EAST), recurrenceId: slot.clone() });
      ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY;COUNT=10')], { exceptions: [moved] });
      ev.recurrenceInfo.item = ev;
      return ev;
    };
    // The user's day differs from the series' (west of UTC), so the zone shows.
    expect(shown(slot).slice(0, 10)).not.toBe(day(5));
    const end = fakeDateTime(day(5), 14, 0, EAST);
    const { sess, pid } = await runTool(eastSeries(), { edit_scope: 'this_and_following', recurrence_id: shown(movedTo), end_iso: shown(end) });
    expect(sess.failReason).toBeUndefined();
    expect(await card(pid)).toContain(`(starting ${shown(movedTo)}, originally ${shown(slot)})`);
  });

  it('at an occurrence moved before its slot, an end before the slot is a length read from that occurrence: the part starts at the slot and lasts as long', async () => {
    const early = series({ exceptions: [changed(5, 'Early', fakeDateTime(day(5), 15), fakeDateTime(day(5), 16))] });
    const { res, saved } = await edit(early, { edit_scope: 'this_and_following', recurrence_id: at(5, 15), end_iso: at(5, 16, 30) });
    expect(res, res.error).toMatchObject({ ok: true });
    const part = saved.find((it) => it.id !== 'evt');
    expect([part.startDate.toString(), part.endDate.toString()]).toEqual([digits(5, 17), digits(5, 18, 30)]);
    const x = changedOf(part, 5);
    expect([x.startDate.toString(), x.endDate.toString(), x.title]).toEqual([digits(5, 15), digits(5, 16, 30), 'Early']);
  });

  it('the card states no original time for an occurrence at its slot', async () => {
    const { sess, pid } = await runTool(withMoved(), { edit_scope: 'this_and_following', recurrence_id: at(3, 17), end_iso: at(3, 19) });
    expect(sess.failReason).toBeUndefined();
    expect(await card(pid)).toContain(`(starting ${at(3, 17)})`);
  });

  async function card(pid) {
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
});

describe('new times that cannot be written are refused before the card, with nothing written', () => {
  it('a timed end alone before the start', async () => {
    await expectRefused(oneOff, { end_iso: at(0, 16) }, /^the event would end before it starts\. An end_iso alone changes only the end/);
  });

  it('a timed start and end given the wrong way round', async () => {
    await expectRefused(oneOff, { start_iso: at(0, 19), end_iso: at(0, 18) }, /^the event would end before it starts\. Ask the user when it should start and end$/);
  });

  it('all_day: false with an end alone on an all-day event', async () => {
    await expectRefused(allDayEvent, { all_day: false, end_iso: at(0, 15) }, /^the edit would leave the start all-day and the end timed/);
  });

  it('all_day: true with an end alone on a timed event', async () => {
    await expectRefused(oneOff, { all_day: true, end_iso: `${day(2)}T00:00:00` }, /^the edit would leave the start timed and the end all-day/);
  });

  it('a zero-length all-day event given a start alone with all_day: false', async () => {
    const zeroLength = () => fakeEvent({ id: 'evt', title: 'Holiday', startDate: fakeDate(day(0), LOCAL_ZONE), endDate: fakeDate(day(0), LOCAL_ZONE) });
    await expectRefused(zeroLength, { all_day: false, start_iso: at(0, 10) }, /^the edit would leave the start timed and the end all-day/);
  });

  it('an all-day end alone on the event\'s own first day', async () => {
    await expectRefused(() => allDayEvent(2), { end_iso: `${day(0)}T00:00:00` }, /^this is an all-day event, so its end_iso is the day after its last day/);
  });
});
