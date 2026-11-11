// fsmPrevStateCompletion.test.js — drives the real FSM dispatcher (chat/fsm/core.js)
// through an exec state into exec_success / exec_fail and asserts the result the
// tool waiter resolves with.
//
// Invariant: a tool's completeExecution receives the state the workflow was in
// before it reached the terminal state, so the tool's detailed result reaches
// the assistant (not the generic "... workflow completed." fallback).
//
// Only the per-tool exec runners are stood in: each one records its result on
// the session, sets ctx.state = "exec_success" and re-enters executeAgentAction,
// exactly like the real runners do. core.js, fsmExec.js and the tools'
// completeExecution are the real modules.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ results: {} }));

globalThis.document = globalThis.document || {
  getElementById: () => null,
};

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  saveChatLog: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugLogging: false },
}));

vi.mock('../chat/modules/converse.js', () => ({
  processUserInput: vi.fn(),
}));

vi.mock('../agent/modules/llm.js', () => ({
  processJSONResponse: vi.fn(),
  sendChat: vi.fn(),
}));

vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({
    classList: { add: vi.fn(), remove: vi.fn() },
    remove: vi.fn(),
  })),
}));

vi.mock('../chat/modules/helpers.js', () => ({
  streamText: vi.fn(),
  toNaiveIso: vi.fn((v) => String(v)),
  toIsoNoMs: vi.fn((v) => String(v)),
  initialiseEmailCompose: vi.fn(),
}));

vi.mock('../agent/modules/templateManager.js', () => ({
  getTemplate: vi.fn(),
}));

// Exec-runner stand-in: record the result field, move to exec_success, re-enter.
function execRunner(resultKey, sourceKey = resultKey) {
  return async () => {
    const { ctx } = await import('../chat/modules/context.js');
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    if (resultKey) ctx.fsmSessions[pid][resultKey] = h.results[sourceKey];
    ctx.state = 'exec_success';
    const core = await import('../chat/fsm/core.js');
    await core.executeAgentAction();
  };
}

vi.mock('../chat/fsm/calendarCreate.js', () => ({
  runStateCreateCalendarEventList: vi.fn(),
  runStateCreateCalendarEventExec: execRunner('createResult'),
}));
vi.mock('../chat/fsm/calendarDelete.js', () => ({
  runStateDeleteCalendarEventList: vi.fn(),
  runStateDeleteCalendarEventExec: execRunner('deleteResult'),
}));
vi.mock('../chat/fsm/calendarEdit.js', () => ({
  runStateEditCalendarEventList: vi.fn(),
  runStateEditCalendarEventExec: execRunner('editResult'),
}));
vi.mock('../chat/fsm/contactsDelete.js', () => ({
  runStateDeleteContactsList: vi.fn(),
  runStateDeleteContactsExecute: execRunner(null),
}));
vi.mock('../chat/fsm/emailArchive.js', () => ({
  runStateArchiveListEmails: vi.fn(),
  runStateArchiveExecute: execRunner('archiveResult', 'emailArchiveResult'),
}));
vi.mock('../chat/fsm/emailDelete.js', () => ({
  runStateDeleteListEmails: vi.fn(),
  runStateDeleteExecute: execRunner('deleteResult', 'emailDeleteResult'),
}));
vi.mock('../chat/fsm/emailCompose.js', () => ({
  runStateSendEmail: vi.fn(),
  runStateSendEmailPreview: vi.fn(),
  runStateSendEmailHeadless: vi.fn(),
}));
vi.mock('../chat/fsm/templateCreate.js', () => ({
  runStateCreateTemplateList: vi.fn(),
  runStateCreateTemplateExec: execRunner('createResult'),
}));
vi.mock('../chat/fsm/templateEdit.js', () => ({
  runStateEditTemplateList: vi.fn(),
  runStateEditTemplateExec: execRunner('editResult'),
}));
vi.mock('../chat/fsm/templateDelete.js', () => ({
  runStateDeleteTemplateList: vi.fn(),
  runStateDeleteTemplateExec: execRunner('deleteResult'),
}));
vi.mock('../chat/fsm/templateShare.js', () => ({
  runStateShareTemplateList: vi.fn(),
  runStateShareTemplateExec: execRunner('shareResult'),
}));
vi.mock('../chat/fsm/templateDownload.js', () => ({
  runStateDownloadTemplateList: vi.fn(),
  runStateDownloadTemplateExec: execRunner('downloadResult'),
}));

import { ctx, initFsmSession } from '../chat/modules/context.js';
import { sendChat, processJSONResponse } from '../agent/modules/llm.js';
import { executeAgentAction } from '../chat/fsm/core.js';

const PID = 'call-381';

// Start a session at the tool's list state (as the tools' run() does), then
// enter the exec state through the real dispatcher; return the waiter result.
async function runToCompletion(toolName, listState, execState) {
  initFsmSession(PID, toolName);
  ctx.fsmSessions[PID].fsmPrevState = listState;
  ctx.activePid = PID;
  ctx.activeToolCallId = PID;
  const waited = new Promise((resolve) => {
    ctx.fsmWaiters[PID] = { resolve };
  });
  ctx.state = execState;
  await executeAgentAction();
  return waited;
}

beforeEach(() => {
  for (const k of Object.keys(ctx.fsmSessions)) delete ctx.fsmSessions[k];
  ctx.fsmWaiters = Object.create(null);
  ctx.state = null;
  h.results = {
    createResult: { event_id: 'ev-1', event_title: 'Standup', calendar_id: 'cal-1', invitations: 'sent', id: 'tpl-1', name: 'Tpl' },
    editResult: { event_id: 'ev-2', event_title: 'Review', calendar_id: 'cal-2', edit_scope: 'this_only', recurrence_id: '2099-01-05T10:00:00', invitations: 'none', id: 'tpl-2', name: 'Tpl2' },
    deleteResult: { event_id: 'ev-3', id: 'tpl-3', name: 'Tpl3' },
    shareResult: { id: 'tpl-4', name: 'Tpl4' },
    downloadResult: { id: 'tpl-5', name: 'Tpl5' },
    emailDeleteResult: { requested: 2, deleted: 2, notMoved: [] },
    emailArchiveResult: { requested: 2, archived: 2, notMoved: [] },
  };
});

describe('FSM completion receives the pre-terminal state (#381)', () => {
  it('calendar_event_edit returns the resolved scope and ids', async () => {
    const r = await runToCompletion('calendar_event_edit', 'calendar_event_edit_list', 'calendar_event_edit_exec');
    expect(r.ok).toBe(true);
    expect(r.output.edit_scope).toBe('this_only');
    expect(r.output.recurrence_id).toBe('2099-01-05T10:00:00');
    expect(r.output.event_id).toBe('ev-2');
    expect(r.output.calendar_id).toBe('cal-2');
    expect(r.output.invitations).toBe('none');
    expect(r.output.result).toContain('this_only');
  });

  it('calendar_event_create returns the new event id and invitations', async () => {
    const r = await runToCompletion('calendar_event_create', 'calendar_event_create_list', 'calendar_event_create_exec');
    expect(r.output).toMatchObject({
      result: 'Calendar event created successfully.',
      event_id: 'ev-1',
      calendar_id: 'cal-1',
      invitations: 'sent',
    });
  });

  const simple = [
    ['calendar_event_delete', 'calendar_event_delete_list', 'calendar_event_delete_exec', { result: 'Calendar event deleted successfully.' }],
    ['contacts_delete', 'contacts_delete_list', 'contacts_delete_execute', 'Selected contact(s) deleted.'],
    ['email_archive', 'email_archive_list', 'email_archive_execute', 'All 2 selected emails archived.'],
    ['email_delete', 'email_delete_list', 'email_delete_execute', 'All 2 selected emails deleted.'],
    ['template_create', 'template_create_list', 'template_create_exec', { result: 'Template created successfully.' }],
    ['template_edit', 'template_edit_list', 'template_edit_exec', { result: 'Template updated successfully.' }],
    ['template_delete', 'template_delete_list', 'template_delete_exec', null],
    ['template_share', 'template_share_list', 'template_share_exec', null],
    ['template_download', 'template_download_list', 'template_download_exec', null],
  ];

  it.each(simple)('%s returns its detailed (non-generic) result', async (tool, list, exec, expected) => {
    const r = await runToCompletion(tool, list, exec);
    expect(r.ok).toBe(true);
    const text = typeof r.output === 'string' ? r.output : r.output.result;
    expect(text).not.toMatch(/workflow completed\.$/);
    if (typeof expected === 'string') expect(r.output).toBe(expected);
    else if (expected) expect(r.output).toMatchObject(expected);
  });

  it('a failure still reports the fail reason, not the success detail', async () => {
    initFsmSession(PID, 'calendar_event_edit');
    ctx.activePid = PID;
    ctx.activeToolCallId = PID;
    const waited = new Promise((resolve) => { ctx.fsmWaiters[PID] = { resolve }; });
    ctx.state = 'calendar_event_edit_list';
    await executeAgentAction(); // list runner is a no-op stand-in; records the state
    ctx.fsmSessions[PID].failReason = 'boom';
    ctx.fsmSessions[PID].editResult = h.results.editResult;
    ctx.state = 'exec_fail';
    await executeAgentAction();
    const r = await waited;
    expect(r.ok).toBe(false);
    expect(r.output).toEqual({ ok: false, error: 'boom' });
  });

  it('a planner hop to exec_success keeps the exec state as the previous state', async () => {
    initFsmSession(PID, 'template_edit');
    ctx.activePid = PID;
    ctx.activeToolCallId = PID;
    ctx.fsmSessions[PID].fsmPrevState = 'template_edit_exec';
    ctx.fsmSessions[PID].editResult = h.results.editResult;
    sendChat.mockResolvedValueOnce({ assistant: '{"action":"exec_success"}' });
    processJSONResponse.mockReturnValueOnce({ action: 'exec_success' });
    const waited = new Promise((resolve) => { ctx.fsmWaiters[PID] = { resolve }; });
    ctx.state = 'plan_next_action';
    await executeAgentAction();
    const r = await waited;
    expect(sendChat.mock.calls.at(-1)[0][0].prev_state).toBe('template_edit_exec');
    expect(r.output).toMatchObject({ result: 'Template updated successfully.', template_id: 'tpl-2' });
  });
});
