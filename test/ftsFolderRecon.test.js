/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// ftsFolderRecon.test.js — Tests for the evidence-triggered per-folder set
// reconcile (Phase 1c of runPostInitReconcile) and the drain-empty re-run.
// See PLAN_FOLDER_SET_RECONCILE.md / ADR-021.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    agentQueues: { ftsIncremental: {} },
    eventLogger: { enabled: false },
  },
}));

vi.mock('../agent/modules/eventLogger.js', () => ({
  logFtsBatchOperation: vi.fn(),
  logFtsOperation: vi.fn(),
  logMessageEventBatch: vi.fn(),
  logMoveEvent: vi.fn(),
}));

vi.mock('../agent/modules/utils.js', () => ({
  headerIDToWeID: vi.fn(),
  log: vi.fn(),
  // Real-ish parseUniqueId (first-two-colons split) — the orphan sweep's
  // fast path depends on its actual behavior, including the ':'-in-folder
  // parse edge.
  parseUniqueId: vi.fn((uniqueId) => {
    if (!uniqueId || typeof uniqueId !== 'string') return null;
    const i1 = uniqueId.indexOf(':');
    if (i1 === -1) return null;
    const i2 = uniqueId.indexOf(':', i1 + 1);
    if (i2 === -1) return null;
    const headerID = uniqueId.substring(i2 + 1);
    if (!headerID) return null;
    return {
      weFolder: { accountId: uniqueId.substring(0, i1), path: uniqueId.substring(i1 + 1, i2) },
      headerID,
    };
  }),
  recheckMessageInFolder: vi.fn(async () => 'absent'),
  getUniqueMessageKey: vi.fn(),
}));

vi.mock('../fts/indexer.js', () => ({
  buildBatchHeader: vi.fn(),
  populateBatchBody: vi.fn(),
}));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefault) => {
        if (typeof keyOrDefault === 'string') {
          return { [keyOrDefault]: storageData[keyOrDefault] || null };
        }
        const result = {};
        for (const [k, def] of Object.entries(keyOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => { Object.assign(storageData, obj); }),
      remove: vi.fn(async (key) => { delete storageData[key]; }),
    },
  },
  accounts: {
    list: vi.fn(async () => []),
  },
};

const { logFtsBatchOperation, logFtsOperation } = await import('../agent/modules/eventLogger.js');
const { recheckMessageInFolder } = await import('../agent/modules/utils.js');
const { _testExports } = await import('../fts/incrementalIndexer.js');
const {
  _runFolderReconcile,
  _maybeScheduleFolderReconRerun,
  _getFolderReconDrainSkipped,
  _resetFolderReconState,
  _getPendingUpdates,
  _setIsEnabled,
  _setExperimentListenersActive,
  _setFtsSearch,
  _setIndexerDisposed,
  FOLDER_RECON_STORAGE_KEY,
  FOLDER_RECON_INITIAL_SCAN_KEY,
  FOLDER_RECON_MISSING_MAX_DEFICIT,
} = _testExports;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const URI_A = 'imap://user@host/INBOX';
const URI_B = 'imap://user@host/%5BGmail%5D/All%20Mail';
const URI_C = 'imap://user@host/INBOX/a%3Ab';

function folderA(over = {}) {
  return {
    accountId: 'account1',
    folderPath: '/INBOX',
    folderURI: URI_A,
    serverType: 'imap',
    totalMessages: 2,
    ...over,
  };
}

function folderB(over = {}) {
  return {
    accountId: 'account3',
    folderPath: '/[Gmail]/All Mail',
    folderURI: URI_B,
    serverType: 'imap',
    totalMessages: 1,
    ...over,
  };
}

const KEY_A = (headerId) => `account1:/INBOX:${headerId}`;
const KEY_B = (headerId) => `account3:/[Gmail]/All Mail:${headerId}`;

/**
 * Live Set-backed fake FTS store implementing the range RPCs with real
 * half-open-range semantics, so counts stay self-consistent with removals.
 */
function makeFtsStore(initialKeys = []) {
  const keys = new Set(initialKeys);
  const sorted = () => [...keys].sort();
  return {
    _keys: keys,
    countMsgIdRange: vi.fn(async (s, e) => ({
      ok: true,
      count: sorted().filter(k => k >= s && k < e).length,
    })),
    listMsgIdRange: vi.fn(async (s, e, afterKey, limit) => {
      const inRange = sorted().filter(k => k >= s && k < e && (afterKey == null || k > afterKey));
      const page = inRange.slice(0, limit);
      return { ok: true, msgIds: page, done: page.length < limit };
    }),
    removeBatch: vi.fn(async (ids) => {
      for (const id of ids) keys.delete(id);
      return { ok: true, count: ids.length };
    }),
    getMessageByMsgId: vi.fn(async (id) => (keys.has(id) ? { msgId: id } : null)),
    filterNewMessages: vi.fn(async (rows) => ({
      ok: true,
      newMsgIds: rows.map(r => r.msgId).filter(id => !keys.has(id)),
    })),
    findByHeaderMessageId: vi.fn(async () => []),
    stats: vi.fn(async () => ({ ok: true, docs: keys.size })),
  };
}

/**
 * Install a browser.tmMsgNotify mock.
 * - msgDbByURI: folderURI -> Set of headerMessageIds present in the msgDB
 *   (probeMessageIds reports the rest as missing).
 * - probeErrorByURI: folderURI -> error string for probeMessageIds.
 * - keysByURI / infosByURI: listKeysAboveKey / getMessageInfosForKeys
 *   results for the missing direction.
 */
function mockNotify(folders, { msgDbByURI = {}, probeErrorByURI = {}, keysByURI = {}, infosByURI = {} } = {}) {
  const byURI = Object.fromEntries(folders.map(f => [f.folderURI, f]));
  const api = {
    getFolderCounts: vi.fn(async () => folders),
    probeMessageIds: vi.fn(async (uri, headerIds) => {
      if (probeErrorByURI[uri]) return { missing: [], error: probeErrorByURI[uri] };
      const present = msgDbByURI[uri] || new Set();
      return { missing: (headerIds || []).filter(id => !present.has(id)) };
    }),
    listKeysAboveKey: vi.fn(async (uri, _sinceKey, _maxKeys) =>
      keysByURI[uri] || { keys: [], truncated: false, totalAbove: 0 }
    ),
    getMessageInfosForKeys: vi.fn(async (uri, keys) => {
      if (infosByURI[uri]) return infosByURI[uri];
      const f = byURI[uri];
      return {
        infos: keys.map(k => ({
          headerMessageId: `msg-${k}@example.com`,
          weMsgId: null,
          weFolderId: null,
          folderPath: f.folderPath,
          accountId: f.accountId,
          subject: `subject ${k}`,
          author: 'a@example.com',
          dateMs: 0,
          msgKey: k,
          eventType: 'cursorScan',
        })),
      };
    }),
  };
  globalThis.browser.tmMsgNotify = api;
  return api;
}

function seedMemo(folders) {
  storageData[FOLDER_RECON_STORAGE_KEY] = { version: 1, folders };
}

function storedMemo() {
  return storageData[FOLDER_RECON_STORAGE_KEY];
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) delete storageData[key];
  // The whole phase is gated on the initial FULL scan's completion flag
  // (add-side completeness precondition) — tests assume a completed scan
  // unless they explicitly clear it.
  storageData[FOLDER_RECON_INITIAL_SCAN_KEY] = true;
  delete globalThis.browser.tmMsgNotify;
  globalThis.browser.accounts.list.mockImplementation(async () => []);
  recheckMessageInFolder.mockImplementation(async () => 'absent');
  _getPendingUpdates().clear();
  _resetFolderReconState();
  _setIsEnabled(true);
  _setExperimentListenersActive(true);
  // Module-level engine stays null: enqueues land in the pending map but the
  // drain loop early-returns, keeping tests deterministic. The reconcile
  // itself receives its store as an explicit argument.
  _setFtsSearch(null);
  _setIndexerDisposed(false);
});

// ---------------------------------------------------------------------------
// _runFolderReconcile — evidence check + memo
// ---------------------------------------------------------------------------

describe('_runFolderReconcile evidence check', () => {
  it('counts equal → no listing/probing, memo written on the first clean pass', async () => {
    const fts = makeFtsStore([KEY_A('a@example.com'), KEY_A('b@example.com')]);
    const api = mockNotify([folderA({ totalMessages: 2 })]);

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersClean).toBe(1);
    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
    expect(api.probeMessageIds).not.toHaveBeenCalled();
    expect(api.listKeysAboveKey).not.toHaveBeenCalled();
    expect(fts.removeBatch).not.toHaveBeenCalled();

    expect(storedMemo().folders['account1:/INBOX']).toMatchObject({
      lastCleanMsgCount: 2,
      lastCleanFtsCount: 2,
    });
  });

  it('memo hit → zero work (no listing, probing, filtering, or removals)', async () => {
    // Biased folder (permanent ftsCount > msgCount, e.g. unindexable
    // no-key messages absorbed by a previous clean pass).
    seedMemo({ 'account1:/INBOX': { lastCleanMsgCount: 2, lastCleanFtsCount: 3, updatedAtMs: 1 } });
    const fts = makeFtsStore([KEY_A('a@example.com'), KEY_A('b@example.com'), KEY_A('c@example.com')]);
    const api = mockNotify([folderA({ totalMessages: 2 })]);

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersMemoHit).toBe(1);
    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
    expect(api.probeMessageIds).not.toHaveBeenCalled();
    expect(fts.filterNewMessages).not.toHaveBeenCalled();
    expect(fts.removeBatch).not.toHaveBeenCalled();
    // Memo unchanged
    expect(storedMemo().folders['account1:/INBOX'].updatedAtMs).toBe(1);
  });

  it('folder reported with an error is skipped without any FTS work', async () => {
    const fts = makeFtsStore([KEY_A('a@example.com')]);
    mockNotify([folderA({ error: 'summary out of date' })]);

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersErrored).toBe(1);
    // Only the feature-detect probe touched countMsgIdRange
    expect(fts.countMsgIdRange).toHaveBeenCalledTimes(1);
    expect(storedMemo()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Stale direction (ftsCount > msgCount)
// ---------------------------------------------------------------------------

describe('stale direction', () => {
  it('probe misses go through verify-then-remove: absent→removed, present→kept', async () => {
    const fts = makeFtsStore([
      KEY_A('a@example.com'),
      KEY_A('ghost@example.com'),
      KEY_A('transient@example.com'),
    ]);
    const api = mockNotify([folderA({ totalMessages: 1 })], {
      msgDbByURI: { [URI_A]: new Set(['a@example.com']) },
    });
    recheckMessageInFolder.mockImplementation(async (headerID) =>
      headerID === 'ghost@example.com' ? 'absent' : 'present'
    );

    const stats = await _runFolderReconcile(fts);

    expect(api.probeMessageIds).toHaveBeenCalled();
    expect(stats.staleCandidates).toBe(2);
    expect(stats.staleRemoved).toBe(1);
    expect(stats.recheckKeptPresent).toBe(1);
    expect(fts._keys.has(KEY_A('ghost@example.com'))).toBe(false);
    expect(fts._keys.has(KEY_A('transient@example.com'))).toBe(true);
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'stale_removed',
      expect.objectContaining({ msgId: KEY_A('ghost@example.com') }));
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'recheck_present',
      expect.objectContaining({ msgId: KEY_A('transient@example.com') }));

    // Clean pass → memo pair uses the post-removal recount
    expect(storedMemo().folders['account1:/INBOX']).toMatchObject({
      lastCleanMsgCount: 1,
      lastCleanFtsCount: 2,
    });
  });

  it('recheck error keeps the entry and blocks the memo write', async () => {
    const fts = makeFtsStore([KEY_A('a@example.com'), KEY_A('unsure@example.com')]);
    mockNotify([folderA({ totalMessages: 1 })], {
      msgDbByURI: { [URI_A]: new Set(['a@example.com']) },
    });
    recheckMessageInFolder.mockImplementation(async () => 'error');

    const stats = await _runFolderReconcile(fts);

    expect(stats.recheckKeptError).toBe(1);
    expect(stats.foldersFailed).toBe(1);
    expect(fts.removeBatch).not.toHaveBeenCalled();
    expect(fts._keys.has(KEY_A('unsure@example.com'))).toBe(true);
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'recheck_error',
      expect.objectContaining({ msgId: KEY_A('unsure@example.com') }));
    expect(storedMemo()).toBeUndefined();
  });

  it('removeBatch throw → no memo write, retried next boot', async () => {
    const fts = makeFtsStore([KEY_A('a@example.com'), KEY_A('ghost@example.com')]);
    mockNotify([folderA({ totalMessages: 1 })], {
      msgDbByURI: { [URI_A]: new Set(['a@example.com']) },
    });
    fts.removeBatch.mockImplementation(async () => { throw new Error('native down'); });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersFailed).toBe(1);
    expect(stats.staleRemoved).toBe(0);
    expect(storedMemo()).toBeUndefined();
  });

  it('probe error aborts the folder without a memo write', async () => {
    const fts = makeFtsStore([KEY_A('a@example.com'), KEY_A('b@example.com')]);
    mockNotify([folderA({ totalMessages: 1 })], {
      probeErrorByURI: { [URI_A]: 'msgDB busy' },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersFailed).toBe(1);
    expect(fts.removeBatch).not.toHaveBeenCalled();
    expect(storedMemo()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Missing direction (msgCount > ftsCount)
// ---------------------------------------------------------------------------

describe('missing direction', () => {
  it('filterNewMessages misses are enqueued into the drain queue; memo written after the clean pass', async () => {
    const fts = makeFtsStore([KEY_A('msg-1@example.com')]);
    mockNotify([folderA({ totalMessages: 3 })], {
      keysByURI: { [URI_A]: { keys: [1, 2, 3], truncated: false, totalAbove: 3 } },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.missingEnqueued).toBe(2);
    const pending = _getPendingUpdates();
    expect(pending.size).toBe(2);
    const entry = pending.get(KEY_A('msg-2@example.com'));
    expect(entry).toBeTruthy();
    expect(entry.type).toBe('new');
    expect(entry.metadata.fromCursorScan).toBe(true);
    expect(pending.has(KEY_A('msg-3@example.com'))).toBe(true);
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'missing_enqueued',
      expect.objectContaining({ msgId: KEY_A('msg-2@example.com') }));

    // Memo pair carries the CURRENT ftsCount (drain hasn't run yet) —
    // next boot's count movement re-checks the folder.
    expect(storedMemo().folders['account1:/INBOX']).toMatchObject({
      lastCleanMsgCount: 3,
      lastCleanFtsCount: 1,
    });
  });

  it('getMessageInfosForKeys error → no memo, folder retried next boot', async () => {
    const fts = makeFtsStore([KEY_A('msg-1@example.com')]);
    mockNotify([folderA({ totalMessages: 3 })], {
      keysByURI: { [URI_A]: { keys: [1, 2, 3], truncated: false, totalAbove: 3 } },
      infosByURI: { [URI_A]: { infos: [], error: 'native boom' } },
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersFailed).toBe(1);
    expect(_getPendingUpdates().size).toBe(0);
    expect(storedMemo()).toBeUndefined();
  });

  it('deficit above the cap → walk skipped, nothing enqueued, no memo (bulk-unindexed history)', async () => {
    const fts = makeFtsStore([KEY_A('msg-1@example.com')]); // ftsCount = 1
    const api = mockNotify([folderA({ totalMessages: 1 + FOLDER_RECON_MISSING_MAX_DEFICIT + 1 })]);

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersDeficitCapped).toBe(1);
    expect(api.listKeysAboveKey).not.toHaveBeenCalled();
    expect(_getPendingUpdates().size).toBe(0);
    expect(storedMemo()).toBeUndefined(); // NOT memoized — heals once coverage converges
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'missing_deficit_capped',
      expect.objectContaining({ deficit: FOLDER_RECON_MISSING_MAX_DEFICIT + 1 }));
  });

  it('deficit exactly at the cap → missing-direction walk still runs', async () => {
    const fts = makeFtsStore([]); // ftsCount = 0
    const api = mockNotify([folderA({ totalMessages: FOLDER_RECON_MISSING_MAX_DEFICIT })], {
      keysByURI: { [URI_A]: { keys: [1], truncated: false, totalAbove: 1 } },
    });

    const stats = await _runFolderReconcile(fts);

    expect(api.listKeysAboveKey).toHaveBeenCalledTimes(1);
    expect(stats.foldersDeficitCapped).toBe(0);
    expect(stats.missingEnqueued).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Drain-quiet gate + drain-empty re-run
// ---------------------------------------------------------------------------

describe('drain-quiet gate and drain-empty re-run', () => {
  it('drain-busy folder is skipped; the drain-empty re-run processes it exactly once', async () => {
    const fts = makeFtsStore([KEY_A('a@example.com'), KEY_A('b@example.com'), KEY_B('x@example.com')]);
    const api = mockNotify([folderA({ totalMessages: 2 }), folderB({ totalMessages: 1 })]);

    // Pending update in folder A → its counts are in flux
    _getPendingUpdates().set(KEY_A('inflight@example.com'), {
      type: 'new',
      uniqueKey: KEY_A('inflight@example.com'),
      timestamp: Date.now(),
      metadata: {},
    });

    const stats = await _runFolderReconcile(fts);

    expect(stats.foldersDrainBusy).toBe(1);
    expect(_getFolderReconDrainSkipped().has('account1:/INBOX')).toBe(true);
    // Folder B was clean and memoized; folder A untouched
    expect(storedMemo().folders['account3:/[Gmail]/All Mail']).toBeTruthy();
    expect(storedMemo().folders['account1:/INBOX']).toBeUndefined();

    // Queue drains → re-run covers exactly the skipped folder
    _getPendingUpdates().clear();
    _setFtsSearch(fts);
    const getFolderCountsCallsBefore = api.getFolderCounts.mock.calls.length;
    const rerun = _maybeScheduleFolderReconRerun();
    expect(rerun).toBeTruthy();
    await rerun;

    expect(api.getFolderCounts.mock.calls.length).toBe(getFolderCountsCallsBefore + 1);
    expect(storedMemo().folders['account1:/INBOX']).toMatchObject({
      lastCleanMsgCount: 2,
      lastCleanFtsCount: 2,
    });
    expect(_getFolderReconDrainSkipped().size).toBe(0);

    // Single-shot per boot: a second drain-empty does nothing
    _getFolderReconDrainSkipped().add('account1:/INBOX');
    expect(_maybeScheduleFolderReconRerun()).toBeUndefined();
  });

  it('re-run is not scheduled when nothing was skipped', () => {
    _setFtsSearch(makeFtsStore([]));
    expect(_maybeScheduleFolderReconRerun()).toBeUndefined();
  });

  it('processPendingUpdates wires the re-run hook into its drain-empty branch (source contract)', () => {
    const src = readFileSync(fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url)), 'utf8');
    const drainEmptyBranch = src.match(/if \(_pendingUpdates\.size === 0\) \{[\s\S]*?\} else \{/);
    expect(drainEmptyBranch).toBeTruthy();
    expect(drainEmptyBranch[0]).toContain('clearPersistedUpdates()');
    expect(drainEmptyBranch[0]).toContain('_maybeScheduleFolderReconRerun()');
  });
});

// ---------------------------------------------------------------------------
// Feature detection / availability
// ---------------------------------------------------------------------------

describe('availability gating', () => {
  it('initial FTS scan incomplete → whole phase skipped (invariant precondition)', async () => {
    delete storageData[FOLDER_RECON_INITIAL_SCAN_KEY];
    const fts = makeFtsStore([KEY_A('a@example.com')]);
    const api = mockNotify([folderA({ totalMessages: 1 })]);

    const result = await _runFolderReconcile(fts);

    expect(result.skipped).toBe(true);
    expect(result.reason).toBe('initial_scan_incomplete');
    expect(api.getFolderCounts).not.toHaveBeenCalled();
    expect(logFtsBatchOperation).toHaveBeenCalledWith('folder_recon', 'skipped_initial_scan_incomplete', {});
  });

  it('native RPC unsupported → whole phase no-ops, logged once per session', async () => {
    const fts = makeFtsStore([]);
    fts.countMsgIdRange.mockImplementation(async () => {
      throw new Error('Unknown reader method: countMsgIdRange');
    });
    const api = mockNotify([folderA()]);

    const first = await _runFolderReconcile(fts);
    expect(first.skipped).toBe(true);
    expect(first.reason).toBe('native_unsupported');
    expect(api.getFolderCounts).not.toHaveBeenCalled();

    const second = await _runFolderReconcile(fts);
    expect(second.skipped).toBe(true);

    const unsupportedLogs = logFtsBatchOperation.mock.calls
      .filter(([op, status]) => op === 'folder_recon' && status === 'unsupported');
    expect(unsupportedLogs).toHaveLength(1);
    // The failed probe is the only native call — no retry per run
    expect(fts.countMsgIdRange).toHaveBeenCalledTimes(1);
  });

  it('experiment unavailable → skip cleanly', async () => {
    const fts = makeFtsStore([]);
    // No browser.tmMsgNotify at all
    const noApi = await _runFolderReconcile(fts);
    expect(noApi.skipped).toBe(true);
    expect(noApi.reason).toBe('no_experiment');

    // Old deployed experiment without the new functions
    globalThis.browser.tmMsgNotify = { getCursorFolders: vi.fn() };
    const oldApi = await _runFolderReconcile(fts);
    expect(oldApi.skipped).toBe(true);
    expect(oldApi.reason).toBe('no_experiment');
    expect(fts.countMsgIdRange).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Orphaned-prefix sweep
// ---------------------------------------------------------------------------

describe('orphaned-prefix sweep', () => {
  function setupOrphanScenario({ recheckVerdict = 'absent' } = {}) {
    // Folder A (clean) + folder C whose path contains ':' (the parse edge).
    const parseEdgeKey = 'account1:/INBOX/a:b:y@example.com';
    const ghostKey = 'ghostAcct:/Gone:x@example.com';
    const fts = makeFtsStore([KEY_A('a@example.com'), parseEdgeKey, ghostKey]);
    mockNotify([
      folderA({ totalMessages: 1 }),
      { accountId: 'account1', folderPath: '/INBOX/a:b', folderURI: URI_C, serverType: 'imap', totalMessages: 1 },
    ]);
    globalThis.browser.accounts.list.mockImplementation(async () => [{
      id: 'account1',
      rootFolder: {
        path: '/',
        subFolders: [
          { path: '/INBOX', subFolders: [{ path: '/INBOX/a:b', subFolders: [] }] },
        ],
      },
    }]);
    recheckMessageInFolder.mockImplementation(async () => recheckVerdict);
    return { fts, parseEdgeKey, ghostKey };
  }

  it('removes keys under a truly absent folder prefix, keeps the existing-folder parse edge', async () => {
    const { fts, parseEdgeKey, ghostKey } = setupOrphanScenario();

    const stats = await _runFolderReconcile(fts);

    expect(stats.orphanRemoved).toBe(1);
    expect(fts._keys.has(ghostKey)).toBe(false);
    expect(fts._keys.has(parseEdgeKey)).toBe(true);
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'orphan_removed',
      expect.objectContaining({ msgId: ghostKey }));
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'orphan_kept_folder_exists',
      expect.objectContaining({ msgId: parseEdgeKey }));
  });

  it('keeps an orphan-prefix key whose recheck does not confirm absence', async () => {
    const { fts, ghostKey } = setupOrphanScenario({ recheckVerdict: 'error' });

    const stats = await _runFolderReconcile(fts);

    expect(stats.orphanRemoved).toBe(0);
    expect(fts._keys.has(ghostKey)).toBe(true);
    expect(logFtsOperation).toHaveBeenCalledWith('folder_recon', 'orphan_kept_recheck',
      expect.objectContaining({ msgId: ghostKey, verdict: 'error' }));
  });

  it('does not walk the keyspace when totals match (no count evidence)', async () => {
    const fts = makeFtsStore([KEY_A('a@example.com'), KEY_A('b@example.com')]);
    mockNotify([folderA({ totalMessages: 2 })]);

    await _runFolderReconcile(fts);

    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
  });

  it('skips the sweep when a folder was skipped before counting (evidence incomplete)', async () => {
    // Folder B errored → its ftsCount never entered the sum, so
    // totalAll > totalKnown is vacuous — no full-keyspace walk.
    const fts = makeFtsStore([KEY_A('a@example.com'), KEY_A('b@example.com'), KEY_B('x@example.com')]);
    mockNotify([folderA({ totalMessages: 2 }), folderB({ error: 'summary out of date' })]);

    await _runFolderReconcile(fts);

    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
  });
});
