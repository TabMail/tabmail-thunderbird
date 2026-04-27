// tagHelper.test.js — Tests for agent/modules/tagHelper.js
//
// Post Phase 0 contracts:
//   - applyActionTags writes to IDB via actionCache.setAction (NOT via browser.messages.update).
//   - applyActionTags skips non-inbox messages.
//   - applyActionTags triggers thread aggregate recompute.
//   - applyPriorityTag writes to IDB via actionCache.setAction.
//   - applyPriorityTag skips non-inbox messages.
//   - applyPriorityTag triggers thread aggregate recompute.
//   - NO calls to browser.messages.update with a tags list (ADD path removed).
//   - NO calls to syncGmailTagFolder / gmailLabelSync (ADD path removed; module trimmed to REMOVE-only).

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  },
}));

const mockSetAction = vi.fn();
const mockClearAction = vi.fn();

vi.mock('../agent/modules/actionCache.js', () => ({
  setAction: (...args) => mockSetAction(...args),
  clearAction: (...args) => mockClearAction(...args),
  clearActionByUniqueKey: (...args) => mockClearAction(...args),
  ACTIONS: { REPLY: 'reply', ARCHIVE: 'archive', DELETE: 'delete', NONE: 'none' },
}));

const mockIsInboxFolder = vi.fn((folder) => !!folder?.isInbox);
const mockGetAllFoldersForAccount = vi.fn(async () => []);

vi.mock('../agent/modules/folderUtils.js', () => ({
  isInboxFolder: (...args) => mockIsInboxFolder(...args),
  getAllFoldersForAccount: (...args) => mockGetAllFoldersForAccount(...args),
}));

const mockGetUniqueMessageKey = vi.fn();

vi.mock('../agent/modules/utils.js', () => ({
  getUniqueMessageKey: (...args) => mockGetUniqueMessageKey(...args),
  indexHeader: vi.fn(),
  log: vi.fn(),
}));

const mockEnsureActionTags = vi.fn(async () => {});
const mockTriggerSortRefresh = vi.fn();

vi.mock('../agent/modules/tagDefs.js', () => ({
  ACTION_TAG_IDS: { reply: 'tm_reply', archive: 'tm_archive', delete: 'tm_delete', none: 'tm_none' },
  ensureActionTags: (...args) => mockEnsureActionTags(...args),
  triggerSortRefresh: (...args) => mockTriggerSortRefresh(...args),
  isDebugTagRaceEnabled: () => false,
  actionFromLiveTagIds: vi.fn(),
  maxPriorityAction: vi.fn(),
}));

const mockComputeAndStoreThreadTagList = vi.fn(async () => ({ ok: true, weIds: [], actions: [], allActionsReady: true }));
const mockUpdateThreadEffectiveTagsIfNeeded = vi.fn(async () => {});
const mockGetTagByThreadEnabled = vi.fn(async () => false);

vi.mock('../agent/modules/threadTagGroup.js', () => ({
  getTagByThreadEnabled: (...args) => mockGetTagByThreadEnabled(...args),
  computeAndStoreThreadTagList: (...args) => mockComputeAndStoreThreadTagList(...args),
  updateThreadEffectiveTagsIfNeeded: (...args) => mockUpdateThreadEffectiveTagsIfNeeded(...args),
  attachTagByThreadListener: vi.fn(),
  cleanupTagByThreadListener: vi.fn(),
  attachThreadTagWatchers: vi.fn(),
  cleanupThreadTagWatchers: vi.fn(),
  retagAllInboxesForTagByThreadToggle: vi.fn(),
  recomputeThreadForInboxMessage: vi.fn(),
}));

globalThis.browser = {
  messages: {
    get: vi.fn(),
    update: vi.fn(),
    query: vi.fn(async () => ({ messages: [] })),
  },
  accounts: { list: vi.fn(async () => []) },
  folders: { getSubFolders: vi.fn(async () => []) },
  glodaSearch: {
    getConversationMessages: vi.fn(async () => ({ success: false, messages: [] })),
  },
};

const { applyActionTags, applyPriorityTag } = await import('../agent/modules/tagHelper.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  mockIsInboxFolder.mockImplementation((folder) => !!folder?.isInbox);
  mockGetTagByThreadEnabled.mockResolvedValue(false);
  mockComputeAndStoreThreadTagList.mockResolvedValue({ ok: true, weIds: [], actions: [], allActionsReady: true });
});

describe('applyActionTags — Phase 0 contracts', () => {
  it('writes to IDB via actionCache.setAction for inbox messages', async () => {
    const msg = { id: 1, folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' }, headerMessageId: 'mid1', tags: [] };
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid1');

    await applyActionTags([msg], { 'acc1:INBOX:mid1': 'reply' });

    // Passes the header so actionCache can dual-write IDB + hdr property.
    // uniqueKey derivation happens inside actionCache via getUniqueMessageKey.
    expect(mockSetAction).toHaveBeenCalledWith(msg, 'reply');
  });

  it('does NOT call browser.messages.update with a tag list (ADD path removed)', async () => {
    const msg = { id: 1, folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' }, headerMessageId: 'mid1', tags: [] };
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid1');

    await applyActionTags([msg], { 'acc1:INBOX:mid1': 'reply' });

    expect(browser.messages.update).not.toHaveBeenCalled();
  });

  it('skips messages that are not in inbox', async () => {
    const msg = { id: 2, folder: { isInbox: false, path: 'Archive' }, headerMessageId: 'mid2', tags: [] };

    await applyActionTags([msg], { 'some-key': 'archive' });

    expect(mockSetAction).not.toHaveBeenCalled();
    expect(browser.messages.update).not.toHaveBeenCalled();
  });

  it('skips messages whose uniqueKey has no matching action in the map', async () => {
    const msg = { id: 3, folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' }, headerMessageId: 'mid3', tags: [] };
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid3');

    await applyActionTags([msg], { 'some-other-key': 'reply' });

    expect(mockSetAction).not.toHaveBeenCalled();
  });

  it('triggers thread aggregate recompute after the IDB writes', async () => {
    const msg = { id: 4, folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' }, headerMessageId: 'mid4', tags: [] };
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid4');

    await applyActionTags([msg], { 'acc1:INBOX:mid4': 'reply' });

    expect(mockComputeAndStoreThreadTagList).toHaveBeenCalledWith(4);
  });

  it('applies effective-action rewrite only when tagByThreadEnabled=true AND compute returned ok', async () => {
    const msg = { id: 5, folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' }, headerMessageId: 'mid5', tags: [] };
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid5');
    mockGetTagByThreadEnabled.mockResolvedValue(true);
    mockComputeAndStoreThreadTagList.mockResolvedValue({ ok: true, weIds: [5], actions: ['reply'], allActionsReady: true });

    await applyActionTags([msg], { 'acc1:INBOX:mid5': 'reply' });

    expect(mockUpdateThreadEffectiveTagsIfNeeded).toHaveBeenCalled();
  });

  it('skips effective-action rewrite when tagByThreadEnabled=false', async () => {
    const msg = { id: 6, folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' }, headerMessageId: 'mid6', tags: [] };
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid6');
    mockGetTagByThreadEnabled.mockResolvedValue(false);

    await applyActionTags([msg], { 'acc1:INBOX:mid6': 'reply' });

    expect(mockUpdateThreadEffectiveTagsIfNeeded).not.toHaveBeenCalled();
  });
});

describe('applyPriorityTag — Phase 0 contracts', () => {
  it('writes to IDB via actionCache.setAction for inbox messages', async () => {
    browser.messages.get.mockResolvedValue({
      id: 10,
      folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' },
      headerMessageId: 'mid10',
      tags: [],
    });
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid10');

    await applyPriorityTag(10, 'delete');

    // Passes the header so actionCache dual-writes IDB + hdr property.
    expect(mockSetAction).toHaveBeenCalledWith(
      expect.objectContaining({ id: 10, headerMessageId: 'mid10' }),
      'delete'
    );
  });

  it('does NOT call browser.messages.update with a tag list', async () => {
    browser.messages.get.mockResolvedValue({
      id: 11,
      folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' },
      headerMessageId: 'mid11',
      tags: [],
    });
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid11');

    await applyPriorityTag(11, 'archive');

    expect(browser.messages.update).not.toHaveBeenCalled();
  });

  it('skips non-inbox messages', async () => {
    browser.messages.get.mockResolvedValue({
      id: 12,
      folder: { isInbox: false, path: 'Archive' },
      headerMessageId: 'mid12',
      tags: [],
    });

    await applyPriorityTag(12, 'reply');

    expect(mockSetAction).not.toHaveBeenCalled();
  });

  it('triggers thread aggregate recompute after the IDB write', async () => {
    browser.messages.get.mockResolvedValue({
      id: 13,
      folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' },
      headerMessageId: 'mid13',
      tags: [],
    });
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid13');

    await applyPriorityTag(13, 'none');

    expect(mockComputeAndStoreThreadTagList).toHaveBeenCalledWith(13);
  });

  it('triggers sort refresh after the write', async () => {
    browser.messages.get.mockResolvedValue({
      id: 14,
      folder: { isInbox: true, path: 'INBOX', accountId: 'acc1' },
      headerMessageId: 'mid14',
      tags: [],
    });
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid14');

    await applyPriorityTag(14, 'reply');

    expect(mockTriggerSortRefresh).toHaveBeenCalled();
  });
});
