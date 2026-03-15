// chatWindowUtils.test.js — Tests for chat/modules/chatWindowUtils.js
//
// Tests for isChatWindowOpen, focusChatWindow, openOrFocusChatWindow

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    chatWindow: {
      defaultWidth: 500,
      defaultHeight: 700,
    },
  },
}));

// ---------------------------------------------------------------------------
// globalThis.browser mock
// ---------------------------------------------------------------------------

globalThis.browser = {
  windows: {
    getAll: vi.fn(async () => []),
    update: vi.fn(async () => {}),
    create: vi.fn(async () => ({ id: 99 })),
  },
  runtime: {
    getURL: vi.fn((path) => `moz-extension://fake/${path}`),
  },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { isChatWindowOpen, focusChatWindow, openOrFocusChatWindow } = await import('../chat/modules/chatWindowUtils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isChatWindowOpen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when no windows exist', async () => {
    browser.windows.getAll.mockResolvedValue([]);
    expect(await isChatWindowOpen()).toBe(false);
  });

  it('returns false when windows have no chat tabs', async () => {
    browser.windows.getAll.mockResolvedValue([
      { tabs: [{ url: 'about:blank' }] },
      { tabs: [{ url: 'https://example.com' }] },
    ]);
    expect(await isChatWindowOpen()).toBe(false);
  });

  it('returns true when a window has the chat tab', async () => {
    browser.windows.getAll.mockResolvedValue([
      { tabs: [{ url: 'moz-extension://fake/chat/chat.html' }] },
    ]);
    expect(await isChatWindowOpen()).toBe(true);
  });

  it('returns true when chat tab is among other tabs', async () => {
    browser.windows.getAll.mockResolvedValue([
      {
        tabs: [
          { url: 'about:blank' },
          { url: 'moz-extension://fake/chat/chat.html' },
          { url: 'https://example.com' },
        ],
      },
    ]);
    expect(await isChatWindowOpen()).toBe(true);
  });

  it('returns false when getAll throws', async () => {
    browser.windows.getAll.mockRejectedValue(new Error('API error'));
    expect(await isChatWindowOpen()).toBe(false);
  });

  it('handles windows with null tabs', async () => {
    browser.windows.getAll.mockResolvedValue([
      { tabs: null },
      {},
    ]);
    expect(await isChatWindowOpen()).toBe(false);
  });

  it('handles tabs with null url', async () => {
    browser.windows.getAll.mockResolvedValue([
      { tabs: [{ url: null }, {}] },
    ]);
    expect(await isChatWindowOpen()).toBe(false);
  });
});

describe('focusChatWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns false when no chat window exists', async () => {
    browser.windows.getAll.mockResolvedValue([]);
    expect(await focusChatWindow()).toBe(false);
  });

  it('focuses existing chat window and returns true', async () => {
    browser.windows.getAll.mockResolvedValue([
      { id: 42, tabs: [{ url: 'moz-extension://fake/chat/chat.html' }] },
    ]);
    const result = await focusChatWindow();
    expect(result).toBe(true);
    expect(browser.windows.update).toHaveBeenCalledWith(42, { focused: true });
  });

  it('returns false when no matching window', async () => {
    browser.windows.getAll.mockResolvedValue([
      { id: 1, tabs: [{ url: 'about:blank' }] },
    ]);
    expect(await focusChatWindow()).toBe(false);
  });

  it('returns false when getAll throws', async () => {
    browser.windows.getAll.mockRejectedValue(new Error('err'));
    expect(await focusChatWindow()).toBe(false);
  });
});

describe('openOrFocusChatWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('focuses existing window instead of creating new one', async () => {
    browser.windows.getAll.mockResolvedValue([
      { id: 42, tabs: [{ url: 'moz-extension://fake/chat/chat.html' }] },
    ]);
    await openOrFocusChatWindow();
    expect(browser.windows.update).toHaveBeenCalledWith(42, { focused: true });
    expect(browser.windows.create).not.toHaveBeenCalled();
  });

  it('creates new window when no existing chat window', async () => {
    browser.windows.getAll.mockResolvedValue([]);
    await openOrFocusChatWindow();
    expect(browser.windows.create).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'popup',
        width: 500,
        height: 700,
      })
    );
  });

  it('does not throw when create fails', async () => {
    browser.windows.getAll.mockResolvedValue([]);
    browser.windows.create.mockRejectedValue(new Error('create failed'));
    await expect(openOrFocusChatWindow()).resolves.not.toThrow();
  });
});
