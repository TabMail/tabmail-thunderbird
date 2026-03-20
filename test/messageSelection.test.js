// messageSelection.test.js — Tests for chat/modules/messageSelection.js
//
// Tests message selection experiment integration: listener init/cleanup,
// selection request handling.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis.browser mock
// ---------------------------------------------------------------------------
const selectionListeners = [];

globalThis.browser = {
  messageSelection: {
    init: vi.fn(),
    getSelectedMessages: vi.fn(async () => '[]'),
    onSelectionChanged: {
      addListener: vi.fn((fn) => selectionListeners.push(fn)),
      removeListener: vi.fn((fn) => {
        const idx = selectionListeners.indexOf(fn);
        if (idx >= 0) selectionListeners.splice(idx, 1);
      }),
    },
  },
  runtime: {
    sendMessage: vi.fn(async () => undefined),
  },
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKey: vi.fn(async (idOrMsg, folder) => {
    if (typeof idOrMsg === 'number') return `unique-${idOrMsg}`;
    if (typeof idOrMsg === 'string') return `unique-${idOrMsg}`;
    return null;
  }),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { debugLogging: false },
}));

vi.mock('../agent/modules/folderResolver.js', () => ({
  resolveWeFolderFromXulUri: vi.fn(async (uri) => ({ path: uri })),
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  initMessageSelectionListener,
  cleanupMessageSelectionListener,
  handleMessageSelectionRequest,
  _testExports,
} from '../chat/modules/messageSelection.js';
const { generateUniqueId } = _testExports;

describe('messageSelection', () => {
  beforeEach(() => {
    selectionListeners.length = 0;
    vi.clearAllMocks();
  });

  // --- initMessageSelectionListener ---
  describe('initMessageSelectionListener', () => {
    it('should call messageSelection.init()', async () => {
      await initMessageSelectionListener();
      expect(browser.messageSelection.init).toHaveBeenCalled();
    });

    it('should add a selection change listener', async () => {
      await initMessageSelectionListener();
      expect(browser.messageSelection.onSelectionChanged.addListener).toHaveBeenCalled();
    });

    it('should clean up existing listener before adding new one', async () => {
      // First init
      await initMessageSelectionListener();
      expect(selectionListeners.length).toBe(1);

      // Second init should clean up first
      await initMessageSelectionListener();
      expect(browser.messageSelection.onSelectionChanged.removeListener).toHaveBeenCalled();
    });
  });

  // --- cleanupMessageSelectionListener ---
  describe('cleanupMessageSelectionListener', () => {
    it('should remove listener when one exists', async () => {
      await initMessageSelectionListener();
      cleanupMessageSelectionListener();
      expect(browser.messageSelection.onSelectionChanged.removeListener).toHaveBeenCalled();
    });

    it('should be safe to call when no listener exists', () => {
      // Should not throw
      cleanupMessageSelectionListener();
      expect(browser.messageSelection.onSelectionChanged.removeListener).not.toHaveBeenCalled();
    });
  });

  // --- handleMessageSelectionRequest ---
  describe('handleMessageSelectionRequest', () => {
    it('should return undefined for non-selection messages', () => {
      const result = handleMessageSelectionRequest({ command: 'other' });
      expect(result).toBeUndefined();
    });

    it('should return undefined for null message', () => {
      const result = handleMessageSelectionRequest(null);
      expect(result).toBeUndefined();
    });

    it('should return a promise for get-current-selection command', () => {
      const result = handleMessageSelectionRequest({ command: 'get-current-selection' });
      expect(result).toBeDefined();
      expect(typeof result.then).toBe('function');
    });

    it('should resolve with ok:true for valid selection request', async () => {
      browser.messageSelection.getSelectedMessages.mockResolvedValueOnce('[]');
      const result = await handleMessageSelectionRequest({ command: 'get-current-selection' });
      expect(result).toEqual({ ok: true });
    });

    it('should handle JSON parse errors gracefully', async () => {
      browser.messageSelection.getSelectedMessages.mockResolvedValueOnce('invalid json');
      const result = await handleMessageSelectionRequest({ command: 'get-current-selection' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('parse');
    });

    it('should return ok:false when experiment is not ready', async () => {
      const orig = browser.messageSelection.getSelectedMessages;
      browser.messageSelection.getSelectedMessages = undefined;
      const result = await handleMessageSelectionRequest({ command: 'get-current-selection' });
      expect(result.ok).toBe(false);
      browser.messageSelection.getSelectedMessages = orig;
    });

    it('should forward unique IDs via runtime messaging', async () => {
      browser.messageSelection.getSelectedMessages.mockResolvedValueOnce(
        JSON.stringify([{ weMsgId: 42 }])
      );
      await handleMessageSelectionRequest({ command: 'get-current-selection' });
      expect(browser.runtime.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'current-selection',
          selectionCount: 1,
        })
      );
    });
  });

  // --- generateUniqueId ---
  describe('generateUniqueId', () => {
    it('resolves using weMsgId when available', async () => {
      const result = await generateUniqueId({ weMsgId: 99 });
      expect(result).toBe('unique-99');
    });

    it('falls back to messageId + folderUri when weMsgId is absent', async () => {
      const result = await generateUniqueId({ messageId: 'msg-abc', folderUri: 'imap://folder' });
      expect(result).toBe('unique-msg-abc');
    });

    it('returns null when neither weMsgId nor messageId is available', async () => {
      const result = await generateUniqueId({});
      expect(result).toBeNull();
    });

    it('falls back to messageId when weMsgId lookup returns null', async () => {
      const { getUniqueMessageKey } = await import('../agent/modules/utils.js');
      // First call (weMsgId path) returns null, second call (messageId path) returns a value
      getUniqueMessageKey
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce('fallback-key');
      const result = await generateUniqueId({ weMsgId: 1, messageId: 'msg-x', folderUri: 'uri' });
      expect(result).toBe('fallback-key');
    });

    it('returns null when weMsgId lookup throws and no messageId', async () => {
      const { getUniqueMessageKey } = await import('../agent/modules/utils.js');
      getUniqueMessageKey.mockRejectedValueOnce(new Error('lookup failed'));
      const result = await generateUniqueId({ weMsgId: 1 });
      expect(result).toBeNull();
    });

    it('returns null when both weMsgId and messageId lookups fail', async () => {
      const { getUniqueMessageKey } = await import('../agent/modules/utils.js');
      getUniqueMessageKey
        .mockRejectedValueOnce(new Error('fail1'))
        .mockRejectedValueOnce(new Error('fail2'));
      const result = await generateUniqueId({ weMsgId: 1, messageId: 'msg-y', folderUri: 'u' });
      expect(result).toBeNull();
    });

    it('returns null when messageId is present but folderUri is missing entirely', async () => {
      // folderUri must not be undefined for the fallback path — check the source
      // msg.folderUri !== undefined is the condition
      const result = await generateUniqueId({ messageId: 'msg-z' });
      expect(result).toBeNull();
    });

    it('handles folderUri being empty string (still defined)', async () => {
      const result = await generateUniqueId({ messageId: 'msg-w', folderUri: '' });
      expect(result).toBe('unique-msg-w');
    });
  });
});
