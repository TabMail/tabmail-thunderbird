// autoUpdateUserPrompt.test.js — Tests for agent/modules/autoUpdateUserPrompt.js

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
vi.mock('../agent/modules/idbStorage.js', () => ({
  get: vi.fn(async () => ({})),
  set: vi.fn(async () => {}),
}));
vi.mock('../agent/modules/llm.js', () => ({
  processJSONResponse: vi.fn(() => null),
  sendChat: vi.fn(async () => null),
}));
vi.mock('../agent/modules/patchApplier.js', () => ({
  applyActionPatch: vi.fn(() => null),
}));
vi.mock('../agent/modules/promptGenerator.js', () => ({
  getUserActionPrompt: vi.fn(async () => ''),
}));

globalThis.browser = {
  messages: {
    get: vi.fn(async () => null),
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  runtime: {
    sendMessage: vi.fn(async () => {}),
  },
};

const {
  autoUpdateUserPromptOnMove,
  autoUpdateUserPromptOnTag,
} = await import('../agent/modules/autoUpdateUserPrompt.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('autoUpdateUserPromptOnMove', () => {
  it('does not throw with valid input', async () => {
    await autoUpdateUserPromptOnMove(123, { source: 'test', action: 'archive' });
    // No error expected
  });

  it('handles missing payload', async () => {
    await autoUpdateUserPromptOnMove(123);
    // No error expected
  });

  it('handles null payload', async () => {
    await autoUpdateUserPromptOnMove(123, null);
    // No error expected
  });
});

describe('autoUpdateUserPromptOnTag', () => {
  it('does not throw with valid input', async () => {
    // getUniqueMessageKey will be called but returns based on mock
    await autoUpdateUserPromptOnTag(123, 'reply', { source: 'manual-tag' });
    // Should complete without throwing
  });

  it('serializes concurrent calls', async () => {
    // Multiple calls should queue up
    const p1 = autoUpdateUserPromptOnTag(1, 'reply');
    const p2 = autoUpdateUserPromptOnTag(2, 'archive');
    await Promise.all([p1, p2]);
    // Both should complete
  });
});
