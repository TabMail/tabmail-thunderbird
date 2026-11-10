/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEditScope.test.js — Tests for the FSM exec routing layer of
// calendar_event_edit (edit_scope dispatch + bridge args sanitization).
//
// Mocks `browser.tmCalendar` at the module-load layer so we can assert which
// bridge method was called and with what arguments. The routing logic in
// runStateEditCalendarEventExec is what the user reported a bug against (the
// bridge rejected `edit_scope` as an unknown property), so the regression test
// here verifies the JS-only field is stripped before the bridge call.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

// ---------- Module mocks ----------
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));

const mockBubble = {
  textContent: '',
  classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
};
vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => mockBubble),
}));

// ctx is a shared mutable state object — the FSM functions read editEventArgs
// from ctx.fsmSessions[pid].
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
vi.mock('../chat/modules/helpers.js', () => ({
  formatNaiveIsoInTimezone: vi.fn((iso) => iso),
  formatTimestampForAgent: vi.fn((d) => String(d)),
  streamText: vi.fn(),
  toNaiveIso: vi.fn((s) => s),
}));
vi.mock('../chatlink/modules/fsm.js', () => ({
  relayFsmConfirmation: vi.fn(async () => {}),
}));

// FSM core's executeAgentAction is invoked at the end of the exec branch to
// progress the state machine — we don't care what it does in these tests.
vi.mock('../chat/fsm/core.js', () => ({
  executeAgentAction: vi.fn(async () => {}),
}));

// browser.tmCalendar surface — we instrument both modifyCalendarEvent and
// splitRecurringEvent so we can assert which was called and inspect args.
const modifyMock = vi.fn(async () => ({ ok: true, event_id: 'evt', title: 't' }));
const splitMock = vi.fn(async () => ({ ok: true, event_id: 'newevt', title: 't' }));
const getCalendarEventDetailsMock = vi.fn(async () => ({
  ok: true,
  attendeeList: [{ email: 'existing@example.com', name: 'Existing' }],
}));

globalThis.browser = {
  tmCalendar: {
    modifyCalendarEvent: modifyMock,
    splitRecurringEvent: splitMock,
    getCalendarEventDetails: getCalendarEventDetailsMock,
  },
};
// runStateEditCalendarEventExec touches `window.tmShowSuggestion` indirectly via
// imports; provide a no-op to avoid load errors in jsdom-free environments.
globalThis.window = globalThis.window || {};

// ---------- Import under test ----------
const { runStateEditCalendarEventExec } = await import('../chat/fsm/calendarEdit.js');

// ---------- Helpers ----------
// Recurrence-id shared across the scope tests. Generated dynamically (project
// rule: no hardcoded dates in tests). It is an opaque pass-through token here —
// the `toNaiveIso` / `formatNaiveIsoInTimezone` mocks are identity functions —
// so the only requirement is that the same value is set on the args and
// asserted back out of the bridge call / editResult.
const RID = (() => {
  const d = new Date();
  d.setDate(d.getDate() + 14);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T17:00:00`;
})();

function setEditArgs(args) {
  fsmCtx.fsmSessions['pid-test'] = { editEventArgs: args };
}

describe('runStateEditCalendarEventExec — edit_scope dispatch', () => {
  beforeEach(() => {
    modifyMock.mockClear();
    splitMock.mockClear();
    getCalendarEventDetailsMock.mockClear();
    fsmCtx.state = '';
    fsmCtx.fsmSessions['pid-test'] = {};
  });

  it('always calls modifyCalendarEvent and passes edit_scope through to the bridge', async () => {
    // Regression: an earlier design stripped edit_scope before calling the
    // bridge because the bridge schema rejected it as "Unexpected property".
    // The proper fix moved scope handling INTO the bridge — modifyCalendarEvent
    // is now the single entry point and accepts edit_scope as a first-class
    // field. The JS layer must NOT strip it; otherwise the bridge can't route.
    setEditArgs({
      event_id: 'evt-1',
      edit_scope: 'all',
      title: 'New title',
    });

    await runStateEditCalendarEventExec();

    expect(modifyMock).toHaveBeenCalledTimes(1);
    expect(splitMock).not.toHaveBeenCalled();
    const args = modifyMock.mock.calls[0][0];
    expect(args.edit_scope).toBe('all');
    expect(args.title).toBe('New title');
    expect(args.event_id).toBe('evt-1');
  });

  it('routes default (no edit_scope, no recurrence_id) to modifyCalendarEvent', async () => {
    setEditArgs({ event_id: 'evt-1', title: 'X' });

    await runStateEditCalendarEventExec();

    expect(modifyMock).toHaveBeenCalledTimes(1);
    expect(splitMock).not.toHaveBeenCalled();
  });

  it('passes edit_scope="this_only" + recurrence_id through to modifyCalendarEvent', async () => {
    setEditArgs({
      event_id: 'evt-1',
      edit_scope: 'this_only',
      recurrence_id: RID,
      title: 'Override title',
    });

    await runStateEditCalendarEventExec();

    expect(modifyMock).toHaveBeenCalledTimes(1);
    expect(splitMock).not.toHaveBeenCalled();
    const args = modifyMock.mock.calls[0][0];
    expect(args.edit_scope).toBe('this_only');
    expect(args.recurrence_id).toBe(RID);
    expect(args.title).toBe('Override title');
  });

  it('passes edit_scope="this_and_following" through to modifyCalendarEvent (bridge dispatches internally)', async () => {
    setEditArgs({
      event_id: 'evt-1',
      calendar_id: 'cal-1',
      edit_scope: 'this_and_following',
      recurrence_id: RID,
      title: 'New series title',
      location: 'Room 5',
    });

    await runStateEditCalendarEventExec();

    // JS layer no longer routes — bridge does. From the FSM's perspective,
    // every edit goes through modifyCalendarEvent regardless of scope.
    expect(modifyMock).toHaveBeenCalledTimes(1);
    expect(splitMock).not.toHaveBeenCalled();
    const args = modifyMock.mock.calls[0][0];
    expect(args.edit_scope).toBe('this_and_following');
    expect(args.recurrence_id).toBe(RID);
    expect(args.title).toBe('New series title');
    expect(args.location).toBe('Room 5');
  });

  // The guest change goes to the bridge as given: the bridge applies it to
  // each item the edit covers, so the flow neither reads the stored guests nor
  // merges.
  for (const scope of ['this_only', 'this_and_following', 'all']) {
    it(`${scope} + a guest change: passed to the bridge as given, with no merge in the flow`, async () => {
      const change = { add_attendees: [{ email: 'alice@example.com', name: 'Alice' }], remove_attendees: [{ email: 'existing@example.com' }] };
      setEditArgs({ event_id: 'evt-1', edit_scope: scope, recurrence_id: RID, ...change });

      await runStateEditCalendarEventExec();

      expect(getCalendarEventDetailsMock).not.toHaveBeenCalled();
      expect(modifyMock).toHaveBeenCalledTimes(1);
      const args = modifyMock.mock.calls[0][0];
      expect(args).toMatchObject({ edit_scope: scope, recurrence_id: RID, ...change });
      expect(args).not.toHaveProperty('attendees');
    });
  }

  it('fails fast when edit_scope requires recurrence_id but none is provided', async () => {
    setEditArgs({
      event_id: 'evt-1',
      edit_scope: 'this_only',
      title: 'Update',
    });

    await runStateEditCalendarEventExec();

    expect(modifyMock).not.toHaveBeenCalled();
    expect(splitMock).not.toHaveBeenCalled();
    expect(fsmCtx.state).toBe('exec_fail');
    expect(fsmCtx.fsmSessions['pid-test'].failReason).toMatch(/recurrence_id/);
  });
});

describe('runStateEditCalendarEventExec — resolved edit_scope echoed into editResult', () => {
  beforeEach(() => {
    modifyMock.mockClear();
    splitMock.mockClear();
    getCalendarEventDetailsMock.mockClear();
    fsmCtx.state = '';
    fsmCtx.fsmSessions['pid-test'] = {};
  });

  it('explicit edit_scope="all" is stored on editResult', async () => {
    setEditArgs({ event_id: 'evt-1', edit_scope: 'all', title: 'X' });
    await runStateEditCalendarEventExec();
    expect(fsmCtx.fsmSessions['pid-test'].editResult.edit_scope).toBe('all');
  });

  it('explicit edit_scope="this_and_following" is stored with its recurrence_id', async () => {
    setEditArgs({
      event_id: 'evt-1',
      edit_scope: 'this_and_following',
      recurrence_id: RID,
      title: 'X',
    });
    await runStateEditCalendarEventExec();
    const r = fsmCtx.fsmSessions['pid-test'].editResult;
    expect(r.edit_scope).toBe('this_and_following');
    expect(r.recurrence_id).toBe(RID);
  });

  it('INFERRED scope (recurrence_id present, no edit_scope) is resolved to "this_only" and echoed', async () => {
    // The dangerous case: the LLM omits edit_scope but passes recurrence_id.
    // The exec layer infers "this_only" — and that resolved value MUST land in
    // editResult so completeExecution can tell the LLM only one occurrence
    // changed (otherwise the model thinks it edited the whole series).
    setEditArgs({
      event_id: 'evt-1',
      recurrence_id: RID,
      title: 'X',
    });
    await runStateEditCalendarEventExec();
    expect(fsmCtx.fsmSessions['pid-test'].editResult.edit_scope).toBe('this_only');
  });
});

// ---------- The bridge's item lookup ----------
// The real bridge (tmCalendar.sys.mjs in node:vm over the calendar harness):
// which item an edit changes is decided by edit_scope, and recurrence_id picks
// one occurrence only for "this_only".
const { loadCalendarBridge, fakeDateTime, fakeEvent, fakeRecurrenceInfo, recurrenceItem } = await import('./helpers/calendarBridgeHarness.js');
const bridgeUrl = fileURLToPath(new URL('../chat/experiments/tmCalendar/tmCalendar.sys.mjs', import.meta.url));

describe('bridge modifyCalendarEvent — edit_scope decides which item changes', () => {
  const day = RID.slice(0, 10);
  const firstDay = (() => {
    const d = new Date(`${day}T12:00:00`);
    d.setDate(d.getDate() - 7);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();
  const dayAfter = (n, hour) => {
    const d = new Date(`${day}T12:00:00`);
    d.setDate(d.getDate() + n);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(hour)}:00:00`;
  };
  // A daily series that started a week before RID's day, with RID's occurrence
  // stored (changed earlier, so it has its own title).
  function series() {
    const stored = fakeEvent({ id: 'standup', title: 'Standup (moved room)', startDate: fakeDateTime(day, 17), endDate: fakeDateTime(day, 17, 30), recurrenceId: fakeDateTime(day, 17) });
    const master = fakeEvent({ id: 'standup', title: 'Standup', startDate: fakeDateTime(firstDay, 17), endDate: fakeDateTime(firstDay, 17, 30) });
    master.recurrenceInfo = fakeRecurrenceInfo([recurrenceItem('RRULE', 'FREQ=DAILY')], { exceptions: [stored] });
    master.recurrenceInfo.item = master;
    return master;
  }
  // An occurrence the series expands to but has not stored: one day later.
  const unstoredRid = dayAfter(1, 17);
  // A time that is no occurrence of the series: an hour after RID.
  const notAnOccurrence = dayAfter(0, 18);
  // The series' changed occurrences, by RECURRENCE-ID and title.
  const changedOf = (item) => item.recurrenceInfo.getExceptionIds()
    .map((rid) => `${rid.toString()} ${item.recurrenceInfo.getExceptionFor(rid).title}`);

  for (const withCalendar of [true, false]) {
    it(`edit_scope "all" edits the series whatever recurrence_id names, and adds or changes no occurrence${withCalendar ? '' : ' (no calendar_id: found by scanning the calendars)'}`, async () => {
      for (const rid of [RID, unstoredRid, notAnOccurrence]) {
        const master = series();
        const changedBefore = changedOf(master);
        expect(changedBefore, rid).toHaveLength(1);
        const { api, modifications, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
        const res = await api.modifyCalendarEvent({
          event_id: 'standup', ...(withCalendar ? { calendar_id: 'cal1' } : {}), edit_scope: 'all', recurrence_id: rid, title: 'Team sync',
        });
        expect(res, rid).toMatchObject({ ok: true });
        expect(modifications, rid).toHaveLength(1);
        expect(modifications[0].oldItem, rid).toBe(master);
        const saved = calendar.items[0];
        expect(saved.title, rid).toBe('Team sync');
        expect(changedOf(saved), rid).toEqual(changedBefore);
        expect(changedOf(master), rid).toEqual(changedBefore);
      }
    });
  }

  it('"this_only", or a recurrence_id without edit_scope, edits that one occurrence and leaves the series', async () => {
    for (const scope of [{ edit_scope: 'this_only' }, {}]) {
      const master = series();
      const { api, modifications, calendar } = loadCalendarBridge(bridgeUrl, { items: [master] });
      const res = await api.modifyCalendarEvent({ event_id: 'standup', calendar_id: 'cal1', ...scope, recurrence_id: RID, title: 'Team sync' });
      expect(res).toMatchObject({ ok: true });
      expect(modifications).toHaveLength(1);
      expect(modifications[0].oldItem.parentItem).toBe(master);
      expect(calendar.items[0]).toBe(master);
      expect(master.title).toBe('Standup');
      expect(changedOf(master)).toEqual([`${fakeDateTime(day, 17).toString()} Team sync`]);
    }
  });
});
