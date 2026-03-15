// toolCompletions.test.js — Tests for completeExecution functions across FSM tools
//
// These are pure functions that determine the result string based on FSM state.
// Tests cover email_compose, email_reply, email_forward, email_delete, contacts_delete.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — all tools import from these modules
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  parseUniqueId: vi.fn(),
  headerIDToWeID: vi.fn(),
  extractBodyFromParts: vi.fn(),
  getUniqueMessageKey: vi.fn(),
  safeGetFull: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugMode: false },
}));

vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async () => ({
    classList: { add: vi.fn(), remove: vi.fn(), contains: vi.fn() },
    textContent: '',
  })),
  appendSystemBubble: vi.fn(),
}));

vi.mock('../chat/modules/context.js', () => {
  const ctx = {
    activePid: 0,
    activeToolCallId: null,
    fsmSessions: {},
    state: '',
    composeDraft: {},
    toolExecutionMode: '',
    awaitingPid: 0,
  };
  return {
    ctx,
    initFsmSession: vi.fn((pid, toolName) => {
      ctx.fsmSessions[pid] = { toolName };
    }),
  };
});

vi.mock('../chat/modules/helpers.js', () => ({
  initialiseEmailCompose: vi.fn(),
  streamText: vi.fn(),
}));

vi.mock('../chat/modules/icsParser.js', () => ({
  extractIcsFromParts: vi.fn(async () => []),
  formatIcsAttachmentsAsString: vi.fn(() => ''),
}));

vi.mock('../chat/fsm/core.js', () => ({
  executeAgentAction: vi.fn(async () => {}),
}));

vi.mock('../chat/fsm/emailCompose.js', () => ({
  validateAndNormalizeRecipientSets: vi.fn(async () => ({
    ok: true,
    recipients: [],
    cc: [],
    bcc: [],
  })),
}));

vi.mock('../compose/modules/edit.js', () => ({
  runComposeEdit: vi.fn(async () => ({
    subject: 'Test',
    body: 'Body',
    raw: '',
    messages: [],
  })),
}));

vi.mock('../agent/modules/inboxContext.js', () => ({
  getInboxForAccount: vi.fn(async () => null),
}));

// Need globalThis.browser for tools that access browser APIs
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
    onChanged: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  messages: {
    get: vi.fn(async () => ({ subject: 'Test', author: 'test@example.com' })),
    move: vi.fn(async () => {}),
  },
  addressBooks: {
    contacts: {
      get: vi.fn(async () => null),
    },
  },
};

// Need requestAnimationFrame for tools
globalThis.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));

// ---------------------------------------------------------------------------
// Import all modules at top level
// ---------------------------------------------------------------------------

const { ctx } = await import('../chat/modules/context.js');

const emailCompose = await import('../chat/tools/email_compose.js');
const emailReply = await import('../chat/tools/email_reply.js');
const emailForward = await import('../chat/tools/email_forward.js');
const emailDelete = await import('../chat/tools/email_delete.js');
const contactsDelete = await import('../chat/tools/contacts_delete.js');
const calendarRead = await import('../chat/tools/calendar_read.js');
const emailMoveToInbox = await import('../chat/tools/email_move_to_inbox.js');
const emailArchive = await import('../chat/tools/email_archive.js');
const emailRead = await import('../chat/tools/email_read.js');

// ---------------------------------------------------------------------------
// Helper to reset ctx state
// ---------------------------------------------------------------------------

function resetCtx() {
  ctx.activePid = 0;
  ctx.activeToolCallId = null;
  ctx.fsmSessions = {};
  ctx.state = '';
  ctx.composeDraft = {};
  ctx.toolExecutionMode = '';
  ctx.awaitingPid = 0;
}

// ---------------------------------------------------------------------------
// email_compose completeExecution
// ---------------------------------------------------------------------------

describe('email_compose.completeExecution', () => {
  beforeEach(resetCtx);

  it('returns success message when no failReason', async () => {
    const result = await emailCompose.completeExecution('agent_converse', 'send_email');
    expect(result).toBe('Email sent successfully.');
  });

  it('returns failure message when failReason is set', async () => {
    ctx.activePid = 'pid-1';
    ctx.fsmSessions['pid-1'] = { failReason: 'No recipients' };
    const result = await emailCompose.completeExecution('exec_fail', 'email_compose_start');
    expect(result).toContain('Failed:');
    expect(result).toContain('No recipients');
  });

  it('returns success when pid is 0 and no sessions', async () => {
    const result = await emailCompose.completeExecution('agent_converse', 'send_email');
    expect(result).toBe('Email sent successfully.');
  });
});

// ---------------------------------------------------------------------------
// email_reply completeExecution
// ---------------------------------------------------------------------------

describe('email_reply.completeExecution', () => {
  beforeEach(resetCtx);

  it('returns success message when no failReason', async () => {
    const result = await emailReply.completeExecution('agent_converse', 'send_email');
    expect(result).toBe('Email sent successfully.');
  });

  it('returns failure message when failReason is set', async () => {
    ctx.activePid = 'pid-2';
    ctx.fsmSessions['pid-2'] = { failReason: 'Email not found' };
    const result = await emailReply.completeExecution('exec_fail', 'email_reply_start');
    expect(result).toContain('Failed:');
    expect(result).toContain('Email not found');
  });
});

// ---------------------------------------------------------------------------
// email_forward completeExecution
// ---------------------------------------------------------------------------

describe('email_forward.completeExecution', () => {
  beforeEach(resetCtx);

  it('returns success message when no failReason', async () => {
    const result = await emailForward.completeExecution('agent_converse', 'send_email');
    expect(result).toBe('Email sent successfully.');
  });

  it('returns failure message when failReason is set', async () => {
    ctx.activePid = 'pid-3';
    ctx.fsmSessions['pid-3'] = { failReason: 'Invalid recipients' };
    const result = await emailForward.completeExecution('exec_fail', 'email_forward_start');
    expect(result).toContain('Failed:');
    expect(result).toContain('Invalid recipients');
  });
});

// ---------------------------------------------------------------------------
// email_delete completeExecution
// ---------------------------------------------------------------------------

describe('email_delete.completeExecution', () => {
  beforeEach(resetCtx);

  it('returns "Selected emails deleted." when prevState is email_delete_execute', async () => {
    const result = await emailDelete.completeExecution('agent_converse', 'email_delete_execute');
    expect(result).toBe('Selected emails deleted.');
  });

  it('returns "Delete workflow completed." for other prevState', async () => {
    const result = await emailDelete.completeExecution('agent_converse', 'email_delete_list');
    expect(result).toBe('Delete workflow completed.');
  });

  it('returns failure message when failReason is set', async () => {
    ctx.activePid = 'pid-4';
    ctx.fsmSessions['pid-4'] = { failReason: 'No emails selected' };
    const result = await emailDelete.completeExecution('exec_fail', 'email_delete_list');
    expect(result).toContain('Failed:');
    expect(result).toContain('No emails selected');
  });
});

// ---------------------------------------------------------------------------
// contacts_delete completeExecution
// ---------------------------------------------------------------------------

describe('contacts_delete.completeExecution', () => {
  beforeEach(resetCtx);

  it('returns "Selected contact(s) deleted." when prevState is contacts_delete_execute', async () => {
    const result = await contactsDelete.completeExecution('agent_converse', 'contacts_delete_execute');
    expect(result).toBe('Selected contact(s) deleted.');
  });

  it('returns "Delete workflow completed." for other prevState', async () => {
    const result = await contactsDelete.completeExecution('agent_converse', 'contacts_delete_list');
    expect(result).toBe('Delete workflow completed.');
  });

  it('returns failure message when failReason is set', async () => {
    ctx.activePid = 'pid-5';
    ctx.fsmSessions['pid-5'] = { failReason: 'Contact not found' };
    const result = await contactsDelete.completeExecution('exec_fail', 'contacts_delete_list');
    expect(result).toContain('Failed:');
    expect(result).toContain('Contact not found');
  });
});

// ---------------------------------------------------------------------------
// email_delete.run FSM marker
// ---------------------------------------------------------------------------

describe('email_delete.run', () => {
  beforeEach(resetCtx);

  it('returns FSM marker object', async () => {
    const result = await emailDelete.run({}, { callId: 'call-1' });
    expect(result).toBeDefined();
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('email_delete');
    expect(result.pid).toBe('call-1');
    expect(typeof result.startedAt).toBe('number');
  });

  it('returns FSM marker with null pid when no callId', async () => {
    const result = await emailDelete.run({}, {});
    expect(result.fsm).toBe(true);
    expect(result.pid).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// contacts_delete.run FSM marker
// ---------------------------------------------------------------------------

describe('contacts_delete.run', () => {
  beforeEach(resetCtx);

  it('returns FSM marker object', async () => {
    const result = await contactsDelete.run({}, { callId: 'call-2' });
    expect(result).toBeDefined();
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('contacts_delete');
    expect(result.pid).toBe('call-2');
  });
});

// ---------------------------------------------------------------------------
// email_compose.run returns empty string (FSM tool)
// ---------------------------------------------------------------------------

describe('email_compose.run', () => {
  beforeEach(resetCtx);

  it('returns empty string (FSM tool)', async () => {
    const result = await emailCompose.run(
      { recipients: [{ email: 'test@example.com' }], request: 'Hello' },
      { callId: 'call-3' }
    );
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// email_reply.run returns empty string (FSM tool)
// ---------------------------------------------------------------------------

describe('email_reply.run', () => {
  beforeEach(resetCtx);

  it('returns empty string (FSM tool)', async () => {
    const result = await emailReply.run(
      { unique_id: 'acc1:INBOX:hdr123', request: 'Thanks!' },
      { callId: 'call-4' }
    );
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// email_forward.run returns empty string (FSM tool)
// ---------------------------------------------------------------------------

describe('email_forward.run', () => {
  beforeEach(resetCtx);

  it('returns empty string (FSM tool)', async () => {
    const result = await emailForward.run(
      { unique_id: 'acc1:INBOX:hdr123', recipients: [{ email: 'fwd@example.com' }], request: 'FYI' },
      { callId: 'call-5' }
    );
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// calendar_read delegation
// ---------------------------------------------------------------------------

describe('calendar_read', () => {
  it('exports run function', () => {
    expect(typeof calendarRead.run).toBe('function');
  });

  it('exports resetPaginationSessions function', () => {
    expect(typeof calendarRead.resetPaginationSessions).toBe('function');
  });

  it('resetPaginationSessions does not throw', () => {
    expect(() => calendarRead.resetPaginationSessions()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// email_move_to_inbox
// ---------------------------------------------------------------------------

describe('email_move_to_inbox', () => {
  it('exports run function', () => {
    expect(typeof emailMoveToInbox.run).toBe('function');
  });

  it('exports resetPaginationSessions function', () => {
    expect(typeof emailMoveToInbox.resetPaginationSessions).toBe('function');
  });

  it('resetPaginationSessions does not throw', () => {
    expect(() => emailMoveToInbox.resetPaginationSessions()).not.toThrow();
  });

  it('run returns error when no unique_ids provided', async () => {
    const result = await emailMoveToInbox.run({});
    expect(result).toBeDefined();
    expect(result.error).toContain('No valid unique_ids');
  });

  it('run returns error when unique_ids is empty array', async () => {
    const result = await emailMoveToInbox.run({ unique_ids: [] });
    expect(result).toBeDefined();
    expect(result.error).toContain('No valid unique_ids');
  });
});

// ---------------------------------------------------------------------------
// email_delete.resetPaginationSessions
// ---------------------------------------------------------------------------

describe('email_delete.resetPaginationSessions', () => {
  it('does not throw', () => {
    expect(() => emailDelete.resetPaginationSessions()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// email_archive completeExecution
// ---------------------------------------------------------------------------

describe('email_archive.completeExecution', () => {
  beforeEach(resetCtx);

  it('returns "Selected emails archived." when prevState is email_archive_execute', async () => {
    const result = await emailArchive.completeExecution('agent_converse', 'email_archive_execute');
    expect(result).toBe('Selected emails archived.');
  });

  it('returns "Archive workflow completed." for other prevState', async () => {
    const result = await emailArchive.completeExecution('agent_converse', 'email_archive_list');
    expect(result).toBe('Archive workflow completed.');
  });

  it('returns failure message when failReason is set', async () => {
    ctx.activePid = 'pid-6';
    ctx.fsmSessions['pid-6'] = { failReason: 'Archive folder not found' };
    const result = await emailArchive.completeExecution('exec_fail', 'email_archive_list');
    expect(result).toContain('Failed:');
    expect(result).toContain('Archive folder not found');
  });
});

describe('email_archive.run', () => {
  beforeEach(resetCtx);

  it('returns FSM marker object', async () => {
    const result = await emailArchive.run({}, { callId: 'call-arch-1' });
    expect(result.fsm).toBe(true);
    expect(result.tool).toBe('email_archive');
    expect(result.pid).toBe('call-arch-1');
  });

  it('resetPaginationSessions does not throw', () => {
    expect(() => emailArchive.resetPaginationSessions()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// email_read tests
// ---------------------------------------------------------------------------

describe('email_read.run', () => {
  beforeEach(resetCtx);

  it('returns error for missing unique_id', async () => {
    const result = await emailRead.run({});
    expect(result).toBeDefined();
    expect(result.error).toContain('invalid or missing unique_id');
  });

  it('returns error for null unique_id', async () => {
    const result = await emailRead.run({ unique_id: null });
    expect(result).toBeDefined();
    expect(result.error).toContain('invalid or missing unique_id');
  });

  it('returns error for numeric unique_id', async () => {
    const result = await emailRead.run({ unique_id: 42 });
    expect(result).toBeDefined();
    expect(result.error).toContain('invalid or missing unique_id');
  });

  it('returns error for empty string unique_id', async () => {
    const result = await emailRead.run({ unique_id: '' });
    expect(result).toBeDefined();
    expect(result.error).toContain('invalid or missing unique_id');
  });
});
