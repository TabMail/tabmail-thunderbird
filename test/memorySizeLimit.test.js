/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// memorySizeLimit.test.js — the chat memory size limit: the stored setting, what
// reaches the native helper (only a helper that advertises the limit gets it),
// and the Chat History tab's usage bar and limit choice.

import { afterEach, describe, expect, it, vi } from 'vitest';

const MB = 1024 ** 2;
const GB = 1024 ** 3;
const CHOICES = [100 * MB, 250 * MB, 500 * MB, GB, 2 * GB, 5 * GB];

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    memoryManagement: {
      nativeRpcTimeoutMs: 1_000,
      memorySizeLimitDefaultBytes: 1024 ** 3,
      memorySizeLimitChoicesBytes: [100 * 1024 ** 2, 250 * 1024 ** 2, 500 * 1024 ** 2, 1024 ** 3, 2 * 1024 ** 3, 5 * 1024 ** 3],
    },
  },
}));
vi.mock('../prompts/modules/utils.js', () => ({ showStatus: vi.fn() }));
vi.mock('../chat/modules/persistentChatStore.js', () => ({ clearAllThinking: vi.fn() }));

function makeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    local: {
      get: vi.fn(async defaults => {
        if (typeof defaults === 'string') return defaults in data ? { [defaults]: data[defaults] } : {};
        const out = {};
        for (const [key, value] of Object.entries(defaults || {})) out[key] = key in data ? data[key] : value;
        return out;
      }),
      set: vi.fn(async values => Object.assign(data, values)),
      remove: vi.fn(async () => {}),
    },
  };
}

afterEach(() => {
  delete globalThis.browser;
  delete globalThis.document;
});

describe('memory size limit setting', () => {
  async function load(initial) {
    vi.resetModules();
    const storage = makeStorage(initial);
    globalThis.browser = { storage: storage };
    const mod = await import('../fts/memorySizeLimit.js');
    return { ...mod, storage };
  }

  it('defaults to 1 GB when unset', async () => {
    const { getMemorySizeLimitBytes } = await load();
    expect(await getMemorySizeLimitBytes()).toBe(GB);
  });

  it('returns a stored choice', async () => {
    const { getMemorySizeLimitBytes } = await load({ memorySizeLimitBytes: 250 * MB });
    expect(await getMemorySizeLimitBytes()).toBe(250 * MB);
  });

  it.each([[0], [-1], [123], ['1073741824'], [null]])('ignores a stored value that is not a choice (%s)', async value => {
    const { getMemorySizeLimitBytes } = await load({ memorySizeLimitBytes: value });
    expect(await getMemorySizeLimitBytes()).toBe(GB);
  });

  it('stores only offered choices', async () => {
    const { setMemorySizeLimitBytes, storage } = await load();
    await setMemorySizeLimitBytes(500 * MB);
    expect(storage.data.memorySizeLimitBytes).toBe(500 * MB);
    await expect(setMemorySizeLimitBytes(123)).rejects.toThrow('Unsupported memory size limit');
    expect(storage.data.memorySizeLimitBytes).toBe(500 * MB);
  });

  it.each([
    [0, '0 KB'],
    [512, '0.5 KB'],
    [12.34 * MB, '12.3 MB'],
    [104.56 * MB, '105 MB'],
    [100 * MB, '100 MB'],
    [GB, '1 GB'],
    [1.5 * GB, '1.5 GB'],
    [5 * GB, '5 GB'],
    [2048 * GB, '2048 GB'],
  ])('formats %s bytes as %s', async (bytes, text) => {
    const { formatBytes } = await load();
    expect(formatBytes(bytes)).toBe(text);
  });
});

// `memoryErrors` names methods the helper answers with an error reply.
function makeNativePort({ capabilities, memoryResults = {}, memoryErrors = {} }) {
  const messageListeners = [];
  const disconnectListeners = [];
  const messages = [];
  return {
    messages,
    onMessage: { addListener: listener => messageListeners.push(listener) },
    onDisconnect: { addListener: listener => disconnectListeners.push(listener) },
    postMessage(message) {
      messages.push(message);
      let result;
      if (memoryErrors[message.method]) {
        const reply = { id: message.id, error: memoryErrors[message.method] };
        Promise.resolve().then(() => {
          for (const listener of messageListeners) listener(reply);
        });
        return;
      }
      if (message.method === 'hello') {
        result = {
          hostVersion: '0.12.0',
          canSelfUpdate: false,
          isUserInstall: true,
          isSystemInstall: false,
          installPath: '/test/fts-helper',
          ...(capabilities ? { capabilities } : {}),
        };
      } else if (message.method === 'init') {
        result = { dbPath: '/test/fts.sqlite' };
      } else {
        result = memoryResults[message.method] ?? { ok: true };
      }
      Promise.resolve().then(() => {
        for (const listener of messageListeners) listener({ id: message.id, result });
      });
    },
    disconnect() {
      for (const listener of disconnectListeners) listener();
    },
  };
}

async function initializedMemory({ capabilities, stored = {}, memoryResults, memoryErrors } = {}) {
  vi.resetModules();
  const port = makeNativePort({ capabilities, memoryResults, memoryErrors });
  const storage = makeStorage(stored);
  globalThis.browser = {
    storage,
    tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
    alarms: { create: vi.fn(() => Promise.resolve()) },
    runtime: {
      connectNative: vi.fn(() => port),
      getManifest: vi.fn(() => ({
        version: '1.9.2',
        browser_specific_settings: { gecko: { id: 'thunderbird@tabmail.ai' } },
      })),
    },
  };
  const { initNativeFts, nativeMemorySearch } = await import('../fts/nativeEngine.js');
  await initNativeFts();
  return { nativeMemorySearch, port, storage };
}

const ROWS = [{ memId: 'turn:1', role: 'session', content: '[USER]: hi', sessionId: 'persistent_chat', turnIndex: 0, dateMs: 1 }];

describe('native memory size limit wire', () => {
  it('sends the stored limit with every memory write to a helper that advertises it', async () => {
    const { nativeMemorySearch, port } = await initializedMemory({
      capabilities: { memorySizeLimitV1: true },
      stored: { memorySizeLimitBytes: 250 * MB },
    });
    await nativeMemorySearch.indexBatch(ROWS);
    const sent = port.messages.find(m => m.method === 'memoryIndexBatch');
    expect(sent.params).toEqual({ rows: ROWS, maxBytes: 250 * MB });
  });

  it('sends the default limit when none is stored', async () => {
    const { nativeMemorySearch, port } = await initializedMemory({ capabilities: { memorySizeLimitV1: true } });
    await nativeMemorySearch.indexBatch(ROWS);
    expect(port.messages.find(m => m.method === 'memoryIndexBatch').params.maxBytes).toBe(GB);
  });

  it.each([
    ['no capabilities', undefined],
    ['other capabilities only', { folderMembershipV1: true }],
    ['the flag not true', { memorySizeLimitV1: 'yes' }],
  ])('keeps the legacy write shape for a helper with %s', async (_label, capabilities) => {
    const { nativeMemorySearch, port } = await initializedMemory({ capabilities });
    await nativeMemorySearch.indexBatch(ROWS);
    const sent = port.messages.find(m => m.method === 'memoryIndexBatch');
    expect(Object.keys(sent.params)).toEqual(['rows']);
  });

  it('applies the stored limit with memoryTrim and returns the helper result', async () => {
    const trimResult = { ok: true, trimmed: 3, usedBytes: 10, withinLimit: true };
    const { nativeMemorySearch, port } = await initializedMemory({
      capabilities: { memorySizeLimitV1: true },
      stored: { memorySizeLimitBytes: 100 * MB },
      memoryResults: { memoryTrim: trimResult },
    });
    await expect(nativeMemorySearch.trim()).resolves.toEqual(trimResult);
    expect(port.messages.find(m => m.method === 'memoryTrim').params).toEqual({ maxBytes: 100 * MB });
  });

  it('reconnects a helper that disconnected and applies the trim, rather than calling it outdated', async () => {
    vi.resetModules();
    const ports = [];
    const trimResult = { ok: true, trimmed: 2, usedBytes: 5, withinLimit: true };
    globalThis.browser = {
      storage: makeStorage({ memorySizeLimitBytes: 100 * MB }),
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      alarms: { create: vi.fn(() => Promise.resolve()) },
      runtime: {
        connectNative: vi.fn(() => {
          const port = makeNativePort({ capabilities: { memorySizeLimitV1: true }, memoryResults: { memoryTrim: trimResult } });
          ports.push(port);
          return port;
        }),
        getManifest: vi.fn(() => ({ version: '1.9.2', browser_specific_settings: { gecko: { id: 'thunderbird@tabmail.ai' } } })),
      },
    };
    const { initNativeFts, nativeMemorySearch } = await import('../fts/nativeEngine.js');
    await initNativeFts();
    ports[0].disconnect();
    // Past the reconnect cooldown, as a helper restart after a crash or an update is.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now + 61_000);
    try {
      await expect(nativeMemorySearch.trim()).resolves.toEqual(trimResult);
    } finally {
      vi.restoreAllMocks();
    }
    expect(ports.length).toBe(2);
    expect(ports[1].messages.find(m => m.method === 'memoryTrim').params).toEqual({ maxBytes: 100 * MB });
  });

  // A failed trim is not an outdated helper: it rejects, so the tab says
  // applying failed rather than "applies once the search helper updates".
  it('rejects with the helper error when an updated helper fails the trim', async () => {
    const { nativeMemorySearch, port } = await initializedMemory({
      capabilities: { memorySizeLimitV1: true },
      stored: { memorySizeLimitBytes: 100 * MB },
      memoryErrors: { memoryTrim: 'database is locked' },
    });
    await expect(nativeMemorySearch.trim()).rejects.toThrow('database is locked');
    expect(port.messages.find(m => m.method === 'memoryTrim').params).toEqual({ maxBytes: 100 * MB });
  });

  it('rejects, not "needs an update", when the helper is gone and cannot reconnect yet', async () => {
    const { nativeMemorySearch, port } = await initializedMemory({ capabilities: { memorySizeLimitV1: true } });
    port.disconnect();
    await expect(nativeMemorySearch.trim()).rejects.toThrow('not connected');
    expect(port.messages.some(m => m.method === 'memoryTrim')).toBe(false);
  });

  it('answers memoryTrim itself for a helper without the limit, sending nothing', async () => {
    const { nativeMemorySearch, port } = await initializedMemory({ capabilities: { folderMembershipV1: true } });
    await expect(nativeMemorySearch.trim()).resolves.toEqual({ ok: false, unsupported: true });
    expect(port.messages.some(m => m.method === 'memoryTrim')).toBe(false);
  });
});

// The Chat History tab's elements: the usage row, and the list and stats that
// loadChatHistory renders after it.
function makeUsageDom() {
  const el = {
    'history-usage-label': { textContent: '' },
    'history-usage-bar': { max: 100, value: 0 },
    'history-usage-note': { textContent: '', style: {} },
    'history-size-limit': {
      value: '',
      options: [],
      listeners: {},
      replaceChildren(...options) { this.options = options; },
      addEventListener(type, listener) { this.listeners[type] = listener; },
    },
    'history-search-input': { value: '', addEventListener() {} },
    'history-list': { innerHTML: '' },
    'history-empty': { style: {} },
    'history-stats': { innerHTML: '' },
    'history-pagination': { style: {} },
  };
  globalThis.document = { getElementById: id => el[id] ?? null };
  globalThis.Option = function Option(text, value) { this.text = text; this.value = value; };
  return el;
}

describe('Chat History usage bar', () => {
  // `stats` answers memoryStats; `statsAfter`, when given, answers it once
  // memoryTrim or memoryClear has been sent (what the helper then holds).
  async function loadHistory({ stats, statsAfter, stored = {}, trimResult } = {}) {
    vi.resetModules();
    const storage = makeStorage(stored);
    let changed = false;
    const sendMessage = vi.fn(async msg => {
      if (msg.cmd === 'memoryStats') return changed && statsAfter !== undefined ? statsAfter : stats;
      if (msg.cmd === 'memoryTrim') { changed = true; return trimResult; }
      if (msg.cmd === 'memoryClear') { changed = true; return { ok: true }; }
      return [];
    });
    globalThis.browser = { storage, runtime: { sendMessage } };
    const el = makeUsageDom();
    const history = await import('../prompts/modules/history.js');
    const { showStatus } = await import('../prompts/modules/utils.js');
    showStatus.mockClear();
    return { changeMemorySizeLimit: history._testExports.changeMemorySizeLimit, history, el, storage, sendMessage, showStatus };
  }

  it('shows used against the limit, with every limit choice offered', async () => {
    const { history, el } = await loadHistory({
      stats: { docs: 4, dbBytes: 900 * MB, usedBytes: 300 * MB },
      stored: { memorySizeLimitBytes: 500 * MB },
    });
    await history.loadChatHistory();
    expect(el['history-usage-label'].textContent).toBe('Memory used: 300 MB of 500 MB');
    expect(el['history-usage-bar'].max).toBe(500 * MB);
    expect(el['history-usage-bar'].value).toBe(300 * MB);
    expect(el['history-size-limit'].options.map(o => Number(o.value))).toEqual(CHOICES);
    expect(el['history-size-limit'].value).toBe(String(500 * MB));
    expect(el['history-usage-note'].textContent).toContain('oldest conversations are removed first');
  });

  it('says the limit waits for a helper update when stats carry no used size', async () => {
    const { history, el } = await loadHistory({ stats: { docs: 1, dbBytes: 2 * MB } });
    await history.loadChatHistory();
    expect(el['history-usage-label'].textContent).toBe('Memory used: 2 MB of 1 GB');
    expect(el['history-usage-note'].textContent).toContain('once the search helper updates');
  });

  for (const [name, stats] of [
    ['no reply', undefined],
    ['an error reply', { error: 'Native FTS helper not connected' }],
  ]) {
    it(`says usage is unavailable, not zero, on ${name} from the helper`, async () => {
      const { history, el } = await loadHistory({ stats });
      await history.loadChatHistory();
      expect(el['history-usage-label'].textContent).toBe('Memory used: unavailable (limit 1 GB)');
      expect(el['history-usage-label'].textContent).not.toMatch(/\d+ KB/);
      expect(el['history-usage-bar'].value).toBe(0);
      expect(el['history-usage-note'].textContent).toContain('once the search helper is running');
      expect(el['history-size-limit'].value).toBe(String(GB));
    });
  }

  it('empties the bar when usage becomes unavailable on a reload', async () => {
    const { history, el, sendMessage } = await loadHistory({ stats: { docs: 4, dbBytes: 300 * MB, usedBytes: 300 * MB } });
    await history.loadChatHistory();
    expect(el['history-usage-bar'].value).toBe(300 * MB);
    sendMessage.mockImplementation(async msg => (msg.cmd === 'memoryStats' ? { error: 'Native FTS helper not connected' } : []));
    await history.loadChatHistory();
    expect(el['history-usage-label'].textContent).toBe('Memory used: unavailable (limit 1 GB)');
    expect(el['history-usage-bar'].value).toBe(0);
  });

  it('caps the bar at the limit when memory is over it', async () => {
    const { history, el } = await loadHistory({
      stats: { docs: 9, dbBytes: 200 * MB, usedBytes: 150 * MB },
      stored: { memorySizeLimitBytes: 100 * MB },
    });
    await history.loadChatHistory();
    expect(el['history-usage-label'].textContent).toBe('Memory used: 150 MB of 100 MB');
    expect(el['history-usage-bar'].value).toBe(100 * MB);
  });

  it('stores a new limit, then applies it, reports what was removed, and shows the new usage', async () => {
    const { changeMemorySizeLimit, el, storage, sendMessage, showStatus } = await loadHistory({
      stats: { docs: 9, dbBytes: 300 * MB, usedBytes: 300 * MB },
      statsAfter: { docs: 2, dbBytes: 300 * MB, usedBytes: 90 * MB },
      trimResult: { ok: true, trimmed: 7, usedBytes: 90 * MB, withinLimit: true },
    });
    await changeMemorySizeLimit(100 * MB);
    expect(storage.data.memorySizeLimitBytes).toBe(100 * MB);
    const cmds = sendMessage.mock.calls.map(([m]) => m.cmd);
    expect(cmds.indexOf('memoryTrim')).toBeGreaterThanOrEqual(0);
    expect(storage.local.set.mock.invocationCallOrder[0])
      .toBeLessThan(sendMessage.mock.invocationCallOrder[cmds.indexOf('memoryTrim')]);
    expect(showStatus.mock.calls).toEqual([['Size limit set to 100 MB. Removed the 7 oldest entries.']]);
    expect(el['history-usage-label'].textContent).toBe('Memory used: 90 MB of 100 MB');
    expect(el['history-size-limit'].value).toBe(String(100 * MB));
  });

  it('says only the new limit when nothing had to be removed', async () => {
    const { changeMemorySizeLimit, el, showStatus } = await loadHistory({
      stats: { docs: 2, dbBytes: 90 * MB, usedBytes: 90 * MB },
      trimResult: { ok: true, trimmed: 0, usedBytes: 90 * MB, withinLimit: true },
    });
    await changeMemorySizeLimit(5 * GB);
    expect(showStatus.mock.calls).toEqual([['Size limit set to 5 GB.']]);
    expect(el['history-usage-label'].textContent).toBe('Memory used: 90 MB of 5 GB');
  });

  it.each([
    [1, 'Size limit set to 100 MB. Removed the oldest entry. More are removed as new conversations are kept.'],
    [0, 'Size limit set to 100 MB. More are removed as new conversations are kept.'],
  ])('says more go later when the helper ran out of time (%s removed)', async (trimmed, text) => {
    const { changeMemorySizeLimit, el, showStatus } = await loadHistory({
      stats: { docs: 9, dbBytes: 300 * MB, usedBytes: 300 * MB },
      statsAfter: { docs: 8, dbBytes: 300 * MB, usedBytes: 280 * MB },
      trimResult: { ok: true, trimmed, usedBytes: 280 * MB, withinLimit: false },
    });
    await changeMemorySizeLimit(100 * MB);
    expect(showStatus.mock.calls).toEqual([[text]]);
    expect(el['history-usage-label'].textContent).toBe('Memory used: 280 MB of 100 MB');
  });

  it('keeps the new limit and says so when the helper cannot apply it yet', async () => {
    const { changeMemorySizeLimit, storage, showStatus } = await loadHistory({
      stats: { docs: 1, dbBytes: MB },
      trimResult: { ok: false, unsupported: true },
    });
    await changeMemorySizeLimit(2 * GB);
    expect(storage.data.memorySizeLimitBytes).toBe(2 * GB);
    expect(showStatus.mock.calls).toEqual([['Size limit set to 2 GB. It applies once the search helper updates.']]);
  });

  it('says only the new limit when no search engine answers the trim', async () => {
    const { changeMemorySizeLimit, storage, showStatus } = await loadHistory({
      stats: { docs: 1, dbBytes: MB, usedBytes: MB },
      trimResult: undefined,
    });
    await changeMemorySizeLimit(2 * GB);
    expect(storage.data.memorySizeLimitBytes).toBe(2 * GB);
    expect(showStatus.mock.calls).toEqual([['Size limit set to 2 GB.']]);
  });

  it('reports a failed trim as an error, keeping the stored limit', async () => {
    const { changeMemorySizeLimit, storage, showStatus } = await loadHistory({
      stats: { docs: 1, dbBytes: MB, usedBytes: MB },
      trimResult: { error: 'helper busy' },
    });
    await changeMemorySizeLimit(250 * MB);
    expect(storage.data.memorySizeLimitBytes).toBe(250 * MB);
    expect(showStatus.mock.calls).toEqual([['Size limit saved, but applying it failed: helper busy', true]]);
  });

  it('says the limit is saved when only applying it fails, and reloads the tab', async () => {
    const { changeMemorySizeLimit, el, storage, sendMessage, showStatus } = await loadHistory({
      stats: { docs: 1, dbBytes: MB, usedBytes: MB },
      stored: { memorySizeLimitBytes: GB },
    });
    sendMessage.mockImplementation(async msg => {
      if (msg.cmd === 'memoryTrim') throw new Error('Could not establish connection');
      if (msg.cmd === 'memoryStats') return { docs: 1, dbBytes: MB, usedBytes: MB };
      return [];
    });
    await changeMemorySizeLimit(250 * MB);
    expect(storage.data.memorySizeLimitBytes).toBe(250 * MB);
    expect(showStatus.mock.calls).toEqual([['Size limit saved, but applying it failed: Error: Could not establish connection', true]]);
    // The tab shows the limit now stored.
    expect(el['history-size-limit'].value).toBe(String(250 * MB));
    expect(el['history-usage-label'].textContent).toBe('Memory used: 1 MB of 250 MB');
  });

  it('changes the limit when the user picks a larger size in the list', async () => {
    const { history, el, storage, sendMessage, showStatus } = await loadHistory({
      stats: { docs: 1, dbBytes: MB, usedBytes: MB },
      trimResult: { ok: true, trimmed: 0, usedBytes: MB, withinLimit: true },
    });
    await history.loadChatHistory();
    history.initHistoryHandlers();
    const select = el['history-size-limit'];
    // The select's values are strings, as the DOM gives them.
    select.value = select.options.find(o => o.text === '2 GB').value;
    select.listeners.change();
    await vi.waitFor(() => expect(showStatus).toHaveBeenCalled());
    expect(storage.data.memorySizeLimitBytes).toBe(2 * GB);
    const trimCall = sendMessage.mock.calls.findIndex(([m]) => m.cmd === 'memoryTrim');
    expect(trimCall).toBeGreaterThanOrEqual(0);
    expect(storage.local.set.mock.invocationCallOrder[0]).toBeLessThan(sendMessage.mock.invocationCallOrder[trimCall]);
    expect(showStatus.mock.calls).toEqual([['Size limit set to 2 GB.']]);
  });

  it('shows what the running helper holds after Clear All', async () => {
    const { history, el, sendMessage } = await loadHistory({
      stats: { docs: 9, dbBytes: 2 * MB, usedBytes: 2 * MB },
      statsAfter: { docs: 0, dbBytes: 2 * MB, usedBytes: 64 * 1024 },
    });
    await history.loadChatHistory();
    expect(el['history-usage-label'].textContent).toBe('Memory used: 2 MB of 1 GB');
    await history.clearChatHistory();
    expect(sendMessage.mock.calls.some(([m]) => m.cmd === 'memoryClear')).toBe(true);
    expect(el['history-usage-label'].textContent).toBe('Memory used: 64 KB of 1 GB');
    expect(el['history-usage-note'].textContent).toContain('oldest conversations are removed first');
  });

  it('still says usage is unavailable after Clear All when no helper answers', async () => {
    const { history, el } = await loadHistory({ stats: undefined });
    await history.clearChatHistory();
    expect(el['history-usage-label'].textContent).toBe('Memory used: unavailable (limit 1 GB)');
    expect(el['history-usage-note'].textContent).toContain('once the search helper is running');
  });

  it('rejects a limit that is not offered without trimming', async () => {
    const { changeMemorySizeLimit, storage, sendMessage, showStatus } = await loadHistory();
    await changeMemorySizeLimit(42);
    expect(storage.data.memorySizeLimitBytes).toBeUndefined();
    expect(sendMessage.mock.calls.some(([m]) => m.cmd === 'memoryTrim')).toBe(false);
    expect(showStatus).toHaveBeenCalledWith(expect.stringContaining('Failed to change the size limit'), true);
  });
});
