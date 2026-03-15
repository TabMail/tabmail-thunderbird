// emailMoveToInbox.test.js — Tests for chat/tools/email_move_to_inbox.js
//
// Tests the run() function with mocked browser APIs and dependencies.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../agent/modules/utils.js', () => ({
  log: vi.fn(),
  parseUniqueId: vi.fn((id) => {
    // Simple parser: "folder:headerID" format
    const parts = id.split(':');
    return { weFolder: parts[0] || '', headerID: parts[1] || id };
  }),
  headerIDToWeID: vi.fn(async () => null),
}));

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  parseUniqueId: vi.fn((id) => {
    const parts = id.split(':');
    return { weFolder: parts[0] || '', headerID: parts[1] || id };
  }),
  headerIDToWeID: vi.fn(async (headerID) => headerID === 'valid' ? 101 : null),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
  },
}));

vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));

vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

vi.mock('../agent/modules/inboxContext.js', () => ({
  getInboxForAccount: vi.fn(async (accountId) => {
    if (accountId === 'acc1') return { id: 'inbox1', path: '/INBOX' };
    return null;
  }),
}));

// ---------------------------------------------------------------------------
// Browser mock
// ---------------------------------------------------------------------------

globalThis.browser = {
  messages: {
    get: vi.fn(async () => null),
    move: vi.fn(async () => {}),
    query: vi.fn(async () => ({ messages: [] })),
  },
  folders: {
    query: vi.fn(async () => []),
  },
  accounts: {
    list: vi.fn(async () => []),
  },
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
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { run, resetPaginationSessions } = await import('../chat/tools/email_move_to_inbox.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('email_move_to_inbox run', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error when no unique_ids provided', async () => {
    const result = await run({});
    expect(result).toEqual({ error: 'No valid unique_ids provided' });
  });

  it('returns error when unique_ids is empty array', async () => {
    const result = await run({ unique_ids: [] });
    expect(result).toEqual({ error: 'No valid unique_ids provided' });
  });

  it('returns error when unique_ids contains only invalid values', async () => {
    const result = await run({ unique_ids: [null, '', 42] });
    expect(result).toEqual({ error: 'No valid unique_ids provided' });
  });

  it('returns error when args is null', async () => {
    const result = await run(null);
    expect(result).toEqual({ error: 'No valid unique_ids provided' });
  });

  it('handles message already in inbox (type=inbox)', async () => {
    // Mock headerIDToWeID to resolve
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);

    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: { accountId: 'acc1', type: 'inbox', path: '/INBOX' },
    });

    const result = await run({ unique_ids: ['folder:valid'] });
    expect(typeof result).toBe('string');
    expect(result).toContain('Moved 1 email');
  });

  it('handles message already in inbox (path=/INBOX)', async () => {
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);

    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: { accountId: 'acc1', type: 'folder', path: '/INBOX' },
    });

    const result = await run({ unique_ids: ['folder:valid'] });
    expect(typeof result).toBe('string');
    expect(result).toContain('Moved 1 email');
  });

  it('moves message to inbox successfully', async () => {
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);

    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: { accountId: 'acc1', type: 'trash', path: '/Trash' },
    });

    const result = await run({ unique_ids: ['folder:valid'] });
    expect(typeof result).toBe('string');
    expect(result).toContain('Moved 1 email to inbox');
    expect(browser.messages.move).toHaveBeenCalledWith(
      [101],
      'inbox1',
      { isUserAction: true }
    );
  });

  it('returns error when message not found', async () => {
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);

    browser.messages.get.mockResolvedValueOnce(null);

    const result = await run({ unique_ids: ['folder:valid'] });
    expect(typeof result).toBe('object');
    expect(result.error).toContain('not found');
  });

  it('returns error when message has no folder', async () => {
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);

    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: null,
    });

    const result = await run({ unique_ids: ['folder:valid'] });
    expect(typeof result).toBe('object');
    expect(result.error).toContain('has no folder');
  });

  it('returns error when inbox not found for account', async () => {
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);

    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: { accountId: 'unknown_acc', type: 'trash', path: '/Trash' },
    });

    const result = await run({ unique_ids: ['folder:valid'] });
    expect(typeof result).toBe('object');
    expect(result.error).toContain('No inbox found');
  });

  it('handles multiple messages with mixed results', async () => {
    const utils = await import('../agent/modules/utils.js');
    // First message resolves successfully
    utils.headerIDToWeID.mockResolvedValueOnce(101);
    // Second message resolves successfully
    utils.headerIDToWeID.mockResolvedValueOnce(102);

    // First message moves successfully
    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: { accountId: 'acc1', type: 'trash', path: '/Trash' },
    });
    // Second message not found
    browser.messages.get.mockResolvedValueOnce(null);

    const result = await run({ unique_ids: ['folder:msg1', 'folder:msg2'] });
    expect(typeof result).toBe('string');
    expect(result).toContain('1 email(s) to inbox');
    expect(result).toContain('1 error(s)');
  });

  it('handles move API throwing error', async () => {
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);

    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: { accountId: 'acc1', type: 'archive', path: '/Archive' },
    });
    browser.messages.move.mockRejectedValueOnce(new Error('IMAP error'));

    const result = await run({ unique_ids: ['folder:valid'] });
    expect(typeof result).toBe('object');
    expect(result.error).toContain('IMAP error');
  });

  it('returns singular message for single moved email', async () => {
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);

    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: { accountId: 'acc1', type: 'trash', path: '/Trash' },
    });

    const result = await run({ unique_ids: ['folder:valid'] });
    expect(result).toBe('Moved 1 email to inbox.');
  });

  it('returns plural message for multiple moved emails', async () => {
    const utils = await import('../agent/modules/utils.js');
    utils.headerIDToWeID.mockResolvedValueOnce(101);
    utils.headerIDToWeID.mockResolvedValueOnce(102);

    browser.messages.get.mockResolvedValueOnce({
      id: 101,
      folder: { accountId: 'acc1', type: 'trash', path: '/Trash' },
    });
    browser.messages.get.mockResolvedValueOnce({
      id: 102,
      folder: { accountId: 'acc1', type: 'archive', path: '/Archive' },
    });

    const result = await run({ unique_ids: ['folder:msg1', 'folder:msg2'] });
    expect(result).toBe('Moved 2 emails to inbox.');
  });
});

describe('resetPaginationSessions', () => {
  it('is a function that does not throw', () => {
    expect(typeof resetPaginationSessions).toBe('function');
    expect(() => resetPaginationSessions()).not.toThrow();
  });
});
