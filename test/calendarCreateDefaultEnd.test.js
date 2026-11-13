/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarCreateDefaultEnd.test.js: a create given no end lasts the default
// length from its start AS THE CALENDAR STORES IT, around the night the
// clocks go back (#393). From the create tool's `run`, with the real argument
// reader, to the real calendar bridge's write, on Thunderbird's own dates
// (ical.js, test/helpers/nativeCalendarDates.js), each bridge call checked
// against the experiment's schema.json. The calendar stores a time the clocks
// repeat as its second pass; an end inside the repeated hour is written in the
// form the tools print it, with its UTC offset, and stored at that moment.
//
// The fall-back night is found from today on the process clock, which reads
// the same rules as the test zones. The expected values come from that clock
// (process.env.TZ), never from the tool's zone arithmetic.

process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi } from 'vitest';

globalThis.browser = {
  tmCalendar: {},
  storage: { local: { get: vi.fn(async () => ({ defaultCalendarId: 'cal1' })), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined) },
};
globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../chat/modules/helpers.js', async () => {
  const actual = await vi.importActual('../chat/modules/helpers.js');
  return { toNaiveIso: actual.toNaiveIso, toIsoNoMs: actual.toIsoNoMs, streamText: vi.fn() };
});
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn(async () => ({ textContent: '', classList: { add: vi.fn(), remove: vi.fn() } })) }));
vi.mock('../chat/modules/context.js', () => ({
  ctx: { activePid: 0, awaitingPid: 0, activeToolCallId: null, fsmSessions: Object.create(null), state: null, toolExecutionMode: null, rawUserTexts: ['original request'] },
  initFsmSession: vi.fn(),
}));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: vi.fn(async () => {}) }));

const { nativeLoaded } = await import('./helpers/nativeCalendarDates.js');
const { checked } = await import('./helpers/calendarSchemaCheck.js');
const { run } = await import('../chat/tools/calendar_event_create.js');
const { ctx } = await import('../chat/modules/context.js');
const { CHAT_SETTINGS } = await import('../chat/modules/chatConfig.js');

const MINUTE_MS = 60 * 1000;
const QUARTER_MS = 15 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAYS_SEARCHED = 800;
const DAYS_AHEAD = 30;
const minutes = CHAT_SETTINGS.createEventDefaultDurationMinutes;
const LENGTH_MS = minutes * MINUTE_MS;
const NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const pad2 = (n) => String(n).padStart(2, '0');

function onClock(zone, fn) {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try { return fn(); } finally { process.env.TZ = was; }
}
async function onClockAsync(zone, fn) {
  const was = process.env.TZ;
  process.env.TZ = zone;
  try { return await fn(); } finally { process.env.TZ = was; }
}
const localDigits = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
// A moment's digits and UTC offset (minutes east) on `zone`'s clock.
const digitsOn = (zone, ms) => onClock(zone, () => localDigits(new Date(ms)));
const offsetOn = (zone, ms) => onClock(zone, () => -new Date(ms).getTimezoneOffset());
const label = (m) => `UTC${m < 0 ? '-' : '+'}${Math.floor(Math.abs(m) / 60)}${Math.abs(m) % 60 ? `:${pad2(Math.abs(m) % 60)}` : ''}`;

// The next time `zone`'s clocks go back, from now: the first moment at the
// later offset (`at`), and how far they go back (`back`). The moments
// [at - back, at) and [at, at + back) show the same digits.
function nextFallBack(zone) {
  const now = Date.now() - (Date.now() % QUARTER_MS);
  const found = onClock(zone, () => {
    const offset = (ms) => -new Date(ms).getTimezoneOffset();
    for (let ms = now; ms < now + DAYS_SEARCHED * DAY_MS; ms += QUARTER_MS) {
      const back = offset(ms - QUARTER_MS) - offset(ms);
      if (back > 0) return { at: ms, back: back * MINUTE_MS };
    }
    return null;
  });
  if (!found) throw new Error(`no fall-back night in ${zone}`);
  return found;
}
// A moment as the tools print it on `zone`'s clock: with its offset only when
// it is in that night's repeated hour.
const shownOn = (zone, fb, ms) => {
  const repeated = ms >= fb.at - fb.back && ms < fb.at + fb.back;
  return repeated ? `${digitsOn(zone, ms)} (${label(offsetOn(zone, ms))})` : digitsOn(zone, ms);
};

let nextPid = 0;
// Runs the tool on a computer in `computer` (Thunderbird's zone too) to the
// card, then writes what the card holds through the real bridge, as the
// confirmed create does. Returns the card's values and the stored moments.
async function createAndStore(computer, args) {
  return onClockAsync(computer, async () => {
    const loaded = nativeLoaded([], computer);
    const schemaErrors = [];
    globalThis.browser.tmCalendar = checked(loaded.api, schemaErrors);
    const pid = `pid-default-end-${nextPid += 1}`;
    ctx.fsmSessions[pid] = {};
    ctx.state = null;
    await run({ title: 'Sync', calendar_id: 'cal1', ...args }, { callId: pid });
    await new Promise((r) => setTimeout(r, 5));
    const sess = ctx.fsmSessions[pid];
    expect(sess.failReason).toBeUndefined();
    const res = await globalThis.browser.tmCalendar.createCalendarEvent(sess.createEventArgs);
    expect(res, res?.error).toMatchObject({ ok: true });
    expect(schemaErrors).toEqual([]);
    expect(loaded.calendar.items).toHaveLength(1);
    const item = loaded.calendar.items[0];
    return {
      card: sess.createEventArgs,
      storedStart: item?.startDate ? item.startDate.nativeTime / 1000 : null,
      storedEnd: item?.endDate ? item.endDate.nativeTime / 1000 : null,
    };
  });
}

// An end in the first pass of the repeated hour: a start that much before
// it, in New York given on computers elsewhere, and on the user's own clock
// (no timezone). With the configured 45 minutes, a 00:30 start.
describe('a create with no end whose default end falls in the first pass of the repeated hour', () => {
  for (const [label_, zone, timezone, computers] of [
    ['in New York given on a computer in another zone', 'America/New_York', 'America/New_York', ['America/Los_Angeles', 'Australia/Sydney']],
    ['on the user\'s own clock', 'America/Los_Angeles', undefined, ['America/Los_Angeles']],
  ]) {
    const fb = nextFallBack(zone);
    const endAt = fb.at - fb.back + QUARTER_MS;
    const startAt = endAt - LENGTH_MS;
    const startIso = digitsOn(zone, startAt);
    for (const computer of computers) {
      it(`${label_} (${computer}): the end is written with its UTC offset and stored at the start plus the default length`, async () => {
        expect(endAt).toBeLessThan(fb.at);
        expect(shownOn(zone, fb, startAt)).toBe(startIso);
        const { card, storedStart, storedEnd } = await createAndStore(computer, { start_iso: startIso, ...(timezone ? { timezone } : {}) });
        expect(card.start_iso).toBe(startIso);
        expect(card.end_iso).toBe(shownOn(zone, fb, endAt));
        expect(card.end_iso).toBe(`${digitsOn(zone, endAt)} (${label(offsetOn(zone, endAt))})`);
        expect(storedStart).toBe(startAt);
        expect(storedEnd).toBe(endAt);
      });
    }
  }
});

// A bare start inside the repeated hour is stored as its second pass. The
// default end is the length after THAT start, so the event ends after it
// starts; the end prints with its offset only when it is still in the
// repeated hour.
describe('a create with no end whose start is in the repeated hour', () => {
  for (const [label_, zone, timezone, computer] of [
    ['on the user\'s own clock', 'America/Los_Angeles', undefined, 'America/Los_Angeles'],
    ['in New York given on a computer in another zone', 'America/New_York', 'America/New_York', 'America/Los_Angeles'],
  ]) {
    const fb = nextFallBack(zone);
    for (const [where, secondPassStart] of [
      ['at the start of the repeated hour', fb.at],
      ['in the middle of the repeated hour', fb.at + fb.back / 2],
    ]) {
      const startIso = digitsOn(zone, secondPassStart);
      it(`${label_}, ${where}: the end is the default length after the stored start`, async () => {
        const { card, storedStart, storedEnd } = await createAndStore(computer, { start_iso: startIso, ...(timezone ? { timezone } : {}) });
        expect(card.start_iso).toBe(startIso);
        expect(storedEnd - storedStart).toBe(LENGTH_MS);
        expect(storedEnd).toBeGreaterThan(storedStart);
        expect(card.end_iso).toBe(shownOn(zone, fb, storedStart + LENGTH_MS));
      });
    }
  }
});

// An end outside the repeated hour is the plain wall clock, as before.
describe('a create with no end whose end is outside the repeated hour', () => {
  const zone = 'America/New_York';
  const computer = 'America/Los_Angeles';
  const fb = nextFallBack(zone);
  const ordinary = onClock(zone, () => {
    const t = new Date();
    return localDigits(new Date(t.getFullYear(), t.getMonth(), t.getDate() + DAYS_AHEAD, 10));
  });
  for (const [where, startIso] of [
    ['an ordinary day', ordinary],
    ['the fall-back night, after the repeated hour', digitsOn(zone, fb.at + fb.back)],
    ['the fall-back night, a start in the repeated hour whose end is after it', digitsOn(zone, fb.at + fb.back - QUARTER_MS)],
  ]) {
    it(`${where}: the end is the zone's plain wall clock, the default length after the stored start`, async () => {
      const { card, storedStart, storedEnd } = await createAndStore(computer, { start_iso: startIso, timezone: zone });
      expect(card.end_iso).toMatch(NAIVE);
      expect(card.end_iso).toBe(digitsOn(zone, storedStart + LENGTH_MS));
      expect(storedEnd - storedStart).toBe(LENGTH_MS);
    });
  }
});
