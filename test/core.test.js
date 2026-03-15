// core.test.js — Tests for chat/tools/core.js
//
// Tests for tool registry, FSM detection, activity labels, execution routing,
// pagination reset, and FSM chain tracking.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((t) => t),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugMode: false },
}));

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {},
}));

vi.mock('../chat/modules/context.js', () => ({
  ctx: { rawUserTexts: [], fsmSessions: {}, state: '', activePid: 0, activeToolCallId: null, awaitingPid: 0 },
  initFsmSession: vi.fn(),
}));

vi.mock('../chat/modules/helpers.js', () => ({
  formatMailList: vi.fn(() => ''),
  toNaiveIso: vi.fn((s) => s),
  toIsoNoMs: vi.fn((d) => (d || new Date()).toISOString().replace(/\.\d{3}Z$/, 'Z')),
  initialiseEmailCompose: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('../chat/modules/entityResolver.js', () => ({
  resolveEmailSubject: vi.fn(async () => null),
  resolveEventDetails: vi.fn(async () => null),
  resolveContactDetails: vi.fn(async () => null),
}));

vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn(() => false) },
    textContent: '',
  })),
}));

// Mock all tool modules to prevent loading their real dependencies
const mockToolRun = vi.fn(async () => ({ ok: true }));
const mockResetPagination = vi.fn();

const toolModuleMock = {
  run: mockToolRun,
  resetPaginationSessions: mockResetPagination,
};

vi.mock('../chat/tools/calendar_event_create.js', () => toolModuleMock);
vi.mock('../chat/tools/calendar_event_delete.js', () => toolModuleMock);
vi.mock('../chat/tools/calendar_event_edit.js', () => toolModuleMock);
vi.mock('../chat/tools/calendar_event_read.js', () => toolModuleMock);
vi.mock('../chat/tools/calendar_read.js', () => toolModuleMock);
vi.mock('../chat/tools/calendar_search.js', () => toolModuleMock);
vi.mock('../chat/tools/contacts_add.js', () => toolModuleMock);
vi.mock('../chat/tools/contacts_delete.js', () => toolModuleMock);
vi.mock('../chat/tools/contacts_edit.js', () => toolModuleMock);
vi.mock('../chat/tools/contacts_search.js', () => toolModuleMock);
vi.mock('../chat/tools/email_archive.js', () => toolModuleMock);
vi.mock('../chat/tools/email_compose.js', () => toolModuleMock);
vi.mock('../chat/tools/email_delete.js', () => toolModuleMock);
vi.mock('../chat/tools/email_forward.js', () => toolModuleMock);
vi.mock('../chat/tools/email_move_to_inbox.js', () => toolModuleMock);
vi.mock('../chat/tools/email_read.js', () => toolModuleMock);
vi.mock('../chat/tools/email_reply.js', () => toolModuleMock);
vi.mock('../chat/tools/email_search.js', () => toolModuleMock);
vi.mock('../chat/tools/inbox_read.js', () => toolModuleMock);
vi.mock('../chat/tools/kb_add.js', () => toolModuleMock);
vi.mock('../chat/tools/kb_del.js', () => toolModuleMock);
vi.mock('../chat/tools/memory_read.js', () => toolModuleMock);
vi.mock('../chat/tools/memory_search.js', () => toolModuleMock);
vi.mock('../chat/tools/web_read.js', () => toolModuleMock);
vi.mock('../chat/tools/reminder_add.js', () => toolModuleMock);
vi.mock('../chat/tools/reminder_del.js', () => toolModuleMock);
vi.mock('../chat/tools/change_setting.js', () => toolModuleMock);

// Mock inboxContext (imported by some tool modules)
vi.mock('../agent/modules/inboxContext.js', () => ({
  buildInboxContext: vi.fn(async () => '[]'),
}));

// Mock contacts.js (imported by contacts_search)
vi.mock('../chat/modules/contacts.js', () => ({
  findContactsRawRows: vi.fn(async () => []),
  parseVCardBasic: vi.fn(() => ({})),
}));

// Mock promptGenerator
vi.mock('../agent/modules/promptGenerator.js', () => ({
  getUserKBPrompt: vi.fn(async () => ''),
}));

// Mock patchApplier
vi.mock('../agent/modules/patchApplier.js', () => ({
  applyKBPatch: vi.fn(() => null),
}));

// Mock reminderStateStore
vi.mock('../agent/modules/reminderStateStore.js', () => ({
  hashReminder: vi.fn(() => 'hash'),
  setEnabled: vi.fn(async () => {}),
}));

// Mock kbReminderGenerator
vi.mock('../agent/modules/kbReminderGenerator.js', () => ({
  generateKBReminders: vi.fn(async () => {}),
}));

// Mock knowledgebase
vi.mock('../agent/modules/knowledgebase.js', () => ({
  debouncedKbUpdate: vi.fn(),
}));

// Mock reminderBuilder
vi.mock('../agent/modules/reminderBuilder.js', () => ({
  buildReminderList: vi.fn(async () => ({ reminders: [] })),
}));

// Mock templateManager
vi.mock('../agent/modules/templateManager.js', () => ({
  ensureMigration: vi.fn(async () => {}),
  getTemplatesAsPrimedPrompt: vi.fn(async () => ''),
}));

// Mock thinkBuffer
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));

// Mock quoteAndSignature
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

// Mock markdown
vi.mock('../chat/modules/markdown.js', () => ({
  renderMarkdown: vi.fn(async () => ''),
  attachSpecialLinkListeners: vi.fn(),
}));

// Mock idTranslator (dynamically imported by executeToolsHeadless)
vi.mock('../chat/modules/idTranslator.js', () => ({
  processToolCallLLMtoTB: vi.fn((name, args) => args),
  processToolResultTBtoLLM: vi.fn((result) => result),
}));

// Provide browser global
globalThis.browser = {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async () => undefined), getURL: vi.fn(() => '') },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------
const {
  isFsmTool,
  isServerSideTool,
  getToolActivityLabel,
  executeToolByName,
  resetToolPaginationSessions,
  resetFsmChainTracking,
  executeToolsHeadless,
} = await import('../chat/tools/core.js');

// ---------------------------------------------------------------------------
// isFsmTool
// ---------------------------------------------------------------------------
describe('isFsmTool', () => {
  it('returns true for known FSM tools', () => {
    expect(isFsmTool('email_compose')).toBe(true);
    expect(isFsmTool('email_forward')).toBe(true);
    expect(isFsmTool('email_reply')).toBe(true);
    expect(isFsmTool('calendar_event_delete')).toBe(true);
    expect(isFsmTool('contacts_delete')).toBe(true);
    expect(isFsmTool('email_delete')).toBe(true);
    expect(isFsmTool('email_archive')).toBe(true);
  });

  it('returns false for non-FSM tools', () => {
    expect(isFsmTool('inbox_read')).toBe(false);
    expect(isFsmTool('email_read')).toBe(false);
    expect(isFsmTool('email_search')).toBe(false);
    expect(isFsmTool('calendar_search')).toBe(false);
    expect(isFsmTool('contacts_search')).toBe(false);
    expect(isFsmTool('kb_add')).toBe(false);
    expect(isFsmTool('kb_del')).toBe(false);
    expect(isFsmTool('memory_search')).toBe(false);
    expect(isFsmTool('memory_read')).toBe(false);
    expect(isFsmTool('web_read')).toBe(false);
    expect(isFsmTool('reminder_add')).toBe(false);
    expect(isFsmTool('reminder_del')).toBe(false);
    expect(isFsmTool('change_setting')).toBe(false);
  });

  it('returns false for unknown tool names', () => {
    expect(isFsmTool('unknown_tool')).toBe(false);
    expect(isFsmTool('')).toBe(false);
    expect(isFsmTool(null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isServerSideTool
// ---------------------------------------------------------------------------
describe('isServerSideTool', () => {
  it('returns true for server_side_tool', () => {
    expect(isServerSideTool('server_side_tool')).toBe(true);
  });

  it('returns false for client-side tools', () => {
    expect(isServerSideTool('inbox_read')).toBe(false);
    expect(isServerSideTool('email_compose')).toBe(false);
    expect(isServerSideTool('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getToolActivityLabel
// ---------------------------------------------------------------------------
describe('getToolActivityLabel', () => {
  it('returns label for inbox_read', async () => {
    expect(await getToolActivityLabel('inbox_read')).toBe('Reading inbox…');
  });

  it('returns label for email_read without unique_id', async () => {
    expect(await getToolActivityLabel('email_read')).toBe('Reading email…');
  });

  it('returns label for email_search with query', async () => {
    expect(await getToolActivityLabel('email_search', { query: 'invoice' }))
      .toBe('Searching mail: invoice');
  });

  it('returns label for email_search without query', async () => {
    expect(await getToolActivityLabel('email_search')).toBe('Searching mail…');
  });

  it('returns label for calendar_search with query', async () => {
    expect(await getToolActivityLabel('calendar_search', { query: 'standup' }))
      .toBe('Searching calendar: standup');
  });

  it('returns label for calendar_search without query', async () => {
    expect(await getToolActivityLabel('calendar_search')).toBe('Searching calendar…');
  });

  it('returns label for contacts_search with query', async () => {
    expect(await getToolActivityLabel('contacts_search', { query: 'Alice' }))
      .toBe('Searching contacts: Alice');
  });

  it('returns label for contacts_search without query', async () => {
    expect(await getToolActivityLabel('contacts_search')).toBe('Searching contacts…');
  });

  it('returns label for calendar_read', async () => {
    expect(await getToolActivityLabel('calendar_read')).toBe('Reading calendar…');
  });

  it('returns label for calendar_event_read with title arg', async () => {
    const label = await getToolActivityLabel('calendar_event_read', { title: 'Sprint Review' });
    expect(label).toBe('Reading event: Sprint Review');
  });

  it('returns fallback for calendar_event_read with no args', async () => {
    const label = await getToolActivityLabel('calendar_event_read');
    expect(label).toBe('Reading calendar entry…');
  });

  it('returns correct labels for simple tools', async () => {
    expect(await getToolActivityLabel('contacts_add')).toBe('Adding contact…');
    expect(await getToolActivityLabel('contacts_edit')).toBe('Editing contact…');
    expect(await getToolActivityLabel('contacts_delete')).toBe('Deleting contact…');
    expect(await getToolActivityLabel('calendar_event_create')).toBe('Creating calendar event…');
    expect(await getToolActivityLabel('calendar_event_edit')).toBe('Updating calendar event…');
    expect(await getToolActivityLabel('calendar_event_delete')).toBe('Deleting calendar event…');
    expect(await getToolActivityLabel('email_delete')).toBe('Deleting selected emails…');
    expect(await getToolActivityLabel('email_archive')).toBe('Archiving selected emails…');
    expect(await getToolActivityLabel('email_move_to_inbox')).toBe('Moving emails to inbox…');
    expect(await getToolActivityLabel('email_compose')).toBe('Starting compose workflow…');
    expect(await getToolActivityLabel('email_forward')).toBe('Starting forward workflow…');
    expect(await getToolActivityLabel('email_reply')).toBe('Starting reply workflow…');
    expect(await getToolActivityLabel('kb_add')).toBe('Updating knowledge base…');
    expect(await getToolActivityLabel('kb_del')).toBe('Removing from knowledge base…');
    expect(await getToolActivityLabel('memory_read')).toBe('Reading memory conversation…');
    expect(await getToolActivityLabel('reminder_add')).toBe('Adding reminder…');
    expect(await getToolActivityLabel('reminder_del')).toBe('Removing reminder…');
    expect(await getToolActivityLabel('change_setting')).toBe('Updating setting…');
  });

  it('returns label for memory_search with query', async () => {
    expect(await getToolActivityLabel('memory_search', { query: 'budget' }))
      .toBe('Searching memory: budget');
  });

  it('returns label for memory_search without query', async () => {
    expect(await getToolActivityLabel('memory_search')).toBe('Searching memory…');
  });

  it('returns label for web_read with url', async () => {
    expect(await getToolActivityLabel('web_read', { url: 'https://example.com' }))
      .toBe('Reading web: https://example.com');
  });

  it('returns label for web_read without url', async () => {
    expect(await getToolActivityLabel('web_read')).toBe('Reading web content…');
  });

  it('returns "Thinking…" for unknown tool', async () => {
    expect(await getToolActivityLabel('nonexistent_tool')).toBe('Thinking…');
  });

  it('returns display label for server_side_tool', async () => {
    expect(await getToolActivityLabel('server_side_tool', { _display_label: 'Processing data…' }))
      .toBe('Processing data…');
  });
});

// ---------------------------------------------------------------------------
// executeToolByName
// ---------------------------------------------------------------------------
describe('executeToolByName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsmChainTracking();
  });

  it('returns error for unknown tool', async () => {
    const result = await executeToolByName('nonexistent_tool', {});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('unknown tool');
  });

  it('calls run for non-FSM tool', async () => {
    mockToolRun.mockResolvedValueOnce({ ok: true, data: 'test' });
    const result = await executeToolByName('inbox_read', {});
    expect(mockToolRun).toHaveBeenCalled();
    expect(result).toEqual({ ok: true, data: 'test' });
  });

  it('returns FSM marker for FSM tool', async () => {
    mockToolRun.mockResolvedValueOnce(undefined);
    const result = await executeToolByName('email_compose', {}, { callId: 'call_1' });
    expect(result).toHaveProperty('fsm', true);
    expect(result).toHaveProperty('tool', 'email_compose');
    expect(result).toHaveProperty('pid', 'call_1');
  });

  it('blocks consecutive FSM tools in same chain', async () => {
    // First FSM tool succeeds
    mockToolRun.mockResolvedValueOnce(undefined);
    await executeToolByName('email_compose', { recipients: ['a@b.com'] }, { callId: 'call_1' });

    // Second FSM tool should be blocked
    const result = await executeToolByName('email_reply', { unique_id: 'uid1' }, { callId: 'call_2' });
    expect(result).toHaveProperty('consecutiveFsmBlocked', true);
    expect(result.ok).toBe(false);
    expect(result.previousFsmTool).toBe('email_compose');
    expect(result.blockedFsmTool).toBe('email_reply');
  });

  it('catches thrown errors from tool run', async () => {
    mockToolRun.mockRejectedValueOnce(new Error('tool exploded'));
    const result = await executeToolByName('inbox_read', {});
    expect(result).toHaveProperty('error');
    expect(result.error).toContain('tool exploded');
  });

  it('reverts FSM chain tracking on synchronous FSM tool failure', async () => {
    mockToolRun.mockRejectedValueOnce(new Error('validation failed'));
    const result = await executeToolByName('email_compose', {}, { callId: 'call_x' });
    expect(result).toHaveProperty('error');

    // After revert, a second FSM call should NOT be blocked
    mockToolRun.mockResolvedValueOnce(undefined);
    const result2 = await executeToolByName('email_reply', {}, { callId: 'call_y' });
    expect(result2.consecutiveFsmBlocked).not.toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resetFsmChainTracking
// ---------------------------------------------------------------------------
describe('resetFsmChainTracking', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('allows FSM tool after reset', async () => {
    // Run first FSM tool
    mockToolRun.mockResolvedValueOnce(undefined);
    await executeToolByName('email_compose', {}, { callId: 'call_1' });

    // Reset chain tracking
    resetFsmChainTracking();

    // Now another FSM tool should work
    mockToolRun.mockResolvedValueOnce(undefined);
    const result = await executeToolByName('email_reply', {}, { callId: 'call_2' });
    expect(result.consecutiveFsmBlocked).not.toBe(true);
    expect(result).toHaveProperty('fsm', true);
  });

  it('does not throw when chain is already empty', () => {
    resetFsmChainTracking();
    resetFsmChainTracking();
    // Should not throw
  });
});

// ---------------------------------------------------------------------------
// resetToolPaginationSessions
// ---------------------------------------------------------------------------
describe('resetToolPaginationSessions', () => {
  it('calls resetPaginationSessions on tools that support it', () => {
    resetToolPaginationSessions();
    // mockResetPagination is the resetPaginationSessions fn for all mocked tools
    // It should have been called for tools that export it
    expect(mockResetPagination).toHaveBeenCalled();
  });

  it('does not throw', () => {
    expect(() => resetToolPaginationSessions()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// executeToolsHeadless
// ---------------------------------------------------------------------------
describe('executeToolsHeadless', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetFsmChainTracking();
  });

  it('blocks FSM tools in headless mode', async () => {
    const results = await executeToolsHeadless([
      { id: 'call_1', function: { name: 'email_compose', arguments: '{}' } },
    ]);
    expect(results).toHaveLength(1);
    const output = JSON.parse(results[0].output);
    expect(output.ok).toBe(false);
    expect(output.error).toContain('requires user interaction');
  });

  it('returns results for empty tool calls array', async () => {
    const results = await executeToolsHeadless([]);
    expect(results).toHaveLength(0);
  });

  it('returns results array matching tool call count', async () => {
    // FSM tools are blocked in headless, so use FSM tools to verify count
    const results = await executeToolsHeadless([
      { id: 'call_1', function: { name: 'email_compose', arguments: '{}' } },
      { id: 'call_2', function: { name: 'email_reply', arguments: '{}' } },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].call_id).toBe('call_1');
    expect(results[1].call_id).toBe('call_2');
  });
});
