/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarSeriesDeleteCard.test.js: calendar_event_delete removes the whole
// stored item, so deleting a repeating event deletes every occurrence of it.
// Invariant: whenever the confirmed delete removes a repeating series, the
// confirmation card (the bubble and the ChatLink relay) says every occurrence
// goes and, when the stored rule can be fully stated, names it; nothing is
// deleted before the confirmation. Through the real bridge on an in-memory
// calendar and the real delete FSM states.

// West of UTC, so a UTC UNTIL instant names the next day in UTC digits.
process.env.TZ = 'America/Vancouver';

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

// ---------- Module mocks (as in calendarEditScope.test.js) ----------
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));

const mockBubble = {
  textContent: '',
  classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
};
vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => mockBubble),
}));

const fsmCtx = {
  activePid: 'pid-test',
  activeToolCallId: 'pid-test',
  fsmSessions: { 'pid-test': {} },
  state: '',
  pendingSuggestion: null,
  rawUserTexts: [],
};
vi.mock('../chat/modules/context.js', () => ({
  ctx: fsmCtx,
  initFsmSession: vi.fn(),
}));

vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
const streamText = vi.fn();
vi.mock('../chat/modules/helpers.js', () => ({
  formatNaiveIsoInTimezone: vi.fn((iso) => iso),
  formatTimestampForAgent: vi.fn((d) => d.toISOString()),
  streamText: (...a) => streamText(...a),
  toNaiveIso: vi.fn((s) => s),
}));
const relayFsmConfirmation = vi.fn(async () => {});
vi.mock('../chatlink/modules/fsm.js', () => ({
  relayFsmConfirmation: (...a) => relayFsmConfirmation(...a),
}));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: vi.fn(async () => {}) }));

globalThis.window = globalThis.window || {};

const {
  loadCalendarBridge, fakeCalDateTime, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem,
} = await import('./helpers/calendarBridgeHarness.js');
const { runStateDeleteCalendarEventList, runStateDeleteCalendarEventExec } = await import('../chat/fsm/calendarDelete.js');
const { run: runEventRead } = await import('../chat/tools/calendar_event_read.js');

// ---------- Dates, all relative to today ----------
const DAY_MS = 86400 * 1000;
const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const digits = (day) => day.replace(/-/g, '');
const daysFromToday = (n) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d;
};
// The first Monday at least a week ahead, so a weekly MO/WE series starts on
// an occurrence of its own rule.
const SERIES_START = (() => {
  const d = daysFromToday(7);
  while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
  return localDay(d);
})();
const START_HOUR = 17;

// A local wall-clock time as a UTC RRULE UNTIL value.
function utcUntil(day, hour, minute = 0, second = 0) {
  const [y, m, d] = day.split('-').map(Number);
  const u = new Date(y, m - 1, d, hour, minute, second);
  return `${u.getUTCFullYear()}${pad2(u.getUTCMonth() + 1)}${pad2(u.getUTCDate())}T${pad2(u.getUTCHours())}${pad2(u.getUTCMinutes())}${pad2(u.getUTCSeconds())}Z`;
}

function series(id, recurrenceItems) {
  const start = fakeDateTime(SERIES_START, START_HOUR);
  const ev = fakeEvent({
    id, title: 'Team sync', startDate: start, endDate: fakeCalDateTime({ ...start, hour: START_HOUR + 1 }),
  });
  ev.recurrenceInfo = fakeRecurrenceInfo(recurrenceItems);
  ev.recurrenceInfo.item = ev;
  return ev;
}

function oneOff(id) {
  const start = fakeDateTime(SERIES_START, START_HOUR);
  return fakeEvent({ id, title: 'Dentist', startDate: start, endDate: fakeCalDateTime({ ...start, hour: START_HOUR + 1 }) });
}

const SERIES_LINE = 'Repeating event: every occurrence will be deleted';

function load(items) {
  const harness = loadCalendarBridge(bridgeUrl, { items });
  globalThis.browser = { tmCalendar: harness.api };
  return harness;
}

// The card text the bubble shows and the relay sends, before any delete.
async function showCard(eventId, harness) {
  fsmCtx.fsmSessions['pid-test'] = { deleteEventArgs: { event_id: eventId } };
  await runStateDeleteCalendarEventList();
  expect(fsmCtx.state).not.toBe('exec_fail');
  const card = streamText.mock.calls.map((c) => c[1]).find((t) => t.startsWith('I found this calendar event'));
  expect(card).toBeTruthy();
  expect(relayFsmConfirmation).toHaveBeenCalledTimes(1);
  const relayed = relayFsmConfirmation.mock.calls[0][0];
  expect(relayed.startsWith(card)).toBe(true);
  expect(harness.deletions).toEqual([]);
  return card;
}

async function confirmDelete() {
  await runStateDeleteCalendarEventExec();
  expect(fsmCtx.state).toBe('exec_success');
}

const repeatsLine = (card) => (card.match(/^Repeats .*$/m) || [])[0] || null;

describe('delete card for a repeating event', () => {
  beforeEach(() => {
    streamText.mockClear();
    relayFsmConfirmation.mockClear();
    fsmCtx.state = '';
    fsmCtx.fsmSessions = { 'pid-test': {} };
  });

  it('a series by its id: the card says every occurrence goes and names the rule; the confirm deletes the series', async () => {
    const harness = load([series('ser', [recurrenceItem('RRULE', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10')])]);
    const card = await showCard('ser', harness);
    expect(card).toContain(SERIES_LINE);
    expect(repeatsLine(card)).toBe('Repeats every 2 weeks on Monday, Wednesday (10 times)');
    await confirmDelete();
    expect(harness.calendar.items).toEqual([]);
  });

  it('the id from a later occurrence\'s search row: the same card, and the series is deleted', async () => {
    const harness = load([series('ser', [recurrenceItem('RRULE', 'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=10')])]);
    const from = localDay(daysFromToday(0));
    const to = localDay(daysFromToday(120));
    const rows = await harness.api.queryCalendarItems(`${from}T00:00:00`, `${to}T00:00:00`, ['cal1']);
    const later = rows.filter((r) => r.recurrenceId);
    expect(later.length).toBe(10);
    const row = later[later.length - 1];
    const card = await showCard(row.id, harness);
    expect(card).toContain(SERIES_LINE);
    expect(repeatsLine(card)).toBe('Repeats every 2 weeks on Monday, Wednesday (10 times)');
    await confirmDelete();
    expect(harness.calendar.items).toEqual([]);
  });

  it('a series by added dates alone: the series line, no Repeats line', async () => {
    const harness = load([series('ser', [
      recurrenceItem('RDATE', `${digits(localDay(daysFromToday(30)))}T170000`),
      recurrenceItem('RDATE', `${digits(localDay(daysFromToday(40)))}T170000`),
    ])]);
    const card = await showCard('ser', harness);
    expect(card).toContain(SERIES_LINE);
    expect(repeatsLine(card)).toBeNull();
    await confirmDelete();
    expect(harness.calendar.items).toEqual([]);
  });

  for (const rule of ['FREQ=MONTHLY;BYDAY=TU;BYSETPOS=2', 'FREQ=HOURLY;COUNT=5']) {
    it(`a rule the fields cannot fully state (${rule}): the series line only, never a wrong rule`, async () => {
      const harness = load([series('ser', [recurrenceItem('RRULE', rule)])]);
      const card = await showCard('ser', harness);
      expect(card).toContain(SERIES_LINE);
      expect(repeatsLine(card)).toBeNull();
      await confirmDelete();
      expect(harness.calendar.items).toEqual([]);
    });
  }

  it('an UNTIL series: the card\'s last day is the one calendar_event_read shows', async () => {
    const lastDay = localDay(daysFromToday(60));
    const harness = load([series('ser', [recurrenceItem('RRULE', `FREQ=DAILY;UNTIL=${utcUntil(lastDay, 23, 59, 59)}`)])]);
    const read = await runEventRead({ event_id: 'ser' });
    expect(read.ok).toBe(true);
    const readUntil = (/"until":"(\d{4}-\d{2}-\d{2})"/.exec(read.results) || [])[1];
    expect(readUntil).toBe(lastDay);
    const card = await showCard('ser', harness);
    expect(card).toContain(SERIES_LINE);
    expect(repeatsLine(card)).toBe(`Repeats daily (until ${readUntil})`);
  });

  it('a one-off event: no series line', async () => {
    const harness = load([oneOff('one')]);
    const card = await showCard('one', harness);
    expect(card).not.toContain(SERIES_LINE);
    expect(repeatsLine(card)).toBeNull();
    await confirmDelete();
    expect(harness.calendar.items).toEqual([]);
  });
});
