/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEditResultText.test.js: what the assistant is told after a
// confirmed edit, for each scope: the slice of the series that changed, the
// scope written (a whole-series time change named at a later occurrence is
// written from that occurrence on, and says so), and the event the write
// left (a split's following part is a new event). An edit that changes
// nothing says so. Through the real edit tool, card and bridge on
// Thunderbird's own dates.

// card and bridge on Thunderbird's own dates.

process.env.TZ = 'America/Los_Angeles';

import { describe, it, expect, vi } from 'vitest';

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

const flow = await import('./helpers/seriesEditFlow.js');
const { onCalendar, seriesOf, edit, iso } = flow;

const LA = 'America/Los_Angeles';
const series = () => seriesOf({ tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10' });
const ONLY = (rid) => `Calendar event modified successfully — edit_scope: this_only (only the occurrence on ${rid}; other occurrences untouched).`;
const FOLLOWING = (rid) => `Calendar event modified successfully — edit_scope: this_and_following (this and all later occurrences from ${rid}; earlier ones untouched).`;
const ALL = 'Calendar event modified successfully — edit_scope: all (the entire event/series).';
const NOTHING_CHANGED = 'Nothing changed: the event already has every time and value this edit gives, so nothing was written and no confirmation was shown.';

describe('what the assistant is told after the edit', () => {
  it('one occurrence: that occurrence only, on the series', async () => {
    onCalendar([series()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: iso('2099-01-12', 10), title: 'Day shift' });
    expect(run.state).toBe('exec_success');
    expect(run.result).toMatchObject({ ok: true, result: ONLY(iso('2099-01-12', 10)), edit_scope: 'this_only', event_id: 'ser' });
  });

  it('from an occurrence on: that occurrence and the later ones, on the new following part', async () => {
    const loaded = onCalendar([series()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-01-14', 10), title: 'Day shift' });
    expect(run.state).toBe('exec_success');
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    expect(run.result).toMatchObject({ ok: true, result: FOLLOWING(iso('2099-01-14', 10)), edit_scope: 'this_and_following', event_id: part.id });
  });

  it('the whole series: every occurrence, on the series', async () => {
    onCalendar([series()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', title: 'Day shift' });
    expect(run.state).toBe('exec_success');
    expect(run.result).toMatchObject({ ok: true, result: ALL, edit_scope: 'all', event_id: 'ser' });
  });

  it('a whole-series time change named at a later occurrence: written from that occurrence on, and told so', async () => {
    const loaded = onCalendar([series()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'all', recurrence_id: iso('2099-01-14', 10), start_iso: iso('2099-01-14', 9) });
    expect(run.state).toBe('exec_success');
    expect(loaded.calendar.items).toHaveLength(2);
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    expect(run.result).toMatchObject({ ok: true, result: FOLLOWING(iso('2099-01-14', 10)), edit_scope: 'this_and_following', event_id: part.id });
  });

  it('an edit that changes nothing: Nothing changed, on every scope', async () => {
    for (const args of [
      { edit_scope: 'this_only', recurrence_id: iso('2099-01-12', 10), title: 'Night shift' },
      { edit_scope: 'this_and_following', recurrence_id: iso('2099-01-14', 10), title: 'Night shift' },
      { edit_scope: 'all', title: 'Night shift' },
    ]) {
      const loaded = onCalendar([series()], LA);
      const run = await edit({ event_id: 'ser', ...args });
      expect(run.result, args.edit_scope).toEqual({ ok: true, result: NOTHING_CHANGED });
      expect(loaded.modifications).toHaveLength(0);
    }
  });

  it('one changed occurrence: the title reported is that occurrence\'s own, not the series\'', async () => {
    const { at } = await import('./helpers/nativeCalendarDates.js');
    const rid = at(LA, '2099-01-12', 10);
    const end = at(LA, '2099-01-12', 11);
    onCalendar([seriesOf({ tzid: LA, day: '2099-01-10', hour: 10, rule: 'FREQ=DAILY;COUNT=10', changed: [{ rid, start: rid, end, title: 'Cover shift' }] })], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: iso('2099-01-12', 10), location: 'Ward B' });
    expect(run.state).toBe('exec_success');
    expect(run.result).toMatchObject({ ok: true, edit_scope: 'this_only', event_id: 'ser', recurrence_id: iso('2099-01-12', 10), event_title: 'Cover shift' });
  });

  it('a split moved to an earlier day: the event id is paired with the occurrence it names', async () => {
    const loaded = onCalendar([series()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-01-14', 10), start_iso: iso('2099-01-13', 9), end_iso: iso('2099-01-13', 10) });
    expect(run.failReason, 'refused').toBeUndefined();
    expect(run.state).toBe('exec_success');
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    // The slice the user named is still told by the occurrence they named.
    expect(run.result.result).toBe(FOLLOWING(iso('2099-01-14', 10)));
    // The pair (event_id, recurrence_id) names the new part's first occurrence.
    expect(run.result.event_id).toBe(part.id);
    expect(run.result.recurrence_id).toBe(iso('2099-01-13', 9));
    const read = await flow.readOccurrence(run.result.recurrence_id);
    expect(read.start_iso).toBe(iso('2099-01-13', 9));
  });

  // Round trip: the recurrence_id an edit returns is the read tools'
  // recurrence_id for that occurrence, and given back it names that occurrence.
  async function roundTrip(eventId, rid, startIso) {
    const read = await flow.readOccurrence(startIso);
    expect(flow.field(read.text, 'recurrence_id'), 'read prints the returned id').toBe(rid);
    const again = await edit({ event_id: eventId, edit_scope: 'this_only', recurrence_id: rid, title: 'Renamed' });
    expect(again.failReason, 'the returned id names an occurrence').toBeUndefined();
    expect(again.state).toBe('exec_success');
    expect((await flow.readOccurrence(startIso)).text).toContain('Renamed');
  }

  it('round trip: one occurrence moved, then edited again by the id the move returned', async () => {
    onCalendar([series()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_only', recurrence_id: iso('2099-01-12', 10), start_iso: iso('2099-01-12', 15), end_iso: iso('2099-01-12', 16) });
    expect(run.state).toBe('exec_success');
    expect(run.result.event_id).toBe('ser');
    expect(run.result.recurrence_id).toBe(iso('2099-01-12', 15));
    await roundTrip('ser', run.result.recurrence_id, iso('2099-01-12', 15));
  });

  it('round trip: a split moved a day earlier, then edited by the pair it returned', async () => {
    const loaded = onCalendar([series()], LA);
    const run = await edit({ event_id: 'ser', edit_scope: 'this_and_following', recurrence_id: iso('2099-01-14', 10), start_iso: iso('2099-01-13', 9), end_iso: iso('2099-01-13', 10) });
    expect(run.state).toBe('exec_success');
    const part = loaded.calendar.items.find((it) => it.id !== 'ser');
    expect(run.result.event_id).toBe(part.id);
    await roundTrip(run.result.event_id, run.result.recurrence_id, iso('2099-01-13', 9));
  });
});

