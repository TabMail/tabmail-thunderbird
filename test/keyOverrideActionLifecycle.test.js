import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { experiment, makeWindow } from './helpers/nativeLifecycleHarness.js';
vi.mock('../agent/modules/actionCache.js', () => ({
  ACTIONS: { DELETE: 'delete', ARCHIVE: 'archive', REPLY: 'reply' },
  getActionForWeId: async () => 'archive',
}));
vi.mock('../agent/modules/composeTracker.js', () => ({ trackComposeWindow() {} }));
vi.mock('../agent/modules/utils.js', () => ({
  getArchiveFolderForHeader: async () => ({ id: 'archive', path: '/Archive' }),
  getTrashFolderForHeader: async () => ({ id: 'trash', path: '/Trash' }),
  getIdentityForMessage: async () => ({}), getUniqueMessageKey: async () => 'synthetic@example.test',
  log() {},
}));
import { registerTabKeyHandlers, cleanupTagActionKeyListeners } from '../agent/modules/tagActionKey.js';
let x, win, rows, effects;
const settled = () => new Promise(resolve => setImmediate(resolve));
const key = (code = 'Tab', modifiers = {}) => ({
  code, key: code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...modifiers,
  preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
});
const fresh = () => ({ id: 1, read: false, folder: { id: 'inbox', accountId: 'synthetic' } });
beforeEach(() => {
  win = makeWindow().win;
  rows = new Map([[1, fresh()], [2, { ...fresh(), id: 2 }]]); effects = [];
  x = experiment('theme/experiments/keyOverride/keyOverride.sys.mjs', 'keyOverride', { windows: [win] });
  globalThis.browser = {
    keyOverride: x.api,
    mailTabs: {
      query: vi.fn(async () => [{ id: 7 }]),
      getSelectedMessages: vi.fn(async () => ({ messages: [{ id: 1 }] })),
    },
    messages: {
      get: vi.fn(async id => structuredClone(rows.get(id))),
      update: vi.fn(async (id, update) => { Object.assign(rows.get(id), update); effects.push(['read', id]); }),
      move: vi.fn(async (ids, destination) => { for (const id of ids) { rows.get(id).folder.id = destination; effects.push(['move', id, destination]); } }),
    },
  };
  registerTabKeyHandlers(); x.api.init();
});
afterEach(() => { cleanupTagActionKeyListeners(); x.instance.onShutdown(false); });
for (let bits = 0; bits < 16; bits++) {
  it(`bare Tab action vs modifier combination ${bits}`, async () => {
    const modifiers = Object.fromEntries(['shiftKey', 'ctrlKey', 'altKey', 'metaKey'].map((name, index) => [name, !!(bits & (1 << index))]));
    const event = key('Tab', modifiers); win.dispatch('keydown', event); await settled();
    expect(rows.get(2)).toEqual({ ...fresh(), id: 2 });
    if (bits === 0) {
      expect(effects).toEqual([['read', 1], ['move', 1, 'archive']]);
      expect(rows.get(1)).toEqual({ ...fresh(), read: true, folder: { id: 'archive', accountId: 'synthetic' } });
      expect(event.preventDefault).toHaveBeenCalledOnce();
    } else {
      expect(rows.get(1)).toEqual(fresh()); expect(effects).toEqual([]);
      expect(browser.mailTabs.query).not.toHaveBeenCalled();
      for (const method of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation']) expect(event[method]).not.toHaveBeenCalled();
    }
  });
}
for (const [code, modifiers] of [['KeyA', {}], ['Enter', {}], ['KeyL', { altKey: true, metaKey: true }], ['KeyL', { altKey: true, ctrlKey: true }]]) {
  it(`unrelated ${code} ${JSON.stringify(modifiers)} preserves mail after async handling`, async () => {
    const event = key(code, modifiers); win.dispatch('keydown', event); await settled();
    expect(rows.get(1)).toEqual(fresh()); expect(rows.get(2)).toEqual({ ...fresh(), id: 2 });
    expect(effects).toEqual([]); expect(browser.mailTabs.query).not.toHaveBeenCalled();
    for (const method of ['preventDefault', 'stopPropagation', 'stopImmediatePropagation']) expect(event[method]).not.toHaveBeenCalled();
  });
}
it('new windows retain bare Tab actions and shutdown restores pass-through', async () => {
  const first = key(); win.dispatch('keydown', first); await settled();
  expect(effects).toEqual([['read', 1], ['move', 1, 'archive']]);
  rows.set(1, fresh()); effects.length = 0;
  const later = makeWindow().win; x.openWindow(later);
  const event = key(); later.dispatch('keydown', event); await settled();
  expect(effects).toEqual([['read', 1], ['move', 1, 'archive']]);
  expect(rows.get(1).folder.id).toBe('archive'); expect(event.preventDefault).toHaveBeenCalledOnce();
  rows.set(1, fresh()); effects.length = 0;
  cleanupTagActionKeyListeners(); x.instance.onShutdown(false);
  for (const current of [win, later]) {
    const after = key(); current.dispatch('keydown', after); await settled();
    expect(after.preventDefault).not.toHaveBeenCalled();
  }
  const future = makeWindow().win; x.openWindow(future);
  const after = key(); future.dispatch('keydown', after); await settled();
  expect(rows.get(1)).toEqual(fresh()); expect(effects).toEqual([]); expect(after.preventDefault).not.toHaveBeenCalled();
});
