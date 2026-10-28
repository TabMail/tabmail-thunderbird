/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #170: email_search answers in every context that runs it. The chat window
// runs it in its page; headless runs (proactive check-ins, reply generation,
// compose edits) run it in the background, which owns the native helper. A runtime message is not delivered to the sender's own frame
// (MDN runtime.sendMessage), so a message the background sends never reaches
// its own FTS command handler: it rejects when no other extension page is
// open, and resolves undefined when one is open but does not answer.
//
// This runs the real FTS command handler (initFtsEngine) over a stand-in
// helper that holds indexed mail, and runs the tool as the background (owner
// of the helper, messages to itself lost) and as a page (messages answered by
// that handler). Each must give the helper's answer, a helper failure must
// read the same in both, and the helper must be asked the same from both.

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({ owner: false, down: false, rows: [] }));

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

// Attachment flags come from the index for this account.
vi.mock('../fts/attachmentFlags.js', () => ({
  accountIdOfMsgId: vi.fn(() => 'account1'),
  getAttachmentRepairedAccounts: vi.fn(async () => new Set(['account1'])),
}));
// A list shows each item's subject, one per line.
vi.mock('../chat/modules/helpers.js', () => ({
  formatMailList: vi.fn(items => items.map(i => i.subject).join('\n')),
  toIsoNoMs: vi.fn((d = new Date()) => d.toISOString().replace(/\.\d{3}Z$/, 'Z')),
}));

// The helper's index: a query matches mail whose subject holds one of its words.
function searchRows(q, { limit, sort }) {
  const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
  const rows = helper.rows.filter(r => words.some(w => r.subject.toLowerCase().includes(w)));
  if (sort === 'date_desc') rows.sort((a, b) => b.dateMs - a.dateMs);
  if (sort === 'date_asc') rows.sort((a, b) => a.dateMs - b.dateMs);
  return rows.slice(0, limit).map(r => ({ ...r }));
}

function failIfDown() {
  if (helper.down) throw new Error('Native FTS helper not connected');
}

vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(async () => { helper.owner = true; return true; }),
  ownsNativeHelper: () => helper.owner,
  nativeFtsSearch: {
    search: vi.fn(async (q, options) => { failIfDown(); return searchRows(q, options); }),
    checkReindexNeeded: vi.fn(async () => ({ needsReindex: false, isFirstRun: false })),
    getHostAvailability: vi.fn(() => true),
    getHostStatus: vi.fn(() => ({ status: 'available' })),
    markVersionAsIndexed: vi.fn(async () => {}),
    stats: vi.fn(async () => ({ docs: 0, vecDocs: 0 })),
    supportsFolderMembership: vi.fn(() => true),
    getConnectionGeneration: vi.fn(() => 1),
    addConnectionListener: vi.fn(() => () => {}),
  },
  nativeMemorySearch: {},
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
let emailSearch;
let native;

beforeAll(async () => {
  const engine = await import('../fts/engine.js');
  await engine.initFtsEngine();
  expect(handler).toBeTypeOf('function');
  emailSearch = await import('../chat/tools/email_search.js');
  native = await import('../fts/nativeEngine.js');
});

beforeEach(() => {
  helper.down = false;
  helper.rows = [
    { uniqueId: 'account1:/INBOX:older@example.com', subject: 'Harbour trip plan', author: 'sender@example.com', dateMs: Date.now() - 2 * HOUR_MS, hasAttachments: false },
    { uniqueId: 'account1:/INBOX:newer@example.com', subject: 'Harbour trip tickets', author: 'sender@example.com', dateMs: Date.now() - HOUR_MS, hasAttachments: true },
  ];
  emailSearch.resetPaginationSessions();
});

const SORTED = ['relevance', 'date_desc', 'date_asc'];

describe('email_search answers in every context (#170)', () => {
  for (const [name, enter] of Object.entries(CONTEXTS)) {
    it(`finds the mail from ${name}`, async () => {
      enter();
      const result = await emailSearch.run({ query: 'harbour' });
      expect(result.error).toBeUndefined();
      expect(result.results).toContain('Harbour trip plan');
      expect(result.results).toContain('Harbour trip tickets');
      expect(result.totalItems).toBe(2);
    });

    it(`keeps the order asked for from ${name}`, async () => {
      enter();
      const result = await emailSearch.run({ query: 'harbour', sort: 'date_asc' });
      expect(result.results.split('\n')).toEqual(['Harbour trip plan', 'Harbour trip tickets']);
    });

    it(`reports a helper failure from ${name} as a page does`, async () => {
      enter();
      helper.down = true;
      await expect(emailSearch.run({ query: 'harbour' })).resolves.toEqual({
        error: 'fts search failed: Native FTS helper not connected',
      });
    });
  }
});

// The helper gets the same request from the background as from a page: the
// same query, dates, limit and order.
describe('the helper is asked the same from every context (#170)', () => {
  const day = ms => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  async function asked(name, args) {
    CONTEXTS[name]();
    emailSearch.resetPaginationSessions();
    native.nativeFtsSearch.search.mockClear();
    await emailSearch.run(args);
    return JSON.stringify(native.nativeFtsSearch.search.mock.calls);
  }
  for (const sort of SORTED) {
    it(`a dated search sorted by ${sort}`, async () => {
      const args = { query: 'harbour', from_date: day(Date.now() - 3 * HOUR_MS), to_date: day(Date.now()), sort };
      const page = await asked('a page', args);
      expect(page).not.toBe('[]');
      for (const background of ['the background, no other page open', 'the background, a page open that does not answer']) {
        expect(await asked(background, args)).toBe(page);
      }
    });
  }
});
