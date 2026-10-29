/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #175: the background owns the native FTS helper and answers the {type: "fts"}
// requests other extension pages (the chat window, settings) send it. While the
// helper is missing, still connecting, or back after an install, a page's request
// gets the answer the background's own direct call gets: the helper's result, or
// its error at once. It is never left unanswered, which a page reads as "not
// ready yet" and retries until its wait runs out, and which a page that does not
// retry reads as success.
//
// This runs the real FTS engine (initFtsEngine and its command handler) over a
// stand-in helper that can be missing or slow to connect, and the real chat tools
// as a page and as the background.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const NOT_CONNECTED = 'Native FTS helper not connected';

const helper = vi.hoisted(() => ({
  owner: false,
  missing: false,
  // Resolves when the helper finishes connecting; null when it is not connecting.
  connecting: null,
  mail: [],
  memory: [],
}));

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  resolveUniqueMessageKey: vi.fn(async id => id),
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
vi.mock('../fts/attachmentFlags.js', () => ({
  accountIdOfMsgId: vi.fn(() => 'account1'),
  getAttachmentRepairedAccounts: vi.fn(async () => new Set(['account1'])),
}));
vi.mock('../chat/modules/helpers.js', async importOriginal => ({
  ...await importOriginal(),
  formatMailList: vi.fn(items => items.map(i => i.subject).join('\n')),
}));

// As the native engine does: the first init claims the helper for this context
// and fails while the helper is missing; a request waits while the helper is
// connecting, and fails at once while it is missing.
async function connected() {
  if (helper.connecting) await helper.connecting;
  if (helper.missing) throw new Error(NOT_CONNECTED);
}
const words = q => String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
const matching = (rows, q, field) => rows.filter(r => words(q).some(w => r[field].toLowerCase().includes(w)));

vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(async () => { helper.owner = true; await connected(); return true; }),
  ownsNativeHelper: () => helper.owner,
  nativeFtsSearch: {
    search: vi.fn(async (q, { limit }) => { await connected(); return matching(helper.mail, q, 'subject').slice(0, limit); }),
    checkReindexNeeded: vi.fn(async () => { await connected(); return { needsReindex: false, isFirstRun: false }; }),
    getHostAvailability: vi.fn(() => !helper.missing),
    getHostStatus: vi.fn(() => ({ status: helper.missing ? 'missing' : 'available' })),
    markVersionAsIndexed: vi.fn(async () => {}),
    stats: vi.fn(async () => { await connected(); return { docs: helper.mail.length, vecDocs: helper.mail.length }; }),
    supportsFolderMembership: vi.fn(() => true),
    getConnectionGeneration: vi.fn(() => 1),
    addConnectionListener: vi.fn(() => () => {}),
  },
  nativeMemorySearch: {
    search: vi.fn(async (q, { limit }) => { await connected(); return matching(helper.memory, q, 'content').slice(0, limit); }),
    clear: vi.fn(async () => { await connected(); helper.memory = []; return { ok: true }; }),
  },
}));

const listeners = new Set();
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async keys => (keys && typeof keys === 'object' && !Array.isArray(keys) ? { ...keys } : {})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
  runtime: {
    onMessage: {
      addListener: vi.fn(l => { listeners.add(l); }),
      removeListener: vi.fn(l => { listeners.delete(l); }),
    },
    sendMessage: vi.fn(),
  },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
  folders: { query: vi.fn(async () => []) },
  accounts: { get: vi.fn(async () => null), list: vi.fn(async () => []) },
};

const NO_RECEIVER = 'Could not establish connection. Receiving end does not exist.';

// A page's message reaches the background's listeners; one that keeps the
// channel open (returns true) answers it, and with none it resolves undefined.
function sendFromPage(message) {
  return new Promise(resolve => {
    let open = false;
    for (const listener of [...listeners]) {
      if (listener(message, {}, resolve) === true) open = true;
    }
    if (!open) resolve(undefined);
  });
}
const CONTEXTS = {
  'a page': () => {
    helper.owner = false;
    browser.runtime.sendMessage = vi.fn(sendFromPage);
  },
  // What the background sends is never delivered to itself.
  'the background': () => {
    helper.owner = true;
    browser.runtime.sendMessage = vi.fn(async () => { throw new Error(NO_RECEIVER); });
  },
};
const requestsFor = cmd => browser.runtime.sendMessage.mock.calls.filter(([m]) => m?.type === 'fts' && m?.cmd === cmd);

let engine;
let emailSearch;
let memorySearch;

beforeEach(async () => {
  vi.resetModules();
  listeners.clear();
  helper.owner = false;
  helper.missing = false;
  helper.connecting = null;
  helper.mail = [{ uniqueId: 'account1:/INBOX:trip@example.com', subject: 'Harbour trip plan', author: 'sender@example.com', dateMs: Date.now(), hasAttachments: false }];
  helper.memory = [{ memId: 'turn:a', dateMs: Date.now(), content: '[USER]: the harbour trip', snippet: 'harbour trip' }];
  engine = await import('../fts/engine.js');
  emailSearch = await import('../chat/tools/email_search.js');
  memorySearch = await import('../chat/tools/memory_search.js');
});

async function startWithHelperMissing() {
  helper.missing = true;
  await expect(engine.initFtsEngine()).rejects.toThrow(NOT_CONNECTED);
}

describe('a missing helper: a page gets the error at once, as the background does (#175)', () => {
  for (const [name, enter] of Object.entries(CONTEXTS)) {
    it(`email_search from ${name}`, async () => {
      await startWithHelperMissing();
      enter();
      await expect(emailSearch.run({ query: 'harbour' })).resolves.toEqual({ error: `fts search failed: ${NOT_CONNECTED}` });
      // Answered on the first request: no not-ready retries.
      if (name === 'a page') expect(requestsFor('search')).toHaveLength(1);
    });

    it(`memory_search from ${name}`, async () => {
      await startWithHelperMissing();
      enter();
      await expect(memorySearch.run({ query: 'harbour' })).resolves.toEqual({ error: `memory search failed: ${NOT_CONNECTED}` });
      if (name === 'a page') expect(requestsFor('memorySearch')).toHaveLength(1);
    });
  }

  it('a page clearing the chat memory is told it failed, not that it succeeded', async () => {
    await startWithHelperMissing();
    CONTEXTS['a page']();
    await expect(sendFromPage({ type: 'fts', cmd: 'memoryClear' })).resolves.toEqual({ error: NOT_CONNECTED });
    expect(helper.memory).toHaveLength(1);
  });
});

describe('a helper still connecting: a page request waits for it (#175)', () => {
  it('and gets the helper\'s answer on its first request', async () => {
    let finishConnecting;
    helper.connecting = new Promise(resolve => { finishConnecting = resolve; });
    const starting = engine.initFtsEngine();
    // The stand-in's owner flag is shared by both contexts: be the page once the
    // background has claimed the helper.
    const native = await import('../fts/nativeEngine.js');
    await vi.waitFor(() => expect(native.initNativeFts).toHaveBeenCalled());
    CONTEXTS['a page']();
    const searching = emailSearch.run({ query: 'harbour' });
    // Longer than the page's readiness wait, so a page left unanswered gives up.
    await new Promise(resolve => setTimeout(resolve, 300));
    helper.connecting = null;
    finishConnecting();
    await starting;
    const result = await searching;
    expect(result.error).toBeUndefined();
    expect(result.results).toContain('Harbour trip plan');
    expect(requestsFor('search')).toHaveLength(1);
  });
});

describe('a helper installed after startup (#175)', () => {
  it('answers a page once the engine starts, through one handler', async () => {
    await startWithHelperMissing();
    helper.missing = false;
    await engine.initFtsEngine();
    expect(listeners.size).toBe(1);
    CONTEXTS['a page']();
    const result = await emailSearch.run({ query: 'harbour' });
    expect(result.results).toContain('Harbour trip plan');
    expect(requestsFor('search')).toHaveLength(1);
  });
});
