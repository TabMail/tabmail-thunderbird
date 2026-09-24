/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// tagActionKey.test.js — Tests for agent/modules/tagActionKey.js

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

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
  },
  mailTabs: {
    query: vi.fn(async () => []),
    getSelectedMessages: vi.fn(async () => ({ messages: [] })),
  },
  messages: { get: vi.fn(async () => null) },
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
  it('registers the active Tab listener', () => {
    registerTabKeyHandlers();
    expect(browser.keyOverride.onTabPressed.addListener).toHaveBeenCalled();
  });

  it('handles missing keyOverride API', () => {
    const orig = browser.keyOverride;
    browser.keyOverride = undefined;
    expect(() => registerTabKeyHandlers()).not.toThrow();
    browser.keyOverride = orig;
  });

  it('connects only bare native Tab to the press-time message action', async () => {
    const { win, hdr } = makeWindow();
    const x = experiment('theme/experiments/keyOverride/keyOverride.sys.mjs', 'keyOverride', {
      windows: [win], moduleOverrides: { getActualSelectedMessages: () => [hdr] },
    });
    const ordinaryApi = browser.keyOverride;
    try {
      browser.keyOverride = x.api;
      const message = { id: 1, subject: 'Synthetic' };
      browser.messages.get.mockResolvedValue(message);
      registerTabKeyHandlers();
      x.api.init();
      const key = (code, modifiers = {}) => ({
        code, key: code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
        ...modifiers,
        preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
      });
      const tab = key('Tab');
      win.dispatch('keydown', tab);
      await vi.waitFor(() => expect(mockPerformTaggedAction).toHaveBeenCalledExactlyOnceWith(message));
      expect(tab.preventDefault).toHaveBeenCalledTimes(1);
      expect(tab.stopPropagation).toHaveBeenCalledTimes(1);
      expect(tab.stopImmediatePropagation).toHaveBeenCalledTimes(1);
      for (const event of [
        key('KeyA'), key('Enter'), key('KeyL', { altKey: true, metaKey: true }),
        key('Tab', { ctrlKey: true }), key('Tab', { shiftKey: true }),
      ]) {
        const lookups = browser.messages.get.mock.calls.length;
        win.dispatch('keydown', event);
        // A stray notification can start selection/action work asynchronously.
        await new Promise(resolve => setImmediate(resolve));
        expect(event.preventDefault).not.toHaveBeenCalled();
        expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(event.stopImmediatePropagation).not.toHaveBeenCalled();
        expect(browser.messages.get).toHaveBeenCalledTimes(lookups);
        expect(mockPerformTaggedAction).toHaveBeenCalledTimes(1);
      }
      expect(browser.mailTabs.query).not.toHaveBeenCalled();
      expect(browser.mailTabs.getSelectedMessages).not.toHaveBeenCalled();
      expect(mockPerformTaggedAction).toHaveBeenCalledTimes(1);
    } finally {
      cleanupTagActionKeyListeners();
      x.instance.onShutdown(false);
      browser.keyOverride = ordinaryApi;
    }
  });

  it('acts on the press-time ID after selection drifts and fails closed if it disappeared', async () => {
    registerTabKeyHandlers();
    const listener = browser.keyOverride.onTabPressed.addListener.mock.lastCall[0];
    const original = { id: 1, subject: 'Original' };
    const newlySelected = { id: 2, subject: 'New selection' };
    browser.mailTabs.query.mockResolvedValue([{ id: 99 }]);
    browser.mailTabs.getSelectedMessages.mockResolvedValue({ messages: [newlySelected] });
    browser.messages.get.mockImplementation(async id => id === 1 ? original : newlySelected);
    await listener({ messageIds: [1] });
    expect(browser.messages.get).toHaveBeenCalledExactlyOnceWith(1);
    expect(mockPerformTaggedAction).toHaveBeenCalledExactlyOnceWith(original);
    expect(browser.mailTabs.getSelectedMessages).not.toHaveBeenCalled();

    mockPerformTaggedAction.mockClear();
    browser.messages.get.mockRejectedValue(new Error('Message not found'));
    await listener({ messageIds: [1] });
    await listener();
    expect(mockPerformTaggedAction).not.toHaveBeenCalled();
    expect(browser.mailTabs.getSelectedMessages).not.toHaveBeenCalled();
  });

  it('refuses an oversized native payload without fetching or acting on a partial selection', async () => {
    registerTabKeyHandlers();
    const listener = browser.keyOverride.onTabPressed.addListener.mock.lastCall[0];
    await listener({ messageIds: Array.from({ length: 101 }, (_, index) => index + 1) });
    expect(browser.messages.get).not.toHaveBeenCalled();
    expect(mockPerformTaggedAction).not.toHaveBeenCalled();
  });
});

describe('cleanupTagActionKeyListeners', () => {
  it('removes listeners after registration', () => {
    registerTabKeyHandlers();
    cleanupTagActionKeyListeners();
    expect(browser.keyOverride.onTabPressed.removeListener).toHaveBeenCalled();
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
