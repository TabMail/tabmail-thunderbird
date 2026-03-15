// idTranslator.test.js — Tests for chat/modules/idTranslator.js

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
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../chat/modules/persistentChatStore.js', () => ({
  loadIdMap: vi.fn(async () => ({ entries: [], nextNumericId: 1, freeIds: [], refCounts: [] })),
  saveIdMap: vi.fn(),
  saveIdMapImmediate: vi.fn(async () => {}),
}));

// Provide a context mock with idTranslation
const mockIdTranslation = {
  idMap: new Map(),
  nextNumericId: 1,
  lastAccessed: 0,
  freeIds: [],
  refCounts: new Map(),
};

vi.mock('../chat/modules/context.js', () => ({
  ctx: {
    idTranslation: {
      idMap: new Map(),
      nextNumericId: 1,
      lastAccessed: 0,
      freeIds: [],
      refCounts: new Map(),
    },
  },
}));

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const { createIsolatedContext, toNumericId, toRealId } = await import('../chat/modules/idTranslator.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createIsolatedContext', () => {
  it('creates a new isolated context', () => {
    const ctx = createIsolatedContext();
    expect(ctx.idMap).toBeInstanceOf(Map);
    expect(ctx.nextNumericId).toBe(1);
    expect(ctx.freeIds).toEqual([]);
    expect(ctx.lastAccessed).toBeGreaterThan(0);
  });

  it('creates independent contexts', () => {
    const ctx1 = createIsolatedContext();
    const ctx2 = createIsolatedContext();
    expect(ctx1.idMap).not.toBe(ctx2.idMap);
  });
});

describe('toNumericId', () => {
  it('returns null for invalid input', () => {
    expect(toNumericId(null)).toBe(null);
    expect(toNumericId(undefined)).toBe(null);
    expect(toNumericId(123)).toBe(null);
  });

  it('assigns numeric IDs to real IDs in isolated context', () => {
    const ctx = createIsolatedContext();
    const id = toNumericId('real-id-123', ctx);
    expect(typeof id).toBe('number');
    expect(id).toBeGreaterThan(0);
  });

  it('returns same numeric ID for same real ID', () => {
    const ctx = createIsolatedContext();
    const id1 = toNumericId('real-id-123', ctx);
    const id2 = toNumericId('real-id-123', ctx);
    expect(id1).toBe(id2);
  });

  it('assigns different numeric IDs to different real IDs', () => {
    const ctx = createIsolatedContext();
    const id1 = toNumericId('real-id-1', ctx);
    const id2 = toNumericId('real-id-2', ctx);
    expect(id1).not.toBe(id2);
  });
});

describe('toRealId', () => {
  it('returns null for invalid input', () => {
    expect(toRealId(null)).toBe(null);
    expect(toRealId('not-a-number')).toBe(null);
  });

  it('resolves numeric ID back to real ID', () => {
    const ctx = createIsolatedContext();
    const numericId = toNumericId('real-id-abc', ctx);
    const realId = toRealId(numericId, ctx);
    expect(realId).toBe('real-id-abc');
  });

  it('returns null for unknown numeric ID', () => {
    const ctx = createIsolatedContext();
    expect(toRealId(999, ctx)).toBe(null);
  });
});
