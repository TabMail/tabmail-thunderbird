/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// threadTagGroup.test.js — Tests for agent/modules/threadTagGroup.js
//
// Post Phase 0 contracts for the thread-effective-action code path:
//   - updateThreadEffectiveTagsIfNeeded only runs when tagByThreadEnabled=true
//     AND allActionsReady=true.
//   - When it runs, it calls actionCache.setAction for each weId in the thread
//     (NOT browser.messages.update({tags:...})).
//   - computeAndStoreThreadTagList's aggregate-store logic still runs unchanged.

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
      tagByThreadDefault: false,
      debugTagRace: { enabled: false },
      threadEnumeration: { maxThreadMessages: 100 },
    },
  },
}));

const mockSetAction = vi.fn();
vi.mock('../agent/modules/actionCache.js', () => ({
  applyThreadEffective: (...args) => mockSetAction(...args),
  ACTIONS: { REPLY: 'reply', ARCHIVE: 'archive', DELETE: 'delete', NONE: 'none' },
}));

const mockIsInboxFolder = vi.fn((folder) => !!folder?.isInbox);
vi.mock('../agent/modules/folderUtils.js', () => ({
  isInboxFolder: (...args) => mockIsInboxFolder(...args),
}));

let idbStore = {};
const mockIdbGet = vi.fn(async (keys) => {
  if (typeof keys === 'string') keys = [keys];
  const result = {};
  for (const k of keys) {
    if (idbStore[k] !== undefined) result[k] = idbStore[k];
  }
  return result;
});
const mockIdbSet = vi.fn(async (obj) => {
  Object.assign(idbStore, obj);
});
const mockIdbRemove = vi.fn(async (keys) => {
  if (typeof keys === 'string') keys = [keys];
  for (const k of keys) delete idbStore[k];
});

vi.mock('../agent/modules/idbStorage.js', () => ({
  get: mockIdbGet,
  set: mockIdbSet,
  remove: mockIdbRemove,
}));

vi.mock('../agent/modules/tagDefs.js', () => ({
  ACTION_TAG_IDS: { reply: 'tm_reply', archive: 'tm_archive', delete: 'tm_delete', none: 'tm_none' },
  maxPriorityAction: (actions) => {
    // Simple priority impl for tests: reply > delete > archive > none
    const priority = { reply: 4, delete: 3, archive: 2, none: 1 };
    let best = null;
    let bestP = 0;
    for (const a of (actions || [])) {
      const p = priority[a] || 0;
      if (p > bestP) { best = a; bestP = p; }
    }
    return best;
  },
  isDebugTagRaceEnabled: () => false,
}));

const mockFindInboxFolderForAccount = vi.fn();
const mockGetConversationForWeMsgId = vi.fn();
const mockGetInboxWeIdsForConversation = vi.fn();
const mockReadCachedActionForWeId = vi.fn();

vi.mock('../agent/modules/tagHelper.js', () => ({
  findInboxFolderForAccount: (...args) => mockFindInboxFolderForAccount(...args),
  getConversationForWeMsgId: (...args) => mockGetConversationForWeMsgId(...args),
  getInboxWeIdsForConversation: (...args) => mockGetInboxWeIdsForConversation(...args),
  readCachedActionForWeId: (...args) => mockReadCachedActionForWeId(...args),
}));

globalThis.browser = {
  accounts: { list: vi.fn(async () => []) },
  messages: {
    get: vi.fn(),
    update: vi.fn(),
    list: vi.fn(async () => ({ messages: [] })),
    onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const {
  computeAndStoreThreadTagList,
  updateThreadEffectiveTagsIfNeeded,
  getTagByThreadEnabled,
} = await import('../agent/modules/threadTagGroup.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  idbStore = {};
  vi.clearAllMocks();
  mockIsInboxFolder.mockImplementation((folder) => !!folder?.isInbox);
});

describe('updateThreadEffectiveTagsIfNeeded — Phase 0 contracts', () => {
  it('delegates member ids to the owner without replaying captured actions', async () => {
    // Seed: setup a thread of 3 messages with mixed actions
    const headers = {
      101: { id: 101, folder: { isInbox: true, path: 'INBOX' }, headerMessageId: 'mid101' },
      102: { id: 102, folder: { isInbox: true, path: 'INBOX' }, headerMessageId: 'mid102' },
      103: { id: 103, folder: { isInbox: true, path: 'INBOX' }, headerMessageId: 'mid103' },
    };
    browser.messages.get.mockImplementation(async (id) => headers[id]);

    // tagByThread enabled
    browser.storage.local.get.mockResolvedValue({ tagByThreadEnabled: true });

    const precomputed = {
      ok: true,
      weIds: [101, 102, 103],
      actions: ['archive', 'reply', 'archive'], // max priority should be reply
      allActionsReady: true,
    };

    await updateThreadEffectiveTagsIfNeeded(101, precomputed, 'test');

    // Should write "reply" (max priority) to all three messages
    expect(mockSetAction).toHaveBeenCalledExactlyOnceWith([101,102,103]);

    // Should NOT call browser.messages.update (ADD path is gone)
    expect(browser.messages.update).not.toHaveBeenCalled();
  });

  it('skips write when tagByThreadEnabled=false (freshly-loaded module)', async () => {
    // The module caches getTagByThreadEnabled result on first call; use a
    // fresh module import to exercise the false-path from a clean state.
    vi.resetModules();
    browser.storage.local.get.mockResolvedValue({ tagByThreadEnabled: false });
    const { updateThreadEffectiveTagsIfNeeded: freshUpdate } = await import('../agent/modules/threadTagGroup.js');

    const precomputed = {
      ok: true,
      weIds: [101],
      actions: ['reply'],
      allActionsReady: true,
    };

    await freshUpdate(101, precomputed, 'test');

    expect(mockSetAction).not.toHaveBeenCalled();
    expect(browser.messages.update).not.toHaveBeenCalled();
  });

  it('lets the owner re-read readiness instead of trusting captured readiness', async () => {
    browser.storage.local.get.mockResolvedValue({ tagByThreadEnabled: true });

    const precomputed = {
      ok: true,
      weIds: [101, 102],
      actions: ['reply'], // only one of two messages has an action yet
      allActionsReady: false,
    };

    await updateThreadEffectiveTagsIfNeeded(101, precomputed, 'test');

    expect(mockSetAction).toHaveBeenCalledWith([101,102]);
  });

  it('skips write when precomputed.ok=false', async () => {
    browser.storage.local.get.mockResolvedValue({ tagByThreadEnabled: true });

    const precomputed = {
      ok: false,
      weIds: [],
      actions: [],
      allActionsReady: true,
    };

    await updateThreadEffectiveTagsIfNeeded(101, precomputed, 'test');

    expect(mockSetAction).not.toHaveBeenCalled();
  });

  it('skips non-inbox messages even in an otherwise-eligible thread', async () => {
    const headers = {
      201: { id: 201, folder: { isInbox: true, path: 'INBOX' }, headerMessageId: 'mid201' },
      202: { id: 202, folder: { isInbox: false, path: 'Archive' }, headerMessageId: 'mid202' }, // non-inbox
    };
    browser.messages.get.mockImplementation(async (id) => headers[id]);
    browser.storage.local.get.mockResolvedValue({ tagByThreadEnabled: true });

    const precomputed = {
      ok: true,
      weIds: [201, 202],
      actions: ['delete', 'delete'],
      allActionsReady: true,
    };

    await updateThreadEffectiveTagsIfNeeded(201, precomputed, 'test');

    // Only the inbox message gets the write
    expect(mockSetAction).toHaveBeenCalledExactlyOnceWith([201,202]);
  });
});

describe('getTagByThreadEnabled', () => {
  it('reads tagByThreadEnabled from storage', async () => {
    browser.storage.local.get.mockResolvedValue({ tagByThreadEnabled: true });
    // First call populates the module-level cache
    const v = await getTagByThreadEnabled();
    expect(v).toBe(true);
  });
});

describe('thread tag update listener ownership', () => {
  let listeners;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    idbStore = {};
    listeners = new Set();
    browser.messages.onUpdated.addListener.mockImplementation((listener) => listeners.add(listener));
    browser.messages.onUpdated.removeListener.mockImplementation((listener) => listeners.delete(listener));
    browser.messages.get.mockResolvedValue({ id: 101, folder: { accountId: 'test-account', path: 'INBOX' } });
    browser.storage.local.get.mockResolvedValue({ tagByThreadEnabled: true });
    mockGetConversationForWeMsgId.mockResolvedValue({ ok: true, conversationId: 'test-thread', headerMessageIds: ['synthetic-id'] });
    mockFindInboxFolderForAccount.mockResolvedValue({ id: 'test-inbox', path: 'INBOX' });
    mockGetInboxWeIdsForConversation.mockResolvedValue([101]);
    mockReadCachedActionForWeId.mockResolvedValue('reply');
  });

  it('handles the first tag update and keeps one owner when late init repeats', async () => {
    const { attachThreadTagWatchers } = await import('../agent/modules/threadTagGroup.js');
    attachThreadTagWatchers();
    attachThreadTagWatchers();
    expect(listeners.size).toBe(1);
    expect(browser.messages.onUpdated.addListener).toHaveBeenCalledTimes(1);

    const listener = [...listeners][0];
    await listener({ id: 101 }, { tags: ['tm_reply'] });
    expect(idbStore['threadTags:test-account:INBOX:glodaConv:test-thread']?.messageActions).toEqual({ 101: 'reply' });
    expect(mockSetAction).toHaveBeenCalledExactlyOnceWith([101]);

    await listener({ id: 101 }, { read: true });
    expect(mockSetAction).toHaveBeenCalledTimes(1);
  });

  it('retries a failed add without stacking and retains ownership on failed remove', async () => {
    const { attachThreadTagWatchers, cleanupThreadTagWatchers } = await import('../agent/modules/threadTagGroup.js');
    browser.messages.onUpdated.addListener.mockImplementationOnce(() => { throw new Error('synthetic add failure'); });
    attachThreadTagWatchers();
    expect(listeners.size).toBe(0);
    attachThreadTagWatchers();
    expect(listeners.size).toBe(1);

    browser.messages.onUpdated.removeListener.mockImplementationOnce(() => { throw new Error('synthetic remove failure'); });
    cleanupThreadTagWatchers();
    attachThreadTagWatchers();
    expect(listeners.size).toBe(1);
    expect(browser.messages.onUpdated.addListener).toHaveBeenCalledTimes(2);
  });
});

describe('tag-by-thread setting listener ownership', () => {
  let listeners;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    idbStore = {};
    listeners = new Set();
    browser.storage.onChanged.addListener.mockImplementation(listener => listeners.add(listener));
    browser.storage.onChanged.removeListener.mockImplementation(listener => listeners.delete(listener));
    browser.accounts.list.mockResolvedValue([{ id: 'test-account' }]);
    browser.messages.list.mockResolvedValue({ messages: [{ id: 101 }] });
    browser.messages.get.mockResolvedValue({ id: 101, folder: { accountId: 'test-account', path: 'INBOX' } });
    mockFindInboxFolderForAccount.mockResolvedValue({ id: 'test-inbox', path: 'INBOX' });
    mockGetConversationForWeMsgId.mockResolvedValue({ ok: true, conversationId: 'test-thread', headerMessageIds: ['synthetic-id'] });
    mockGetInboxWeIdsForConversation.mockResolvedValue([101]);
    mockReadCachedActionForWeId.mockResolvedValue('reply');
  });

  it('processes the first toggle once and ignores unrelated storage changes', async () => {
    const { attachTagByThreadListener } = await import('../agent/modules/threadTagGroup.js');
    attachTagByThreadListener();
    attachTagByThreadListener();
    expect(listeners.size).toBe(1);
    expect(browser.storage.onChanged.addListener).toHaveBeenCalledTimes(1);

    const listener = [...listeners][0];
    await listener({ tagByThreadEnabled: { newValue: true } }, 'local');
    expect(idbStore['threadTags:test-account:INBOX:glodaConv:test-thread']?.messageActions).toEqual({ 101: 'reply' });
    expect(mockSetAction).toHaveBeenCalledExactlyOnceWith([101]);

    await listener({ tagByThreadEnabled: { newValue: false } }, 'sync');
    await listener({ otherSetting: { newValue: true } }, 'local');
    expect(mockSetAction).toHaveBeenCalledTimes(1);
  });

  it('retries failed attachment without stacking after failed removal', async () => {
    const { attachTagByThreadListener, cleanupTagByThreadListener } = await import('../agent/modules/threadTagGroup.js');
    browser.storage.onChanged.addListener.mockImplementationOnce(() => { throw new Error('synthetic add failure'); });
    attachTagByThreadListener();
    expect(listeners.size).toBe(0);
    attachTagByThreadListener();
    expect(listeners.size).toBe(1);

    browser.storage.onChanged.removeListener.mockImplementationOnce(() => { throw new Error('synthetic remove failure'); });
    cleanupTagByThreadListener();
    attachTagByThreadListener();
    expect(listeners.size).toBe(1);
    expect(browser.storage.onChanged.addListener).toHaveBeenCalledTimes(2);
  });
});
