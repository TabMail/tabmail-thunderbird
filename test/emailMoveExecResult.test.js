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

const FOLDER = { id: 'folder-dest', path: '/Dest' };

globalThis.browser = {
  messages: {
    get: vi.fn(async (id) => ({ id, folder: { accountId: 'acct-1' } })),
    move: vi.fn(async () => {}),
  },
};

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getTrashFolderForHeader: vi.fn(async () => ({ id: 'folder-dest', path: '/Dest' })),
  getArchiveFolderForHeader: vi.fn(async () => ({ id: 'folder-dest', path: '/Dest' })),
  resolveUniqueMessageKey: vi.fn(async (uid) => ({ weID: Number(uid.split('-')[1]), headerID: uid })),
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
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
import { runStateDeleteExecute } from '../chat/fsm/emailDelete.js';
import { runStateArchiveExecute } from '../chat/fsm/emailArchive.js';

const PID = 'call-move';

async function run(tool, execState, runner, uniqueIds) {
  initFsmSession(PID, tool);
  ctx.activePid = PID;
  ctx.activeToolCallId = PID;
  ctx.selectedEmailList = uniqueIds.map((u) => ({ uniqueId: u }));
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
  ['email_delete', 'email_delete_execute', () => runStateDeleteExecute(), 'deleted', 'Deleted'],
  ['email_archive', 'email_archive_execute', () => runStateArchiveExecute(), 'archived', 'Archived'],
];

describe.each(cases)('%s exec result', (tool, execState, runner, past, Past) => {
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
});
