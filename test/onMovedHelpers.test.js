// onMovedHelpers.test.js — Tests for pure helper functions in agent/modules/onMoved.js

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
    actionTagging: {
      actionPriority: { reply: 40, delete: 30, archive: 20, none: 10 },
      debugTagRace: { enabled: false },
    },
    memoryManagement: {},
  },
}));

vi.mock('../agent/modules/autoUpdateUserPrompt.js', () => ({
  autoUpdateUserPromptOnMove: vi.fn(),
}));

vi.mock('../agent/modules/eventLogger.js', () => ({
  logMessageEvent: vi.fn(),
  logMoveEvent: vi.fn(),
}));

vi.mock('../agent/modules/folderUtils.js', () => ({
  getAllFoldersForAccount: vi.fn(async () => []),
  isInboxFolder: vi.fn(() => false),
}));

vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
}));

vi.mock('../agent/modules/inboxContext.js', () => ({
  getInboxForAccount: vi.fn(async () => null),
}));

vi.mock('../agent/modules/tagHelper.js', () => ({
  ACTION_TAG_IDS: {
    delete: 'tm_delete',
    archive: 'tm_archive',
    reply: 'tm_reply',
    none: 'tm_none',
  },
  recomputeThreadForInboxMessage: vi.fn(async () => {}),
}));

vi.mock('../agent/modules/utils.js', () => ({
  clearAlarm: vi.fn(),
  ensureAlarm: vi.fn(),
  getArchiveFolderForHeader: vi.fn(async () => null),
  getTrashFolderForHeader: vi.fn(async () => null),
  getUniqueMessageKey: vi.fn(async () => 'mock-key'),
  indexHeader: vi.fn(),
  log: vi.fn(),
  removeHeaderIndexForDeletedMessage: vi.fn(),
  updateHeaderIndexForMovedMessage: vi.fn(),
}));

globalThis.browser = {
  messages: {
    get: vi.fn(async () => null),
    update: vi.fn(async () => {}),
    move: vi.fn(async () => {}),
    list: vi.fn(async () => ({ messages: [] })),
    tags: {
      list: vi.fn(async () => []),
    },
  },
  messages_ext: {
    listSince: vi.fn(async () => ({ messages: [] })),
  },
  accounts: {
    list: vi.fn(async () => []),
  },
  folders: {
    getSubFolders: vi.fn(async () => []),
  },
  alarms: {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  compose: {
    onAfterSend: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const { _testHelpers } = await import('../agent/modules/onMoved.js');
const { _isMessageNotFoundError, _hasTabMailActionTags, _stripTabMailActionTagsFromList, _extractListsFromArgs } = _testHelpers;

// ---------------------------------------------------------------------------
// _isMessageNotFoundError
// ---------------------------------------------------------------------------

describe('_isMessageNotFoundError', () => {
  it('returns true for Error with "message not found"', () => {
    expect(_isMessageNotFoundError(new Error('message not found'))).toBe(true);
  });

  it('returns true for case-insensitive "Message Not Found"', () => {
    expect(_isMessageNotFoundError(new Error('Message Not Found'))).toBe(true);
  });

  it('returns true for string "message not found in folder"', () => {
    expect(_isMessageNotFoundError('message not found in folder')).toBe(true);
  });

  it('returns false for Error with a different message', () => {
    expect(_isMessageNotFoundError(new Error('network timeout'))).toBe(false);
  });

  it('returns false for null', () => {
    expect(_isMessageNotFoundError(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(_isMessageNotFoundError(undefined)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(_isMessageNotFoundError('')).toBe(false);
  });

  it('returns false for non-string input like a number', () => {
    expect(_isMessageNotFoundError(12345)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _hasTabMailActionTags
// ---------------------------------------------------------------------------

describe('_hasTabMailActionTags', () => {
  it('returns true when tags contain a TabMail action tag', () => {
    expect(_hasTabMailActionTags(['tm_delete'])).toBe(true);
    expect(_hasTabMailActionTags(['tm_archive'])).toBe(true);
    expect(_hasTabMailActionTags(['tm_reply'])).toBe(true);
    expect(_hasTabMailActionTags(['tm_none'])).toBe(true);
  });

  it('returns false for tags without any TabMail tags', () => {
    expect(_hasTabMailActionTags(['$label1', 'custom_tag'])).toBe(false);
  });

  it('returns false for empty array', () => {
    expect(_hasTabMailActionTags([])).toBe(false);
  });

  it('returns false for non-array input', () => {
    expect(_hasTabMailActionTags('tm_delete')).toBe(false);
    expect(_hasTabMailActionTags(42)).toBe(false);
    expect(_hasTabMailActionTags({})).toBe(false);
  });

  it('returns false for null', () => {
    expect(_hasTabMailActionTags(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(_hasTabMailActionTags(undefined)).toBe(false);
  });

  it('returns true for mix of TabMail and non-TabMail tags', () => {
    expect(_hasTabMailActionTags(['$label1', 'tm_reply', 'custom'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// _stripTabMailActionTagsFromList
// ---------------------------------------------------------------------------

describe('_stripTabMailActionTagsFromList', () => {
  it('removes TabMail action tags and keeps others', () => {
    const result = _stripTabMailActionTagsFromList(['$label1', 'tm_delete', 'custom', 'tm_reply']);
    expect(result).toEqual(['$label1', 'custom']);
  });

  it('returns empty array for empty input', () => {
    expect(_stripTabMailActionTagsFromList([])).toEqual([]);
  });

  it('returns empty array when all tags are TabMail tags', () => {
    expect(_stripTabMailActionTagsFromList(['tm_delete', 'tm_archive', 'tm_reply', 'tm_none'])).toEqual([]);
  });

  it('returns unchanged array when no TabMail tags present', () => {
    const tags = ['$label1', '$label2', 'custom'];
    const result = _stripTabMailActionTagsFromList(tags);
    expect(result).toEqual(['$label1', '$label2', 'custom']);
  });

  it('returns empty array for non-array input', () => {
    expect(_stripTabMailActionTagsFromList('tm_delete')).toEqual([]);
    expect(_stripTabMailActionTagsFromList(42)).toEqual([]);
    expect(_stripTabMailActionTagsFromList(null)).toEqual([]);
    expect(_stripTabMailActionTagsFromList(undefined)).toEqual([]);
  });

  it('preserves order of remaining tags', () => {
    const result = _stripTabMailActionTagsFromList(['z_tag', 'tm_archive', 'a_tag', 'tm_none', 'm_tag']);
    expect(result).toEqual(['z_tag', 'a_tag', 'm_tag']);
  });
});

// ---------------------------------------------------------------------------
// _extractListsFromArgs
// ---------------------------------------------------------------------------

describe('_extractListsFromArgs', () => {
  it('extracts items from args with messages array', () => {
    const msg1 = { id: 1, subject: 'Hello' };
    const msg2 = { id: 2, subject: 'World' };
    const result = _extractListsFromArgs([{ messages: [msg1, msg2] }]);
    expect(result.items).toEqual([msg1, msg2]);
    expect(result.hasHeaders).toBe(true);
  });

  it('extracts items from args with messageIds', () => {
    const result = _extractListsFromArgs([{ messageIds: [10, 20, 30] }]);
    expect(result.items).toEqual([{ id: 10 }, { id: 20 }, { id: 30 }]);
    expect(result.hasHeaders).toBe(false);
  });

  it('extracts items from args with ids (alternate key)', () => {
    const result = _extractListsFromArgs([{ ids: [5, 6] }]);
    expect(result.items).toEqual([{ id: 5 }, { id: 6 }]);
    expect(result.hasHeaders).toBe(false);
  });

  it('prefers messageIds over ids when both present', () => {
    const result = _extractListsFromArgs([{ messageIds: [1], ids: [99] }]);
    expect(result.items).toEqual([{ id: 1 }]);
  });

  it('extracts before/after lists from two-list format', () => {
    const before = [{ id: 1, folder: 'Inbox' }];
    const after = [{ id: 2, folder: 'Archive' }];
    const result = _extractListsFromArgs([{ messages: before }, { messages: after }]);
    expect(result.hasTwoLists).toBe(true);
    expect(result.beforeList).toEqual(before);
    expect(result.afterList).toEqual(after);
  });

  it('sets hasTwoLists=false for single-list format', () => {
    const result = _extractListsFromArgs([{ messages: [{ id: 1 }] }]);
    expect(result.hasTwoLists).toBe(false);
    expect(result.beforeList).toEqual([]);
    expect(result.afterList).toEqual([{ id: 1 }]);
  });

  it('handles null args gracefully', () => {
    const result = _extractListsFromArgs(null);
    expect(result.details).toEqual({});
    expect(result.items).toEqual([]);
    expect(result.hasTwoLists).toBeFalsy();
    expect(result.beforeList).toEqual([]);
    expect(result.afterList).toEqual([]);
  });

  it('handles undefined args gracefully', () => {
    const result = _extractListsFromArgs(undefined);
    expect(result.details).toEqual({});
    expect(result.items).toEqual([]);
  });

  it('handles empty array args gracefully', () => {
    const result = _extractListsFromArgs([]);
    expect(result.details).toEqual({});
    expect(result.items).toEqual([]);
    expect(result.hasTwoLists).toBe(false);
  });

  it('handles args with empty messages array', () => {
    const result = _extractListsFromArgs([{ messages: [] }]);
    expect(result.hasHeaders).toBe(false);
    expect(result.items).toEqual([]);
  });

  it('returns details as the first element of args', () => {
    const detail = { messages: [{ id: 1 }], extra: 'data' };
    const result = _extractListsFromArgs([detail]);
    expect(result.details).toBe(detail);
  });
});
