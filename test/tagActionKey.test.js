// tagActionKey.test.js — Tests for agent/modules/tagActionKey.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockPerformTaggedAction = vi.fn(async () => {});

vi.mock('../agent/modules/action.js', () => ({
  performTaggedAction: (...args) => mockPerformTaggedAction(...args),
}));

globalThis.browser = {
  keyOverride: {
    onTabPressed: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
    onShiftTabPressed: {
      addListener: vi.fn(),
      removeListener: vi.fn(),
    },
  },
  mailTabs: {
    query: vi.fn(async () => []),
    getSelectedMessages: vi.fn(async () => ({ messages: [] })),
  },
};

const {
  registerTabKeyHandlers,
  cleanupTagActionKeyListeners,
  triggerTagActionKey,
} = await import('../agent/modules/tagActionKey.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('registerTabKeyHandlers', () => {
  it('registers onTabPressed and onShiftTabPressed listeners', () => {
    registerTabKeyHandlers();
    expect(browser.keyOverride.onTabPressed.addListener).toHaveBeenCalled();
    expect(browser.keyOverride.onShiftTabPressed.addListener).toHaveBeenCalled();
  });

  it('handles missing keyOverride API', () => {
    const orig = browser.keyOverride;
    browser.keyOverride = undefined;
    expect(() => registerTabKeyHandlers()).not.toThrow();
    browser.keyOverride = orig;
  });
});

describe('cleanupTagActionKeyListeners', () => {
  it('removes listeners after registration', () => {
    registerTabKeyHandlers();
    cleanupTagActionKeyListeners();
    expect(browser.keyOverride.onTabPressed.removeListener).toHaveBeenCalled();
    expect(browser.keyOverride.onShiftTabPressed.removeListener).toHaveBeenCalled();
  });

  it('handles case when no listeners registered', () => {
    cleanupTagActionKeyListeners();
    // Should not throw
  });
});

describe('triggerTagActionKey', () => {
  it('does nothing when no active tab', async () => {
    browser.mailTabs.query.mockResolvedValue([]);
    await triggerTagActionKey();
    expect(mockPerformTaggedAction).not.toHaveBeenCalled();
  });

  it('does nothing when no selected messages', async () => {
    browser.mailTabs.query.mockResolvedValue([{ id: 1 }]);
    browser.mailTabs.getSelectedMessages.mockResolvedValue({ messages: [] });
    await triggerTagActionKey();
    expect(mockPerformTaggedAction).not.toHaveBeenCalled();
  });

  it('performs tagged action on selected messages', async () => {
    const msg1 = { id: 1, subject: 'Test' };
    const msg2 = { id: 2, subject: 'Test2' };
    browser.mailTabs.query.mockResolvedValue([{ id: 1 }]);
    browser.mailTabs.getSelectedMessages.mockResolvedValue({ messages: [msg1, msg2] });

    await triggerTagActionKey();
    expect(mockPerformTaggedAction).toHaveBeenCalledTimes(2);
    expect(mockPerformTaggedAction).toHaveBeenCalledWith(msg1);
    expect(mockPerformTaggedAction).toHaveBeenCalledWith(msg2);
  });
});
