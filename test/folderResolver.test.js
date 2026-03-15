// folderResolver.test.js — Tests for agent/modules/folderResolver.js
//
// Tests the toWeFolderRef pure function and resolveWeFolderFromXulUri with mocked browser.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock browser.accounts
// ---------------------------------------------------------------------------

globalThis.browser = {
  accounts: {
    list: vi.fn(async () => [
      {
        id: 'acc1',
        name: 'Work Account',
        identities: [{ email: 'user@example.com' }],
        incomingServer: { hostname: 'imap.example.com', type: 'imap' },
        rootFolder: {
          path: '/',
          name: 'Root',
          accountId: 'acc1',
          id: 'root',
          type: 'none',
          subFolders: [
            {
              path: '/INBOX',
              name: 'INBOX',
              accountId: 'acc1',
              id: 'inbox-1',
              type: 'inbox',
              subFolders: [
                {
                  path: '/INBOX/Sub',
                  name: 'Sub',
                  accountId: 'acc1',
                  id: 'sub-1',
                  type: 'normal',
                  subFolders: [],
                },
              ],
            },
            {
              path: '/Archive',
              name: 'Archive',
              accountId: 'acc1',
              id: 'archive-1',
              type: 'archives',
              subFolders: [],
            },
          ],
        },
      },
    ]),
  },
};

const { resolveWeFolderFromXulUri, toWeFolderRef } = await import('../agent/modules/folderResolver.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('toWeFolderRef', () => {
  it('returns null for null input', () => {
    expect(toWeFolderRef(null)).toBeNull();
  });

  it('returns normalized folder ref', () => {
    const folder = {
      accountId: 'acc1',
      path: '/INBOX',
      id: 'inbox-1',
      name: 'INBOX',
      type: 'inbox',
      subFolders: [{ path: '/INBOX/Sub' }], // Should not be in output
    };
    const ref = toWeFolderRef(folder);
    expect(ref.accountId).toBe('acc1');
    expect(ref.path).toBe('/INBOX');
    expect(ref.id).toBe('inbox-1');
    expect(ref.name).toBe('INBOX');
    expect(ref.type).toBe('inbox');
    expect(ref.subFolders).toBeUndefined();
  });
});

describe('resolveWeFolderFromXulUri', () => {
  it('returns null for null input', async () => {
    const result = await resolveWeFolderFromXulUri(null);
    expect(result).toBeNull();
  });

  it('returns null for empty string', async () => {
    const result = await resolveWeFolderFromXulUri('');
    expect(result).toBeNull();
  });

  it('returns null for non-string input', async () => {
    const result = await resolveWeFolderFromXulUri(42);
    expect(result).toBeNull();
  });

  it('resolves IMAP URI to folder', async () => {
    const uri = 'imap://user%40example.com@imap.example.com/INBOX';
    const result = await resolveWeFolderFromXulUri(uri);
    expect(result).toBeDefined();
    expect(result.path).toBe('/INBOX');
    expect(result.accountId).toBe('acc1');
  });

  it('resolves subfolder URI', async () => {
    const uri = 'imap://user%40example.com@imap.example.com/INBOX/Sub';
    const result = await resolveWeFolderFromXulUri(uri);
    expect(result).toBeDefined();
    expect(result.path).toBe('/INBOX/Sub');
    expect(result.name).toBe('Sub');
  });

  it('caches results for repeated calls', async () => {
    const uri = 'imap://user%40example.com@imap.example.com/Archive';
    const result1 = await resolveWeFolderFromXulUri(uri);
    const result2 = await resolveWeFolderFromXulUri(uri);
    expect(result1).toBe(result2); // Same reference = cached
  });

  it('returns null for non-existent folder path', async () => {
    const uri = 'imap://user%40example.com@imap.example.com/NonExistent';
    const result = await resolveWeFolderFromXulUri(uri);
    expect(result).toBeNull();
  });

  it('returns null for malformed URI', async () => {
    const result = await resolveWeFolderFromXulUri('not-a-uri');
    expect(result).toBeNull();
  });

  it('returns normalized ref when normalize option is true', async () => {
    const uri = 'imap://user%40example.com@imap.example.com/Archive';
    const result = await resolveWeFolderFromXulUri(uri, { normalize: true });
    expect(result).toBeDefined();
    expect(result.path).toBe('/Archive');
    // Should not contain subFolders
    expect(result.subFolders).toBeUndefined();
  });
});
