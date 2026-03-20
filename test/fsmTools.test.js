// fsmTools.test.js — Tests for FSM-based email tools
//
// Tests email_delete, email_archive:
// - run() returns FSM markers
// - completeExecution() returns correct results based on state

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks
// ---------------------------------------------------------------------------
const storageData = {};

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keysOrDefault) => {
        if (typeof keysOrDefault === 'string') {
          return { [keysOrDefault]: storageData[keysOrDefault] ?? undefined };
        }
        const result = {};
        for (const [k, def] of Object.entries(keysOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        for (const [k, v] of Object.entries(obj)) storageData[k] = v;
      }),
    },
  },
  runtime: {
    sendMessage: vi.fn(async () => undefined),
  },
  messages: {
    get: vi.fn(async (id) => {
      if (id === 42) return { subject: 'Test Subject', author: 'alice@example.com' };
      return null;
    }),
    getFull: vi.fn(async () => ({ parts: [] })),
  },
};

globalThis.requestAnimationFrame = vi.fn((fn) => setTimeout(fn, 0));

// ---------------------------------------------------------------------------
// Module mocks — no top-level variable references in factories (hoisting)
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  parseUniqueId: vi.fn((uid) => ({ weFolder: null, headerID: uid })),
  headerIDToWeID: vi.fn(async (hid) => {
    if (hid === 'valid-header') return 42;
    return null;
  }),
  getUniqueMessageKey: vi.fn(async () => 'unique-key'),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugLogging: false },
}));

vi.mock('../chat/chat.js', () => ({
  createNewAgentBubble: vi.fn(async (text) => ({
    textContent: text || '',
    classList: { add: vi.fn(), remove: vi.fn() },
  })),
}));

vi.mock('../chat/modules/context.js', () => {
  const ctx = {
    activePid: 0,
    awaitingPid: 0,
    activeToolCallId: null,
    fsmSessions: Object.create(null),
    fsmWaiters: Object.create(null),
    state: null,
    toolExecutionMode: null,
    rawUserTexts: ['user request'],
    composeDraft: {},
    selectedRecipientList: [],
  };
  return {
    ctx,
    initFsmSession: vi.fn((pid, tool) => {
      ctx.fsmSessions[pid] = ctx.fsmSessions[pid] || {};
      ctx.fsmSessions[pid].toolName = tool;
    }),
  };
});

vi.mock('../chat/modules/helpers.js', () => ({
  streamText: vi.fn(),
  toNaiveIso: vi.fn((v) => String(v)),
  initialiseEmailCompose: vi.fn(),
}));

vi.mock('../chat/fsm/core.js', () => ({
  executeAgentAction: vi.fn(async () => {}),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import { run as deleteRun, completeExecution as deleteComplete, _testExports as deleteTestExports } from '../chat/tools/email_delete.js';
import { run as archiveRun, completeExecution as archiveComplete, _testExports as archiveTestExports } from '../chat/tools/email_archive.js';
const { normalizeArgs: deleteNormalizeArgs } = deleteTestExports;
const { normalizeArgs: archiveNormalizeArgs } = archiveTestExports;

describe('email_delete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('run', () => {
    it('should return FSM marker with tool name', async () => {
      const result = await deleteRun({}, { callId: 'pid-d1' });
      expect(result).toEqual(expect.objectContaining({
        fsm: true,
        tool: 'email_delete',
        pid: 'pid-d1',
      }));
    });

    it('should include startedAt timestamp', async () => {
      const before = Date.now();
      const result = await deleteRun({}, { callId: 'pid-d2' });
      expect(result.startedAt).toBeGreaterThanOrEqual(before);
    });

    it('should handle confirm flag in args', async () => {
      const result = await deleteRun({ confirm: true }, { callId: 'pid-d3' });
      expect(result.fsm).toBe(true);
    });

    it('should handle string callId', async () => {
      const result = await deleteRun({}, { callId: 'string-pid' });
      expect(result.pid).toBe('string-pid');
    });

    it('should handle missing callId', async () => {
      const result = await deleteRun({}, {});
      expect(result.pid).toBeNull();
    });
  });

  describe('completeExecution', () => {
    it('should return success when prevState is email_delete_execute', async () => {
      const result = await deleteComplete('done', 'email_delete_execute');
      expect(result).toContain('deleted');
    });

    it('should return generic completion otherwise', async () => {
      const result = await deleteComplete('done', 'other_state');
      expect(result).toContain('completed');
    });
  });
});

describe('email_archive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('run', () => {
    it('should return FSM marker with tool name', async () => {
      const result = await archiveRun({}, { callId: 'pid-a1' });
      expect(result).toEqual(expect.objectContaining({
        fsm: true,
        tool: 'email_archive',
        pid: 'pid-a1',
      }));
    });

    it('should include startedAt timestamp', async () => {
      const before = Date.now();
      const result = await archiveRun({}, { callId: 'pid-a1b' });
      expect(result.startedAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe('completeExecution', () => {
    it('should return success when prevState is email_archive_execute', async () => {
      const result = await archiveComplete('done', 'email_archive_execute');
      expect(result).toContain('archived');
    });

    it('should return generic completion for other states', async () => {
      const result = await archiveComplete('done', 'other');
      expect(result).toContain('completed');
    });
  });
});

// ---------------------------------------------------------------------------
// email_delete normalizeArgs
// ---------------------------------------------------------------------------
describe('email_delete normalizeArgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default confirm=false for empty args', async () => {
    const result = await deleteNormalizeArgs();
    expect(result).toEqual({ confirm: false });
  });

  it('returns default confirm=false for null args', async () => {
    const result = await deleteNormalizeArgs(null);
    expect(result).toEqual({ confirm: false });
  });

  it('passes through confirm=true', async () => {
    const result = await deleteNormalizeArgs({ confirm: true });
    expect(result.confirm).toBe(true);
  });

  it('defaults confirm to false for non-boolean confirm', async () => {
    const result = await deleteNormalizeArgs({ confirm: 'yes' });
    expect(result.confirm).toBe(false);
  });

  it('resolves valid unique_ids to internal_ids', async () => {
    const result = await deleteNormalizeArgs({ unique_ids: ['valid-header'] });
    expect(result.internal_ids).toEqual([42]);
  });

  it('skips non-string unique_ids entries', async () => {
    const result = await deleteNormalizeArgs({ unique_ids: [123, null, undefined] });
    expect(result.internal_ids).toBeUndefined();
    expect(result.confirm).toBe(false);
  });

  it('skips unique_ids that fail to resolve', async () => {
    const result = await deleteNormalizeArgs({ unique_ids: ['unknown-header'] });
    // headerIDToWeID returns null for unknown headers
    expect(result.internal_ids).toBeUndefined();
  });

  it('handles mixed valid and invalid unique_ids', async () => {
    const result = await deleteNormalizeArgs({
      unique_ids: ['valid-header', 'unknown-header', null],
    });
    expect(result.internal_ids).toEqual([42]);
  });

  it('does not set internal_ids when unique_ids is not an array', async () => {
    const result = await deleteNormalizeArgs({ unique_ids: 'not-an-array' });
    expect(result.internal_ids).toBeUndefined();
  });

  it('handles empty unique_ids array', async () => {
    const result = await deleteNormalizeArgs({ unique_ids: [] });
    expect(result.internal_ids).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// email_archive normalizeArgs
// ---------------------------------------------------------------------------
describe('email_archive normalizeArgs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default confirm=false for empty args', async () => {
    const result = await archiveNormalizeArgs();
    expect(result).toEqual({ confirm: false });
  });

  it('returns default confirm=false for null args', async () => {
    const result = await archiveNormalizeArgs(null);
    expect(result).toEqual({ confirm: false });
  });

  it('passes through confirm=true', async () => {
    const result = await archiveNormalizeArgs({ confirm: true });
    expect(result.confirm).toBe(true);
  });

  it('defaults confirm to false for non-boolean confirm', async () => {
    const result = await archiveNormalizeArgs({ confirm: 'yes' });
    expect(result.confirm).toBe(false);
  });

  it('resolves valid unique_ids to internal_ids', async () => {
    const result = await archiveNormalizeArgs({ unique_ids: ['valid-header'] });
    expect(result.internal_ids).toEqual([42]);
  });

  it('skips non-string unique_ids entries', async () => {
    const result = await archiveNormalizeArgs({ unique_ids: [123, null, undefined] });
    expect(result.internal_ids).toBeUndefined();
    expect(result.confirm).toBe(false);
  });

  it('skips unique_ids that fail to resolve', async () => {
    const result = await archiveNormalizeArgs({ unique_ids: ['unknown-header'] });
    expect(result.internal_ids).toBeUndefined();
  });

  it('handles mixed valid and invalid unique_ids', async () => {
    const result = await archiveNormalizeArgs({
      unique_ids: ['valid-header', 'unknown-header', null],
    });
    expect(result.internal_ids).toEqual([42]);
  });

  it('does not set internal_ids when unique_ids is not an array', async () => {
    const result = await archiveNormalizeArgs({ unique_ids: 'not-an-array' });
    expect(result.internal_ids).toBeUndefined();
  });

  it('handles empty unique_ids array', async () => {
    const result = await archiveNormalizeArgs({ unique_ids: [] });
    expect(result.internal_ids).toBeUndefined();
  });
});
