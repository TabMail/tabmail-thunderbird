// emailMoveExecResult.test.js — drives the REAL email delete / archive exec
// runners (chat/fsm/emailDelete.js, chat/fsm/emailArchive.js) through the real
// terminal handlers (chat/fsm/fsmExec.js) into each tool's real
// completeExecution, with the message move failing for all or some messages.
//
// Invariant: the assistant is never told emails were deleted/archived when
// they were not. All moved -> success; none moved -> failure with a reason;
// some moved -> "moved N of M" naming the ones that did not move.

import { describe, it, expect, vi, beforeEach } from 'vitest';

globalThis.document = globalThis.document || { getElementById: () => null };
globalThis.window = globalThis.window || {};

const FOLDER = { id: 'folder-dest', path: '/Dest' };

globalThis.browser = {
  messages: {
    // id 9: message gone; id 8: account without a Trash/Archive folder.
    get: vi.fn(async (id) => (id === 9 ? null : { id, folder: { accountId: id === 8 ? 'acct-nofolder' : 'acct-1' } })),
    move: vi.fn(async () => {}),
  },
};

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getTrashFolderForHeader: vi.fn(async (h) => (h.folder.accountId === 'acct-nofolder' ? null : { id: 'folder-dest', path: '/Dest' })),
  getArchiveFolderForHeader: vi.fn(async (h) => (h.folder.accountId === 'acct-nofolder' ? null : { id: 'folder-dest', path: '/Dest' })),
  // "gone-*" ids no longer resolve to a live message.
  resolveUniqueMessageKey: vi.fn(async (uid) => (uid.startsWith('gone') ? null : { weID: Number(uid.split('-')[1]), headerID: uid })),
  getUniqueMessageKey: vi.fn(async (h) => ({ 1: 'a', 2: 'b' })[h.id]),
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../agent/modules/summaryGenerator.js', () => ({ getSummary: vi.fn(async () => null) }));
vi.mock('../agent/modules/inboxContext.js', () => ({ buildInboxContext: vi.fn() }));
vi.mock('../chatlink/modules/fsm.js', () => ({
  relayFsmConfirmation: vi.fn(),
  buildEmailListSummary: vi.fn(),
}));
vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({
    classList: { add: vi.fn(), remove: vi.fn() },
    remove: vi.fn(),
  })),
}));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chat/modules/helpers.js', () => ({
  streamText: vi.fn(),
  renderEmailSelectionList: vi.fn(),
  toNaiveIso: vi.fn((v) => String(v)),
}));
// The dispatcher: route terminal states to the real terminal handlers.
vi.mock('../chat/fsm/core.js', () => ({
  executeAgentAction: vi.fn(async () => {
    const { ctx } = await import('../chat/modules/context.js');
    const exec = await import('../chat/fsm/fsmExec.js');
    if (ctx.state === 'exec_success') return exec.runStateExecSuccess();
    if (ctx.state === 'exec_fail') return exec.runStateExecFail();
  }),
}));

import { ctx, initFsmSession } from '../chat/modules/context.js';
import { runStateDeleteExecute, runStateDeleteListEmails } from '../chat/fsm/emailDelete.js';
import { runStateArchiveExecute, runStateArchiveListEmails } from '../chat/fsm/emailArchive.js';

const PID = 'call-move';

async function run(tool, execState, runner, uniqueIds) {
  initFsmSession(PID, tool);
  ctx.activePid = PID;
  ctx.activeToolCallId = PID;
  if (uniqueIds) ctx.selectedEmailList = uniqueIds.map((u) => (typeof u === 'string' ? { uniqueId: u } : u));
  const waited = new Promise((resolve) => { ctx.fsmWaiters[PID] = { resolve }; });
  ctx.state = execState;
  // What the real dispatcher records on entering the exec state.
  ctx.fsmSessions[PID].fsmPrevState = execState;
  await runner();
  return waited;
}

beforeEach(() => {
  ctx.fsmWaiters = Object.create(null);
  browser.messages.move.mockReset();
  browser.messages.move.mockImplementation(async () => {});
});

const cases = [
  ['email_delete', 'email_delete_execute', () => runStateDeleteExecute(), 'deleted', 'Deleted', () => runStateDeleteListEmails()],
  ['email_archive', 'email_archive_execute', () => runStateArchiveExecute(), 'archived', 'Archived', () => runStateArchiveListEmails()],
];

describe.each(cases)('%s exec result', (tool, execState, runner, past, Past, listRunner) => {
  it('every move fails -> failure with a reason, never success', async () => {
    browser.messages.move.mockRejectedValue(new Error('move refused'));
    const r = await run(tool, execState, runner, ['msg-1', 'msg-2']);
    expect(r.ok).toBe(false);
    expect(r.output).toBe(`Failed: None of the 2 selected email(s) could be ${past}: msg-1, msg-2.`);
  });

  it('some moves fail -> reports moved N of M and names the rest', async () => {
    browser.messages.move.mockImplementation(async ([id]) => {
      if (id === 2) throw new Error('move refused');
    });
    const r = await run(tool, execState, runner, ['msg-1', 'msg-2', 'msg-3']);
    expect(r.ok).toBe(true);
    expect(r.output).toBe(`${Past} 2 of 3 selected emails. Not ${past} (unchanged): msg-2.`);
  });

  it('all moves succeed -> success', async () => {
    const r = await run(tool, execState, runner, ['msg-1', 'msg-2']);
    expect(r.ok).toBe(true);
    expect(r.output).toBe(`All 2 selected emails ${past}.`);
    expect(browser.messages.move).toHaveBeenCalledWith([1], FOLDER.id, { isUserAction: true });
  });

  it('names every message that did not move, whatever the reason', async () => {
    browser.messages.move.mockImplementation(async ([id]) => {
      if (id === 7) throw new Error('move refused');
    });
    const r = await run(tool, execState, runner, [
      'gone-1', // does not resolve
      'msg-9', // no message
      'msg-8', // no Trash/Archive folder
      'msg-2', // moves
      { messageId: 7 }, // no uniqueId; move throws; labelled by internal id
    ]);
    expect(r.ok).toBe(true);
    expect(r.output).toBe(`${Past} 1 of 5 selected emails. Not ${past} (unchanged): gone-1, msg-9, msg-8, 7.`);
  });

  it('confirming with nothing selected fails as "no emails were selected"', async () => {
    const r = await run(tool, execState, runner, []);
    expect(r.ok).toBe(false);
    expect(r.output).toBe('Failed: No emails were selected.');
  });

  it('a repeated id is listed and moved once', async () => {
    initFsmSession(PID, tool);
    ctx.activePid = PID;
    ctx.activeToolCallId = PID;
    // Internal ids 1, 1, 2 carry unique ids "a", "a", "b".
    ctx.fsmSessions[PID].overrideInternalIds = [1, 1, 2];
    await listRunner();
    expect(ctx.selectedEmailList.map((e) => e.uniqueId)).toEqual(['a', 'b']);
    browser.messages.move.mockImplementation(async ([id]) => {
      if (moved.has(id)) throw new Error('already moved');
      moved.add(id);
    });
    const moved = new Set();
    const r = await run(tool, execState, runner, null);
    expect(r.output).toBe(`All 2 selected emails ${past}.`);
  });
});
