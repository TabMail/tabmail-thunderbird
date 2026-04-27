// action.test.js — Tests for agent/modules/action.js
//
// Tests performTaggedAction which executes message actions based on the
// cached AI action (read from actionCache → IDB).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../agent/modules/composeTracker.js', () => ({
  trackComposeWindow: vi.fn(),
}));

const mockGetActionForWeId = vi.fn();

vi.mock('../agent/modules/actionCache.js', () => ({
  ACTIONS: { REPLY: 'reply', ARCHIVE: 'archive', DELETE: 'delete', NONE: 'none' },
  getActionForWeId: (...args) => mockGetActionForWeId(...args),
}));

const mockGetTrashFolder = vi.fn();
const mockGetArchiveFolder = vi.fn();
const mockGetIdentityForMessage = vi.fn();
const mockGetUniqueMessageKey = vi.fn();

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getTrashFolderForHeader: (...args) => mockGetTrashFolder(...args),
  getArchiveFolderForHeader: (...args) => mockGetArchiveFolder(...args),
  getIdentityForMessage: (...args) => mockGetIdentityForMessage(...args),
  getUniqueMessageKey: (...args) => mockGetUniqueMessageKey(...args),
}));

globalThis.browser = {
  messages: {
    get: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
  },
  compose: {
    beginReply: vi.fn(),
  },
};

const { performTaggedAction, performTaggedActions } = await import('../agent/modules/action.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('performTaggedAction', () => {
  it('returns "no_action" when message has no cached action', async () => {
    browser.messages.get.mockResolvedValue({ tags: [] });
    mockGetActionForWeId.mockResolvedValue(null);
    const result = await performTaggedAction({ id: 1 });
    expect(result).toBe('no_action');
  });

  it('returns "deleted" when action is "delete" and trash folder found', async () => {
    const hdr = { tags: [], folder: { accountId: 'acc1' } };
    browser.messages.get.mockResolvedValue(hdr);
    browser.messages.update.mockResolvedValue(undefined);
    browser.messages.move.mockResolvedValue(undefined);
    mockGetActionForWeId.mockResolvedValue('delete');
    mockGetTrashFolder.mockResolvedValue({ id: 'trash-id', path: '/Trash' });

    const result = await performTaggedAction({ id: 1 });
    expect(result).toBe('deleted');
    expect(browser.messages.update).toHaveBeenCalledWith(1, { read: true });
    expect(browser.messages.move).toHaveBeenCalled();
  });

  it('returns "trash_not_found" when trash folder not found', async () => {
    const hdr = { tags: [], folder: { accountId: 'acc1' } };
    browser.messages.get.mockResolvedValue(hdr);
    mockGetActionForWeId.mockResolvedValue('delete');
    mockGetTrashFolder.mockResolvedValue(null);

    const result = await performTaggedAction({ id: 1 });
    expect(result).toBe('trash_not_found');
  });

  it('returns "archived" when action is "archive"', async () => {
    const hdr = { tags: [], folder: { accountId: 'acc1' } };
    browser.messages.get.mockResolvedValue(hdr);
    browser.messages.update.mockResolvedValue(undefined);
    browser.messages.move.mockResolvedValue(undefined);
    mockGetActionForWeId.mockResolvedValue('archive');
    mockGetArchiveFolder.mockResolvedValue({ id: 'archive-id', path: '/Archive' });

    const result = await performTaggedAction({ id: 2 });
    expect(result).toBe('archived');
    expect(browser.messages.update).toHaveBeenCalledWith(2, { read: true });
    expect(browser.messages.move).toHaveBeenCalled();
  });

  it('returns "archive_folder_missing" when archive folder not found', async () => {
    const hdr = { tags: [], folder: { accountId: 'acc1' } };
    browser.messages.get.mockResolvedValue(hdr);
    mockGetActionForWeId.mockResolvedValue('archive');
    mockGetArchiveFolder.mockResolvedValue(null);

    const result = await performTaggedAction({ id: 3 });
    expect(result).toBe('archive_folder_missing');
  });

  it('returns "reply_opened" when action is "reply"', async () => {
    const hdr = { tags: [] };
    browser.messages.get.mockResolvedValue(hdr);
    mockGetActionForWeId.mockResolvedValue('reply');
    mockGetIdentityForMessage.mockResolvedValue({ identityId: 'id1' });
    browser.compose.beginReply.mockResolvedValue({ id: 42 });

    const result = await performTaggedAction({ id: 4 });
    expect(result).toBe('reply_opened');
    expect(browser.compose.beginReply).toHaveBeenCalledWith(4, 'replyToAll', { identityId: 'id1' });
  });

  it('returns "reply_opened" even without identity', async () => {
    const hdr = { tags: [] };
    browser.messages.get.mockResolvedValue(hdr);
    mockGetActionForWeId.mockResolvedValue('reply');
    mockGetIdentityForMessage.mockResolvedValue(null);
    browser.compose.beginReply.mockResolvedValue({ id: 43 });

    const result = await performTaggedAction({ id: 5 });
    expect(result).toBe('reply_opened');
    expect(browser.compose.beginReply).toHaveBeenCalledWith(5, 'replyToAll', {});
  });

  it('uses provided header instead of fetching', async () => {
    const hdr = { tags: [] };
    mockGetActionForWeId.mockResolvedValue('none');
    const result = await performTaggedAction({ id: 6 }, hdr);
    expect(result).toBe('no_action');
    expect(browser.messages.get).not.toHaveBeenCalled();
  });

  it('returns "error" when messages.get throws', async () => {
    browser.messages.get.mockRejectedValue(new Error('fail'));
    const result = await performTaggedAction({ id: 7 });
    expect(result).toBe('error');
  });
});

describe('performTaggedActions', () => {
  it('processes multiple messages', async () => {
    browser.messages.get.mockResolvedValue({ tags: [] });
    mockGetActionForWeId.mockResolvedValue(null);
    const results = await performTaggedActions([{ id: 1 }, { id: 2 }]);
    expect(results).toEqual(['no_action', 'no_action']);
  });

  it('returns empty array for empty input', async () => {
    const results = await performTaggedActions([]);
    expect(results).toEqual([]);
  });
});
