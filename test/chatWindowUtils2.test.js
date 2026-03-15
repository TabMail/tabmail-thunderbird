// chatWindowUtils2.test.js — Additional tests for chat/modules/chatWindowUtils.js

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
vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    chatWindow: {
      defaultWidth: 600,
      defaultHeight: 800,
    },
  },
}));

globalThis.browser = {
  windows: {
    getAll: vi.fn(async () => []),
    create: vi.fn(async () => ({ id: 1 })),
    update: vi.fn(async () => {}),
  },
  runtime: {
    getURL: vi.fn((p) => `moz-extension://fake/${p}`),
  },
  storage: {
    local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

const {
  isChatWindowOpen,
  focusChatWindow,
  openOrFocusChatWindow,
} = await import('../chat/modules/chatWindowUtils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('isChatWindowOpen', () => {
  it('returns false when no windows', async () => {
    browser.windows.getAll.mockResolvedValue([]);
    expect(await isChatWindowOpen()).toBe(false);
  });

  it('returns true when chat window found', async () => {
    browser.windows.getAll.mockResolvedValue([{
      tabs: [{ url: 'moz-extension://fake/chat/chat.html' }],
    }]);
    expect(await isChatWindowOpen()).toBe(true);
  });

  it('returns false when no chat tab found', async () => {
    browser.windows.getAll.mockResolvedValue([{
      tabs: [{ url: 'moz-extension://fake/other.html' }],
    }]);
    expect(await isChatWindowOpen()).toBe(false);
  });

  it('handles errors gracefully', async () => {
    browser.windows.getAll.mockRejectedValue(new Error('fail'));
    expect(await isChatWindowOpen()).toBe(false);
  });
});

describe('focusChatWindow', () => {
  it('returns false when no chat window exists', async () => {
    browser.windows.getAll.mockResolvedValue([]);
    expect(await focusChatWindow()).toBe(false);
  });

  it('focuses existing chat window and returns true', async () => {
    browser.windows.getAll.mockResolvedValue([{
      id: 42,
      tabs: [{ url: 'moz-extension://fake/chat/chat.html' }],
    }]);
    expect(await focusChatWindow()).toBe(true);
    expect(browser.windows.update).toHaveBeenCalledWith(42, { focused: true });
  });
});

describe('openOrFocusChatWindow', () => {
  it('focuses existing window if present', async () => {
    browser.windows.getAll.mockResolvedValue([{
      id: 1,
      tabs: [{ url: 'moz-extension://fake/chat/chat.html' }],
    }]);
    await openOrFocusChatWindow();
    expect(browser.windows.update).toHaveBeenCalled();
    expect(browser.windows.create).not.toHaveBeenCalled();
  });

  it('creates new window when none exists', async () => {
    browser.windows.getAll.mockResolvedValue([]);
    await openOrFocusChatWindow();
    expect(browser.windows.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'popup',
      width: 600,
      height: 800,
    }));
  });

  it('handles create errors', async () => {
    browser.windows.getAll.mockResolvedValue([]);
    browser.windows.create.mockRejectedValue(new Error('fail'));
    await openOrFocusChatWindow();
    // Should not throw
  });
});
