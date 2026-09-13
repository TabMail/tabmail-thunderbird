/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// actionCache.test.js — Tests for agent/modules/actionCache.js
//
// Tests the canonical IDB read/write module for per-message AI action state.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock stores
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/idbStorage.js', () => ({
  get: mockIdbGet,
  set: mockIdbSet,
  remove: mockIdbRemove,
}));

const mockGetUniqueMessageKey = vi.fn();

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: {} }));
vi.mock('../agent/modules/tagDefs.js', () => ({ triggerSortRefresh: vi.fn(), maxPriorityAction: vi.fn() }));
vi.mock('../agent/modules/utils.js', () => ({
  getUniqueMessageKey: (...args) => mockGetUniqueMessageKey(...args),
}));

const mockHdrSetAction = vi.fn(async () => true);

globalThis.browser = {
  messages: { get: vi.fn() },
  tmHdr: {
    setAction: mockHdrSetAction,
  },
};

const {
  ACTIONS,
  getActionForWeId,
  getActionForUniqueKey,
  getActionsForUniqueKeys,
  setAction,
  clearAction,
  clearActionByUniqueKey,
} = await import('../agent/modules/actionCache.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  idbStore = {};
  vi.clearAllMocks();
});

describe('ACTIONS enum', () => {
  it('exposes the four action names in plain form (no tm_ prefix)', () => {
    expect(ACTIONS.REPLY).toBe('reply');
    expect(ACTIONS.ARCHIVE).toBe('archive');
    expect(ACTIONS.DELETE).toBe('delete');
    expect(ACTIONS.NONE).toBe('none');
  });

  it('is frozen', () => {
    expect(Object.isFrozen(ACTIONS)).toBe(true);
  });
});

describe('getActionForUniqueKey', () => {
  it('returns the cached action', async () => {
    idbStore['action:acc1:INBOX:msgid1'] = 'reply';
    expect(await getActionForUniqueKey('acc1:INBOX:msgid1')).toBe('reply');
  });

  it('returns null for no cache', async () => {
    expect(await getActionForUniqueKey('acc1:INBOX:nonexistent')).toBe(null);
  });

  it('returns null for empty/null input', async () => {
    expect(await getActionForUniqueKey(null)).toBe(null);
    expect(await getActionForUniqueKey('')).toBe(null);
    expect(await getActionForUniqueKey(undefined)).toBe(null);
  });
});

describe('getActionForWeId', () => {
  it('resolves via getUniqueMessageKey and reads from IDB', async () => {
    idbStore['action:acc1:INBOX:msgid1'] = 'archive';
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:msgid1');

    expect(await getActionForWeId(42)).toBe('archive');
  });

  it('returns null when uniqueKey cannot be resolved', async () => {
    mockGetUniqueMessageKey.mockResolvedValue(null);
    expect(await getActionForWeId(42)).toBe(null);
  });

  it('accepts a header object directly', async () => {
    idbStore['action:acc1:INBOX:msgid1'] = 'reply';
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:msgid1');

    const header = { id: 1, headerMessageId: 'msgid1' };
    expect(await getActionForWeId(header)).toBe('reply');
  });
});

describe('getActionsForUniqueKeys', () => {
  it('bulk-reads multiple keys, returning only those with cache entries', async () => {
    idbStore['action:k1'] = 'reply';
    idbStore['action:k2'] = 'delete';
    // k3 has no entry

    const result = await getActionsForUniqueKeys(['k1', 'k2', 'k3']);
    expect(result).toEqual({ k1: 'reply', k2: 'delete' });
  });

  it('returns empty object for empty input', async () => {
    expect(await getActionsForUniqueKeys([])).toEqual({});
    expect(await getActionsForUniqueKeys(null)).toEqual({});
    expect(await getActionsForUniqueKeys(undefined)).toEqual({});
  });

  it('filters out falsy keys', async () => {
    idbStore['action:k1'] = 'reply';
    const result = await getActionsForUniqueKeys(['k1', null, '', undefined]);
    expect(result).toEqual({ k1: 'reply' });
  });
});
