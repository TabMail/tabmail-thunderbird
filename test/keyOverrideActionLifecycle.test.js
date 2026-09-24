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
import { registerTabKeyHandlers, cleanupTagActionKeyListeners, triggerTagActionKey } from '../agent/modules/tagActionKey.js';
let x, win, rows, effects;
const settled = () => new Promise(resolve => setImmediate(resolve));
const key = (code = 'Tab', modifiers = {}) => ({
  code, key: code, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...modifiers,
  preventDefault: vi.fn(), stopPropagation: vi.fn(), stopImmediatePropagation: vi.fn(),
});
const fresh = () => ({ id: 1, read: false, folder: { id: 'inbox', accountId: 'synthetic' } });
beforeEach(() => {
  const initial = makeWindow();
  win = initial.win;
  rows = new Map([[1, fresh()], [2, { ...fresh(), id: 2 }]]); effects = [];
  x = experiment('theme/experiments/keyOverride/keyOverride.sys.mjs', 'keyOverride', {
    windows: [win], moduleOverrides: { getActualSelectedMessages: () => [initial.hdr] },
  });
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

it('uses the pressed window and every selected message, not another window or later selection', async () => {
  cleanupTagActionKeyListeners();
  x.instance.onShutdown(false);
  const first = makeWindow();
  const other = makeWindow();
  const selectedByPane = new Map([
    [first.cw, [{ ...first.hdr, messageKey: 1 }, { ...first.hdr, messageKey: 2 }]],
    [other.cw, [{ ...other.hdr, messageKey: 3 }]],
  ]);
  rows.set(3, { ...fresh(), id: 3 });
  x = experiment('theme/experiments/keyOverride/keyOverride.sys.mjs', 'keyOverride', {
    windows: [first.win, other.win],
    moduleOverrides: { getActualSelectedMessages: pane => selectedByPane.get(pane) || [] },
  });
  x.context.extension.messageManager.convert = header => ({ id: header.messageKey });
  browser.keyOverride = x.api;
  registerTabKeyHandlers();
  x.api.init();
  const pressed = key();
  first.win.dispatch('keydown', pressed);
  selectedByPane.set(first.cw, [{ ...first.hdr, messageKey: 3 }]);
  await settled();
  expect(pressed.preventDefault).toHaveBeenCalledOnce();
  expect(effects.filter(effect => effect[0] === 'move').map(effect => effect[1]).sort()).toEqual([1, 2]);
  expect(rows.get(1).folder.id).toBe('archive');
  expect(rows.get(2).folder.id).toBe('archive');
  expect(rows.get(3).folder.id).toBe('inbox');
  expect(browser.mailTabs.query).not.toHaveBeenCalled();
});

it('refuses a missing pressed target without acting on the rest, then recovers', async () => {
  cleanupTagActionKeyListeners();
  x.instance.onShutdown(false);
  const selected = makeWindow();
  selected.cw.gDBView = selected.view;
  const headers = [{ ...selected.hdr, messageKey: 1 }, { ...selected.hdr, messageKey: 2 }];
  let current = headers;
  x = experiment('theme/experiments/keyOverride/keyOverride.sys.mjs', 'keyOverride', {
    windows: [selected.win],
    moduleOverrides: { getActualSelectedMessages: pane => pane === selected.cw ? current : [] },
  });
  x.context.extension.messageManager.convert = header => ({ id: header.messageKey });
  browser.keyOverride = x.api;
  browser.messages.get = vi.fn(async id => {
    if (id === 2) throw new Error('Synthetic deleted target');
    return structuredClone(rows.get(id));
  });
  registerTabKeyHandlers();
  x.api.init();
  selected.win.dispatch('keydown', key());
  await settled();
  expect(browser.messages.get.mock.calls.map(call => call[0])).toEqual([1, 2]);
  expect(effects).toEqual([]);
  current = headers.slice(0, 1);
  selected.win.dispatch('keydown', key());
  await settled();
  expect(effects).toEqual([['read', 1], ['move', 1, 'archive']]);
});

it('does not consume Tab when one of several native targets cannot be converted', async () => {
  cleanupTagActionKeyListeners();
  x.instance.onShutdown(false);
  const selected = makeWindow();
  x = experiment('theme/experiments/keyOverride/keyOverride.sys.mjs', 'keyOverride', {
    windows: [selected.win],
    moduleOverrides: {
      getActualSelectedMessages: pane => pane === selected.cw
        ? [{ ...selected.hdr, messageKey: 1 }, { ...selected.hdr, messageKey: 2 }] : [],
    },
  });
  const convert = vi.fn(header => header.messageKey === 2 ? null : { id: header.messageKey });
  x.context.extension.messageManager.convert = convert;
  browser.keyOverride = x.api;
  registerTabKeyHandlers();
  x.api.init();
  const pressed = key();
  selected.win.dispatch('keydown', pressed);
  await settled();
  expect(convert).toHaveBeenCalledTimes(2);
  expect(pressed.preventDefault).not.toHaveBeenCalled();
  expect(effects).toEqual([]);
});

it('executes all 100 selected actions at the bound and refuses 101', async () => {
  cleanupTagActionKeyListeners();
  x.instance.onShutdown(false);
  const selected = makeWindow();
  const headers = Array.from({ length: 101 }, (_, index) => ({
    ...selected.hdr, messageKey: index + 1,
  }));
  selected.cw.threadTree.selectedIndices = Array.from({ length: 100 }, (_, index) => index);
  x = experiment('theme/experiments/keyOverride/keyOverride.sys.mjs', 'keyOverride', {
    windows: [selected.win],
    moduleOverrides: { getActualSelectedMessages: pane =>
      pane.threadTree.selectedIndices.map(index => headers[index]) },
  });
  x.context.extension.messageManager.convert = header => ({ id: header.messageKey });
  browser.keyOverride = x.api;
  rows = new Map(headers.map(header => [header.messageKey, {
    ...fresh(), id: header.messageKey,
  }]));
  registerTabKeyHandlers(); x.api.init();
  const atLimit = key(); selected.win.dispatch('keydown', atLimit); await settled();
  expect(atLimit.preventDefault).toHaveBeenCalledOnce();
  expect(effects.filter(effect => effect[0] === 'move')).toHaveLength(100);
  expect([...rows.values()].slice(0, 100).every(row => row.folder.id === 'archive')).toBe(true);
  effects.length = 0;
  selected.cw.threadTree.selectedIndices.push(100);
  const oversized = key(); selected.win.dispatch('keydown', oversized); await settled();
  expect(oversized.preventDefault).not.toHaveBeenCalled();
  expect(effects).toEqual([]);
  expect(rows.get(101).folder.id).toBe('inbox');
});

it('keeps the action promise pending until a deferred move completes', async () => {
  let finishMove;
  browser.messages.move = vi.fn(() => new Promise(resolve => { finishMove = resolve; }));
  let completed = false;
  const action = triggerTagActionKey().then(() => { completed = true; });
  await settled();
  expect(browser.messages.move).toHaveBeenCalledOnce();
  expect(completed).toBe(false);
  finishMove();
  await action;
  expect(completed).toBe(true);
});
