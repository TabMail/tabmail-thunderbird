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

describe('setAction', () => {
  it('writes both action key and ts meta key to IDB for a header object', async () => {
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:msgid1');
    const header = { id: 1, headerMessageId: 'msgid1', folder: { accountId: 'acc1', path: 'INBOX' } };

    const result = await setAction(header, 'reply');

    expect(result).toBe('acc1:INBOX:msgid1');
    expect(idbStore['action:acc1:INBOX:msgid1']).toBe('reply');
    expect(idbStore['action:ts:acc1:INBOX:msgid1']).toMatchObject({ ts: expect.any(Number) });
  });

  it('accepts a WE message id number and resolves via getUniqueMessageKey', async () => {
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:msgid2');

    const result = await setAction(42, 'archive');

    expect(result).toBe('acc1:INBOX:msgid2');
    expect(idbStore['action:acc1:INBOX:msgid2']).toBe('archive');
    expect(mockGetUniqueMessageKey).toHaveBeenCalledWith(42);
  });

  it('accepts a uniqueKey string directly (three-segment)', async () => {
    const result = await setAction('acc1:INBOX:msgid3', 'delete');

    expect(result).toBe('acc1:INBOX:msgid3');
    expect(idbStore['action:acc1:INBOX:msgid3']).toBe('delete');
    expect(mockGetUniqueMessageKey).not.toHaveBeenCalled();
  });

  it('rejects invalid action values', async () => {
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:msgid1');

    expect(await setAction({ id: 1 }, 'not_a_valid_action')).toBe(null);
    expect(await setAction({ id: 1 }, '')).toBe(null);
    expect(await setAction({ id: 1 }, null)).toBe(null);
    expect(await setAction({ id: 1 }, undefined)).toBe(null);
    expect(mockIdbSet).not.toHaveBeenCalled();
  });

  it('accepts all four valid actions', async () => {
    for (const a of ['reply', 'archive', 'delete', 'none']) {
      mockGetUniqueMessageKey.mockResolvedValue(`acc1:INBOX:${a}`);
      const result = await setAction({ id: 1 }, a);
      expect(result).toBe(`acc1:INBOX:${a}`);
      expect(idbStore[`action:acc1:INBOX:${a}`]).toBe(a);
    }
  });

  it('returns null when uniqueKey cannot be resolved', async () => {
    mockGetUniqueMessageKey.mockResolvedValue(null);
    expect(await setAction({ id: 1 }, 'reply')).toBe(null);
    expect(mockIdbSet).not.toHaveBeenCalled();
  });

  it('returns null for falsy input', async () => {
    expect(await setAction(null, 'reply')).toBe(null);
    expect(await setAction(undefined, 'reply')).toBe(null);
    expect(mockIdbSet).not.toHaveBeenCalled();
  });

  it('writes hdr property via browser.tmHdr.setAction when input is a WE id', async () => {
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid-push-we');

    await setAction(42, 'reply');

    // Push is fire-and-forget; let microtasks flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockHdrSetAction).toHaveBeenCalledWith(42, 'reply');
  });

  it('writes hdr property when input is a header object', async () => {
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid-push-hdr');
    const header = { id: 99, headerMessageId: 'mid-push-hdr', folder: { accountId: 'acc1', path: 'INBOX' } };

    await setAction(header, 'archive');

    await new Promise((r) => setTimeout(r, 0));
    expect(mockHdrSetAction).toHaveBeenCalledWith(99, 'archive');
  });

  it('does NOT write hdr property when input is a bare uniqueKey string (no weMsgId available)', async () => {
    await setAction('acc1:INBOX:mid-no-weid', 'delete');

    await new Promise((r) => setTimeout(r, 0));
    expect(mockHdrSetAction).not.toHaveBeenCalled();
  });
});

describe('clearAction — hdr property write', () => {
  it('writes null action to hdr property when clearing by weMsgId', async () => {
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:mid-clear');

    await clearAction(55);

    await new Promise((r) => setTimeout(r, 0));
    expect(mockHdrSetAction).toHaveBeenCalledWith(55, undefined);
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

describe('clearAction / clearActionByUniqueKey', () => {
  it('removes both action and ts keys from IDB', async () => {
    idbStore['action:acc1:INBOX:msgid1'] = 'reply';
    idbStore['action:ts:acc1:INBOX:msgid1'] = { ts: 123 };

    const result = await clearActionByUniqueKey('acc1:INBOX:msgid1');
    expect(result).toBe(true);
    expect(idbStore['action:acc1:INBOX:msgid1']).toBeUndefined();
    expect(idbStore['action:ts:acc1:INBOX:msgid1']).toBeUndefined();
  });

  it('is a no-op for no cache entry but still returns true', async () => {
    const result = await clearActionByUniqueKey('acc1:INBOX:nonexistent');
    expect(result).toBe(true);
  });

  it('returns false for empty/null input', async () => {
    expect(await clearActionByUniqueKey(null)).toBe(false);
    expect(await clearActionByUniqueKey('')).toBe(false);
  });

  it('clearAction resolves uniqueKey from header object', async () => {
    mockGetUniqueMessageKey.mockResolvedValue('acc1:INBOX:msgid1');
    idbStore['action:acc1:INBOX:msgid1'] = 'reply';
    idbStore['action:ts:acc1:INBOX:msgid1'] = { ts: 123 };

    const header = { id: 1 };
    const result = await clearAction(header);
    expect(result).toBe(true);
    expect(idbStore['action:acc1:INBOX:msgid1']).toBeUndefined();
  });

  it('clearAction returns false when uniqueKey cannot be resolved', async () => {
    mockGetUniqueMessageKey.mockResolvedValue(null);
    const result = await clearAction({ id: 1 });
    expect(result).toBe(false);
  });
});
