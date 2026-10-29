/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #155: memory_search and memory_read answer in every context that runs them.
// The chat window runs them in its page; headless runs (proactive check-ins,
// reply generation, compose edits) run them in the background, which owns the
// native helper. A runtime message is not delivered to the sender's own frame
// (MDN runtime.sendMessage), so a message the background sends never reaches
// its own FTS command handler: it rejects when no other extension page is
// open, and resolves undefined when one is open but does not answer.
//
// This runs the real FTS command handler (initFtsEngine) over a stand-in
// helper that holds memory rows, and runs both tools as the background
// (owner of the helper, messages to itself lost) and as a page (messages
// answered by that handler). Each must give the helper's answer, and a helper
// failure must read the same in both.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({ owner: false, down: false, rows: [] }));

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKeyCandidates: vi.fn(),
  headerIDToWeID: vi.fn(),
  recheckMessageInFolder: vi.fn(),
}));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    ftsCleanup: { queryChunkSize: 5, validationBatchSize: 2, removeBatchSize: 2, batchDelayMs: 0, entryDelayMs: 0 },
    ftsMaintenanceLog: { maxCorrectionEntriesPerRun: 0 },
  },
}));
vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsOperation: vi.fn(),
  logFtsBatchOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));
vi.mock('../fts/indexer.js', () => ({ indexMessages: vi.fn(async () => ({ scanned: 0, newlyIndexed: 0, skipped: 0, correctionDetails: [] })) }));
vi.mock('../fts/incrementalIndexer.js', () => ({ initIncrementalIndexer: vi.fn(async () => {}) }));
vi.mock('../fts/memoryIndexer.js', async importOriginal => ({
  ...await importOriginal(),
  migrateExistingChatHistory: vi.fn(async () => ({ migrated: false })),
}));
// A short readiness wait, so a request that gets no answer ends within the test.
vi.mock('../chat/modules/chatConfig.js', async importOriginal => {
  const original = await importOriginal();
  return { ...original, CHAT_SETTINGS: { ...original.CHAT_SETTINGS, ftsReadinessTimeoutMs: 200, ftsReadinessRetryDelayMs: 10 } };
});

// The helper's memory: date bounds inclusive, newest first, `previewChars`
// cuts content, a query matches entries holding one of its words.
function searchRows(q, { from, to, limit, ignoreDate, previewChars }) {
  const lo = ignoreDate || from === '' || from == null ? -Infinity : from;
  const hi = ignoreDate || to === '' || to == null ? Infinity : to;
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const cut = text => (previewChars > 0 ? text.slice(0, previewChars) : text);
  return helper.rows
    .filter(r => r.dateMs >= lo && r.dateMs <= hi)
    .filter(r => words.length === 0 || words.some(w => r.content.toLowerCase().includes(w)))
    .sort((a, b) => b.dateMs - a.dateMs)
    .slice(0, limit)
    .map(r => ({ ...r, content: cut(r.content), snippet: words.length ? cut(r.content) : null }));
}

function failIfDown() {
  if (helper.down) throw new Error('Native FTS helper not connected');
}

vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(async () => { helper.owner = true; return true; }),
  ownsNativeHelper: () => helper.owner,
  nativeFtsSearch: {
    checkReindexNeeded: vi.fn(async () => ({ needsReindex: false, isFirstRun: false })),
    getHostAvailability: vi.fn(() => true),
    getHostStatus: vi.fn(() => ({ status: 'available' })),
    markVersionAsIndexed: vi.fn(async () => {}),
    stats: vi.fn(async () => ({ docs: 0, vecDocs: 0 })),
    supportsFolderMembership: vi.fn(() => true),
    getConnectionGeneration: vi.fn(() => 1),
    addConnectionListener: vi.fn(() => () => {}),
  },
  nativeMemorySearch: {
    search: vi.fn(async (q, options) => { failIfDown(); return searchRows(q, options); }),
    read: vi.fn(async (timestampMs, toleranceMs) => {
      failIfDown();
      return helper.rows.filter(r => Math.abs(r.dateMs - timestampMs) <= toleranceMs).map(r => ({ ...r }));
    }),
  },
}));

let handler = null;
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async keys => (keys && typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {})),
      set: vi.fn(async () => {}),
    },
  },
  runtime: {
    onMessage: { addListener: vi.fn(l => { handler = l; }), removeListener: vi.fn() },
    sendMessage: vi.fn(),
  },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  folders: { query: vi.fn(async () => []) },
  accounts: { get: vi.fn(async () => null) },
};

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

// The background owns the helper; what it sends is never delivered to itself.
const CONTEXTS = {
  'the background, no other page open': () => {
    helper.owner = true;
    browser.runtime.sendMessage = vi.fn(async () => { throw new Error(NO_RECEIVER); });
  },
  'the background, a page open that does not answer': () => {
    helper.owner = true;
    browser.runtime.sendMessage = vi.fn(async () => undefined);
  },
  // A page does not own the helper; the background's handler answers it.
  'a page': () => {
    helper.owner = false;
    browser.runtime.sendMessage = vi.fn(message => new Promise(resolve => {
      if (handler(message, {}, resolve) !== true) resolve(undefined);
    }));
  },
};

const HOUR_MS = 60 * 60 * 1000;
let memorySearch;
let memoryRead;
let entry;

beforeAll(async () => {
  const engine = await import('../fts/engine.js');
  await engine.initFtsEngine();
  expect(handler).toBeTypeOf('function');
  memorySearch = await import('../chat/tools/memory_search.js');
  memoryRead = await import('../chat/tools/memory_read.js');
});

beforeEach(() => {
  helper.down = false;
  entry = {
    memId: 'turn:lighthouse',
    sessionId: 'persistent_chat',
    role: 'exchange',
    content: '[USER]: when is the lighthouse trip?\n\n[AGENT]: Saturday at nine.',
    dateMs: Date.now() - HOUR_MS,
  };
  helper.rows = [entry];
  memorySearch.resetPaginationSessions();
});

// What a search sent on the runtime: the background calls the helper directly
// and sends nothing; a page sends only its own search requests (#174).
function expectOnlyOwnRequests(name) {
  const sent = browser.runtime.sendMessage.mock.calls.map(c => c[0]);
  if (name === 'a page') {
    expect(sent.length).toBeGreaterThan(0);
    for (const msg of sent) expect(msg).toMatchObject({ type: 'fts', cmd: 'memorySearch' });
  } else {
    expect(sent).toEqual([]);
  }
}

describe('memory tools answer in every context (#155)', () => {
  for (const [name, enter] of Object.entries(CONTEXTS)) {
    it(`memory_search finds the conversation from ${name}`, async () => {
      enter();
      const result = await memorySearch.run({ query: 'lighthouse' });
      expect(result.error).toBeUndefined();
      expect(result.results).toContain(`[timestamp: ${entry.dateMs}]`);
      expect(result.results).toContain('lighthouse trip');
      expectOnlyOwnRequests(name);
    });

    it(`memory_search lists recent conversations from ${name}`, async () => {
      enter();
      const result = await memorySearch.run({ query: '' });
      expect(result.error).toBeUndefined();
      expect(result.results).toContain(`[timestamp: ${entry.dateMs}]`);
      expectOnlyOwnRequests(name);
    });

    it(`memory_read reads the whole conversation from ${name}`, async () => {
      enter();
      const result = await memoryRead.run({ timestamp: entry.dateMs });
      expect(typeof result).toBe('string');
      expect(result).toContain('--- Conversation from');
      expect(result).toContain(entry.content);
    });

    it(`both tools report a helper failure from ${name} as a page does`, async () => {
      enter();
      helper.down = true;
      await expect(memorySearch.run({ query: 'lighthouse' })).resolves.toEqual({
        error: 'memory search failed: Native FTS helper not connected',
      });
      await expect(memoryRead.run({ timestamp: entry.dateMs })).resolves.toEqual({
        error: 'memory read failed: Native FTS helper not connected',
      });
    });

    // The listing step succeeds and the whole read then fails: a failure, never "nothing found".
    it(`memory_read reports a failed whole read from ${name}`, async () => {
      enter();
      const { nativeMemorySearch } = await import('../fts/nativeEngine.js');
      nativeMemorySearch.read.mockImplementationOnce(async () => { throw new Error('Native RPC timed out'); });
      await expect(memoryRead.run({ timestamp: entry.dateMs })).resolves.toEqual({
        error: 'memory read failed: Native RPC timed out',
      });
      expect(nativeMemorySearch.read).toHaveBeenCalled();
    });
  }
});

// The helper gets the same requests from the background as from a page: the
// same query, dates, limit, preview length and read tolerance (the caps that
// keep each reply under the 1 MiB native message limit, TB-069 and TB-194).
describe('the helper is asked the same from every context (#155)', () => {
  const day = ms => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  async function asked(name, act) {
    const { nativeMemorySearch } = await import('../fts/nativeEngine.js');
    CONTEXTS[name]();
    memorySearch.resetPaginationSessions();
    nativeMemorySearch.search.mockClear();
    nativeMemorySearch.read.mockClear();
    await act();
    return JSON.stringify({ search: nativeMemorySearch.search.mock.calls, read: nativeMemorySearch.read.mock.calls });
  }
  const CALLS = {
    'a dated search': () => memorySearch.run({ query: 'lighthouse', from_date: day(entry.dateMs), to_date: day(entry.dateMs) }),
    'a listing': () => memorySearch.run({ query: '' }),
    'a whole read': () => memoryRead.run({ timestamp: entry.dateMs }),
  };
  for (const [what, act] of Object.entries(CALLS)) {
    it(`${what}`, async () => {
      const page = await asked('a page', act);
      expect(page).not.toBe(JSON.stringify({ search: [], read: [] }));
      for (const background of ['the background, no other page open', 'the background, a page open that does not answer']) {
        expect(await asked(background, act)).toBe(page);
      }
    });
  }
});
