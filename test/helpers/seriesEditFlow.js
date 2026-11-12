/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// An edit or a delete as the user sees it, on Thunderbird's own dates: the
// real tool (its check before the card), the real card states (the card text,
// then the confirmed write) and the real bridge, then the read tools as the assistant
// reads the result. The test file mocks the chat modules first (vi.mock), as
// calendarCardAllDayDates.test.js does, and sets process.env.TZ to the user's
// zone; the modules are imported here when first used, so they are the mocked
// ones.

import { fakeEvent, fakeRecurrenceInfo, recurrenceItem, recurrenceDate } from './calendarBridgeHarness.js';
import { nativeLoaded, at, digits } from './nativeCalendarDates.js';
import { checked } from './calendarSchemaCheck.js';

let mods = null;
async function modules() {
  mods ??= {
    edit: await import('../../chat/tools/calendar_event_edit.js'),
    read: await import('../../chat/tools/calendar_event_read.js'),
    fsm: await import('../../chat/fsm/calendarEdit.js'),
    helpers: await import('../../chat/modules/helpers.js'),
    context: await import('../../chat/modules/context.js'),
  };
  return mods;
}

/** The bridge over `items`, the user in `userTzid`, as the tools reach it. */
export function onCalendar(items, userTzid) {
  const loaded = nativeLoaded(items, userTzid);
  globalThis.browser.tmCalendar = checked(loaded.api, []);
  return loaded;
}

/** `day` ("YYYY-MM-DD") plus `n` days. */
export function dayPlus(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const pad2 = (n) => String(n).padStart(2, '0');
/** "YYYY-MM-DDTHH:MM:00". */
export const iso = (day, hour, minute = 0) => `${day}T${pad2(hour)}:${pad2(minute)}:00`;

/**
 * A series in `tzid` starting `day` at `hour`:`minute`, ending `end` (a date
 * value) or a plain clock add of `hours`, repeating `rule` (daily unless
 * given), with changed occurrences (`changed`: `{ rid, start, end, title?,
 * location?, isDate? }`, each a date value) and excluded dates (`exdates`,
 * RECURRENCE-IDs).
 */
export function seriesOf({ tzid, day, hour = 22, minute = 0, hours = 1, end = null, rule = 'FREQ=DAILY;COUNT=60', changed = [], exdates = [], title = 'Night shift', id = 'ser' }) {
  const startDate = at(tzid, day, hour, minute);
  let endDate = end;
  if (!endDate) {
    endDate = startDate.clone();
    endDate.hour += hours;
  }
  const ev = fakeEvent({ id, title, startDate, endDate, properties: { LOCATION: 'Ward A' } });
  const exceptions = changed.map((c) => {
    const ex = fakeEvent({ id, title: c.title || title, startDate: c.start, endDate: c.end, recurrenceId: c.rid, properties: { LOCATION: c.location || 'Ward A' } });
    return ex;
  });
  ev.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', rule), ...exdates.map((rid) => recurrenceDate('EXDATE', rid))], { exceptions });
  ev.recurrenceInfo.item = ev;
  return ev;
}

let nextPid = 0;
/**
 * Runs an edit through the tool and, when the tool shows the card, the card
 * state and (unless `confirm` is false) the confirmed write. Returns the
 * session, the final state, the failure the assistant is told, the card's
 * details and changes, and the tool's result (completeExecution).
 */
export async function edit(args, { confirm = true } = {}) {
  const { edit: tool, fsm, helpers, context } = await modules();
  const { ctx } = context;
  const pid = `pid-series-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  helpers.streamText.mockClear();
  await tool.run({ calendar_id: 'cal1', ...args }, { callId: pid });
  for (let i = 0; i < 2000 && !ctx.state; i++) await new Promise((r) => setTimeout(r, 1));
  const sess = ctx.fsmSessions[pid];
  const out = { sess, card: null, header: null, changes: null };
  const was = ctx.activePid;
  ctx.activePid = pid;
  try {
    if (ctx.state === 'calendar_event_edit_list') {
      helpers.streamText.mockClear();
      await fsm.runStateEditCalendarEventList();
      out.card = helpers.streamText.mock.calls.map((c) => String(c[1])).find((t) => t.startsWith('I found this calendar event')) || null;
      if (out.card) [out.header, out.changes] = out.card.split('Proposed changes:');
      // The user confirms: the planner moves to the exec state and records it
      // as the previous state (core.js runStatePlanNextAction), which is what
      // completeExecution reads to report the write.
      if (confirm && out.card) {
        sess.fsmPrevState = 'calendar_event_edit_exec';
        await fsm.runStateEditCalendarEventExec();
      }
    }
    out.state = ctx.state;
    out.failReason = sess.failReason;
    out.result = await tool.completeExecution(ctx.state, sess.fsmPrevState);
  } finally {
    ctx.activePid = was;
  }
  return out;
}

let deleteMods = null;
async function deleteModules() {
  deleteMods ??= {
    tool: await import('../../chat/tools/calendar_event_delete.js'),
    fsm: await import('../../chat/fsm/calendarDelete.js'),
    relay: await import('../../chatlink/modules/fsm.js'),
  };
  return deleteMods;
}

/**
 * Runs a delete through the tool and, when the tool shows the card, the card
 * state and (unless `confirm` is false) the confirmed write, as edit() does.
 * Returns the session, the final state, the failure the assistant is told,
 * the card (the bubble's text), what the ChatLink relay sent, the bubble after
 * the write, and the tool's result (completeExecution).
 */
export async function remove(args, { confirm = true } = {}) {
  const { helpers, context } = await modules();
  const { tool, fsm, relay } = await deleteModules();
  const { ctx } = context;
  const pid = `pid-series-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  helpers.streamText.mockClear();
  relay.relayFsmConfirmation.mockClear();
  await tool.run({ calendar_id: 'cal1', ...args }, { callId: pid });
  for (let i = 0; i < 2000 && !ctx.state; i++) await new Promise((r) => setTimeout(r, 1));
  const sess = ctx.fsmSessions[pid];
  const out = { sess, card: null, relayed: null, done: null };
  const was = ctx.activePid;
  ctx.activePid = pid;
  try {
    if (ctx.state === 'calendar_event_delete_list') {
      helpers.streamText.mockClear();
      await fsm.runStateDeleteCalendarEventList();
      out.card = helpers.streamText.mock.calls.map((c) => String(c[1])).find((t) => t.startsWith('I found this calendar event')) || null;
      out.relayed = relay.relayFsmConfirmation.mock.calls[0]?.[0] ?? null;
      if (confirm && out.card) {
        sess.fsmPrevState = 'calendar_event_delete_exec';
        helpers.streamText.mockClear();
        await fsm.runStateDeleteCalendarEventExec();
        out.done = helpers.streamText.mock.calls.map((c) => String(c[1])).at(-1) ?? null;
      }
    }
    out.state = ctx.state;
    out.failReason = sess.failReason;
    out.result = await tool.completeExecution(ctx.state, sess.fsmPrevState);
  } finally {
    ctx.activePid = was;
  }
  return out;
}

/** A card change: the old and new value of the line after `**label:**`, or null. */
export function cardChange(changes, label) {
  const lines = String(changes || '').split('\n');
  const i = lines.findIndex((l) => l === `**${label}:**`);
  if (i < 0) return null;
  const m = /^ {2}(.*) → \*\*(.*)\*\*$/.exec(lines[i + 1] || '');
  return m ? { from: m[1], to: m[2] } : null;
}

/** The card's Start or End change, whichever label it has (time or date). */
export function timeChange(changes, side) {
  return cardChange(changes, `${side} time`) || cardChange(changes, `${side} date`);
}

/** A line `label: value` of a card's details or a read tool's result. */
export function field(text, label) {
  const m = new RegExp(`^${label}: (.*)$`, 'm').exec(String(text || ''));
  return m ? m[1] : null;
}

/** calendar_event_read of the series (by its id). */
export async function readSeries(id = 'ser') {
  const { read } = await modules();
  const res = await read.run({ event_id: id, calendar_id: 'cal1' });
  return { start_iso: field(res.results, 'start_iso'), end_iso: field(res.results, 'end_iso'), text: res.results };
}

/** calendar_event_read of the occurrence starting at `startIso` ("No entries matched." gives nulls). */
export async function readOccurrence(startIso, title = null) {
  const { read } = await modules();
  const res = await read.run({ start_iso: startIso, ...(title ? { title } : {}) });
  return { start_iso: field(res.results, 'start_iso'), end_iso: field(res.results, 'end_iso'), all_day: field(res.results, 'all_day'), text: res.results };
}

/** formatCardTime of a printed value, as the card prints it. */
export async function asCard(naiveIso, opts = {}) {
  const { helpers } = await modules();
  return helpers.formatCardTime(naiveIso, opts);
}

/**
 * Every occurrence Thunderbird returns for the stored series `item` in
 * [from, to) days, with its start and end digits and kind: what I1 checks.
 */
export function occurrencesOf(item, fromDay, toDay) {
  const tzid = item.startDate.timezone.tzid === 'floating' ? 'UTC' : item.startDate.timezone.tzid;
  const range = (day) => at(tzid === 'UTC' ? 'UTC' : tzid, day, 0, 0);
  return [...item.recurrenceInfo.getOccurrences(range(fromDay), range(toDay), 0)].map((occ) => ({
    start: digits(occ.startDate), end: digits(occ.endDate), isDate: !!occ.startDate.isDate,
    tzid: occ.startDate.timezone.tzid, changed: occ !== null && !!item.recurrenceInfo.getExceptionFor(occ.recurrenceId),
    occ,
  }));
}

/** Wall-clock seconds between two digit strings. */
export function clockDiff(endDigits, startDigits) {
  return (Date.parse(`${endDigits}Z`) - Date.parse(`${startDigits}Z`)) / 1000;
}

/**
 * One row of the series time tables, through the tool: the edit is confirmed
 * and written, then
 *   I1: every occurrence Thunderbird returns in [fromDay, toDay), of the
 *       series' kind and zone, plain or changed, lasts W by its digits;
 *   I2: the named occurrence, read back, ends at `namedEnd`;
 *   I3: the card's Start and End lines are what the read tool prints after
 *       the write;
 *   I4: Thunderbird's own length of the stored series is W.
 * Returns the stored series and the run.
 */
export async function seriesRow(loaded, args, { W, namedStart, namedEnd, fromDay, toDay }) {
  const { expect } = await import('vitest');
  const run = await edit(args);
  expect(run.failReason, 'refused').toBeUndefined();
  expect(run.card, 'no card').toBeTruthy();
  expect(run.state).toBe('exec_success');
  const stored = loaded.calendar.items.find((it) => it.id === (args.event_id || 'ser'));
  const tzid = stored.startDate.timezone.tzid;
  for (const o of occurrencesOf(stored, fromDay, toDay)) {
    if (o.isDate !== !!stored.startDate.isDate || o.tzid !== tzid) continue;
    expect(clockDiff(o.end, o.start), `I1 ${o.start} to ${o.end}`).toBe(W);
  }
  const named = await readOccurrence(namedStart);
  expect(named.start_iso, 'I2 the named occurrence is read').toBe(namedStart);
  expect(named.end_iso, 'I2').toBe(namedEnd);
  const end = timeChange(run.changes, 'End');
  if (end) expect(end.to, 'I3 End').toBe(await asCard(named.end_iso));
  const start = timeChange(run.changes, 'Start');
  if (start) expect(start.to, 'I3 Start').toBe(await asCard(named.start_iso));
  expect(stored.endDate.subtractDate(stored.startDate).inSeconds, 'I4').toBe(W);
  return { stored, run };
}
