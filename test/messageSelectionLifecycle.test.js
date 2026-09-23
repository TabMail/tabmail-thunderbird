import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const filename = new URL('../chat/experiments/messageSelection/messageSelection.sys.mjs', import.meta.url).pathname;
const source = readFileSync(filename, 'utf8');
function target() {
  const events = new Map();
  return {
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); },
    emit(name) { for (const fn of [...(events.get(name) || [])]) fn(); },
    count(name) { return events.get(name)?.size || 0; },
  };
}
function harness({ loading = false } = {}) {
  const pending = [];
  const tabContainer = target();
  const header = { messageKey: 1, messageId: 'synthetic@example.test', subject: 'Synthetic', author: 'sender@example.test', date: Date.now() * 1000, folder: { URI: 'mailbox://synthetic/Inbox' } };
  const headers = [header, { ...header, messageId: 'second@example.test' }];
  const selection = { count: 1, getRangeCount: () => 1, getRangeAt(_i, a, b) { a.value = 0; b.value = 0; } };
  const trees = [target(), target()];
  const tabs = trees.map((tree, index) => ({ mode: { name: 'mail3PaneTab' }, chromeBrowser: { contentWindow: {
    gDBView: { selection, hdrForRow: () => headers[index] },
    document: { getElementById: id => id === 'threadTree' ? tree : null, querySelector: () => null },
  } } }));
  const tabmail = { tabInfo: tabs, tabContainer, currentTabInfo: tabs[0], get currentAbout3Pane() { return this.currentTabInfo.chromeBrowser.contentWindow; } };
  const win = { ...target(), document: { readyState: loading ? 'loading' : 'complete', getElementById: id => win.document.readyState === 'complete' && id === 'tabmail' ? tabmail : null, querySelector: () => null } };
  const registered = new Map();
  const notifyObservers = vi.fn();
  const services = {
    wm: { getEnumerator() { let index = 0; return { hasMoreElements: () => index === 0, getNext: () => { index++; return win; } }; } },
    tm: { dispatchToMainThread: fn => pending.push(fn) },
    obs: { addObserver() {}, removeObserver() {}, notifyObservers },
  };
  const sandbox = {
    Services: services, console: { log() {}, error() {} },
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionSupport')) return { ExtensionSupport: {
        registerWindowListener(id, listener) { registered.set(id, listener); listener.onLoadWindow(win); },
        unregisterWindowListener(id) { registered.delete(id); },
      } };
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: { ExtensionAPI: class { onShutdown() {} }, EventManager: class { api() { return {}; } } } };
      throw Error(path);
    } },
  };
  vm.runInNewContext(`${source}\nglobalThis.Experiment = messageSelection;`, sandbox, { filename });
  const instance = new sandbox.Experiment();
  const api = instance.getAPI({ extension: { id: 'synthetic@example.test', messageManager: { convert: () => ({ id: 1 }) } } }).messageSelection;
  const flush = () => { while (pending.length) pending.shift()(); };
  const selectTab = index => { tabmail.currentTabInfo = tabs[index]; tabContainer.emit('TabSelect'); };
  const setMessageId = (index, messageId) => { headers[index] = { ...headers[index], messageId }; };
  const finishLoad = () => { win.document.readyState = 'complete'; win.emit('load'); };
  return { instance, api, trees, tabContainer, pending, notifyObservers, registered, flush, selectTab, setMessageId, win, finishLoad };
}
describe('review: native ownership with real window and queued callback shapes', () => {
  it('tracks an existing window that finishes loading after listener registration', () => {
    const h = harness({ loading: true }); h.api.init();
    expect(h.trees[0].count('select')).toBe(0);
    expect(h.win.count('load')).toBe(1);
    h.finishLoad();
    expect(h.trees[0].count('select')).toBe(1);
    expect(h.tabContainer.count('TabSelect')).toBe(1);
    h.trees[0].emit('select'); h.flush();
    expect(JSON.parse(h.notifyObservers.mock.calls[0][2]).selectedMessages[0].messageId).toBe('synthetic@example.test');
    h.instance.onShutdown(false);
    expect(h.trees[0].count('select')).toBe(0);
  });
  it('cancels loading-window setup on close and true shutdown', () => {
    for (const close of [false, true]) {
      const h = harness({ loading: true }); h.api.init();
      if (close) h.win.emit('unload'); else h.instance.onShutdown(false);
      expect(h.win.count('load')).toBe(0);
      h.finishLoad();
      expect(h.trees[0].count('select')).toBe(0);
      if (close) h.instance.onShutdown(false);
    }
  });
  it('positive control: active tree emits before shutdown and detaches afterward', () => {
    const h = harness(); h.api.init(); h.flush();
    expect(h.trees[0].count('select')).toBe(1);
    h.trees[0].emit('select'); h.flush();
    expect(h.notifyObservers).toHaveBeenCalledTimes(1);
    h.instance.onShutdown(false);
    expect(h.trees[0].count('select')).toBe(0);
    expect(h.tabContainer.count('TabSelect')).toBe(0);
    h.trees[0].emit('select'); h.flush();
    expect(h.notifyObservers).toHaveBeenCalledTimes(1);
  });
  it('publishes the newly selected message rather than a stale previous selection', () => {
    const h = harness(); h.api.init();
    h.trees[0].emit('select'); h.flush();
    const first = JSON.parse(h.notifyObservers.mock.calls[0][2]);
    expect(first.selectedMessages[0].messageId).toBe('synthetic@example.test');
    h.setMessageId(0, 'newly-selected@example.test');
    h.trees[0].emit('select'); h.flush();
    const second = JSON.parse(h.notifyObservers.mock.calls[1][2]);
    expect(second.selectedMessages[0].messageId).toBe('newly-selected@example.test');
  });
  it('cleans every previously visited mail tab, including inactive tabs', () => {
    const h = harness(); h.api.init(); h.flush(); h.selectTab(1);
    expect(h.trees.map(t => t.count('select'))).toEqual([1, 1]);
    h.instance.onShutdown(false);
    expect(h.registered.size).toBe(0);
    h.selectTab(0); h.trees[0].emit('select'); h.flush();
    expect(h.notifyObservers).not.toHaveBeenCalled();
    expect(h.trees.map(t => t.count('select'))).toEqual([0, 0]);
  });
  it('does not reattach a tree when deferred window setup runs after shutdown', () => {
    const h = harness(); h.api.init();
    expect(h.trees[0].count('select')).toBe(1);
    h.instance.onShutdown(false);
    expect(h.trees[0].count('select')).toBe(0);
    h.flush();
    expect(h.trees[0].count('select')).toBe(0);
  });
  it('does not inspect or publish selection after a queued select outlives shutdown', () => {
    const h = harness(); h.api.init(); h.flush();
    h.trees[0].emit('select');
    const sentBeforeShutdown = h.notifyObservers.mock.calls.length;
    h.instance.onShutdown(false); h.flush();
    expect(h.notifyObservers).toHaveBeenCalledTimes(sentBeforeShutdown);
  });
});
