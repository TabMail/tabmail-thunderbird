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
it('a newer foreground mail tab snapshot stays selected after an old window-ready lookup completes', async () => {
  const w = makeWindow();
  const second = makeWindow();
  second.hdr.messageKey = 2;
  second.hdr.messageId = 'second@example.test';
  w.cw.gDBView = w.view;
  second.cw.gDBView = second.view;
  delete w.win.gDBView;
  const tabmail = w.win.document.getElementById('tabmail');
  tabmail.tabInfo[0].mode = { name: 'mail3PaneTab' };
  const secondTab = { mode: { name: 'mail3PaneTab' }, chromeBrowser: { contentWindow: second.cw } };
  tabmail.tabInfo.push(secondTab);
  tabmail.currentTabInfo = tabmail.tabInfo[0];
  w.win.document.readyState = 'loading';
  const x = experiment('chat/experiments/messageSelection/messageSelection.sys.mjs', 'messageSelection', { windows: [w.win] });
  x.instance.extension.messageManager.convert = hdr => ({ id: hdr.messageKey });
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  const timeline = [];
  getUniqueMessageKey.mockImplementation(async id => {
    timeline.push(`lookup:${id}`);
    return id === 1 ? await old : `synthetic:${id}`;
  });
  const timers = [];
  const listeners = new Set();
  const ctx = { selectedMessageIds: [] };
  const autocompleteState = { matches: [] };
  const mention = experimentFunctions(new URL('../chat/modules/mentionAutocomplete.js', import.meta.url),
    ['updateMatches'], {
      ctx, autocompleteState, emailCache: [], templateCache: [], log: vi.fn(),
      getEmailById: async id => ({ subject: `Synthetic ${id}`, from: 'sender@example.test' }),
    });
  globalThis.browser = {
    messageSelection: x.api,
    runtime: {
      onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage: vi.fn(async message => {
        if (message.command === 'get-current-selection') return handleMessageSelectionRequest(message);
        timeline.push(`deliver:${message.selectedMessageIds.join(',')}`);
        for (const fn of listeners) fn(message);
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
    expect(ctx.selectedMessageIds).toEqual([]);
    expect(timers).toHaveLength(1);
    w.win.document.readyState = 'complete';
    w.win.dispatch('load');
    await settle();
    expect(timeline).toContain('lookup:1');
    tabmail.currentTabInfo = secondTab;
    tabmail.currentAbout3Pane = second.cw;
    w.tabContainer.dispatch('TabSelect');
    expect(JSON.parse(await x.api.getSelectedMessages()).map(msg => msg.weMsgId)).toEqual([2]);
    timers.shift()();
    await settle();
    expect(ctx.selectedMessageIds).toEqual(['synthetic:2']);
    await mention.updateMatches('');
    expect(autocompleteState.matches[0]).toMatchObject({
      type: 'selected', label: 'Synthetic synthetic:2',
      description: 'Selected • From: sender@example.test',
    });
    finishOld('synthetic:1');
    await settle();
    expect(ctx.selectedMessageIds).toEqual(['synthetic:2']);
    await mention.updateMatches('');
    expect(autocompleteState.matches[0].label).toBe('Synthetic synthetic:2');
  } finally {
    chat.cleanupMessageSelectionListener();
    cleanupMessageSelectionListener();
    x.instance.onShutdown(false);
    delete globalThis.browser;
  }
});
