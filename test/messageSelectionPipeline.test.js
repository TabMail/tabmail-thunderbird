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
const expectedFor = (...keys) => ({
  ...expected,
  selectedMessageIds: keys.map(key => `synthetic-account:/Inbox:message-${key}`),
  selectionCount: keys.length,
});
const settle = () => new Promise(resolve => setImmediate(resolve));

it('delivers a usable selected-message identity before sleep, while primed, and after conversion', async () => {
  const w = makeWindow();
  const x = experiment('chat/experiments/messageSelection/messageSelection.sys.mjs', 'messageSelection', { windows: [w.win] });
  x.instance.extension.messageManager.convert = hdr => ({ id: hdr.messageKey });
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
      w.hdr.messageKey = 2;
      w.tree.dispatch('select');
      expect(queued).toHaveLength(1);
      await consumer(queued[0]);
      expect(deliveries).toEqual([expected, expectedFor(2)]);

      primed.convert({ async: value => consumer(value) });
      w.hdr.messageKey = 3;
      w.view.selection.count = 2;
      w.view.selection.getRangeAt = (_range, start, end) => { start.value = 0; end.value = 1; };
      w.view.hdrForRow = row => row === 0 ? w.hdr : {
        ...w.hdr, messageKey: 4, messageId: 'second@synthetic.test',
      };
      w.tree.dispatch('select');
      await settle();
      expect(deliveries).toEqual([expected, expectedFor(2), expectedFor(3, 4)]);

      w.view.selection.count = 0;
      w.tree.dispatch('select');
      await settle();
      expect(deliveries).toEqual([expected, expectedFor(2), expectedFor(3, 4), expectedFor()]);
    } finally {
      primed.unregister();
    }

    w.tree.dispatch('select');
    await settle();
    expect(deliveries).toHaveLength(4);
  } finally {
    x.instance.onShutdown(false);
  }
});
