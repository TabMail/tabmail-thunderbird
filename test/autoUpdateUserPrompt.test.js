/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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

  // -------------------------------------------------------------------------
  // (a) systemMsg includes action_compact_threshold
  // -------------------------------------------------------------------------

  it('(a) systemMsg includes default action_compact_threshold=100 when no config in storage', async () => {
    idb.get.mockImplementation(async (key) => {
      if (key.startsWith('summary:')) {
        return { [key]: { blurb: 'b', subject: 's', fromSender: 'user@example.com', todos: '' } };
      }
      if (key.startsWith('action:orig:')) return { [key]: 'archive' };
      if (key.startsWith('action:userprompt:')) return { [key]: '' };
      return {};
    });
    // Storage returns empty (no action_config key) → default threshold 100
    globalThis.browser.storage.local.get.mockResolvedValue({});
    promptGenerator.getUserActionPrompt.mockResolvedValue('# My action rules');
    llm.sendChat.mockResolvedValueOnce({ assistant: '{"patch":"ADD\nreply\nSome rule"}' });
    llm.processJSONResponse.mockReturnValueOnce({ patch: 'ADD\nreply\nSome rule' });
    patchApplier.applyActionPatch.mockReturnValueOnce('# My action rules updated');

    await autoUpdateUserPromptOnTag(200, 'reply', { source: 'test' });

    expect(llm.sendChat).toHaveBeenCalledTimes(1);
    const callArgs = llm.sendChat.mock.calls[0][0];
    expect(Array.isArray(callArgs)).toBe(true);
    const sysMsg = callArgs[0];
    expect(sysMsg.action_compact_threshold).toBe(100);
  });

  it('(a) systemMsg includes custom action_compact_threshold when storage has action_config', async () => {
    idb.get.mockImplementation(async (key) => {
      if (key.startsWith('summary:')) {
        return { [key]: { blurb: 'b', subject: 's', fromSender: 'user@example.com', todos: '' } };
      }
      if (key.startsWith('action:orig:')) return { [key]: 'archive' };
      if (key.startsWith('action:userprompt:')) return { [key]: '' };
      return {};
    });
    // Storage returns custom threshold 250
    globalThis.browser.storage.local.get.mockImplementation(async (key) => {
      if (key === 'user_prompts:action_config') {
        return { 'user_prompts:action_config': { compact_threshold: 250 } };
      }
      return {};
    });
    promptGenerator.getUserActionPrompt.mockResolvedValue('# My action rules');
    llm.sendChat.mockResolvedValueOnce({ assistant: '{"patch":"ADD\nreply\nSome rule"}' });
    llm.processJSONResponse.mockReturnValueOnce({ patch: 'ADD\nreply\nSome rule' });
    patchApplier.applyActionPatch.mockReturnValueOnce('# My action rules updated');

    await autoUpdateUserPromptOnTag(201, 'reply', { source: 'test' });

    expect(llm.sendChat).toHaveBeenCalledTimes(1);
    const callArgs = llm.sendChat.mock.calls[0][0];
    const sysMsg = callArgs[0];
    expect(sysMsg.action_compact_threshold).toBe(250);
  });

  // -------------------------------------------------------------------------
  // (b) Multi-op combined patch applies fully (2 DELs + 2 ADDs)
  // -------------------------------------------------------------------------

  it('(b) multi-op patch with 2 DELs + 2 ADDs applied in full order', async () => {
    idb.get.mockImplementation(async (key) => {
      if (key.startsWith('summary:')) {
        return { [key]: { blurb: 'b', subject: 's', fromSender: 'user@example.com', todos: '' } };
      }
      if (key.startsWith('action:orig:')) return { [key]: 'archive' };
      if (key.startsWith('action:userprompt:')) return { [key]: '' };
      return {};
    });
    globalThis.browser.storage.local.get.mockResolvedValue({});
    promptGenerator.getUserActionPrompt.mockResolvedValue('# base content');

    // Simulate server compaction+refine: 2 DELs of old rules, 2 ADDs of new rules
    const multiOpPatch = 'DEL\ndelete\nOld spam rule\nDEL\narchive\nOld newsletter rule\nADD\ndelete\nNew spam rule v2\nADD\narchive\nNew newsletter rule v2';
    llm.sendChat.mockResolvedValueOnce({ assistant: `{"patch":${JSON.stringify(multiOpPatch)}}` });
    llm.processJSONResponse.mockReturnValueOnce({ patch: multiOpPatch });

    // Real patchApplier is mocked — simulate each op being applied in sequence,
    // returning different content at each step. We verify it's called once (the
    // autoUpdateUserPrompt module delegates the entire patch to applyActionPatch).
    patchApplier.applyActionPatch.mockReturnValueOnce('# fully updated content after all 4 ops');

    await autoUpdateUserPromptOnTag(300, 'reply', { source: 'test' });

    // applyActionPatch called once with the full multi-op patch text
    expect(patchApplier.applyActionPatch).toHaveBeenCalledTimes(1);
    expect(patchApplier.applyActionPatch).toHaveBeenCalledWith('# base content', multiOpPatch);
    // Result persisted
    expect(globalThis.browser.storage.local.set).toHaveBeenCalledWith({
      'user_prompts:user_action.md': '# fully updated content after all 4 ops',
    });
  });

  // -------------------------------------------------------------------------
  // (c) Malformed assistant response (prose, not JSON) → no write, no throw
  // -------------------------------------------------------------------------

  it('(c) malformed assistant response (prose) → no write to storage, no throw', async () => {
    idb.get.mockImplementation(async (key) => {
      if (key.startsWith('summary:')) {
        return { [key]: { blurb: 'b', subject: 's', fromSender: 'user@example.com', todos: '' } };
      }
      if (key.startsWith('action:orig:')) return { [key]: 'archive' };
      if (key.startsWith('action:userprompt:')) return { [key]: '' };
      return {};
    });
    globalThis.browser.storage.local.get.mockResolvedValue({});
    promptGenerator.getUserActionPrompt.mockResolvedValue('# base content');

    // Backend returns prose instead of JSON
    llm.sendChat.mockResolvedValueOnce({ assistant: 'I think you should archive emails from newsletters.' });
    // processJSONResponse returns null for non-JSON input
    llm.processJSONResponse.mockReturnValueOnce(null);

    await expect(autoUpdateUserPromptOnTag(400, 'reply', { source: 'test' })).resolves.not.toThrow();

    expect(patchApplier.applyActionPatch).not.toHaveBeenCalled();
    expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (d) Empty patch → no write, no throw
  // -------------------------------------------------------------------------

  it('(d) empty patch {"patch":""} → no write to storage, no throw', async () => {
    idb.get.mockImplementation(async (key) => {
      if (key.startsWith('summary:')) {
        return { [key]: { blurb: 'b', subject: 's', fromSender: 'user@example.com', todos: '' } };
      }
      if (key.startsWith('action:orig:')) return { [key]: 'archive' };
      if (key.startsWith('action:userprompt:')) return { [key]: '' };
      return {};
    });
    globalThis.browser.storage.local.get.mockResolvedValue({});
    promptGenerator.getUserActionPrompt.mockResolvedValue('# base content');

    // Backend returns a well-formed JSON but with an empty patch string
    llm.sendChat.mockResolvedValueOnce({ assistant: '{"patch":""}' });
    llm.processJSONResponse.mockReturnValueOnce({ patch: '' });

    await expect(autoUpdateUserPromptOnTag(500, 'reply', { source: 'test' })).resolves.not.toThrow();

    // patchText.trim() is "" → early return before applyActionPatch
    expect(patchApplier.applyActionPatch).not.toHaveBeenCalled();
    expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // (e) Patch with a DEL that matches nothing → no partial write
  //
  // The server dry-runs ops before sending, so in practice a DEL for a
  // non-existent rule should not reach the client. This test pins the
  // client-side failure mode: applyActionPatch returns null → the whole patch
  // is aborted and storage is NOT written (no partial state).
  // -------------------------------------------------------------------------

  it('(e) patch whose DEL matches nothing → applyActionPatch returns null → no partial write', async () => {
    idb.get.mockImplementation(async (key) => {
      if (key.startsWith('summary:')) {
        return { [key]: { blurb: 'b', subject: 's', fromSender: 'user@example.com', todos: '' } };
      }
      if (key.startsWith('action:orig:')) return { [key]: 'archive' };
      if (key.startsWith('action:userprompt:')) return { [key]: '' };
      return {};
    });
    globalThis.browser.storage.local.get.mockResolvedValue({});
    promptGenerator.getUserActionPrompt.mockResolvedValue('# base content');

    const badPatch = 'DEL\ndelete\nRule that does not exist locally';
    llm.sendChat.mockResolvedValueOnce({ assistant: `{"patch":${JSON.stringify(badPatch)}}` });
    llm.processJSONResponse.mockReturnValueOnce({ patch: badPatch });
    // Simulate strict client applier: DEL for non-existent rule → null (whole patch fails)
    patchApplier.applyActionPatch.mockReturnValueOnce(null);

    await expect(autoUpdateUserPromptOnTag(600, 'reply', { source: 'test' })).resolves.not.toThrow();

    // applyActionPatch was called (patch text was valid JSON with non-empty patch)
    expect(patchApplier.applyActionPatch).toHaveBeenCalledTimes(1);
    // But storage.local.set was NOT called — no partial write
    expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
  });
});
