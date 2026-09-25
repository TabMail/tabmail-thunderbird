import { afterEach, expect, it, vi } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';
import { experimentFunctions } from './helpers/experimentFunctions.js';
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), getUniqueMessageKey: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../agent/modules/folderResolver.js', () => ({ resolveWeFolderFromXulUri: vi.fn() }));
import { getUniqueMessageKey } from '../agent/modules/utils.js';
import { CHAT_SETTINGS } from '../chat/modules/chatConfig.js';
import { initMessageSelectionListener, cleanupMessageSelectionListener, handleMessageSelectionRequest } from '../chat/modules/messageSelection.js';

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
afterEach(() => { cleanupMessageSelectionListener(); delete globalThis.browser; });
function harness() {
  const w = makeWindow();
  const x = experiment('chat/experiments/messageSelection/messageSelection.sys.mjs', 'messageSelection', { windows: [w.win] });
  x.instance.extension.messageManager.convert = hdr => ({ id: hdr.messageKey });
  const listeners = new Set(), deliveries = [];
  const ctx = { selectedMessageIds: ['synthetic:initial-state'] };
  globalThis.browser = {
    messageSelection: x.api,
    runtime: {
      onMessage: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
      sendMessage: vi.fn(async message => {
        if (message.command === 'get-current-selection') return handleMessageSelectionRequest(message);
        deliveries.push([...message.selectedMessageIds]);
        for (const listener of listeners) listener(message);
      }),
    },
  };
  const chat = experimentFunctions(new URL('../chat/chat.js', import.meta.url),
    ['initMessageSelectionTracking', 'updateSelectionFromMessage', 'cleanupMessageSelectionListener'], {
      CHAT_SETTINGS, browser, ctx, currentSelectionCount: 0, messageSelectionListener: null,
      log: vi.fn(), setTimeout,
    });
  const autocompleteState = { matches: [] };
  const mention = experimentFunctions(new URL('../chat/modules/mentionAutocomplete.js', import.meta.url),
    ['updateMatches'], {
      ctx, autocompleteState, emailCache: [], templateCache: [], log: vi.fn(),
      getEmailById: async id => ({ subject: id, from: 'sender@example.test' }),
    });
  const select = async id => {
    w.view.selection.count = id === null ? 0 : 1;
    if (id !== null) { w.hdr.messageKey = id; w.hdr.messageId = 'synthetic-' + id + '@example.test'; }
    w.tree.dispatch('select');
    await settle();
  };
  const selectedMatches = async () => {
    await mention.updateMatches('');
    return autocompleteState.matches.filter(x => x.type === 'selected').map(x => x.label);
  };
  return { w, x, ctx, chat, deliveries, select, selectedMatches,
    close() { chat.cleanupMessageSelectionListener(); cleanupMessageSelectionListener(); x.instance.onShutdown(false); } };
}

it('native deselection remains authoritative after an older native identity lookup completes', async () => {
  const h = harness();
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  getUniqueMessageKey.mockImplementation(async id => id === 2 ? old : 'synthetic:' + id);
  try {
    await initMessageSelectionListener();
    await h.chat.initMessageSelectionTracking();
    expect(h.ctx.selectedMessageIds).toEqual(['synthetic:1']);
    expect(await h.selectedMatches()).toEqual(['synthetic:1']);
    await h.select(2);
    expect(getUniqueMessageKey).toHaveBeenCalledWith(2);
    expect(h.ctx.selectedMessageIds).toEqual(['synthetic:1']);
    await h.select(null);
    expect(h.deliveries.at(-1)).toEqual([]);
    expect(h.ctx.selectedMessageIds).toEqual([]);
    expect(await h.selectedMatches()).toEqual([]);
    finishOld('synthetic:2');
    await settle();
    expect(h.ctx.selectedMessageIds).toEqual([]);
    expect(h.deliveries).not.toContainEqual(['synthetic:2']);
    expect(await h.selectedMatches()).toEqual([]);
    await h.select(3);
    expect(h.ctx.selectedMessageIds).toEqual(['synthetic:3']);
    expect(await h.selectedMatches()).toEqual(['synthetic:3']);
  } finally { finishOld('synthetic:2'); h.close(); }
});

it('native deselection remains authoritative after an older startup reply completes', async () => {
  const h = harness();
  let finishOld;
  const old = new Promise(resolve => { finishOld = resolve; });
  getUniqueMessageKey.mockImplementation(async id => id === 1 ? old : 'synthetic:' + id);
  try {
    await initMessageSelectionListener();
    const startup = h.chat.initMessageSelectionTracking();
    await settle();
    expect(getUniqueMessageKey).toHaveBeenCalledWith(1);
    expect(h.ctx.selectedMessageIds).toEqual(['synthetic:initial-state']);
    await h.select(null);
    expect(h.ctx.selectedMessageIds).toEqual([]);
    expect(h.deliveries).toEqual([[]]);
    expect(await h.selectedMatches()).toEqual([]);
    finishOld('synthetic:1');
    await startup;
    expect(h.ctx.selectedMessageIds).toEqual([]);
    expect(await h.selectedMatches()).toEqual([]);
    await h.select(3);
    expect(h.ctx.selectedMessageIds).toEqual(['synthetic:3']);
    expect(await h.selectedMatches()).toEqual(['synthetic:3']);
  } finally { finishOld('synthetic:1'); h.close(); }
});
