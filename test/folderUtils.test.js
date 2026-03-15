// folderUtils.test.js — Tests for agent/modules/folderUtils.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

globalThis.browser = {
  accounts: {
    list: vi.fn(async () => []),
  },
  folders: {
    getSubFolders: vi.fn(async () => []),
  },
};

const { isInboxFolder, getAllFoldersForAccount } = await import('../agent/modules/folderUtils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isInboxFolder', () => {
  it('returns false for null/undefined', () => {
    expect(isInboxFolder(null)).toBe(false);
    expect(isInboxFolder(undefined)).toBe(false);
  });

  it('returns true for folder.type === "inbox"', () => {
    expect(isInboxFolder({ type: 'inbox' })).toBe(true);
  });

  it('returns true for folder.path === "/INBOX"', () => {
    expect(isInboxFolder({ path: '/INBOX' })).toBe(true);
  });

  it('returns false for non-inbox folder type', () => {
    expect(isInboxFolder({ type: 'sent' })).toBe(false);
  });

  it('returns true for specialUse containing "inbox"', () => {
    expect(isInboxFolder({ specialUse: ['inbox'] })).toBe(true);
    expect(isInboxFolder({ specialUse: ['Inbox'] })).toBe(true);
  });

  it('returns true for folder named "inbox"', () => {
    expect(isInboxFolder({ name: 'Inbox' })).toBe(true);
    expect(isInboxFolder({ name: 'inbox' })).toBe(true);
  });

  it('returns true for unified inbox', () => {
    expect(isInboxFolder({ name: 'Unified Inbox' })).toBe(true);
  });

  it('returns false for non-inbox folder', () => {
    expect(isInboxFolder({ type: 'drafts', path: '/Drafts', name: 'Drafts' })).toBe(false);
  });

  it('returns false for empty object', () => {
    expect(isInboxFolder({})).toBe(false);
  });
});

describe('getAllFoldersForAccount', () => {
  it('returns empty array when account not found', async () => {
    browser.accounts.list.mockResolvedValue([{ id: 'other', rootFolder: { id: 'root' } }]);
    const result = await getAllFoldersForAccount('nonexistent');
    expect(result).toEqual([]);
  });

  it('returns root folder and children', async () => {
    const rootFolder = { id: 'root', name: 'Root' };
    const child1 = { id: 'c1', name: 'Inbox' };
    const child2 = { id: 'c2', name: 'Sent' };

    browser.accounts.list.mockResolvedValue([{ id: 'acct1', rootFolder }]);
    browser.folders.getSubFolders
      .mockResolvedValueOnce([child1, child2])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await getAllFoldersForAccount('acct1');
    expect(result).toHaveLength(3);
    expect(result.map(f => f.name)).toEqual(['Root', 'Inbox', 'Sent']);
  });

  it('handles nested subfolders', async () => {
    const rootFolder = { id: 'root', name: 'Root' };
    const parent = { id: 'p1', name: 'Gmail' };
    const child = { id: 'c1', name: 'All Mail' };

    browser.accounts.list.mockResolvedValue([{ id: 'acct1', rootFolder }]);
    browser.folders.getSubFolders
      .mockResolvedValueOnce([parent])
      .mockResolvedValueOnce([child])
      .mockResolvedValueOnce([]);

    const result = await getAllFoldersForAccount('acct1');
    expect(result).toHaveLength(3);
    expect(result.map(f => f.name)).toEqual(['Root', 'Gmail', 'All Mail']);
  });

  it('handles missing rootFolder', async () => {
    browser.accounts.list.mockResolvedValue([{ id: 'acct1' }]);
    const result = await getAllFoldersForAccount('acct1');
    expect(result).toEqual([]);
  });

  it('handles getSubFolders errors gracefully', async () => {
    const rootFolder = { id: 'root', name: 'Root' };
    browser.accounts.list.mockResolvedValue([{ id: 'acct1', rootFolder }]);
    browser.folders.getSubFolders.mockRejectedValue(new Error('fail'));

    const result = await getAllFoldersForAccount('acct1');
    expect(result).toHaveLength(1);
  });
});
