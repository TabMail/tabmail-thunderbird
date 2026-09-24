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
  const tabs = trees.map((tree, index) => ({ mode: { name: 'mail3PaneTab' }, chromeBrowser: { ...target(), contentWindow: {
    gDBView: { selection, hdrForRow: () => headers[index] },
    document: { readyState: 'complete', getElementById: id => id === 'threadTree' && tabs[index]?.chromeBrowser.contentWindow.document.readyState === 'complete' ? tree : null, querySelector: () => null },
  } } }));
  const tabmail = { tabInfo: tabs, tabContainer, currentTabInfo: tabs[0], get currentAbout3Pane() { return this.currentTabInfo.chromeBrowser.contentWindow; } };
  const win = { ...target(), document: { readyState: loading ? 'loading' : 'complete', getElementById: id => win.document.readyState === 'complete' && id === 'tabmail' ? tabmail : null, querySelector: () => null } };
  const registered = new Map();
  const observers = new Map();
  const notifyObservers = vi.fn((subject, topic, data) => {
    for (const observer of [...(observers.get(topic) || [])]) observer(subject, topic, data);
  });
  const eventManagers = [];
  const services = {
    wm: { getEnumerator() { let index = 0; return { hasMoreElements: () => index === 0, getNext: () => { index++; return win; } }; } },
    tm: { dispatchToMainThread: fn => pending.push(fn) },
    obs: {
      addObserver(observer, topic) {
        if (!observers.has(topic)) observers.set(topic, new Set());
        observers.get(topic).add(observer);
      },
      removeObserver(observer, topic) { observers.get(topic)?.delete(observer); },
      notifyObservers,
    },
  };
  const sandbox = {
    Services: services, console: { log() {}, error() {} },
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionSupport')) return { ExtensionSupport: {
        registerWindowListener(id, listener) { registered.set(id, listener); listener.onLoadWindow(win); },
        unregisterWindowListener(id) { registered.delete(id); },
      } };
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: {
        ExtensionAPI: class { onShutdown() {} },
        ExtensionAPIPersistent: class {
          primeListener(event, fire, params, isInStartup) {
            return this.PERSISTENT_EVENTS?.[event]?.({ fire, isInStartup }, params);
          }
        },
        EventManager: class {
          constructor(options) { eventManagers.push(options); }
          api() { return {}; }
        },
      } };
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
  const loadedViews = tabs.map(tab => tab.chromeBrowser.contentWindow.gDBView);
  const setTabLoading = index => { tabs[index].chromeBrowser.contentWindow.document.readyState = 'loading'; tabs[index].chromeBrowser.contentWindow.gDBView = null; };
  const finishTabLoad = index => { tabs[index].chromeBrowser.contentWindow.document.readyState = 'complete'; tabs[index].chromeBrowser.contentWindow.gDBView = loadedViews[index]; tabs[index].chromeBrowser.emit('load'); };
  return { instance, api, trees, tabs, tabContainer, selection, pending, notifyObservers, observers, eventManagers, registered, flush, selectTab, setMessageId, win, finishLoad, setTabLoading, finishTabLoad };
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
  it('publishes the existing selection when a loading mail window becomes ready', () => {
    const h = harness({ loading: true });
    h.api.init();
    expect(h.notifyObservers).not.toHaveBeenCalled();
    h.finishLoad(); h.flush();
    expect(h.notifyObservers).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.notifyObservers.mock.calls[0][2]).selectedMessages[0].messageId).toBe('synthetic@example.test');
    h.instance.onShutdown(false);
  });
  it('does not publish an empty snapshot before a loading mail view has a selection', () => {
    const h = harness({ loading: true });
    h.selection.count = 0;
    h.api.init();
    h.finishLoad(); h.flush();
    expect(h.notifyObservers).not.toHaveBeenCalled();
    h.selection.count = 1;
    h.trees[0].emit('select'); h.flush();
    expect(JSON.parse(h.notifyObservers.mock.calls[0][2]).selectedMessages[0].messageId).toBe('synthetic@example.test');
    h.instance.onShutdown(false);
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
    expect(h.notifyObservers).toHaveBeenCalledTimes(1);
    h.notifyObservers.mockClear();
    h.instance.onShutdown(false);
    expect(h.registered.size).toBe(0);
    h.selectTab(0); h.trees[0].emit('select'); h.flush();
    expect(h.notifyObservers).not.toHaveBeenCalled();
    expect(h.trees.map(t => t.count('select'))).toEqual([0, 0]);
  });
  it('waits for a newly selected 3-pane tab to load before publishing and attaching its tree', () => {
    const h = harness(); h.api.init(); h.flush();
    h.trees[0].emit('select'); h.flush();
    expect(JSON.parse(h.notifyObservers.mock.lastCall[2]).selectedMessages[0].messageId).toBe('synthetic@example.test');
    h.notifyObservers.mockClear();

    h.setTabLoading(1); h.selectTab(1); h.flush();
    expect(h.notifyObservers).not.toHaveBeenCalled();
    expect(h.trees[1].count('select')).toBe(0);
    expect(h.tabs[1].chromeBrowser.count('load')).toBe(1);

    h.finishTabLoad(1); h.flush();
    expect(h.trees[1].count('select')).toBe(1);
    expect(h.notifyObservers).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.notifyObservers.mock.lastCall[2]).selectedMessages[0].messageId).toBe('second@example.test');
    h.setMessageId(1, 'after-load@example.test');
    h.trees[1].emit('select'); h.flush();
    expect(JSON.parse(h.notifyObservers.mock.lastCall[2]).selectedMessages[0].messageId).toBe('after-load@example.test');
    h.instance.onShutdown(false);
  });
  it('cancels a pending tab load when selection moves away', () => {
    const h = harness(); h.api.init(); h.flush();
    h.setTabLoading(1); h.selectTab(1);
    expect(h.tabs[1].chromeBrowser.count('load')).toBe(1);
    h.selectTab(0); h.notifyObservers.mockClear();
    expect(h.tabs[1].chromeBrowser.count('load')).toBe(0);
    h.finishTabLoad(1); h.flush();
    expect(h.trees[1].count('select')).toBe(0);
    expect(h.notifyObservers).not.toHaveBeenCalled();
    h.instance.onShutdown(false);
  });
  it('cancels a pending tab load on true shutdown', () => {
    const h = harness(); h.api.init(); h.flush();
    h.setTabLoading(1); h.selectTab(1); h.notifyObservers.mockClear();
    expect(h.tabs[1].chromeBrowser.count('load')).toBe(1);
    h.instance.onShutdown(false);
    expect(h.tabs[1].chromeBrowser.count('load')).toBe(0);
    h.finishTabLoad(1); h.flush();
    expect(h.trees[1].count('select')).toBe(0);
    expect(h.notifyObservers).not.toHaveBeenCalled();
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
  it('primes a selection event during sleep, preserves its payload, and converts exactly one native observer', () => {
    const h = harness();
    const event = h.eventManagers.find(options => options.name === 'messageSelection.onSelectionChanged');
    expect(event).toMatchObject({ module: 'messageSelection', event: 'onSelectionChanged' });
    expect(event.extensionApi).toBe(h.instance);
    h.api.init(); h.flush();

    const before = [];
    const active = h.instance.PERSISTENT_EVENTS.onSelectionChanged({ fire: { async: value => before.push(value) } }, []);
    h.trees[0].emit('select'); h.flush();
    expect(before.map(value => value.selectedMessages[0].messageId)).toEqual(['synthetic@example.test']);
    active.unregister();
    expect(h.observers.get('messageSelection-changed').size).toBe(0);

    const queued = [];
    const wake = vi.fn();
    const primed = h.instance.primeListener('onSelectionChanged', {
      async(value) { queued.push(value); wake(); },
    }, [], false);
    h.setMessageId(0, 'selected-during-sleep@example.test');
    h.trees[0].emit('select'); h.flush();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(queued.map(value => value.selectedMessages[0].messageId)).toEqual(['selected-during-sleep@example.test']);
    expect(h.observers.get('messageSelection-changed').size).toBe(1);

    const after = [];
    primed.convert({ async: value => after.push(value) });
    for (const value of queued) after.push(value);
    expect(after.map(value => value.selectedMessages[0].messageId)).toEqual(['selected-during-sleep@example.test']);
    h.setMessageId(0, 'selected-after-wake@example.test');
    h.trees[0].emit('select'); h.flush();
    expect(after.map(value => value.selectedMessages[0].messageId)).toEqual([
      'selected-during-sleep@example.test', 'selected-after-wake@example.test',
    ]);
    primed.unregister();
    expect(h.observers.get('messageSelection-changed').size).toBe(0);
    h.instance.onShutdown(false);
  });
});
