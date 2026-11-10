/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// calendarEditPreCardCheck.test.js: the edit tool, from its `run` with the
// real argument reader, against the real calendar bridge. An edit of the
// times the bridge would refuse fails before the confirmation card with
// nothing written; an edit it allows reaches the card.

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
// The real toNaiveIso: the tool reads start_iso and end_iso with it.
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

const { loadCalendarBridge, fakeDate, fakeDateTime, fakeEvent, LOCAL_ZONE } = await import('./helpers/calendarBridgeHarness.js');
const { run } = await import('../chat/tools/calendar_event_edit.js');
const { ctx } = await import('../chat/modules/context.js');

// 2099 is the dated-test exception (never goes stale).
const allDayEvent = () => fakeEvent({ id: 'evt', title: 'Holiday', startDate: fakeDate('2099-10-06', LOCAL_ZONE), endDate: fakeDate('2099-10-07', LOCAL_ZONE) });
const timedEvent = () => fakeEvent({ id: 'evt', title: 'Sync', startDate: fakeDateTime('2099-10-06', 9), endDate: fakeDateTime('2099-10-06', 10) });

let nextPid = 0;
// Runs the tool to the point it either fails or stashes the edit for the card.
async function runEdit(item, args) {
  const loaded = loadCalendarBridge(bridgeUrl, { items: [item] });
  globalThis.browser.tmCalendar = loaded.api;
  const pid = `pid-precard-${nextPid += 1}`;
  ctx.fsmSessions[pid] = {};
  ctx.state = null;
  await run({ event_id: 'evt', calendar_id: 'cal1', ...args }, { callId: pid });
  await new Promise((r) => setTimeout(r, 5));
  return { sess: ctx.fsmSessions[pid], loaded };
}

function expectCard({ sess, loaded }, fields) {
  expect(sess.failReason).toBeUndefined();
  expect(sess.editEventArgs).toMatchObject(fields);
  expect(sess.editEventArgs).not.toHaveProperty('check_only');
  expect(loaded.modifications).toHaveLength(0);
}

describe('calendar_event_edit against the real bridge, before the confirmation card', () => {
  it('an all-day event given a time of day without all_day fails with the question to ask, and nothing is written', async () => {
    const { sess, loaded } = await runEdit(allDayEvent(), { start_iso: '2099-10-20T15:00:00', end_iso: '2099-10-20T16:00:00' });
    expect(sess.failReason).toMatch(/^this is an all-day event, and the edit gives a time of day without all_day\. Ask the user/);
    expect(ctx.state).toBe('exec_fail');
    expect(sess.editEventArgs).toBeUndefined();
    expect(loaded.modifications).toHaveLength(0);
  });

  it('an all-day event given dates at midnight reaches the card', async () => {
    expectCard(await runEdit(allDayEvent(), { start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-22T00:00:00' }),
      { start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-22T00:00:00' });
  });

  it('an all-day event given bare dates, the shape its refusal asks for, reaches the card', async () => {
    expectCard(await runEdit(allDayEvent(), { start_iso: '2099-10-20', end_iso: '2099-10-22' }),
      { start_iso: '2099-10-20T00:00:00', end_iso: '2099-10-22T00:00:00' });
  });

  it('an all-day event stated timed, with a time, reaches the card', async () => {
    expectCard(await runEdit(allDayEvent(), { all_day: false, start_iso: '2099-10-20T15:00:00', end_iso: '2099-10-20T16:00:00' }), { all_day: false });
  });

  it('a timed event moved, with a guest added and invitations asked for, reaches the card with them', async () => {
    const guests = [{ email: 'sam@example.com' }];
    expectCard(await runEdit(timedEvent(), { start_iso: '2099-10-20T15:00:00', add_attendees: guests, send_invitations: true }),
      { start_iso: '2099-10-20T15:00:00', add_attendees: guests, send_invitations: true });
  });

  it('an all-day event moved, with a guest added and invitations asked for, reaches the card', async () => {
    expectCard(await runEdit(allDayEvent(), { start_iso: '2099-10-20T00:00:00', add_attendees: [{ email: 'sam@example.com' }], send_invitations: true }),
      { send_invitations: true });
  });

  it('an event the bridge cannot find fails before the card', async () => {
    const loaded = loadCalendarBridge(bridgeUrl, { items: [] });
    globalThis.browser.tmCalendar = loaded.api;
    ctx.fsmSessions['pid-precard-missing'] = {};
    await run({ event_id: 'gone', calendar_id: 'cal1', start_iso: '2099-10-20T15:00:00' }, { callId: 'pid-precard-missing' });
    await new Promise((r) => setTimeout(r, 5));
    expect(ctx.fsmSessions['pid-precard-missing'].failReason).toBeTruthy();
    expect(ctx.fsmSessions['pid-precard-missing'].editEventArgs).toBeUndefined();
  });
});
