import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function target() {
  const handlers = new Map();
  const once = new Map();
  return {
    handlers,
    addEventListener(name, callback, options) {
      if (!handlers.has(name)) handlers.set(name, new Set());
      handlers.get(name).add(callback);
      if (options?.once) {
        if (!once.has(name)) once.set(name, new Set());
        once.get(name).add(callback);
      }
    },
    removeEventListener(name, callback) {
      handlers.get(name)?.delete(callback);
      once.get(name)?.delete(callback);
    },
    dispatch(name, ...args) {
      for (const callback of [...(handlers.get(name) || [])]) {
        if (once.get(name)?.has(callback)) {
          handlers.get(name).delete(callback);
          once.get(name).delete(callback);
        }
        callback(...args);
      }
    },
  };
}

export function makeWindow() {
  const tree = {
    ...target(), style: {}, getAttribute: () => '',
    classList: { contains: () => false, add() {}, remove() {} },
    querySelector: () => null,
  };
  const pane = target();
  const tabContainer = target();
  const cw = target();
  const doc = {
    ...target(),
    location: { href: 'about:3pane' },
    documentElement: { classList: { add() {}, remove() {} }, setAttribute() {}, removeAttribute() {} },
    getElementById: id => id === 'threadTree' ? tree : id === 'messageBrowser' ? pane : null,
    querySelector: () => null,
    defaultView: cw,
  };
  cw.document = doc;
  cw.MutationObserver = class {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  };
  cw.setTimeout = () => 1;
  cw.clearTimeout = () => {};

  const hdr = {
    messageId: 'synthetic@example.test', subject: 'Synthetic subject',
    author: 'sender@example.test', messageKey: 1, flags: 0,
    date: Date.now() * 1000,
    folder: { URI: 'mailbox://synthetic/Inbox', prettyName: 'Inbox' },
  };
  const selection = {
    count: 1, getRangeCount: () => 1,
    getRangeAt(_range, start, end) { start.value = end.value = 0; },
  };
  const view = {
    selection, hdrForRow: () => hdr,
    msgFolder: { flags: 1, URI: 'mailbox://synthetic/Inbox' },
    rowCount: 2, sort() {}, addColumnHandler() {}, getColumnHandler() { return null; },
  };
  const media = target();
  const tabmail = {
    currentAbout3Pane: cw,
    currentTabInfo: { mode: { name: 'mail3PaneTab' } },
    tabInfo: [{ chromeBrowser: { contentDocument: doc, contentWindow: cw } }],
    tabContainer,
  };
  const win = {
    ...target(),
    location: { href: 'chrome://messenger/content/messenger.xhtml' },
    gDBView: view,
    setTimeout: () => 1, clearTimeout() {}, requestAnimationFrame: callback => callback(),
    matchMedia: () => media,
    document: {
      readyState: 'complete',
      getElementById: id => id === 'tabmail' ? tabmail : id === 'threadTree' ? tree : null,
      querySelector: () => null,
      documentElement: { setAttribute() {}, removeAttribute() {}, classList: { add() {}, remove() {} } },
    },
  };
  win.document.defaultView = win;
  return { win, tree, tabContainer, pane, cw, doc, hdr, view, media };
}

export function experiment(relativePath, name, { windows = [], holdFetch = false, moduleOverrides = {} } = {}) {
  const windowListeners = new Map();
  const mfn = new Set();
  const columns = new Map();
  const observers = new Map();
  const logs = [];
  const queued = [];
  const sheets = new Set();
  const enumerator = items => {
    let index = 0;
    return { hasMoreElements: () => index < items.length, getNext: () => items[index++] };
  };
  const Services = {
    scriptSecurityManager: { getSystemPrincipal: () => ({}) },
    wm: { getEnumerator: () => enumerator([...windows]), getMostRecentWindow: () => windows.at(-1) },
    prefs: {
      getIntPref: (_key, fallback) => fallback ?? 2, setIntPref() {},
      getBoolPref: () => true, addObserver() {}, removeObserver() {},
    },
    io: { newURI: value => ({ spec: value }) },
    tm: { dispatchToMainThread: callback => callback() },
    obs: {
      addObserver(callback, topic) {
        if (!observers.has(topic)) observers.set(topic, new Set());
        observers.get(topic).add(callback);
      },
      removeObserver(callback, topic) { observers.get(topic)?.delete(callback); },
      notifyObservers(subject, topic, data) {
        for (const callback of observers.get(topic) || []) {
          if (typeof callback === 'function') callback(subject, topic, data);
          else callback.observe(subject, topic, data);
        }
      },
    },
  };
  const ExtensionSupport = {
    registerWindowListener(id, listener) {
      if (windowListeners.has(id)) return false;
      windowListeners.set(id, listener);
      // Existing non-blank windows are notified immediately, even if still loading.
      for (const win of windows) listener.onLoadWindow?.(win);
      return true;
    },
    unregisterWindowListener(id) { windowListeners.delete(id); },
  };
  class ExtensionAPI {
    constructor(extension) { this.extension = extension; }
    onShutdown() {}
  }
  class ExtensionAPIPersistent extends ExtensionAPI {
    primeListener(event, fire, params, isInStartup) {
      return this.PERSISTENT_EVENTS?.[event]?.({ fire, isInStartup }, params);
    }
  }
  class EventManager {
    constructor(options) { this.options = options; }
    api() {
      const handlers = new Map();
      return {
        addListener: callback => {
          if (!handlers.has(callback)) {
            const fire = { async: (...args) => Promise.resolve(callback(...args)) };
            const unregister = this.options.register
              ? this.options.register(fire)
              : this.options.extensionApi.PERSISTENT_EVENTS[this.options.event]({ fire }, []).unregister;
            handlers.set(callback, unregister);
          }
        },
        removeListener: callback => { handlers.get(callback)?.(); handlers.delete(callback); },
        hasListener: callback => handlers.has(callback),
        close: () => { for (const unregister of handlers.values()) unregister(); handlers.clear(); },
      };
    }
  }
  const extension = {
    id: 'synthetic@example.test',
    getURL: relative => `moz-extension://synthetic/${relative}`,
    baseURI: { resolve: relative => `moz-extension://synthetic/${relative}` },
    messageManager: { convert: () => ({ id: 1 }) },
    folderManager: { convert: () => ({ id: 'synthetic', accountId: 'synthetic', path: '/Inbox' }) },
    on() {}, off() {}, emit() {},
  };
  const context = { extension };
  const styleService = {
    AGENT_SHEET: 0,
    sheetRegistered: uri => sheets.has(uri.spec),
    loadAndRegisterSheet: uri => sheets.add(uri.spec),
    unregisterSheet: uri => sheets.delete(uri.spec),
  };
  const modules = {
    ExtensionCommon: { ExtensionAPI, ExtensionAPIPersistent, EventManager }, ExtensionSupport,
    NetUtil: {
      asyncFetch(options, callback) {
        const url = typeof options.uri === 'string' ? options.uri : options.uri.spec;
        const text = readFileSync(new URL(`../../${url.replace('moz-extension://synthetic/', '')}`, import.meta.url), 'utf8');
        const finish = () => callback({ text, available: () => text.length, close() {} }, 0);
        if (holdFetch) queued.push(finish);
        else finish();
      },
      readInputStreamToString: stream => stream.text,
    },
    MailServices: { mfn: { addListener: callback => mfn.add(callback), removeListener: callback => mfn.delete(callback) } },
    ThreadPaneColumns: {
      addCustomColumn(id, data) {
        if (columns.has(id)) throw Error('already used');
        columns.set(id, data);
      },
      removeCustomColumn: id => columns.delete(id),
    },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
  };
  Object.assign(modules, moduleOverrides);
  const sandbox = {
    Services,
    ChromeUtils: { importESModule: () => modules, generateQI: () => () => {} },
    console: Object.fromEntries(['log', 'warn', 'error', 'debug'].map(level => [level, (...args) => logs.push(args)])),
    Cc: new Proxy({}, { get: () => ({ getService: () => styleService, createInstance: () => ({ initWithCallback() {}, cancel() {} }) }) }),
    Cu: { Sandbox: () => ({}), evalInSandbox: (source, scope) => vm.runInNewContext(source, scope) },
    Ci: {
      nsILoadInfo: { SEC_ALLOW_CROSS_ORIGIN_SEC_CONTEXT_IS_NULL: 0 },
      nsIStyleSheetService: {}, nsIContentPolicy: { TYPE_OTHER: 1 },
      nsMsgFolderFlags: { Inbox: 1, Virtual: 2 },
      nsIMsgFolderNotificationService: { msgPropertyChanged: 1, msgsDeleted: 2, msgsMoveCopyCompleted: 4, msgsClassified: 8 },
      nsMsgViewSortType: { byCustom: 99, byDate: 18 }, nsITimer: { TYPE_ONE_SHOT: 0 },
    },
    Components: { isSuccessCode: () => true },
    TextEncoder, URL, Date, WeakMap, Map, Set,
  };
  const file = new URL(`../../${relativePath}`, import.meta.url).pathname;
  vm.runInNewContext(readFileSync(file, 'utf8') + `\nglobalThis.Experiment = ${name};`, sandbox, { filename: file });
  const instance = new sandbox.Experiment(extension);
  const api = instance.getAPI(context)[name];
  return {
    api, instance, context, windows, windowListeners, mfn, columns, observers, logs, queued, sheets, Services, sandbox,
    openWindow(win) {
      windows.push(win);
      for (const listener of windowListeners.values()) listener.onLoadWindow?.(win);
    },
    closeWindow(win) {
      for (const listener of windowListeners.values()) listener.onUnloadWindow?.(win);
      windows.splice(windows.indexOf(win), 1);
      win.closed = true;
      win.dispatch?.('unload');
    },
  };
}
