import { afterEach, expect, it, vi } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKey: vi.fn(async id =>
    typeof id === 'number' ? `synthetic-account:/Inbox:message-${id}` : null),
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugLogging: false } }));
vi.mock('../agent/modules/folderResolver.js', () => ({
  resolveWeFolderFromXulUri: vi.fn(async () => ({ accountId: 'synthetic-account', path: '/Inbox' })),
}));

import { initMessageSelectionListener, cleanupMessageSelectionListener } from '../chat/modules/messageSelection.js';

const originalBrowser = globalThis.browser;
afterEach(() => {
  cleanupMessageSelectionListener();
  if (originalBrowser === undefined) delete globalThis.browser;
  else globalThis.browser = originalBrowser;
});

const expected = {
  command: 'selection-changed',
  selectedMessageIds: ['synthetic-account:/Inbox:message-1'],
  selectionCount: 1,
};
const settle = () => new Promise(resolve => setImmediate(resolve));

it('delivers a usable selected-message identity before sleep, while primed, and after conversion', async () => {
  const w = makeWindow();
  const x = experiment('chat/experiments/messageSelection/messageSelection.sys.mjs', 'messageSelection', { windows: [w.win] });
  const deliveries = [];
  let consumer;
  const addListener = x.api.onSelectionChanged.addListener;
  x.api.onSelectionChanged.addListener = callback => {
    consumer = callback;
    addListener(callback);
  };
  globalThis.browser = {
    messageSelection: x.api,
    runtime: { sendMessage: vi.fn(async message => { deliveries.push(message); }) },
  };

  try {
    await initMessageSelectionListener();
    w.tree.dispatch('select');
    await settle();
    expect(deliveries).toEqual([expected]);

    x.api.onSelectionChanged.close();
    const queued = [];
    const primed = x.instance.primeListener('onSelectionChanged', {
      async: value => queued.push(value),
    }, [], false);
    expect(primed).toBeTruthy();
    try {
      w.tree.dispatch('select');
      expect(queued).toHaveLength(1);
      await consumer(queued[0]);
      expect(deliveries).toEqual([expected, expected]);

      primed.convert({ async: value => consumer(value) });
      w.tree.dispatch('select');
      await settle();
      expect(deliveries).toEqual([expected, expected, expected]);
    } finally {
      primed.unregister();
    }

    w.tree.dispatch('select');
    await settle();
    expect(deliveries).toHaveLength(3);
  } finally {
    x.instance.onShutdown(false);
  }
});
