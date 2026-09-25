import { expect, it, vi } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';
import { experimentFunctions } from './helpers/experimentFunctions.js';
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), getUniqueMessageKey: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../agent/modules/folderResolver.js', () => ({ resolveWeFolderFromXulUri: vi.fn() }));
import { getUniqueMessageKey } from '../agent/modules/utils.js';
import { CHAT_SETTINGS } from '../chat/modules/chatConfig.js';
import { initMessageSelectionListener, cleanupMessageSelectionListener, handleMessageSelectionRequest } from '../chat/modules/messageSelection.js';
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
it('a window-ready snapshot cannot replace the later user selection after ID resolution', async () => {
  const w = makeWindow();
  w.win.document.readyState = 'loading';
  const x = experiment('chat/experiments/messageSelection/messageSelection.sys.mjs', 'messageSelection', { windows: [w.win] });
  x.instance.extension.messageManager.convert = hdr => ({ id: hdr.messageKey });
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  const timeline = [];
  const timers = [];
  getUniqueMessageKey.mockImplementation(async id => {
    timeline.push(`resolve-start:${id}`);
    const result = id === 1 ? await old : `synthetic-account:/Inbox:message-${id}`;
    timeline.push(`resolve-end:${id}`);
    return result;
  });
  const listeners = new Set();
  const ctx = { selectedMessageIds: [] };
  globalThis.browser = {
    messageSelection: x.api,
    runtime: {
      onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage: vi.fn(async message => {
        if (message.command === 'get-current-selection') return handleMessageSelectionRequest(message);
        timeline.push(`deliver:${message.selectedMessageIds.join(',')}`);
        for (const listener of listeners) listener(message);
      }),
    },
  };
  const chat = experimentFunctions(new URL('../chat/chat.js', import.meta.url),
    ['initMessageSelectionTracking', 'updateSelectionFromMessage', 'cleanupMessageSelectionListener'], {
      CHAT_SETTINGS, browser, ctx, currentSelectionCount: 0, messageSelectionListener: null,
      log: vi.fn(), setTimeout: fn => { timers.push(fn); },
    });
  try {
    await initMessageSelectionListener();
    await chat.initMessageSelectionTracking();
    for (let attempt = 0; attempt < 4 && timers.length; attempt++) {
      timers.shift()();
      await settle();
    }
    expect(timers).toHaveLength(0);
    w.win.document.readyState = 'complete';
    w.win.dispatch('load');
    await settle();
    w.hdr.messageKey = 2;
    w.hdr.messageId = 'new-selection@example.test';
    w.tree.dispatch('select');
    await settle();
    expect(ctx.selectedMessageIds).toEqual(['synthetic-account:/Inbox:message-2']);
    finishOld('synthetic-account:/Inbox:message-1');
    await settle();
    expect(timeline).toContain('deliver:synthetic-account:/Inbox:message-2');
    expect(ctx.selectedMessageIds).toEqual(['synthetic-account:/Inbox:message-2']);

    let finishAfterCleanup;
    const pending = new Promise(resolve => { finishAfterCleanup = resolve; });
    getUniqueMessageKey.mockImplementation(async id => id === 3
      ? await pending : `synthetic-account:/Inbox:message-${id}`);
    w.hdr.messageKey = 3;
    w.tree.dispatch('select');
    await settle();
    cleanupMessageSelectionListener();
    finishAfterCleanup('synthetic-account:/Inbox:message-3');
    await settle();
    expect(timeline).not.toContain('deliver:synthetic-account:/Inbox:message-3');
    expect(ctx.selectedMessageIds).toEqual(['synthetic-account:/Inbox:message-2']);
  } finally {
    chat.cleanupMessageSelectionListener();
    cleanupMessageSelectionListener();
    x.instance.onShutdown(false);
    delete globalThis.browser;
  }
});
