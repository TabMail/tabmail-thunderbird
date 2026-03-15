// folderUtilsAsync.test.js — Tests for getAllFoldersForAccount in agent/modules/folderUtils.js
//
// Requires browser mock for accounts.list and folders.getSubFolders.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Browser mock
// ---------------------------------------------------------------------------

globalThis.browser = {
  accounts: {
    list: vi.fn(async () => []),
  },
  folders: {
    getSubFolders: vi.fn(async () => []),
  },
};

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const { getAllFoldersForAccount } = await import('../agent/modules/folderUtils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getAllFoldersForAccount', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when no accounts exist', async () => {
    browser.accounts.list.mockResolvedValue([]);
    const result = await getAllFoldersForAccount('account1');
    expect(result).toEqual([]);
  });

  it('returns empty array when account not found', async () => {
    browser.accounts.list.mockResolvedValue([
      { id: 'other', rootFolder: { id: 'root1' } },
    ]);
    const result = await getAllFoldersForAccount('account1');
    expect(result).toEqual([]);
  });

  it('returns empty array when account has no rootFolder', async () => {
    browser.accounts.list.mockResolvedValue([
      { id: 'account1' },
    ]);
    const result = await getAllFoldersForAccount('account1');
    expect(result).toEqual([]);
  });

  it('returns root folder when it has no children', async () => {
    const rootFolder = { id: 'root1', name: 'Root', path: '/' };
    browser.accounts.list.mockResolvedValue([
      { id: 'account1', rootFolder },
    ]);
    browser.folders.getSubFolders.mockResolvedValue([]);
    const result = await getAllFoldersForAccount('account1');
    expect(result).toEqual([rootFolder]);
  });

  it('traverses folder tree recursively', async () => {
    const inbox = { id: 'f1', name: 'Inbox', path: '/INBOX' };
    const sent = { id: 'f2', name: 'Sent', path: '/Sent' };
    const subfolder = { id: 'f3', name: 'Work', path: '/INBOX/Work' };
    const rootFolder = { id: 'root1', name: 'Root', path: '/' };

    browser.accounts.list.mockResolvedValue([
      { id: 'account1', rootFolder },
    ]);
    browser.folders.getSubFolders.mockImplementation(async (folderId) => {
      if (folderId === 'root1') return [inbox, sent];
      if (folderId === 'f1') return [subfolder];
      return [];
    });

    const result = await getAllFoldersForAccount('account1');
    expect(result).toHaveLength(4); // root + inbox + sent + subfolder
    expect(result.map(f => f.id)).toContain('root1');
    expect(result.map(f => f.id)).toContain('f1');
    expect(result.map(f => f.id)).toContain('f2');
    expect(result.map(f => f.id)).toContain('f3');
  });

  it('handles circular references via visited set', async () => {
    const rootFolder = { id: 'root1', name: 'Root', path: '/' };
    const folder1 = { id: 'f1', name: 'Folder1', path: '/Folder1' };

    browser.accounts.list.mockResolvedValue([
      { id: 'account1', rootFolder },
    ]);
    // f1 references back to root1 as a child (circular)
    browser.folders.getSubFolders.mockImplementation(async (folderId) => {
      if (folderId === 'root1') return [folder1];
      if (folderId === 'f1') return [rootFolder]; // circular
      return [];
    });

    const result = await getAllFoldersForAccount('account1');
    // Should not loop forever, should have exactly 2 unique folders
    expect(result).toHaveLength(2);
  });

  it('handles getSubFolders throwing for a folder', async () => {
    const rootFolder = { id: 'root1', name: 'Root', path: '/' };
    const inbox = { id: 'f1', name: 'Inbox', path: '/INBOX' };

    browser.accounts.list.mockResolvedValue([
      { id: 'account1', rootFolder },
    ]);
    browser.folders.getSubFolders.mockImplementation(async (folderId) => {
      if (folderId === 'root1') return [inbox];
      throw new Error('IMAP sync error');
    });

    const result = await getAllFoldersForAccount('account1');
    // Should still return root + inbox despite error on inbox children
    expect(result).toHaveLength(2);
  });

  it('handles accounts.list throwing', async () => {
    browser.accounts.list.mockRejectedValue(new Error('no access'));
    const result = await getAllFoldersForAccount('account1');
    expect(result).toEqual([]);
  });

  it('skips folders without id', async () => {
    const rootFolder = { id: 'root1', name: 'Root', path: '/' };

    browser.accounts.list.mockResolvedValue([
      { id: 'account1', rootFolder },
    ]);
    browser.folders.getSubFolders.mockResolvedValue([
      { name: 'NoId' }, // no id property
      null,
    ]);

    const result = await getAllFoldersForAccount('account1');
    // Only root folder should be returned
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('root1');
  });
});
