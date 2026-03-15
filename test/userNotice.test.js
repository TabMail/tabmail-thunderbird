// userNotice.test.js — Tests for agent/modules/userNotice.js

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
    userNotice: {
      cannotTagSelf: { width: 420, height: 240 },
    },
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

globalThis.browser = {
  runtime: {
    getURL: vi.fn((path) => `moz-extension://fake/${path}`),
  },
  windows: {
    create: vi.fn(async (opts) => ({ id: 99 })),
    get: vi.fn(async () => ({})),
    update: vi.fn(async () => {}),
  },
  notifications: {
    create: vi.fn(async () => {}),
  },
};

const { notifyCannotTagSelf } = await import('../agent/modules/userNotice.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('notifyCannotTagSelf', () => {
  it('creates a popup window', async () => {
    await notifyCannotTagSelf({ count: 1 });
    expect(browser.windows.create).toHaveBeenCalled();
    const call = browser.windows.create.mock.calls[0][0];
    expect(call.type).toBe('popup');
    expect(call.width).toBe(420);
    expect(call.height).toBe(240);
  });

  it('creates a notification with correct message for single message', async () => {
    await notifyCannotTagSelf({ count: 1 });
    expect(browser.notifications.create).toHaveBeenCalled();
    const call = browser.notifications.create.mock.calls[0];
    expect(call[1].message).toContain('This message is from you');
  });

  it('creates a notification with correct message for multiple messages', async () => {
    await notifyCannotTagSelf({ count: 3 });
    expect(browser.notifications.create).toHaveBeenCalled();
    const call = browser.notifications.create.mock.calls[0];
    expect(call[1].message).toContain('These 3 messages are from you');
  });

  it('uses default count of 1', async () => {
    await notifyCannotTagSelf();
    expect(browser.notifications.create).toHaveBeenCalled();
    const call = browser.notifications.create.mock.calls[0];
    expect(call[1].message).toContain('This message is from you');
  });

  it('notification uses basic type', async () => {
    await notifyCannotTagSelf({ count: 1 });
    const call = browser.notifications.create.mock.calls[0];
    expect(call[1].type).toBe('basic');
    expect(call[1].title).toBe('TabMail');
  });

  it('generates unique notification IDs', async () => {
    await notifyCannotTagSelf({ count: 1 });
    await notifyCannotTagSelf({ count: 1 });
    const id1 = browser.notifications.create.mock.calls[0][0];
    const id2 = browser.notifications.create.mock.calls[1][0];
    expect(id1).not.toBe(id2);
    expect(id1).toContain('tabmail:cannot-tag-self');
  });

  it('reuses window if already open', async () => {
    // First call creates window (or reuses from prior test state)
    await notifyCannotTagSelf({ count: 1 });

    // Second call should try to get existing window and focus it
    vi.clearAllMocks();
    await notifyCannotTagSelf({ count: 1 });
    // Since window 99 was cached from first call, second call should try to focus it
    expect(browser.windows.get).toHaveBeenCalledWith(99);
    expect(browser.windows.update).toHaveBeenCalledWith(99, { focused: true });
    // Should NOT create a new window
    expect(browser.windows.create).not.toHaveBeenCalled();
  });
});
