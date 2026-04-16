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
vi.mock('../agent/modules/utils.js', () => ({
  getUniqueMessageKey: vi.fn(async () => 'acct:INBOX:msg-1'),
  getRealSubject: vi.fn(async () => 'test subject'),
  log: vi.fn(),
  saveChatLog: vi.fn(() => {}),
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
const idb = await import('../agent/modules/idbStorage.js');
const llm = await import('../agent/modules/llm.js');
const patchApplier = await import('../agent/modules/patchApplier.js');
const promptGenerator = await import('../agent/modules/promptGenerator.js');

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

  it('skips patch apply when user_action.md drifts during backend call', async () => {
    // Set up cached summary + original action so the flow proceeds past its
    // early-return guards (line 69: summary missing, line 91: orig == current).
    idb.get.mockImplementation(async (key) => {
      if (key.startsWith('summary:')) {
        return { [key]: { blurb: 'b', subject: 's', fromSender: 'f', todos: '' } };
      }
      if (key.startsWith('action:orig:')) return { [key]: 'archive' };
      if (key.startsWith('action:userprompt:')) return { [key]: '' };
      return {};
    });

    // First read = base ("v1"), second read (post-LLM guard) = drifted ("v2").
    let readCount = 0;
    promptGenerator.getUserActionPrompt.mockImplementation(async () => {
      readCount++;
      return readCount === 1 ? 'base v1' : 'drifted v2';
    });

    // Valid backend response → code reaches the guard.
    llm.sendChat.mockResolvedValueOnce({ assistant: '{"patch":"some patch text"}' });
    llm.processJSONResponse.mockReturnValueOnce({ patch: 'some patch text' });

    await autoUpdateUserPromptOnTag(123, 'reply', { source: 'test' });

    // Guard must short-circuit: patch never applied, storage never written.
    expect(patchApplier.applyActionPatch).not.toHaveBeenCalled();
    expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
    // Both reads happened: base capture + post-flight re-read.
    expect(readCount).toBe(2);
  });

  it('applies patch on happy path (no drift)', async () => {
    idb.get.mockImplementation(async (key) => {
      if (key.startsWith('summary:')) {
        return { [key]: { blurb: 'b', subject: 's', fromSender: 'f', todos: '' } };
      }
      if (key.startsWith('action:orig:')) return { [key]: 'archive' };
      if (key.startsWith('action:userprompt:')) return { [key]: '' };
      return {};
    });

    // Both reads return the same base → guard allows apply.
    promptGenerator.getUserActionPrompt.mockResolvedValue('stable base');

    llm.sendChat.mockResolvedValueOnce({ assistant: '{"patch":"some patch text"}' });
    llm.processJSONResponse.mockReturnValueOnce({ patch: 'some patch text' });
    patchApplier.applyActionPatch.mockReturnValueOnce('stable base updated');

    await autoUpdateUserPromptOnTag(123, 'reply', { source: 'test' });

    expect(patchApplier.applyActionPatch).toHaveBeenCalledWith('stable base', 'some patch text');
    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:user_action.md': 'stable base updated',
    });
  });
});
