/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFolderMembershipId } from '../fts/folderMembershipIdentity.js';
import { experimentFunctions } from './helpers/experimentFunctions.js';

const reconConfig = {
  folderScanPageSize: 250,
  // Two rows per assignment call, so a multi-row page both shares a batch
  // and crosses batches.
  membershipAssignBatchSize: 2,
  membershipListPageSize: 50,
  membershipStatePageSize: 50,
  digestWorkChunkEntries: 1000,
  missingPageKeys: 500,
  stalePageKeys: 100,
  stalePagesPerSlice: 1,
  rechecksPerSlice: 5,
  enqueuesPerSlice: 20,
  pendingHighWater: 100,
  pendingLowWater: 25,
  paceDelayMs: 25,
  pressureDelayMs: 250,
  errorDelayMs: 1000,
  syncQuietMs: 5000,
  reverifyIntervalMs: 20 * 60 * 1000,
  walkPeriodMs: 24 * 60 * 60 * 1000,
  membershipUnresolvedRetryMs: 10 * 60 * 1000,
  hardFloorMaxElapsedMs: 10 * 60 * 1000,
};

// Capture real primitives before any test installs fake timers. Scheduler
// slices can await native crypto or other event-loop work that advancing the
// virtual clock alone cannot settle.
const realSetTimeout = globalThis.setTimeout.bind(globalThis);
const realDateNow = Date.now.bind(Date);
// Stay below Vitest's outer 5s default so a stuck helper reports this explicit
// scheduler error instead of a generic test timeout.
const SCHEDULER_SETTLE_REAL_DEADLINE_MS = 4_000;
// Real thread-pool latency imposed on every membership digest in the retry
// fixture. Large enough that the bounded real-loop turns granted by virtual
// advancement alone cannot finish a tick; small enough to keep the test quick.
const RETRY_DIGEST_REAL_LATENCY_MS = 50;

function yieldToRealEventLoop() {
  return new Promise(resolve => realSetTimeout(resolve, 0));
}

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    agentQueues: {
      ftsIncremental: {},
      ftsFolderRecon: reconConfig,
    },
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
  getForegroundFetchPressure: vi.fn(() => ({ active: 0, waiting: 0, chatTyping: false })),
  getUniqueMessageKeyCandidates: vi.fn((uniqueId, folders) => {
    const first = uniqueId.indexOf(':');
    if (first <= 0) return [];
    const accountId = uniqueId.slice(0, first);
    return (folders || []).filter(folder =>
      folder.accountId === accountId
      && uniqueId.startsWith(`${accountId}:${folder.path}:`))
      .map(folder => ({
        weFolder: folder,
        headerID: uniqueId.slice(`${accountId}:${folder.path}:`.length),
      }));
  }),
  headerIDToWeID: vi.fn(),
  log: vi.fn(),
  parseUniqueId: vi.fn(),
  resolveUniqueMessageKey: vi.fn(),
  recheckMessageInFolder: vi.fn(async () => 'absent'),
  getUniqueMessageKey: vi.fn(),
}));

vi.mock('../fts/indexer.js', () => ({
  buildBatchHeader: vi.fn(),
  populateBatchBody: vi.fn(),
}));

// The native helper behind the real engine wrappers (fts/engine.js); only
// the traffic fixtures route writes through them.
const fakeNativeFts = vi.hoisted(() => ({ indexBatch: vi.fn() }));
vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(async () => true),
  nativeFtsSearch: fakeNativeFts,
  nativeMemorySearch: {},
}));

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keyOrDefault) => {
        if (typeof keyOrDefault === 'string') {
          return { [keyOrDefault]: storageData[keyOrDefault] ?? null };
        }
        if (Array.isArray(keyOrDefault)) {
          return Object.fromEntries(keyOrDefault.map(key => [key, storageData[key]]));
        }
        return Object.fromEntries(Object.entries(keyOrDefault).map(([key, fallback]) => [
          key,
          storageData[key] === undefined ? fallback : storageData[key],
        ]));
      }),
      set: vi.fn(async obj => Object.assign(storageData, obj)),
      remove: vi.fn(async key => { delete storageData[key]; }),
    },
  },
  accounts: { list: vi.fn(async () => []) },
};

const {
  getForegroundFetchPressure,
  getUniqueMessageKeyCandidates,
  getUniqueMessageKey,
  headerIDToWeID,
  parseUniqueId,
  recheckMessageInFolder,
  resolveUniqueMessageKey,
} = await import('../agent/modules/utils.js');
const { buildBatchHeader, populateBatchBody } = await import('../fts/indexer.js');
const {
  _resetFtsOperationCoordinatorForTests,
  acquireFtsExclusiveOperation,
  clearOwnedFtsScanStatus,
  getFtsMembershipEpoch,
  runFtsMembershipMutation,
  writeOwnedFtsScanStatus,
} = await import('../fts/operationCoordinator.js');
const incrementalIndexer = await import('../fts/incrementalIndexer.js');
const { ftsSearch: engineFtsSearch } = await import('../fts/engine.js');
const { _testExports, flushPendingUpdates, getIncrementalIndexerStatus } = incrementalIndexer;

// The state the deleted volatile pending flag summarised, read from what the
// session actually owes: no walk obligation, no queued update, a finished
// orphan pass, and an outcome snapshot that records completion.
function reconWorkOwed() {
  return _testExports._getFolderReconDirty().size > 0
    || _testExports._getPendingUpdates().size > 0
    || _testExports._getFolderReconEphemeralEvidence().orphanDone !== true;
}

async function sessionSettled() {
  return !reconWorkOwed()
    && (await getIncrementalIndexerStatus()).folderRecon.outcomes.complete === true;
}

// The real producer of dropped queued work: the queue-stuck abandonment of
// every queued update.
async function abandonAllQueued() {
  return _testExports._abandonPendingUpdates([..._testExports._getPendingUpdates().values()], 'queue_stuck');
}

// The orphan tail's quiet predicate for the current generation and serial.
function quietNow() {
  return _testExports._folderReconQuietSince(
    _testExports._getFolderReconGeneration(),
    _testExports._getFolderReconEventSerial(),
  );
}

function emptyDigest() {
  return createHash('sha256').update(Buffer.alloc(0)).digest('hex');
}

function framedDigest(values) {
  const hash = createHash('sha256');
  const encoded = [...new Set(values)].map(value => Buffer.from(value, 'utf8'));
  encoded.sort(Buffer.compare);
  for (const bytes of encoded) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function sqliteBinaryCompare(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sqliteNativeRange(values, start, end, after = null) {
  return [...values]
    .filter(key => sqliteBinaryCompare(key, start) >= 0
      && sqliteBinaryCompare(key, end) < 0
      && (after == null || sqliteBinaryCompare(key, after) > 0))
    .sort(sqliteBinaryCompare);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installEmptyFolders(folderKeys) {
  const folders = folderKeys.map(([accountId, folderPath], index) => ({
    accountId,
    folderPath,
    folderURI: `imap://folder-${index}`,
    serverType: 'imap',
    stableUidKeys: true,
    uidValidity: index + 1,
  }));
  globalThis.browser.accounts.list.mockResolvedValue([{
    id: 'account1',
    type: 'imap',
    rootFolder: {
      path: '/',
      isRoot: true,
      subFolders: folders.map(folder => ({ path: folder.folderPath, subFolders: [] })),
    },
  }]);
  let nextToken = 1;
  globalThis.browser.tmMsgNotify = {
    getFolderState: vi.fn(async (accountId, folderPath) =>
      folders.find(folder => folder.accountId === accountId && folder.folderPath === folderPath)),
    beginFolderMessageScan: vi.fn(async (uri) => {
      const folder = folders.find(item => item.folderURI === uri);
      return {
        token: `t-${nextToken++}`,
        accountId: folder.accountId,
        folderPath: folder.folderPath,
        stableUidKeys: true,
        uidValidity: folder.uidValidity,
      };
    }),
    readFolderMessageScanPage: vi.fn(async () => ({ rows: [], done: true })),
    cancelFolderMessageScan: vi.fn(async () => ({ cancelled: true })),
    probeMessageIds: vi.fn(async () => ({ missing: [] })),
  };
  return {
    fingerprintMsgIdRange: vi.fn(async () => ({ count: 0, sha256: emptyDigest() })),
    countMsgIdRange: vi.fn(async () => ({ count: 0 })),
    listMsgIdRange: vi.fn(async () => ({ msgIds: [], done: true })),
    filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })),
    removeBatch: vi.fn(async () => ({ count: 0 })),
    getMessageByMsgId: vi.fn(async () => null),
    stats: vi.fn(async () => ({})),
  };
}

function installFolderRows(rows, folderOverrides = {}) {
  const folder = {
    accountId: 'account1',
    folderPath: '/Archive',
    folderURI: 'imap://archive',
    serverType: 'imap',
    stableUidKeys: true,
    uidValidity: 7,
    ...folderOverrides,
  };
  globalThis.browser.accounts.list.mockResolvedValue([{
    id: folder.accountId,
    type: folder.serverType,
    rootFolder: {
      path: '/',
      isRoot: true,
      subFolders: [{ path: folder.folderPath, subFolders: [] }],
    },
  }]);
  let nextToken = 1;
  const scans = new Map();
  const rowByKey = new Map(rows.map(row => [row.msgKey, row]));
  globalThis.browser.tmMsgNotify = {
    getFolderState: vi.fn(async () => folder),
    beginFolderMessageScan: vi.fn(async () => {
      const token = `scan-${nextToken++}`;
      scans.set(token, { offset: 0, rows: rows.map(row => ({ ...row })) });
      return {
        token,
        accountId: folder.accountId,
        folderPath: folder.folderPath,
        serverType: folder.serverType,
        stableUidKeys: folder.stableUidKeys,
        uidValidity: folder.uidValidity,
      };
    }),
    readFolderMessageScanPage: vi.fn(async (token, limit) => {
      const scan = scans.get(token);
      const page = scan.rows.slice(scan.offset, scan.offset + limit);
      scan.offset += page.length;
      const done = scan.offset >= scan.rows.length;
      if (done) scans.delete(token);
      return { rows: page, done };
    }),
    cancelFolderMessageScan: vi.fn(async token => ({ cancelled: scans.delete(token) })),
    getMessageInfosForKeys: vi.fn(async (_uri, keys) => ({
      infos: keys.map(key => rowByKey.get(key)).filter(Boolean).map(row => ({
        accountId: folder.accountId,
        folderPath: folder.folderPath,
        headerMessageId: row.headerMessageId,
        msgKey: row.msgKey,
      })),
    })),
    probeMessageIds: vi.fn(async () => ({ missing: [] })),
  };
  return folder;
}

function installRepairFolders(specs) {
  const folders = specs.map((spec, index) => ({
    accountId: 'account1',
    folderPath: spec.folderPath,
    folderURI: `none://repair-${index}`,
    serverType: 'none',
    stableUidKeys: false,
    uidValidity: 0,
  }));
  const rowsByURI = new Map(folders.map((folder, index) => [
    folder.folderURI,
    Array.from({ length: specs[index].rows || 0 }, (_, rowIndex) => ({
      msgKey: rowIndex + 1,
      headerMessageId: `${index}-${rowIndex + 1}@example.com`,
    })),
  ]));
  globalThis.browser.accounts.list.mockResolvedValue([{
    id: 'account1', type: 'none',
    rootFolder: {
      path: '/', isRoot: true,
      subFolders: folders.map(folder => ({ path: folder.folderPath, subFolders: [] })),
    },
  }]);
  let nextToken = 1;
  const scans = new Map();
  globalThis.browser.tmMsgNotify = {
    getFolderState: vi.fn(async (accountId, folderPath) => ({
      ...folders.find(folder => folder.accountId === accountId && folder.folderPath === folderPath),
    })),
    beginFolderMessageScan: vi.fn(async (uri, includeMessageIds) => {
      const folder = folders.find(item => item.folderURI === uri);
      const token = `repair-${nextToken++}`;
      scans.set(token, { uri, offset: 0, includeMessageIds });
      return { token, ...folder };
    }),
    readFolderMessageScanPage: vi.fn(async (token, limit) => {
      const scan = scans.get(token);
      const source = rowsByURI.get(scan.uri);
      const rows = source.slice(scan.offset, scan.offset + limit).map(row => (
        scan.includeMessageIds ? row : { msgKey: row.msgKey }
      ));
      scan.offset += rows.length;
      const done = scan.offset >= source.length;
      if (done) scans.delete(token);
      return { rows, done };
    }),
    cancelFolderMessageScan: vi.fn(async token => ({ cancelled: scans.delete(token) })),
    getMessageInfosForKeys: vi.fn(async (uri, keys) => ({
      infos: rowsByURI.get(uri).filter(row => keys.includes(row.msgKey)).map(row => ({
        accountId: 'account1',
        folderPath: folders.find(folder => folder.folderURI === uri).folderPath,
        headerMessageId: row.headerMessageId,
        msgKey: row.msgKey,
      })),
    })),
    probeMessageIds: vi.fn(async () => ({ missing: [] })),
  };
  const nativeKeys = new Set();
  const inNativeRange = (start, end, after = null) =>
    sqliteNativeRange(nativeKeys, start, end, after);
  const fts = {
    fingerprintMsgIdRange: vi.fn(async (start, end) => {
      const rows = inNativeRange(start, end);
      return { count: rows.length, sha256: framedDigest(rows) };
    }),
    countMsgIdRange: vi.fn(async (start, end) => ({ count: inNativeRange(start, end).length })),
    listMsgIdRange: vi.fn(async (start, end, after, limit) => {
      const rows = inNativeRange(start, end, after);
      const page = rows.slice(0, limit);
      return { msgIds: page, done: page.length < limit };
    }),
    filterNewMessages: vi.fn(async rows => ({
      newMsgIds: rows.map(row => row.msgId).filter(msgId => !nativeKeys.has(msgId)),
    })),
    removeBatch: vi.fn(async ids => {
      for (const id of ids) nativeKeys.delete(id);
      return { count: ids.length };
    }),
    getMessageByMsgId: vi.fn(async id => (nativeKeys.has(id) ? { msgId: id } : null)),
    stats: vi.fn(async () => ({})),
  };
  return { folders, rowsByURI, nativeKeys, fts };
}

function installExactMembershipFolders(specs, { assigned = false } = {}) {
  const folders = specs.map((spec, index) => ({
    accountId: 'account1',
    folderPath: spec.folderPath,
    folderId: makeFolderMembershipId('account1', spec.folderPath),
    weFolderId: spec.weFolderId || spec.folderId || `session-folder-${index}`,
    folderURI: `none://membership-${index}`,
    serverType: 'none',
    stableUidKeys: false,
    uidValidity: 0,
  }));
  const rowsByURI = new Map(folders.map((folder, index) => [
    folder.folderURI,
    (specs[index].headerMessageIds || []).map((headerMessageId, rowIndex) => ({
      msgKey: rowIndex + 1,
      headerMessageId,
    })),
  ]));
  globalThis.browser.accounts.list.mockResolvedValue([{
    id: 'account1', type: 'none',
    rootFolder: {
      path: '/', isRoot: true,
      subFolders: folders.map(folder => ({
        id: folder.weFolderId,
        path: folder.folderPath,
        subFolders: [],
      })),
    },
  }]);
  let nextToken = 1;
  const scans = new Map();
  globalThis.browser.tmMsgNotify = {
    getFolderState: vi.fn(async (accountId, folderPath) => ({
      ...folders.find(folder =>
        folder.accountId === accountId && folder.folderPath === folderPath),
    })),
    beginFolderMessageScan: vi.fn(async (uri) => {
      const folder = folders.find(item => item.folderURI === uri);
      const token = `membership-${nextToken++}`;
      scans.set(token, { uri, offset: 0 });
      return { token, ...folder };
    }),
    readFolderMessageScanPage: vi.fn(async (token, limit) => {
      const scan = scans.get(token);
      const source = rowsByURI.get(scan.uri);
      const rows = source.slice(scan.offset, scan.offset + limit);
      scan.offset += rows.length;
      const done = scan.offset >= source.length;
      if (done) scans.delete(token);
      return { rows, done };
    }),
    cancelFolderMessageScan: vi.fn(async token => ({ cancelled: scans.delete(token) })),
    getMessageInfosForKeys: vi.fn(async (uri, keys) => ({
      infos: rowsByURI.get(uri).filter(row => keys.includes(row.msgKey)).map(row => ({
        accountId: 'account1',
        folderPath: folders.find(folder => folder.folderURI === uri).folderPath,
        headerMessageId: row.headerMessageId,
        msgKey: row.msgKey,
      })),
    })),
    // The folder's msgDB Message-ID index: ids with no live header.
    probeMessageIds: vi.fn(async (uri, ids) => {
      const present = new Set((rowsByURI.get(uri) || []).map(row => row.headerMessageId));
      return { missing: ids.filter(id => !present.has(id)), uncertain: [] };
    }),
  };
  const nativeRows = new Map();
  for (let index = 0; index < folders.length; index++) {
    for (const row of rowsByURI.get(folders[index].folderURI)) {
      const msgId = `account1:${folders[index].folderPath}:${row.headerMessageId}`;
      nativeRows.set(msgId, assigned ? folders[index].folderId : null);
    }
  }
  globalThis.browser.messages = {
    query: vi.fn(async ({ folderId, headerMessageId }) => {
      const folder = folders.find(item => item.weFolderId === folderId);
      const found = folder && rowsByURI.get(folder.folderURI)
        .some(row => row.headerMessageId === headerMessageId);
      return { messages: found ? [{ id: `${folderId}:${headerMessageId}` }] : [] };
    }),
  };
  const rowsForFolder = folderId => [...nativeRows]
    .filter(([, assignedFolderId]) => assignedFolderId === folderId)
    .map(([msgId]) => msgId)
    .sort(sqliteBinaryCompare);
  const allRows = () => [...nativeRows.keys()].sort(sqliteBinaryCompare);
  const fts = {
    supportsFolderMembership: vi.fn(() => true),
    getConnectionGeneration: vi.fn(() => 1),
    listFolderMembership: vi.fn(async (folderId, after, limit) => {
      const rows = rowsForFolder(folderId)
        .filter(msgId => after == null || sqliteBinaryCompare(msgId, after) > 0);
      const page = rows.slice(0, limit);
      return { ok: true, msgIds: page, done: page.length === rows.length };
    }),
    listFolderMembershipState: vi.fn(async (after, limit) => {
      const rows = [...nativeRows]
        .map(([msgId, folderId]) => ({ msgId, folderId }))
        .filter(entry => after == null || sqliteBinaryCompare(entry.msgId, after) > 0)
        .sort((a, b) => sqliteBinaryCompare(a.msgId, b.msgId));
      const entries = rows.slice(0, limit);
      // Native semantics: terminal only on a short page, so an exact
      // multiple of the limit needs one more (empty) read.
      return { ok: true, entries, done: entries.length < limit };
    }),
    // Attributed exactly as fts/engine.js's ftsSearch attributes them, so a
    // slice's own writes reach the native change ledger as in production.
    assignFolderMembershipBatch: vi.fn(async (assignments, token = null) => runFtsMembershipMutation(async () => {
      for (const { msgId, folderId } of assignments) {
        const existing = nativeRows.get(msgId);
        if (existing != null && existing !== folderId) throw new Error('folder_membership_conflict');
      }
      let assigned = 0;
      let alreadyAssigned = 0;
      let missing = 0;
      for (const { msgId, folderId } of assignments) {
        if (!nativeRows.has(msgId)) missing++;
        else if (nativeRows.get(msgId) === folderId) alreadyAssigned++;
        else {
          nativeRows.set(msgId, folderId);
          assigned++;
        }
      }
      return { ok: true, assigned, alreadyAssigned, missing };
    }, token, {
      folderIds: assignments.map(assignment => assignment?.folderId),
      keys: assignments.map(assignment => assignment?.msgId),
    })),
    fingerprintMsgIdRange: vi.fn(async (start, end) => {
      const rows = sqliteNativeRange(allRows(), start, end);
      return { count: rows.length, sha256: framedDigest(rows) };
    }),
    countMsgIdRange: vi.fn(async (start, end) => ({
      count: sqliteNativeRange(allRows(), start, end).length,
    })),
    listMsgIdRange: vi.fn(async (start, end, after, limit) => {
      const rows = sqliteNativeRange(allRows(), start, end, after);
      const page = rows.slice(0, limit);
      return { msgIds: page, done: page.length === rows.length };
    }),
    filterNewMessages: vi.fn(async rows => ({
      newMsgIds: rows.map(row => row.msgId).filter(msgId => !nativeRows.has(msgId)),
    })),
    removeBatch: vi.fn(async (ids, token = null) => runFtsMembershipMutation(async () => {
      for (const id of ids) nativeRows.delete(id);
      return { count: ids.length };
    }, token, { msgIds: ids, keys: ids })),
    getMessageByMsgId: vi.fn(async id => (nativeRows.has(id) ? { msgId: id } : null)),
    stats: vi.fn(async () => ({})),
  };
  return { folders, rowsByURI, nativeRows, fts };
}

/*
 * Keep this sentinel near the exact-membership fake: no implementation under
 * test may recover the deprecated unassigned-only or whole-folder fingerprint
 * RPCs by accident.
 */
function expectOnlyBoundedFolderMembershipReads(fts) {
  expect(fts).not.toHaveProperty('fingerprintFolderMembership');
  expect(fts).not.toHaveProperty('listUnassignedFolderMembership');
  expect(fts.listFolderMembership.mock.calls.every(
    ([, , limit]) => limit > 0 && limit <= 2000,
  )).toBe(true);
  expect(fts.listFolderMembershipState.mock.calls.every(
    ([, limit]) => limit > 0 && limit <= 2000,
  )).toBe(true);
}

// A scheduler tick started by the retry timer callback cannot be awaited by
// the test. Such a tick awaits WebCrypto digests that settle on the REAL event
// loop at load-dependent latency, while a finite series of virtual advances
// grants only a bounded number of real-loop turns (one per advance plus one
// per fired fake timer). A fixed count of advances is therefore not enough
// real-time progress for the tick to finish (TB #43). Yield to the real loop
// until the in-flight tick releases its owner slot, under the same real
// deadline as the direct helper below; on expiry disable the indexer so the
// stalled continuation unwinds without committing proof. The caller owns
// virtual time: this helper drives no fake timers, so a tick that parks on a
// fake timer (a multi-page folder scan) needs the caller's next advance.
async function settleInFlightSchedulerTickWithFakeTimers(
  deadlineMs = SCHEDULER_SETTLE_REAL_DEADLINE_MS,
  yieldToRealLoop = yieldToRealEventLoop,
) {
  const startedAt = realDateNow();
  while (_testExports._isFolderReconSchedulerActive()) {
    await yieldToRealLoop();
    // Re-read ownership AFTER the yield: work that completed during a long
    // real-loop turn must win over a deadline that elapsed in the same turn.
    if (_testExports._isFolderReconSchedulerActive()
        && realDateNow() - startedAt >= deadlineMs) {
      _testExports._setIsEnabled(false);
      throw new Error(
        `In-flight folder reconciliation tick did not settle within ${deadlineMs}ms real time`,
      );
    }
  }
}

async function settleSchedulerTickWithFakeTimers(fts) {
  let settled = false;
  let outcome;
  let outcomeError;
  let outcomeFailed = false;
  // Observe both outcomes at creation. The tracking promise itself never
  // rejects, so a deadline cannot abandon a later rejecting scheduler tail.
  const observed = _testExports._runFolderReconSchedulerTick(fts).then(
    value => {
      outcome = value;
      settled = true;
    },
    error => {
      outcomeError = error;
      outcomeFailed = true;
      settled = true;
    },
  );
  const startedAt = realDateNow();
  while (!settled) {
    await vi.advanceTimersByTimeAsync(_testExports.FOLDER_RECON_CHUNK_DELAY_MS);
    if (settled) break;
    await yieldToRealEventLoop();
    if (!settled
        && realDateNow() - startedAt >= SCHEDULER_SETTLE_REAL_DEADLINE_MS) {
      _testExports._setIsEnabled(false);
      throw new Error(
        `Folder reconciliation tick did not settle within ${SCHEDULER_SETTLE_REAL_DEADLINE_MS}ms real time`,
      );
    }
  }
  await observed;
  if (outcomeFailed) throw outcomeError;
  return outcome;
}

function seedExclusiveMembershipEvidence() {
  const { folders, fts } = installRepairFolders([
    { folderPath: '/A', rows: 1 },
  ]);
  const liveKey = 'account1:/A:0-1@example.com';
  _testExports._setFtsSearch(fts);
  _testExports._setFolderReconEphemeralEvidenceForTests({
    folderKey: 'account1:/A',
    deferredAt: Date.now() + 60_000,
    failureCount: 3,
    orphanDone: true,
    orphanPass: { phase: 'test-pass' },
    sessionDone: ['account1:/A'],
  });
  _testExports._admitFolderReconActiveProof(
    'account1:/A',
    folders[0],
    {
      proofKind: 'full',
      count: 1,
      sha256: framedDigest([liveKey]),
      keyMapCount: 1,
      keyMapSha256: framedDigest([`1:${liveKey}`]),
      uidCount: 1,
      uidSha256: 'uid-proof',
      sortedKeys: Uint32Array.of(1),
      serverType: 'none',
      stableUidKeys: false,
      uidValidity: 0,
      syncStartedAt: 0,
      mutationSerial: 0,
    },
    _testExports._getFolderReconGeneration(),
    'repair',
  );
  return { fts, liveKey };
}

async function acquireMutatedExclusiveLease() {
  const lease = await acquireFtsExclusiveOperation('full');
  await runFtsMembershipMutation(async () => ({ count: 1 }));
  return lease;
}

async function seedDrainFailureEvidence(fts) {
  const uniqueKey = 'account1:/Drain:drain@example.com';
  const update = {
    type: 'new',
    uniqueKey,
    timestamp: Date.now(),
    folderKey: 'account1:/Drain',
    hasFailed: false,
    lastFailedAt: 0,
    metadata: {},
  };
  _testExports._getPendingUpdates().set(uniqueKey, update);
  headerIDToWeID.mockResolvedValue(101);
  globalThis.browser.messages = {
    get: vi.fn(async () => ({
      id: 101,
      headerMessageId: 'drain@example.com',
      folder: { accountId: 'account1', path: '/Drain' },
    })),
  };
  buildBatchHeader.mockResolvedValue([{ msgId: uniqueKey }]);
  getUniqueMessageKey.mockResolvedValue(uniqueKey);
  fts.filterNewMessages.mockRejectedValueOnce(new Error('native filter unavailable'));
  _testExports._setFtsSearch(fts);
  await flushPendingUpdates();
  expect(_testExports._getPendingUpdates().has(uniqueKey)).toBe(true);
  _testExports._getPendingUpdates().clear();
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) delete storageData[key];
  storageData[_testExports.FOLDER_RECON_INITIAL_SCAN_KEY] = true;
  _testExports._resetFolderReconState();
  _testExports._setIsEnabled(true);
  _testExports._setIndexerDisposed(false);
  _testExports._setFtsSearch(null);
  _testExports._setLastSyncEventMs(0);
  _testExports._getPendingUpdates().clear();
  getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
  parseUniqueId.mockImplementation((uniqueId) => {
    if (!uniqueId || typeof uniqueId !== 'string') return null;
    const first = uniqueId.indexOf(':');
    const second = uniqueId.indexOf(':', first + 1);
    if (first < 0 || second < 0 || second === uniqueId.length - 1) return null;
    return {
      weFolder: { accountId: uniqueId.slice(0, first), path: uniqueId.slice(first + 1, second) },
      headerID: uniqueId.slice(second + 1),
    };
  });
  resolveUniqueMessageKey.mockImplementation(async (uniqueId) => {
    const parsed = parseUniqueId(uniqueId);
    if (!parsed) return null;
    const weID = await headerIDToWeID(parsed.headerID, parsed.weFolder, false);
    return weID ? { ...parsed, weID } : null;
  });
  recheckMessageInFolder.mockResolvedValue('absent');
  headerIDToWeID.mockReset();
  getUniqueMessageKey.mockReset();
  buildBatchHeader.mockReset();
  populateBatchBody.mockReset();
  delete globalThis.browser.messages;
  globalThis.browser.accounts.list.mockResolvedValue([]);
  delete globalThis.browser.tmMsgNotify;
});

describe('cooperative folder reconcile production contracts', () => {
  it('exposes a resumable scheduler and wake hook', () => {
    expect(_testExports._runFolderReconSchedulerTick).toBeTypeOf('function');
    expect(_testExports._wakeFolderRecon).toBeTypeOf('function');
  });

  it('declares bounded scan-page and low-key-page Experiment APIs', () => {
    const schemaPath = fileURLToPath(new URL('../agent/experiments/tmMsgNotify/schema.json', import.meta.url));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const names = schema[0].functions.map(fn => fn.name);

    expect(names).toEqual(expect.arrayContaining([
      'beginFolderMessageScan',
      'readFolderMessageScanPage',
      'cancelFolderMessageScan',
    ]));
    expect(names).not.toContain('listNextKeys');
  });

  it('never asks the folder reconcile path for an unbounded key transfer', () => {
    const sourcePath = fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const missingDirection = source.match(
      /async function _folderReconMissingDirection[\s\S]*?\n}\n\n\/\*\*\n \* Orphaned-prefix sweep/,
    )?.[0] || '';

    expect(missingDirection).toContain('_upperBoundMsgKey');
    expect(missingDirection).not.toMatch(/listNextKeys|listKeysAboveKey/);
  });

  it('keeps incremental drain utility imports inside the add-on module tree', () => {
    for (const path of [
      '../fts/incrementalIndexer.js',
      '../fts/indexer.js',
    ]) {
      const source = readFileSync(
        fileURLToPath(new URL(path, import.meta.url)),
        'utf8',
      );
      expect(source, path).not.toContain('import("../../agent/modules/utils.js")');
    }
  });

  it('converges beyond the former 10k boundary in one live session', async () => {
    const total = 10_001;
    const allKeys = Array.from({ length: total }, (_, index) => index + 1);
    globalThis.browser.tmMsgNotify = {
      getMessageInfosForKeys: vi.fn(async (_uri, keys) => ({
        infos: keys.map(key => ({
          accountId: 'account1',
          folderPath: '/Archive',
          headerMessageId: `m-${key}@example.com`,
          msgKey: key,
        })),
      })),
    };
    const fts = { filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })) };
    const folder = { accountId: 'account1', folderPath: '/Archive', folderURI: 'imap://archive' };
    const stats = { missingEnqueued: 0 };
    let cursor = 0;
    let reachedEnd = false;
    while (!reachedEnd) {
      const result = await _testExports._folderReconMissingDirection(
        fts,
        folder,
        stats,
        { scans: reconConfig.missingPageKeys, enqueues: reconConfig.enqueuesPerSlice },
        cursor,
        Uint32Array.from(allKeys),
      );
      cursor = result.cursor;
      reachedEnd = result.reachedEnd;
    }

    expect(cursor).toBe(total);
    expect(globalThis.browser.tmMsgNotify.getMessageInfosForKeys).toHaveBeenCalledTimes(21);
    expect(globalThis.browser.tmMsgNotify.getMessageInfosForKeys.mock.calls.every(
      call => call[1].length <= reconConfig.missingPageKeys,
    )).toBe(true);
  });

  it('reuses one active proof across >10k keys and refreshes before verification', async () => {
    const total = 10_001;
    const rows = Array.from({ length: total }, (_, index) => ({
      msgKey: index + 1,
      headerMessageId: `m-${index + 1}@example.com`,
    }));
    installFolderRows(rows);
    const expectedKeys = rows.map(row => `account1:/Archive:${row.headerMessageId}`);
    const completeFingerprint = { count: total, sha256: framedDigest(expectedKeys) };
    let nativeComplete = false;
    const fts = {
      fingerprintMsgIdRange: vi.fn(async () => nativeComplete
        ? completeFingerprint
        : { count: 0, sha256: emptyDigest() }),
      countMsgIdRange: vi.fn(async () => ({ count: nativeComplete ? total : 0 })),
      listMsgIdRange: vi.fn(async () => ({ msgIds: [], done: true })),
      filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })),
      removeBatch: vi.fn(async () => ({ count: 0 })),
      getMessageByMsgId: vi.fn(async () => null),
      stats: vi.fn(async () => ({})),
    };
    _testExports._setFolderReconBudgetOverride({ scans: reconConfig.missingPageKeys });

    // Twenty slices account for the first 10,000 keys without repeating the
    // 41-page parent-process header walk on every scheduler turn.
    for (let slice = 0; slice < 20; slice++) {
      const stats = await _testExports._runFolderReconcile(fts);
      expect(stats.foldersBudgetPartial).toBe(1);
    }
    expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
      .folders['account1:/Archive'].missingBackfillKey).toBe(10_000);
    expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).toHaveBeenCalledTimes(1);

    // Model the incremental/native path completing the final membership row.
    // Equality against the retained working proof must trigger a second fresh
    // scan; the retained proof itself is forbidden from minting verification.
    nativeComplete = true;
    const verified = await _testExports._runFolderReconcile(fts);

    expect(verified.foldersClean).toBe(1);
    expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
      .folders['account1:/Archive'].verified).toBe(true);
    expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).toHaveBeenCalledTimes(2);
    expect(globalThis.browser.tmMsgNotify.readFolderMessageScanPage).toHaveBeenCalledTimes(82);
    expect(_testExports._getFolderReconWorkingProofTelemetry()).toMatchObject({
      reuses: 20,
      scans: 2,
      active: 0,
    });
  });

  it('admits more than the former per-run enqueue allowance through repeated bounded drain slices', async () => {
    vi.useFakeTimers();
    try {
      const total = 201;
      const allKeys = Uint32Array.from({ length: total }, (_, index) => index + 1);
      globalThis.browser.tmMsgNotify = {
        getMessageInfosForKeys: vi.fn(async (_uri, keys) => ({
          infos: keys.map(key => ({
            accountId: 'account1',
            folderPath: '/Archive',
            headerMessageId: `m-${key}@example.com`,
            msgKey: key,
          })),
        })),
      };
      const fts = {
        filterNewMessages: vi.fn(async rows => ({ newMsgIds: rows.map(row => row.msgId) })),
      };
      const folder = { accountId: 'account1', folderPath: '/Archive', folderURI: 'imap://archive' };
      const stats = { missingEnqueued: 0 };
      let cursor = 0;
      let reachedEnd = false;
      let maxLiveQueue = 0;
      let slices = 0;
      while (!reachedEnd) {
        const result = await _testExports._folderReconMissingDirection(
          fts,
          folder,
          stats,
          { scans: reconConfig.missingPageKeys, enqueues: reconConfig.enqueuesPerSlice },
          cursor,
          allKeys,
        );
        cursor = result.cursor;
        reachedEnd = result.reachedEnd;
        maxLiveQueue = Math.max(maxLiveQueue, _testExports._getPendingUpdates().size);
        _testExports._getPendingUpdates().clear(); // existing drain completed this slice
        slices++;
      }

      expect(stats.missingEnqueued).toBe(total);
      expect(slices).toBe(11);
      expect(maxLiveQueue).toBe(reconConfig.enqueuesPerSlice);
      expect(maxLiveQueue).toBeLessThanOrEqual(reconConfig.pendingHighWater);
      expect(populateBatchBody).not.toHaveBeenCalled();
    } finally {
      _testExports._getPendingUpdates().clear();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('yields to another task between bounded parent header pages', async () => {
    vi.useFakeTimers();
    try {
      let offset = 0;
      let interleaved = false;
      const rows = Array.from({ length: 501 }, (_, index) => ({
        msgKey: index + 1,
        headerMessageId: `m-${index + 1}@example.com`,
      }));
      globalThis.browser.tmMsgNotify = {
        beginFolderMessageScan: vi.fn(async () => ({
          token: 'scan', accountId: 'account1', folderPath: '/Archive',
        })),
        readFolderMessageScanPage: vi.fn(async () => {
          if (offset === reconConfig.folderScanPageSize) expect(interleaved).toBe(true);
          const page = rows.slice(offset, offset + reconConfig.folderScanPageSize);
          offset += page.length;
          if (offset === reconConfig.folderScanPageSize) {
            setTimeout(() => { interleaved = true; }, 0);
          }
          return { rows: page, done: offset >= rows.length };
        }),
        cancelFolderMessageScan: vi.fn(async () => ({ cancelled: true })),
      };
      const promise = _testExports._scanFolderMessagesCooperatively({
        accountId: 'account1', folderPath: '/Archive', folderURI: 'imap://archive',
      });
      await vi.runAllTimersAsync();
      const result = await promise;
      expect(result.count).toBe(501);
      expect(globalThis.browser.tmMsgNotify.readFolderMessageScanPage).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes one active repair proof across enqueue-one drains before advancing folders', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts, nativeKeys } = installRepairFolders([
        { folderPath: '/A', rows: 3 },
        { folderPath: '/B', rows: 0 },
      ]);
      _testExports._setFolderReconBudgetOverride({ scans: 10, enqueues: 1 });
      _testExports._setFtsSearch(null);

      for (let turn = 0; turn < 4; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        for (const uniqueKey of _testExports._getPendingUpdates().keys()) nativeKeys.add(uniqueKey);
        _testExports._getPendingUpdates().clear();
        vi.setSystemTime(Date.now() + 1000);
      }
      await settleSchedulerTickWithFakeTimers(fts);

      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual(['none://repair-0', 'none://repair-0', 'none://repair-1']);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set([
        'account1:/A',
        'account1:/B',
      ]));
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('converges two large simulated folders in order without rescan thrash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts, nativeKeys } = installRepairFolders([
        { folderPath: '/Huge-A', rows: 3 },
        { folderPath: '/Huge-B', rows: 3 },
      ]);
      _testExports._setFolderReconBudgetOverride({ scans: 10, enqueues: 1 });
      _testExports._setFtsSearch(null);

      for (let turn = 0; turn < 12
          && _testExports._getFolderReconSessionDone().size < 2; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        for (const uniqueKey of _testExports._getPendingUpdates().keys()) {
          nativeKeys.add(uniqueKey);
        }
        _testExports._getPendingUpdates().clear();
        vi.setSystemTime(Date.now() + 1000);
      }

      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set([
        'account1:/Huge-A',
        'account1:/Huge-B',
      ]));
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual([
          'none://repair-0', 'none://repair-0',
          'none://repair-1', 'none://repair-1',
        ]);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('releases an invalidated active proof so the next folder makes progress', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts } = installRepairFolders([
        { folderPath: '/A', rows: 2 },
        { folderPath: '/B', rows: 1 },
      ]);
      const filterNew = fts.filterNewMessages.getMockImplementation();
      fts.filterNewMessages.mockImplementationOnce(async rows => {
        _testExports._invalidateFolderReconProofForEvent('account1', '/A');
        return filterNew(rows);
      });
      _testExports._setFolderReconBudgetOverride({ scans: 1, enqueues: 1 });
      _testExports._setFtsSearch(null);

      const invalidated = await settleSchedulerTickWithFakeTimers(fts);
      expect(invalidated).toMatchObject({ foldersLocalDrift: 1, foldersFailed: 0 });
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();

      vi.setSystemTime(Date.now() + 1000);
      await settleSchedulerTickWithFakeTimers(fts);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual(['none://repair-0', 'none://repair-1']);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('releases an active proof after a real repair error so another folder progresses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts } = installRepairFolders([
        { folderPath: '/A', rows: 2 },
        { folderPath: '/B', rows: 1 },
      ]);
      fts.filterNewMessages.mockRejectedValueOnce(new Error('native filter unavailable'));
      _testExports._setFolderReconBudgetOverride({ scans: 1, enqueues: 1 });
      _testExports._setFtsSearch(null);

      const failed = await settleSchedulerTickWithFakeTimers(fts);
      expect(failed).toMatchObject({ foldersFailed: 1 });
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();

      vi.setSystemTime(Date.now() + 1000);
      await settleSchedulerTickWithFakeTimers(fts);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual(['none://repair-0', 'none://repair-1']);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('fairly defers an active repair after a thrown drain await while retaining a newer intention', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts } = installRepairFolders([
        { folderPath: '/A', rows: 1 },
        { folderPath: '/B', rows: 0 },
      ]);
      _testExports._setFolderReconBudgetOverride({ scans: 1, enqueues: 1 });
      _testExports._setFtsSearch(null);
      await settleSchedulerTickWithFakeTimers(fts);

      const [queuedKey, captured] = [..._testExports._getPendingUpdates().entries()][0];
      expect(_testExports._getFolderReconActiveProofKey()).toBe('account1:/A');
      headerIDToWeID.mockResolvedValue(101);
      globalThis.browser.messages = {
        get: vi.fn(async () => ({
          id: 101,
          headerMessageId: '0-1@example.com',
          folder: { accountId: 'account1', path: '/A' },
        })),
      };
      buildBatchHeader.mockResolvedValue([{ msgId: queuedKey }]);
      getUniqueMessageKey.mockResolvedValue(queuedKey);
      fts.filterNewMessages.mockImplementationOnce(async () => {
        _testExports._getPendingUpdates().set(queuedKey, {
          ...captured,
          type: 'moved',
          timestamp: captured.timestamp + 1,
        });
        throw new Error('native filter unavailable');
      });
      _testExports._setFtsSearch(fts);

      await flushPendingUpdates();

      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();
      expect(_testExports._getPendingUpdates().get(queuedKey)).toMatchObject({
        type: 'moved',
        timestamp: captured.timestamp + 1,
        folderKey: 'account1:/A',
      });
      expect(storageData.fts_pending_updates).toBeUndefined();
      expect(_testExports._getFolderReconDirty()).toContain('account1:/A');

      _testExports._setFtsSearch(null);
      vi.clearAllTimers();
      const resumed = await settleSchedulerTickWithFakeTimers(fts);
      expect(resumed).toMatchObject({ foldersClean: 1 });
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual(['none://repair-0', 'none://repair-1']);
      expect(_testExports._getFolderReconSessionDone()).toContain('account1:/B');
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reaches bounded abandonment through the real unresolved drain path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts } = installRepairFolders([
        { folderPath: '/A', rows: 1 },
        { folderPath: '/B', rows: 0 },
      ]);
      _testExports._setFolderReconBudgetOverride({ scans: 1, enqueues: 1 });
      _testExports._setFtsSearch(null);
      await settleSchedulerTickWithFakeTimers(fts);

      const [queuedKey, queued] = [..._testExports._getPendingUpdates().entries()][0];
      _testExports._getPendingUpdates().set(queuedKey, { ...queued, hasFailed: true });
      _testExports._setConsecutiveNoProgressCycles(
        _testExports._getRetryConfig().maxConsecutiveNoProgress - 1,
      );
      headerIDToWeID.mockResolvedValue(null);
      _testExports._setFtsSearch(fts);

      await flushPendingUpdates();

      expect(headerIDToWeID).toHaveBeenCalledOnce();
      expect(_testExports._getConsecutiveNoProgressCycles()).toBe(0);
      expect(_testExports._getPendingUpdates().has(queuedKey)).toBe(false);
      expect(_testExports._getFolderReconDirty()).toContain('account1:/A');
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();

      _testExports._setFtsSearch(null);
      vi.clearAllTimers();
      const resumed = await settleSchedulerTickWithFakeTimers(fts);
      expect(resumed).toMatchObject({ foldersClean: 1 });
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual(['none://repair-0', 'none://repair-1']);
      expect(_testExports._getFolderReconSessionDone()).toContain('account1:/B');
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('releases the active proof at the actual abandonment fairness boundary', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts } = installRepairFolders([
        { folderPath: '/A', rows: 1 },
        { folderPath: '/B', rows: 0 },
      ]);
      _testExports._setFolderReconBudgetOverride({ scans: 1, enqueues: 1 });
      _testExports._setFtsSearch(null);
      await settleSchedulerTickWithFakeTimers(fts);

      const [queuedKey, queued] = [..._testExports._getPendingUpdates().entries()][0];
      const failed = { ...queued, hasFailed: true };
      _testExports._getPendingUpdates().set(queuedKey, failed);
      _testExports._setConsecutiveNoProgressCycles(
        _testExports._getRetryConfig().maxConsecutiveNoProgress,
      );
      expect(_testExports._shouldDropFailedUpdates()).toBe(true);

      const abandoned = await _testExports._abandonPendingUpdates([failed], 'queue_stuck');

      expect(abandoned).toEqual({ dropped: 1, retained: 0 });
      expect(_testExports._getPendingUpdates().has(queuedKey)).toBe(false);
      expect(_testExports._getFolderReconDirty()).toContain('account1:/A');
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();

      vi.clearAllTimers();
      const resumed = await settleSchedulerTickWithFakeTimers(fts);
      expect(resumed).toMatchObject({ foldersClean: 1 });
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual(['none://repair-0', 'none://repair-1']);
      expect(_testExports._getFolderReconSessionDone()).toContain('account1:/B');
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('invalidates verified session evidence after an exclusive membership rewrite', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { folders, fts, nativeKeys } = installRepairFolders([
        { folderPath: '/A', rows: 1 },
      ]);
      const liveKey = 'account1:/A:0-1@example.com';
      nativeKeys.add(liveKey);
      _testExports._setFtsSearch(null);

      for (let turn = 0; turn < 8 && !(await sessionSettled()); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 1000);
      }
      expect(await sessionSettled()).toBe(true);
      expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');
      await seedDrainFailureEvidence(fts);
      _testExports._setFtsSearch(fts);
      _testExports._setFolderReconEphemeralEvidenceForTests?.({
        folderKey: 'account1:/A',
        deferredAt: Date.now() + 60_000,
        failureCount: 3,
        orphanDone: true,
        orphanPass: { phase: 'test-pass' },
      });
      const seededEvidence = _testExports._getFolderReconEphemeralEvidence?.();
      if (seededEvidence) {
        expect(seededEvidence).toMatchObject({
          deferred: 3,
          failures: 2,
          orphanDone: true,
          hasOrphanPass: true,
          // /Drain is in no inventory, so its failure records no walk
          // obligation; an inventory that lists it walks it anyway.
          dirty: [],
        });
      }
      _testExports._admitFolderReconActiveProof(
        'account1:/A',
        folders[0],
        {
          proofKind: 'full',
          count: 1,
          sha256: framedDigest([liveKey]),
          keyMapCount: 1,
          keyMapSha256: framedDigest([`1:${liveKey}`]),
          uidCount: 1,
          uidSha256: 'uid-proof',
          sortedKeys: Uint32Array.of(1),
          serverType: 'none',
          stableUidKeys: false,
          uidValidity: 0,
          syncStartedAt: 0,
          mutationSerial: 0,
        },
        _testExports._getFolderReconGeneration(),
        'repair',
      );
      expect(_testExports._getFolderReconActiveProofKey()).toBe('account1:/A');
      const timersBeforeRelease = vi.getTimerCount();

      const lease = await acquireFtsExclusiveOperation('full');
      await runFtsMembershipMutation(async () => {
        nativeKeys.delete(liveKey);
      });
      await expect(runFtsMembershipMutation(async () => {
        throw new Error('rebuild stopped after partial mutation');
      })).rejects.toThrow('rebuild stopped after partial mutation');

      expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');
      expect(_testExports._getFolderReconActiveProofKey()).toBe('account1:/A');
      expect(vi.getTimerCount()).toBe(timersBeforeRelease);
      globalThis.browser.storage.local.set.mockClear();
      lease.release();

      // Invalidation, the walk obligation and the wake are all synchronous
      // with owner release; nothing waits on storage.
      expect(_testExports._getFolderReconSessionDone()).not.toContain('account1:/A');
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();
      expect(_testExports._getFolderReconEphemeralEvidence()).toEqual({
        deferred: 0,
        failures: 0,
        orphanDone: false,
        hasOrphanPass: false,
        dirty: ['account1:/A'],
      });
      expect(quietNow()).toBe(false);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();

      _testExports._setFtsSearch(null);
      vi.clearAllTimers();
      vi.setSystemTime(Date.now() + 1000);
      const reproved = await settleSchedulerTickWithFakeTimers(fts);
      expect(reproved.missingEnqueued).toBe(1);
      expect(_testExports._getPendingUpdates().has(liveKey)).toBe(true);
      expect(reproved.complete).not.toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('wakes normal reconciliation directly on exclusive release without storage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      seedExclusiveMembershipEvidence();
      expect(quietNow()).toBe(true);
      const lease = await acquireMutatedExclusiveLease();
      expect(quietNow()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      lease.release();

      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();
      expect(_testExports._getFolderReconEphemeralEvidence()).toEqual({
        deferred: 0,
        failures: 0,
        orphanDone: false,
        hasOrphanPass: false,
        dirty: ['account1:/A'],
      });
      expect(quietNow()).toBe(false);
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(reconConfig.paceDelayMs);
      expect(globalThis.browser.accounts.list).toHaveBeenCalled();
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ['dispose', async () => {
      await incrementalIndexer.disposeIncrementalIndexer();
    }],
    ['disabled re-init generation', async () => {
      storageData.chat_ftsIncrementalEnabled = false;
      await incrementalIndexer.initIncrementalIndexer({});
    }],
    ['replacement generation', async () => {
      _testExports._resetFolderReconState();
      _testExports._setIsEnabled(true);
      _testExports._setIndexerDisposed(false);
    }],
  ])('drops a stale post-exclusive wake on %s', async (_name, cancelOwner) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      seedExclusiveMembershipEvidence();
      const lease = await acquireMutatedExclusiveLease();
      lease.release();
      expect(vi.getTimerCount()).toBe(1);

      await cancelOwner();
      await vi.advanceTimersByTimeAsync(
        reconConfig.errorDelayMs + reconConfig.paceDelayMs,
      );

      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('synchronously clears every generation-local proof class before waking', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url)),
      'utf8',
    );
    const handler = source.match(
      /function _handleExclusiveFtsMembershipChange[\s\S]*?\n}/,
    )?.[0] || '';
    expect(handler.length, 'exclusive invalidation handler extraction is non-vacuous')
      .toBeGreaterThan(500);
    for (const state of [
      '_folderReconSessionDone.clear()',
      '_folderReconSessionDeferred.clear()',
      '_folderReconFailureCounts.clear()',
      '_folderReconDrainFailureDeferred.clear()',
      '_folderReconDrainFailureCounts.clear()',
      '_folderReconOrphanDone = false',
      '_folderReconOrphanPass = null',
      '_releaseFolderReconActiveProof(null, "invalidation")',
      '_markAllFolderReconWalks()',
    ]) {
      expect(handler).toContain(state);
    }
    const dirtyAt = handler.indexOf('_markAllFolderReconWalks()');
    const wakeAt = handler.indexOf('_wakeFolderRecon(');
    expect(dirtyAt).toBeGreaterThan(-1);
    expect(wakeAt).toBeGreaterThan(dirtyAt);
    expect(handler).not.toContain('await');
  });

  it('does not invalidate verified session evidence for a read-only exclusive owner', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    _testExports._setFtsSearch(null);
    await _testExports._runFolderReconSchedulerTick(fts);
    expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');
    expect(quietNow()).toBe(true);

    const lease = await acquireFtsExclusiveOperation('maintenance-read');
    lease.release();
    await Promise.resolve();

    expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');
    expect(_testExports._getFolderReconDirty()).not.toContain('__all__');
    expect(quietNow()).toBe(true);
  });

  it('does not cycle-rescan across 33 sequential partial folders', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts, nativeKeys } = installRepairFolders(Array.from(
        { length: 33 },
        (_, index) => ({ folderPath: `/F-${String(index).padStart(2, '0')}`, rows: 1 }),
      ));
      _testExports._setFolderReconBudgetOverride({ scans: 1, enqueues: 1 });
      _testExports._setFtsSearch(null);

      for (let turn = 0; turn < 70
          && _testExports._getFolderReconSessionDone().size < 33; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        for (const uniqueKey of _testExports._getPendingUpdates().keys()) nativeKeys.add(uniqueKey);
        _testExports._getPendingUpdates().clear();
        vi.setSystemTime(Date.now() + 1000);
      }

      expect(_testExports._getFolderReconSessionDone().size).toBe(33);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual(Array.from({ length: 33 }, (_, index) => [
          `none://repair-${index}`,
          `none://repair-${index}`,
        ]).flat());
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('uses one phase-tagged proof without arbitrary resource cutoffs', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/SNAPSHOT_CACHE_MAX_ENTRIES|SNAPSHOT_CACHE_MAX_BYTES|SNAPSHOT_CACHE_IDLE_TTL/);
    expect(source).not.toMatch(/_folderReconSnapshots|_folderReconOversizeSnapshotKey/);
    expect(source).toContain('_folderReconActiveProof');
    expect(source).toContain('phase:');
  });

  it('aborts a missing slice on local invalidation without cursor advance or repair backoff', async () => {
    installFolderRows([{ msgKey: 1, headerMessageId: 'm-1@example.com' }]);
    const fts = {
      fingerprintMsgIdRange: vi.fn(async () => ({ count: 0, sha256: emptyDigest() })),
      countMsgIdRange: vi.fn(async () => ({ count: 0 })),
      listMsgIdRange: vi.fn(async () => ({
        msgIds: ['account1:/Archive:indexed@example.com'],
        done: false,
      })),
      filterNewMessages: vi.fn(async () => {
        _testExports._invalidateFolderReconProofForEvent('account1', '/Archive');
        return { newMsgIds: [] };
      }),
      removeBatch: vi.fn(async () => ({ count: 0 })),
      getMessageByMsgId: vi.fn(async () => null),
      stats: vi.fn(async () => ({})),
    };

    const stats = await _testExports._runFolderReconcile(fts);
    const checkpoint = storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
      .folders['account1:/Archive'];
    expect(stats).toMatchObject({ foldersLocalDrift: 1, foldersFailed: 0 });
    expect(checkpoint).toMatchObject({ verified: false, missingBackfillKey: 0 });
    expect(checkpoint).not.toHaveProperty('staleAfterKey');
    expect(checkpoint).not.toHaveProperty('partialPostVerifyFailureCount');
    expect(_testExports._getPendingUpdates().size).toBe(0);
  });

  it('retains the working proof across pending drain work and refreshes after native change', async () => {
    vi.useFakeTimers();
    try {
      const rows = [{ msgKey: 1, headerMessageId: 'm-1@example.com' }];
      installFolderRows(rows);
      const completeFingerprint = {
        count: 1,
        sha256: framedDigest(['account1:/Archive:m-1@example.com']),
      };
      let nativeComplete = false;
      const fts = {
        fingerprintMsgIdRange: vi.fn(async () => nativeComplete
          ? completeFingerprint
          : { count: 0, sha256: emptyDigest() }),
        countMsgIdRange: vi.fn(async () => ({ count: nativeComplete ? 1 : 0 })),
        listMsgIdRange: vi.fn(async () => ({ msgIds: [], done: true })),
        filterNewMessages: vi.fn(async rowsToFilter => ({
          newMsgIds: nativeComplete ? [] : rowsToFilter.map(row => row.msgId),
        })),
        removeBatch: vi.fn(async () => ({ count: 0 })),
        getMessageByMsgId: vi.fn(async () => null),
        stats: vi.fn(async () => ({})),
      };

      const enqueued = await _testExports._runFolderReconcile(fts);
      expect(enqueued.missingEnqueued).toBe(1);
      expect(_testExports._getPendingUpdates().size).toBe(1);
      expect(_testExports._getFolderReconWorkingProofTelemetry().active).toBe(1);

      const gated = await _testExports._runFolderReconcile(fts);
      expect(gated.foldersDrainBusy).toBe(1);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).toHaveBeenCalledTimes(1);

      // The existing incremental drain owns the body/native write. Once it is
      // complete, the retained repair proof can trigger—but never replace—the
      // mandatory fresh verification scan.
      nativeComplete = true;
      _testExports._getPendingUpdates().clear();
      const verified = await _testExports._runFolderReconcile(fts);
      expect(verified.foldersClean).toBe(1);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).toHaveBeenCalledTimes(2);
      expect(_testExports._getFolderReconWorkingProofTelemetry().active).toBe(0);
      expect(populateBatchBody).not.toHaveBeenCalled();
    } finally {
      _testExports._getPendingUpdates().clear();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('abandons a live scan at a page boundary when foreground pressure starts, then restarts safely', async () => {
    const firstRows = Array.from({ length: reconConfig.folderScanPageSize }, (_, index) => ({
      msgKey: index + 1,
      headerMessageId: `m-${index + 1}@example.com`,
    }));
    globalThis.browser.tmMsgNotify = {
      beginFolderMessageScan: vi.fn(async () => ({
        token: 'scan-1', accountId: 'account1', folderPath: '/Archive',
      })),
      readFolderMessageScanPage: vi.fn(async () => {
        getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
        return { rows: firstRows, done: false };
      }),
      cancelFolderMessageScan: vi.fn(async () => ({ cancelled: true })),
    };
    const folder = {
      accountId: 'account1', folderPath: '/Archive', folderURI: 'imap://archive',
    };

    await expect(_testExports._scanFolderMessagesCooperatively(folder))
      .rejects.toThrow('folder_recon_pressure');
    expect(globalThis.browser.tmMsgNotify.cancelFolderMessageScan).toHaveBeenCalledWith('scan-1');

    getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
    globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockResolvedValue({
      token: 'scan-2', accountId: 'account1', folderPath: '/Archive',
    });
    globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async () => ({
      rows: firstRows.slice(0, 1), done: true,
    }));
    await expect(_testExports._scanFolderMessagesCooperatively(folder))
      .resolves.toMatchObject({ count: 1 });
  });

  it('checks foreground pressure after a terminal parent page before digest or native work', async () => {
    const folder = installFolderRows([{ msgKey: 1, headerMessageId: 'one@example.com' }]);
    const readPage = globalThis.browser.tmMsgNotify.readFolderMessageScanPage.getMockImplementation();
    globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async (...args) => {
      const page = await readPage(...args);
      getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
      return { ...page, done: true };
    });
    const digest = vi.spyOn(globalThis.crypto.subtle, 'digest');

    await expect(_testExports._scanFolderMessagesCooperatively(folder))
      .rejects.toThrow('folder_recon_pressure');
    expect(digest).not.toHaveBeenCalled();
  });

  it('defers a stale pass after one atomic global recheck without failure backoff', async () => {
    const ghosts = [
      'account1:/Archive:ghost-1@example.com',
      'account1:/Archive:ghost-2@example.com',
    ];
    installFolderRows([], { serverType: 'none', stableUidKeys: false });
    const nativeKeys = new Set(ghosts);
    const fts = {
      fingerprintMsgIdRange: vi.fn(async (start, end) => {
        const rows = sqliteNativeRange(nativeKeys, start, end);
        return { count: rows.length, sha256: framedDigest(rows) };
      }),
      countMsgIdRange: vi.fn(async () => ({ count: 0 })),
      listMsgIdRange: vi.fn(async (start, end, after, limit) => {
        const rows = sqliteNativeRange(nativeKeys, start, end, after);
        const page = rows.slice(0, limit);
        return { msgIds: page, done: page.length < limit };
      }),
      filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })),
      removeBatch: vi.fn(async ids => {
        for (const id of ids) nativeKeys.delete(id);
        return { count: ids.length };
      }),
      getMessageByMsgId: vi.fn(async id => (nativeKeys.has(id) ? { msgId: id } : null)),
      stats: vi.fn(async () => ({})),
    };
    recheckMessageInFolder.mockImplementationOnce(async () => {
      getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
      return 'absent';
    });
    globalThis.browser.tmMsgNotify.probeMessageIds.mockResolvedValue({
      missing: ['ghost-1@example.com', 'ghost-2@example.com'],
    });
    _testExports._setFtsSearch(null);

    const pressured = await _testExports._runFolderReconSchedulerTick(fts);

    expect(pressured).toMatchObject({ skipped: true, reason: 'pressure' });
    expect(recheckMessageInFolder).toHaveBeenCalledOnce();
    expect(fts.removeBatch).not.toHaveBeenCalled();
    expect(_testExports._getFolderReconActiveProofKey()).toBe('account1:/Archive');
    expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
      ?.folders?.['account1:/Archive']?.partialRetryNotBeforeMs).toBeUndefined();

    getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
    // Real timers: the pressured slice's own duration is the inter-slice
    // floor, so a slow (loaded) run waits longer before the next slice.
    let resumed;
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
      resumed = await _testExports._runFolderReconSchedulerTick(fts);
      if (!(resumed?.skipped && resumed.reason === 'hard_floor')) break;
    }
    expect(resumed.foldersFailed).toBe(0);
    expect(recheckMessageInFolder.mock.calls.length).toBeGreaterThan(1);
  });

  it('propagates scan pressure as a cooperative scheduler deferral', async () => {
    const folder = installFolderRows([
      { msgKey: 1, headerMessageId: 'one@example.com' },
    ], { serverType: 'none', stableUidKeys: false });
    const readPage = globalThis.browser.tmMsgNotify.readFolderMessageScanPage.getMockImplementation();
    globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async (...args) => {
      const page = await readPage(...args);
      getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
      return page;
    });
    const fts = {
      fingerprintMsgIdRange: vi.fn(async () => ({ count: 0, sha256: emptyDigest() })),
      countMsgIdRange: vi.fn(async () => ({ count: 0 })),
      listMsgIdRange: vi.fn(async () => ({ msgIds: [], done: true })),
      filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })),
      removeBatch: vi.fn(async () => ({ count: 0 })),
      getMessageByMsgId: vi.fn(async () => null),
      stats: vi.fn(async () => ({})),
    };
    _testExports._setFtsSearch(null);

    const result = await _testExports._runFolderReconSchedulerTick(fts);

    expect(result).toMatchObject({ skipped: true, reason: 'pressure' });
    expect(result).not.toHaveProperty('foldersErrored');
    expect(globalThis.browser.tmMsgNotify.cancelFolderMessageScan).toHaveBeenCalledWith('scan-1');
  });

  it('cancels at a digest boundary when an exclusive writer starts waiting', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    let exclusivePromise = null;
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      exclusivePromise = acquireFtsExclusiveOperation('full');
      return realDigest(...args);
    });

    await expect(_testExports._runFolderReconcile(fts))
      .rejects.toThrow('folder_recon_cancelled');
    expect(fts.fingerprintMsgIdRange).toHaveBeenCalledTimes(1); // support probe only
    const lease = await exclusivePromise;
    lease.release();
  });

  it('detects a local mutation serial change immediately after digest', async () => {
    const folder = installFolderRows([{ msgKey: 1, headerMessageId: 'one@example.com' }]);
    const realDigest = globalThis.crypto.subtle.digest.bind(globalThis.crypto.subtle);
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
      const value = await realDigest(...args);
      _testExports._invalidateFolderReconProofForEvent('account1', '/Archive');
      return value;
    });

    await expect(_testExports._scanFolderMessagesCooperatively(folder))
      .rejects.toThrow('folder_changed_during_scan');
  });

  it('pauses under SafeGetFull pressure and resumes without a body-side path', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    _testExports._setFtsSearch(fts);
    getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 2, chatTyping: false });
    expect(await _testExports._runFolderReconSchedulerTick()).toMatchObject({
      skipped: true,
      reason: 'pressure',
    });
    expect(globalThis.browser.tmMsgNotify.getFolderState).not.toHaveBeenCalled();

    getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
    const result = await _testExports._runFolderReconSchedulerTick();
    expect(result.foldersClean).toBe(1);
    expect(populateBatchBody).not.toHaveBeenCalled();
  });

  it('admits exactly high-water live updates and defers overflow to reconcile', async () => {
    vi.useFakeTimers();
    try {
      _testExports._setFtsSearch({});
      // A folder this session already certified, so an owed walk is recorded.
      _testExports._setFolderReconEphemeralEvidenceForTests({
        sessionDone: ['account1:/INBOX'],
        orphanDone: true,
      });
      const addMessage = i => _testExports.onExperimentMessageAdded({
        accountId: 'account1',
        folderPath: '/INBOX',
        headerMessageId: `m-${i}@example.com`,
        msgKey: i + 1,
        eventType: 'msgAdded',
      });
      for (let i = 0; i < reconConfig.pendingHighWater; i++) await addMessage(i);
      // Exactly high water is admitted with no walk obligation.
      expect(_testExports._getPendingUpdates().size).toBe(reconConfig.pendingHighWater);
      expect(_testExports._getFolderReconDirty()).not.toContain('account1:/INBOX');
      expect(_testExports._getFolderReconEphemeralEvidence().orphanDone).toBe(true);

      await addMessage(reconConfig.pendingHighWater);
      expect(_testExports._getPendingUpdates().size).toBe(reconConfig.pendingHighWater);
      expect(_testExports._getFolderReconDirty()).toContain('account1:/INBOX');
      expect(_testExports._getFolderReconEphemeralEvidence().orphanDone).toBe(false);
      expect(populateBatchBody).not.toHaveBeenCalled();
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('advances the session round-robin cursor so a later folder runs next', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      _testExports._setFtsSearch(fts);
      await _testExports._runFolderReconSchedulerTick();
      const firstCalls = globalThis.browser.tmMsgNotify.getFolderState.mock.calls.length;
      _testExports._setFolderReconHardNotBeforeMs(Date.now() + 100);

      await expect(_testExports._runFolderReconSchedulerTick()).resolves.toMatchObject({
        skipped: true,
        reason: 'hard_floor',
      });
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledTimes(firstCalls);

      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick();
      expect(globalThis.browser.tmMsgNotify.getFolderState.mock.calls.map(call => call[1]))
        .toEqual(['/A', '/B']);
      expect(_testExports._getFolderReconRoundRobinCursor()).toBe('account1:/B');
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  // A host sleep inside a slice inflates its measured wall time. Install a
  // folder-state read that moves the fake clock forward once, mid-slice.
  function jumpClockDuringFirstFolderRead(jumpMs) {
    const folderState = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
    let jumped = false;
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath) => {
      if (!jumped) {
        jumped = true;
        vi.setSystemTime(Date.now() + jumpMs);
      }
      return folderState(accountId, folderPath);
    });
    return () => jumped;
  }

  it('clips a host sleep inside a slice so the next wake stays within hardFloorMaxElapsedMs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      const jumped = jumpClockDuringFirstFolderRead(2 * 60 * 60 * 1000);
      _testExports._setFtsSearch(fts);
      await _testExports._runFolderReconSchedulerTick();

      expect(jumped()).toBe(true);
      expect(_testExports._getFolderReconRuntimeTelemetry().lastSliceElapsedMs)
        .toBeGreaterThanOrEqual(2 * 60 * 60 * 1000);
      const dueInMs = _testExports._getFolderReconTimerDueMs() - Date.now();
      expect(dueInMs).toBeGreaterThan(0);
      expect(dueInMs).toBeLessThanOrEqual(reconConfig.hardFloorMaxElapsedMs);
      expect(_testExports._getFolderReconHardNotBeforeMs() - Date.now())
        .toBeLessThanOrEqual(reconConfig.hardFloorMaxElapsedMs);
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('keeps the full reservation of a legitimately long slice below the clip', async () => {
    const longSliceMs = 5 * 60 * 1000;
    expect(longSliceMs).toBeGreaterThan(_testExports.FOLDER_RECON_BACKOFF_WAIT_CAP_MS);
    expect(longSliceMs).toBeLessThan(reconConfig.hardFloorMaxElapsedMs);
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      const jumped = jumpClockDuringFirstFolderRead(longSliceMs);
      _testExports._setFtsSearch(fts);
      await _testExports._runFolderReconSchedulerTick();

      expect(jumped()).toBe(true);
      expect(_testExports._getFolderReconHardNotBeforeMs() - Date.now())
        .toBeGreaterThanOrEqual(longSliceMs);
      expect(_testExports._getFolderReconTimerDueMs() - Date.now())
        .toBeGreaterThanOrEqual(longSliceMs);
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('ends a backward clock jump stall within hardFloorMaxElapsedMs without re-arming every wake', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      const jumped = jumpClockDuringFirstFolderRead(30 * 1000);
      _testExports._setFtsSearch(fts);
      await _testExports._runFolderReconSchedulerTick();
      expect(jumped()).toBe(true);
      expect(_testExports._getFolderReconHardNotBeforeMs()).toBeGreaterThan(Date.now());

      vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000);
      _testExports._wakeFolderRecon('test_after_backward_jump', reconConfig.paceDelayMs);
      expect(_testExports._getFolderReconTimerDueMs() - Date.now())
        .toBeLessThanOrEqual(reconConfig.hardFloorMaxElapsedMs);
      const armedDelayMs = _testExports._getFolderReconRuntimeTelemetry().lastScheduledDelayMs;
      // A wake that asks for nothing earlier leaves the armed timer alone.
      await vi.advanceTimersByTimeAsync(1000);
      _testExports._wakeFolderRecon('test_repeat_wake', reconConfig.paceDelayMs);
      expect(_testExports._getFolderReconRuntimeTelemetry().lastScheduledDelayMs).toBe(armedDelayMs);

      const slicesBefore = _testExports._getFolderReconRuntimeTelemetry().schedulerSlices;
      await vi.advanceTimersByTimeAsync(reconConfig.hardFloorMaxElapsedMs + reconConfig.paceDelayMs);
      await settleInFlightSchedulerTickWithFakeTimers();
      expect(_testExports._getFolderReconRuntimeTelemetry().schedulerSlices).toBeGreaterThan(slicesBefore);
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('backs off persistent folder errors exponentially while refreshing inventory once per tick', async () => {
    vi.useFakeTimers();
    const startedAt = new Date('2026-08-21T00:00:00Z').getTime();
    vi.setSystemTime(startedAt);
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      const realFolderState = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath) => {
        if (folderPath === '/A') {
          return {
            accountId,
            folderPath,
            folderURI: 'imap://folder-0',
            stableUidKeys: true,
            uidValidity: 1,
            error: 'summary unavailable',
          };
        }
        return realFolderState(accountId, folderPath);
      });
      _testExports._setFtsSearch(fts);

      await _testExports._runFolderReconSchedulerTick(fts); // /A: first failure
      await _testExports._runFolderReconSchedulerTick(fts); // /B: succeeds
      expect(globalThis.browser.accounts.list).toHaveBeenCalledTimes(2);

      vi.setSystemTime(startedAt + reconConfig.errorDelayMs - 1);
      await expect(_testExports._runFolderReconSchedulerTick(fts)).resolves.toMatchObject({
        skipped: true,
        reason: 'backoff',
      });
      expect(globalThis.browser.tmMsgNotify.getFolderState.mock.calls
        .filter(call => call[1] === '/A')).toHaveLength(1);

      vi.setSystemTime(startedAt + reconConfig.errorDelayMs);
      await _testExports._runFolderReconSchedulerTick(fts); // /A: second failure
      vi.setSystemTime(startedAt + (3 * reconConfig.errorDelayMs) - 1);
      await expect(_testExports._runFolderReconSchedulerTick(fts)).resolves.toMatchObject({
        skipped: true,
        reason: 'backoff',
      });
      vi.setSystemTime(startedAt + (3 * reconConfig.errorDelayMs));
      await _testExports._runFolderReconSchedulerTick(fts); // /A: third failure

      expect(globalThis.browser.tmMsgNotify.getFolderState.mock.calls
        .filter(call => call[1] === '/A')).toHaveLength(3);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledTimes(6);
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('does not let a removed or renamed folder pin a later tick behind stale inventory', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const oldFts = installEmptyFolders([['account1', '/Old']]);
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath) => ({
        accountId,
        folderPath,
        folderURI: 'imap://old',
        stableUidKeys: true,
        uidValidity: 1,
        error: 'summary unavailable',
      }));
      _testExports._setFtsSearch(oldFts);

      const first = await _testExports._runFolderReconSchedulerTick(oldFts);
      expect(first.foldersErrored).toBe(1);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledOnce();

      const newFts = installEmptyFolders([['account1', '/New']]);
      _testExports._setFtsSearch(newFts);
      const second = await _testExports._runFolderReconSchedulerTick(newFts);

      expect(second.foldersClean).toBe(1);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledTimes(2);
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledWith('account1', '/New');
      expect(globalThis.browser.tmMsgNotify.getFolderState).not.toHaveBeenCalledWith('account1', '/Old');
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    [['account1', '/INBOX/a'], ['account1', '/INBOX/a:b']],
    [['account1', '/INBOX/a:b'], ['account1', '/INBOX/a']],
  ])('fails closed for colon-overlapping folder keyspaces in either inventory order', async (...folderKeys) => {
    const fts = installEmptyFolders(folderKeys);
    const childKey = 'account1:/INBOX/a:b:live@example.com';
    // This exact native string can mean parent /INBOX/a + Message-ID
    // b:live@example.com OR child /INBOX/a:b + live@example.com.
    expect(`account1:/INBOX/a:${'b:live@example.com'}`).toBe(childKey);
    fts.fingerprintMsgIdRange.mockImplementation(async (start, end) => {
      const rows = childKey >= start && childKey < end ? [childKey] : [];
      return { count: rows.length, sha256: framedDigest(rows) };
    });
    fts.countMsgIdRange.mockImplementation(async (start, end) => ({
      count: childKey >= start && childKey < end ? 1 : 0,
    }));
    fts.listMsgIdRange.mockImplementation(async (start, end) => ({
      msgIds: childKey >= start && childKey < end ? [childKey] : [],
      done: true,
    }));
    globalThis.browser.tmMsgNotify.probeMessageIds.mockResolvedValue({
      missing: ['b:live@example.com'],
    });
    _testExports._setFtsSearch(fts);

    const result = await _testExports._runFolderReconSchedulerTick(fts);

    expect(result).toMatchObject({ skipped: true, reason: 'ambiguous_folder_keyspace' });
    expect(globalThis.browser.tmMsgNotify.probeMessageIds).not.toHaveBeenCalled();
    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
    expect(fts.countMsgIdRange).not.toHaveBeenCalled();
    expect(fts.removeBatch).not.toHaveBeenCalled();
    expect(_testExports._getFolderReconSessionDone().size).toBe(0);
    expect(Object.values(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders || {}))
      .not.toContainEqual(expect.objectContaining({ verified: true }));
    const status = await getIncrementalIndexerStatus();
    expect(status.folderRecon).toMatchObject({ ambiguousGroups: 1, ambiguousFolders: 2 });
    expect(JSON.stringify(status.folderRecon)).not.toMatch(/account1|\/INBOX|live@example/);
    // The ambiguity holds the session open: the next tick does not complete.
    expect((await _testExports._runFolderReconSchedulerTick(fts))?.complete).not.toBe(true);
    expect(status.folderRecon.outcomes.complete).toBe(false);
  });

  it.each([
    ['/F', '/F:suffix'],
    ['/F:suffix', '/F'],
  ])('migrates F and F:suffix independently in inventory order %s, %s', async (...folderOrder) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const specsByPath = new Map([
        ['/F', {
          folderPath: '/F',
          folderId: 'opaque-parent',
          headerMessageIds: ['parent@example.com'],
        }],
        ['/F:suffix', {
          folderPath: '/F:suffix',
          folderId: 'opaque-child',
          headerMessageIds: ['child@[IPv6:2001:db8::1]'],
        }],
      ]);
      const { folders, nativeRows, fts } = installExactMembershipFolders(
        folderOrder.map(path => specsByPath.get(path)),
      );

      const outcomes = [];
      for (let turn = 0; turn < 10; turn++) {
        outcomes.push(await _testExports._runFolderReconSchedulerTick(fts));
        vi.setSystemTime(Date.now() + 100);
        if (_testExports._getFolderMembershipCleanupProven()
            && _testExports._getFolderReconSessionDone().size === folders.length) break;
      }

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect([...nativeRows.values()].sort()).toEqual([
        makeFolderMembershipId('account1', '/F'),
        makeFolderMembershipId('account1', '/F:suffix'),
      ].sort());
      expect(fts.assignFolderMembershipBatch).toHaveBeenCalled();
      expect(fts.assignFolderMembershipBatch.mock.calls.every(
        ([assignments]) => assignments.length <= reconConfig.membershipAssignBatchSize,
      )).toBe(true);
      expect(fts.listFolderMembership).toHaveBeenCalledWith(
        makeFolderMembershipId('account1', '/F'), null, expect.any(Number),
      );
      expect(fts.listFolderMembership).toHaveBeenCalledWith(
        makeFolderMembershipId('account1', '/F:suffix'), null, expect.any(Number),
      );
      expectOnlyBoundedFolderMembershipReads(fts);
      // Classification probes each candidate reading's msgDB once; the walks
      // themselves never probe (no stale direction).
      const uriOf = path => folders.find(folder => folder.folderPath === path).folderURI;
      expect(globalThis.browser.tmMsgNotify.probeMessageIds.mock.calls).toEqual(
        expect.arrayContaining([
          [uriOf('/F'), ['parent@example.com']],
          [uriOf('/F:suffix'), ['child@[IPv6:2001:db8::1]']],
        ]));
      expect(globalThis.browser.tmMsgNotify.probeMessageIds.mock.calls
        .every(([, ids]) => ids.length === 1)).toBe(true);
      expect(globalThis.browser.messages.query).not.toHaveBeenCalled();
      expect(outcomes).not.toContainEqual(expect.objectContaining({
        skipped: true,
        reason: 'ambiguous_folder_keyspace',
      }));
      const childAssignment = fts.assignFolderMembershipBatch.mock.calls
        .flatMap(([assignments]) => assignments)
        .find(assignment => assignment.folderId
          === makeFolderMembershipId('account1', '/F:suffix'));
      expect(childAssignment.msgId).toBe(
        'account1:/F:suffix:child@[IPv6:2001:db8::1]',
      );
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps exact migration incomplete when native reports a folder conflict', async () => {
    const { fts } = installExactMembershipFolders([
      {
        folderPath: '/F:suffix',
        folderId: 'opaque-child',
        headerMessageIds: ['child@example.com'],
      },
    ]);
    fts.assignFolderMembershipBatch.mockRejectedValueOnce(new Error('folder_membership_conflict'));

    const result = await _testExports._runFolderReconSchedulerTick(fts);

    expect(result).toMatchObject({
      complete: false,
      migration: { failed: true, reason: 'legacy_assignment_failed' },
    });
    expect(fts.assignFolderMembershipBatch).toHaveBeenCalledTimes(1);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    expectOnlyBoundedFolderMembershipReads(fts);
  });

  it('keeps composed, decomposed, and non-BMP folder identities byte-exact', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const specs = [
        { folderPath: '/Caf\u00e9', folderId: 'opaque-nfc', headerMessageIds: ['nfc@example.com'] },
        { folderPath: '/Cafe\u0301', folderId: 'opaque-nfd', headerMessageIds: ['nfd@example.com'] },
        { folderPath: '/\ud83d\udce8', folderId: 'opaque-plane', headerMessageIds: ['sender@[IPv6:2001:db8::1]'] },
      ];
      const { nativeRows, fts } = installExactMembershipFolders(specs);

      for (let turn = 0; turn < 40
        && (!_testExports._getFolderMembershipCleanupProven()
          || [...nativeRows.values()].some(folderId => folderId === null)); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(nativeRows.get('account1:/Caf\u00e9:nfc@example.com'))
        .toBe(makeFolderMembershipId('account1', '/Caf\u00e9'));
      expect(nativeRows.get('account1:/Cafe\u0301:nfd@example.com'))
        .toBe(makeFolderMembershipId('account1', '/Cafe\u0301'));
      expect(nativeRows.get('account1:/\ud83d\udce8:sender@[IPv6:2001:db8::1]'))
        .toBe(makeFolderMembershipId('account1', '/\ud83d\udce8'));
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reuses durable membership after restart when Thunderbird folder ids change', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const specs = [
        {
          folderPath: '/F:%/Caf\u00e9/\ud83d\udce8',
          weFolderId: 'session-old-nfc',
          headerMessageIds: ['nfc@example.com'],
        },
        {
          folderPath: '/F:%/Cafe\u0301/\ud83d\udce8',
          weFolderId: 'session-old-nfd',
          headerMessageIds: ['nfd@[IPv6:2001:db8::1]'],
        },
      ];
      const { folders, nativeRows, fts } = installExactMembershipFolders(specs);

      for (let turn = 0; turn < 40
        && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);

      const nfcMembershipId = makeFolderMembershipId('account1', specs[0].folderPath);
      const nfdMembershipId = makeFolderMembershipId('account1', specs[1].folderPath);
      expect(nfcMembershipId).not.toBe(nfdMembershipId);
      expect(new Set(nativeRows.values())).toEqual(new Set([
        nfcMembershipId,
        nfdMembershipId,
      ]));

      // Simulate a restart whose Thunderbird session minted different
      // MailFolder.id values, with one row's owner lost so the state pass
      // must assign it again through the new session's ids.
      folders[0].weFolderId = 'session-new-nfc';
      folders[1].weFolderId = 'session-new-nfd';
      globalThis.browser.accounts.list.mockResolvedValue([{
        id: 'account1', type: 'none',
        rootFolder: {
          path: '/', isRoot: true,
          subFolders: folders.map(folder => ({
            id: folder.weFolderId,
            path: folder.folderPath,
            subFolders: [],
          })),
        },
      }]);
      nativeRows.set(`account1:${specs[0].folderPath}:nfc@example.com`, null);
      nativeRows.set(`account1:${specs[1].folderPath}:nfd@[IPv6:2001:db8::1]`, null);
      fts.assignFolderMembershipBatch.mockClear();
      _testExports._resetFolderReconState();
      _testExports._setIsEnabled(true);
      _testExports._setIndexerDisposed(false);
      _testExports._setFtsSearch(fts);
      _testExports._setLastSyncEventMs(0);

      for (let turn = 0; turn < 40
        && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        const result = await settleSchedulerTickWithFakeTimers(fts);
        expect(result?.migration?.failed).not.toBe(true);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(new Set(nativeRows.values())).toEqual(new Set([
        nfcMembershipId,
        nfdMembershipId,
      ]));
      expect(fts.assignFolderMembershipBatch.mock.calls
        .flatMap(([assignments]) => assignments)
        .map(assignment => assignment.folderId))
        .toEqual(expect.arrayContaining([nfcMembershipId, nfdMembershipId]));
      expect(fts.assignFolderMembershipBatch.mock.calls
        .flatMap(([assignments]) => assignments)
        .some(assignment => assignment.folderId.startsWith('session-'))).toBe(false);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('removes a zero-candidate ghost of a loaded account under the fence and then cuts over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/F',
        folderId: 'opaque-parent',
        headerMessageIds: [],
      }]);
      const ghost = 'account1:/Gone:orphan@example.com';
      nativeRows.set(ghost, null);

      for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        await _testExports._runFolderReconSchedulerTick(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(nativeRows.has(ghost)).toBe(false);
      expect(fts.removeBatch).toHaveBeenCalledWith([ghost], expect.anything());
      // No folder can own the key, so no query is needed to call it a ghost,
      // and the replay that earns cutover reads pages only.
      expect(globalThis.browser.messages.query).not.toHaveBeenCalled();
      const telemetry = _testExports._getFolderReconRuntimeTelemetry();
      expect(telemetry.membershipStateRestartMutatedReplay).toBe(1);
      expect(telemetry.membershipStateRestartUnresolvedReplay).toBe(0);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('fails closed when a current opaque owner is attached to a mismatched raw key', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/F', folderId: 'opaque-parent', headerMessageIds: [],
      }]);
      const mismatched = 'account1:/Other:message@example.com';
      nativeRows.set(mismatched, makeFolderMembershipId('account1', '/F'));
      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({
        complete: false,
        migration: { failed: true, restart: true, reason: 'unresolved_legacy_rows' },
      });
      expect(nativeRows.has(mismatched)).toBe(true);
      expect(fts.removeBatch).not.toHaveBeenCalled();
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('treats a state-pass assignment for a vanished native row as an accounted no-op', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const msgId = 'account1:/F:vanished@example.com';
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/F',
        folderId: 'opaque-parent',
        headerMessageIds: ['vanished@example.com'],
      }]);
      const assign = fts.assignFolderMembershipBatch.getMockImplementation();
      fts.assignFolderMembershipBatch.mockImplementationOnce(async (assignments, ...rest) => {
        // The row is listed ownerless, then deleted before its assignment.
        nativeRows.delete(msgId);
        return assign(assignments, ...rest);
      });

      const passResult = await _testExports._runFolderReconSchedulerTick(fts);

      expect(passResult).toMatchObject({ complete: false, migration: { restart: true } });
      expect(passResult.migration.failed).toBeUndefined();
      // A page without removals assigns unfenced (no fence token).
      expect(fts.assignFolderMembershipBatch).toHaveBeenCalledWith([{
        msgId,
        folderId: makeFolderMembershipId('account1', '/F'),
      }], null);
      expect(fts.filterNewMessages).not.toHaveBeenCalled();
      expect(nativeRows.has(msgId)).toBe(false);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);

      // The replay is the next pass turn; the folder turn between them
      // reconciles /F without reading a state page.
      for (let turn = 0; turn < 2 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(2);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('enumerates an unbounded legacy relation backlog through bounded native pages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const headerMessageIds = Array.from(
        { length: reconConfig.membershipStatePageSize * 2 + 1 },
        (_, index) => `legacy-${String(index).padStart(4, '0')}@example.com`,
      );
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/F',
        folderId: 'opaque-parent',
        headerMessageIds,
      }]);
      for (let turn = 0; turn < 20
        && (!_testExports._getFolderMembershipCleanupProven()
          || !_testExports._getFolderReconSessionDone().has('account1:/F'));
        turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect([...nativeRows.values()].every(folderId =>
        folderId === makeFolderMembershipId('account1', '/F'))).toBe(true);
      expect(_testExports._getFolderReconSessionDone()).toContain('account1:/F');
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(6);
      expect(fts.listFolderMembershipState.mock.calls.every(
        ([, limit]) => limit === reconConfig.membershipStatePageSize,
      )).toBe(true);
      expect(fts.assignFolderMembershipBatch.mock.calls.every(
        ([assignments]) => assignments.length <= reconConfig.membershipAssignBatchSize,
      )).toBe(true);
      expect(fts.listFolderMembership.mock.calls.filter(
        ([folderId]) => folderId === makeFolderMembershipId('account1', '/F'),
      ).length).toBeGreaterThanOrEqual(3);
      expectOnlyBoundedFolderMembershipReads(fts);
      expect(populateBatchBody).not.toHaveBeenCalled();
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    {
      name: 'deleted folder',
      specs: [{ folderPath: '/Keep', folderId: 'opaque-keep', headerMessageIds: ['keep@example.com'] }],
      stale: ['account1:/Deleted:stale@example.com', 'opaque-deleted'],
    },
    {
      name: 'renamed folder',
      specs: [{ folderPath: '/New', folderId: 'opaque-new', headerMessageIds: ['live@example.com'] }],
      stale: ['account1:/Old:live@example.com', 'opaque-old'],
    },
  ])('removes assigned stale ownership and converges for $name', async ({ specs, stale }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { nativeRows, fts } = installExactMembershipFolders(specs);
      for (const [msgId] of nativeRows) {
        const owner = specs.find(spec => msgId.startsWith(`account1:${spec.folderPath}:`));
        nativeRows.set(msgId, makeFolderMembershipId('account1', owner.folderPath));
      }
      nativeRows.set(stale[0], stale[1]);

      for (let turn = 0; turn < 40
        && (!_testExports._getFolderMembershipCleanupProven()
          || nativeRows.has(stale[0])); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(nativeRows.has(stale[0])).toBe(false);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      for (const spec of specs) {
        expect(nativeRows.has(`account1:${spec.folderPath}:${spec.headerMessageIds[0]}`)).toBe(true);
      }
      expect(fts.removeBatch).toHaveBeenCalledWith([stale[0]], expect.anything());
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // INVARIANT (2026-09-10 cold-start wipe): `browser.accounts.list(true)` only
  // describes what Thunderbird has LOADED. A membership row whose opaque owner
  // is absent from the inventory may be removed only when the row's ACCOUNT is
  // present in that inventory; an account with no enumerated folder is
  // unknown, never deleted. Before the fix both the migration state pass and
  // the post-cutover orphan sweep removed every such row, wiping ~58k rows
  // across the four accounts Thunderbird had not loaded yet.
  it('never removes a row on inventory absence when Thunderbird has loaded no folders at all', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { nativeRows, fts } = installExactMembershipFolders([]);
      const coldRows = [
        ['account1:/Gone:stale@example.com', 'opaque-gone'],
        ['account1:/Archive:kept@example.com', makeFolderMembershipId('account1', '/Archive')],
      ];
      for (const [msgId, folderId] of coldRows) nativeRows.set(msgId, folderId);

      for (let turn = 0; turn < 40; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      for (const [msgId] of coldRows) expect(nativeRows.has(msgId)).toBe(true);
      expect(fts.removeBatch).not.toHaveBeenCalled();
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps rows of an account absent from a cold inventory while still removing stale rows of a loaded account', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/Keep', folderId: 'opaque-keep', headerMessageIds: ['keep@example.com'],
      }]);
      nativeRows.set(
        'account1:/Keep:keep@example.com',
        makeFolderMembershipId('account1', '/Keep'),
      );
      // account1 is loaded (it contributed a folder) and this folder is gone:
      // genuine deleted-folder evidence, must still be removed.
      const stale = 'account1:/Deleted:stale@example.com';
      nativeRows.set(stale, 'opaque-deleted');
      // account2 contributed NO folder to the inventory: not loaded yet. Every
      // one of its rows must survive both the state pass and the orphan sweep.
      const coldRows = Array.from({ length: 3 }, (_, index) =>
        `account2:/Archive:cold-${index}@example.com`);
      for (const msgId of coldRows) {
        nativeRows.set(msgId, makeFolderMembershipId('account2', '/Archive'));
      }

      for (let turn = 0; turn < 40
        && (!_testExports._getFolderMembershipCleanupProven()
          || !_testExports._getFolderReconSessionDone().has('account1:/Keep')
          || nativeRows.has(stale)); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }
      // Keep ticking so the post-cutover orphan sweep gets its turns too.
      for (let turn = 0; turn < 20; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(nativeRows.has(stale)).toBe(false);
      expect(nativeRows.has('account1:/Keep:keep@example.com')).toBe(true);
      for (const msgId of coldRows) expect(nativeRows.has(msgId)).toBe(true);
      const removedKeys = fts.removeBatch.mock.calls.flatMap(([ids]) => ids);
      expect(removedKeys).toEqual([stale]);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('removes an orphan by authoritative unknown folderId in the state pass without reparsing', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/Keep', folderId: 'opaque-keep', headerMessageIds: ['keep@example.com'],
      }]);
      nativeRows.set(
        'account1:/Keep:keep@example.com',
        makeFolderMembershipId('account1', '/Keep'),
      );
      // Owned by a folder no longer in the inventory (its account is loaded).
      const orphan = 'account1:/Former:sender@[IPv6:2001:db8::1]';
      nativeRows.set(orphan, 'opaque-former');
      for (let turn = 0; turn < 30
        && (!_testExports._getFolderMembershipCleanupProven()
          || !_testExports._getFolderReconSessionDone().has('account1:/Keep'));
        turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(nativeRows.has(orphan)).toBe(false);
      expect(nativeRows.has('account1:/Keep:keep@example.com')).toBe(true);
      expect(globalThis.browser.messages.query).not.toHaveBeenCalledWith(
        expect.objectContaining({ headerMessageId: 'sender@[IPv6:2001:db8::1]' }),
      );
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('limits exact native enumeration to one page per scheduler slice across many pages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const headerMessageIds = Array.from(
        { length: reconConfig.membershipListPageSize * 3 + 1 },
        (_, index) => `page-${String(index).padStart(4, '0')}@example.com`,
      );
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/Paged', folderId: 'opaque-paged', headerMessageIds,
      }]);
      for (const msgId of nativeRows.keys()) {
        nativeRows.set(msgId, makeFolderMembershipId('account1', '/Paged'));
      }
      const callsPerTurn = [];
      let ordinaryTurns = 0;

      for (let turn = 0; turn < 40
        && (!_testExports._getFolderMembershipCleanupProven()
          || !_testExports._getFolderReconSessionDone().has('account1:/Paged'));
        turn++) {
        const before = fts.listFolderMembership.mock.calls.length
          + fts.listFolderMembershipState.mock.calls.length;
        await settleSchedulerTickWithFakeTimers(fts);
        const after = fts.listFolderMembership.mock.calls.length
          + fts.listFolderMembershipState.mock.calls.length;
        callsPerTurn.push(after - before);
        await Promise.resolve().then(() => { ordinaryTurns++; });
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderReconSessionDone()).toContain('account1:/Paged');
      expect(fts.listFolderMembership.mock.calls.length).toBeGreaterThan(3);
      expect(callsPerTurn.every(count => count <= 1)).toBe(true);
      expect(ordinaryTurns).toBe(callsPerTurn.length);
      expectOnlyBoundedFolderMembershipReads(fts);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('advances a mismatched exact-membership stale cursor across page-budget slices', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const headerMessageIds = Array.from(
        { length: reconConfig.stalePageKeys + 2 },
        (_, index) => `stale-page-${String(index).padStart(4, '0')}@example.com`,
      );
      const folderKey = 'account1:/PagedMismatch';
      const folderId = makeFolderMembershipId('account1', '/PagedMismatch');
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/PagedMismatch', folderId: 'opaque-paged-mismatch', headerMessageIds,
      }]);
      for (const msgId of nativeRows.keys()) nativeRows.set(msgId, folderId);
      // The final local header is absent from native FTS. The stale pass must
      // traverse a nonterminal 100-key page before missing-direction repair.
      nativeRows.delete(`${folderKey}:${headerMessageIds.at(-1)}`);
      const staleGhost = `${folderKey}:zzzz-stale@example.com`;
      nativeRows.set(staleGhost, folderId);
      globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (_uri, ids) => ({
        missing: ids.filter(id => id === 'zzzz-stale@example.com'),
      }));
      headerIDToWeID.mockImplementation(async id => headerMessageIds.indexOf(id) + 1);
      globalThis.browser.messages.get = vi.fn(async id => ({
        id,
        headerMessageId: headerMessageIds[id - 1],
        folder: { accountId: 'account1', path: '/PagedMismatch' },
      }));
      getUniqueMessageKey.mockImplementation(async h => `${folderKey}:${h.headerMessageId}`);
      buildBatchHeader.mockImplementation(async headers => headers.map(h => ({
        msgId: `${folderKey}:${h.headerMessageId}`, folderId,
      })));
      populateBatchBody.mockImplementation(async rows => ({
        successfulRows: rows, failedMsgIds: [],
      }));
      fts.indexBatch = vi.fn(async rows => runFtsMembershipMutation(async () => {
        for (const row of rows) nativeRows.set(row.msgId, row.folderId);
        return { count: rows.length };
      }));
      const callsPerTurn = [];
      for (let turn = 0; turn < 35 && !storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
        ?.folders?.[folderKey]?.staleAfterKey; turn++) {
        const before = fts.listFolderMembership.mock.calls.length
          + fts.listFolderMembershipState.mock.calls.length;
        await settleSchedulerTickWithFakeTimers(fts);
        const after = fts.listFolderMembership.mock.calls.length
          + fts.listFolderMembershipState.mock.calls.length;
        callsPerTurn.push(after - before);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(callsPerTurn.every(count => count <= 1)).toBe(true);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
        .folders[folderKey].staleAfterKey)
        .toBe(`${folderKey}:${headerMessageIds[99]}`);
      expect(fts.filterNewMessages).toHaveBeenCalled();

      for (let turn = 0; turn < 100 && !_testExports._getFolderReconSessionDone().has(folderKey); turn++) {
        const before = fts.listFolderMembership.mock.calls.length
          + fts.listFolderMembershipState.mock.calls.length;
        await settleSchedulerTickWithFakeTimers(fts);
        const after = fts.listFolderMembership.mock.calls.length
          + fts.listFolderMembershipState.mock.calls.length;
        callsPerTurn.push(after - before);
        if (_testExports._getPendingUpdates().size > 0) {
          _testExports._setFtsSearch(fts);
          await flushPendingUpdates();
          _testExports._setFtsSearch(null);
        }
        vi.setSystemTime(Date.now() + 1000);
      }

      expect(callsPerTurn.every(count => count <= 1)).toBe(true);
      expect(fts.listFolderMembership.mock.calls.some(
        ([id, after, limit]) => id === folderId && after !== null
          && limit === reconConfig.stalePageKeys,
      )).toBe(true);
      expect(fts.removeBatch).toHaveBeenCalledWith([staleGhost], expect.anything());
      expect(fts.indexBatch).toHaveBeenCalled();
      expect([...nativeRows.keys()].sort()).toEqual(
        headerMessageIds.map(id => `${folderKey}:${id}`).sort(),
      );
      expect(_testExports._getPendingUpdates().size).toBe(0);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
        .folders[folderKey]).toMatchObject({ verified: true, expectedCount: 102, ftsCount: 102 });
      expect(_testExports._getFolderReconSessionDone()).toContain(folderKey);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('finishes terminal verification within the one-page native budget', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const folderKey = 'account1:/TerminalBudget';
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/TerminalBudget', headerMessageIds: ['missing@example.com'],
      }]);
      nativeRows.clear();
      // A false-negative filter still needs a completed terminal comparison,
      // so the checkpoint can record a retry instead of failing on page budget.
      fts.filterNewMessages.mockResolvedValue({ newMsgIds: [] });
      const pagesPerTurn = [];
      for (let turn = 0; turn < 35 && !storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
        ?.folders?.[folderKey]?.partialPostVerifyFailureCount; turn++) {
        const before = fts.listFolderMembership.mock.calls.length
          + fts.listFolderMembershipState.mock.calls.length;
        await settleSchedulerTickWithFakeTimers(fts);
        pagesPerTurn.push(fts.listFolderMembership.mock.calls.length
          + fts.listFolderMembershipState.mock.calls.length - before);
        vi.setSystemTime(Date.now() + 1000);
      }
      expect(pagesPerTurn.every(count => count <= 1)).toBe(true);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
        .folders[folderKey]).toMatchObject({
        verified: false,
        partialPostVerifyFailureCount: 1,
      });
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });


  it.each([
    ['a rename lands while the terminal page is read', 'page'],
    ['a rename lands right after the inventory snapshot', 'inventory'],
    ['the inventory is unchanged (control)', null],
  ])('publishes cutover from a terminal state page only when no topology change overtook it: %s', async (_label, renameAt) => {
    const rename = renameAt !== null;
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const renameListeners = new Set();
    globalThis.browser.folders = {
      onRenamed: {
        addListener: listener => renameListeners.add(listener),
        removeListener: listener => renameListeners.delete(listener),
      },
    };
    incrementalIndexer.setupFolderTopologyListeners();
    try {
      const { fts, nativeRows, folders, rowsByURI } = installExactMembershipFolders([{
        folderPath: '/Z', headerMessageIds: ['zz-1@example.com'],
      }]);
      await settleSchedulerTickWithFakeTimers(fts); // the state pass assigns every row
      vi.setSystemTime(Date.now() + 100);
      await settleSchedulerTickWithFakeTimers(fts); // a folder turn walks /Z
      vi.setSystemTime(Date.now() + 100);
      // The tick below reads the replay's terminal page.
      expect(_testExports._getFolderReconMembershipTurn()).toBe('pass');
      const ownerPath = rename ? '/A' : '/Z';
      const ownedWrite = `account1:${ownerPath}:aa-new@example.com`;
      const renameZToA = () => {
        folders[0].folderPath = '/A';
        folders[0].folderId = makeFolderMembershipId('account1', '/A');
        globalThis.browser.accounts.list.mockResolvedValue([{
          id: 'account1', type: 'none',
          rootFolder: {
            path: '/', isRoot: true,
            subFolders: [{ id: folders[0].weFolderId, path: '/A', subFolders: [] }],
          },
        }]);
        for (const listener of [...renameListeners]) {
          listener({ accountId: 'account1', path: '/Z' }, { accountId: 'account1', path: '/A' });
        }
      };
      if (renameAt === 'inventory') {
        // The snapshot still lists /Z; the rename completes just after it.
        const oldInventory = await globalThis.browser.accounts.list();
        globalThis.browser.accounts.list.mockImplementationOnce(async () => {
          renameZToA();
          return oldInventory;
        });
      }
      fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
        const page = await fts.listFolderMembershipState.getMockImplementation()(after, limit);
        if (renameAt === 'page') renameZToA();
        // The drain commits a correctly owned row behind the cursor through
        // the real membership coordinator, for a message the folder holds
        // (folder turns now walk it before cleanup completes).
        rowsByURI.get(folders[0].folderURI).push({ msgKey: 2, headerMessageId: 'aa-new@example.com' });
        await runFtsMembershipMutation(async () => {
          nativeRows.set(ownedWrite, makeFolderMembershipId('account1', ownerPath));
        });
        return page;
      });
      const epochBefore = getFtsMembershipEpoch();

      await _testExports._runFolderReconSchedulerTick(fts);

      expect(getFtsMembershipEpoch()).toBeGreaterThan(epochBefore);
      expect(nativeRows.get(ownedWrite)).toBe(makeFolderMembershipId('account1', ownerPath));
      if (!rename) {
        // Ownership-preserving drift alone never restarts the pass.
        expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
        return;
      }
      // The pass judged an inventory the rename overtook: no cutover from it.
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
      const stateReadsBefore = fts.listFolderMembershipState.mock.calls.length;
      for (let turn = 0; turn < 12 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 1000);
        await settleSchedulerTickWithFakeTimers(fts);
      }
      // A fresh pass over the new inventory earns it and drops the old owner.
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(fts.listFolderMembershipState.mock.calls[stateReadsBefore][0]).toBeNull();
      expect(nativeRows.has('account1:/Z:zz-1@example.com')).toBe(false);
      expect(nativeRows.get(ownedWrite)).toBe(makeFolderMembershipId('account1', '/A'));
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      delete globalThis.browser.folders;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
  it('does not bind a stale cursor to a native digest from before a removal', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const headerMessageIds = Array.from(
        { length: reconConfig.stalePageKeys + 2 },
        (_, index) => `live-${String(index).padStart(4, '0')}@example.com`,
      );
      const folderKey = 'account1:/PagedGhost';
      const folderId = makeFolderMembershipId('account1', '/PagedGhost');
      const ghost = `${folderKey}:000-ghost@example.com`;
      const missing = `${folderKey}:${headerMessageIds.at(-1)}`;
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/PagedGhost', headerMessageIds,
      }]);
      for (const msgId of nativeRows.keys()) nativeRows.set(msgId, folderId);
      nativeRows.delete(missing);
      nativeRows.set(ghost, folderId);
      globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (_uri, ids) => ({
        missing: ids.filter(id => id === '000-ghost@example.com'),
      }));

      for (let turn = 0; turn < 35 && fts.removeBatch.mock.calls.length === 0; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }
      expect(fts.removeBatch).toHaveBeenCalledWith([ghost], expect.anything());
      expect(nativeRows.has(ghost)).toBe(false);
      // The native deletion changed the native proof, not the local headers.
      // The missing-direction pass can still admit the real local row now.
      expect(fts.filterNewMessages).toHaveBeenCalledWith(
        expect.arrayContaining([{ msgId: missing }]));
      expect(_testExports._getPendingUpdates().get(missing)).toMatchObject({ type: 'new' });
      expect(_testExports._getFolderReconActiveProofKey()).toBe(folderKey);
      const checkpoint = storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
        ?.folders?.[folderKey];
      expect(checkpoint?.verified).not.toBe(true);
      if (typeof checkpoint?.staleAfterKey === 'string') {
        expect(checkpoint.partialStaleFtsCount).toBe(nativeRows.size);
        expect(checkpoint.partialStaleFtsSha256).toBe(framedDigest([...nativeRows.keys()]));
      }
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('drops a membership-state page at a pressure boundary without minting cutover', async () => {
    const { fts } = installExactMembershipFolders([
      {
        folderPath: '/F',
        folderId: 'opaque-parent',
        headerMessageIds: ['parent@example.com'],
      },
    ]);
    const pageStarted = deferred();
    const allowPage = deferred();
    const listState = fts.listFolderMembershipState.getMockImplementation();
    fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
      pageStarted.resolve();
      await allowPage.promise;
      return listState(after, limit);
    });

    const running = _testExports._runFolderReconSchedulerTick(fts);
    await pageStarted.promise;
    getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
    allowPage.resolve();
    const result = await running;

    expect(result).toMatchObject({ skipped: true, reason: 'pressure' });
    expect(fts.assignFolderMembershipBatch).not.toHaveBeenCalled();
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
  });

  it('commits an ownerless row classified while pressure rises inside its msgDB probe, then yields', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, folders, nativeRows } = installExactMembershipFolders([
        { folderPath: '/F', headerMessageIds: ['parent@example.com'] },
      ]);
      const row = 'account1:/F:parent@example.com';
      const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
      globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementationOnce(async (...args) => {
        getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
        return probe(...args);
      });

      const result = await settleSchedulerTickWithFakeTimers(fts);

      // The classified row is a bounded write: it commits, then the tick yields.
      expect(result).toMatchObject({ skipped: true, reason: 'pressure' });
      expect(nativeRows.get(row)).toBe(folders[0].folderId);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
      getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
      await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // INVARIANT (2026-10-02): the pass certifies that every row has a live,
  // structurally prefixing owner. Capable writes preserve that, so new mail
  // indexed while the pass runs must neither restart nor skip it; before this
  // the pass reset to page one on every membership epoch change and could
  // never finish under steady mail.
  it('keeps the global membership-state pass across an ownership-preserving write mid-page', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const headerMessageIds = Array.from(
        { length: reconConfig.membershipStatePageSize + 1 },
        (_, index) => `drift-${String(index).padStart(4, '0')}@example.com`,
      );
      const { fts, nativeRows } = installExactMembershipFolders([{
        folderPath: '/F', headerMessageIds,
      }], { assigned: true });
      const folderId = makeFolderMembershipId('account1', '/F');
      const behindCursor = 'account1:/F:drift-0000-new@example.com';
      fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
        const page = await fts.listFolderMembershipState.getMockImplementation()(after, limit);
        // New mail, indexed with its owner, lands behind the cursor.
        await runFtsMembershipMutation(async () => { nativeRows.set(behindCursor, folderId); });
        return page;
      });

      const first = await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 100);
      // A folder turn between the two pass turns reads no state page.
      const folderTurn = await _testExports._runFolderReconSchedulerTick(fts);
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 100);
      const second = await _testExports._runFolderReconSchedulerTick(fts);

      expect(first).toMatchObject({ complete: false, migration: { membershipStateProgress: true } });
      expect(folderTurn.migration).toBeUndefined();
      expect(second.migration).toBeUndefined();
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      const cursors = fts.listFolderMembershipState.mock.calls.map(([after]) => after);
      expect(cursors).toHaveLength(2);
      expect(cursors[0]).toBeNull();
      expect(cursors[1]).toBe(`account1:/F:${headerMessageIds[reconConfig.membershipStatePageSize - 1]}`);
      expect(nativeRows.get(behindCursor)).toBe(folderId);
      expectOnlyBoundedFolderMembershipReads(fts);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('restarts global proof from page one after capability downgrade and re-upgrade', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const headerMessageIds = Array.from(
        { length: reconConfig.membershipStatePageSize + 1 },
        (_, index) => `downgrade-${String(index).padStart(4, '0')}@example.com`,
      );
      const { fts } = installExactMembershipFolders([{
        folderPath: '/F', folderId: 'opaque-parent', headerMessageIds,
      }], { assigned: true });
      let capable = true;
      fts.supportsFolderMembership.mockImplementation(() => capable);
      await _testExports._runFolderReconSchedulerTick(fts); // state page one
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(1);
      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
      capable = false;
      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts);
      capable = true;
      vi.setSystemTime(Date.now() + 100);

      const restarted = await _testExports._runFolderReconSchedulerTick(fts);

      expect(restarted).toMatchObject({
        complete: false,
        migration: { membershipStateProgress: true },
      });
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(2);
      // Page one again, not the page-two cursor the downgraded pass reached.
      expect(fts.listFolderMembershipState.mock.calls[1][0]).toBeNull();
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // A stale owner is judged against the tick's inventory snapshot. A row
  // indexed after that snapshot into a just-created folder is
  // indistinguishable from a deleted folder's row, so the removal is fenced
  // on the epoch read before the snapshot and retried on the SAME page when
  // that fence loses: nothing is removed on stale evidence, nothing skipped.
  it('retries a stale-owner removal on the same page when its inventory fence loses', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts, nativeRows } = installExactMembershipFolders([{
        folderPath: '/Keep', headerMessageIds: ['keep@example.com'],
      }], { assigned: true });
      const stale = 'account1:/Deleted:stale@example.com';
      nativeRows.set(stale, makeFolderMembershipId('account1', '/Deleted'));
      fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
        await runFtsMembershipMutation(async () => ({ ok: true }));
        return fts.listFolderMembershipState.getMockImplementation()(after, limit);
      });

      const lost = await _testExports._runFolderReconSchedulerTick(fts);

      expect(lost).toMatchObject({
        complete: false,
        migration: { retry: true, reason: 'stale_folder_remove_fence_lost' },
      });
      expect(fts.removeBatch).not.toHaveBeenCalled();
      expect(nativeRows.has(stale)).toBe(true);
      expect(_testExports._getFolderReconRuntimeTelemetry().membershipStatePageRetries).toBe(1);

      for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }

      expect(nativeRows.has(stale)).toBe(false);
      expect(fts.removeBatch).toHaveBeenCalledWith([stale], expect.anything());
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      // Same page retried (null), then a full replay after the removal (null).
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after))
        .toEqual([null, null, null]);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // The stale-owner removal reads only its own key's writes: a write to
  // another key leaves it standing, even one indexed into the deleted
  // folder's path (a folder re-created after the snapshot is a topology
  // event, which refuses the page). A write that attempted the stale key
  // itself refuses that row alone, as unresolved debt.
  it.each([
    { written: 'unrelated', topology: false, outcome: 'removed' },
    { written: 'recreated', topology: false, outcome: 'removed' },
    { written: 'recreated', topology: true, outcome: 'page_retry' },
    { written: 'same key', topology: false, outcome: 'row_refused' },
  ])('stale-owner removal when a scoped write lands after the inventory snapshot: written=$written topology=$topology', async ({ written, topology, outcome }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows, folders } = installExactMembershipFolders([{
        folderPath: '/Keep', headerMessageIds: ['keep@example.com'],
      }], { assigned: true });
      const deletedId = makeFolderMembershipId('account1', '/Deleted');
      const stale = 'account1:/Deleted:stale@example.com';
      nativeRows.set(stale, deletedId);
      const [writtenKey, owner] = {
        unrelated: ['account1:/Keep:late@example.com', folders[0].folderId],
        recreated: ['account1:/Deleted:new@example.com', deletedId],
        'same key': [stale, deletedId],
      }[written];
      fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
        const page = await fts.listFolderMembershipState.getMockImplementation()(after, limit);
        await runFtsMembershipMutation(async () => { nativeRows.set(writtenKey, owner); }, null,
          { msgIds: [writtenKey], folderIds: [owner], keys: [writtenKey] });
        if (topology) _testExports._onFolderReconTopologyChanged();
        return page;
      });

      const result = await _testExports._runFolderReconSchedulerTick(fts);

      if (outcome === 'page_retry') {
        expect(result).toMatchObject({ migration: { retry: true } });
        expect(nativeRows.has(stale)).toBe(true);
        expect(fts.assignFolderMembershipBatch).not.toHaveBeenCalled();
      } else if (outcome === 'row_refused') {
        expect(result).toMatchObject({ migration: { restart: true, reason: 'unresolved_legacy_rows' } });
        expect(nativeRows.has(stale)).toBe(true);
        expect(fts.removeBatch).not.toHaveBeenCalled();
      } else {
        expect(result?.migration?.retry).not.toBe(true);
        expect(nativeRows.has(stale)).toBe(false);
      }
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('uses exact path-boundary lookups instead of a quadratic ambiguity census', () => {
    const sourcePath = fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const census = source.match(
      /function _folderReconAmbiguousKeyspaces[\s\S]*?\n}\n\n\/\*\*/,
    )?.[0] || '';

    expect(census).not.toMatch(/for \(let j = i \+ 1; j < valid\.length; j\+\+\)/);
    expect(census).toContain('path.indexOf(":")');
  });

  it('tests orphan ownership by msgId boundaries without scanning every folder', () => {
    const sourcePath = fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const sweep = source.match(
      /async function _folderReconOrphanSweep[\s\S]*?\n}\n\n\/\*\*\n \* Startup fingerprint/,
    )?.[0] || '';

    expect(sweep).not.toContain('knownPrefixes.some');
    expect(sweep).toContain('_folderReconMsgIdHasKnownFolderPrefix');
  });

  it('canonicalizes duplicate inventory identities before folder and orphan proof', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const live = 'account1:/A:live@example.com';
      const ghost = 'account1:/Gone:ghost@example.com';
      const nativeKeys = new Set([live, ghost]);
      globalThis.browser.accounts.list.mockResolvedValue([{
        id: 'account1', type: 'none',
        rootFolder: {
          path: '/', isRoot: true,
          subFolders: [
            { path: '/A', subFolders: [] },
            { path: '/A', subFolders: [] },
          ],
        },
      }]);
      let nextToken = 1;
      globalThis.browser.tmMsgNotify = {
        getFolderState: vi.fn(async () => ({
          accountId: 'account1', folderPath: '/A', folderURI: 'none://a',
          serverType: 'none', stableUidKeys: false,
        })),
        beginFolderMessageScan: vi.fn(async () => ({
          token: `duplicate-${nextToken++}`,
          accountId: 'account1', folderPath: '/A', serverType: 'none', stableUidKeys: false,
        })),
        readFolderMessageScanPage: vi.fn(async () => ({
          rows: [{ msgKey: 1, headerMessageId: 'live@example.com' }], done: true,
        })),
        cancelFolderMessageScan: vi.fn(async () => ({ cancelled: true })),
        probeMessageIds: vi.fn(async () => ({ missing: [] })),
      };
      const inRange = (start, end, after = null) =>
        sqliteNativeRange(nativeKeys, start, end, after);
      const fts = {
        fingerprintMsgIdRange: vi.fn(async (start, end) => {
          const rows = inRange(start, end);
          return { count: rows.length, sha256: framedDigest(rows) };
        }),
        countMsgIdRange: vi.fn(async (start, end) => ({ count: inRange(start, end).length })),
        listMsgIdRange: vi.fn(async (start, end, after, limit) => {
          const page = inRange(start, end, after).slice(0, limit);
          return { msgIds: page, done: page.length < limit };
        }),
        filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })),
        removeBatch: vi.fn(async ids => {
          for (const id of ids) nativeKeys.delete(id);
          return { count: ids.length };
        }),
        getMessageByMsgId: vi.fn(async id => (nativeKeys.has(id) ? { msgId: id } : null)),
        stats: vi.fn(async () => ({})),
      };
      _testExports._setFtsSearch(null);

      let result = null;
      for (let turn = 0; turn < 8 && result?.complete !== true; turn++) {
        result = await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 1000);
      }

      expect(result).toMatchObject({ complete: true });
      expect(nativeKeys).toEqual(new Set([live]));
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledOnce();
      expect(await sessionSettled()).toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('prunes a renamed abandoned identity and stale drain state so current work can complete', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const abandoned = {
        uniqueKey: 'account1:/Old:gone@example.com',
        type: 'new',
        timestamp: 1,
        folderKey: 'account1:/Old',
        metadata: {},
      };
      _testExports._getPendingUpdates().set(abandoned.uniqueKey, abandoned);
      await _testExports._abandonPendingUpdates([abandoned], 'renamed');
      _testExports._getFolderReconDrainSkipped().add('account1:/Old');

      const fts = installEmptyFolders([['account1', '/New']]);
      _testExports._setFtsSearch(fts);
      await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 1000);
      const completed = await _testExports._runFolderReconSchedulerTick(fts);

      expect(completed).toMatchObject({ complete: true });
      expect(_testExports._getFolderReconDirty()).not.toContain('account1:/Old');
      expect(_testExports._getFolderReconDrainSkipped()).not.toContain('account1:/Old');
      expect(_testExports._maybeScheduleFolderReconRerun()).toBeUndefined();
      expect(await sessionSettled()).toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('legacy sweep never removes a row on inventory absence when Thunderbird has loaded no folders at all', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const oldKey = 'account1:/Old:ghost@example.com';
      const keys = new Set([oldKey]);
      const fts = {
        fingerprintMsgIdRange: vi.fn(async (start, end) => {
          const rows = sqliteNativeRange(keys, start, end);
          return { count: rows.length, sha256: framedDigest(rows) };
        }),
        countMsgIdRange: vi.fn(async (start, end) => ({
          count: sqliteNativeRange(keys, start, end).length,
        })),
        listMsgIdRange: vi.fn(async (start, end, after, limit) => {
          const rows = sqliteNativeRange(keys, start, end, after);
          const page = rows.slice(0, limit);
          return { msgIds: page, done: page.length < limit };
        }),
        removeBatch: vi.fn(async ids => {
          let count = 0;
          for (const id of ids) count += keys.delete(id) ? 1 : 0;
          return { count };
        }),
        getMessageByMsgId: vi.fn(async id => (keys.has(id) ? { msgId: id } : null)),
        filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })),
        stats: vi.fn(async () => ({})),
      };
      recheckMessageInFolder.mockResolvedValue('absent');
      globalThis.browser.accounts.list.mockResolvedValue([]);
      globalThis.browser.tmMsgNotify = {
        getFolderState: vi.fn(),
        beginFolderMessageScan: vi.fn(),
        readFolderMessageScanPage: vi.fn(),
        cancelFolderMessageScan: vi.fn(),
        probeMessageIds: vi.fn(),
      };
      _testExports._setFtsSearch(fts);

      const runTick = async () => {
        let settled = false;
        const tick = _testExports._runFolderReconSchedulerTick(fts).then(value => { settled = true; return value; });
        for (let step = 0; step < 200 && !settled; step++) {
          await vi.advanceTimersByTimeAsync(_testExports.FOLDER_RECON_ENTRY_DELAY_MS);
        }
        return tick;
      };
      const first = await runTick();
      expect(first.orphan).toMatchObject({ basisProgress: true, orphanRemoved: 0 });
      // The scheduler's own armed timer may run a tick between the manual
      // ones, so drive until the terminal state rather than counting ticks.
      let second = first;
      for (let turn = 0; turn < 20 && second?.reason !== 'unloaded_accounts'; turn++) {
        vi.setSystemTime(Date.now() + 1000);
        second = await runTick();
      }

      // An empty inventory is a cold Thunderbird, not an empty mailbox: the row
      // survives, no recheck was even attempted, nothing was removed, and the
      // kept row holds the session incomplete while a capped re-inventory
      // retry is armed.
      expect(second).toMatchObject({ complete: false, reason: 'unloaded_accounts' });
      expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
      // A tick the scheduler's own timer started may still be in flight; it
      // ends in the same state and re-arms the retry.
      for (let step = 0; step < 200 && _testExports._isFolderReconSchedulerActive(); step++) {
        await vi.advanceTimersByTimeAsync(_testExports.FOLDER_RECON_ENTRY_DELAY_MS);
        await yieldToRealEventLoop();
      }
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(keys.has(oldKey)).toBe(true);
      expect(recheckMessageInFolder).not.toHaveBeenCalled();
      expect(fts.removeBatch).not.toHaveBeenCalled();
      expect(_testExports._getFolderReconRuntimeTelemetry().unloadedAccountRowsKept).toBeGreaterThan(0);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('legacy sweep keeps rows of an account absent from a cold inventory while still removing a rechecked-absent row of a loaded account', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const staleKey = 'account1:/Deleted:stale@example.com';
      const coldKeys = [
        'account2:/Archive:cold-0@example.com',
        'account2:/Archive:cold-1@example.com',
        'account2:/Archive:cold-2@example.com',
      ];
      const keys = new Set([staleKey, ...coldKeys]);
      const fts = {
        fingerprintMsgIdRange: vi.fn(async (start, end) => {
          const rows = sqliteNativeRange(keys, start, end);
          return { count: rows.length, sha256: framedDigest(rows) };
        }),
        countMsgIdRange: vi.fn(async (start, end) => ({
          count: sqliteNativeRange(keys, start, end).length,
        })),
        listMsgIdRange: vi.fn(async (start, end, after, limit) => {
          const rows = sqliteNativeRange(keys, start, end, after);
          const page = rows.slice(0, limit);
          return { msgIds: page, done: page.length < limit };
        }),
        removeBatch: vi.fn(async ids => {
          let count = 0;
          for (const id of ids) count += keys.delete(id) ? 1 : 0;
          return { count };
        }),
        getMessageByMsgId: vi.fn(async id => (keys.has(id) ? { msgId: id } : null)),
        filterNewMessages: vi.fn(async () => ({ newMsgIds: [] })),
        stats: vi.fn(async () => ({})),
      };
      // Only account1 is loaded, and its inventory has no /Deleted folder any more.
      installEmptyFolders([['account1', '/Keep']]);
      recheckMessageInFolder.mockResolvedValue('absent');
      _testExports._setFtsSearch(fts);

      let result = null;
      for (let turn = 0; turn < 20 && result?.reason !== 'unloaded_accounts'; turn++) {
        // Drive the tick's cooperative yields under fake timers until it settles.
        let settled = false;
        const tick = _testExports._runFolderReconSchedulerTick(fts).then(value => { settled = true; return value; });
        for (let step = 0; step < 200 && !settled; step++) {
          await vi.advanceTimersByTimeAsync(_testExports.FOLDER_RECON_ENTRY_DELAY_MS);
        }
        result = await tick;
        vi.setSystemTime(Date.now() + 1000);
      }

      // The cold account's rows hold the session incomplete; the loaded
      // account's stale row is removed after one live global recheck.
      expect(result).toMatchObject({ complete: false, reason: 'unloaded_accounts' });
      expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
      expect(recheckMessageInFolder).toHaveBeenCalledOnce();
      expect(keys.has(staleKey)).toBe(false);
      for (const key of coldKeys) expect(keys.has(key)).toBe(true);
      const removedKeys = fts.removeBatch.mock.calls.flatMap(([ids]) => ids);
      expect(removedKeys).toEqual([staleKey]);
      // The global recheck was only ever consulted for the loaded account's row.
      for (const [, weFolder] of recheckMessageInFolder.mock.calls) {
        expect(weFolder?.accountId ?? weFolder).not.toContain('account2');
      }
      expect(_testExports._getFolderReconRuntimeTelemetry().unloadedAccountRowsKept).toBeGreaterThanOrEqual(3);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps the session incomplete when work is dirtied while the completing tick is suspended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      _testExports._setFtsSearch(fts);
      const first = await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 1000);
      expect(first?.complete).not.toBe(true);

      const listStarted = deferred();
      const allowList = deferred();
      const list = globalThis.browser.accounts.list.getMockImplementation();
      globalThis.browser.accounts.list.mockImplementationOnce(async (...args) => {
        listStarted.resolve();
        await allowList.promise;
        return list(...args);
      });
      const completing = _testExports._runFolderReconSchedulerTick(fts);
      await listStarted.promise;
      const concurrent = {
        uniqueKey: 'account1:/A:late@example.com', type: 'deleted', timestamp: 2,
        folderKey: 'account1:/A', metadata: {},
      };
      _testExports._getPendingUpdates().set(concurrent.uniqueKey, concurrent);
      await _testExports._abandonPendingUpdates([concurrent], 'clear_race');
      allowList.resolve();
      const suspended = await completing;

      expect(suspended?.complete).not.toBe(true);
      expect(_testExports._getFolderReconDirty()).toContain('account1:/A');
      expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);

      // Control: without the concurrent dirtying, the same tick completes.
      vi.setSystemTime(Date.now() + reconConfig.errorDelayMs * 64);
      let result = null;
      for (let turn = 0; turn < 6 && result?.complete !== true; turn++) {
        result = await _testExports._runFolderReconSchedulerTick(fts);
        vi.setSystemTime(Date.now() + reconConfig.errorDelayMs * 64);
      }
      expect(result).toMatchObject({ complete: true });
      expect(await sessionSettled()).toBe(true);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reserves at least the prior slice duration before scheduling more reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      let scanNumber = 0;
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async uri => {
        scanNumber++;
        vi.setSystemTime(Date.now() + 100);
        const index = uri.endsWith('0') ? 0 : 1;
        return {
          token: `paced-${scanNumber}`,
          accountId: 'account1',
          folderPath: index === 0 ? '/A' : '/B',
          stableUidKeys: true,
          uidValidity: index + 1,
        };
      });
      _testExports._setFtsSearch(fts);

      await _testExports._runFolderReconSchedulerTick();
      expect(globalThis.browser.tmMsgNotify.getFolderState.mock.calls.map(call => call[1]))
        .toEqual(['/A']);
      await vi.advanceTimersByTimeAsync(99);
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledTimes(2));
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('migrates v2 proof/backoff fields intact and cancels a suspended scan safely', async () => {
    storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
      version: 2,
      folders: {
        'account1:/A': {
          verified: false,
          missingBackfillKey: 123,
          partialPostVerifyFailureCount: 4,
          partialRetryNotBeforeMs: 9999,
        },
      },
    };
    const memo = await _testExports._getFolderReconMemo();
    expect(memo).toMatchObject({
      version: 3,
      roundRobinCursor: null,
      folders: {
        'account1:/A': {
          missingBackfillKey: 123,
          partialPostVerifyFailureCount: 4,
          partialRetryNotBeforeMs: 9999,
        },
      },
    });

    let releasePage;
    globalThis.browser.tmMsgNotify = {
      beginFolderMessageScan: vi.fn(async () => ({
        token: 'scan', accountId: 'account1', folderPath: '/A',
      })),
      readFolderMessageScanPage: vi.fn(() => new Promise(resolve => { releasePage = resolve; })),
      cancelFolderMessageScan: vi.fn(async () => ({ cancelled: true })),
    };
    const scan = _testExports._scanFolderMessagesCooperatively({
      accountId: 'account1', folderPath: '/A', folderURI: 'imap://a',
    });
    await vi.waitFor(() => expect(releasePage).toBeTypeOf('function'));
    _testExports._resetFolderReconState();
    _testExports._setIsEnabled(true);
    releasePage({ rows: [], done: false });
    await expect(scan).rejects.toThrow('folder_recon_cancelled');
    expect(globalThis.browser.tmMsgNotify.cancelFolderMessageScan).toHaveBeenCalledWith('scan');
  });

  it('does not let an old reconciliation finally release a newer generation owner', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    const folder = {
      accountId: 'account1', folderPath: '/A', folderURI: 'imap://folder-0',
      serverType: 'imap', stableUidKeys: true, uidValidity: 1,
    };
    const oldState = deferred();
    const newState = deferred();
    globalThis.browser.tmMsgNotify.getFolderState
      .mockImplementationOnce(() => oldState.promise)
      .mockImplementationOnce(() => newState.promise);

    const oldRun = _testExports._runFolderReconcile(fts);
    await vi.waitFor(() => expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledTimes(1));

    _testExports._resetFolderReconState();
    _testExports._setIsEnabled(true);
    _testExports._setIndexerDisposed(false);
    _testExports._setFtsSearch(fts);
    const newRun = _testExports._runFolderReconcile(fts);
    await vi.waitFor(() => expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledTimes(2));

    oldState.resolve(folder);
    await expect(oldRun).rejects.toThrow('folder_recon_cancelled');
    await expect(_testExports._runFolderReconSchedulerTick(fts)).resolves.toMatchObject({
      skipped: true,
      reason: 'busy',
    });

    newState.resolve(folder);
    await expect(newRun).resolves.toMatchObject({ foldersClean: 1 });
  });

  it('issues no later scan or native call after disposal wins a suspended folder-state await', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    const folder = {
      accountId: 'account1', folderPath: '/A', folderURI: 'imap://folder-0',
      serverType: 'imap', stableUidKeys: true, uidValidity: 1,
    };
    const state = deferred();
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementationOnce(() => state.promise);

    const oldRun = _testExports._runFolderReconcile(fts);
    await vi.waitFor(() => expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledOnce());
    fts.fingerprintMsgIdRange.mockClear();
    _testExports._resetFolderReconState();
    _testExports._setIndexerDisposed(true);
    state.resolve(folder);

    await expect(oldRun).rejects.toThrow('folder_recon_cancelled');
    expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).not.toHaveBeenCalled();
    expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
    expect(fts.removeBatch).not.toHaveBeenCalled();
  });

  it('does not let an old scheduler finally release a newer generation owner', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    const accounts = await globalThis.browser.accounts.list(true);
    globalThis.browser.accounts.list.mockClear();
    const oldInventory = deferred();
    const newInventory = deferred();
    globalThis.browser.accounts.list
      .mockImplementationOnce(() => oldInventory.promise)
      .mockImplementationOnce(() => newInventory.promise)
      .mockResolvedValue(accounts);

    const oldTick = _testExports._runFolderReconSchedulerTick(fts);
    await vi.waitFor(() => expect(globalThis.browser.accounts.list).toHaveBeenCalledTimes(1));

    _testExports._resetFolderReconState();
    _testExports._setIsEnabled(true);
    _testExports._setIndexerDisposed(false);
    _testExports._setFtsSearch(fts);
    const newTick = _testExports._runFolderReconSchedulerTick(fts);
    await vi.waitFor(() => expect(globalThis.browser.accounts.list).toHaveBeenCalledTimes(2));

    oldInventory.resolve(accounts);
    await expect(oldTick).rejects.toThrow('folder_recon_cancelled');
    await expect(_testExports._runFolderReconSchedulerTick(fts)).resolves.toMatchObject({
      skipped: true,
      reason: 'busy',
    });

    newInventory.resolve(accounts);
    await expect(newTick).resolves.toMatchObject({ foldersClean: 1 });
  });

  it('reports bounded aggregate-only reconciliation telemetry and resets it per generation', async () => {
    const rows = [
      { msgKey: 1, headerMessageId: 'one@example.com' },
      { msgKey: 2, headerMessageId: 'two@example.com' },
    ];
    const folder = installFolderRows(rows);
    globalThis.browser.tmMsgNotify.getFolderMessageScanStats = vi.fn(async () => ({
      live: 1,
      maxLive: 8,
      idleTtlMs: 5 * 60 * 1000,
    }));

    await _testExports._scanFolderMessagesCooperatively(folder);
    getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
    _testExports._setFtsSearch({});
    await _testExports._runFolderReconSchedulerTick();
    const status = await getIncrementalIndexerStatus();

    expect(status.folderRecon).toMatchObject({
      scanPages: 1,
      scanHeaders: 2,
      schedulerTicks: 1,
      schedulerPressureSkips: 1,
      maxPendingObserved: 0,
    });
    expect(status.folderRecon.scanHeaders).toBeGreaterThanOrEqual(status.folderRecon.scanPages);
    expect(status.folderRecon.maxPendingObserved).toBeLessThanOrEqual(reconConfig.pendingHighWater);
    for (const field of [
      'scanPages',
      'scanHeaders',
      'schedulerTicks',
      'schedulerSlices',
      'schedulerPressureSkips',
      'schedulerBusySkips',
      'lastSliceElapsedMs',
      'maxSliceElapsedMs',
      'lastScheduledDelayMs',
      'maxScheduledDelayMs',
      'maxPendingObserved',
    ]) {
      expect(Number.isSafeInteger(status.folderRecon[field]), `${field} is bounded`).toBe(true);
      expect(status.folderRecon[field], `${field} is non-negative`).toBeGreaterThanOrEqual(0);
    }
    expect(status.folderRecon.lastSliceElapsedMs).toBeLessThanOrEqual(
      status.folderRecon.maxSliceElapsedMs,
    );
    expect(status.folderRecon.lastScheduledDelayMs).toBeLessThanOrEqual(
      status.folderRecon.maxScheduledDelayMs,
    );
    expect(status.folderRecon.scanTokens).toEqual({
      live: 1,
      maxLive: 8,
      idleTtlMs: 5 * 60 * 1000,
    });
    expect(JSON.stringify(status.folderRecon)).not.toMatch(/account1|Archive|example\.com/i);

    _testExports._resetFolderReconState();
    const reset = await getIncrementalIndexerStatus();
    expect(reset.folderRecon).toMatchObject({
      scanPages: 0,
      scanHeaders: 0,
      schedulerTicks: 0,
      schedulerPressureSkips: 0,
      maxPendingObserved: 0,
    });
  });

  it('accumulates meaningful outcomes and throttles persistent snapshots until completion', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      _testExports._setFtsSearch(fts);

      await _testExports._runFolderReconSchedulerTick(fts); // /A
      await _testExports._runFolderReconSchedulerTick(fts); // /B
      await _testExports._runFolderReconSchedulerTick(fts); // one-shot range-count basis + completion

      const status = await getIncrementalIndexerStatus();
      expect(status.folderRecon.outcomes).toMatchObject({
        slices: 2,
        complete: true,
        totals: { foldersTotal: 2, foldersClean: 2 },
        latest: { foldersTotal: 1, foldersClean: 1 },
      });
      expect(storageData.fts_folder_recon_last).toMatchObject({
        slices: 2,
        complete: true,
        totals: { foldersClean: 2 },
      });
      const snapshotWrites = globalThis.browser.storage.local.set.mock.calls
        .filter(([value]) => Object.hasOwn(value, 'fts_folder_recon_last'));
      expect(snapshotWrites).toHaveLength(2); // first bounded status + forced completion
      expect(JSON.stringify(status.folderRecon.outcomes)).not.toMatch(/account1|\/A|\/B|@/);
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('never arms the rolling re-walk in legacy key-range mode', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      _testExports._setFtsSearch(fts);
      let result;
      for (let turn = 0; turn < 10 && result?.complete !== true; turn++) {
        result = await _testExports._runFolderReconSchedulerTick(fts);
      }
      expect(result).toMatchObject({ complete: true });
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
      expect(_testExports._getFolderReconRollingDueMs()).toBe(0);
      expect(_testExports._getFolderReconNextWalkDueMs().size).toBe(0);
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  describe('outcome snapshot writes', () => {
    const snapshotWrites = () => globalThis.browser.storage.local.set.mock.calls
      .filter(([value]) => Object.hasOwn(value, 'fts_folder_recon_last'));
    const settleWrites = async () => {
      for (let turn = 0; turn < 5; turn++) await Promise.resolve();
    };
    const changed = { foldersTotal: 1, foldersReconciled: 1, missingEnqueued: 1 };
    const unchanged = { foldersTotal: 1, foldersMemoHit: 1 };

    it('writes a meaningful change and its completion once, then nothing for unchanged completions', async () => {
      _testExports._recordFolderReconOutcome(changed, 5);
      _testExports._completeFolderReconOutcome();
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(2);
      expect(storageData.fts_folder_recon_last).toMatchObject({
        complete: true,
        totals: { missingEnqueued: 1 },
      });

      for (let pass = 0; pass < 2; pass++) {
        _testExports._recordFolderReconOutcome(unchanged, 5);
        _testExports._completeFolderReconOutcome();
        await settleWrites();
      }
      expect(snapshotWrites()).toHaveLength(2);

      // A later meaningful change is written again.
      _testExports._recordFolderReconOutcome(changed, 5);
      _testExports._completeFolderReconOutcome();
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(3);
      expect(storageData.fts_folder_recon_last).toMatchObject({ totals: { missingEnqueued: 2 } });
    });

    it('resets completion when a later slice changes something and persists it as incomplete', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(realDateNow());
      try {
        const outcomes = async () => (await getIncrementalIndexerStatus()).folderRecon.outcomes;
        _testExports._recordFolderReconOutcome(changed, 5);
        _testExports._completeFolderReconOutcome();
        await settleWrites();
        expect((await outcomes()).complete).toBe(true);
        expect(storageData.fts_folder_recon_last).toMatchObject({ complete: true });

        // Inside the persist interval the change is not written yet, but the
        // live status already says incomplete.
        _testExports._recordFolderReconOutcome(changed, 5);
        await settleWrites();
        expect((await outcomes()).complete).toBe(false);
        expect(storageData.fts_folder_recon_last).toMatchObject({ complete: true });
        expect(snapshotWrites()).toHaveLength(2);

        // Once the interval allows, the snapshot records the incomplete state.
        vi.setSystemTime(Date.now() + 31_000);
        _testExports._recordFolderReconOutcome(changed, 5);
        await settleWrites();
        expect((await outcomes()).complete).toBe(false);
        expect(snapshotWrites()).toHaveLength(3);
        expect(storageData.fts_folder_recon_last).toMatchObject({
          complete: false,
          totals: { missingEnqueued: 3 },
        });

        // Control: an unchanged slice leaves completion alone, and the next
        // clean completion writes complete again.
        _testExports._recordFolderReconOutcome(unchanged, 5);
        expect((await outcomes()).complete).toBe(false);
        _testExports._completeFolderReconOutcome();
        await settleWrites();
        expect((await outcomes()).complete).toBe(true);
        expect(snapshotWrites()).toHaveLength(4);
        expect(storageData.fts_folder_recon_last).toMatchObject({ complete: true });
        _testExports._recordFolderReconOutcome(unchanged, 5);
        expect((await outcomes()).complete).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('writes nothing for a session of read-only slices', async () => {
      _testExports._recordFolderReconOutcome(unchanged, 5);
      _testExports._completeFolderReconOutcome();
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(0);
    });

    it('retries a failed change write at the next completion', async () => {
      globalThis.browser.storage.local.set.mockRejectedValueOnce(new Error('disk full'));
      _testExports._recordFolderReconOutcome(changed, 5);
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(1);
      expect(storageData.fts_folder_recon_last).toBeUndefined();

      _testExports._completeFolderReconOutcome();
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(2);
      expect(storageData.fts_folder_recon_last).toMatchObject({
        complete: true,
        totals: { missingEnqueued: 1 },
      });

      _testExports._completeFolderReconOutcome();
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(2);
    });

    // A session already complete leaves no completion to write, so only the
    // unwritten change itself can bring the failed write back.
    it('retries a failed change write of an already complete session at the next completion', async () => {
      _testExports._recordFolderReconOutcome(unchanged, 5);
      _testExports._completeFolderReconOutcome();
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(0);

      globalThis.browser.storage.local.set.mockRejectedValueOnce(new Error('disk full'));
      _testExports._recordFolderReconOutcome(changed, 5);
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(1);
      expect(storageData.fts_folder_recon_last).toBeUndefined();

      _testExports._completeFolderReconOutcome();
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(2);
      expect(storageData.fts_folder_recon_last).toMatchObject({
        complete: true,
        totals: { missingEnqueued: 1 },
      });
    });

    it('keeps a change recorded while an earlier write is in flight unwritten until it is written', async () => {
      _testExports._recordFolderReconOutcome(unchanged, 5);
      _testExports._completeFolderReconOutcome();
      await settleWrites();

      let finishWrite;
      globalThis.browser.storage.local.set.mockImplementationOnce(() => new Promise((resolve) => {
        finishWrite = resolve;
      }));
      _testExports._recordFolderReconOutcome(changed, 5);
      expect(snapshotWrites()).toHaveLength(1);
      // A second change lands while the first write is in flight (throttled).
      _testExports._recordFolderReconOutcome(changed, 5);
      expect(snapshotWrites()).toHaveLength(1);
      finishWrite();
      await settleWrites();

      _testExports._completeFolderReconOutcome();
      await settleWrites();
      expect(snapshotWrites()).toHaveLength(2);
      expect(storageData.fts_folder_recon_last).toMatchObject({
        complete: true,
        totals: { missingEnqueued: 2 },
      });
    });
  });

  it('persists aggregate-only last and rerun telemetry without exact identifiers', async () => {
    const { fts } = installRepairFolders([
      { folderPath: '/Private-Archive', rows: 1 },
    ]);
    _testExports._setFtsSearch(null);
    await _testExports._runFolderReconSchedulerTick(fts);
    const pending = [..._testExports._getPendingUpdates().values()][0];
    _testExports._getPendingUpdates().set(pending.uniqueKey, {
      ...pending,
      metadata: { subject: 'private-subject-sentinel' },
    });
    await _testExports._runFolderReconcile(
      fts,
      new Set(['account1:/Private-Archive']),
    );
    await Promise.resolve();

    const storedArtifacts = {
      last: storageData.fts_folder_recon_last,
      rerun: storageData.fts_folder_recon_last_rerun,
    };
    expect(storedArtifacts.last).toBeTruthy();
    expect(storedArtifacts.rerun).toBeTruthy();
    for (const [name, payload] of Object.entries(storedArtifacts)) {
      expect(payload, `${name} has no exact detail arrays`).not.toHaveProperty('notable');
      expect(payload, `${name} has no unverified identity array`)
        .not.toHaveProperty('unverifiedFolderKeys');
      expect(JSON.stringify(payload), `${name} is privacy-safe`)
        .not.toMatch(/account1|Private-Archive|0-1@example\.com|private-subject-sentinel/);
    }
  });

  it('forbids listAllKeys from every production reconcile Experiment API', () => {
    const sourcePath = fileURLToPath(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const indexerPath = fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url));
    const indexer = readFileSync(indexerPath, 'utf8');
    const productionApis = [
      'beginFolderMessageScan',
      'readFolderMessageScanPage',
      'cancelFolderMessageScan',
      'getFolderMessageScanStats',
      'getMessageInfosForKeys',
      'probeMessageIds',
    ];
    for (const name of productionApis) {
      const body = source.match(new RegExp(`async ${name}[\\s\\S]*?\\n        },`))?.[0] || '';
      expect(body.length, `${name} extraction is non-vacuous`).toBeGreaterThan(40);
      expect(body, `${name} must not call listAllKeys`).not.toContain('listAllKeys');
    }
    expect(source).not.toContain('.listAllKeys(');
    const schemaPath = fileURLToPath(new URL('../agent/experiments/tmMsgNotify/schema.json', import.meta.url));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    expect(schema[0].functions.map(fn => fn.name)).not.toContain('listKeysAboveKey');
    // The retired cursor walker, its key lister and the experiment's cursor
    // read are deleted; no production path names them.
    expect(indexer).not.toMatch(/_runCursorScan|_listCursorKeysAboveKeyCooperatively|getCursorFolder/);
    expect(source).not.toContain('getCursorFolder');
    expect(schema[0].functions.map(fn => fn.name)).not.toContain('getCursorFolder');
    expect(schema[0].functions.map(fn => fn.name)).toContain('beginFolderMessageScan');
    const productionRecon = indexer.match(
      /async function _runFolderReconcile[\s\S]*?\n}\n\nfunction _wakeFolderRecon/,
    )?.[0] || '';
    expect(productionRecon.length).toBeGreaterThan(1000);
    expect(productionRecon).not.toMatch(/listNextKeys|listKeysAboveKey/);
  });

  it('exposes only aggregate bounded scan-token telemetry', () => {
    const schemaPath = fileURLToPath(new URL('../agent/experiments/tmMsgNotify/schema.json', import.meta.url));
    const schema = JSON.parse(readFileSync(schemaPath, 'utf8'));
    const getter = schema[0].functions.find(fn => fn.name === 'getFolderMessageScanStats');

    expect(getter).toBeTruthy();
    expect(Object.keys(getter.returns.properties).sort()).toEqual([
      'idleTtlMs',
      'live',
      'maxLive',
    ]);
    expect(Object.values(getter.returns.properties).every(property => property.type === 'integer'))
      .toBe(true);
  });

  it('uses one fail-closed IMAPDeleted/Expunged proof domain across every lookup', () => {
    const sourcePath = fileURLToPath(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const predicate = source.match(/function isExcludedProofHeader[\s\S]*?\n}/)?.[0] || '';
    const scan = source.match(/async readFolderMessageScanPage[\s\S]*?\n        },/)?.[0] || '';
    const infos = source.match(/async getMessageInfosForKeys[\s\S]*?\n        },/)?.[0] || '';
    const probe = source.match(/async probeMessageIds[\s\S]*?\n        },/)?.[0] || '';

    expect(predicate.length, 'shared predicate extraction is non-vacuous').toBeGreaterThan(120);
    const isExcluded = Function(
      'Ci',
      `${predicate}\nreturn isExcludedProofHeader;`,
    )({ nsMsgMessageFlags: { IMAPDeleted: 1, Expunged: 2 } });
    expect(isExcluded({ flags: 0 })).toBe(false);
    expect(isExcluded({ flags: 1 })).toBe(true);
    expect(isExcluded({ flags: 2 })).toBe(true);
    expect(isExcluded({ flags: 3 })).toBe(true);
    expect(isExcluded({ get flags() { throw new Error('summary unavailable'); } })).toBe(true);
    for (const [name, body] of [
      ['readFolderMessageScanPage', scan],
      ['getMessageInfosForKeys', infos],
      ['probeMessageIds', probe],
    ]) {
      expect(body.length, `${name} extraction is non-vacuous`).toBeGreaterThan(120);
      expect(body, `${name} uses the shared proof predicate`)
        .toContain('isExcludedProofHeader(hdr)');
    }
  });

  it('bounds abandoned parent scan tokens with executable idle-TTL and live-cap semantics', () => {
    const sourcePath = fileURLToPath(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url));
    const source = readFileSync(sourcePath, 'utf8');
    const sweep = source.match(/function sweepFolderMessageScans[\s\S]*?\n}/)?.[0] || '';

    expect(sweep).toContain('FOLDER_SCAN_IDLE_TTL_MS');
    expect(sweep).toContain('FOLDER_SCAN_MAX_LIVE');
    const scans = new Map([
      ['expired', { lastAccessMs: 0 }],
      ['active', { lastAccessMs: 900 }],
      ['older-live', { lastAccessMs: 950 }],
    ]);
    const runSweep = Function(
      'folderMessageScans',
      'FOLDER_SCAN_IDLE_TTL_MS',
      'FOLDER_SCAN_MAX_LIVE',
      `return (${sweep});`,
    )(scans, 300, 3);
    runSweep(1000, false);
    expect([...scans.keys()]).toEqual(['active', 'older-live']);

    // A page read refreshes the active scan; reserving a new slot evicts the
    // least-recently-accessed live token while retaining the refreshed one.
    scans.get('active').lastAccessMs = 1100;
    scans.set('newer', { lastAccessMs: 1050 });
    runSweep(1200, true);
    expect([...scans.keys()]).toEqual(['active', 'newer']);
    scans.set('reserved-slot', { lastAccessMs: 1200 });
    expect(scans.size).toBe(3);

    expect(source).toContain(
      'ChromeUtils.importESModule("resource://gre/modules/Timer.sys.mjs")',
    );
    expect(source).toContain('folderMessageScanSweepTimer = setGeckoInterval');
    expect(source).toContain('clearGeckoInterval(folderMessageScanSweepTimer)');
    expect(source).not.toMatch(/(^|[^A-Za-z])setInterval\(/m);
    expect(source).not.toMatch(/(^|[^A-Za-z])clearInterval\(/m);
    expect(source).toContain('scan.lastAccessMs = Date.now()');
  });
});

describe('strict reconciliation lifecycle contracts', () => {
  it('observes the shared fake-timer helper outcome before any deadline exit', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const body = source.match(
      /async function settleSchedulerTickWithFakeTimers[\s\S]*?\n}\n\nfunction seedExclusiveMembershipEvidence/,
    )?.[0] || '';
    expect(body.length, 'scheduler settle helper extraction is non-vacuous')
      .toBeGreaterThan(900);
    expect(body).toContain('_runFolderReconSchedulerTick(fts).then(');
    expect(body).toContain('outcomeError = error');
    expect(body).toContain('await observed');
    expect(body).toContain('if (outcomeFailed) throw outcomeError');
    expect(body).not.toContain('.finally(');
    const invalidateAt = body.indexOf('_testExports._setIsEnabled(false)');
    const deadlineErrorAt = body.indexOf('throw new Error(');
    expect(invalidateAt).toBeGreaterThan(0);
    expect(deadlineErrorAt).toBeGreaterThan(invalidateAt);
  });

  it('settles the strict storage tail instead of widening virtual scheduler turns', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const body = source.match(
      /it\('arms one normal in-session retry[\s\S]*?\n  \}\);/,
    )?.[0] || '';
    expect(body.length, 'retry fixture extraction is non-vacuous').toBeGreaterThan(500);
    expect(body).toContain('_reconStorageTransaction(');
  });

  it('keeps the post-init retry fixture within its original small virtual-turn bound', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const body = source.match(
      /it\('arms one normal in-session retry[\s\S]*?\n  \}\);/,
    )?.[0] || '';
    const turnBound = Number(body.match(/turn < (\d+)/)?.[1]);
    expect(body.length, 'retry fixture extraction is non-vacuous').toBeGreaterThan(500);
    expect(turnBound).toBeGreaterThan(0);
    expect(turnBound).toBeLessThanOrEqual(20);
  });

  it('arms one normal in-session retry when the first post-init scheduler seed rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    let digestSpy = null;
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      globalThis.browser.accounts.list.mockRejectedValueOnce(new Error('inventory unavailable'));
      _testExports._setFtsSearch(fts);
      // Impose real thread-pool latency on every membership digest. In
      // production the digest settles at load-dependent latency; pinning a
      // fixed latency makes the fixture deterministic instead of passing only
      // when each digest happens to land within the bounded real-loop turns
      // the virtual advances grant.
      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
        await new Promise(resolve => realSetTimeout(resolve, RETRY_DIGEST_REAL_LATENCY_MS));
        return realDigest(...args);
      });

      await _testExports.runPostInitReconcile(fts);
      // A failed seed keeps the durable marker so a restart retries too, and
      // leaves the session incomplete.
      expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(reconConfig.errorDelayMs - 1);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      // The timer callback intentionally starts a bounded scheduler turn.
      // Settle the in-flight tick on the real event loop, then its permanent
      // strict storage tail, after each small virtual turn instead of widening
      // the amount of virtual scheduling the test accepts.
      for (let turn = 0; turn < 20 && !(await sessionSettled()); turn++) {
        await vi.advanceTimersByTimeAsync(1000);
        await settleInFlightSchedulerTickWithFakeTimers();
        await _testExports._reconStorageTransaction(
          _testExports._getFolderReconGeneration(),
          () => {},
        );
      }
      expect(digestSpy).toHaveBeenCalled();

      expect(globalThis.browser.accounts.list.mock.calls.length).toBeGreaterThan(1);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).toHaveBeenCalled();
      expect(await sessionSettled()).toBe(true);
    } finally {
      digestSpy?.mockRestore();
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('fails closed when an in-flight tick never settles within the real deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    const gate = deferred();
    let digestSpy = null;
    let observed = null;
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      _testExports._setFtsSearch(fts);
      const realDigest = crypto.subtle.digest.bind(crypto.subtle);
      digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementationOnce(async (...args) => {
        await gate.promise;
        return realDigest(...args);
      });

      _testExports._wakeFolderRecon('stalled-tick', 0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(digestSpy).toHaveBeenCalledOnce();
      expect(_testExports._isFolderReconSchedulerActive()).toBe(true);
      expect(reconWorkOwed()).toBe(true);
      const memoBefore = structuredClone(storageData[_testExports.FOLDER_RECON_STORAGE_KEY] ?? null);

      // Exercise the DEFAULT deadline the retry fixture relies on.
      const deadlineMs = SCHEDULER_SETTLE_REAL_DEADLINE_MS;
      const startedAt = realDateNow();
      observed = settleInFlightSchedulerTickWithFakeTimers().then(
        () => ({ kind: 'completed' }),
        error => ({ kind: 'error', message: error.message }),
      );
      const outcome = await Promise.race([
        observed,
        new Promise(resolve => realSetTimeout(() => resolve({ kind: 'unbounded' }), deadlineMs + 1_000)),
      ]);
      const elapsedMs = realDateNow() - startedAt;

      // Release the stalled continuation and let it unwind before asserting.
      gate.resolve();
      const cleanupStart = realDateNow();
      while (_testExports._isFolderReconSchedulerActive()
          && realDateNow() - cleanupStart < SCHEDULER_SETTLE_REAL_DEADLINE_MS) {
        await yieldToRealEventLoop();
      }
      await observed;

      expect(outcome).toEqual({
        kind: 'error',
        message: `In-flight folder reconciliation tick did not settle within ${deadlineMs}ms real time`,
      });
      expect(elapsedMs).toBeGreaterThanOrEqual(deadlineMs);
      expect(_testExports._isFolderReconSchedulerActive()).toBe(false);
      // The disabled late continuation commits no proof: session evidence,
      // memo and native rows are untouched and no wake timer is left armed.
      expect(reconWorkOwed()).toBe(true);
      expect(_testExports._getFolderReconSessionDone().size).toBe(0);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY] ?? null).toEqual(memoBefore);
      expect(fts.removeBatch).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      gate.resolve();
      digestSpy?.mockRestore();
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  }, SCHEDULER_SETTLE_REAL_DEADLINE_MS + 3_000);

  it('accepts a tick that completes during the last real-loop turn even when the deadline elapsed in it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    const listStarted = deferred();
    const releaseList = deferred();
    let tick = null;
    try {
      const fts = installEmptyFolders([]);
      _testExports._setFtsSearch(fts);
      const list = globalThis.browser.accounts.list.getMockImplementation();
      globalThis.browser.accounts.list.mockImplementationOnce(async (...args) => {
        listStarted.resolve();
        await releaseList.promise;
        return list(...args);
      });
      tick = _testExports._runFolderReconSchedulerTick(fts);
      await listStarted.promise;
      expect(_testExports._isFolderReconSchedulerActive()).toBe(true);
      expect(reconWorkOwed()).toBe(true);

      const deadlineMs = 50;
      let slowYields = 0;
      // One real-loop turn that outlasts the deadline and during which the
      // tick durably completes. Completion already observable before the
      // deadline decision must win.
      const slowYield = async () => {
        slowYields++;
        await new Promise(resolve => realSetTimeout(resolve, deadlineMs + 20));
        releaseList.resolve();
        await expect(tick).resolves.toMatchObject({ complete: true });
        await yieldToRealEventLoop();
      };
      await expect(settleInFlightSchedulerTickWithFakeTimers(deadlineMs, slowYield))
        .resolves.toBeUndefined();
      expect(slowYields).toBe(1);
      expect(_testExports._isFolderReconSchedulerActive()).toBe(false);
      expect(await sessionSettled()).toBe(true);
    } finally {
      releaseList.resolve();
      if (tick) await tick.catch(() => {});
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps a raised idle-duty floor across shorter pressure and work wakes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      _testExports._setFtsSearch(fts);
      _testExports._setFolderReconHardNotBeforeMs(Date.now() + 2_000);

      _testExports._wakeFolderRecon('pressure', 250);
      _testExports._wakeFolderRecon('drain_low_water', 25);
      await vi.advanceTimersByTimeAsync(1_999);
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(globalThis.browser.tmMsgNotify.getFolderState).not.toHaveBeenCalled();
      expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(globalThis.browser.accounts.list).toHaveBeenCalled();
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('re-arms an already scheduled timer later when a completed slice raises the floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000);
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      _testExports._setFtsSearch(fts);
      _testExports._wakeFolderRecon('work', 250);
      _testExports._setFolderReconHardNotBeforeMs(Date.now() + 2_000);

      await vi.advanceTimersByTimeAsync(250);
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(globalThis.browser.tmMsgNotify.getFolderState).not.toHaveBeenCalled();
      expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_750);
      expect(globalThis.browser.accounts.list).toHaveBeenCalled();
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('routes the drain-low-water rerun through the timer and cannot directly bypass the floor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000_000);
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      _testExports._setFtsSearch(fts);
      _testExports._getFolderReconDrainSkipped().add('account1:/A');
      _testExports._setFolderReconHardNotBeforeMs(Date.now() + 1_000);

      expect(_testExports._maybeScheduleFolderReconRerun()).toBeUndefined();
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(999);
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(globalThis.browser.tmMsgNotify.getFolderState).not.toHaveBeenCalled();
      expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(globalThis.browser.accounts.list).toHaveBeenCalled();
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalled();
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('fails closed on a live exclusive scan before inventory or native probing', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    const lease = await acquireFtsExclusiveOperation('full');
    await writeOwnedFtsScanStatus(lease, { scanType: 'full' });

    const result = await _testExports._runFolderReconcile(fts);

    expect(result).toMatchObject({ skipped: true, reason: 'operation_busy' });
    expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
    expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
    await clearOwnedFtsScanStatus(lease);
    lease.release();
  });

  it('normalizes an ownerless active record after owned clear fails and then proceeds', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    const lease = await acquireFtsExclusiveOperation('full');
    await writeOwnedFtsScanStatus(lease, { scanType: 'full' });
    globalThis.browser.storage.local.set.mockRejectedValueOnce(new Error('clear write failed'));
    await expect(clearOwnedFtsScanStatus(lease)).rejects.toThrow('clear write failed');
    lease.release();
    expect(storageData.fts_scan_status).toMatchObject({
      isScanning: true,
      runId: lease.runId,
    });

    const result = await _testExports._runFolderReconSchedulerTick(fts);

    expect(result.foldersClean).toBe(1);
    expect(globalThis.browser.accounts.list).toHaveBeenCalledOnce();
    expect(storageData.fts_scan_status).toMatchObject({
      isScanning: false,
      scanType: 'none',
      interrupted: true,
    });
  });

  it('fails closed on a strict scan-gate read error before inventory or native probing', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    globalThis.browser.storage.local.get.mockRejectedValueOnce(new Error('storage unavailable'));

    const result = await _testExports._runFolderReconcile(fts);

    expect(result).toMatchObject({ skipped: true, reason: 'scan_gate_read_failed' });
    expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
    expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
  });

  it('strictly merges same-generation targeted memo patches without stale whole-object writes', async () => {
    storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = { version: 3, folders: {} };
    const generation = _testExports._getFolderReconGeneration();

    await Promise.all([
      _testExports._reconStorageTransaction(generation, state => {
        state.memo.folders['account1:/A'] = { verified: false, missingBackfillKey: 10 };
      }),
      _testExports._reconStorageTransaction(generation, state => {
        state.memo.folders['account1:/B'] = { verified: true, ftsCount: 2 };
      }),
    ]);

    expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders).toMatchObject({
      'account1:/A': { missingBackfillKey: 10 },
      'account1:/B': { verified: true, ftsCount: 2 },
    });
  });

  it('rejects old-generation completion before it can overwrite a newer memo', async () => {
    const readStarted = deferred();
    const allowRead = deferred();
    const generation = _testExports._getFolderReconGeneration();
    globalThis.browser.storage.local.get.mockImplementationOnce(async () => {
      readStarted.resolve();
      await allowRead.promise;
      return {
        [_testExports.FOLDER_RECON_STORAGE_KEY]: { version: 3, folders: {} },
      };
    });
    const oldWrite = _testExports._reconStorageTransaction(generation, state => {
      state.memo.roundRobinCursor = 'account1:/old';
    });
    await readStarted.promise;
    _testExports._resetFolderReconState();
    storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
      version: 3,
      folders: { 'account1:/new': { verified: false } },
    };
    allowRead.resolve();

    await expect(oldWrite).rejects.toThrow(/folder_recon_cancelled/);
    expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders)
      .toHaveProperty('account1:/new');
  });

  it('propagates strict memo read and write failures', async () => {
    const generation = _testExports._getFolderReconGeneration();
    globalThis.browser.storage.local.get.mockRejectedValueOnce(new Error('read failed'));
    await expect(_testExports._reconStorageTransaction(generation, () => {}))
      .rejects.toThrow('read failed');

    globalThis.browser.storage.local.set.mockRejectedValueOnce(new Error('write failed'));
    await expect(_testExports._reconStorageTransaction(generation, state => {
      state.memo.roundRobinCursor = 'account1:/A';
    })).rejects.toThrow('write failed');
  });
});

describe('terminal verification membership epoch', () => {
  // concurrent: a native write while the terminal local refresh runs —
  // unscoped (wildcard), this folder's own row, or another folder's row.
  it.each(['none', 'wildcard', 'self', 'other'])('matches current native membership after terminal local refresh: concurrent=%s', async (concurrent) => {
    const concurrentRemove = concurrent === 'wildcard' || concurrent === 'self';
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const folderKey = 'account1:/TerminalRace';
      const folderId = makeFolderMembershipId('account1', '/TerminalRace');
      const oldKey = `${folderKey}:old@example.com`;
      const newKey = `${folderKey}:current@example.com`;
      const { folders, rowsByURI, nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/TerminalRace', headerMessageIds: ['old@example.com'],
      }]);
      nativeRows.clear();
      nativeRows.set(newKey, folderId);
      // current@ is live in the folder's msgDB throughout; only the scan view
      // is refreshed at the terminal step.
      browser.tmMsgNotify.probeMessageIds.mockResolvedValue({ missing: [], uncertain: [] });
      let terminalArmed = false;
      let refreshed = false;
      let concurrentWrites = 0;
      fts.filterNewMessages.mockImplementation(async () => {
        terminalArmed = true;
        return { newMsgIds: [] };
      });
      const realBegin = browser.tmMsgNotify.beginFolderMessageScan.getMockImplementation();
      browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async (...args) => {
        if (terminalArmed && !refreshed) {
          refreshed = true;
          rowsByURI.set(folders[0].folderURI, [{ msgKey: 2, headerMessageId: 'current@example.com' }]);
        }
        return realBegin(...args);
      });
      const realPage = browser.tmMsgNotify.readFolderMessageScanPage.getMockImplementation();
      browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async (...args) => {
        const result = await realPage(...args);
        if (terminalArmed && concurrent !== 'none' && concurrentWrites === 0) {
          if (concurrent === 'other') {
            const otherKey = 'account1:/Other:other@example.com';
            const otherId = makeFolderMembershipId('account1', '/Other');
            await runFtsMembershipMutation(async () => {
              nativeRows.delete(otherKey);
              concurrentWrites++;
            }, null, { msgIds: [otherKey], folderIds: [otherId] });
          } else {
            await runFtsMembershipMutation(async () => {
              nativeRows.delete(newKey);
              concurrentWrites++;
            }, null, concurrent === 'self' ? { msgIds: [newKey] } : '*');
          }
        }
        return result;
      });
      for (let turn = 0; turn < 35 && !refreshed; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 1000);
      }
      expect(refreshed).toBe(true);
      expect(fts.filterNewMessages).toHaveBeenCalledWith([{ msgId: oldKey }]);
      expect(concurrentWrites).toBe(concurrent === 'none' ? 0 : 1);
      expect(rowsByURI.get(folders[0].folderURI)).toEqual([{ msgKey: 2, headerMessageId: 'current@example.com' }]);
      const checkpoint = storageData[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders?.[folderKey];
      if (concurrentRemove) {
        expect(nativeRows.size).toBe(0);
        expect(checkpoint?.verified).not.toBe(true);
        expect(checkpoint).toMatchObject({ missingBackfillKey: 0, missingBackfillStarted: false });
        expect(_testExports._getFolderReconSessionDone().has(folderKey)).toBe(false);
        expect(checkpoint?.partialPostVerifyFailureCount).toBeUndefined();
      } else {
        expect([...nativeRows.keys()]).toEqual([newKey]);
        expect(checkpoint).toMatchObject({ verified: true, expectedCount: 1, ftsCount: 1,
          expectedSha256: framedDigest([newKey]), ftsSha256: framedDigest([newKey]) });
        expect(_testExports._getFolderReconSessionDone().has(folderKey)).toBe(true);
      }
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
it('stale removal cannot verify a rediscovered local row using its old native digest', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
  try {
    const folderKey = 'account1:/Rediscovery';
    const folderId = makeFolderMembershipId('account1', '/Rediscovery');
    const liveKey = `${folderKey}:rediscovered@example.com`;
    const { folders, rowsByURI, nativeRows, fts } = installExactMembershipFolders([{
      folderPath: '/Rediscovery', headerMessageIds: [],
    }]);
    nativeRows.set(liveKey, folderId);
    browser.tmMsgNotify.probeMessageIds.mockImplementation(async (_uri, ids) => ({ missing: ids }));
    const realBegin = browser.tmMsgNotify.beginFolderMessageScan.getMockImplementation();
    let rediscovered = false;
    browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async (...args) => {
      if (fts.removeBatch.mock.calls.length > 0 && !rediscovered) {
        rediscovered = true;
        rowsByURI.set(folders[0].folderURI, [{ msgKey: 1, headerMessageId: 'rediscovered@example.com' }]);
      }
      return realBegin(...args);
    });
    for (let turn = 0; turn < 35 && !rediscovered; turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + 1000);
    }
    expect(rediscovered).toBe(true);
    expect(fts.removeBatch).toHaveBeenCalledWith([liveKey], expect.anything());
    expect(nativeRows.has(liveKey)).toBe(false);
    expect(rowsByURI.get(folders[0].folderURI)).toEqual([{ msgKey: 1, headerMessageId: 'rediscovered@example.com' }]);
    expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders?.[folderKey]?.verified).not.toBe(true);
    expect(_testExports._getFolderReconSessionDone().has(folderKey)).toBe(false);
    for (let turn = 0; turn < 15 && !_testExports._getPendingUpdates().has(liveKey); turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + 1000);
    }
    expect(_testExports._getPendingUpdates().has(liveKey)).toBe(true);
    expect(nativeRows.has(liveKey)).toBe(false);
  } finally {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

// A stale-direction recheck reads only its own folder: the util scopes the
// query by folder id, so the direction must hand that id over.
it('scopes every stale-direction presence recheck to its folder id', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(realDateNow());
  try {
    const folderKey = 'account1:/Scoped';
    const folderId = makeFolderMembershipId('account1', '/Scoped');
    const staleKey = `${folderKey}:gone@example.com`;
    const { nativeRows, fts } = installExactMembershipFolders([{
      folderPath: '/Scoped', weFolderId: 'session-folder-scoped', headerMessageIds: [],
    }]);
    nativeRows.set(staleKey, folderId);
    browser.tmMsgNotify.probeMessageIds.mockImplementation(async (_uri, ids) => ({ missing: ids }));
    for (let turn = 0; turn < 35 && nativeRows.has(staleKey); turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + 1000);
    }
    expect(fts.removeBatch).toHaveBeenCalledWith([staleKey], expect.anything());
    expect(recheckMessageInFolder).toHaveBeenCalled();
    for (const [headerId, weFolder] of recheckMessageInFolder.mock.calls) {
      expect(headerId).toBe('gone@example.com');
      expect(weFolder).toEqual({ accountId: 'account1', path: '/Scoped', id: 'session-folder-scoped' });
    }
  } finally {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  }
});

// INVARIANT (2026-10-02 release-profile heap: 11,268 old/new copies of the
// whole ~57 KiB fts_folder_recon_memo held by storage.onChanged): the global
// membership-state pass and its cutover are volatile, per-session proof. A
// capable multi-page pass must never rewrite the durable memo, and the
// migration keeps no durable record at all.
describe('volatile membership-state pass (memo storage churn)', () => {
  function memoWrites() {
    return globalThis.browser.storage.local.set.mock.calls.filter(([patch]) =>
      Object.prototype.hasOwnProperty.call(patch, _testExports.FOLDER_RECON_STORAGE_KEY));
  }

  function seedAssignedFolder(headerCount) {
    const headerMessageIds = Array.from(
      { length: headerCount },
      (_, index) => `state-${String(index).padStart(5, '0')}@example.com`,
    );
    return installExactMembershipFolders([{ folderPath: '/F', headerMessageIds }], { assigned: true });
  }

  it('cuts over a capable multi-page state pass without writing the memo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const pageSize = reconConfig.membershipStatePageSize;
      const { fts } = seedAssignedFolder(pageSize * 2 + 1);
      const writesBefore = memoWrites().length;
      let migrationTicks = 0;
      for (let turn = 0; turn < 20 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        const writes = memoWrites().length;
        const result = await settleSchedulerTickWithFakeTimers(fts);
        if (result?.migration) {
          migrationTicks++;
          expect(memoWrites().length, `memo written during state-pass turn ${turn}`)
            .toBe(writes);
        }
        vi.setSystemTime(Date.now() + 100);
      }
      // Every tick until cleanup, folder turns included: at most the one
      // folder's own certification checkpoint is written.
      expect(fts.listFolderMembership).toHaveBeenCalled();
      expect(memoWrites().length - writesBefore).toBeLessThanOrEqual(1);

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      // The cutover turn may continue into per-folder work, which owns its
      // own checkpoints; none of them carries a migration record.
      expect(memoWrites().every(([patch]) => !Object.prototype.hasOwnProperty.call(
        patch[_testExports.FOLDER_RECON_STORAGE_KEY], 'folderMembershipMigration',
      ))).toBe(true);
      expect(migrationTicks).toBeGreaterThanOrEqual(2);
      expect(fts.listFolderMembershipState.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  const P = reconConfig.membershipStatePageSize;
  it.each([0, P - 1, P, P + 1, 2 * P, 2 * P + 1])(
    'advances the volatile pass monotonically to cutover for %i rows',
    async (rowCount) => {
      vi.useFakeTimers();
      vi.setSystemTime(realDateNow());
      try {
        const { fts } = seedAssignedFolder(rowCount);
        const expectedReads = Math.floor(rowCount / P) + 1;
        // Folder turns run between pass turns until cleanup completes.
        for (let turn = 0; turn < 2 * expectedReads
          && !_testExports._getFolderMembershipCleanupProven(); turn++) {
          const result = await _testExports._runFolderReconSchedulerTick(fts);
          expect(result?.migration?.restart, `no restart on tick ${turn}`).toBeUndefined();
          const reads = fts.listFolderMembershipState.mock.calls.length;
          expect(_testExports._getFolderMembershipCleanupProven(),
            `cutover exactly at native terminal evidence (tick ${turn}, read ${reads})`)
            .toBe(reads === expectedReads);
          vi.setSystemTime(Date.now() + 100);
        }

        expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
        expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(expectedReads);
        const cursors = fts.listFolderMembershipState.mock.calls.map(([after]) => after);
        expect(cursors[0]).toBeNull();
        for (let index = 1; index < cursors.length; index++) {
          // Strictly increasing on non-empty pages; the terminal empty page of
          // an exact multiple re-reads after the last row, never past it.
          expect(sqliteBinaryCompare(cursors[index], cursors[index - 1] ?? '')).toBeGreaterThan(0);
        }
        const telemetry = _testExports._getFolderReconRuntimeTelemetry();
        expect(telemetry.membershipStatePages).toBe(expectedReads);
        expect(telemetry.membershipCutovers).toBe(1);
        expect(telemetry.membershipLastPassSlices).toBe(expectedReads);
        for (const field of Object.keys(telemetry).filter(key =>
          key.startsWith('membershipStateRestart'))) {
          expect(telemetry[field], field).toBe(0);
        }
      } finally {
        _testExports._setIsEnabled(false);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  // Seeded PRNG so a failing fuzz seed replays exactly.
  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Oracle on the fake native table itself, not on the code under test:
  // every row has an owner in the inventory that prefixes its raw key.
  function expectEveryRowOwnedByAPresentFolder(nativeRows, inventory) {
    for (const [msgId, owner] of nativeRows) {
      const folder = inventory.find(item => item.folderId === owner);
      expect(folder, `row ${msgId} has a present owner`).toBeTruthy();
      expect(msgId.startsWith(`${folder.accountId}:${folder.folderPath}:`)).toBe(true);
    }
  }

  // Testing rule 11: concurrency-heavy proof, seeded fault + latency
  // injection with real coordinator mutations and explicit quiet windows.
  it.each([
    ...[11, 23, 37, 41, 53, 67, 79, 97].map(seed => ({ seed, writeRate: 0.6 })),
    { seed: 5, writeRate: 1 }, // steady: a write between every pair of slices
    { seed: 7, writeRate: 0 }, // quiet positive control
  ])('converges under ownership-preserving live writes (seed $seed, rate $writeRate)', async ({ seed, writeRate }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const random = seededRandom(seed);
      const rowCount = P * 3 + 7;
      const { fts, nativeRows, folders } = seedAssignedFolder(rowCount);
      const folderId = folders[0].folderId;
      let nextNew = 0;
      const ownedWrite = async () => {
        if (random() < 0.7 || nativeRows.size === 0) {
          // New mail, indexed with its owner by the one derivation site.
          const msgId = `account1:/F:live-${seed}-${nextNew++}@example.com`;
          await runFtsMembershipMutation(async () => { nativeRows.set(msgId, folderId); });
        } else {
          const keys = [...nativeRows.keys()];
          const victim = keys[Math.floor(random() * keys.length)];
          await runFtsMembershipMutation(async () => { nativeRows.delete(victim); });
        }
      };
      const read = fts.listFolderMembershipState.getMockImplementation();
      fts.listFolderMembershipState.mockImplementation(async (after, limit) => {
        if (random() < 0.5) await yieldToRealEventLoop(); // latency jitter
        const page = await read(after, limit);
        if (random() < writeRate / 2) await ownedWrite(); // write during the read
        if (random() < 0.5) await Promise.resolve();
        return page;
      });
      const epochBefore = getFtsMembershipEpoch();
      const sliceBudget = 2 * (Math.floor(rowCount / P) + 2);
      let slices = 0;
      while (!_testExports._getFolderMembershipCleanupProven() && slices < sliceBudget) {
        await settleSchedulerTickWithFakeTimers(fts);
        slices++;
        if (random() < writeRate || writeRate === 1) await ownedWrite();
        if (random() < writeRate / 3) {
          // A local message event: the scheduler waits out the quiet window.
          _testExports._invalidateFolderReconProofForEvent('account1', '/F');
          vi.setSystemTime(Date.now() + reconConfig.syncQuietMs + 1);
        } else {
          vi.setSystemTime(Date.now() + 100);
        }
      }

      expect(_testExports._getFolderMembershipCleanupProven(),
        `cutover within ${sliceBudget} slices`).toBe(true);
      if (writeRate > 0) {
        expect(getFtsMembershipEpoch(), 'the seed really moved the epoch')
          .toBeGreaterThan(epochBefore);
      }
      expectEveryRowOwnedByAPresentFolder(nativeRows, folders);
      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('replays the pass when a NULL row appears ahead of the cursor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows, rowsByURI, folders } = seedAssignedFolder(P + 1);
      const ahead = 'account1:/F:zz-late@example.com';
      const read = fts.listFolderMembershipState.getMockImplementation();
      fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
        const page = await read(after, limit);
        // A legacy-shaped row lands AHEAD of the cursor (forced fake).
        nativeRows.set(ahead, null);
        rowsByURI.get(folders[0].folderURI).push({ msgKey: 999, headerMessageId: 'zz-late@example.com' });
        return page;
      });

      // Pass-turn results only: folder turns in between carry no migration.
      const results = [];
      for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        const migration = (await _testExports._runFolderReconSchedulerTick(fts))?.migration;
        if (migration) results.push(migration);
        vi.setSystemTime(Date.now() + 100);
      }

      // Page two sees the NULL row and assigns it; that pass replays.
      expect(results[1]).toMatchObject({ restart: true });
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(nativeRows.get(ahead)).toBe(folders[0].folderId);
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after))
        .toEqual([null, `account1:/F:state-${String(P - 1).padStart(5, '0')}@example.com`, null,
          `account1:/F:state-${String(P - 1).padStart(5, '0')}@example.com`]);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('resets before cutover when a legacy connection wrote a NULL row behind the cursor', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows } = seedAssignedFolder(P + 1);
      await _testExports._runFolderReconSchedulerTick(fts); // page one
      vi.setSystemTime(Date.now() + 100);
      // G1 capable -> G2 legacy writes an ownerless row behind the cursor,
      // no tick observes it -> G3 capable.
      nativeRows.set('account1:/F:aaa-legacy@example.com', null);
      fts.getConnectionGeneration.mockReturnValue(3);

      await _testExports._runFolderReconSchedulerTick(fts);

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after))
        .toEqual([null, null]);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps cutover for a producer-less NULL row behind the cursor and classifies it on the next session pass', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows } = seedAssignedFolder(P + 1);
      const orphan = 'account1:/F:aaa-unowned@example.com';
      await _testExports._runFolderReconSchedulerTick(fts); // page one
      vi.setSystemTime(Date.now() + 100);
      nativeRows.set(orphan, null); // forced fake: no production producer exists
      await _testExports._runFolderReconSchedulerTick(fts); // a folder turn
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts); // terminal page
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);

      // A NULL row has no revoke site any more: this session keeps its cutover.
      for (let turn = 0; turn < 5; turn++) {
        vi.setSystemTime(Date.now() + 100);
        await settleSchedulerTickWithFakeTimers(fts);
      }
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(nativeRows.get(orphan)).toBeNull();

      // The next session's pass starts before-first and classifies the row: no
      // live message, so it is removed as a ghost before cutover.
      _testExports._resetFolderReconState();
      _testExports._setIsEnabled(true);
      _testExports._setIndexerDisposed(false);
      fts.listFolderMembershipState.mockClear();
      for (let turn = 0; turn < 20 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await settleSchedulerTickWithFakeTimers(fts);
      }
      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(nativeRows.has(orphan)).toBe(false);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ['pressure after a committed stale removal', 'remove', 'pressure'],
    ['a removal that throws after committing', 'remove', 'throw'],
    ['pressure after a committed assignment', 'assign', 'pressure'],
    ['an assignment that throws after committing', 'assign', 'throw'],
  ])('requires a full replay before cutover after %s', async (_name, mutator, fault) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows, rowsByURI, folders } = seedAssignedFolder(P + 1);
      const target = mutator === 'remove'
        ? 'account1:/Deleted:gone@example.com'
        : 'account1:/F:aaa-unassigned@example.com';
      if (mutator === 'remove') {
        nativeRows.set(target, makeFolderMembershipId('account1', '/Deleted'));
      } else {
        nativeRows.set(target, null);
        rowsByURI.get(folders[0].folderURI).push({ msgKey: 998, headerMessageId: 'aaa-unassigned@example.com' });
      }
      const method = mutator === 'remove' ? 'removeBatch' : 'assignFolderMembershipBatch';
      const real = fts[method].getMockImplementation();
      fts[method].mockImplementationOnce(async (...args) => {
        const result = await real(...args);
        if (fault === 'throw') throw new Error('uncertain_native_write');
        getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
        return result;
      });

      const read = fts.listFolderMembershipState.getMockImplementation();
      const readAtMs = [Date.now()];
      fts.listFolderMembershipState.mockImplementation(async (...args) => {
        readAtMs.push(Date.now());
        return read(...args);
      });
      const faulted = await _testExports._runFolderReconSchedulerTick(fts);
      getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
      expect(faulted.skipped === true || faulted.migration?.failed === true).toBe(true);

      for (let turn = 0; turn < 30 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      const cursors = fts.listFolderMembershipState.mock.calls.map(([after]) => after);
      if (fault === 'throw') {
        // Faulted page one, its same-page retry, page two, then a full replay.
        expect(cursors.filter(after => after === null).length).toBeGreaterThanOrEqual(3);
        // A rejected page mutation backs the retry off; folder turns run meanwhile.
        expect(readAtMs[2] - readAtMs[1]).toBeGreaterThanOrEqual(reconConfig.errorDelayMs);
      } else {
        // Pressure during the commit keeps the page: the cursor advanced past
        // page one, then page two, then a full replay.
        expect(cursors[1]).not.toBeNull();
        expect(cursors.filter(after => after === null).length).toBeGreaterThanOrEqual(2);
      }
      expect(cursors.at(-2)).toBeNull();
      if (mutator === 'remove') expect(nativeRows.has(target)).toBe(false);
      else expect(nativeRows.get(target)).toBe(folders[0].folderId);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('ignores a stored pre-2026-10 mid-pass cursor and cutover marker after restart', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, folders } = seedAssignedFolder(P + 1);
      // A record left by an earlier release: inventory, completions, and a
      // mid-pass cursor with a cutover marker. None of it is evidence.
      storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
        version: 3,
        roundRobinCursor: null,
        folders: {},
        folderMembershipMigration: {
          version: 1,
          inventoryCount: 1,
          inventorySha256: framedDigest([`${folders[0].folderId}\u0000account1\u0000/F`]),
          completedFolderIds: { [folders[0].folderId]: true },
          stateAfterMsgId: 'account1:/F:state-00049@example.com',
          passMembershipEpoch: 7,
          passMutated: false,
          passUnresolved: 0,
          cutoverProven: true,
          updatedAtMs: Date.now(),
        },
      };

      const first = await _testExports._runFolderReconSchedulerTick(fts);

      expect(first).toMatchObject({ complete: false, migration: { membershipStateProgress: true } });
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(1);
      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
      // The pass turn does no per-folder or orphan reconciliation.
      expect(fts.listFolderMembership).not.toHaveBeenCalled();
      expect(fts.listMsgIdRange).not.toHaveBeenCalled();
      expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
      expect(memoWrites()).toHaveLength(0);

      // A folder turn, then the pass turn that reads the terminal page.
      for (let turn = 0; turn < 2 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(2);
      expect(fts.listFolderMembershipState.mock.calls[1][0])
        .toBe('account1:/F:state-00049@example.com');

      // The first memo write after the upgrade drops the stale record.
      for (let turn = 0; turn < 20 && memoWrites().length === 0; turn++) {
        vi.setSystemTime(Date.now() + 100);
        await settleSchedulerTickWithFakeTimers(fts);
      }
      expect(memoWrites().length).toBeGreaterThan(0);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY])
        .not.toHaveProperty('folderMembershipMigration');
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  async function earnCutover(fts) {
    for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
      await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 100);
    }
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    fts.listFolderMembershipState.mockClear();
  }

  it.each([
    ['exclusive membership change', async () => {
      const lease = await acquireFtsExclusiveOperation('rebuild');
      await runFtsMembershipMutation(async () => ({ ok: true }));
      lease.release();
    }],
    ['capability downgrade', async (fts) => {
      fts.supportsFolderMembership.mockReturnValue(false);
      await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 100);
      fts.supportsFolderMembership.mockReturnValue(true);
    }],
    ['native reconnect with capability unchanged', async (fts) => {
      // G1 capable -> G2 (an unobserved legacy helper) -> G3 capable.
      fts.getConnectionGeneration.mockReturnValue(3);
    }],
    ['runtime disable', async (fts) => {
      // The only runtime toggle is a dispose + init lifecycle.
      await incrementalIndexer.disposeIncrementalIndexer();
      storageData.chat_ftsIncrementalEnabled = true;
      await incrementalIndexer.initIncrementalIndexer(fts);
      // init restarts the sync-quiet window; let it elapse before ticking.
      vi.setSystemTime(Date.now() + reconConfig.syncQuietMs + 1);
    }],
    ['inventory change', async () => {
      // A folder created in Thunderbird (no rows yet) rebinds the pass.
      const accounts = await globalThis.browser.accounts.list();
      accounts[0].rootFolder.subFolders.push({ id: 'session-new', path: '/New', subFolders: [] });
    }],
  ])('revokes cutover and restarts the pass before-first after %s', async (_name, change) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts } = seedAssignedFolder(P + 1);
      await earnCutover(fts);

      await change(fts);
      vi.setSystemTime(Date.now() + 100);
      for (let turn = 0; turn < 10 && fts.listFolderMembershipState.mock.calls.length === 0; turn++) {
        await _testExports._runFolderReconSchedulerTick(fts);
        expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('never publishes cutover from a pass whose native connection changed mid-read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts } = seedAssignedFolder(0);
      fts.listFolderMembershipState.mockImplementationOnce(async () => {
        fts.getConnectionGeneration.mockReturnValue(2);
        return { ok: true, entries: [], done: true };
      });

      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({
        complete: false,
        migration: { restart: true, reason: 'membership_state_binding_changed' },
      });
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after)).toEqual([null, null]);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('restarts a pre-cutover pass from before-first when a topology change lands mid-pass and still cuts over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const renameListeners = new Set();
    globalThis.browser.folders = {
      onRenamed: {
        addListener: listener => renameListeners.add(listener),
        removeListener: listener => renameListeners.delete(listener),
      },
    };
    incrementalIndexer.setupFolderTopologyListeners();
    try {
      const { fts } = seedAssignedFolder(P * 2 + 1);
      await _testExports._runFolderReconSchedulerTick(fts);
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after)).toEqual([null]);
      // A rename and its reversal: the inventory the next tick reads is unchanged.
      for (const listener of [...renameListeners]) {
        listener({ accountId: 'account1', path: '/F' }, { accountId: 'account1', path: '/F' });
      }
      for (let turn = 0; turn < 8 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }

      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      const cursors = fts.listFolderMembershipState.mock.calls.map(([after]) => after);
      expect(cursors[1]).toBeNull();
      expect(cursors.slice(1).filter(after => after === null)).toHaveLength(1);
      expect(_testExports._getFolderReconRuntimeTelemetry().membershipStateRestartBindingChanged).toBe(1);
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      delete globalThis.browser.folders;
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps a row indexed into a folder created while the inventory is read', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows } = seedAssignedFolder(1);
      const newFolderId = makeFolderMembershipId('account1', '/G');
      const newRow = 'account1:/G:g-new@example.com';
      const snapshot = await globalThis.browser.accounts.list();
      // Thunderbird creates /G after this listing was taken, and the drain
      // indexes a correctly owned row into it before the state page is read.
      globalThis.browser.accounts.list.mockImplementationOnce(async () => {
        await runFtsMembershipMutation(async () => { nativeRows.set(newRow, newFolderId); });
        return snapshot;
      });

      await _testExports._runFolderReconSchedulerTick(fts);

      expect(nativeRows.get(newRow)).toBe(newFolderId);
      expect(fts.removeBatch.mock.calls.some(([ids]) => ids.includes(newRow))).toBe(false);
      expect(_testExports._getFolderReconRuntimeTelemetry().membershipStatePageRetries).toBe(1);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ['oversized', 'membership_state_page_invalid',
      () => ({ ok: true, entries: Array.from({ length: P + 1 }, (_, i) => ({ msgId: `account1:/F:z${String(i).padStart(6, '0')}`, folderId: null })), done: false })],
    ['empty but not terminal', 'membership_state_page_invalid', () => ({ ok: true, entries: [], done: false })],
    ['out of cursor order', 'membership_state_order_invalid',
      () => ({ ok: true, entries: [{ msgId: 'account1:/F:a@example.com', folderId: null }], done: true })],
    ['carrying an empty owner', 'membership_state_folder_id_invalid',
      () => ({ ok: true, entries: [{ msgId: 'account1:/F:zz@example.com', folderId: '' }], done: true })],
  ])('restarts the pass from before-first after a state page %s and earns no cutover from it', async (_label, reason, page) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts } = seedAssignedFolder(P + 1);
      await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 100);
      expect(fts.listFolderMembershipState.mock.calls.at(-1)[0]).toBeNull();
      await _testExports._runFolderReconSchedulerTick(fts); // a folder turn
      vi.setSystemTime(Date.now() + 100);
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(1);
      fts.listFolderMembershipState.mockImplementationOnce(async () => page());

      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({ complete: false, migration: { failed: true, reason } });
      expect(fts.listFolderMembershipState.mock.calls.at(-1)[0]).not.toBeNull();
      expect(_testExports._getFolderReconRuntimeTelemetry().membershipStateRestartPageInvalid).toBe(1);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
      // The restarted pass reads from before-first on its next pass turn.
      for (let turn = 0; turn < 2 && fts.listFolderMembershipState.mock.calls.length === 2; turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(3);
      expect(fts.listFolderMembershipState.mock.calls.at(-1)[0]).toBeNull();
      for (let turn = 0; turn < 4 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries the same state page after a stale-owner removal fails without a lost fence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows } = seedAssignedFolder(1);
      const staleRow = 'account1:/Gone:gone@example.com';
      nativeRows.set(staleRow, makeFolderMembershipId('account1', '/Gone'));
      const removeBatch = fts.removeBatch.getMockImplementation();
      fts.removeBatch.mockImplementationOnce(async () => { throw new Error('disk I/O error'); });

      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({
        complete: false,
        migration: { failed: true, reason: 'stale_folder_remove_failed' },
      });
      expect(nativeRows.has(staleRow)).toBe(true);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
      fts.removeBatch.mockImplementation(removeBatch);
      // The rejected removal backs the page off; folder turns run meanwhile.
      const failedAtMs = Date.now();
      for (let turn = 0; turn < 30 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        const reads = fts.listFolderMembershipState.mock.calls.length;
        await _testExports._runFolderReconSchedulerTick(fts);
        if (reads === 1 && fts.listFolderMembershipState.mock.calls.length > reads) {
          expect(Date.now() - failedAtMs).toBeGreaterThanOrEqual(reconConfig.errorDelayMs);
        }
      }
      expect(nativeRows.has(staleRow)).toBe(false);
      // Same page retried, then the sticky replay pass that earns cutover.
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after)).toEqual([null, null, null]);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('assigns an ownerless live row read by the state pass instead of revoking cutover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows } = seedAssignedFolder(2);
      // The second live header's row lost its owner before the pass read it.
      const ownerless = 'account1:/F:state-00001@example.com';
      nativeRows.set(ownerless, null);
      await earnCutover(fts);

      expect(nativeRows.get(ownerless)).toBe(makeFolderMembershipId('account1', '/F'));
      expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(ownerless);
      expect(_testExports._getFolderReconRuntimeTelemetry().membershipStateRestartRevoked || 0).toBe(0);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('revokes cutover when the inventory carries a folder without a session id', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts } = seedAssignedFolder(1);
      await earnCutover(fts);
      globalThis.browser.accounts.list.mockResolvedValue([{
        id: 'account1', type: 'none',
        rootFolder: { path: '/', isRoot: true, subFolders: [{ path: '/F', subFolders: [] }] },
      }]);

      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({
        complete: false,
        migration: { failed: true, reason: 'folder_id_inventory_invalid' },
      });
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('reads no further state page after cutover and leaves the page budget to folder work', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts } = seedAssignedFolder(P + 1);
      await earnCutover(fts);
      fts.listFolderMembership.mockClear();

      for (let turn = 0; turn < 3; turn++) {
        await _testExports._runFolderReconSchedulerTick(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(fts.listFolderMembershipState).not.toHaveBeenCalled();
      expect(fts.listFolderMembership).toHaveBeenCalled();
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});

describe('reconciliation recovery wakes (native reconnect, folder topology)', () => {
  // Drives ONLY timers already armed by production code: no manual tick.
  async function driveTimersUntil(predicate, { stepMs = 250, maxVirtualMs = 180_000 } = {}) {
    const startedAt = realDateNow();
    for (let virtualMs = 0; !(await predicate()); virtualMs += stepMs) {
      if (virtualMs >= maxVirtualMs || realDateNow() - startedAt >= 15_000) return false;
      await vi.advanceTimersByTimeAsync(stepMs);
      await yieldToRealEventLoop();
    }
    return true;
  }
  const reconciliationIdle = async () => !_testExports._isFolderReconSchedulerActive()
    && await sessionSettled();
  // An idle legacy scheduler arms nothing; exact mode keeps exactly one
  // future wake, its rolling tick, at most one interval away.
  function expectIdleTimers(exact) {
    expect(vi.getTimerCount()).toBe(exact ? 1 : 0);
    if (!exact) return;
    const remainingMs = _testExports._getFolderReconRollingDueMs() - Date.now();
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(reconConfig.reverifyIntervalMs);
  }

  function withReconnectableHelper(fts) {
    let generation = 1;
    const connectionListeners = new Set();
    fts.getConnectionGeneration = vi.fn(() => generation);
    fts.addConnectionListener = vi.fn((listener) => {
      connectionListeners.add(listener);
      return () => { connectionListeners.delete(listener); };
    });
    return {
      connectionListeners,
      reconnect() {
        generation++;
        for (const listener of [...connectionListeners]) listener(generation);
      },
    };
  }

  function makeEvent() {
    const listeners = new Set();
    return {
      listeners,
      addListener: vi.fn(listener => listeners.add(listener)),
      removeListener: vi.fn(listener => listeners.delete(listener)),
      emit: (...args) => { for (const listener of [...listeners]) listener(...args); },
    };
  }

  function installTopologyEvents() {
    const events = {
      folders: Object.fromEntries(['onCreated', 'onDeleted', 'onRenamed', 'onMoved', 'onCopied']
        .map(name => [name, makeEvent()])),
      accounts: Object.fromEntries(['onCreated', 'onDeleted'].map(name => [name, makeEvent()])),
    };
    globalThis.browser.folders = events.folders;
    Object.assign(globalThis.browser.accounts, events.accounts);
    return events;
  }

  function uninstallTopologyEvents() {
    delete globalThis.browser.folders;
    delete globalThis.browser.accounts.onCreated;
    delete globalThis.browser.accounts.onDeleted;
  }

  it('re-probes and finishes after a helper reconnect that follows an unknown-method verdict', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      const helper = withReconnectableHelper(fts);
      fts.fingerprintMsgIdRange.mockRejectedValue(new Error('Unknown reader method: fingerprintMsgIdRange'));
      await incrementalIndexer.initIncrementalIndexer(fts);

      expect(await driveTimersUntil(() => fts.fingerprintMsgIdRange.mock.calls.length > 0
        && !_testExports._isFolderReconSchedulerActive())).toBe(true);
      // Confirmed unsupported on this connection: no further turn is armed and
      // more time does not re-probe.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(fts.fingerprintMsgIdRange).toHaveBeenCalledOnce();
      expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).not.toHaveBeenCalled();

      fts.fingerprintMsgIdRange.mockReset();
      fts.fingerprintMsgIdRange.mockResolvedValue({ count: 0, sha256: emptyDigest() });
      helper.reconnect();

      expect(await driveTimersUntil(reconciliationIdle)).toBe(true);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders['account1:/A'])
        .toMatchObject({ verified: true });
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries a transient native probe failure with growing delay instead of latching', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      withReconnectableHelper(fts);
      const probeTimes = [];
      fts.fingerprintMsgIdRange.mockImplementation(async () => {
        probeTimes.push(Date.now());
        if (probeTimes.length <= 2) throw new Error('Native helper disconnected');
        return { count: 0, sha256: emptyDigest() };
      });
      await incrementalIndexer.initIncrementalIndexer(fts);

      expect(await driveTimersUntil(reconciliationIdle, { stepMs: 100 })).toBe(true);
      expect(probeTimes.length).toBeGreaterThanOrEqual(3);
      expect(probeTimes[1] - probeTimes[0]).toBeGreaterThanOrEqual(reconConfig.errorDelayMs);
      expect(probeTimes[2] - probeTimes[1]).toBeGreaterThanOrEqual(2 * reconConfig.errorDelayMs);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders['account1:/A'])
        .toMatchObject({ verified: true });
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps transient probe retries within the backoff ceiling on one connection and still verifies once the probe recovers', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      withReconnectableHelper(fts);
      const probeTimes = [];
      fts.fingerprintMsgIdRange.mockImplementation(async (start, end) => {
        if (start === '' && end === '') {
          probeTimes.push(Date.now());
          if (probeTimes.length <= 10) throw new Error('synthetic transient native read failure');
        }
        return { count: 0, sha256: emptyDigest() };
      });
      await incrementalIndexer.initIncrementalIndexer(fts);
      expect(await driveTimersUntil(reconciliationIdle, { stepMs: 10_000, maxVirtualMs: 2_000_000 })).toBe(true);
      expect(probeTimes).toHaveLength(11);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders['account1:/A'])
        .toMatchObject({ verified: true });
      expect(await sessionSettled()).toBe(true);
      const intervals = probeTimes.slice(1).map((time, index) => time - probeTimes[index]);
      const ceilingMs = 5 * 60 * 1000;
      // Ten failures outgrow the ceiling, so the later retries sit at it; one
      // fake-clock step of slack covers settlement.
      expect(Math.max(...intervals)).toBeGreaterThanOrEqual(ceilingMs);
      expect(Math.max(...intervals)).toBeLessThanOrEqual(ceilingMs + 10_000);
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('keeps one connection subscription per indexer lifetime and drops it on dispose', async () => {
    vi.useFakeTimers();
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      const helper = withReconnectableHelper(fts);
      await incrementalIndexer.initIncrementalIndexer(fts);
      await incrementalIndexer.initIncrementalIndexer(fts);
      expect(helper.connectionListeners.size).toBe(1);
      await incrementalIndexer.disposeIncrementalIndexer();
      expect(helper.connectionListeners.size).toBe(0);
      helper.reconnect();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ['folders', 'onDeleted'],
    ['folders', 'onRenamed'],
    ['folders', 'onMoved'],
    ['accounts', 'onDeleted'],
  ])('wakes idle legacy reconciliation on %s.%s and removes the departed folder rows', async (family, name) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const events = installTopologyEvents();
    try {
      const { folders, rowsByURI, nativeKeys, fts } = installRepairFolders([
        { folderPath: '/A', rows: 2 },
        { folderPath: '/B', rows: 2 },
      ]);
      for (const folder of folders) {
        for (const row of rowsByURI.get(folder.folderURI)) {
          nativeKeys.add(`account1:${folder.folderPath}:${row.headerMessageId}`);
        }
      }
      await incrementalIndexer.initIncrementalIndexer(fts);
      expect(await driveTimersUntil(reconciliationIdle)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      // /B disappears from Thunderbird while reconciliation is idle.
      globalThis.browser.accounts.list.mockResolvedValue([{
        id: 'account1', type: 'none',
        rootFolder: { path: '/', isRoot: true, subFolders: [{ path: '/A', subFolders: [] }] },
      }]);
      events[family][name].emit({ accountId: 'account1', path: '/B' });
      await _testExports._reconStorageTransaction(_testExports._getFolderReconGeneration(), () => {});
      expect(reconWorkOwed()).toBe(true);

      expect(await driveTimersUntil(async () => (await reconciliationIdle())
        && ![...nativeKeys].some(key => key.startsWith('account1:/B:')))).toBe(true);
      expect([...nativeKeys].filter(key => key.startsWith('account1:/A:'))).toHaveLength(2);
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      uninstallTopologyEvents();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('starts a fresh exact-mode pass after an idle folder deletion and drops its stale owners', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const events = installTopologyEvents();
    try {
      const { nativeRows, fts } = installExactMembershipFolders([
        { folderPath: '/Keep', headerMessageIds: ['keep@example.com'] },
        { folderPath: '/Gone', headerMessageIds: ['gone@example.com'] },
      ]);
      await incrementalIndexer.initIncrementalIndexer(fts);
      expect(await driveTimersUntil(reconciliationIdle)).toBe(true);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expectIdleTimers(true);

      globalThis.browser.accounts.list.mockResolvedValue([{
        id: 'account1', type: 'none',
        rootFolder: {
          path: '/', isRoot: true,
          subFolders: [{ id: 'session-folder-0', path: '/Keep', subFolders: [] }],
        },
      }]);
      const statePagesBefore = fts.listFolderMembershipState.mock.calls.length;
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/Gone' });

      expect(await driveTimersUntil(async () => (await reconciliationIdle())
        && !nativeRows.has('account1:/Gone:gone@example.com'))).toBe(true);
      expect(fts.listFolderMembershipState.mock.calls.slice(statePagesBefore)[0][0]).toBeNull();
      expect(nativeRows.get('account1:/Keep:keep@example.com'))
        .toBe(makeFolderMembershipId('account1', '/Keep'));
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      uninstallTopologyEvents();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  // `/A` -> `/Temp`, `/B` -> `/A`, `/Temp` -> `/B`: every event fires but the
  // final account/path inventory is identical, so only per-folder
  // re-verification can see that the two folders' contents traded places.
  it.each([
    ['legacy', 'idle', true],
    ['legacy', 'during the last folder verification', true],
    ['legacy', 'idle', false],
    ['exact', 'idle', true],
    ['exact', 'during the last folder verification', true],
    ['exact', 'idle', false],
  ])('re-verifies every folder after a same-inventory topology change (%s mode, %s, contents swapped=%s)', async (mode, when, swapped) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const events = installTopologyEvents();
    try {
      const fixture = mode === 'exact'
        ? installExactMembershipFolders([
          { folderPath: '/A', headerMessageIds: ['a@example.com'] },
          { folderPath: '/B', headerMessageIds: ['b@example.com'] },
        ])
        : installRepairFolders([{ folderPath: '/A', rows: 1 }, { folderPath: '/B', rows: 1 }]);
      const { fts, rowsByURI } = fixture;
      const native = mode === 'exact' ? fixture.nativeRows : fixture.nativeKeys;
      const [uriA, uriB] = [...rowsByURI.keys()];
      const [idA] = rowsByURI.get(uriA).map(row => row.headerMessageId);
      const [idB] = rowsByURI.get(uriB).map(row => row.headerMessageId);
      if (mode !== 'exact') {
        native.add(`account1:/A:${idA}`);
        native.add(`account1:/B:${idB}`);
      }
      globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => ({
        missing: ids.filter(id => !rowsByURI.get(uri).some(row => row.headerMessageId === id)),
      }));
      const inventory = await globalThis.browser.accounts.list();
      const swapTopology = () => {
        if (swapped) {
          const rowsA = rowsByURI.get(uriA);
          rowsByURI.set(uriA, rowsByURI.get(uriB));
          rowsByURI.set(uriB, rowsA);
        }
        events.folders.onRenamed.emit({ accountId: 'account1', path: '/A' }, { accountId: 'account1', path: '/Temp' });
        events.folders.onRenamed.emit({ accountId: 'account1', path: '/B' }, { accountId: 'account1', path: '/A' });
        events.folders.onRenamed.emit({ accountId: 'account1', path: '/Temp' }, { accountId: 'account1', path: '/B' });
      };
      const scan = globalThis.browser.tmMsgNotify.beginFolderMessageScan;
      let fired = false;
      if (when !== 'idle') {
        const original = scan.getMockImplementation();
        scan.mockImplementation(async (...args) => {
          const result = await original(...args);
          // /A is already session-done when /B's first verification starts
          // (in exact mode: the first one after cutover, not the assignment scan).
          if (!fired && args[0] === uriB
              && (mode !== 'exact' || _testExports._getFolderMembershipCleanupProven())) {
            fired = true;
            swapTopology();
          }
          return result;
        });
      }
      // Re-verification admits each folder's new row to missing-row repair.
      const missingFound = async () => {
        const found = new Set();
        for (const { value } of fts.filterNewMessages.mock.results) {
          for (const msgId of (await value).newMsgIds) found.add(msgId);
        }
        return found.has(`account1:/A:${idB}`) && found.has(`account1:/B:${idA}`);
      };
      const staleGone = () => !native.has(`account1:/A:${idA}`) && !native.has(`account1:/B:${idB}`);
      await incrementalIndexer.initIncrementalIndexer(fts);

      if (when === 'idle') {
        expect(await driveTimersUntil(reconciliationIdle)).toBe(true);
        expectIdleTimers(mode === 'exact');
        fired = true;
        swapTopology();
      }
      const scansBefore = when === 'idle' ? scan.mock.calls.length : 0;
      // The inventory the scheduler reads afterwards is the one it verified.
      expect(await globalThis.browser.accounts.list()).toEqual(inventory);

      if (swapped) {
        const ok = await driveTimersUntil(async () => fired && staleGone() && await missingFound());
        expect(ok).toBe(true);
        expect(reconWorkOwed()).toBe(true);
      } else {
        expect(await driveTimersUntil(async () => fired && (await reconciliationIdle())
          && scan.mock.calls.slice(scansBefore).some(([uri]) => uri === uriA)
          && scan.mock.calls.slice(scansBefore).some(([uri]) => uri === uriB))).toBe(true);
        expect(native.has(`account1:/A:${idA}`)).toBe(true);
        expect(native.has(`account1:/B:${idB}`)).toBe(true);
        expect(_testExports._getPendingUpdates().size).toBe(0);
      }
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      uninstallTopologyEvents();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('still re-verifies every folder when the topology marker write fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const events = installTopologyEvents();
    try {
      const fts = installEmptyFolders([['account1', '/A'], ['account1', '/B']]);
      await incrementalIndexer.initIncrementalIndexer(fts);
      expect(await driveTimersUntil(reconciliationIdle)).toBe(true);
      const scan = globalThis.browser.tmMsgNotify.beginFolderMessageScan;
      const scansBefore = scan.mock.calls.length;
      globalThis.browser.storage.local.set.mockRejectedValueOnce(new Error('storage unavailable'));

      events.folders.onRenamed.emit({ accountId: 'account1', path: '/A' }, { accountId: 'account1', path: '/A' });

      expect(await driveTimersUntil(async () => (await reconciliationIdle())
        && scan.mock.calls.length >= scansBefore + 2)).toBe(true);
      expect(new Set(scan.mock.calls.slice(scansBefore).map(([uri]) => uri)).size).toBe(2);
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      uninstallTopologyEvents();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(['legacy', 'exact'])('re-verifies a folder removed and recreated at the same path while reconciliation is idle (%s mode)', async (mode) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const events = installTopologyEvents();
    try {
      const fixture = mode === 'exact'
        ? installExactMembershipFolders([{ folderPath: '/A', headerMessageIds: ['old@example.com'] }])
        : installRepairFolders([{ folderPath: '/A', rows: 1 }]);
      const { folders, rowsByURI, fts } = fixture;
      const nativeKeys = mode === 'exact' ? fixture.nativeRows : fixture.nativeKeys;
      const uri = folders[0].folderURI;
      const oldKey = `account1:/A:${rowsByURI.get(uri)[0].headerMessageId}`;
      if (mode !== 'exact') nativeKeys.add(oldKey);
      globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (probeUri, ids) => ({
        missing: ids.filter(id => !rowsByURI.get(probeUri).some(row => row.headerMessageId === id)),
      }));
      await incrementalIndexer.initIncrementalIndexer(fts);
      expect(await driveTimersUntil(reconciliationIdle)).toBe(true);
      if (mode === 'exact') expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);

      rowsByURI.set(uri, [{ msgKey: 1, headerMessageId: 'new@example.com' }]);
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/A' });
      events.folders.onCreated.emit({ accountId: 'account1', path: '/A' });

      const newKeyFound = async () => {
        for (const { value } of fts.filterNewMessages.mock.results) {
          if ((await value).newMsgIds.includes('account1:/A:new@example.com')) return true;
        }
        return false;
      };
      expect(await driveTimersUntil(async () => !nativeKeys.has(oldKey) && await newKeyFound())).toBe(true);
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      uninstallTopologyEvents();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    // Control: an operation that STARTS without exact mode applies the
    // legacy overlap refusal to both folders.
    ['before the folder operation captures its mode', 'notify', 'getFolderState'],
    ['while the folder operation\'s local proof is in flight', 'notify', 'beginFolderMessageScan'],
    ['while the folder operation reads its native digest', 'fts', 'listFolderMembership'],
  ])('never switches an in-flight folder operation to legacy key ranges when the helper reconnects %s', async (_label, owner, seam) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      // `/F` and `/F:Child` overlap as legacy key ranges: the child's raw key
      // lies inside the parent's range and would strip to a wrong Message-ID.
      const { fts, nativeRows, rowsByURI } = installExactMembershipFolders([
        { folderPath: '/F', headerMessageIds: [] },
        { folderPath: '/F:Child', headerMessageIds: ['child@example.com'] },
      ]);
      const childRow = 'account1:/F:Child:child@example.com';
      const parentId = makeFolderMembershipId('account1', '/F');
      // A stale row in the parent sends its operation through the stale direction.
      const ghostRow = 'account1:/F:ghost@example.com';
      nativeRows.set(ghostRow, parentId);
      const helper = withReconnectableHelper(fts);
      const notify = globalThis.browser.tmMsgNotify;
      notify.probeMessageIds.mockImplementation(async (uri, ids) => ({
        missing: ids.filter(id => !rowsByURI.get(uri).some(row => row.headerMessageId === id)),
      }));
      const target = owner === 'fts' ? fts : notify;
      const original = target[seam].getMockImplementation();
      let reconnected = false;
      target[seam].mockImplementation(async (...args) => {
        const result = await original(...args);
        const parent = seam === 'getFolderState' ? args[1] === '/F'
          : seam === 'listFolderMembership' ? args[0] === parentId
            : result.folderPath === '/F';
        // The helper reconnects (still capable) during the parent's first
        // post-cutover folder operation.
        if (!reconnected && parent && _testExports._getFolderMembershipCleanupProven()) {
          reconnected = true;
          helper.reconnect();
        }
        return result;
      });
      await incrementalIndexer.initIncrementalIndexer(fts);

      expect(await driveTimersUntil(async () => reconnected && (await reconciliationIdle()))).toBe(true);
      expect(nativeRows.get(childRow)).toBe(makeFolderMembershipId('account1', '/F:Child'));
      expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(childRow);
      expect(nativeRows.has(ghostRow)).toBe(false);
      expect(fts.listMsgIdRange).not.toHaveBeenCalled();
      expect(fts.fingerprintMsgIdRange.mock.calls.filter(([start, end]) => start !== '' || end !== ''))
        .toEqual([]);
      // Recovery re-earned exact cutover on the new connection and verified both folders.
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      const memoFolders = storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders;
      expect(memoFolders['account1:/F']).toMatchObject({ verified: true, ftsCount: 0 });
      expect(memoFolders['account1:/F:Child']).toMatchObject({ verified: true, ftsCount: 1 });
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('attaches and detaches every other topology wake when one event API throws', async () => {
    const events = installTopologyEvents();
    try {
      events.folders.onMoved.addListener.mockImplementationOnce(() => { throw new Error('attach refused'); });
      incrementalIndexer.setupFolderTopologyListeners();
      expect(events.folders.onMoved.listeners.size).toBe(0);
      expect(events.folders.onCopied.listeners.size).toBe(1);
      expect(events.accounts.onDeleted.listeners.size).toBe(1);
      // A failed attach is retried by the next registration.
      incrementalIndexer.setupFolderTopologyListeners();
      expect(events.folders.onMoved.listeners.size).toBe(1);

      events.folders.onCreated.removeListener.mockImplementationOnce(() => { throw new Error('detach refused'); });
      await incrementalIndexer.disposeIncrementalIndexer();
      expect(events.folders.onRenamed.listeners.size).toBe(0);
      expect(events.accounts.onDeleted.listeners.size).toBe(0);
      // Ownership is released even when the API refused the removal.
      incrementalIndexer.setupFolderTopologyListeners();
      expect(events.folders.onCreated.addListener).toHaveBeenCalledTimes(2);
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      uninstallTopologyEvents();
    }
  });

  it('ignores topology events while disabled and keeps one owner per event', async () => {
    const events = installTopologyEvents();
    try {
      incrementalIndexer.setupFolderTopologyListeners();
      incrementalIndexer.setupFolderTopologyListeners();
      for (const event of [...Object.values(events.folders), ...Object.values(events.accounts)]) {
        expect(event.listeners.size).toBe(1);
      }
      // A certified folder and a finished orphan pass, so a topology event
      // that acts has something to reopen.
      _testExports._setFolderReconEphemeralEvidenceForTests({
        sessionDone: ['account1:/A'],
        orphanDone: true,
      });
      _testExports._setIsEnabled(false);
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/B' });
      for (let turn = 0; turn < 5; turn++) await yieldToRealEventLoop();
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
      expect(_testExports._getFolderReconDirty().size).toBe(0);
      expect(_testExports._getFolderReconEphemeralEvidence().orphanDone).toBe(true);

      // Positive control: the same event on an enabled indexer reopens the
      // session and owes the certified folder a walk.
      _testExports._setIsEnabled(true);
      _testExports._setFtsSearch(installEmptyFolders([['account1', '/A']]));
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/B' });
      for (let turn = 0; turn < 5; turn++) await yieldToRealEventLoop();
      expect(_testExports._getFolderReconDirty()).toContain('account1:/A');
      expect(_testExports._getFolderReconEphemeralEvidence().orphanDone).toBe(false);
      _testExports._setIsEnabled(false);
      await incrementalIndexer.disposeIncrementalIndexer();
      for (const event of [...Object.values(events.folders), ...Object.values(events.accounts)]) {
        expect(event.listeners.size).toBe(0);
      }
    } finally {
      uninstallTopologyEvents();
    }
  });
});

// ---------------------------------------------------------------------------
// Reconciliation defect fixes: every ownerless row is classified (assign,
// ghost, unloaded or unresolved), unloaded accounts are kept and hold the
// session incomplete, and the orphan stage completes once per binding.
// ---------------------------------------------------------------------------


// Folders already migrated: every live header row is owned, so ticks go
// straight to the pass.
function seedMigratedExactFolders(specs) {
  return installExactMembershipFolders(specs, { assigned: true });
}

// Counts only ticks that did scheduler work: a tick the inter-slice floor
// (or an in-flight wake-fired slice) skipped is not a turn, so a slow, loaded
// event loop cannot use up the bound.
async function tickUntil(fts, done, maxTicks = 30) {
  let result;
  for (let work = 0, guard = 0; work < maxTicks && guard < 20 * maxTicks; guard++) {
    result = await settleSchedulerTickWithFakeTimers(fts);
    vi.setSystemTime(Date.now() + 100);
    if (done(result)) return result;
    if (!isSkippedTick(result)) work++;
  }
  return result;
}

// Like tickUntil, with steps long enough that a refused row's delayed
// unresolved replay runs within a few ticks. Counts only ticks that did
// scheduler work, and settles a wake-fired slice still in flight before each
// clock jump (a jump inside it would raise the hard floor by the jump).
async function tickThroughUnresolvedReplay(fts, done, maxWorkTicks = 30) {
  let result;
  for (let work = 0, guard = 0; work < maxWorkTicks && guard < 20 * maxWorkTicks; guard++) {
    result = await settleSchedulerTickWithFakeTimers(fts);
    if (!isSkippedTick(result)) work++;
    await settleInFlightFolderRecon();
    vi.setSystemTime(Date.now() + reconConfig.membershipUnresolvedRetryMs / 5);
    if (done(result)) return result;
  }
  return result;
}

describe('ownerless-row classifier (exact helpers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('assigns a live row on a scoped positive without any global query', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['live@example.com'] },
    ]);
    nativeRows.set('account1:/F:live@example.com', null);

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(nativeRows.get('account1:/F:live@example.com'))
      .toBe(makeFolderMembershipId('account1', '/F'));
    expect(recheckMessageInFolder).not.toHaveBeenCalled();
  });

  it('assigns a row whose scoped query misses but whose global query finds it', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    const row = 'account1:/F:late-sync@example.com';
    nativeRows.set(row, null);
    recheckMessageInFolder.mockResolvedValue('present');

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(nativeRows.get(row)).toBe(makeFolderMembershipId('account1', '/F'));
    expect(recheckMessageInFolder).toHaveBeenCalledWith('late-sync@example.com', expect.objectContaining({
      accountId: 'account1', path: '/F', id: 'session-folder-0',
    }));
  });

  it('keeps a row with two live owners unresolved and never cuts over', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['X:m@example.com'] },
      { folderPath: '/F:X', headerMessageIds: ['m@example.com'] },
    ]);
    const shared = 'account1:/F:X:m@example.com';
    nativeRows.set(shared, null);

    await tickUntil(fts, () => false, 12);

    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    expect(nativeRows.get(shared)).toBeNull();
    expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(shared);
    expect(_testExports._getFolderReconRuntimeTelemetry().membershipStateRestartUnresolvedReplay)
      .toBeGreaterThan(0);
  });

  it('keeps a row unresolved when a global query errors, and when the key has no account separator', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    nativeRows.set('account1:/F:flaky@example.com', null);
    nativeRows.set('no-separator-key', null);
    recheckMessageInFolder.mockResolvedValue('error');

    await tickUntil(fts, () => false, 8);

    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    expect(nativeRows.has('account1:/F:flaky@example.com')).toBe(true);
    expect(nativeRows.has('no-separator-key')).toBe(true);
    expect(fts.removeBatch).not.toHaveBeenCalled();
  });

  it('spends at most 5 + k - 1 global queries on a k-candidate ghost and defers the next row', async () => {
    const paths = ['/F', '/F:C', '/F:C:C', '/F:C:C:C', '/F:C:C:C:C', '/F:C:C:C:C:C', '/F:C:C:C:C:C:C'];
    const { nativeRows, fts } = seedMigratedExactFolders(
      paths.map(folderPath => ({ folderPath, headerMessageIds: [] })),
    );
    const deep = 'account1:/F:C:C:C:C:C:C:gone@example.com';
    const next = 'account1:/F:C:C:C:C:C:C:later@example.com';
    nativeRows.set(deep, null);
    nativeRows.set(next, null);

    const first = await tickUntil(fts, () => recheckMessageInFolder.mock.calls.length > 0, 5);

    expect(first.migration).toMatchObject({ complete: false, membershipStateProgress: true });
    expect(recheckMessageInFolder).toHaveBeenCalledTimes(paths.length);
    expect(recheckMessageInFolder.mock.calls.every(([headerId]) => !headerId.endsWith('later@example.com')))
      .toBe(true);
    expect(nativeRows.has(deep)).toBe(false);
    expect(nativeRows.get(next)).toBeNull();
    // The deferred row is re-read by the next pass slice, never skipped.
    fts.listFolderMembershipState.mockClear();
    await tickUntil(fts, () => fts.listFolderMembershipState.mock.calls.length > 0, 3);
    expect(fts.listFolderMembershipState.mock.calls[0][0]).toBe(deep);
  });

  it('does not complete an interrupted done:true page until its last ghost is removed', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    const ghosts = Array.from({ length: 6 }, (_, index) => `account1:/F:ghost-${index}@example.com`);
    for (const ghost of ghosts) nativeRows.set(ghost, null);

    const first = await tickUntil(fts, () => recheckMessageInFolder.mock.calls.length > 0, 5);

    expect(first.migration).toMatchObject({ complete: false, membershipStateProgress: true });
    expect(ghosts.filter(ghost => nativeRows.has(ghost))).toEqual([ghosts[5]]);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    expect(_testExports._getFolderMembershipStatePass().completed).toBe(false);
    expect(_testExports._getFolderReconEphemeralEvidence().orphanDone).toBe(false);
    expect(first?.complete).not.toBe(true);

    // The next pass slice removes it; a folder turn may run first.
    await tickUntil(fts, () => !nativeRows.has(ghosts[5]), 3);
    expect(nativeRows.has(ghosts[5])).toBe(false);

    await tickUntil(fts, result => result?.complete === true);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(await sessionSettled()).toBe(true);
  });

  it('lets the global query decide after a probe throws, errors or reports an uncertain lookup, or its folder state is unreadable, and takes a probe positive without one', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['live@example.com'] },
      { folderPath: '/G', headerMessageIds: [] },
    ]);
    const live = 'account1:/F:live@example.com';
    const negatives = ['thrown', 'errored', 'uncertain']
      .map(name => `account1:/F:${name}@example.com`);
    const stateless = 'account1:/G:stateless@example.com';
    nativeRows.set(live, null);
    for (const key of [...negatives, stateless]) nativeRows.set(key, null);
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      if (ids[0] === 'thrown@example.com') throw new Error('probe failed');
      // The real probe's error shape: an empty `missing` beside the error.
      if (ids[0] === 'errored@example.com') return { missing: [], error: 'db_unavailable' };
      if (ids[0] === 'uncertain@example.com') return { missing: [], uncertain: ids };
      return probe(uri, ids);
    });
    const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
    let classifying = false;
    fts.listFolderMembershipState.mockImplementation(((list) => async (...args) => {
      classifying = true;
      return list(...args);
    })(fts.listFolderMembershipState.getMockImplementation()));
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, ...rest) =>
      (classifying && folderPath === '/G'
        // An errored state is never trusted, even when it still names a URI.
        ? { ...(await state(accountId, folderPath, ...rest)), error: 'folder_db_unavailable' }
        : state(accountId, folderPath, ...rest)));
    recheckMessageInFolder.mockResolvedValue('present');

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    const owner = makeFolderMembershipId('account1', '/F');
    for (const key of [live, ...negatives]) expect(nativeRows.get(key)).toBe(owner);
    expect(nativeRows.get(stateless)).toBe(makeFolderMembershipId('account1', '/G'));
    expect(recheckMessageInFolder.mock.calls.map(([headerId]) => headerId).sort()).toEqual(
      ['errored@example.com', 'stateless@example.com', 'thrown@example.com', 'uncertain@example.com']);
    expect(globalThis.browser.tmMsgNotify.probeMessageIds.mock.calls
      .some(([, ids]) => ids[0] === 'stateless@example.com')).toBe(false);
    expect(globalThis.browser.messages.query).not.toHaveBeenCalled();
  });

  // The global answer decides after an uncertain probe: absent removes the
  // row as a ghost, an error leaves it unresolved (no cutover).
  it.each(['absent', 'error'])('follows the global %s verdict after an uncertain probe', async (verdict) => {
    const { fts, nativeRows, folders } = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds: [] }]);
    const key = 'account1:/F:uncertain@example.com';
    nativeRows.set(key, null);
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (_uri, ids) => ({ missing: [], uncertain: ids }));
    recheckMessageInFolder.mockResolvedValue(verdict);

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven(), 12);

    expect(globalThis.browser.tmMsgNotify.probeMessageIds)
      .toHaveBeenCalledWith(folders[0].folderURI, ['uncertain@example.com']);
    expect(recheckMessageInFolder).toHaveBeenCalledWith('uncertain@example.com',
      expect.objectContaining({ accountId: 'account1', path: '/F' }));
    expect(nativeRows.has(key)).toBe(verdict === 'error');
    if (verdict === 'error') expect(nativeRows.get(key)).toBeNull();
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(verdict === 'absent');
    expect(fts.assignFolderMembershipBatch).not.toHaveBeenCalled();
  });

  it('migrates many already-owned rows without any message query', async () => {
    const headerMessageIds = Array.from({ length: reconConfig.membershipStatePageSize * 2 + 3 },
      (_, index) => `owned-${String(index).padStart(4, '0')}@example.com`);
    const { fts } = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds }]);

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(globalThis.browser.messages.query).not.toHaveBeenCalled();
    expect(recheckMessageInFolder).not.toHaveBeenCalled();
  });

  it('retries a ghost page whose removal fence is lost to a relevant re-add, then assigns the row', async () => {
    const { nativeRows, rowsByURI, folders, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    const row = 'account1:/F:readded@example.com';
    nativeRows.set(row, null);
    recheckMessageInFolder.mockImplementationOnce(async () => {
      // The message is re-added while the slice is still deciding: the index
      // write advances the membership epoch the removal is fenced on.
      rowsByURI.get(folders[0].folderURI).push({ msgKey: 99, headerMessageId: 'readded@example.com' });
      await runFtsMembershipMutation(async () => ({ count: 1 }));
      return 'absent';
    });

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(row);
    expect(nativeRows.get(row)).toBe(makeFolderMembershipId('account1', '/F'));
    expect(_testExports._getFolderReconRuntimeTelemetry().membershipStatePageRetries).toBeGreaterThan(0);
  });
});

describe('unloaded-account rows (exact helpers)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const coldNull = 'account2:/Archive:cold@example.com';
  const coldOwned = 'account2:/Archive:owned@example.com';

  function seedWithColdAccount() {
    const installed = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['live@example.com'] },
    ]);
    installed.nativeRows.set(coldNull, null);
    installed.nativeRows.set(coldOwned, makeFolderMembershipId('account2', '/Archive'));
    // The scheduler's own retry timer is part of the contract under test.
    _testExports._setFtsSearch(installed.fts);
    return installed;
  }

  function loadAccount2(installed) {
    const folder = {
      accountId: 'account2',
      folderPath: '/Archive',
      folderId: makeFolderMembershipId('account2', '/Archive'),
      weFolderId: 'session-folder-account2',
      folderURI: 'none://membership-account2',
      serverType: 'none',
      stableUidKeys: false,
      uidValidity: 0,
    };
    installed.folders.push(folder);
    installed.rowsByURI.set(folder.folderURI, [
      { msgKey: 1, headerMessageId: 'cold@example.com' },
      { msgKey: 2, headerMessageId: 'owned@example.com' },
    ]);
    globalThis.browser.accounts.list.mockResolvedValue([
      {
        id: 'account1', type: 'none',
        rootFolder: {
          path: '/', isRoot: true,
          subFolders: installed.folders.filter(item => item.accountId === 'account1').map(item => ({
            id: item.weFolderId, path: item.folderPath, subFolders: [],
          })),
        },
      },
      {
        id: 'account2', type: 'none',
        rootFolder: {
          path: '/', isRoot: true,
          subFolders: [{ id: folder.weFolderId, path: folder.folderPath, subFolders: [] }],
        },
      },
    ]);
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath) => ({
      ...installed.folders.find(item => item.accountId === accountId && item.folderPath === folderPath),
    }));
  }

  // Fire the scheduler's own armed timer, drive the tick it starts to
  // completion, and return the delay that tick armed next.
  async function fireSchedulerTimer() {
    const ticks = _testExports._getFolderReconRuntimeTelemetry().schedulerTicks;
    await vi.advanceTimersToNextTimerAsync();
    expect(_testExports._getFolderReconRuntimeTelemetry().schedulerTicks).toBeGreaterThan(ticks);
    while (_testExports._isFolderReconSchedulerActive()) {
      await vi.advanceTimersByTimeAsync(_testExports.FOLDER_RECON_CHUNK_DELAY_MS);
      await yieldToRealEventLoop();
    }
    return _testExports._getFolderReconRuntimeTelemetry().lastScheduledDelayMs;
  }

  // Run on the scheduler's own timers until `count` inventory-retry-length
  // waits were armed; shorter pace wakes in between are the work they schedule.
  async function retryDelays(count) {
    const delays = [];
    for (let fired = 0; fired < 200 && delays.length < count; fired++) {
      const delayMs = await fireSchedulerTimer();
      if (delayMs >= reconConfig.errorDelayMs) delays.push(delayMs);
    }
    return delays;
  }

  // Start reconciliation with one tick, then let the scheduler's own timers
  // run it until it parks on the inventory retry.
  async function runUntilRetryArmed(fts) {
    await settleSchedulerTickWithFakeTimers(fts);
    const armedMs = () => _testExports._getFolderReconRuntimeTelemetry().lastScheduledDelayMs;
    if (armedMs() < reconConfig.errorDelayMs) await retryDelays(1);
    expect(armedMs()).toBe(reconConfig.errorDelayMs);
  }

  async function runTimersUntil(done) {
    for (let fired = 0; fired < 200 && !(await done()); fired++) await fireSchedulerTimer();
    return done();
  }

  it('keeps NULL and owned rows of an unloaded account, proves cutover and holds the session incomplete', async () => {
    const { nativeRows, fts } = seedWithColdAccount();

    await runUntilRetryArmed(fts);

    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(_testExports._getFolderMembershipStatePass().unloaded).toBe(2);
    expect(nativeRows.get(coldNull)).toBeNull();
    expect(nativeRows.get(coldOwned)).toBe(makeFolderMembershipId('account2', '/Archive'));
    expect(fts.removeBatch).not.toHaveBeenCalled();
    expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
    expect(_testExports._getFolderReconRuntimeTelemetry().membershipStateRestartRevoked).toBe(0);
    // The kept rows were never queried: no live query can see an unloaded account.
    expect(recheckMessageInFolder).not.toHaveBeenCalled();
    // The kept rows hold the session open: another tick does not complete it.
    expect(await settleSchedulerTickWithFakeTimers(fts))
      .toMatchObject({ complete: false, reason: 'unloaded_accounts' });
  });

  // Exact mode's rolling tick re-reads the inventory at least once per
  // interval, so the doubling backoff never parks it for longer.
  it('re-reads the inventory on a doubling backoff, at least once per rolling interval, without re-running the pass', async () => {
    const { fts } = seedWithColdAccount();
    const errorDelayMs = reconConfig.errorDelayMs;
    await settleSchedulerTickWithFakeTimers(fts);

    const delays = await retryDelays(12);

    expect(delays.slice(0, 6)).toEqual([1, 2, 4, 8, 16, 32].map(factor => errorDelayMs * factor));
    for (const delayMs of delays) expect(delayMs).toBeLessThanOrEqual(reconConfig.reverifyIntervalMs);
    expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
    // Unchanged digest: the completed pass is reused, no page is re-read.
    fts.listFolderMembershipState.mockClear();
    fts.listFolderMembership.mockClear();
    const [nextDelayMs] = await retryDelays(1);
    expect(nextDelayMs).toBeLessThanOrEqual(reconConfig.reverifyIntervalMs);
    expect(fts.listFolderMembershipState).not.toHaveBeenCalled();
    expect(fts.listFolderMembership).not.toHaveBeenCalled();
  });

  it('resets the backoff when the inventory digest changes', async () => {
    const installed = seedWithColdAccount();
    const { fts } = installed;
    await settleSchedulerTickWithFakeTimers(fts);
    expect(await retryDelays(4)).toEqual([1, 2, 4, 8].map(factor => reconConfig.errorDelayMs * factor));

    // A new, empty account1 folder changes the digest but not the cold account.
    const folder = {
      accountId: 'account1', folderPath: '/New', folderId: makeFolderMembershipId('account1', '/New'),
      weFolderId: 'session-folder-new', folderURI: 'none://membership-new',
      serverType: 'none', stableUidKeys: false, uidValidity: 0,
    };
    installed.folders.push(folder);
    installed.rowsByURI.set(folder.folderURI, []);
    globalThis.browser.accounts.list.mockResolvedValue([{
      id: 'account1', type: 'none',
      rootFolder: {
        path: '/', isRoot: true,
        subFolders: installed.folders.map(item => ({ id: item.weFolderId, path: item.folderPath, subFolders: [] })),
      },
    }]);

    expect(await retryDelays(3)).toEqual([1, 2, 4].map(factor => reconConfig.errorDelayMs * factor));
    expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
    expect(_testExports._getFolderMembershipStatePass().unloaded).toBe(2);
  });

  it('keeps no timer after dispose while the retry is armed', async () => {
    const { fts } = seedWithColdAccount();
    await runUntilRetryArmed(fts);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await incrementalIndexer.disposeIncrementalIndexer();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('migrates a late-loading account on the retry tick and then completes the session', async () => {
    const installed = seedWithColdAccount();
    const { nativeRows, fts } = installed;
    await runUntilRetryArmed(fts);

    // No topology event: the account simply appears in the next inventory read.
    loadAccount2(installed);

    expect(await runTimersUntil(sessionSettled)).toBe(true);
    expect(nativeRows.get(coldNull)).toBe(makeFolderMembershipId('account2', '/Archive'));
    expect(nativeRows.get(coldOwned)).toBe(makeFolderMembershipId('account2', '/Archive'));
    expect(fts.removeBatch).not.toHaveBeenCalled();
  });

  it('holds the session incomplete for seeded rows under an empty inventory, then progresses once the account loads', async () => {
    const installed = installExactMembershipFolders([]);
    const { nativeRows, fts } = installed;
    nativeRows.set('account1:/F:kept@example.com', null);
    nativeRows.set('account1:/F:owned@example.com', makeFolderMembershipId('account1', '/F'));
    _testExports._setFtsSearch(fts);

    await runUntilRetryArmed(fts);

    expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
    expect(nativeRows.size).toBe(2);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    const folder = {
      accountId: 'account1', folderPath: '/F', folderId: makeFolderMembershipId('account1', '/F'),
      weFolderId: 'session-folder-f', folderURI: 'none://membership-f',
      serverType: 'none', stableUidKeys: false, uidValidity: 0,
    };
    installed.folders.push(folder);
    installed.rowsByURI.set(folder.folderURI, [
      { msgKey: 1, headerMessageId: 'kept@example.com' },
      { msgKey: 2, headerMessageId: 'owned@example.com' },
    ]);
    globalThis.browser.accounts.list.mockResolvedValue([{
      id: 'account1', type: 'none',
      rootFolder: { path: '/', isRoot: true, subFolders: [{ id: folder.weFolderId, path: '/F', subFolders: [] }] },
    }]);

    expect(await runTimersUntil(sessionSettled)).toBe(true);
    expect(nativeRows.get('account1:/F:kept@example.com')).toBe(makeFolderMembershipId('account1', '/F'));
  });

  it('completes the session for an empty inventory over an empty index', async () => {
    const { fts } = installExactMembershipFolders([]);
    _testExports._setFtsSearch(fts);

    await settleSchedulerTickWithFakeTimers(fts);
    await runTimersUntil(async () => (await sessionSettled()) || vi.getTimerCount() === 0);

    expect(await sessionSettled()).toBe(true);
  });

  it('spends no state page on the tick after the unloaded terminal state', async () => {
    const { fts } = seedWithColdAccount();
    await runUntilRetryArmed(fts);
    fts.listFolderMembershipState.mockClear();
    fts.listFolderMembership.mockClear();

    await fireSchedulerTimer();

    expect(fts.listFolderMembershipState).not.toHaveBeenCalled();
    expect(fts.listFolderMembership).not.toHaveBeenCalled();
  });
});

// Legacy helper over a real key set; the listed folders are empty in
// Thunderbird, so every key used here lies outside every folder prefix.
function installLegacyKeyIndex(folderPaths, initialKeys) {
  const fts = installEmptyFolders(folderPaths.map(folderPath => ['account1', folderPath]));
  const keys = new Set(initialKeys);
  fts.fingerprintMsgIdRange.mockImplementation(async (start, end) => {
    const rows = sqliteNativeRange(keys, start, end);
    return { count: rows.length, sha256: framedDigest(rows) };
  });
  fts.countMsgIdRange.mockImplementation(async (start, end) => ({
    count: sqliteNativeRange(keys, start, end).length,
  }));
  fts.listMsgIdRange.mockImplementation(async (start, end, after, limit) => {
    const rows = sqliteNativeRange(keys, start, end, after);
    const page = rows.slice(0, limit);
    return { msgIds: page, done: page.length < limit };
  });
  fts.removeBatch.mockImplementation(async ids => {
    let count = 0;
    for (const id of ids) count += keys.delete(id) ? 1 : 0;
    return { count };
  });
  fts.getMessageByMsgId.mockImplementation(async id => (keys.has(id) ? { msgId: id } : null));
  return { fts, keys };
}

// A queued update of an account outside the inventory holds the session open
// (the orphan tail's quiet predicate refuses) without blocking any folder's
// work.
const HELD_KEY = 'account9:/Held:held@example.com';
function holdSessionWithQueuedUpdate() {
  _testExports._getPendingUpdates().set(HELD_KEY, {
    uniqueKey: HELD_KEY,
    type: 'add',
    timestamp: Date.now(),
  });
}

describe('orphan completion across ticks', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._getPendingUpdates().clear();
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('keeps the pin refusal of all orphan work while a legacy overlap group exists, then cleans once it is gone', async () => {
    const zGone = 'account1:/ZGone:z@example.com';
    const { fts, keys } = installLegacyKeyIndex(['/F', '/F:Child'], [zGone]);

    for (let turn = 0; turn < 4; turn++) {
      const result = await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + 100);
      expect(result).toMatchObject({ skipped: true, reason: 'ambiguous_folder_keyspace' });
    }
    expect(fts.countMsgIdRange).not.toHaveBeenCalled();
    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
    expect(recheckMessageInFolder).not.toHaveBeenCalled();
    expect(keys.has(zGone)).toBe(true);
    expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);

    // Control: the overlap disappears with the inventory change.
    globalThis.browser.accounts.list.mockResolvedValue([{
      id: 'account1', type: 'imap',
      rootFolder: { path: '/', isRoot: true, subFolders: [{ path: '/F', subFolders: [] }] },
    }]);
    const result = await tickUntil(fts, value => value?.complete === true);

    expect(result).toMatchObject({ complete: true });
    expect(keys.has(zGone)).toBe(false);
    expect(recheckMessageInFolder).toHaveBeenCalledOnce();
    expect(await sessionSettled()).toBe(true);
  });

  it('yields a legacy orphan slice to foreground pressure without losing the pass', async () => {
    const ghost = 'account1:/Gone:x@example.com';
    const { fts, keys } = installLegacyKeyIndex(['/Keep'], [ghost]);
    recheckMessageInFolder.mockImplementationOnce(async () => {
      getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
      return 'absent';
    });

    const pressured = await tickUntil(fts, value => value?.reason === 'pressure');

    expect(pressured).toMatchObject({ skipped: true, reason: 'pressure' });
    expect(keys.has(ghost)).toBe(true);
    getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
    const result = await tickUntil(fts, value => value?.complete === true);
    expect(result).toMatchObject({ complete: true });
    expect(keys.has(ghost)).toBe(false);
  });

  it('retries a legacy basis interrupted at its global count instead of walking a clean index', async () => {
    const { fts } = installLegacyKeyIndex(['/Keep'], []);
    const count = fts.countMsgIdRange.getMockImplementation();
    let pressured = false;
    fts.countMsgIdRange.mockImplementation(async (start, end) => {
      if (start === '' && !pressured) {
        pressured = true;
        getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
      }
      return count(start, end);
    });

    const interrupted = await tickUntil(fts, value => value?.reason === 'pressure');
    expect(interrupted).toMatchObject({ skipped: true, reason: 'pressure' });
    getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
    const result = await tickUntil(fts, value => value?.complete === true);

    expect(result).toMatchObject({ complete: true });
    // The basis retried its global count; no orphan walk page was read.
    expect(fts.countMsgIdRange.mock.calls.filter(([start]) => start === '')).toHaveLength(2);
    expect(fts.listMsgIdRange.mock.calls.filter(([start]) => start === '')).toHaveLength(0);
    expect(await sessionSettled()).toBe(true);
  });

  it.each([
    ['an equal count basis', []],
    ['a walk after a count mismatch', ['account1:/Gone:x@example.com']],
  ])('keeps a legacy orphan completion from %s across a later drain write', async (_label, ghosts) => {
    const { fts, keys } = installLegacyKeyIndex(['/Keep'], ghosts);
    holdSessionWithQueuedUpdate();

    await tickUntil(fts, () => _testExports._getFolderReconOrphanPass()?.complete === true);
    expect(_testExports._getFolderReconOrphanPass()?.complete).toBe(true);
    expect(quietNow()).toBe(false);
    for (const ghost of ghosts) expect(keys.has(ghost)).toBe(false);

    // The queued update drains: one indexBatch into a known folder.
    _testExports._getPendingUpdates().clear();
    await runFtsMembershipMutation(async () => ({ count: 1 }));
    fts.countMsgIdRange.mockClear();
    fts.listMsgIdRange.mockClear();
    fts.fingerprintMsgIdRange.mockClear();
    const result = await settleSchedulerTickWithFakeTimers(fts);

    expect(result).toMatchObject({ complete: true });
    expect(await sessionSettled()).toBe(true);
    expect(fts.countMsgIdRange).not.toHaveBeenCalled();
    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
  });

  it('removes removed-folder and keeps colon-overlap rows in the exact state pass, and keeps that completion across a drain write', async () => {
    // Both live rows lie inside /F's raw key range: one is /F's own message
    // whose Message-ID contains a colon, one belongs to /F:X.
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['X:a@example.com'] },
      { folderPath: '/F:X', headerMessageIds: ['b@example.com'] },
    ]);
    const former = 'account1:/F:Former:y@example.com';
    nativeRows.set(former, makeFolderMembershipId('account1', '/F:Former'));
    holdSessionWithQueuedUpdate();

    await tickUntil(fts, () => _testExports._getFolderMembershipStatePass()?.completed === true);
    await settleSchedulerTickWithFakeTimers(fts);
    expect(nativeRows.has(former)).toBe(false);
    expect(nativeRows.get('account1:/F:X:a@example.com')).toBe(makeFolderMembershipId('account1', '/F'));
    expect(nativeRows.get('account1:/F:X:b@example.com')).toBe(makeFolderMembershipId('account1', '/F:X'));
    expect(quietNow()).toBe(false);

    _testExports._getPendingUpdates().clear();
    await runFtsMembershipMutation(async () => ({ count: 1 }));
    fts.listFolderMembershipState.mockClear();
    // The write raises the scheduler's quiet floor; the next ticks wait it out.
    const result = await tickUntil(fts, value => value?.complete === true, 40);

    expect(result).toMatchObject({ complete: true });
    expect(await sessionSettled()).toBe(true);
    expect(fts.listFolderMembershipState).not.toHaveBeenCalled();
  });

  it('does not let a completed exact pass survive an inventory change', async () => {
    const installed = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds: [] }]);
    const { fts } = installed;
    holdSessionWithQueuedUpdate();
    await tickUntil(fts, () => _testExports._getFolderMembershipStatePass()?.completed === true);

    const folder = {
      accountId: 'account1', folderPath: '/G', folderId: makeFolderMembershipId('account1', '/G'),
      weFolderId: 'session-folder-g', folderURI: 'none://membership-g',
      serverType: 'none', stableUidKeys: false, uidValidity: 0,
    };
    installed.folders.push(folder);
    installed.rowsByURI.set(folder.folderURI, []);
    globalThis.browser.accounts.list.mockResolvedValue([{
      id: 'account1', type: 'none',
      rootFolder: {
        path: '/', isRoot: true,
        subFolders: installed.folders.map(item => ({ id: item.weFolderId, path: item.folderPath, subFolders: [] })),
      },
    }]);
    _testExports._getPendingUpdates().clear();
    const changed = await settleSchedulerTickWithFakeTimers(fts);

    expect(changed?.complete).not.toBe(true);
    expect(reconWorkOwed()).toBe(true);
    const result = await tickUntil(fts, value => value?.complete === true);
    expect(result).toMatchObject({ complete: true });
  });

  // The orphan tail's quiet predicate alone refuses a session completion
  // across a message event that lands after the orphan slice's last await.
  it('refuses completion and continues the orphan tail when a message event lands between the orphan slice and the tail', async () => {
    const { fts } = installLegacyKeyIndex(['/Keep'], []);
    const count = fts.countMsgIdRange.getMockImplementation();
    let fired = false;
    fts.countMsgIdRange.mockImplementation(async (start, end) => {
      const result = await count(start, end);
      // The basis' global count is the orphan slice's last native read.
      if (start === '' && !fired) {
        fired = true;
        _testExports._invalidateFolderReconProofForEvent('account1', '/Keep');
      }
      return result;
    });

    const refused = await tickUntil(fts, () => fired);

    expect(refused).toEqual({ complete: false, orphan: expect.objectContaining({ complete: true }) });
    expect(_testExports._getFolderReconOrphanPass()?.complete).toBe(true);
    // Quiet control: the next tick that began after the event completes.
    const result = await settleSchedulerTickWithFakeTimers(fts);
    expect(result).toMatchObject({ complete: true });
  });

  it('documents #111: a late exact-mode commit after the completed pass stays until the next pass', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds: [] }]);
    await tickUntil(fts, value => value?.complete === true);
    expect(await sessionSettled()).toBe(true);

    // A timed-out index_batch for a since-removed folder commits natively
    // with no epoch advance.
    const late = 'account1:/Removed:late@example.com';
    nativeRows.set(late, makeFolderMembershipId('account1', '/Removed'));
    await settleSchedulerTickWithFakeTimers(fts);

    expect(nativeRows.has(late)).toBe(true);
  });

  it.each([2, 3])('ignores a stored version-%i orphanSweep cursor and drops it on the next memo write', async (version) => {
    const ghost = 'account1:/Gone:a@example.com';
    const { fts, keys } = installLegacyKeyIndex(['/INBOX'], [ghost]);
    // A stored cursor already past the ghost, with digests that match this
    // inventory and index exactly as a 1.8.4 / PR 1 build would have stored.
    storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
      version,
      roundRobinCursor: null,
      folders: {},
      orphanSweep: {
        afterKey: 'account1:/Gone:z@example.com',
        inventoryCount: 1,
        inventorySha256: framedDigest(['account1:/INBOX']),
        knownFtsCount: 0,
        nativeCount: 1,
        nativeSha256: framedDigest([ghost]),
        membershipEpoch: getFtsMembershipEpoch(),
        updatedAtMs: Date.now(),
      },
    };

    const result = await tickUntil(fts, value => value?.complete === true);

    expect(result).toMatchObject({ complete: true });
    expect(keys.has(ghost)).toBe(false);
    expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].orphanSweep).toBeUndefined();
  });
});

describe('legacy orphan pass reset triggers', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const ghosts = Array.from({ length: 12 }, (_, index) =>
    `account1:/Deleted:ghost-${String(index).padStart(2, '0')}@example.com`);

  async function startWalk() {
    const installed = installLegacyKeyIndex(['/Keep'], ghosts);
    let connection = 1;
    installed.fts.getConnectionGeneration = vi.fn(() => connection);
    installed.reconnect = () => { connection++; };
    recheckMessageInFolder.mockResolvedValue('present');
    await tickUntil(installed.fts, () => _testExports._getFolderReconOrphanPass()?.cursor != null);
    expect(_testExports._getFolderReconOrphanPass().cursor).toBe(ghosts[4]);
    return installed;
  }

  const setInventory = (paths) => {
    globalThis.browser.accounts.list.mockResolvedValue([{
      id: 'account1', type: 'imap',
      rootFolder: { path: '/', isRoot: true, subFolders: paths.map(path => ({ path, subFolders: [] })) },
    }]);
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath) => ({
      accountId, folderPath, folderURI: `imap://${folderPath}`,
      serverType: 'imap', stableUidKeys: true, uidValidity: 1,
    }));
    globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async uri => ({
      token: `scan-${uri}`, accountId: 'account1', folderPath: uri.slice('imap://'.length),
      stableUidKeys: true, uidValidity: 1,
    }));
  };

  // The real producer of dirty marks for dropped work: an abandoned queued
  // update dirties its folder (or `__all__` when it names none).
  async function abandonQueuedUpdate(folderKey) {
    const update = { uniqueKey: 'account1:/Keep:dropped@example.com', type: 'add', timestamp: Date.now(), folderKey };
    _testExports._getPendingUpdates().set(update.uniqueKey, update);
    await _testExports._abandonPendingUpdates([update]);
  }

  it.each([
    ['a folder dirty mark', async () => { await abandonQueuedUpdate('account1:/Keep'); }],
    ['an __all__ dirty mark', async () => { await abandonQueuedUpdate(undefined); }],
    ['an inventory digest change', async () => { setInventory(['/Keep', '/Other']); }],
    ['a native reconnect', async ({ reconnect }) => { reconnect(); }],
  ])('restarts a mid-walk pass before-first after %s', async (_label, trigger) => {
    const installed = await startWalk();
    const before = _testExports._getFolderReconOrphanPass();

    await trigger(installed);
    installed.fts.listMsgIdRange.mockClear();
    // Per-folder work reads its own range first; the orphan walk reads ''.
    const walkCalls = () => installed.fts.listMsgIdRange.mock.calls.filter(([start]) => start === '');
    await tickUntil(installed.fts, () => walkCalls().length > 0);

    expect(_testExports._getFolderReconOrphanPass()).not.toBe(before);
    expect(walkCalls()[0][2]).toBeNull();
  });

  it('drops the pass on dispose', async () => {
    await startWalk();

    await incrementalIndexer.disposeIncrementalIndexer();

    expect(_testExports._getFolderReconOrphanPass()).toBeNull();
  });

  it('neither runs nor drops the pass on an ambiguity tick', async () => {
    const { fts } = await startWalk();
    const before = _testExports._getFolderReconOrphanPass();
    setInventory(['/Keep', '/Keep:Child']);
    fts.listMsgIdRange.mockClear();

    const result = await settleSchedulerTickWithFakeTimers(fts);

    expect(result).toMatchObject({ skipped: true, reason: 'ambiguous_folder_keyspace' });
    expect(_testExports._getFolderReconOrphanPass()).toBe(before);
    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
  });
});

describe('exact state pass progress and cost', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._getPendingUpdates().clear();
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('progresses past an unresolved prefix, replays it after the terminal page, and cuts over once it resolves', async () => {
    const installed = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['X:a@example.com', 'c-live@example.com'] },
      { folderPath: '/F:X', headerMessageIds: ['a@example.com'] },
    ]);
    const { nativeRows, rowsByURI, folders, fts } = installed;
    // Two live owners for one native key (colon overlap): unresolved.
    const shared = 'account1:/F:X:a@example.com';
    nativeRows.set(shared, null);
    // Scoped negative and a global error: unresolved.
    const flaky = 'account1:/F:b-flaky@example.com';
    nativeRows.set(flaky, null);
    // Sorted after both: a live row to assign and a ghost to remove.
    nativeRows.set('account1:/F:c-live@example.com', null);
    const ghost = 'account1:/F:d-ghost@example.com';
    nativeRows.set(ghost, null);
    recheckMessageInFolder.mockImplementation(async headerId =>
      (headerId === 'b-flaky@example.com' ? 'error' : 'absent'));

    await tickUntil(fts, () => _testExports._getFolderReconRuntimeTelemetry()
      .membershipStateRestartUnresolvedReplay > 0);

    expect(nativeRows.get('account1:/F:c-live@example.com')).toBe(makeFolderMembershipId('account1', '/F'));
    expect(nativeRows.has(ghost)).toBe(false);
    expect(nativeRows.get(shared)).toBeNull();
    expect(nativeRows.get(flaky)).toBeNull();
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);

    // Resolution: /F:X's copy goes away and the flaky query recovers.
    rowsByURI.set(folders[1].folderURI, []);
    rowsByURI.get(folders[0].folderURI).push({ msgKey: 9, headerMessageId: 'b-flaky@example.com' });
    recheckMessageInFolder.mockResolvedValue('absent');
    // The replay waits out the in-session unresolved retry delay.
    vi.setSystemTime(Date.now() + reconConfig.membershipUnresolvedRetryMs);
    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(nativeRows.get(shared)).toBe(makeFolderMembershipId('account1', '/F'));
    expect(nativeRows.get(flaky)).toBe(makeFolderMembershipId('account1', '/F'));
  });

  it('finishes a short page of owned, unloaded and one ghost row in one slice with one global query', async () => {
    const headerMessageIds = Array.from({ length: 30 }, (_, index) => `owned-${index}@example.com`);
    const { nativeRows, fts } = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds }]);
    for (let index = 0; index < 10; index++) nativeRows.set(`account2:/Cold:cold-${index}@example.com`, null);
    const ghost = 'account1:/F:zz-ghost@example.com';
    nativeRows.set(ghost, null);

    await tickUntil(fts, () => _testExports._getFolderMembershipStatePass()?.slices > 0);
    const pass = _testExports._getFolderMembershipStatePass();

    expect(pass.slices).toBe(1);
    expect(recheckMessageInFolder).toHaveBeenCalledOnce();
    expect(nativeRows.has(ghost)).toBe(false);
    expect(pass.unloaded).toBe(10);
  });

  it('assigns and cuts over under between-slice writes, then completes once they stop', async () => {
    const headerMessageIds = Array.from({ length: reconConfig.membershipStatePageSize * 3 },
      (_, index) => `live-${String(index).padStart(4, '0')}@example.com`);
    const installed = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds }]);
    const { nativeRows, rowsByURI, folders, fts } = installed;
    for (const id of headerMessageIds) nativeRows.set(`account1:/F:${id}`, null);

    // Phase 1: a drain write lands between every slice until cutover.
    let written = 0;
    for (let turn = 0; turn < 60 && !_testExports._getFolderMembershipCleanupProven(); turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + 100);
      const id = `drained-${written++}@example.com`;
      rowsByURI.get(folders[0].folderURI).push({ msgKey: 1000 + written, headerMessageId: id });
      await runFtsMembershipMutation(async () => {
        nativeRows.set(`account1:/F:${id}`, folders[0].folderId);
        return { count: 1 };
      });
    }
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    for (const id of headerMessageIds) {
      expect(nativeRows.get(`account1:/F:${id}`)).toBe(folders[0].folderId);
    }

    // Phase 2: quiet ticks complete reconciliation.
    const result = await tickUntil(fts, value => value?.complete === true, 60);
    expect(result).toMatchObject({ complete: true });
    expect(await sessionSettled()).toBe(true);
    expect(populateBatchBody).not.toHaveBeenCalled();
  });
});

describe('drain body fetches (unchanged by reconciliation)', () => {
  afterEach(() => {
    _testExports._getPendingUpdates().clear();
  });

  async function drain(headerIds, indexed) {
    const keys = headerIds.map(id => `account1:/Drain:${id}`);
    headerIds.forEach((id, index) => {
      _testExports._getPendingUpdates().set(keys[index], {
        type: 'new', uniqueKey: keys[index], timestamp: Date.now(),
        folderKey: 'account1:/Drain', hasFailed: false, lastFailedAt: 0, metadata: {},
      });
    });
    headerIDToWeID.mockImplementation(async headerId => 100 + headerIds.indexOf(headerId));
    globalThis.browser.messages = {
      get: vi.fn(async weId => ({
        id: weId,
        headerMessageId: headerIds[weId - 100],
        folder: { accountId: 'account1', path: '/Drain' },
      })),
    };
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: `account1:/Drain:${header.headerMessageId}`,
    })));
    getUniqueMessageKey.mockImplementation(async header => `account1:/Drain:${header.headerMessageId}`);
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    const fts = {
      filterNewMessages: vi.fn(async rows => ({
        newMsgIds: rows.map(row => row.msgId).filter(msgId => !indexed.has(msgId)),
      })),
      getMessageByMsgId: vi.fn(async msgId => (indexed.has(msgId) ? { msgId } : null)),
      indexBatch: vi.fn(async rows => {
        for (const row of rows) indexed.add(row.msgId);
        return { count: rows.length };
      }),
      stats: vi.fn(async () => ({})),
    };
    _testExports._setFtsSearch(fts);
    await flushPendingUpdates();
    return keys;
  }

  it('fetches no body for adds that are already indexed and exactly one for the one missing row', async () => {
    const indexedIds = Array.from({ length: 5 }, (_, index) => `indexed-${index}@example.com`);
    const indexed = new Set(indexedIds.map(id => `account1:/Drain:${id}`));

    await drain(indexedIds, indexed);
    expect(populateBatchBody).not.toHaveBeenCalled();
    expect(_testExports._getPendingUpdates().size).toBe(0);

    await drain([...indexedIds, 'missing@example.com'], indexed);
    expect(populateBatchBody).toHaveBeenCalledOnce();
    expect(populateBatchBody.mock.calls[0][0].map(row => row.msgId))
      .toEqual(['account1:/Drain:missing@example.com']);
  });
});

describe('no-change startup writes nothing to storage', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const FOLDER_COUNT = 200;

  function storageWriteKeys() {
    const set = globalThis.browser.storage.local.set.mock.calls.flatMap(([items]) => Object.keys(items));
    const removed = globalThis.browser.storage.local.remove.mock.calls.flatMap(([keys]) => [keys].flat());
    return { set, removed };
  }

  // One full session earns every checkpoint; the next session starts from
  // the stored memo with nothing changed.
  async function finishFirstSessionThenRestart(install) {
    const installed = install();
    const first = await tickUntil(installed.fts, value => value?.complete === true, FOLDER_COUNT * 3);
    expect(first).toMatchObject({ complete: true });
    _testExports._resetFolderReconState();
    _testExports._setIsEnabled(true);
    globalThis.browser.storage.local.set.mockClear();
    globalThis.browser.storage.local.remove.mockClear();
    return installed;
  }

  async function runSecondSession(fts) {
    let result;
    for (let turn = 0; turn < FOLDER_COUNT * 3 && result?.complete !== true; turn++) {
      result = await settleSchedulerTickWithFakeTimers(fts);
      // Cross the 30 s outcome-snapshot throttle partway through.
      vi.setSystemTime(Date.now() + (turn === Math.floor(FOLDER_COUNT / 2) ? 31_000 : 100));
    }
    return result;
  }

  const legacyFullProjection = () => {
    const installed = installRepairFolders(Array.from({ length: FOLDER_COUNT }, (_, index) => ({
      folderPath: `/F${String(index).padStart(3, '0')}`, rows: 1,
    })));
    installed.folders.forEach((folder, index) => {
      installed.nativeKeys.add(`account1:${folder.folderPath}:${index}-1@example.com`);
    });
    return installed;
  };
  const legacyUidTier = () => ({
    fts: installEmptyFolders(Array.from({ length: FOLDER_COUNT }, (_, index) =>
      ['account1', `/U${String(index).padStart(3, '0')}`])),
  });
  const exactFullProjection = () => seedMigratedExactFolders(Array.from({ length: FOLDER_COUNT }, (_, index) => ({
    folderPath: `/E${String(index).padStart(3, '0')}`, headerMessageIds: [`e-${index}@example.com`],
  })));

  it.each([
    ['legacy, non-IMAP full projection', legacyFullProjection],
    ['legacy, IMAP UID tier', legacyUidTier],
    ['exact, non-IMAP full projection', exactFullProjection],
  ])('%s: zero storage writes', async (_label, install) => {
    const { fts } = await finishFirstSessionThenRestart(install);

    const result = await runSecondSession(fts);

    expect(result).toMatchObject({ complete: true });
    const { set, removed } = storageWriteKeys();
    expect(set).toEqual([]);
    expect(removed).toEqual([]);
    expect(await sessionSettled()).toBe(true);
  }, 30_000);

  it('control: one changed folder writes its checkpoint with the cursor and its outcome', async () => {
    const installed = await finishFirstSessionThenRestart(legacyFullProjection);
    const changed = installed.folders[7];
    installed.rowsByURI.get(changed.folderURI).push({ msgKey: 2, headerMessageId: '7-2@example.com' });
    installed.nativeKeys.add(`account1:${changed.folderPath}:7-2@example.com`);

    const result = await runSecondSession(installed.fts);

    expect(result).toMatchObject({ complete: true });
    const { set, removed } = storageWriteKeys();
    const memoWrites = globalThis.browser.storage.local.set.mock.calls
      .map(([items]) => items[_testExports.FOLDER_RECON_STORAGE_KEY])
      .filter(Boolean);
    expect(memoWrites).toHaveLength(1);
    expect(memoWrites[0].roundRobinCursor).toBeTruthy();
    // The changed outcome is snapshotted once, and completion once more.
    expect(set.filter(key => key === 'fts_folder_recon_last')).toHaveLength(2);
    expect(removed).toEqual([]);
  }, 30_000);
});

describe('reconciliation removal vs a racing re-add', () => {
  const LIVE = 'account1:/F:live@example.com';

  afterEach(() => {
    _testExports._setIsEnabled(false);
    _testExports._getPendingUpdates().clear();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // Two events can share a millisecond: a prior event and the re-add both
  // carry the frozen clock, so only the message-event serial tells them apart.
  it.each([false, true])('keeps a row re-added and drained in the millisecond of an earlier event; re-added=%s', async (readd) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const clockSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      const { rowsByURI, nativeRows, fts, folders } = seedMigratedExactFolders([
        { folderPath: '/F', headerMessageIds: [] },
      ]);
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: '/F',
        headerMessageId: 'prior@example.com', msgKey: 8, eventType: 'msgAdded',
      });
      _testExports._getPendingUpdates().clear();
      nativeRows.set(LIVE, null);
      headerIDToWeID.mockResolvedValue(100);
      globalThis.browser.messages.get = vi.fn(async () => ({
        id: 100, headerMessageId: 'live@example.com', folder: { accountId: 'account1', path: '/F' },
      }));
      buildBatchHeader.mockResolvedValue([{ msgId: LIVE, folderId: folders[0].folderId }]);
      getUniqueMessageKey.mockResolvedValue(LIVE);
      _testExports._setFtsSearch(fts);
      recheckMessageInFolder.mockImplementationOnce(async () => {
        if (readd) {
          // The scoped query missed; the message is re-added and drained
          // (a real event, the real drain) before the removal fence.
          rowsByURI.get(folders[0].folderURI).push({ msgKey: 1, headerMessageId: 'live@example.com' });
          await _testExports.onExperimentMessageAdded({
            accountId: 'account1', folderPath: '/F',
            headerMessageId: 'live@example.com', msgKey: 1, eventType: 'msgAdded',
          });
          await flushPendingUpdates();
          expect(_testExports._getPendingUpdates().has(LIVE)).toBe(false);
        }
        return 'absent';
      });

      await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

      expect(fts.removeBatch.mock.calls.flat(2).includes(LIVE)).toBe(!readd);
      expect(nativeRows.has(LIVE)).toBe(readd);
    } finally {
      clockSpy.mockRestore();
    }
  });

  it('withholds a ghost removal when a message event arrives after classification began', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { rowsByURI, nativeRows, fts, folders } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    const localRows = rowsByURI.get(folders[0].folderURI);
    nativeRows.set(LIVE, null);
    const listPages = [];
    const listState = fts.listFolderMembershipState.getMockImplementation();
    fts.listFolderMembershipState.mockImplementation(async (after, limit) => {
      listPages.push(after);
      return listState(after, limit);
    });
    recheckMessageInFolder.mockImplementationOnce(async () => {
      // The scoped query missed; the message is re-added (a real Thunderbird
      // event) before the removal.
      localRows.push({ msgKey: 1, headerMessageId: 'live@example.com' });
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1',
        folderPath: '/F',
        headerMessageId: 'live@example.com',
        msgKey: 1,
        eventType: 'msgAdded',
      });
      _testExports._getPendingUpdates().clear();
      return 'absent';
    });

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(LIVE);
    expect(nativeRows.get(LIVE)).toBe(folders[0].folderId);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    // The withheld page is read again from the same cursor.
    expect(listPages.slice(0, 2)).toEqual([null, null]);
    expect(_testExports._getFolderReconRuntimeTelemetry().membershipStatePageRetries).toBeGreaterThan(0);
  });

  it('removes the same ghost when no message event intervenes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    nativeRows.set(LIVE, null);
    recheckMessageInFolder.mockResolvedValue('absent');

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    expect(fts.removeBatch.mock.calls.flat(2)).toContain(LIVE);
    expect(nativeRows.has(LIVE)).toBe(false);
  });

  // The per-folder stale direction removes an already-owned row the folder
  // no longer holds. A re-add delivered after its absence verdict queues the
  // message but writes nothing native, so only the event serial can withhold
  // the removal of a row that is live again.
  // A converted event names the folder (its own local change); an
  // unconverted one is a change to every folder.
  const reAddCases = [[false, false], [true, false], [false, true], [true, true]];

  it.each(reAddCases)('withholds an owned stale-row removal when the re-add is delivered first; delivered=%s converted=%s', async (delivered, converted) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, nativeRows, rowsByURI, folders } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    nativeRows.set(LIVE, folders[0].folderId);
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (_uri, ids) => ({
      missing: ids.filter(id => !rowsByURI.get(folders[0].folderURI).some(row => row.headerMessageId === id)),
    }));
    let rechecked = false;
    recheckMessageInFolder.mockImplementationOnce(async () => {
      rechecked = true;
      if (delivered) {
        rowsByURI.get(folders[0].folderURI).push({ msgKey: 1, headerMessageId: 'live@example.com' });
        await _testExports.onExperimentMessageAdded({
          accountId: 'account1', folderPath: '/F',
          ...(converted ? { weFolderId: folders[0].weFolderId } : {}),
          headerMessageId: 'live@example.com', msgKey: 1, eventType: 'msgAdded',
        });
      }
      return 'absent';
    });
    for (let turn = 0; turn < 30 && !rechecked; turn++) {
      try {
        await settleSchedulerTickWithFakeTimers(fts);
      } catch (error) {
        if (!String(error?.message || error).includes('folder_changed_during_scan')) throw error;
      }
      vi.setSystemTime(Date.now() + 1000);
    }
    expect(rechecked).toBe(true);

    expect(fts.removeBatch.mock.calls.flat(2).includes(LIVE)).toBe(!delivered);
    expect(nativeRows.get(LIVE)).toBe(delivered ? folders[0].folderId : undefined);
    expect(_testExports._getPendingUpdates().has(LIVE)).toBe(delivered);

    // The drain consumes the queued add; the folder then certifies with the
    // row kept under its owner, or gone.
    _testExports._getPendingUpdates().clear();
    recheckMessageInFolder.mockResolvedValue('absent');
    const result = await tickUntil(fts, value => value?.complete === true, 60);
    expect(result).toMatchObject({ complete: true });
    expect(_testExports._getFolderReconSessionDone()).toContain('account1:/F');
    expect(nativeRows.get(LIVE)).toBe(delivered ? folders[0].folderId : undefined);
  });

  // The re-add lands after the last absence check, while the removal fence
  // is being acquired: it queues work but moves no native epoch, so only the
  // event serial checked inside the fence withholds the removal.
  it.each(reAddCases)('withholds an owned stale-row removal when the re-add is delivered while the removal fence is acquiring; readd=%s converted=%s', async (readd, converted) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, nativeRows, rowsByURI, folders } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    nativeRows.set(LIVE, folders[0].folderId);
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (_uri, ids) => ({
      missing: ids.filter(id => !rowsByURI.get(folders[0].folderURI).some(row => row.headerMessageId === id)),
    }));
    let rechecked = false;
    let injected = false;
    let eventPromise;
    recheckMessageInFolder.mockImplementationOnce(async () => {
      rechecked = true;
      return 'absent';
    });
    const fakeSetTimeout = globalThis.setTimeout.bind(globalThis);
    const timerSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
      if (rechecked && !injected && delay === _testExports.FOLDER_RECON_ENTRY_DELAY_MS) {
        injected = true;
        return fakeSetTimeout(() => {
          callback(...args);
          // The continuation does its last absence check and starts the real
          // async membership fence before this event microtask is delivered.
          eventPromise = Promise.resolve().then(async () => {
            if (!readd) return;
            rowsByURI.get(folders[0].folderURI).push({ msgKey: 1, headerMessageId: 'live@example.com' });
            await _testExports.onExperimentMessageAdded({
              accountId: 'account1', folderPath: '/F',
              ...(converted ? { weFolderId: folders[0].weFolderId } : {}),
              headerMessageId: 'live@example.com', msgKey: 1, eventType: 'msgAdded',
            });
          });
        }, delay);
      }
      return fakeSetTimeout(callback, delay, ...args);
    });
    try {
      for (let turn = 0; turn < 30 && !injected; turn++) {
        try { await settleSchedulerTickWithFakeTimers(fts); }
        catch (error) {
          if (!String(error?.message || error).includes('folder_changed_during_scan')) throw error;
        }
        vi.setSystemTime(Date.now() + 1000);
      }
      await eventPromise;
      expect(rechecked).toBe(true);
      expect(injected).toBe(true);
      expect(rowsByURI.get(folders[0].folderURI).some(row => row.headerMessageId === 'live@example.com')).toBe(readd);
      expect(_testExports._getPendingUpdates().has(LIVE)).toBe(readd);
      expect(nativeRows.get(LIVE)).toBe(readd ? folders[0].folderId : undefined);
      expect(fts.removeBatch.mock.calls.flat(2).includes(LIVE)).toBe(!readd);
    } finally {
      timerSpy.mockRestore();
    }
  });

  function startDrain(indexed) {
    _testExports._getPendingUpdates().set(LIVE, {
      type: 'new', uniqueKey: LIVE, timestamp: Date.now(),
      folderKey: 'account1:/F', hasFailed: false, lastFailedAt: 0, metadata: {},
    });
    headerIDToWeID.mockImplementation(async () => 100);
    globalThis.browser.messages = {
      get: vi.fn(async weId => ({
        id: weId,
        headerMessageId: 'live@example.com',
        folder: { accountId: 'account1', path: '/F' },
      })),
    };
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: `account1:/F:${header.headerMessageId}`,
    })));
    getUniqueMessageKey.mockImplementation(async header => `account1:/F:${header.headerMessageId}`);
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    const fts = {
      filterNewMessages: vi.fn(async rows => ({
        newMsgIds: rows.map(row => row.msgId).filter(msgId => !indexed.has(msgId)),
      })),
      getMessageByMsgId: vi.fn(async msgId => (indexed.has(msgId) ? { msgId } : null)),
      indexBatch: vi.fn(async rows => {
        for (const row of rows) indexed.add(row.msgId);
        return { count: rows.length };
      }),
      stats: vi.fn(async () => ({})),
    };
    _testExports._setFtsSearch(fts);
    return { fts, drained: flushPendingUpdates() };
  }

  it('re-indexes a re-add whose drain overlaps an in-flight removal of the old row', async () => {
    const indexed = new Set([LIVE]);
    const removalMayCommit = deferred();
    const removal = runFtsMembershipMutation(async () => {
      await removalMayCommit.promise;
      indexed.delete(LIVE);
      return { count: 1 };
    });

    const { fts, drained } = startDrain(indexed);
    await yieldToRealEventLoop();
    // The "already indexed?" read waits for the removal instead of seeing the
    // row it is about to delete.
    expect(fts.filterNewMessages).not.toHaveBeenCalled();
    removalMayCommit.resolve();
    await removal;
    await drained;

    expect(fts.indexBatch).toHaveBeenCalledOnce();
    expect(indexed.has(LIVE)).toBe(true);
    expect(populateBatchBody).toHaveBeenCalledOnce();
    expect(_testExports._getPendingUpdates().size).toBe(0);
  });

  it('consumes an already-indexed add without a body fetch when no removal is in flight', async () => {
    const indexed = new Set([LIVE]);

    const { fts, drained } = startDrain(indexed);
    await drained;

    expect(fts.filterNewMessages).toHaveBeenCalledOnce();
    expect(fts.indexBatch).not.toHaveBeenCalled();
    expect(populateBatchBody).not.toHaveBeenCalled();
    expect(indexed.has(LIVE)).toBe(true);
    expect(_testExports._getPendingUpdates().size).toBe(0);
  });
});


describe('drain removal never deletes a sibling key on a scoped negative', () => {
  const STALE_EVENT_KEY = 'account1:/Old:moved@example.com';
  const SIBLING = 'account1:/Sib:moved@example.com';

  afterEach(() => {
    _testExports._setIsEnabled(false);
    _testExports._getPendingUpdates().clear();
  });

  function drainDelete(indexed) {
    _testExports._getPendingUpdates().set(STALE_EVENT_KEY, {
      type: 'deleted', uniqueKey: STALE_EVENT_KEY, timestamp: Date.now(),
      folderKey: 'account1:/Old', hasFailed: false, lastFailedAt: 0, metadata: {},
    });
    globalThis.browser.folders = {
      query: vi.fn(async () => [
        { id: 'f-old', accountId: 'account1', path: '/Old' },
        { id: 'f-sib', accountId: 'account1', path: '/Sib' },
      ]),
    };
    // A folder-scoped query can miss a message that is present (ADR-017).
    globalThis.browser.messages = { query: vi.fn(async () => ({ messages: [] })) };
    const fts = {
      removeBatch: vi.fn(async ids => {
        let count = 0;
        for (const id of ids) if (indexed.delete(id)) count++;
        return { count };
      }),
      getMessageByMsgId: vi.fn(async msgId => (indexed.has(msgId) ? { msgId } : null)),
      // The removed sibling-key fallback searched this; keeping it lets the
      // test fail on code that still deletes a sibling on a scoped negative.
      findByHeaderMessageId: vi.fn(async () => [...indexed]),
      stats: vi.fn(async () => ({})),
    };
    _testExports._setFtsSearch(fts);
    return { fts, drained: flushPendingUpdates() };
  }

  it('keeps the sibling row and consumes the event when the event key is not indexed', async () => {
    const indexed = new Set([SIBLING]);
    const { fts, drained } = drainDelete(indexed);
    await drained;

    expect(indexed.has(SIBLING)).toBe(true);
    expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(SIBLING);
    expect(globalThis.browser.messages.query).not.toHaveBeenCalled();
    expect(_testExports._getPendingUpdates().size).toBe(0);
  });

  it('control: removes the event key itself and verifies it', async () => {
    const indexed = new Set([STALE_EVENT_KEY, SIBLING]);
    const { fts, drained } = drainDelete(indexed);
    await drained;

    expect(indexed.has(STALE_EVENT_KEY)).toBe(false);
    expect(indexed.has(SIBLING)).toBe(true);
    expect(fts.getMessageByMsgId).toHaveBeenCalledWith(STALE_EVENT_KEY);
    expect(_testExports._getPendingUpdates().size).toBe(0);
  });
});

describe('startup walk, walk obligations and rolling re-walk (exact mode)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  const walkPeriodMs = reconConfig.walkPeriodMs;
  const intervalMs = reconConfig.reverifyIntervalMs;
  const A1 = 'account1:/A:a-1@example.com';
  const A2 = 'account1:/A:a-2@example.com';
  const A3 = 'account1:/A:a-3@example.com';
  const B2 = 'account1:/B:b-2@example.com';

  // Stable-UID IMAP folders with a msgDB incarnation token the experiment
  // creates on the first ensureIncarnationToken read.
  function installTokenFolders(folderSpecs) {
    const installed = seedMigratedExactFolders(folderSpecs);
    const tokens = new Map();
    installed.folders.forEach(folder => {
      Object.assign(folder, { serverType: 'imap', stableUidKeys: true, uidValidity: 7 });
    });
    const stateFor = (accountId, folderPath, options) => {
      const folder = installed.folders.find(item =>
        item.accountId === accountId && item.folderPath === folderPath);
      if (!folder) return { accountId, folderPath, error: 'folder_not_found' };
      if (!tokens.has(folder.folderURI) && options?.ensureIncarnationToken === true) {
        tokens.set(folder.folderURI, `incarnation-${folder.folderURI}-${tokens.size}`);
      }
      return { ...folder, incarnationToken: tokens.get(folder.folderURI) || '' };
    };
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (...args) => stateFor(...args));
    // The msgDB hash probe reflects the folder's current headers.
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (folderURI, ids) => {
      const present = new Set((installed.rowsByURI.get(folderURI) || []).map(row => row.headerMessageId));
      return { missing: ids.filter(id => !present.has(id)) };
    });
    return { ...installed, tokens };
  }

  async function finishSession(fts, maxTicks = 60) {
    const result = await tickUntil(fts, value => value?.complete === true, maxTicks);
    expect(result).toMatchObject({ complete: true });
    return result;
  }

  function restartSession() {
    _testExports._resetFolderReconState();
    _testExports._setIsEnabled(true);
    vi.clearAllTimers();
    for (const mock of [
      globalThis.browser.storage.local.set,
      globalThis.browser.storage.local.remove,
      globalThis.browser.tmMsgNotify.beginFolderMessageScan,
      globalThis.browser.tmMsgNotify.getFolderState,
    ]) mock.mockClear();
  }

  function clearNativeCalls(fts) {
    for (const name of ['listFolderMembership', 'fingerprintMsgIdRange', 'listMsgIdRange']) fts[name].mockClear();
  }

  // Runs passes to completion; the drain indexes what they queue (into the
  // folder under test) before the next pass.
  async function settleWithDrain(fts, nativeRows, folderId, advanceMs) {
    for (let turn = 0; turn < 12; turn++) {
      vi.setSystemTime(Date.now() + advanceMs);
      const result = await tickUntil(fts, value => value?.complete === true
        || _testExports._getPendingUpdates().size > 0, 60);
      if (result?.complete === true && _testExports._getPendingUpdates().size === 0) return;
      for (const key of _testExports._getPendingUpdates().keys()) nativeRows.set(key, folderId);
      _testExports._getPendingUpdates().clear();
    }
  }

  const memoFor = folderKey => storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders[folderKey];
  const nextWalkDue = folderKey => _testExports._getFolderReconNextWalkDueMs().get(folderKey);
  const rollingDue = () => _testExports._getFolderReconRollingDueMs();
  const queued = key => _testExports._getPendingUpdates().has(key);
  // A completed tick: the orphan tail completes only through its quiet
  // predicate, so this is a settled session.
  const settled = value => value?.complete === true;
  const specs = [
    { folderPath: '/A', headerMessageIds: ['a-1@example.com', 'a-2@example.com'] },
    { folderPath: '/B', headerMessageIds: ['b-1@example.com', 'b-2@example.com'] },
  ];

  // Moves the clock to `atMs` (never backwards) and runs ticks until the
  // session is settled or `until` holds.
  async function runAt(fts, atMs, until = () => false, maxTicks = 60) {
    vi.setSystemTime(Math.max(Date.now(), atMs));
    return tickUntil(fts, value => until(value) || settled(value), maxTicks);
  }

  // Runs passes until settled; the drain indexes what they queue into the
  // folder the key names.
  async function settleAllWithDrain(fts, nativeRows, folders, advanceMs = 30 * 60_000) {
    for (let turn = 0; turn < 48; turn++) {
      const result = await runAt(fts, Date.now() + advanceMs, () => _testExports._getPendingUpdates().size > 0);
      if (settled(result) && _testExports._getPendingUpdates().size === 0) return true;
      for (const key of _testExports._getPendingUpdates().keys()) {
        const folder = folders.find(item => key.startsWith(`account1:${item.folderPath}:`));
        nativeRows.set(key, folder.folderId);
      }
      _testExports._getPendingUpdates().clear();
    }
    return false;
  }

  // Runs rolling ticks from `fromMs` until `done` holds or `deadlineMs`
  // passes: a due folder may wait behind earlier-due admissions.
  async function rollUntil(fts, fromMs, done, deadlineMs) {
    await runAt(fts, Math.max(fromMs, rollingDue()), done);
    while (!done() && Date.now() < deadlineMs) await runAt(fts, rollingDue(), done);
    return done();
  }

  // Runs one tick as the scheduler timer does, which retries a tick that a
  // message event voided.
  async function timerTick(fts) {
    try {
      return await settleSchedulerTickWithFakeTimers(fts);
    } catch (error) {
      if (!String(error?.message || error).includes('folder_changed_during_scan')) throw error;
      return { voidedByEvent: true };
    } finally {
      vi.setSystemTime(Date.now() + 100);
    }
  }

  // The real producer of a walk obligation for dropped work.
  async function abandonQueuedUpdate(folderKey, uniqueKey = `${folderKey || 'account1:/A'}:dropped@example.com`) {
    const update = { uniqueKey, type: 'new', timestamp: Date.now(), folderKey };
    _testExports._getPendingUpdates().set(update.uniqueKey, update);
    expect((await _testExports._abandonPendingUpdates([update], 'queue_stuck')).dropped).toBe(1);
  }

  describe('startup walk', () => {
    it('walks every folder on every startup and certifies an unchanged one with zero storage writes', async () => {
      const { fts, folders } = installTokenFolders(specs);
      await finishSession(fts);
      expect(memoFor('account1:/A')).toMatchObject({ verified: true, incarnationToken: expect.any(String) });

      for (let startup = 0; startup < 2; startup++) {
        restartSession();
        clearNativeCalls(fts);
        await finishSession(fts);

        const scans = globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls;
        expect(new Set(scans.map(([uri]) => uri))).toEqual(new Set(folders.map(folder => folder.folderURI)));
        expect(scans.every(([, full]) => full === false)).toBe(true);
        for (const folder of folders) {
          expect(fts.listFolderMembership.mock.calls.some(([folderId]) => folderId === folder.folderId)).toBe(true);
        }
        expect(globalThis.browser.messages.query).not.toHaveBeenCalled();
        expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
        expect(globalThis.browser.storage.local.remove).not.toHaveBeenCalled();
        expect(_testExports._getPendingUpdates().size).toBe(0);
        expect(await sessionSettled()).toBe(true);
        expect(_testExports._getFolderReconSessionDone()).toEqual(new Set(['account1:/A', 'account1:/B']));
      }
    });

    it('upgrades a tokenless checkpoint through one full projection, then takes the UID tier', async () => {
      const { fts } = installTokenFolders(specs);
      await finishSession(fts);
      // A checkpoint stored by 1.8.4, PR 1 or PR 2 carries no incarnation token.
      for (const checkpoint of Object.values(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders)) {
        delete checkpoint.incarnationToken;
      }

      restartSession();
      await finishSession(fts);
      const fullScans = globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls;
      expect(fullScans.length).toBeGreaterThanOrEqual(2);
      expect(fullScans.every(([, full]) => full === true)).toBe(true);
      expect(memoFor('account1:/A')).toMatchObject({ verified: true, incarnationToken: expect.any(String) });

      restartSession();
      await finishSession(fts);
      const scans = globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls;
      expect(scans.length).toBeGreaterThanOrEqual(2);
      expect(scans.every(([, full]) => full === false)).toBe(true);
    });

    // No stored field certifies a folder at startup: whatever a checkpoint
    // carries, the startup walk enumerates and repairs.
    it.each([
      ['a current', () => {}],
      ['a tokenless', checkpoint => { delete checkpoint.incarnationToken; }],
      ['an obsolete gate-field', checkpoint => Object.assign(checkpoint, {
        numMessages: 2, rangeCount: 2, rangeSha256: 'obsolete', highestModSeq: '100',
      })],
    ])('repairs a native removal made while Thunderbird was closed (%s checkpoint)', async (_name, shape) => {
      const { fts, nativeRows } = installTokenFolders(specs);
      await finishSession(fts);
      for (const checkpoint of Object.values(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders)) shape(checkpoint);
      nativeRows.delete(A2);

      restartSession();
      await tickUntil(fts, value => value?.complete === true || queued(A2), 60);

      expect(queued(A2)).toBe(true);
      expect(quietNow()).toBe(false);
    });

    // CONDSTORE on: Thunderbird stores HIGHESTMODSEQ at SELECT, before it
    // applies the downloaded headers, so a count-preserving expunge plus a
    // header applied later leaves the stored modseq and count unchanged.
    describe('a count-preserving swap the stored HIGHESTMODSEQ never saw', () => {
      // /A loses a-2 and gains a-3: same count, same msgDB.
      function swapA(rowsByURI, folders) {
        const uriA = folders[0].folderURI;
        const rows = rowsByURI.get(uriA);
        rowsByURI.set(uriA, [rows[0], { ...rows[1], msgKey: 3, headerMessageId: 'a-3@example.com' }]);
      }

      it.each([false, true])('is repaired by the next startup after a restart that missed both events; swapped=%s', async (swapped) => {
        const { fts, rowsByURI, nativeRows, folders } = installTokenFolders(specs);
        await finishSession(fts);
        if (swapped) swapA(rowsByURI, folders);

        restartSession();
        await settleWithDrain(fts, nativeRows, folders[0].folderId, 60 * 60_000);

        expect(nativeRows.has(A2)).toBe(!swapped);
        expect(nativeRows.has(A3)).toBe(swapped);
        expect(nativeRows.has(A1)).toBe(true);
        expect(await sessionSettled()).toBe(true);
      });

      it.each([false, true])('is repaired in-session after a queue-stuck abandonment dropped both events; swapped=%s', async (swapped) => {
        const { fts, rowsByURI, nativeRows, folders } = installTokenFolders(specs);
        await finishSession(fts);
        if (swapped) swapA(rowsByURI, folders);
        const now = Date.now();
        _testExports._getPendingUpdates().set(A3, { uniqueKey: A3, type: 'new', timestamp: now, folderKey: 'account1:/A' });
        _testExports._getPendingUpdates().set(A2, { uniqueKey: A2, type: 'deleted', timestamp: now, folderKey: 'account1:/A' });
        expect((await abandonAllQueued()).dropped).toBe(2);
        expect(_testExports._getPendingUpdates().size).toBe(0);
        expect(_testExports._getFolderReconDirty()).toContain('account1:/A');

        await settleWithDrain(fts, nativeRows, folders[0].folderId, 10 * 60_000);

        expect(nativeRows.has(A2)).toBe(!swapped);
        expect(nativeRows.has(A3)).toBe(swapped);
        expect(await sessionSettled()).toBe(true);
      });
    });
  });

  describe('membership safety of the UID tier and the full projection', () => {
    // cleanupIncomplete: an undecidable ownerless row keeps global cleanup
    // incomplete, so the UID tier runs before cleanup (PR 3b §3.2).
    it.each([false, true])('never certifies a msgDB replaced during a UID-tier scan; cleanupIncomplete=%s', async (cleanupIncomplete) => {
      const { fts, folders, tokens, rowsByURI, nativeRows } = installTokenFolders([specs[0]]);
      await finishSession(fts);
      if (cleanupIncomplete) {
        nativeRows.set('account1:/A:zz-undecidable@example.com', null);
        const recheck = recheckMessageInFolder.getMockImplementation();
        recheckMessageInFolder.mockImplementation(async (headerId, ...rest) =>
          (headerId === 'zz-undecidable@example.com' ? 'error' : recheck(headerId, ...rest)));
      }
      const uri = folders[0].folderURI;
      const newKey = 'account1:/A:replacement@example.com';
      const scan = globalThis.browser.tmMsgNotify.beginFolderMessageScan.getMockImplementation();
      let replaced = false;
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async (...args) => {
        if (!replaced && args[0] === uri && args[1] === false) {
          // Same UIDs, another msgDB: only the incarnation token differs.
          replaced = true;
          tokens.set(uri, 'replacement-incarnation');
          rowsByURI.get(uri)[0].headerMessageId = 'replacement@example.com';
        }
        return scan(...args);
      });
      restartSession();
      const result = await tickUntil(fts, value => value?.complete === true || queued(newKey), 60);
      expect(replaced).toBe(true);
      expect(nativeRows.has(newKey) || queued(newKey)).toBe(true);
      expect(result?.complete === true && nativeRows.has(A1)).toBe(false);
      if (cleanupIncomplete) expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    });

    // The UID-only tier certifies a stored Message-ID projection only while
    // the UID namespace it was hashed in still backs the folder: a
    // UIDVALIDITY reset under the same incarnation token, seen at its
    // awaited closing read, must not certify the old projection.
    it.each([false, true])('repairs a UIDVALIDITY reset seen at the UID tier\'s closing read; reset=%s', async (reset) => {
      const { fts, folders, rowsByURI, nativeRows } = installTokenFolders(specs);
      await finishSession(fts);
      const uri = folders[0].folderURI;
      const newKey = 'account1:/A:reset-uid@example.com';
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      let closed = false;
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        // The first plain read of /A this session is the UID tier's closing read.
        if (!closed && folderPath === '/A' && options === undefined) {
          closed = true;
          if (reset) {
            folders[0].uidValidity = 8;
            rowsByURI.get(uri)[0].headerMessageId = 'reset-uid@example.com';
          }
        }
        return state(accountId, folderPath, options);
      });
      restartSession();
      const result = await tickUntil(fts, value => settled(value) || queued(newKey), 60);
      expect(closed).toBe(true);
      expect(settled(result)).toBe(!reset);
      expect(queued(newKey)).toBe(reset);
      // The attempt whose closing read saw the reset certified nothing.
      expect(_testExports._getFolderReconSessionDone().has('account1:/A')).toBe(!reset);

      expect(await settleAllWithDrain(fts, nativeRows, folders)).toBe(true);
      expect(Object.fromEntries(nativeRows)).toEqual({
        ...(reset ? { [newKey]: folders[0].folderId } : { [A1]: folders[0].folderId }),
        [A2]: folders[0].folderId,
        'account1:/B:b-1@example.com': folders[1].folderId,
        [B2]: folders[1].folderId,
      });
      expect(_testExports._getPendingUpdates().size).toBe(0);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set(['account1:/A', 'account1:/B']));
      expect(await sessionSettled()).toBe(true);
    });

    it.each([false, true])('never certifies a yielded attempt across a new generation; removed meanwhile=%s', async (removed) => {
      const { fts, nativeRows } = installTokenFolders([specs[0]]);
      await finishSession(fts);
      restartSession();
      const yielded = await tickUntil(fts, value => value?.reason === 'membership_page' || value?.complete === true, 60);
      expect(yielded.reason).toBe('membership_page');
      if (removed) nativeRows.delete(A1);
      restartSession();
      await tickUntil(fts, value => value?.complete === true || queued(A1), 60);
      expect(nativeRows.has(A1) || queued(A1)).toBe(true);
      expect(queued(A1)).toBe(removed);
      expect(nativeRows.has(A2)).toBe(true);
    });

    it('re-projects a folder whose msgDB was swapped with identical UIDs while inactive', async () => {
      const { fts, rowsByURI, nativeRows, folders, tokens } = installTokenFolders(specs);
      await finishSession(fts);

      // Rename swap while Thunderbird was closed: /A now holds the database
      // that was /B's (same UIDs, UIDVALIDITY and count) and the other way
      // round. Only the incarnation tokens tell them apart.
      const [uriA, uriB] = folders.map(folder => folder.folderURI);
      const rowsA = rowsByURI.get(uriA);
      rowsByURI.set(uriA, rowsByURI.get(uriB));
      rowsByURI.set(uriB, rowsA);
      const tokenA = tokens.get(uriA);
      tokens.set(uriA, tokens.get(uriB));
      tokens.set(uriB, tokenA);

      restartSession();
      for (let turn = 0; turn < 12; turn++) {
        const result = await tickUntil(fts, value => value?.complete === true
          || _testExports._getPendingUpdates().size > 0, 60);
        if (result?.complete === true && _testExports._getPendingUpdates().size === 0) break;
        // The missing rows are indexed by the drain; model its native write.
        for (const key of _testExports._getPendingUpdates().keys()) {
          const folder = folders.find(item => key.startsWith(`account1:${item.folderPath}:`));
          nativeRows.set(key, folder.folderId);
        }
        _testExports._getPendingUpdates().clear();
        vi.setSystemTime(Date.now() + 60 * 60_000);
      }

      expect(nativeRows.has('account1:/A:b-1@example.com')).toBe(true);
      expect(nativeRows.has(A1)).toBe(false);
      expect(nativeRows.has('account1:/B:a-1@example.com')).toBe(true);
      expect(nativeRows.has('account1:/B:b-1@example.com')).toBe(false);
    });

    // Token creation can fail (the experiment then reports ""): a folder
    // without a token never takes the UID tier, so a msgDB swap with
    // identical UIDs is still re-projected.
    it('re-projects a swapped msgDB when every incarnation token is empty', async () => {
      const { fts, rowsByURI, nativeRows, folders } = installTokenFolders(specs);
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (...args) => ({
        ...(await state(...args)),
        incarnationToken: '',
      }));
      await finishSession(fts);
      expect(memoFor('account1:/A')).toMatchObject({ verified: true });
      const [uriA, uriB] = folders.map(folder => folder.folderURI);
      const rowsA = rowsByURI.get(uriA);
      rowsByURI.set(uriA, rowsByURI.get(uriB));
      rowsByURI.set(uriB, rowsA);

      restartSession();
      for (let turn = 0; turn < 12; turn++) {
        const result = await tickUntil(fts, value => value?.complete === true
          || _testExports._getPendingUpdates().size > 0, 60);
        if (result?.complete === true && _testExports._getPendingUpdates().size === 0) break;
        for (const key of _testExports._getPendingUpdates().keys()) {
          const folder = folders.find(item => key.startsWith(`account1:${item.folderPath}:`));
          nativeRows.set(key, folder.folderId);
        }
        _testExports._getPendingUpdates().clear();
        vi.setSystemTime(Date.now() + 60 * 60_000);
      }

      expect(nativeRows.has('account1:/A:b-1@example.com')).toBe(true);
      expect(nativeRows.has(A1)).toBe(false);
    });

    // A message re-added between the attempt's opening read and its scan is
    // certified with the native row a pending repair left behind. When it
    // later leaves without an event, the next startup walk must drop the
    // stale row.
    it.each([false, true])('repairs a missed removal of a message re-added between the opening read and the scan; removed=%s', async (removed) => {
      const { fts, rowsByURI, nativeRows, folders } = installTokenFolders(specs);
      await finishSession(fts);
      const uriA = folders[0].folderURI;
      const staleKey = 'account1:/A:x@example.com';
      nativeRows.set(staleKey, folders[0].folderId);
      // A tokenless checkpoint: this session fully projects /A.
      delete memoFor('account1:/A').incarnationToken;

      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      let readded = false;
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        const result = await state(accountId, folderPath, options);
        if (!readded && folderPath === '/A' && options?.ensureIncarnationToken === true) {
          readded = true;
          rowsByURI.set(uriA, [...rowsByURI.get(uriA), { msgKey: 3, headerMessageId: 'x@example.com' }]);
        }
        return result;
      });
      restartSession();
      await finishSession(fts);
      expect(readded).toBe(true);
      expect(memoFor('account1:/A')).toMatchObject({ verified: true, expectedCount: 3 });

      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(state);
      if (removed) rowsByURI.set(uriA, rowsByURI.get(uriA).filter(row => row.headerMessageId !== 'x@example.com'));
      restartSession();
      await settleWithDrain(fts, nativeRows, folders[0].folderId, 60 * 60_000);

      expect(nativeRows.has(staleKey)).toBe(!removed);
      expect(nativeRows.has(A1)).toBe(true);
    });

    it('never certifies the opening incarnation when the msgDB is replaced before the closing read', async () => {
      const { fts, folders, tokens } = installTokenFolders(specs);
      const uriA = folders[0].folderURI;
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      let replaced = false;
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        if (!replaced && folderPath === '/A' && options === undefined) {
          // The closing read (the only read without options) sees a different
          // database incarnation than the inventory read that opened the proof.
          replaced = true;
          tokens.set(uriA, 'replacement-incarnation');
        }
        return state(accountId, folderPath, options);
      });

      await finishSession(fts);
      expect(replaced).toBe(true);
      const persistedA = globalThis.browser.storage.local.set.mock.calls
        .map(([value]) => value[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders?.['account1:/A'])
        .filter(checkpoint => checkpoint?.verified === true);
      expect(persistedA.length).toBeGreaterThan(0);
      expect(persistedA.every(checkpoint => checkpoint.incarnationToken === 'replacement-incarnation')).toBe(true);
      expect(memoFor('account1:/A')).toMatchObject({
        verified: true,
        incarnationToken: 'replacement-incarnation',
      });
    });

    it('errors a UID-tier hit whose closing read shows another msgDB, then re-projects it in the same pass', async () => {
      const { fts, folders, tokens } = installTokenFolders(specs);
      await finishSession(fts);
      const uriA = folders[0].folderURI;
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      let replaced = false;
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        if (!replaced && folderPath === '/A' && options === undefined) {
          replaced = true;
          tokens.set(uriA, 'replacement-incarnation');
        }
        return state(accountId, folderPath, options);
      });

      restartSession();
      await finishSession(fts);
      expect(replaced).toBe(true);
      const scansOfA = globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls
        .filter(([uri]) => uri === uriA).map(([, full]) => full);
      expect(scansOfA[0]).toBe(false);
      expect(scansOfA).toContain(true);
      expect(memoFor('account1:/A')).toMatchObject({ verified: true, incarnationToken: 'replacement-incarnation' });
    });

    // A timed-out native removal of `lateKey` that commits physically during
    // the closing read: after the certifying proof, with no membership epoch
    // change and no later source event (owner-blessed: the next walk repairs).
    function commitRemovalAtClosingRead(nativeRows, folderPath, lateKey) {
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      const late = { committed: false };
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, path, options) => {
        if (!late.committed && path === folderPath && options === undefined) {
          late.committed = true;
          nativeRows.delete(lateKey);
        }
        return state(accountId, path, options);
      });
      return late;
    }

    async function expectRepairedNextSession(fts, lateKey) {
      restartSession();
      await tickUntil(fts, value => value?.complete === true || queued(lateKey), 60);
      expect(queued(lateKey)).toBe(true);
    }

    it.each([
      ['a full projection of /F', false, [{ folderPath: '/F', headerMessageIds: ['f-1@example.com', 'f-2@example.com'] }]],
      ['a full projection of /F beside /F:Child', false, [
        { folderPath: '/F', headerMessageIds: ['f-1@example.com', 'f-2@example.com'] },
        { folderPath: '/F:Child', headerMessageIds: ['c-1@example.com'] },
      ]],
      ['a UID-tier walk of /F', true, [{ folderPath: '/F', headerMessageIds: ['f-1@example.com', 'f-2@example.com'] }]],
    ])('repairs a native removal committed at the closing read of %s on the next startup', async (_name, uidTier, folderSpecs) => {
      const { fts, nativeRows } = installTokenFolders(folderSpecs);
      if (uidTier) {
        await finishSession(fts);
        restartSession();
      }
      const lateKey = 'account1:/F:f-2@example.com';
      const late = commitRemovalAtClosingRead(nativeRows, '/F', lateKey);
      await finishSession(fts);
      expect(late.committed).toBe(true);
      expect(nativeRows.has(lateKey)).toBe(false);
      expect(memoFor('account1:/F')).toMatchObject({ verified: true });
      if (uidTier) {
        expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.every(([, full]) => full === false)).toBe(true);
      }

      await expectRepairedNextSession(fts, lateKey);
    });

    // /A gains a-3, which vanishes from the msgDB while the missing direction
    // looks it up: nothing is queued and the fresh local scan equals the
    // initial native digest, so the attempt verifies at its terminal check.
    function addRowThatVanishesDuringRepair(rowsByURI, folders) {
      const uriA = folders[0].folderURI;
      rowsByURI.get(uriA).push({ msgKey: 3, headerMessageId: 'a-3@example.com' });
      const infos = globalThis.browser.tmMsgNotify.getMessageInfosForKeys.getMockImplementation();
      const vanish = { done: false };
      globalThis.browser.tmMsgNotify.getMessageInfosForKeys.mockImplementation(async (uri, keys) => {
        if (!vanish.done && uri === uriA) {
          vanish.done = true;
          rowsByURI.set(uriA, rowsByURI.get(uriA).filter(row => row.headerMessageId !== 'a-3@example.com'));
        }
        return infos(uri, keys);
      });
      return vanish;
    }

    it('earns the incarnation token at the terminal check of a repair attempt', async () => {
      const { fts, rowsByURI, folders, tokens } = installTokenFolders(specs);
      await finishSession(fts);
      const vanish = addRowThatVanishesDuringRepair(rowsByURI, folders);

      restartSession();
      const repaired = await tickUntil(fts, value => value?.foldersReconciled > 0 || value?.complete === true, 60);
      expect(vanish.done).toBe(true);
      expect(repaired.foldersReconciled).toBe(1);
      expect(memoFor('account1:/A')).toMatchObject({ verified: true, incarnationToken: tokens.get(folders[0].folderURI) });
    });

    it('never certifies the opening incarnation at the terminal check when the msgDB was replaced', async () => {
      const { fts, rowsByURI, folders, tokens } = installTokenFolders(specs);
      await finishSession(fts);
      const vanish = addRowThatVanishesDuringRepair(rowsByURI, folders);
      const uriA = folders[0].folderURI;
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      let replaced = false;
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        if (vanish.done && !replaced && folderPath === '/A' && options === undefined) {
          replaced = true;
          tokens.set(uriA, 'replacement-incarnation');
        }
        return state(accountId, folderPath, options);
      });

      restartSession();
      const drifted = await tickUntil(fts, () => replaced, 60);
      expect(drifted.foldersReconciled).toBe(0);
      expect(drifted.foldersLocalDrift).toBe(1);
      expect(memoFor('account1:/A').verified).not.toBe(true);
      await finishSession(fts);
      const persistedA = globalThis.browser.storage.local.set.mock.calls
        .map(([value]) => value[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders?.['account1:/A'])
        .filter(checkpoint => checkpoint?.verified === true);
      expect(persistedA.length).toBeGreaterThan(0);
      expect(persistedA.every(checkpoint => checkpoint.incarnationToken === 'replacement-incarnation')).toBe(true);
    });

    describe('each identity or epoch condition, alone, keeps a changed folder from being certified', () => {
      // A row in /A's native membership that /A's msgDB does not hold.
      const STRAY = 'account1:/A:a-0@example.com';

      // Runs `change` once, at /A's closing read (the only read without options).
      function atClosingRead(change) {
        const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
        const hook = { ran: false };
        globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
          if (!hook.ran && folderPath === '/A' && options === undefined) {
            hook.ran = true;
            await change();
          }
          return state(accountId, folderPath, options);
        });
        return hook;
      }

      it('the native digest: an equal-count native change is repaired at the next startup', async () => {
        const { fts, nativeRows, folders } = installTokenFolders(specs);
        await finishSession(fts);
        nativeRows.delete(A2);
        nativeRows.set(STRAY, folders[0].folderId);

        restartSession();
        await settleWithDrain(fts, nativeRows, folders[0].folderId, 60 * 60_000);

        expect(nativeRows.has(A2)).toBe(true);
        expect(nativeRows.has(STRAY)).toBe(false);
      });

      it('a native write between the local scan and the proof never certifies a state the proof did not read', async () => {
        const { fts, nativeRows, folders } = installTokenFolders(specs);
        await finishSession(fts);
        // A late native commit adds a stray row to /A's membership.
        nativeRows.set(STRAY, folders[0].folderId);
        // After /A's full local scan, before its proof, the stray row is
        // removed under a membership write.
        const readPage = globalThis.browser.tmMsgNotify.readFolderMessageScanPage.getMockImplementation();
        let removed = false;
        globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async (token, limit) => {
          const page = await readPage(token, limit);
          if (!removed && page.done && page.rows.some(row => row.headerMessageId.startsWith('a-'))
              && globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.at(-1)?.[1] === true) {
            removed = true;
            await runFtsMembershipMutation(async () => { nativeRows.delete(STRAY); });
          }
          return page;
        });
        restartSession();
        await finishSession(fts);
        expect(removed).toBe(true);
        expect(memoFor('account1:/A').verified).toBe(true);
        // Another late commit restores exactly the state before the proof.
        nativeRows.set(STRAY, folders[0].folderId);

        restartSession();
        await settleWithDrain(fts, nativeRows, folders[0].folderId, 60 * 60_000);

        expect(nativeRows.has(STRAY)).toBe(false);
      });

      it('UIDVALIDITY: a changed UIDVALIDITY under the same incarnation token takes the full projection', async () => {
        const { fts, folders } = installTokenFolders(specs);
        await finishSession(fts);
        folders[0].uidValidity = 8;

        restartSession();
        await finishSession(fts);

        expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls)
          .toContainEqual([folders[0].folderURI, true]);
        expect(memoFor('account1:/A')).toMatchObject({ verified: true, uidValidity: 8 });
      });

      it('the closing epoch: a native removal at the UID tier\'s closing read is repaired in the same pass', async () => {
        const { fts, nativeRows } = installTokenFolders(specs);
        await finishSession(fts);
        const hook = atClosingRead(() => runFtsMembershipMutation(async () => { nativeRows.delete(A2); }));

        restartSession();
        await tickUntil(fts, value => value?.complete === true || queued(A2), 60);
        expect(queued(A2)).toBe(true);
        expect(hook.ran).toBe(true);
        expect(nativeRows.has(A1)).toBe(true);
      });

      // Owner-blessed residual: an in-session msgDB change no event announces
      // is repaired by the folder's next rolling walk.
      it.each([false, true])('an unannounced count-preserving swap at the UID tier\'s closing read is repaired by the rolling walk; swapped=%s', async (swapped) => {
        const { fts, rowsByURI, nativeRows, folders } = installTokenFolders(specs);
        await finishSession(fts);
        const hook = atClosingRead(() => {
          if (!swapped) return;
          const uriA = folders[0].folderURI;
          const rows = rowsByURI.get(uriA);
          rowsByURI.set(uriA, [rows[0], { ...rows[1], msgKey: 3, headerMessageId: 'a-3@example.com' }]);
        });
        restartSession();
        await finishSession(fts);
        expect(hook.ran).toBe(true);

        const due = nextWalkDue('account1:/A');
        expect(await rollUntil(fts, due, () => queued(A3), due + 3 * intervalMs)).toBe(swapped);
        expect(nativeRows.has(A1)).toBe(true);
      });
    });

    // The folder gains a row unannounced that vanishes again while the
    // missing direction looks it up, so the attempt writes nothing and
    // verifies at its terminal check; its stale or missing direction is
    // budget-truncated first.
    it.each([
      ['missing direction', 4, { scans: 1, enqueues: 1 }],
      ['stale direction', reconConfig.stalePageKeys + 2, null],
    ])('repairs a late removal during a budget-truncated (%s) attempt\'s yield at the next startup', async (_name, rows, budget) => {
      const ids = Array.from({ length: rows }, (_, index) => `a-${String(index + 1).padStart(4, '0')}@example.com`);
      const { fts, rowsByURI, nativeRows, folders } = installTokenFolders([{ folderPath: '/A', headerMessageIds: ids }]);
      await finishSession(fts);
      const uriA = folders[0].folderURI;
      const vanishingKey = rows + 1;
      rowsByURI.get(uriA).push({ msgKey: vanishingKey, headerMessageId: 'a-vanishing@example.com' });
      const infos = globalThis.browser.tmMsgNotify.getMessageInfosForKeys.getMockImplementation();
      globalThis.browser.tmMsgNotify.getMessageInfosForKeys.mockImplementation(async (uri, keys) => {
        if (keys.includes(vanishingKey)) {
          rowsByURI.set(uriA, rowsByURI.get(uriA).filter(row => row.msgKey !== vanishingKey));
        }
        return infos(uri, keys);
      });
      restartSession();
      if (budget) _testExports._setFolderReconBudgetOverride(budget);
      try {
        const partial = await tickUntil(fts, value => value?.foldersBudgetPartial > 0 || value?.complete === true, 60);
        expect(partial.foldersBudgetPartial).toBe(1);
        // While the attempt waits, a timed-out native removal commits
        // physically: no epoch change, no event.
        const lateKey = `account1:/A:${ids[0]}`;
        nativeRows.delete(lateKey);
        await finishSession(fts);
        expect(memoFor('account1:/A')).toMatchObject({ verified: true, incarnationToken: expect.any(String) });
        _testExports._setFolderReconBudgetOverride(null);

        await expectRepairedNextSession(fts, lateKey);
      } finally {
        _testExports._setFolderReconBudgetOverride(null);
      }
    });

    it('certifies nothing on a failed closing read and certifies on the next pass', async () => {
      const { fts } = installTokenFolders(specs);
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      let failed = false;
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        if (!failed && folderPath === '/A' && options === undefined) {
          failed = true;
          throw new Error('msgDB unavailable');
        }
        return state(accountId, folderPath, options);
      });

      const first = await tickUntil(fts, () => failed, 60);
      expect(first.foldersLocalDrift).toBe(1);
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders?.['account1:/A']).toBeUndefined();
      await finishSession(fts);
      expect(memoFor('account1:/A')).toMatchObject({ verified: true, incarnationToken: expect.any(String) });
    });

    // The incarnation token is identity evidence, earned by the closing read:
    // membership traffic during a projection must never keep a folder on
    // full projections forever.
    it('stores the incarnation token when a membership write lands during a full projection, so the next startup takes the UID tier', async () => {
      const { fts, folders } = installTokenFolders(specs);
      await finishSession(fts);
      for (const checkpoint of Object.values(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders)) {
        delete checkpoint.incarnationToken;
      }
      const list = fts.listFolderMembership.getMockImplementation();
      let wrote = false;
      fts.listFolderMembership.mockImplementation(async (folderId, after, limit) => {
        const page = await list(folderId, after, limit);
        if (!wrote && folderId === folders[0].folderId) {
          wrote = true;
          await runFtsMembershipMutation(async () => ({ count: 1 }));
        }
        return page;
      });

      restartSession();
      await finishSession(fts);
      expect(wrote).toBe(true);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls)
        .toContainEqual([folders[0].folderURI, true]);
      expect(memoFor('account1:/A')).toMatchObject({ verified: true, incarnationToken: expect.any(String) });

      restartSession();
      await finishSession(fts);
      const scansOfA = globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls
        .filter(([uri]) => uri === folders[0].folderURI).map(([, full]) => full);
      expect(scansOfA.length).toBeGreaterThan(0);
      expect(scansOfA.every(full => full === false)).toBe(true);
    });
  });

  describe('UID tier ordering (native digest first)', () => {
    const many = Array.from({ length: 3 * reconConfig.membershipListPageSize }, (_, i) => `m-${String(i).padStart(4, '0')}@example.com`);
    const BIG = 'account1:/Big';

    it('enumerates the UIDs once per successful attempt of a multi-page folder', async () => {
      const { fts, folders } = installTokenFolders([{ folderPath: '/Big', headerMessageIds: many }]);
      await finishSession(fts);
      restartSession();
      clearNativeCalls(fts);

      await finishSession(fts);

      expect(fts.listFolderMembership.mock.calls.length).toBeGreaterThan(1);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls).toEqual([[folders[0].folderURI, false]]);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set([BIG]));
      expect(await sessionSettled()).toBe(true);
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
    });

    const stampMoments = [
      ['after the terminal native page', 'terminal_page'],
      ['during the UID enumeration', 'uid_scan'],
      ['during the closing read', 'closing_read'],
    ];

    // Installs a hook that runs `invalidate` once, at `moment` after the
    // digest's first native page.
    function hookStampMoment(fts, moment, invalidate) {
      const hook = { ran: false };
      const fire = () => {
        if (hook.ran) return;
        hook.ran = true;
        invalidate();
      };
      const list = fts.listFolderMembership.getMockImplementation();
      fts.listFolderMembership.mockImplementation(async (folderId, after, limit) => {
        const page = await list(folderId, after, limit);
        if (moment === 'terminal_page' && page.done) fire();
        return page;
      });
      const readPage = globalThis.browser.tmMsgNotify.readFolderMessageScanPage.getMockImplementation();
      globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async (token, limit) => {
        const page = await readPage(token, limit);
        if (moment === 'uid_scan') fire();
        return page;
      });
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        if (moment === 'closing_read' && options === undefined) fire();
        return state(accountId, folderPath, options);
      });
      return hook;
    }

    // A message event for the folder itself voids the stamp the digest's
    // first native page captured, at each point after that page.
    it.each(stampMoments)('never certifies a UID-tier hit whose native-page stamp was invalidated %s; a fresh attempt does', async (_name, moment) => {
      const { fts, folders } = installTokenFolders([{ folderPath: '/Big', headerMessageIds: many }]);
      await finishSession(fts);
      const invalidate = () => _testExports._invalidateFolderReconProofForEvent('account1', '/Big');
      const hook = hookStampMoment(fts, moment, invalidate);

      restartSession();
      // The invalidated attempt ends without certifying the folder.
      let voided;
      for (let turn = 0; turn < 60; turn++) {
        voided = await timerTick(fts);
        if (hook.ran && voided?.reason !== 'membership_page') break;
      }
      expect(hook.ran).toBe(true);
      expect(voided?.complete === true).toBe(false);
      expect(_testExports._getFolderReconSessionDone().has(BIG)).toBe(false);
      expect(reconWorkOwed()).toBe(true);

      await finishSession(fts);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set([BIG]));
      expect(await sessionSettled()).toBe(true);
      expect(memoFor(BIG)).toMatchObject({ verified: true, incarnationToken: expect.any(String) });
    });

    // Another folder's message event leaves the stamp current: the attempt
    // certifies the folder without restarting.
    it.each(stampMoments)('certifies a UID-tier hit when another folder\'s event lands %s', async (_name, moment) => {
      const { fts, folders } = installTokenFolders([{ folderPath: '/Big', headerMessageIds: many }]);
      await finishSession(fts);
      const hook = hookStampMoment(fts, moment,
        () => _testExports._invalidateFolderReconProofForEvent('account1', '/Elsewhere'));

      restartSession();
      clearNativeCalls(fts);
      await finishSession(fts);

      expect(hook.ran).toBe(true);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls).toEqual([[folders[0].folderURI, false]]);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set([BIG]));
      expect(await sessionSettled()).toBe(true);
    });

    // INVARIANT (2026-10-04): a native write in another folder at any of the
    // cold folder's UID-tier proof boundaries (terminal membership page, UID
    // enumeration, closing identity read) neither invalidates its checkpoint
    // nor forces a rescan.
    it.each(['terminal_page', 'uid_scan', 'closing_read'])('keeps the cold UID proof across another folder\'s native write at %s', async moment => {
      const { fts, folders, nativeRows, rowsByURI } = installTokenFolders([
        { folderPath: '/Big', headerMessageIds: many },
        { folderPath: '/Elsewhere', headerMessageIds: ['seed@example.com'] },
      ]);
      await finishSession(fts);
      const [cold, hot] = folders;
      const hotId = 'native-write@example.com';
      const hotKey = `account1:/Elsewhere:${hotId}`;
      let written = false;
      fakeNativeFts.indexBatch.mockImplementation(async (rows, wire) => {
        if (wire) wire.withFolderIds = true;
        for (const row of rows) nativeRows.set(row.msgId, row.folderId);
        return { count: rows.length };
      });
      const write = async () => {
        if (written) return;
        written = true;
        rowsByURI.get(hot.folderURI).push({ msgKey: 99, headerMessageId: hotId });
        await engineFtsSearch.indexBatch([{ msgId: hotKey, folderId: hot.folderId }]);
      };
      const list = fts.listFolderMembership.getMockImplementation();
      fts.listFolderMembership.mockImplementation(async (folderId, ...args) => {
        const page = await list(folderId, ...args);
        if (moment === 'terminal_page' && folderId === cold.folderId && page.done) await write();
        return page;
      });
      const api = globalThis.browser.tmMsgNotify;
      const begin = api.beginFolderMessageScan.getMockImplementation();
      const coldTokens = new Set();
      api.beginFolderMessageScan.mockImplementation(async (uri, ...args) => {
        const scan = await begin(uri, ...args);
        if (uri === cold.folderURI) coldTokens.add(scan.token);
        return scan;
      });
      const read = api.readFolderMessageScanPage.getMockImplementation();
      api.readFolderMessageScanPage.mockImplementation(async (token, ...args) => {
        const page = await read(token, ...args);
        if (moment === 'uid_scan' && coldTokens.has(token)) await write();
        return page;
      });
      const state = api.getFolderState.getMockImplementation();
      api.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        const value = await state(accountId, folderPath, options);
        if (moment === 'closing_read' && folderPath === '/Big' && options === undefined) await write();
        return value;
      });
      restartSession();
      clearNativeCalls(fts);

      await finishSession(fts);

      expect(written).toBe(true);
      expect(nativeRows.get(hotKey)).toBe(hot.folderId);
      expect(many.every(id => nativeRows.get(`account1:/Big:${id}`) === cold.folderId)).toBe(true);
      expect(_testExports._getFolderReconSessionDone()).toContain(BIG);
      expect(globalThis.browser.storage.local.set.mock.calls.filter(([patch]) =>
        patch[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders?.[BIG]?.verified === false)).toHaveLength(0);
      expect(api.beginFolderMessageScan.mock.calls.filter(([uri]) => uri === cold.folderURI))
        .toEqual([[cold.folderURI, false]]);
      expect(await sessionSettled()).toBe(true);
    });

    it('restarts a multi-page UID-tier attempt whose native pages a membership write invalidated, then certifies', async () => {
      const { fts } = installTokenFolders([{ folderPath: '/Big', headerMessageIds: many }]);
      await finishSession(fts);
      restartSession();
      const yielded = await tickUntil(fts, value => value?.reason === 'membership_page' || value?.complete === true, 60);
      expect(yielded.reason).toBe('membership_page');
      // A write elsewhere lands while the attempt waits for its next page.
      await runFtsMembershipMutation(async () => ({ count: 1 }));

      await finishSession(fts);

      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set([BIG]));
      expect(await sessionSettled()).toBe(true);
    });

    // The attempt began before the mark, so its digest cannot discharge it:
    // the resumed attempt must not certify, and the row lost meanwhile is
    // re-queued in this session rather than at the next rolling walk.
    it('does not certify a UID-tier attempt that was yielded when its folder was marked', async () => {
      const { fts, nativeRows, folders } = installTokenFolders([{ folderPath: '/Big', headerMessageIds: many }]);
      await finishSession(fts);
      restartSession();
      // The first page yield comes before any native page is read; the
      // second comes after one.
      for (let page = 0; page < 2; page++) {
        const yielded = await tickUntil(fts, value => value?.reason === 'membership_page' || value?.complete === true, 60);
        expect(yielded.reason).toBe('membership_page');
      }
      // A native row vanishes with no epoch move (a late commit), and the
      // folder's abandoned queue work marks it.
      const lost = `${BIG}:${many[0]}`;
      expect(nativeRows.has(lost)).toBe(true);
      nativeRows.delete(lost);
      await abandonQueuedUpdate(BIG);

      const result = await tickUntil(fts, value => settled(value) || queued(lost), 200);

      expect(queued(lost)).toBe(true);
      expect(settled(result)).toBe(false);
      expect(await settleAllWithDrain(fts, nativeRows, folders)).toBe(true);
      expect(nativeRows.get(lost)).toBe(folders[0].folderId);
    });
  });

  describe('walk obligations', () => {
    // /A's msgDB stays unreadable for scans while `broken.value` holds.
    function breakScansOf(folderURI) {
      const scan = globalThis.browser.tmMsgNotify.beginFolderMessageScan.getMockImplementation();
      const broken = { value: true, attempts: 0 };
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async (...args) => {
        if (broken.value && args[0] === folderURI) {
          broken.attempts++;
          throw new Error('msgDB unavailable');
        }
        return scan(...args);
      });
      return broken;
    }

    it('keeps a failing marked folder\'s exponential deferral across ticks while another folder completes', async () => {
      const { fts, folders, nativeRows } = installTokenFolders(specs);
      await finishSession(fts);
      const broken = breakScansOf(folders[0].folderURI);
      await abandonQueuedUpdate('account1:/A');
      await abandonQueuedUpdate('account1:/B');

      // One hour of ticks, ten seconds apart: the backoff doubles up to its
      // five-minute cap, so /A is retried about twenty times, not every tick.
      for (let tick = 0; tick < 360; tick++) {
        vi.setSystemTime(Date.now() + 10_000);
        await settleSchedulerTickWithFakeTimers(fts);
      }

      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set(['account1:/B']));
      expect(broken.attempts).toBeGreaterThan(5);
      expect(broken.attempts).toBeLessThanOrEqual(30);
      expect(_testExports._getFolderReconDirty()).toEqual(new Set(['account1:/A']));
      expect(quietNow()).toBe(false);

      broken.value = false;
      expect(await settleAllWithDrain(fts, nativeRows, folders)).toBe(true);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set(['account1:/A', 'account1:/B']));
    });

    it('discharges an all-folder mark folder by folder, never by the first certification', async () => {
      const { fts, nativeRows, folders } = installTokenFolders(specs);
      await finishSession(fts);
      nativeRows.delete(A2);
      nativeRows.delete(B2);
      await abandonQueuedUpdate(undefined, 'account1:/Z:dropped@example.com');
      expect(_testExports._getFolderReconDirty()).toEqual(new Set(['account1:/A', 'account1:/B']));

      expect(await settleAllWithDrain(fts, nativeRows, folders)).toBe(true);

      expect(nativeRows.get(A2)).toBe(folders[0].folderId);
      expect(nativeRows.get(B2)).toBe(folders[1].folderId);
      expect(_testExports._getFolderReconDirty().size).toBe(0);
    });

    // A mark made while an attempt runs (here with an unannounced removal at
    // the same moment) must outlive that attempt and force a later one.
    it.each([
      ['after native paging begins', 'native_page'],
      ['after the UID scan', 'uid_scan'],
      ['during the closing read', 'closing_read'],
    ])('keeps a mark made %s for a later attempt, which repairs the folder', async (_name, moment) => {
      const { fts, nativeRows, folders } = installTokenFolders(specs);
      await finishSession(fts);
      const hook = { ran: false };
      const fire = async () => {
        if (hook.ran) return;
        hook.ran = true;
        nativeRows.delete(A2);
        await abandonQueuedUpdate('account1:/A');
      };
      const list = fts.listFolderMembership.getMockImplementation();
      fts.listFolderMembership.mockImplementation(async (folderId, after, limit) => {
        const page = await list(folderId, after, limit);
        if (moment === 'native_page' && folderId === folders[0].folderId) await fire();
        return page;
      });
      const scan = globalThis.browser.tmMsgNotify.beginFolderMessageScan.getMockImplementation();
      const uidScansOfA = new Set();
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async (uri, full) => {
        const opened = await scan(uri, full);
        if (uri === folders[0].folderURI && full === false) uidScansOfA.add(opened.token);
        return opened;
      });
      const readPage = globalThis.browser.tmMsgNotify.readFolderMessageScanPage.getMockImplementation();
      globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async (token, limit) => {
        const page = await readPage(token, limit);
        if (moment === 'uid_scan' && page.done && uidScansOfA.has(token)) await fire();
        return page;
      });
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        if (moment === 'closing_read' && folderPath === '/A' && options === undefined) await fire();
        return state(accountId, folderPath, options);
      });

      restartSession();
      let result = await tickUntil(fts, value => settled(value) || queued(A2), 60);
      for (let step = 0; step < 30 && !queued(A2) && !settled(result); step++) {
        result = await runAt(fts, Date.now() + 60_000, () => queued(A2));
      }

      expect(hook.ran).toBe(true);
      expect(queued(A2)).toBe(true);
      expect(quietNow()).toBe(false);
    });

    it.each([
      ['an added', 'onExperimentMessageAdded', (rows, uri) => {
        rows.set(uri, [...rows.get(uri), { msgKey: 3, headerMessageId: 'a-3@example.com' }]);
      }, A3, true],
      ['a removed', 'onExperimentMessageRemoved', (rows, uri) => {
        rows.set(uri, rows.get(uri).filter(row => row.headerMessageId !== 'a-2@example.com'));
      }, A2, false],
    ])('owes the folder a walk when %s message event could not be queued', async (_name, handler, change, key, indexed) => {
      const { fts, rowsByURI, nativeRows, folders } = installTokenFolders(specs);
      await finishSession(fts);
      change(rowsByURI, folders[0].folderURI);
      // The event names the folder but carries no Message-ID to queue.
      await _testExports[handler]({ accountId: 'account1', folderPath: '/A', eventType: 'test' });
      expect(_testExports._getPendingUpdates().size).toBe(0);
      expect(_testExports._getFolderReconDirty()).toEqual(new Set(['account1:/A']));

      await settleWithDrain(fts, nativeRows, folders[0].folderId, 60_000);

      expect(nativeRows.has(key)).toBe(indexed);
      expect(await sessionSettled()).toBe(true);
    });

    it.each([
      ['a connection generation change', fts => { fts.getConnectionGeneration.mockReturnValue(2); }],
      ['a capability loss then regain', async fts => {
        fts.supportsFolderMembership.mockReturnValue(false);
        await settleSchedulerTickWithFakeTimers(fts);
        fts.supportsFolderMembership.mockReturnValue(true);
      }],
    ])('re-walks every completed folder after %s, once cutover is re-earned', async (_name, reconnect) => {
      const { fts, nativeRows, folders } = installTokenFolders(specs);
      await finishSession(fts);
      // Late native removals no event announced.
      nativeRows.delete(A2);
      nativeRows.delete(B2);

      await reconnect(fts);
      const result = await tickUntil(fts, value => settled(value) || queued(A2) || queued(B2), 60);

      expect(queued(A2) || queued(B2)).toBe(true);
      expect(settled(result)).toBe(false);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(quietNow()).toBe(false);
      expect(await settleAllWithDrain(fts, nativeRows, folders)).toBe(true);
      expect(nativeRows.get(A2)).toBe(folders[0].folderId);
      expect(nativeRows.get(B2)).toBe(folders[1].folderId);
    });

    // Overflow events for folders no inventory lists record no obligation,
    // so sustained pressure cannot grow the obligation map; a known folder's
    // overflow is still owed its walk.
    it('records overflow obligations only for known folders while pressure holds the scheduler off', async () => {
      const { fts, nativeRows, folders } = installTokenFolders(specs);
      await finishSession(fts);
      nativeRows.delete(A2);
      getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
      for (let index = 0; _testExports._getPendingUpdates().size < reconConfig.pendingHighWater; index++) {
        _testExports._getPendingUpdates().set(`account1:/B:queued-${index}@example.com`, {
          uniqueKey: `account1:/B:queued-${index}@example.com`, type: 'new', timestamp: Date.now(), folderKey: 'account1:/B',
        });
      }
      for (let index = 0; index < 1000; index++) {
        await _testExports.onExperimentMessageAdded({
          accountId: 'account1', folderPath: `/Transient-${index}`,
          headerMessageId: `overflow-${index}@example.com`, msgKey: 1, eventType: 'msgAdded',
        });
        expect(await settleSchedulerTickWithFakeTimers(fts)).toMatchObject({ skipped: true });
      }
      expect(_testExports._getFolderReconDirty()).toEqual(new Set());
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: '/A',
        headerMessageId: 'overflow-a@example.com', msgKey: 9, eventType: 'msgAdded',
      });
      expect(_testExports._getFolderReconDirty()).toEqual(new Set(['account1:/A']));

      _testExports._getPendingUpdates().clear();
      getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
      expect(await settleAllWithDrain(fts, nativeRows, folders)).toBe(true);
      expect(_testExports._getFolderReconDirty().size).toBe(0);
      expect(nativeRows.get(A2)).toBe(folders[0].folderId);
    });

    // A folder that disappears while its attempt waits for a page must not
    // leave that attempt's record behind: folder churn would grow it for
    // the whole session.
    it('drops the yielded attempt of a folder that disappears while it waits', async () => {
      const ids = Array.from({ length: 150 }, (_, index) => `row-${String(index).padStart(4, '0')}@example.com`);
      const { fts, folders } = installTokenFolders([
        { folderPath: '/Stay', headerMessageIds: ids },
        { folderPath: '/Vanish', headerMessageIds: ids },
      ]);
      await finishSession(fts, 200);
      restartSession();
      const allFolderIds = new Set(folders.map(folder => folder.folderId));
      const yieldedIds = () => [..._testExports._getFolderMembershipYieldedAttempts().keys()]
        .filter(folderId => allFolderIds.has(folderId));
      while (yieldedIds().length === 0) {
        const yielded = await tickUntil(fts, value => value?.reason === 'membership_page' || value?.complete === true, 60);
        expect(yielded.reason).toBe('membership_page');
      }
      const [first] = yieldedIds();
      const vanishing = folders.find(folder => folder.folderId === first);
      const staying = folders.find(folder => folder !== vanishing);
      globalThis.browser.accounts.list.mockResolvedValue([{
        id: 'account1', type: 'imap',
        rootFolder: {
          path: '/', isRoot: true,
          subFolders: [{ id: staying.weFolderId, accountId: 'account1', path: staying.folderPath, subFolders: [] }],
        },
      }]);

      await finishSession(fts, 200);

      expect(_testExports._getFolderMembershipYieldedAttempts().has(vanishing.folderId)).toBe(false);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set([`account1:${staying.folderPath}`]));
    });

    it('prunes a vanished folder\'s obligation and next walk', async () => {
      const { fts } = installTokenFolders(specs);
      await finishSession(fts);
      await abandonQueuedUpdate(undefined, 'account1:/Z:dropped@example.com');
      _testExports._pruneFolderReconRuntimeToFolderKeys(new Set(['account1:/A']));
      expect(_testExports._getFolderReconDirty()).toEqual(new Set(['account1:/A']));
      expect([..._testExports._getFolderReconNextWalkDueMs().keys()]).toEqual(['account1:/A']);
    });
  });

  describe('rolling re-walk', () => {
    // A timed-out index_batch for a since-removed folder commits natively
    // after the completed membership-state pass. No folder walk visits that
    // folder, so the pass itself must not stay complete past a walk period.
    it('removes a late native commit for a removed folder within a walk period and an interval', async () => {
      const { fts, nativeRows, folders } = installTokenFolders([{ folderPath: '/F', headerMessageIds: ['live@example.com'] }]);
      const passStartedAt = Date.now();
      await finishSession(fts);
      const passMs = Date.now() - passStartedAt;
      const live = 'account1:/F:live@example.com';
      const late = 'account1:/Removed:late@example.com';
      nativeRows.set(late, makeFolderMembershipId('account1', '/Removed'));
      const deadline = Date.now() + walkPeriodMs + intervalMs + passMs;

      await runAt(fts, Date.now() + walkPeriodMs - intervalMs);
      expect(nativeRows.has(late)).toBe(true);
      expect(await rollUntil(fts, Date.now(), () => !nativeRows.has(late), deadline)).toBe(true);

      expect(Date.now()).toBeLessThanOrEqual(deadline);
      expect(nativeRows.get(live)).toBe(folders[0].folderId);
      await finishSession(fts);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(await sessionSettled()).toBe(true);
    });

    it('repairs a late native removal no event announced at the folder\'s rolling walk, and not before', async () => {
      const { fts, nativeRows } = installTokenFolders(specs);
      await finishSession(fts);
      nativeRows.delete(A2);
      const due = nextWalkDue('account1:/A');
      expect(due).toBeGreaterThan(Date.now());
      expect(due).toBeLessThanOrEqual(Date.now() + walkPeriodMs);

      // Every rolling tick before the folder's walk is due leaves it alone.
      for (let at = Date.now() + intervalMs; at < due; at += intervalMs) {
        await runAt(fts, at);
        expect(queued(A2)).toBe(false);
      }
      expect(await sessionSettled()).toBe(true);

      expect(await rollUntil(fts, due, () => queued(A2), due + 3 * intervalMs)).toBe(true);
      expect(quietNow()).toBe(false);
    });

    it('does not consume the rolling tick before it is due or on a pressure skip', async () => {
      const { fts } = installTokenFolders(specs);
      await finishSession(fts);
      const due = rollingDue();
      expect(due).toBeGreaterThan(Date.now());

      vi.setSystemTime(due - 60_000);
      await settleSchedulerTickWithFakeTimers(fts);
      expect(rollingDue()).toBe(due);

      vi.setSystemTime(due);
      getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
      expect(await settleSchedulerTickWithFakeTimers(fts)).toMatchObject({ skipped: true, reason: 'pressure' });
      expect(rollingDue()).toBe(due);

      getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
      await settleSchedulerTickWithFakeTimers(fts);
      expect(rollingDue()).toBeGreaterThanOrEqual(due + intervalMs);
      expect(rollingDue()).toBeLessThan(due + intervalMs + 60_000);
    });

    it('arms one bounded rolling wake while idle and none after dispose', async () => {
      const { fts } = installTokenFolders(specs);
      await finishSession(fts);
      // Attach the runtime only now, so no timer-started tick of the session
      // can overlap the idle tick measured below.
      vi.clearAllTimers();
      _testExports._setFtsSearch(fts);
      vi.setSystemTime(Date.now() + 60_000);
      expect(await settleSchedulerTickWithFakeTimers(fts)).toMatchObject({ complete: true });
      expect(vi.getTimerCount()).toBe(1);
      expect(rollingDue() - Date.now()).toBeGreaterThan(0);
      expect(rollingDue() - Date.now()).toBeLessThanOrEqual(intervalMs);

      await incrementalIndexer.disposeIncrementalIndexer();
      expect(vi.getTimerCount()).toBe(0);
      expect(rollingDue()).toBe(0);
      expect(_testExports._getFolderReconNextWalkDueMs().size).toBe(0);
    });

    // Runs one pass slice by slice until `ended`, spacing the slices past the
    // rolling interval with foreground pressure when `spaced`.
    async function runPass(fts, spaced, ended) {
      let pressureSkips = 0;
      for (let slice = 0; slice < 12; slice++) {
        const result = await settleSchedulerTickWithFakeTimers(fts);
        if (ended(result)) return { ended: true, pressureSkips };
        if (spaced) {
          getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
          vi.setSystemTime(Date.now() + intervalMs + 1);
          expect(await settleSchedulerTickWithFakeTimers(fts)).toMatchObject({ skipped: true, reason: 'pressure' });
          pressureSkips++;
          getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
        } else {
          vi.setSystemTime(Date.now() + 100);
        }
      }
      return { ended: false, pressureSkips };
    }

    // Slices spaced past the rolling interval (here by foreground pressure)
    // must still let a finite startup pass complete, and the rolling walk
    // still repairs a late native removal afterwards.
    it.each([false, true])('completes passes whose slices are spaced past the rolling interval; spaced=%s', async (spaced) => {
      const { fts, nativeRows } = installTokenFolders(specs);
      await finishSession(fts);
      restartSession();

      const first = await runPass(fts, spaced, settled);
      expect(first.pressureSkips > 0).toBe(spaced);
      expect(first.ended).toBe(true);
      expect([...nativeRows.keys()].sort()).toEqual([A1, A2, 'account1:/B:b-1@example.com', B2]);

      nativeRows.delete(A1);
      const due = nextWalkDue('account1:/A');
      expect(await rollUntil(fts, due, () => queued(A1), due + 3 * intervalMs)).toBe(true);
    });

    // A rolling tick that comes due while the folder's own rolling walk is
    // still paging must not re-mark it: a mark newer than the attempt keeps
    // it from discharging, so a folder whose walk always spans a tick would
    // never complete.
    it('finishes a multi-page rolling walk whose slices are spaced past the rolling interval, walking the folder once', async () => {
      const many = Array.from({ length: 3 * reconConfig.membershipListPageSize }, (_, i) => `m-${String(i).padStart(4, '0')}@example.com`);
      const { fts } = installTokenFolders([{ folderPath: '/Big', headerMessageIds: many }]);
      await finishSession(fts);
      vi.setSystemTime(Math.max(nextWalkDue('account1:/Big'), rollingDue()));
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockClear();

      const pass = await runPass(fts, true, settled);

      expect(pass.ended).toBe(true);
      expect(pass.pressureSkips).toBeGreaterThan(1);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).toHaveBeenCalledOnce();
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set(['account1:/Big']));
      expect(await sessionSettled()).toBe(true);
    });

    // The failing folder's walk falls due first, so an admission that let an
    // outstanding folder consume the tick would starve the healthy one.
    it('keeps admitting a healthy folder\'s rolling walks while an earlier-due folder\'s obligation keeps failing, then recovers both', async () => {
      const { fts, nativeRows, folders } = installTokenFolders(specs);
      await finishSession(fts);
      const keyOf = folder => `account1:${folder.folderPath}`;
      const [failing, healthy] = [...folders].sort((left, right) => nextWalkDue(keyOf(left)) - nextWalkDue(keyOf(right)));
      const lateKey = `${keyOf(healthy)}:${healthy.folderPath === '/A' ? 'a' : 'b'}-2@example.com`;
      const scan = globalThis.browser.tmMsgNotify.beginFolderMessageScan.getMockImplementation();
      let broken = true;
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async (...args) => {
        if (broken && args[0] === failing.folderURI) throw new Error('msgDB unavailable');
        return scan(...args);
      });
      await abandonQueuedUpdate(keyOf(failing));

      for (let period = 0; period < 2; period++) {
        // The healthy folder is complete before its walk falls due.
        for (let step = 0; step < 72 && !_testExports._getFolderReconSessionDone().has(keyOf(healthy)); step++) {
          await runAt(fts, Date.now() + intervalMs, () => _testExports._getFolderReconSessionDone().has(keyOf(healthy)));
        }
        expect(_testExports._getFolderReconSessionDone().has(keyOf(healthy))).toBe(true);
        const due = nextWalkDue(keyOf(healthy));
        expect(due).toBeGreaterThan(nextWalkDue(keyOf(failing)));
        // A late native removal in the healthy folder that no event announced.
        nativeRows.delete(lateKey);
        expect(await rollUntil(fts, due, () => queued(lateKey), due + 3 * intervalMs)).toBe(true);
        // The drain indexes it into the healthy folder.
        _testExports._getPendingUpdates().delete(lateKey);
        nativeRows.set(lateKey, healthy.folderId);
        expect(_testExports._getFolderReconDirty().has(keyOf(failing))).toBe(true);
        expect(quietNow()).toBe(false);
      }

      broken = false;
      expect(await settleAllWithDrain(fts, nativeRows, folders)).toBe(true);
      expect(nativeRows.get(lateKey)).toBe(healthy.folderId);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set(['account1:/A', 'account1:/B']));
    });

    // Records when each folder's walk begins (its first native membership
    // page); a page re-read within one interval is the same walk.
    function trackWalks(fts, folders) {
      const walks = new Map(folders.map(folder => [folder.folderId, []]));
      const list = fts.listFolderMembership.getMockImplementation();
      fts.listFolderMembership.mockImplementation(async (folderId, after, limit) => {
        const starts = walks.get(folderId);
        if (after == null && starts && !(starts.at(-1) > Date.now() - intervalMs)) starts.push(Date.now());
        return list(folderId, after, limit);
      });
      return walks;
    }

    // Steps the clock one rolling interval at a time.
    async function stepIntervals(fts, folders, untilMs) {
      while (Date.now() < untilMs) await runAt(fts, Date.now() + intervalMs, undefined, 20 * folders.length + 60);
    }

    const tokenFolderSpecs = paths => paths.map((folderPath, index) => ({
      folderPath,
      headerMessageIds: [`f-${index}@example.com`],
    }));

    // The owner deadline: a folder's next walk begins within one walk period
    // plus one rolling interval of its previous one, plus the time a pass
    // spends reaching it, measured here as a whole startup pass.
    function expectWalkedWithinDeadline(walks, folders, passMs, fromMs) {
      for (const folder of folders) {
        const starts = walks.get(folder.folderId).filter(at => at >= fromMs);
        expect(starts.length).toBeGreaterThanOrEqual(2);
        for (let index = 1; index < starts.length; index++) {
          expect(starts[index] - starts[index - 1]).toBeLessThanOrEqual(walkPeriodMs + intervalMs + passMs);
        }
      }
    }

    it.each([1, 2, 71, 72, 73, 500])('re-walks each of %i unchanged folders once per walk period, never sooner', async (count) => {
      const { fts, folders } = installTokenFolders(tokenFolderSpecs(
        Array.from({ length: count }, (_, index) => `/F${String(index).padStart(3, '0')}`),
      ));
      const walks = trackWalks(fts, folders);
      const passStartedAt = Date.now();
      await finishSession(fts, 20 * count + 60);
      const passMs = Date.now() - passStartedAt;
      const firstDue = new Map(folders.map(folder => [folder.folderId, nextWalkDue(`account1:${folder.folderPath}`)]));
      globalThis.browser.storage.local.set.mockClear();

      await stepIntervals(fts, folders, passStartedAt + 3 * walkPeriodMs);

      expectWalkedWithinDeadline(walks, folders, passMs, passStartedAt);
      const firstRollingWalksPerTick = new Map();
      for (const folder of folders) {
        const starts = walks.get(folder.folderId);
        expect(starts[1]).toBeGreaterThanOrEqual(firstDue.get(folder.folderId));
        for (let index = 2; index < starts.length; index++) {
          expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(walkPeriodMs);
        }
        const tick = Math.floor((starts[1] - passStartedAt) / intervalMs);
        firstRollingWalksPerTick.set(tick, (firstRollingWalksPerTick.get(tick) || 0) + 1);
      }
      // The stable offsets spread the startup cohort: no tick starts more
      // than about twice the even share of rolling walks.
      const evenShare = count * intervalMs / walkPeriodMs;
      expect(Math.max(...firstRollingWalksPerTick.values())).toBeLessThanOrEqual(Math.ceil(2 * evenShare) + 4);
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
      expect(await sessionSettled()).toBe(true);
    }, 120_000);

    // Deadlines that coincide must not queue behind one another: a cohort
    // whose stable offsets all land in the period's last interval, and a
    // cohort a topology event re-walked at one moment.
    it.each([
      ['offsets clustered in the last interval', 'clustered'],
      ['re-walked together by a topology event', 'signal'],
    ])('re-walks a cohort of 73 folders %s within the deadline', async (_name, cohort) => {
      const count = 73;
      const paths = [];
      for (let index = 0; paths.length < count; index++) {
        const folderPath = `/Cluster-${index}`;
        if (cohort !== 'clustered'
            || _testExports._folderReconWalkOffsetMs(`account1:${folderPath}`) >= walkPeriodMs - intervalMs) {
          paths.push(folderPath);
        }
      }
      const { fts, folders } = installTokenFolders(tokenFolderSpecs(paths));
      const walks = trackWalks(fts, folders);
      const passStartedAt = Date.now();
      await finishSession(fts, 20 * count + 60);
      const passMs = Date.now() - passStartedAt;
      let fromMs = passStartedAt;
      if (cohort === 'signal') {
        vi.setSystemTime(Date.now() + intervalMs);
        fromMs = Date.now();
        const onRenamed = { listeners: new Set() };
        onRenamed.addListener = listener => onRenamed.listeners.add(listener);
        onRenamed.removeListener = listener => onRenamed.listeners.delete(listener);
        globalThis.browser.folders = { onRenamed };
        incrementalIndexer.setupFolderTopologyListeners();
        const folder = { accountId: 'account1', path: '/Cluster-0' };
        for (const listener of [...onRenamed.listeners]) listener(folder, folder);
        expect(_testExports._getFolderReconDirty().size).toBe(count);
        await finishSession(fts, 20 * count + 60);
      }
      try {
        const dues = folders.map(folder => nextWalkDue(`account1:${folder.folderPath}`));
        expect(Math.max(...dues) - Math.min(...dues)).toBeLessThanOrEqual(intervalMs + passMs);

        await stepIntervals(fts, folders, fromMs + 2 * walkPeriodMs + intervalMs);

        expectWalkedWithinDeadline(walks, folders, passMs, fromMs);
        expect(await sessionSettled()).toBe(true);
      } finally {
        if (globalThis.browser.folders) {
          await incrementalIndexer.disposeIncrementalIndexer();
          delete globalThis.browser.folders;
        }
      }
    }, 120_000);

    // Empty inventory and index, nothing verified: only the rolling tick's
    // wake can discover the account.
    it('discovers and walks an account that loads after a cold start without any account event', async () => {
      const { fts, nativeRows, folders } = installTokenFolders(specs);
      nativeRows.clear();
      delete storageData[_testExports.FOLDER_RECON_STORAGE_KEY];
      const accounts = globalThis.browser.accounts.list.getMockImplementation();
      globalThis.browser.accounts.list.mockResolvedValue([]);
      await finishSession(fts);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(_testExports._getFolderReconSessionDone().size).toBe(0);
      // Attach the runtime only now, so no timer-started tick overlaps the
      // idle tick: the completed session still arms one bounded wake.
      vi.clearAllTimers();
      _testExports._setFtsSearch(fts);
      vi.setSystemTime(Date.now() + 60_000);
      expect(await settleSchedulerTickWithFakeTimers(fts)).toMatchObject({ complete: true });
      expect(vi.getTimerCount()).toBe(1);
      expect(rollingDue() - Date.now()).toBeGreaterThan(0);
      expect(rollingDue() - Date.now()).toBeLessThanOrEqual(intervalMs);
      _testExports._setFtsSearch(null);
      vi.clearAllTimers();

      globalThis.browser.accounts.list.mockImplementation(accounts);
      await runAt(fts, rollingDue(), () => queued(A1));
      expect(queued(A1)).toBe(true);
      expect(await settleAllWithDrain(fts, nativeRows, folders)).toBe(true);

      expect(Object.fromEntries(nativeRows)).toEqual({
        [A1]: folders[0].folderId,
        [A2]: folders[0].folderId,
        'account1:/B:b-1@example.com': folders[1].folderId,
        [B2]: folders[1].folderId,
      });
    });
  });

  it('control: an unchanged folder after a certification enqueues nothing', async () => {
    const { fts } = installTokenFolders(specs);
    await finishSession(fts);
    restartSession();
    await finishSession(fts);
    expect(_testExports._getPendingUpdates().size).toBe(0);
  });

  // A folder whose msgDB cannot be read while it is new to the inventory
  // must not hold every other folder's reconciliation: the membership-state
  // pass alone proves cutover and never reads a folder's msgDB.
  describe('an unreadable newly inventoried folder', () => {
    const B1 = 'account1:/B:b-1@example.com';

    // /A has completed; /B then appears in the inventory. `failure` is how
    // /B's msgDB refuses: getFolderState reports an error or throws, the
    // scan cannot start, or its page read fails. /B's native rows, if any,
    // are owned (capable era) unless `ownerless`.
    function addUnreadableFolder(installed, { failure = 'error', rows = [], ownerless = false } = {}) {
      const b = {
        accountId: 'account1',
        folderPath: '/B',
        folderId: makeFolderMembershipId('account1', '/B'),
        weFolderId: 'session-folder-b',
        folderURI: 'none://membership-b',
        serverType: 'imap',
        stableUidKeys: true,
        uidValidity: 7,
      };
      installed.folders.push(b);
      installed.rowsByURI.set(b.folderURI, rows.map((headerMessageId, index) => ({
        msgKey: index + 1,
        headerMessageId,
      })));
      for (const headerMessageId of rows) {
        installed.nativeRows.set(`account1:/B:${headerMessageId}`, ownerless ? null : b.folderId);
      }
      globalThis.browser.accounts.list.mockResolvedValue([{
        id: 'account1', type: 'none',
        rootFolder: {
          path: '/', isRoot: true,
          subFolders: installed.folders.map(folder => ({
            id: folder.weFolderId,
            path: folder.folderPath,
            subFolders: [],
          })),
        },
      }]);
      // Pages read after /B joined the inventory belong to a pass bound to it.
      const readable = {
        value: false,
        stateReads: 0,
        statePagesAtAdd: installed.fts.listFolderMembershipState.mock.calls.length,
        scanTokens: [],
      };
      const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) => {
        if (folderPath === '/B') readable.stateReads++;
        if (folderPath === '/B' && !readable.value && failure === 'error') {
          return { accountId, folderPath, error: 'folder_db_unavailable' };
        }
        if (folderPath === '/B' && !readable.value && failure === 'throw') {
          throw new Error('folder_db_unavailable');
        }
        return state(accountId, folderPath, options);
      });
      const scan = globalThis.browser.tmMsgNotify.beginFolderMessageScan.getMockImplementation();
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async (uri, ...rest) => {
        if (uri === b.folderURI && !readable.value && failure === 'scan') return { error: 'folder_db_unavailable' };
        const started = await scan(uri, ...rest);
        if (uri === b.folderURI) readable.scanTokens.push(started.token);
        return started;
      });
      const page = globalThis.browser.tmMsgNotify.readFolderMessageScanPage.getMockImplementation();
      globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async (token, ...rest) => {
        if (readable.scanTokens.includes(token) && !readable.value && failure === 'page') {
          return { error: 'folder_db_unavailable' };
        }
        return page(token, ...rest);
      });
      const passReadWithB = () =>
        installed.fts.listFolderMembershipState.mock.calls.length > readable.statePagesAtAdd;
      return { b, readable, passReadWithB };
    }

    // Runs spaced ticks until `done` holds or the deadline passes, skipping
    // ahead to the next rolling-walk admission when that comes later.
    async function runUntil(fts, done, deadlineMs) {
      while (!done() && Date.now() < deadlineMs) {
        await runAt(fts, Math.max(Date.now() + 60_000, Math.min(rollingDue(), deadlineMs)), done, 20);
      }
      return done();
    }

    const obligations = [
      ['a real queue abandonment', async () => { await abandonQueuedUpdate('account1:/A'); }, () => Date.now() + 60 * 60_000],
      ['a due rolling walk', async () => {}, () => nextWalkDue('account1:/A') + 3 * intervalMs],
    ];

    it.each([
      ...obligations.flatMap(([name, oblige, deadline]) => [
        [name, 'error', [], oblige, deadline],
        [name, 'throw', ['b-1@example.com'], oblige, deadline],
        [name, 'scan', ['b-1@example.com'], oblige, deadline],
        [name, 'page', ['b-1@example.com'], oblige, deadline],
      ]),
    ])('repairs a healthy folder owed %s while a new folder stays unreadable; failure=%s rows=%j', async (_name, failure, rows, oblige, deadline) => {
      const installed = installTokenFolders([specs[0]]);
      const { fts, nativeRows, folders } = installed;
      await finishSession(fts);
      nativeRows.delete(A2);
      const { readable, passReadWithB } = addUnreadableFolder(installed, { failure, rows });
      await oblige();

      // The obligation's tick inventories /B, which rebinds the pass; the
      // pass re-earns cutover without reading /B's msgDB.
      const cutoverWithB = () => passReadWithB() && _testExports._getFolderMembershipCleanupProven();
      expect(await runUntil(fts, cutoverWithB, deadline())).toBe(true);

      expect(await runUntil(fts, () => queued(A2), deadline())).toBe(true);
      for (const key of _testExports._getPendingUpdates().keys()) nativeRows.set(key, folders[0].folderId);
      _testExports._getPendingUpdates().clear();
      expect(await runUntil(fts, () => _testExports._getFolderReconSessionDone().has('account1:/A'),
        Date.now() + 60 * 60_000)).toBe(true);

      expect(nativeRows.get(A2)).toBe(folders[0].folderId);
      expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
      expect(readable.stateReads).toBeGreaterThan(0);
      expect(_testExports._getFolderReconSessionDone().has('account1:/B')).toBe(false);
      // The unreadable folder's outcome reopened the completed session.
      expect((await getIncrementalIndexerStatus()).folderRecon.outcomes.complete).toBe(false);
      for (const headerMessageId of rows) expect(nativeRows.has(`account1:/B:${headerMessageId}`)).toBe(true);

      // Once /B can be read, it is reconciled and the session completes.
      readable.value = true;
      expect(await settleAllWithDrain(fts, nativeRows, installed.folders)).toBe(true);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set(['account1:/A', 'account1:/B']));
    });

    // The pass assigns an ownerless row through a per-row probe of its
    // folder's Message-ID index, so assignment never waits on the folder's
    // msgDB scan.
    it.each(['readable', 'scan'])('assigns a new folder\'s ownerless row per row and earns cutover; failure=%s', async (failure) => {
      const installed = installTokenFolders([specs[0]]);
      const { fts } = installed;
      await finishSession(fts);
      const { b, readable, passReadWithB } = addUnreadableFolder(installed, {
        failure, rows: ['b-1@example.com'], ownerless: true,
      });
      readable.value = failure === 'readable';
      globalThis.browser.messages.query.mockClear();
      globalThis.browser.tmMsgNotify.probeMessageIds.mockClear();
      await abandonQueuedUpdate('account1:/A');

      expect(await runUntil(fts, () => passReadWithB()
        && _testExports._getFolderMembershipCleanupProven(), Date.now() + 60 * 60_000)).toBe(true);

      expect(installed.nativeRows.get(B1)).toBe(b.folderId);
      expect(globalThis.browser.tmMsgNotify.probeMessageIds)
        .toHaveBeenCalledWith(b.folderURI, ['b-1@example.com']);
      expect(globalThis.browser.messages.query).not.toHaveBeenCalled();
      if (failure === 'readable') {
        expect(await settleAllWithDrain(fts, installed.nativeRows, installed.folders)).toBe(true);
        expect(_testExports._getFolderReconSessionDone()).toEqual(new Set(['account1:/A', 'account1:/B']));
      }
    });

    // Fail-closed boundary: an ownerless row of a folder that cannot be read
    // is unresolved, so the pass never earns cutover until the folder can be.
    it('never earns cutover while an unreadable new folder holds an ownerless row', { timeout: 30_000 }, async () => {
      const installed = installTokenFolders([specs[0]]);
      const { fts } = installed;
      await finishSession(fts);
      const { b, readable, passReadWithB } = addUnreadableFolder(installed, { rows: ['b-1@example.com'], ownerless: true });
      const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
      globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
        if (uri === b.folderURI && !readable.value) throw new Error('folder_db_unavailable');
        return probe(uri, ids);
      });
      recheckMessageInFolder.mockImplementation(async (_headerID, weFolder) =>
        (weFolder?.path === '/B' && !readable.value ? 'error' : 'absent'));
      await abandonQueuedUpdate('account1:/A');

      expect(await runUntil(fts, passReadWithB, Date.now() + 60 * 60_000)).toBe(true);
      expect(await runUntil(fts, () => _testExports._getFolderMembershipCleanupProven(),
        Date.now() + 2 * 60 * 60_000)).toBe(false);
      expect(installed.nativeRows.get(B1)).toBeNull();
      expect(reconWorkOwed()).toBe(true);

      readable.value = true;
      expect(await runUntil(fts, () => _testExports._getFolderMembershipCleanupProven(),
        Date.now() + 60 * 60_000)).toBe(true);
      expect(installed.nativeRows.get(B1)).toBe(b.folderId);
    });
  });
});

describe('capability-keyed quiet veto (sustained sync traffic)', () => {
  const EVENT_GAP_MS = 4_000;
  const TRAFFIC_MS = 31 * 60_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // A real message event every EVENT_GAP_MS (shorter than the quiet window);
  // the healthy drain indexes each one before the next arrives.
  async function underTraffic(fts, until) {
    let event = 0;
    for (let elapsedMs = 0; elapsedMs < TRAFFIC_MS && !until(); elapsedMs += EVENT_GAP_MS) {
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1',
        folderPath: '/A',
        headerMessageId: `traffic-${event++}@example.com`,
        msgKey: 1000 + event,
        eventType: 'msgAdded',
      });
      _testExports._getPendingUpdates().clear();
      for (let stepMs = 0; stepMs < EVENT_GAP_MS && !until(); stepMs += 250) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 250);
      }
    }
    return until();
  }

  const specs = [
    { folderPath: '/A', headerMessageIds: ['a-1@example.com'] },
    { folderPath: '/B', headerMessageIds: ['b-1@example.com'] },
  ];

  it('earns cutover on a capable helper at startup despite events every 4 s', async () => {
    const { fts } = installExactMembershipFolders(specs);
    _testExports._setFtsSearch(fts);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);

    expect(await underTraffic(fts, () => _testExports._getFolderMembershipCleanupProven())).toBe(true);
    expect(_testExports._getFolderMembershipStatePass()).toMatchObject({ completed: true });
  });

  it('re-earns cutover after a capable reconnect despite events every 4 s', async () => {
    const { fts } = installExactMembershipFolders(specs);
    _testExports._setFtsSearch(fts);
    expect(await underTraffic(fts, () => _testExports._getFolderMembershipCleanupProven())).toBe(true);

    // The reconnect revokes cutover; it is re-earned only by a state pass
    // bound to the new connection generation.
    fts.getConnectionGeneration.mockReturnValue(2);
    fts.listFolderMembershipState.mockClear();
    expect(await underTraffic(fts, () => _testExports._getFolderMembershipCleanupProven()
      && _testExports._getFolderMembershipStatePass()?.connectionGeneration === 2)).toBe(true);
    expect(fts.listFolderMembershipState).toHaveBeenCalled();
  });

  it('control: a legacy helper still waits for a quiet window', async () => {
    const { fts } = installExactMembershipFolders(specs);
    fts.supportsFolderMembership.mockReturnValue(false);
    _testExports._setFtsSearch(fts);
    getForegroundFetchPressure.mockClear();
    _testExports._setLastSyncEventMs(Date.now());
    expect(await settleSchedulerTickWithFakeTimers(fts)).toMatchObject({ skipped: true, reason: 'pressure' });
    expect(globalThis.browser.tmMsgNotify.getFolderState).not.toHaveBeenCalled();
  });
});

describe('folder-scoped change evidence (sustained traffic in another folder)', () => {
  const EVENT_GAP_MS = 4_000;
  const TRAFFIC_MS = 31 * 60_000;
  const SLICE_STEP_MS = 250;
  // More native membership pages than slices fit between two events.
  const COLD_ROWS = 20 * reconConfig.membershipListPageSize + 1;
  // Thousands of simulated slices; real time only.
  const TRAFFIC_TEST_TIMEOUT_MS = 120_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // Earned exact mode. A late native removal no event announced (P6) left
  // the cold folder one row short. `/Cold:Hot` is a distinct folder whose
  // keys all sit inside the cold folder's raw key range.
  function seedColdAndHot(hotPath = '/Hot') {
    const cold = Array.from({ length: COLD_ROWS }, (_, i) => `cold-${String(i).padStart(4, '0')}@example.com`);
    const installed = seedMigratedExactFolders([
      { folderPath: '/Cold', headerMessageIds: cold },
      { folderPath: hotPath, headerMessageIds: ['hot-seed@example.com'] },
    ]);
    const missingKey = `account1:/Cold:${cold[COLD_ROWS >> 1]}`;
    installed.nativeRows.delete(missingKey);
    installRealDrain(installed);
    return { ...installed, missingKey };
  }

  // The production drain: queued adds are resolved to headers, filtered
  // against the native index and written through the real engine wrapper
  // (which attributes each row to its folder) into the fake native backend.
  function installRealDrain({ fts, nativeRows, folders, rowsByURI }) {
    const headers = new Map();
    // A raw key resolves through the folders whose live messages hold it, so
    // a colon-bearing path reaches its real folder.
    resolveUniqueMessageKey.mockImplementation(async key => {
      const matches = folders.flatMap(folder => {
        const prefix = `account1:${folder.folderPath}:`;
        if (!key.startsWith(prefix)) return [];
        const headerID = key.slice(prefix.length);
        if (!rowsByURI.get(folder.folderURI).some(row => row.headerMessageId === headerID)) return [];
        return [{ headerID, weFolder: { accountId: 'account1', path: folder.folderPath, id: folder.weFolderId } }];
      });
      if (matches.length !== 1) return null;
      const weID = await headerIDToWeID(matches[0].headerID, matches[0].weFolder, false);
      return { ...matches[0], weID };
    });
    headerIDToWeID.mockImplementation(async (headerID, weFolder) => {
      const weID = headers.size + 1;
      headers.set(weID, { id: weID, headerMessageId: headerID, folder: { accountId: weFolder.accountId, path: weFolder.path } });
      return weID;
    });
    globalThis.browser.messages.get = vi.fn(async weID => headers.get(weID) || null);
    const keyOf = header => `${header.folder.accountId}:${header.folder.path}:${header.headerMessageId}`;
    buildBatchHeader.mockImplementation(async batch => batch.map(header => ({
      msgId: keyOf(header),
      folderId: makeFolderMembershipId(header.folder.accountId, header.folder.path),
    })));
    getUniqueMessageKey.mockImplementation(async header => keyOf(header));
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    installCapableNativeIndex(nativeRows);
    fts.indexBatch = (rows, token) => engineFtsSearch.indexBatch(rows, token);
  }

  // A capable helper receives each row with its folderId.
  function installCapableNativeIndex(nativeRows) {
    fakeNativeFts.indexBatch.mockImplementation(async (rows, wire) => {
      if (wire) wire.withFolderIds = true;
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
  }

  // A real message event in `eventFolderPath` every EVENT_GAP_MS. An
  // unconverted event is the experiment's fallback when the folder manager
  // cannot convert the folder: server key and folder URI, no weFolderId.
  async function underTraffic({ fts, folders, rowsByURI }, until, eventFolderPath = '/Hot', {
    unconverted = false,
    messageId = n => `traffic-${n}@example.com`,
  } = {}) {
    let event = 0;
    const location = unconverted
      ? { accountId: 'server1', folderPath: `imap://user@example.com${eventFolderPath}`, weFolderId: null }
      : {
          accountId: 'account1',
          folderPath: eventFolderPath,
          weFolderId: folders.find(folder => folder.folderPath === eventFolderPath).weFolderId,
        };
    const eventFolder = folders.find(folder => folder.folderPath === eventFolderPath);
    for (let elapsedMs = 0; elapsedMs < TRAFFIC_MS && !until(); elapsedMs += EVENT_GAP_MS) {
      const headerMessageId = messageId(event++);
      const msgKey = 100_000 + event;
      // The message lands in the folder's msgDB, then Thunderbird announces it.
      rowsByURI.get(eventFolder.folderURI).push({ msgKey, headerMessageId });
      await _testExports.onExperimentMessageAdded({
        ...location,
        headerMessageId,
        msgKey,
        eventType: 'msgAdded',
      });
      await flushPendingUpdates();
      for (let stepMs = 0; stepMs < EVENT_GAP_MS && !until(); stepMs += SLICE_STEP_MS) {
        await settleSchedulerTickWithFakeTimers(fts);
        await flushPendingUpdates();
        vi.setSystemTime(Date.now() + SLICE_STEP_MS);
      }
    }
    return until();
  }

  // The cold folder is one row short and one stale row long natively.
  function seedColdRepairs(hotPath) {
    const installed = seedColdAndHot(hotPath);
    const staleKey = 'account1:/Cold:stale@example.com';
    installed.nativeRows.set(staleKey, installed.folders[0].folderId);
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (folderURI, ids) => {
      const present = new Set((installed.rowsByURI.get(folderURI) || []).map(row => row.headerMessageId));
      return { missing: ids.filter(id => !present.has(id)) };
    });
    _testExports._setFtsSearch(installed.fts);
    const coldFirstPageReads = () => installed.fts.listFolderMembership.mock.calls
      .filter(([folderId, after]) => folderId === installed.folders[0].folderId && after == null).length;
    return { ...installed, staleKey, coldFirstPageReads };
  }

  it.each(['/Hot', '/Cold:Hot'])('repairs and completes a cold multi-page folder while another folder (%s) receives mail every 4 s for the whole interval', async (hotPath) => {
    // Quiet baseline: the cold proof's own first-page reads (the first
    // attempt plus a restart after each of its own repairs).
    const quiet = seedColdRepairs(hotPath);
    const quietDone = () => _testExports._getFolderReconSessionDone().has('account1:/Cold');
    for (let turn = 0; turn < 2000 && !quietDone(); turn++) {
      await settleSchedulerTickWithFakeTimers(quiet.fts);
      await flushPendingUpdates();
      vi.setSystemTime(Date.now() + SLICE_STEP_MS);
    }
    expect(quietDone()).toBe(true);
    const quietReads = quiet.coldFirstPageReads();

    _testExports._resetFolderReconState();
    _testExports._getPendingUpdates().clear();
    const installed = seedColdRepairs(hotPath);
    const [cold, hot] = installed.folders;
    const sent = [];
    const coldDone = () => _testExports._getFolderReconSessionDone().has(`account1:${cold.folderPath}`);
    let doneAtEvent = null;

    await underTraffic(installed, () => {
      if (doneAtEvent === null && coldDone()) doneAtEvent = sent.length;
      return false;
    }, hotPath, { messageId: n => { sent.push(`traffic-${n}@example.com`); return sent.at(-1); } });

    // Events kept arriving for the whole interval, and the drain kept up.
    expect(sent.length).toBe(TRAFFIC_MS / EVENT_GAP_MS);
    await flushPendingUpdates();
    expect(_testExports._getPendingUpdates().size).toBe(0);
    expect(sent.every(id => installed.nativeRows.get(`account1:${hotPath}:${id}`) === hot.folderId)).toBe(true);
    // The cold folder was repaired in both directions and completed early.
    expect(installed.nativeRows.get(installed.missingKey)).toBe(cold.folderId);
    expect(installed.nativeRows.has(installed.staleKey)).toBe(false);
    expect(coldDone()).toBe(true);
    expect(doneAtEvent).not.toBeNull();
    expect(doneAtEvent).toBeLessThan(sent.length / 10);
    // The other folder's traffic caused no cold proof restart.
    console.log('READS quiet', quietReads, 'traffic', installed.coldFirstPageReads(), 'doneAt', doneAtEvent);
    expect(installed.coldFirstPageReads()).toBe(quietReads);
  }, TRAFFIC_TEST_TIMEOUT_MS);

  // Every distinct colon-bearing Message-ID splits into candidate folder
  // paths no folder has; only real folders may occupy the change ledger, or
  // the hot folder's mail alone would evict entries and void the cold proof.
  it('repairs the cold folder while the other folder\'s colon-bearing Message-IDs churn past the ledger cap', async () => {
    const LEDGER_CAP = 4;
    _resetFtsOperationCoordinatorForTests({ changeLedgerCap: LEDGER_CAP });
    try {
      const installed = seedColdAndHot();
      const cold = installed.folders[0];
      _testExports._setFtsSearch(installed.fts);

      const repaired = () => installed.nativeRows.get(installed.missingKey) === cold.folderId
        && _testExports._getFolderReconSessionDone().has(`account1:${cold.folderPath}`);
      const sent = [];
      expect(await underTraffic(installed, repaired, '/Hot', {
        messageId: n => {
          const id = `item-${n}:a:b:c:d:e:f@[IPv6:2001:db8:0:0:0:0:0:${n}]`;
          sent.push(`account1:/Hot:${id}`);
          return id;
        },
      })).toBe(true);
      // Synthetic path ends (every ":" after the account but the real
      // folder's) far exceed the cap.
      const synthetic = sent.reduce((sum, key) => sum + key.split(':').length - 3, 0);
      expect(synthetic).toBeGreaterThan(10 * LEDGER_CAP);
    } finally {
      _resetFtsOperationCoordinatorForTests();
    }
  }, TRAFFIC_TEST_TIMEOUT_MS);

  // The stale direction lists the cold folder, then removes its stale rows
  // under a fence on the cold folder's evidence: another folder's write
  // after every cold listing never refuses that removal.
  it.each(['/Hot', '/Cold:Hot'])('removes a cold folder\'s stale row while another folder (%s) is written after every cold listing', async (hotPath) => {
    const installed = seedMigratedExactFolders([
      { folderPath: '/Cold', headerMessageIds: ['cold-1@example.com', 'cold-2@example.com'] },
      { folderPath: hotPath, headerMessageIds: ['hot-seed@example.com'] },
    ]);
    installCapableNativeIndex(installed.nativeRows);
    const [cold, hot] = installed.folders;
    const staleKey = 'account1:/Cold:stale@example.com';
    installed.nativeRows.set(staleKey, cold.folderId);
    // The msgDB probe reflects the folder's current headers.
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (folderURI, ids) => {
      const present = new Set((installed.rowsByURI.get(folderURI) || []).map(row => row.headerMessageId));
      return { missing: ids.filter(id => !present.has(id)) };
    });
    _testExports._setFtsSearch(installed.fts);
    let written = 0;
    const list = installed.fts.listFolderMembership.getMockImplementation();
    installed.fts.listFolderMembership.mockImplementation(async (folderId, ...rest) => {
      const page = await list(folderId, ...rest);
      if (folderId === cold.folderId) {
        const msgId = `account1:${hotPath}:late-${++written}@example.com`;
        await engineFtsSearch.indexBatch([{ msgId, folderId: hot.folderId }]);
      }
      return page;
    });

    const coldDone = () => _testExports._getFolderReconSessionDone().has('account1:/Cold');
    for (let turn = 0; turn < 120 && !coldDone(); turn++) {
      await settleSchedulerTickWithFakeTimers(installed.fts);
      vi.setSystemTime(Date.now() + SLICE_STEP_MS);
    }

    expect(written).toBeGreaterThan(1);
    expect(installed.nativeRows.has(staleKey)).toBe(false);
    expect(coldDone()).toBe(true);
  }, TRAFFIC_TEST_TIMEOUT_MS);

  // The converse at the same fence: a write that makes the stale row valid
  // again lands after its recheck and before the removal. Attributed to the
  // cold folder (or unattributed) it must refuse the older absence evidence;
  // attributed to another folder it must not.
  it.each([
    { writer: 'self', removed: false },
    { writer: 'wildcard', removed: false },
    { writer: 'other', removed: true },
  ])('a $writer write between the stale recheck and its removal fence: removed=$removed', async ({ writer, removed }) => {
    const installed = seedMigratedExactFolders([
      { folderPath: '/Cold', headerMessageIds: ['cold-1@example.com', 'cold-2@example.com'] },
      { folderPath: '/Hot', headerMessageIds: ['hot-seed@example.com'] },
    ]);
    const [cold, hot] = installed.folders;
    const staleId = 'stale@example.com';
    const staleKey = `account1:/Cold:${staleId}`;
    installed.nativeRows.set(staleKey, cold.folderId);
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (folderURI, ids) => {
      const present = new Set((installed.rowsByURI.get(folderURI) || []).map(row => row.headerMessageId));
      return { missing: ids.filter(id => !present.has(id)) };
    });
    _testExports._setFtsSearch(installed.fts);
    let raced = false;
    recheckMessageInFolder.mockImplementation(async (headerID) => {
      if (headerID === staleId && !raced) {
        raced = true;
        if (writer === 'other') {
          const msgId = 'account1:/Hot:late@example.com';
          await runFtsMembershipMutation(async () => { installed.nativeRows.set(msgId, hot.folderId); }, null,
            { msgIds: [msgId], folderIds: [hot.folderId] });
        } else {
          // The message is back in the cold folder and re-indexed there.
          const rows = installed.rowsByURI.get(cold.folderURI);
          installed.rowsByURI.set(cold.folderURI, [...rows, { ...rows[0], msgKey: 99, headerMessageId: staleId }]);
          const reAdd = async () => { installed.nativeRows.set(staleKey, cold.folderId); };
          if (writer === 'self') {
            await runFtsMembershipMutation(reAdd, null, { msgIds: [staleKey], folderIds: [cold.folderId] });
          } else {
            await runFtsMembershipMutation(reAdd);
          }
        }
      }
      return 'absent';
    });

    const coldDone = () => _testExports._getFolderReconSessionDone().has('account1:/Cold');
    for (let turn = 0; turn < 120 && !coldDone(); turn++) {
      await settleSchedulerTickWithFakeTimers(installed.fts);
      vi.setSystemTime(Date.now() + SLICE_STEP_MS);
    }

    expect(raced).toBe(true);
    // One recheck: the other folder's write never costs the removal a retry,
    // and after a refusal the re-added message is no longer a candidate.
    expect(recheckMessageInFolder.mock.calls.filter(([headerID]) => headerID === staleId)).toHaveLength(1);
    const removedIds = installed.fts.removeBatch.mock.calls.flatMap(([ids]) => ids);
    expect(removedIds.includes(staleKey)).toBe(removed);
    expect(installed.nativeRows.get(staleKey)).toBe(removed ? undefined : cold.folderId);
    expect(coldDone()).toBe(true);
  }, TRAFFIC_TEST_TIMEOUT_MS);

  // A native removal no event announces is a change only the ledger sees.
  // Removing a cold row its digest already covered must restart the cold
  // proof (the row is re-admitted before the folder is done); removing a hot
  // row must not touch it.
  it.each([
    { removedFolder: '/Cold', coldRestarts: true },
    { removedFolder: '/Hot', coldRestarts: false },
  ])('a removal-only native change in $removedFolder during the cold digest: coldRestarts=$coldRestarts', async ({ removedFolder, coldRestarts }) => {
    const cold = Array.from({ length: COLD_ROWS }, (_, i) => `cold-${String(i).padStart(4, '0')}@example.com`);
    const installed = seedMigratedExactFolders([
      { folderPath: '/Cold', headerMessageIds: cold },
      { folderPath: '/Hot', headerMessageIds: ['hot-seed@example.com'] },
    ]);
    const coldFolder = installed.folders[0];
    installRealDrain(installed);
    _testExports._setFtsSearch(installed.fts);
    const removedKey = removedFolder === '/Cold'
      ? `account1:/Cold:${cold[0]}`
      : 'account1:/Hot:hot-seed@example.com';
    const coldCursors = () => installed.fts.listFolderMembership.mock.calls
      .filter(([folderId]) => folderId === coldFolder.folderId)
      .map(([, after]) => after);
    const coldPageReads = () => coldCursors().length;
    const READS_BEFORE_REMOVAL = 3;
    const coldDone = () => _testExports._getFolderReconSessionDone().has('account1:/Cold');

    let removed = false;
    let readsBeforeRemoval = -1;
    let coldDoneWhileMissing = false;
    for (let turn = 0; turn < 600 && !(removed && coldDone()); turn++) {
      if (!removed && coldPageReads() >= READS_BEFORE_REMOVAL) {
        removed = true;
        // A settle may run more than one slice.
        readsBeforeRemoval = coldPageReads();
        // Exactly what the engine's removeBatch wrapper attributes.
        await runFtsMembershipMutation(
          async () => { installed.nativeRows.delete(removedKey); },
          null,
          { msgIds: [removedKey] },
        );
      }
      await settleSchedulerTickWithFakeTimers(installed.fts);
      await flushPendingUpdates();
      vi.setSystemTime(Date.now() + SLICE_STEP_MS);
      if (removedFolder === '/Cold' && coldDone() && !installed.nativeRows.has(removedKey)) {
        coldDoneWhileMissing = true;
      }
    }

    expect(removed).toBe(true);
    expect(coldDone()).toBe(true);
    expect(coldDoneWhileMissing).toBe(false);
    // The first cold read after the removal either resumes or starts over.
    expect(readsBeforeRemoval).toBeLessThan(Math.ceil(COLD_ROWS / reconConfig.membershipListPageSize));
    expect(coldCursors()[readsBeforeRemoval] === null).toBe(coldRestarts);
  }, TRAFFIC_TEST_TIMEOUT_MS);

  // Another folder's event and drained native write also land inside the
  // cold folder's slices, during each of its native reads and each page of
  // its local msgDB scan.
  function trafficInsideColdSlices(installed) {
    let event = 0;
    const counts = { injected: 0, scanPages: 0 };
    const inject = async () => {
      counts.injected++;
      const headerMessageId = `inside-${event++}@example.com`;
      const msgKey = 200_000 + event;
      installed.rowsByURI.get(installed.folders[1].folderURI).push({ msgKey, headerMessageId });
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1',
        folderPath: '/Hot',
        weFolderId: installed.folders[1].weFolderId,
        headerMessageId,
        msgKey,
        eventType: 'msgAdded',
      });
      await flushPendingUpdates();
    };
    for (const name of ['listFolderMembership', 'listMsgIdRange', 'fingerprintMsgIdRange', 'filterNewMessages']) {
      const original = installed.fts[name].getMockImplementation();
      installed.fts[name].mockImplementation(async (...args) => {
        const result = await original(...args);
        if (JSON.stringify(args).includes('/Cold')) await inject();
        return result;
      });
    }
    const coldTokens = new Set();
    const notify = globalThis.browser.tmMsgNotify;
    const begin = notify.beginFolderMessageScan.getMockImplementation();
    notify.beginFolderMessageScan.mockImplementation(async (uri, ...rest) => {
      const started = await begin(uri, ...rest);
      if (uri === installed.folders[0].folderURI) coldTokens.add(started.token);
      return started;
    });
    const readPage = notify.readFolderMessageScanPage.getMockImplementation();
    notify.readFolderMessageScanPage.mockImplementation(async (token, ...rest) => {
      const page = await readPage(token, ...rest);
      if (coldTokens.has(token)) {
        counts.scanPages++;
        await inject();
      }
      return page;
    });
    return counts;
  }

  it('repairs and completes the cold folder when the other folder\'s writes land inside its slices', async () => {
    const installed = seedColdAndHot();
    const cold = installed.folders[0];
    const inside = trafficInsideColdSlices(installed);
    _testExports._setFtsSearch(installed.fts);

    const repaired = () => installed.nativeRows.get(installed.missingKey) === cold.folderId
      && _testExports._getFolderReconSessionDone().has(`account1:${cold.folderPath}`);
    expect(await underTraffic(installed, repaired)).toBe(true);
    expect(inside.injected).toBeGreaterThan(COLD_ROWS / reconConfig.membershipListPageSize);
    expect(inside.scanPages).toBeGreaterThan(COLD_ROWS / reconConfig.folderScanPageSize);
  }, TRAFFIC_TEST_TIMEOUT_MS);

  it('control: the same traffic aimed at the cold folder itself keeps restarting its proof', async () => {
    const installed = seedColdAndHot();
    const cold = installed.folders[0];
    _testExports._setFtsSearch(installed.fts);

    const done = () => _testExports._getFolderReconSessionDone().has(`account1:${cold.folderPath}`);
    // Bounded window: the folder's own changes keep invalidating its pages.
    const windowEnd = Date.now() + 5 * 60_000;
    expect(await underTraffic(installed, () => done() || Date.now() >= windowEnd, '/Cold')).toBe(true);
    expect(done()).toBe(false);
  }, TRAFFIC_TEST_TIMEOUT_MS);

  it('treats another folder\'s unconverted events as changes to every folder', async () => {
    const installed = seedColdAndHot();
    const cold = installed.folders[0];
    _testExports._setFtsSearch(installed.fts);

    const done = () => _testExports._getFolderReconSessionDone().has(`account1:${cold.folderPath}`);
    // Such an event cannot be attributed to an inventory folder.
    const windowEnd = Date.now() + 5 * 60_000;
    expect(await underTraffic(installed, () => done() || Date.now() >= windowEnd, '/Hot', { unconverted: true })).toBe(true);
    expect(done()).toBe(false);
  }, TRAFFIC_TEST_TIMEOUT_MS);

  // The local ledger is capped; an evicted touch raises the floor, so a
  // proof stamped before it is refused rather than trusted.
  it('refuses a local stamp older than an evicted touch of its folder, and trusts a newer one', () => {
    const cold = 'account1:/Cold';
    const old = _testExports._folderReconLocalScope(cold);
    _testExports._noteFolderReconLocalChange(cold);
    for (let i = 0; i < _testExports.FOLDER_RECON_CHANGE_LEDGER_CAP; i++) {
      _testExports._noteFolderReconLocalChange(`account1:/Busy-${i}`);
    }
    expect(_testExports._folderReconLocalUnchangedSince(cold, old.since)).toBe(false);
    const fresh = _testExports._folderReconLocalScope(cold);
    expect(_testExports._folderReconLocalUnchangedSince(cold, fresh.since)).toBe(true);
    // A retained touch of another folder does not refuse the newer stamp.
    _testExports._noteFolderReconLocalChange('account1:/Busy-0');
    expect(_testExports._folderReconLocalUnchangedSince(cold, fresh.since)).toBe(true);
  });

  // The operation's last own local check precedes its checkpoint write and
  // the scheduler's memo reload. A removal whose Message-ID Thunderbird could
  // not read invalidates local evidence but queues nothing, so only the
  // session-done grant can keep the folder from being skipped.
  describe('a message event after the operation\'s last own check', () => {
    const memoKey = () => _testExports.FOLDER_RECON_STORAGE_KEY;
    const removedKey = 'account1:/A:a-2@example.com';

    function seedTwoFolders() {
      const installed = seedMigratedExactFolders([
        { folderPath: '/A', headerMessageIds: ['a-1@example.com', 'a-2@example.com'] },
        { folderPath: '/B', headerMessageIds: ['b-1@example.com'] },
      ]);
      // The msgDB probe reflects the folder's current headers.
      globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (folderURI, ids) => {
        const present = new Set((installed.rowsByURI.get(folderURI) || []).map(row => row.headerMessageId));
        return { missing: ids.filter(id => !present.has(id)) };
      });
      return installed;
    }

    // /A loses a-2 from its msgDB; the event names /A but carries no
    // Message-ID. An event in /B is the same shape in another folder.
    function removalEvent(installed, folderPath) {
      const folder = installed.folders.find(item => item.folderPath === folderPath);
      if (folderPath === '/A') {
        const rows = installed.rowsByURI.get(folder.folderURI);
        rows.splice(rows.findIndex(row => row.headerMessageId === 'a-2@example.com'), 1);
      }
      return _testExports.onExperimentMessageRemoved({
        accountId: 'account1',
        folderPath,
        weFolderId: folder.weFolderId,
        headerMessageId: '',
        msgKey: 2,
        eventType: 'msgDeleted',
      });
    }

    const aVerifiedIn = value => value?.[memoKey()]?.folders?.['account1:/A']?.verified === true;

    // Fires once: during /A's verified checkpoint write ('write'), or during
    // the scheduler's memo reload right after it ('reload').
    function fireAfterLastCheck(installed, boundary, folderPath) {
      const fired = { tick: null };
      const storage = globalThis.browser.storage.local;
      if (boundary === 'write') {
        const set = storage.set.getMockImplementation();
        storage.set.mockImplementation(async (value) => {
          const result = await set(value);
          if (fired.tick === null && aVerifiedIn(value)) {
            fired.tick = 'pending';
            await removalEvent(installed, folderPath);
          }
          return result;
        });
      } else {
        const get = storage.get.getMockImplementation();
        storage.get.mockImplementation(async (keys) => {
          if (fired.tick === null && aVerifiedIn(storageData)
              && JSON.stringify(keys ?? null).includes(memoKey())) {
            fired.tick = 'pending';
            await removalEvent(installed, folderPath);
          }
          return get(keys);
        });
      }
      return fired;
    }

    async function tickUntilFired(fts, fired) {
      for (let turn = 0; turn < 30 && fired.tick === null; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }
      expect(fired.tick).toBe('pending');
    }

    it.each(['write', 'reload'])('withholds completion from the folder and repairs it (event during the %s)', async (boundary) => {
      const installed = seedTwoFolders();
      const fired = fireAfterLastCheck(installed, boundary, '/A');
      _testExports._setFtsSearch(installed.fts);

      await tickUntilFired(installed.fts, fired);
      expect(_testExports._getFolderReconSessionDone().has('account1:/A')).toBe(false);
      expect(_testExports._getPendingUpdates().size).toBe(0);

      const result = await tickUntil(installed.fts, value => value?.complete === true, 60);
      expect(result).toMatchObject({ complete: true });
      expect(installed.nativeRows.has(removedKey)).toBe(false);
      expect(installed.nativeRows.get('account1:/A:a-1@example.com')).toBe(installed.folders[0].folderId);
    });

    it.each(['write', 'reload'])('control: another folder\'s event during the %s keeps the completion', async (boundary) => {
      const installed = seedTwoFolders();
      const fired = fireAfterLastCheck(installed, boundary, '/B');
      _testExports._setFtsSearch(installed.fts);

      await tickUntilFired(installed.fts, fired);
      expect(_testExports._getFolderReconSessionDone().has('account1:/A')).toBe(true);
    });

    // A native write (the real engine wrapper) during the memo reload moves
    // the global membership epoch. Only a write to /A's own key range may
    // withhold /A's earned completion.
    it.each(['/A', '/B'])('a native write in %s during the memo reload withholds only its own folder\'s completion', async (writerPath) => {
      const installed = seedTwoFolders();
      installRealDrain(installed);
      _testExports._setFtsSearch(installed.fts);
      const writer = installed.folders.find(folder => folder.folderPath === writerPath);
      const headerMessageId = 'late-native@example.com';
      const msgId = `account1:${writerPath}:${headerMessageId}`;
      const fired = { tick: null };
      const storage = globalThis.browser.storage.local;
      const get = storage.get.getMockImplementation();
      storage.get.mockImplementation(async (keys) => {
        if (fired.tick === null && aVerifiedIn(storageData)
            && JSON.stringify(keys ?? null).includes(memoKey())) {
          fired.tick = 'pending';
          installed.rowsByURI.get(writer.folderURI).push({ msgKey: 100, headerMessageId });
          await installed.fts.indexBatch([{ msgId, folderId: writer.folderId }]);
        }
        return get(keys);
      });

      await tickUntilFired(installed.fts, fired);
      expect(installed.nativeRows.get(msgId)).toBe(writer.folderId);
      expect(_testExports._getPendingUpdates().size).toBe(0);
      expect(_testExports._getFolderReconSessionDone().has('account1:/A')).toBe(writerPath === '/B');

      // The withheld folder is proved again and completes.
      const result = await tickUntil(installed.fts, value => value?.complete === true, 60);
      expect(result).toMatchObject({ complete: true });
      expect(_testExports._getFolderReconSessionDone().has('account1:/A')).toBe(true);
      expect(installed.nativeRows.get(msgId)).toBe(writer.folderId);
    });
  });
});

// A queued add that first failed to resolve is retried; a removal of the
// same message delivered while the retry reads its header is the newer
// intention and must survive the retry's bookkeeping, so the index ends
// without the message once the queue drains and reconciliation completes.
describe('a newer queued intention during a drain retry', () => {
  // The drain's stuck-queue counter is module state; an earlier test must
  // not leave it near the abandonment threshold.
  beforeEach(() => _testExports._setConsecutiveNoProgressCycles(0));
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // Body extraction runs after an await; a removal queued meanwhile is a
  // newer intention the older add's failure must not mark.
  it('an older add whose body extraction fails leaves a newer removal unmarked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders } = seedMigratedExactFolders([{ folderPath: '/A', headerMessageIds: [] }]);
    const folder = folders[0];
    const key = 'account1:/A:b@example.com';
    const event = {
      accountId: 'account1', folderPath: '/A', weFolderId: folder.weFolderId,
      headerMessageId: 'b@example.com', msgKey: 2, eventType: 'msgAdded',
    };
    _testExports._setFtsSearch(fts);
    headerIDToWeID.mockResolvedValue(2);
    globalThis.browser.messages.get = vi.fn(async () => ({
      id: 2, headerMessageId: 'b@example.com', folder: { accountId: 'account1', path: '/A' },
    }));
    getUniqueMessageKey.mockImplementation(async header => `account1:${header.folder.path}:${header.headerMessageId}`);
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: `account1:${header.folder.path}:${header.headerMessageId}`,
      folderId: makeFolderMembershipId('account1', header.folder.path),
    })));
    await _testExports.onExperimentMessageAdded(event);
    expect(_testExports._getPendingUpdates().get(key)?.type).toBe('new');
    let removedQueued = false;
    populateBatchBody.mockImplementation(async rows => {
      vi.setSystemTime(Date.now() + 5);
      await _testExports.onExperimentMessageRemoved({ ...event, eventType: 'msgDeleted' });
      removedQueued = true;
      return { successfulRows: [], failedMsgIds: rows.map(row => row.msgId) };
    });
    vi.setSystemTime(Date.now() + 1000);
    await flushPendingUpdates();

    expect(removedQueued).toBe(true);
    const current = _testExports._getPendingUpdates().get(key);
    expect(current?.type).toBe('deleted');
    expect(current?.hasFailed).toBeUndefined();
  });

  // The retry bookkeeping keeps the entry the drain captured, so an add whose
  // body extraction failed once is dequeued once its retry indexes it.
  it('dequeues a failed add once its retry indexes it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows } = seedMigratedExactFolders([{ folderPath: '/A', headerMessageIds: [] }]);
    const key = 'account1:/A:b@example.com';
    fts.indexBatch = vi.fn(async rows => {
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    _testExports._setFtsSearch(fts);
    headerIDToWeID.mockResolvedValue(2);
    globalThis.browser.messages.get = vi.fn(async () => ({
      id: 2, headerMessageId: 'b@example.com', folder: { accountId: 'account1', path: '/A' },
    }));
    getUniqueMessageKey.mockImplementation(async header => `account1:${header.folder.path}:${header.headerMessageId}`);
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: `account1:${header.folder.path}:${header.headerMessageId}`,
      folderId: makeFolderMembershipId('account1', header.folder.path),
    })));
    populateBatchBody
      .mockImplementationOnce(async rows => ({ successfulRows: [], failedMsgIds: rows.map(row => row.msgId) }))
      .mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    await _testExports.onExperimentMessageAdded({
      accountId: 'account1', folderPath: '/A', weFolderId: folders[0].weFolderId,
      headerMessageId: 'b@example.com', msgKey: 2, eventType: 'msgAdded',
    });

    vi.setSystemTime(Date.now() + 1000);
    await flushPendingUpdates();
    expect(_testExports._getPendingUpdates().get(key)?.hasFailed).toBe(true);
    vi.setSystemTime(Date.now() + 1000);
    await flushPendingUpdates();

    expect(nativeRows.get(key)).toBe(folders[0].folderId);
    expect(_testExports._getPendingUpdates().has(key)).toBe(false);
  });

  it.each([false, true])('ends with the index agreeing with the latest event; removed during the retry=%s', async (removedDuringRetry) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const installed = seedMigratedExactFolders([{ folderPath: '/A', headerMessageIds: ['a@example.com'] }]);
    const { fts, folders, nativeRows, rowsByURI } = installed;
    const folder = folders[0];
    const key = 'account1:/A:b@example.com';
    const event = {
      accountId: 'account1',
      folderPath: '/A',
      weFolderId: folder.weFolderId,
      headerMessageId: 'b@example.com',
      msgKey: 2,
      eventType: 'msgAdded',
    };
    _testExports._setFtsSearch(fts);
    fts.indexBatch = vi.fn(async rows => runFtsMembershipMutation(async () => {
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    }, null, { msgIds: rows.map(row => row.msgId), folderIds: rows.map(row => row.folderId) }));
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => ({
      missing: ids.filter(id => !rowsByURI.get(uri).some(row => row.headerMessageId === id)),
    }));
    // The add lands after /A's verified checkpoint write.
    const storage = globalThis.browser.storage.local;
    const set = storage.set.getMockImplementation();
    let added = false;
    storage.set.mockImplementation(async value => {
      const result = await set(value);
      if (!added && value[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders?.['account1:/A']?.verified === true) {
        added = true;
        // No drain of the add, timer-driven or explicit, resolves it until
        // the retry below.
        headerIDToWeID.mockResolvedValue(null);
        rowsByURI.get(folder.folderURI).push({ msgKey: 2, headerMessageId: 'b@example.com' });
        await _testExports.onExperimentMessageAdded(event);
      }
      return result;
    });
    await tickUntil(fts, () => added, 20);
    expect(added).toBe(true);
    const queuedAdd = _testExports._getPendingUpdates().get(key);
    expect(queuedAdd.type).toBe('new');

    // The first drain cannot resolve the message.
    vi.setSystemTime(Date.now() + 1000);
    await flushPendingUpdates();
    expect(_testExports._getPendingUpdates().get(key).hasFailed).toBe(true);

    // The retry resolves it; the removal is delivered while its header read
    // is in flight, and the read returns the header it captured before.
    headerIDToWeID.mockResolvedValue(2);
    globalThis.browser.messages.get = vi.fn(async () => {
      const captured = { id: 2, headerMessageId: 'b@example.com', folder: { accountId: 'account1', path: '/A' } };
      if (removedDuringRetry && rowsByURI.get(folder.folderURI).length > 1) {
        rowsByURI.get(folder.folderURI).splice(1, 1);
        await _testExports.onExperimentMessageRemoved({ ...event, eventType: 'msgDeleted' });
        expect(_testExports._getPendingUpdates().get(key).timestamp).toBeGreaterThan(queuedAdd.timestamp);
      }
      return captured;
    });
    getUniqueMessageKey.mockImplementation(async header => `account1:/A:${header.headerMessageId}`);
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: `account1:/A:${header.headerMessageId}`,
      folderId: folder.folderId,
    })));
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    for (let turn = 0; turn < 4 && _testExports._getPendingUpdates().size > 0; turn++) {
      vi.setSystemTime(Date.now() + 1000);
      await flushPendingUpdates();
    }
    expect(_testExports._getPendingUpdates().size).toBe(0);

    const result = await tickUntil(fts, value => value?.complete === true, 40);
    expect(result).toMatchObject({ complete: true });
    expect(nativeRows.has(key)).toBe(!removedDuringRetry);
    expect(nativeRows.get('account1:/A:a@example.com')).toBe(folder.folderId);
  });

  // Two events for one message can share a millisecond: Date.now() is a
  // time value, not a unique intention number. A drain still finishing the
  // first must leave the opposite, newer intention queued.
  it.each(['added then removed', 'removed then added'])('honours an opposite intention queued in the same millisecond: %s', async (direction) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const installed = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds: ['live@example.com'] }]);
    const { fts, folders, nativeRows, rowsByURI } = installed;
    await tickUntil(fts, value => value?.complete === true, 40);
    expect(_testExports._getFolderReconSessionDone().has('account1:/F')).toBe(true);
    const folder = folders[0];
    const key = 'account1:/F:live@example.com';
    const event = {
      accountId: 'account1',
      folderPath: '/F',
      weFolderId: folder.weFolderId,
      headerMessageId: 'live@example.com',
      msgKey: 1,
      eventType: 'msgAdded',
    };
    _testExports._setFtsSearch(fts);
    headerIDToWeID.mockResolvedValue(1);
    globalThis.browser.messages.get = vi.fn(async () => ({
      id: 1,
      headerMessageId: event.headerMessageId,
      folder: { accountId: 'account1', path: '/F' },
    }));
    getUniqueMessageKey.mockResolvedValue(key);
    buildBatchHeader.mockResolvedValue([{ msgId: key, folderId: folder.folderId }]);
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    fakeNativeFts.indexBatch.mockImplementation(async rows => {
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;
    const adding = direction === 'added then removed';
    const remove = async () => {
      rowsByURI.set(folder.folderURI, []);
      await _testExports.onExperimentMessageRemoved({ ...event, eventType: 'msgDeleted' });
    };
    const add = async () => {
      rowsByURI.set(folder.folderURI, [{ msgKey: 1, headerMessageId: event.headerMessageId }]);
      await _testExports.onExperimentMessageAdded(event);
    };
    if (adding) await add();
    else await remove();
    const first = _testExports._getPendingUpdates().get(key);
    // The second event lands while the drain checks the native index for
    // the first, in the same millisecond.
    const read = fts.getMessageByMsgId.getMockImplementation();
    let replacement = null;
    fts.getMessageByMsgId.mockImplementation(async id => {
      const answer = await read(id);
      if (id === key && !replacement) {
        if (adding) await remove();
        else await add();
        replacement = _testExports._getPendingUpdates().get(key);
      }
      return answer;
    });

    await flushPendingUpdates();
    expect(replacement?.timestamp).toBe(first.timestamp);
    expect(replacement?.type).not.toBe(first.type);
    for (let turn = 0; turn < 4 && _testExports._getPendingUpdates().size > 0; turn++) {
      vi.setSystemTime(Date.now() + 1000);
      await flushPendingUpdates();
    }
    expect(_testExports._getPendingUpdates().size).toBe(0);

    const result = await tickUntil(fts, value => value?.complete === true, 40);
    expect(result).toMatchObject({ complete: true });
    expect(nativeRows.has(key)).toBe(!adding);
  });
});

// Classification cost: one hashed msgDB Message-ID lookup per candidate
// reading, never a WebExtension query (Thunderbird answers a folder-scoped
// `messages.query` by walking the whole folder, so a per-row query made the
// migration quadratic in folder size).
describe('membership assignment msgDB probe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('classifies every ownerless row with one probe of its folder and no message query', async () => {
    const headerMessageIds = Array.from({ length: reconConfig.membershipStatePageSize + 3 },
      (_, index) => `probed-${String(index).padStart(4, '0')}@example.com`);
    const { fts, nativeRows, folders } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds },
    ]);
    for (const id of headerMessageIds) nativeRows.set(`account1:/F:${id}`, null);
    globalThis.browser.tmMsgNotify.probeMessageIds.mockClear();
    globalThis.browser.tmMsgNotify.getFolderState.mockClear();

    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());

    for (const id of headerMessageIds) expect(nativeRows.get(`account1:/F:${id}`)).toBe(folders[0].folderId);
    const probes = globalThis.browser.tmMsgNotify.probeMessageIds.mock.calls;
    expect(probes.map(([, ids]) => ids[0]).sort()).toEqual(headerMessageIds);
    expect(probes.every(([uri, ids]) => uri === folders[0].folderURI && ids.length === 1)).toBe(true);
    // The folder's URI is resolved once per state page, not once per row.
    const stateReads = globalThis.browser.tmMsgNotify.getFolderState.mock.calls
      .filter(([, folderPath]) => folderPath === '/F').length;
    expect(stateReads).toBeLessThan(headerMessageIds.length);
    expect(globalThis.browser.messages.query).not.toHaveBeenCalled();
    expect(recheckMessageInFolder).not.toHaveBeenCalled();
  });

  it('retries a row whose probe is interrupted by an event in its folder, then assigns it', async () => {
    const { fts, nativeRows, folders } = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds: [] }]);
    const row = 'account1:/F:probed@example.com';
    nativeRows.set(row, null);
    let interrupted = false;
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async () => {
      if (!interrupted) {
        interrupted = true;
        // A real Thunderbird event lands while the probe is in flight.
        await _testExports.onExperimentMessageAdded({
          accountId: 'account1', folderPath: '/F', headerMessageId: 'other@example.com', msgKey: 9, eventType: 'msgAdded',
        });
        _testExports._getPendingUpdates().clear();
      }
      return { missing: [], uncertain: [] };
    });

    const first = await settleSchedulerTickWithFakeTimers(fts);
    expect(first).toMatchObject({ complete: false, migration: { membershipStateProgress: true } });
    expect(_testExports._getFolderReconRuntimeTelemetry().membershipStatePageRetries).toBe(1);
    expect(nativeRows.get(row)).toBeNull();
    expect(recheckMessageInFolder).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 100);
    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(nativeRows.get(row)).toBe(folders[0].folderId);
  });
});

// INVARIANT (2026-10-04, R6): migration never holds per-folder repair behind
// other folders' failures or traffic. An eager per-folder metadata scan ahead
// of the membership-state pass used to: many folders failing at the error
// cadence, or a busy folder invalidated between scan slices, kept the
// scheduler in migration forever and a healthy folder's missing row was
// never enqueued. Only production timers drive the first schedule.
describe('migration never starves a healthy folder\'s repair', () => {
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('repairs a healthy folder while many folders keep failing at the scheduled error cadence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    // Enough folders that the first is due again before the last is reached.
    const failingFolders = Math.ceil(
      _testExports.FOLDER_RECON_GENERIC_FAILURE_BACKOFF_MAX_MS / reconConfig.errorDelayMs) + 1;
    // The failing folders come first in the round-robin, so each is tried
    // before the healthy one.
    const { fts, folders, nativeRows, rowsByURI } = seedMigratedExactFolders([
      ...Array.from({ length: failingFolders }, (_, i) => ({
        folderPath: `/Bad${String(i).padStart(3, '0')}`,
        headerMessageIds: [],
      })),
      { folderPath: '/Z', headerMessageIds: [] },
    ]);
    const healthy = folders.at(-1);
    _testExports._setFtsSearch(fts);
    const missing = 'account1:/Z:missing@example.com';
    rowsByURI.get(healthy.folderURI).push({ msgKey: 1, headerMessageId: 'missing@example.com' });
    await _testExports.onExperimentMessageAdded({
      accountId: 'account1', folderPath: '/Z', weFolderId: healthy.weFolderId,
      headerMessageId: 'missing@example.com', msgKey: 1, eventType: 'msgAdded',
    });
    // The real producer of a dropped addition: a queue-stuck abandonment.
    expect((await abandonAllQueued()).dropped).toBe(1);
    expect(_testExports._getPendingUpdates().size).toBe(0);
    const state = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath, options) =>
      (folderPath.startsWith('/Bad')
        ? { accountId, folderPath, error: 'folder_db_unavailable' }
        : state(accountId, folderPath, options)));

    const deadlineMs = Date.now() + 60 * 60_000;
    while (!_testExports._getPendingUpdates().has(missing) && Date.now() < deadlineMs) {
      await vi.advanceTimersByTimeAsync(reconConfig.errorDelayMs);
      await settleInFlightSchedulerTickWithFakeTimers();
    }

    expect(_testExports._getPendingUpdates().has(missing)).toBe(true);
    expect(nativeRows.has(missing)).toBe(false);
    expect(fts.listFolderMembershipState).toHaveBeenCalled();
    const failedFolders = new Set(globalThis.browser.tmMsgNotify.getFolderState.mock.calls
      .map(([, folderPath]) => folderPath)
      .filter(folderPath => folderPath.startsWith('/Bad')));
    expect(failedFolders.size).toBe(failingFolders);
  }, 60_000);

  it('repairs a healthy folder while a busy folder is written between every slice', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, rowsByURI } = seedMigratedExactFolders([
      {
        folderPath: '/Busy',
        headerMessageIds: Array.from({ length: 3 * reconConfig.folderScanPageSize + 1 },
          (_, i) => `busy-${i}@example.com`),
      },
      { folderPath: '/A', headerMessageIds: ['missing@example.com'] },
    ]);
    const missing = 'account1:/A:missing@example.com';
    nativeRows.delete(missing);
    _testExports._setFtsSearch(fts);
    let currentHeader;
    headerIDToWeID.mockResolvedValue(1);
    globalThis.browser.messages.get = vi.fn(async () => currentHeader);
    getUniqueMessageKey.mockImplementation(async header =>
      `account1:${header.folder.path}:${header.headerMessageId}`);
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: `account1:${header.folder.path}:${header.headerMessageId}`,
      folderId: folders[0].folderId,
    })));
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    fakeNativeFts.indexBatch.mockImplementation(async rows => {
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;

    let arrivals = 0;
    for (let turn = 0; turn < 200 && !_testExports._getPendingUpdates().has(missing); turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      if (_testExports._getPendingUpdates().has(missing)) break;
      // A converted arrival in /Busy, fully drained before the next slice.
      const headerMessageId = `arrival-${turn}@example.com`;
      rowsByURI.get(folders[0].folderURI).push({ msgKey: 10_000 + turn, headerMessageId });
      currentHeader = { id: 1, headerMessageId, folder: { accountId: 'account1', path: '/Busy' } };
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: '/Busy', weFolderId: folders[0].weFolderId,
        headerMessageId, msgKey: 10_000 + turn, eventType: 'msgAdded',
      });
      await flushPendingUpdates();
      expect(_testExports._getPendingUpdates().size).toBe(0);
      arrivals++;
      vi.setSystemTime(Date.now() + reconConfig.paceDelayMs);
    }

    expect(_testExports._getPendingUpdates().has(missing)).toBe(true);
    expect(fts.listFolderMembershipState).toHaveBeenCalled();
    expect(arrivals).toBeGreaterThan(0);
  }, 30_000);
});

// A message drained inside a test can wake a timer-driven scheduler tick that
// is still running when the test ends; settle it before the next test's
// reset, or its teardown spends that test's native page budget.
async function quiesceFolderReconAfterTest() {
  _testExports._setIsEnabled(false);
  for (let turn = 0; turn < 50 && _testExports._isFolderReconSchedulerActive(); turn++) {
    await vi.advanceTimersByTimeAsync(_testExports.FOLDER_RECON_CHUNK_DELAY_MS);
    await yieldToRealEventLoop();
  }
  expect(_testExports._isFolderReconSchedulerActive()).toBe(false);
  vi.clearAllTimers();
  vi.useRealTimers();
}

// INVARIANT (2026-10-04, R7): an ownerless row's verdict depends only on its
// candidate folders' messages, so mail delivered to any other folder while
// the row is being classified — even inside every query — neither voids the
// verdict nor holds the pass (and every folder's reconciliation behind it).
// An event in a candidate folder still voids the row, and a removal still
// yields to an event in the removed row's candidate folders or a folder event.
describe('ownerless-row verdicts read only their candidate folders\' events', () => {
  afterEach(quiesceFolderReconAfterTest);

  // Mail drained in another folder raises foreground pressure in bursts.
  // Pressure may interrupt a page's classification at any row; the rows
  // already classified are committed before the slice yields, so the pass
  // completes between bursts shorter than a page.
  it.each([0, 20])('assigns every row and earns cutover under recurring foreground pressure (%i ghost rows)', async (ghosts) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const PERIOD_MS = 200;
    const BUSY_MS = 40;
    const READ_MS = 5;
    const ids = Array.from({ length: 40 }, (_, i) => `m-${String(i).padStart(3, '0')}@example.com`);
    const { fts, folders, nativeRows } = installExactMembershipFolders([
      { folderPath: '/F', headerMessageIds: ids },
      { folderPath: '/Other', headerMessageIds: [] },
    ]);
    const ghostKeys = Array.from({ length: ghosts }, (_, i) => `account1:/F:gone-${String(i).padStart(3, '0')}@example.com`);
    for (const key of ghostKeys) nativeRows.set(key, null);
    _testExports._setFtsSearch(fts);
    const startedAt = Date.now();
    getForegroundFetchPressure.mockImplementation(() => ({
      active: (Date.now() - startedAt) % PERIOD_MS < BUSY_MS ? 1 : 0, waiting: 0, chatTyping: false,
    }));
    // Every Thunderbird read takes time, so pressure lands mid-page.
    const slow = fn => vi.fn(async (...args) => {
      await new Promise(resolve => setTimeout(resolve, READ_MS));
      return fn(...args);
    });
    const notify = globalThis.browser.tmMsgNotify;
    for (const name of ['readFolderMessageScanPage', 'beginFolderMessageScan', 'getFolderState', 'probeMessageIds']) {
      notify[name] = slow(notify[name].getMockImplementation());
    }
    let pressuredSlices = 0;
    // Counts only ticks that did scheduler work (a floor-skipped tick under a
    // loaded event loop is not a turn).
    for (let work = 0, guard = 0; work < 80 && guard < 1600
      && !_testExports._getFolderMembershipCleanupProven(); guard++) {
      const result = await settleSchedulerTickWithFakeTimers(fts);
      if (JSON.stringify(result ?? null).includes('pressure')) pressuredSlices++;
      if (!isSkippedTick(result)) work++;
      vi.setSystemTime(Date.now() + 37);
    }

    expect(pressuredSlices).toBeGreaterThan(0);
    expect(ids.every(id => nativeRows.get(`account1:/F:${id}`) === folders[0].folderId)).toBe(true);
    expect(ghostKeys.filter(key => nativeRows.has(key))).toEqual([]);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
  }, 60_000);

  // INVARIANT (stage 3b): a verdict is voided only by an event on its row's
  // own raw key (or a keyless event in its folder), never by other mail in
  // its candidate folder. A voided row is refused and counted as unresolved
  // debt — the page continues — and the delayed replay classifies it again
  // in-session. during: the row's msgDB probe, or (after a failed probe) its
  // global recheck, whose refusal happens at classification.
  it.each([
    { eventKey: 'other@example.com', label: 'other@example.com', during: 'probe', refused: false },
    { eventKey: 'cold@example.com', label: 'cold@example.com', during: 'probe', refused: true },
    { eventKey: '<cold@example.com>', label: '<cold@example.com>', during: 'probe', refused: true },
    { eventKey: undefined, label: 'no key', during: 'probe', refused: true },
    { eventKey: 'other@example.com', label: 'other@example.com', during: 'recheck', refused: false },
    { eventKey: 'cold@example.com', label: 'cold@example.com', during: 'recheck', refused: true },
    { eventKey: undefined, label: 'no key', during: 'recheck', refused: true },
  ])('a verdict read across an event for $label in its candidate folder during its $during: refused=$refused', async ({ eventKey, during, refused }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['cold@example.com'] },
      { folderPath: '/Other', headerMessageIds: [] },
    ]);
    const cold = 'account1:/F:cold@example.com';
    const later = 'account1:/Other:later@example.com';
    nativeRows.set(cold, null);
    nativeRows.set(later, null);
    _testExports._setFtsSearch(fts);
    let fired = false;
    const fire = async () => {
      fired = true;
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: '/F', weFolderId: folders[0].weFolderId,
        headerMessageId: eventKey, msgKey: 77, eventType: 'msgAdded',
      });
      _testExports._getPendingUpdates().clear();
    };
    recheckMessageInFolder.mockImplementation(async (headerId, weFolder) => {
      if (during === 'recheck' && !fired && headerId === 'cold@example.com') await fire();
      return weFolder?.path === '/F' && headerId === 'cold@example.com' ? 'present' : 'absent';
    });
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      if (!ids.includes('cold@example.com')) return probe(uri, ids);
      if (during === 'recheck') return { missing: [], error: 'db_unavailable' };
      if (!fired) await fire();
      return probe(uri, ids);
    });

    const first = await settleSchedulerTickWithFakeTimers(fts);

    expect(fired).toBe(true);
    const telemetry = _testExports._getFolderReconRuntimeTelemetry();
    // The page is never cut: the later row's ghost is removed either way.
    expect(telemetry.membershipStatePageRetries).toBe(0);
    expect(nativeRows.has(later)).toBe(false);
    if (!refused) {
      expect(nativeRows.get(cold)).toBe(folders[0].folderId);
      expect(telemetry.membershipStateRowsRefused).toBe(0);
      return;
    }
    expect(nativeRows.get(cold)).toBeNull();
    expect(telemetry.membershipStateRowsRefused).toBe(1);
    expect(first).toMatchObject({ migration: { restart: true, reason: 'unresolved_legacy_rows' } });
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    // The delayed replay assigns it once its evidence stands.
    vi.setSystemTime(Date.now() + reconConfig.membershipUnresolvedRetryMs);
    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(nativeRows.get(cold)).toBe(folders[0].folderId);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
  });

  // during: the row's msgDB probe, or (after a failed probe) its global
  // recheck. Mail drained into the row's own folder on other keys does not
  // void its verdict (stage 3b; before it, every own-folder arrival did, so
  // steady mail starved the row).
  it.each([
    { eventFolder: '/Other', during: 'probe', assigned: true },
    { eventFolder: '/F', during: 'probe', assigned: true },
    { eventFolder: '/Other', during: 'recheck', assigned: true },
    { eventFolder: '/F', during: 'recheck', assigned: true },
  ])('classifies an ownerless row while mail is drained into $eventFolder inside every $during: assigned=$assigned', async ({ eventFolder, during, assigned }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, rowsByURI } = seedMigratedExactFolders([
      { folderPath: '/A', headerMessageIds: ['missing@example.com'] },
      { folderPath: '/F', headerMessageIds: ['cold@example.com'] },
      { folderPath: '/Other', headerMessageIds: [] },
    ]);
    const cold = 'account1:/F:cold@example.com';
    const missing = 'account1:/A:missing@example.com';
    nativeRows.set(cold, null);
    nativeRows.delete(missing);
    _testExports._setFtsSearch(fts);
    const busy = folders.find(folder => folder.folderPath === eventFolder);
    let currentHeader;
    headerIDToWeID.mockResolvedValue(1);
    globalThis.browser.messages.get = vi.fn(async () => currentHeader);
    getUniqueMessageKey.mockImplementation(async header =>
      `account1:${header.folder.path}:${header.headerMessageId}`);
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: `account1:${header.folder.path}:${header.headerMessageId}`,
      folderId: makeFolderMembershipId('account1', header.folder.path),
    })));
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    fakeNativeFts.indexBatch.mockImplementation(async rows => {
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    let arrivals = 0;
    // A real arrival, fully drained.
    const arrive = async () => {
      const headerMessageId = `arrival-${arrivals++}@example.com`;
      rowsByURI.get(busy.folderURI).push({ msgKey: 10_000 + arrivals, headerMessageId });
      currentHeader = { id: 1, headerMessageId, folder: { accountId: 'account1', path: busy.folderPath } };
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: busy.folderPath, weFolderId: busy.weFolderId,
        headerMessageId, msgKey: 10_000 + arrivals, eventType: 'msgAdded',
      });
      await flushPendingUpdates();
    };
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      if (during === 'recheck') return { missing: [], error: 'db_unavailable' };
      await arrive();
      return probe(uri, ids);
    });
    recheckMessageInFolder.mockImplementation(async (headerId, weFolder) => {
      await arrive();
      return weFolder?.path === '/F' && headerId === 'cold@example.com' ? 'present' : 'absent';
    });

    for (let turn = 0; turn < 40 && !_testExports._getPendingUpdates().has(missing); turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + reconConfig.paceDelayMs);
    }

    expect(arrivals).toBeGreaterThan(0);
    expect(assigned).toBe(true);
    expect(nativeRows.get(cold)).toBe(folders[1].folderId);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(_testExports._getPendingUpdates().has(missing)).toBe(true);
    const telemetry = _testExports._getFolderReconRuntimeTelemetry();
    expect(telemetry.membershipStatePageRetries).toBe(0);
    expect(telemetry.membershipStateRowsRefused).toBe(0);
  }, 30_000);

  // INVARIANT (2026-10-04, key-scoped in stage 3b): a membership write by
  // someone else since the inventory refuses only the removal of a key it
  // attempted (that row is unresolved debt); a write on another key in the
  // ghost's folder does not. A write whose keys are unknown passes the key
  // ledger's floor, so the fence refuses the whole page before any of its
  // assignments commit, and the page is re-read whole.
  it.each([
    { writer: 'keyless', outcome: 'page_retry' },
    { writer: 'other key', outcome: 'removed' },
    { writer: 'ghost key', outcome: 'row_refused' },
  ])('a foreign membership write on the ghost\'s folder since the inventory: writer=$writer', async ({ writer, outcome }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['live@example.com'] },
    ]);
    const ghost = 'account1:/F:ghost@example.com';
    const live = 'account1:/F:live@example.com';
    nativeRows.set(ghost, null);
    nativeRows.set(live, null);
    const list = fts.listFolderMembershipState.getMockImplementation();
    const scope = {
      keyless: [folders[0].folderId],
      'other key': { folderIds: [folders[0].folderId], keys: ['account1:/F:other@example.com'] },
      'ghost key': { folderIds: [folders[0].folderId], keys: [ghost] },
    }[writer];
    fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
      const page = await list(after, limit);
      await runFtsMembershipMutation(async () => ({ ok: true }), null, scope);
      return page;
    });

    const first = await settleSchedulerTickWithFakeTimers(fts);

    if (outcome === 'page_retry') {
      expect(first).toMatchObject({ migration: { retry: true, reason: 'stale_folder_remove_fence_lost' } });
      expect(fts.assignFolderMembershipBatch).not.toHaveBeenCalled();
      expect(nativeRows.get(live)).toBeNull();
      expect(nativeRows.has(ghost)).toBe(true);
      vi.setSystemTime(Date.now() + 100);
    } else if (outcome === 'row_refused') {
      expect(first).toMatchObject({ migration: { restart: true, reason: 'unresolved_legacy_rows' } });
      expect(nativeRows.get(live)).toBe(folders[0].folderId);
      expect(nativeRows.has(ghost)).toBe(true);
      expect(fts.removeBatch).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + reconConfig.membershipUnresolvedRetryMs);
    } else {
      expect(first?.migration?.retry).not.toBe(true);
      expect(nativeRows.get(live)).toBe(folders[0].folderId);
      expect(nativeRows.has(ghost)).toBe(false);
    }
    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(nativeRows.get(live)).toBe(folders[0].folderId);
    expect(nativeRows.has(ghost)).toBe(false);
    if (outcome === 'page_retry') expect(fts.listFolderMembershipState.mock.calls[1][0]).toBeNull();
  });

  it.each([
    { change: 'other-folder mail', withheld: false },
    { change: 'a re-add in the ghost\'s folder', withheld: true },
    { change: 'a folder rename', withheld: true },
    { change: 'an event naming no folder', withheld: true },
  ])('commits the page\'s assignments and removes a ghost after $change during them: withheld=$withheld', async ({ change, withheld }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const renameListeners = new Set();
    globalThis.browser.folders = {
      onRenamed: {
        addListener: listener => renameListeners.add(listener),
        removeListener: listener => renameListeners.delete(listener),
      },
    };
    incrementalIndexer.setupFolderTopologyListeners();
    try {
      const { fts, folders, nativeRows, rowsByURI } = seedMigratedExactFolders([
        { folderPath: '/F', headerMessageIds: ['live@example.com'] },
        { folderPath: '/Other', headerMessageIds: [] },
      ]);
      const ghost = 'account1:/F:ghost@example.com';
      const live = 'account1:/F:live@example.com';
      nativeRows.set(ghost, null);
      nativeRows.set(live, null);
      const assign = fts.assignFolderMembershipBatch.getMockImplementation();
      fts.assignFolderMembershipBatch.mockImplementationOnce(async (...args) => {
        if (change === 'other-folder mail') {
          await _testExports.onExperimentMessageAdded({
            accountId: 'account1', folderPath: '/Other', weFolderId: folders[1].weFolderId,
            headerMessageId: 'other@example.com', msgKey: 7, eventType: 'msgAdded',
          });
        } else if (change === 'a re-add in the ghost\'s folder') {
          rowsByURI.get(folders[0].folderURI).push({ msgKey: 8, headerMessageId: 'ghost@example.com' });
          await _testExports.onExperimentMessageAdded({
            accountId: 'account1', folderPath: '/F', weFolderId: folders[0].weFolderId,
            headerMessageId: 'ghost@example.com', msgKey: 8, eventType: 'msgAdded',
          });
        } else if (change === 'an event naming no folder') {
          // No weFolderId: the experiment's unconverted payload.
          await _testExports.onExperimentMessageAdded({
            accountId: 'account1', folderPath: '/Other',
            headerMessageId: 'other@example.com', msgKey: 7, eventType: 'msgAdded',
          });
        } else {
          // A rename and its reversal: the inventory is unchanged.
          for (const listener of [...renameListeners]) {
            listener({ accountId: 'account1', path: '/Other' }, { accountId: 'account1', path: '/Other' });
          }
        }
        _testExports._getPendingUpdates().clear();
        return assign(...args);
      });

      const first = await settleSchedulerTickWithFakeTimers(fts);

      expect(nativeRows.get(live), JSON.stringify(first)).toBe(folders[0].folderId);
      expect(fts.removeBatch.mock.calls.flat(2).includes(ghost)).toBe(!withheld);
      expect(nativeRows.has(ghost)).toBe(withheld);
      if (!withheld) {
        // The page's own owner write for /F never voids its /F ghost's
        // removal: no same-page retry.
        expect(first?.migration?.retry).not.toBe(true);
        expect(_testExports._getFolderReconRuntimeTelemetry().membershipStatePageRetries).toBe(0);
      }
      if (withheld && change === 'a re-add in the ghost\'s folder') {
        // The same-key event refuses only the ghost row; the page commits
        // and its terminal page schedules the delayed replay.
        expect(first).toMatchObject({ migration: { restart: true, reason: 'unresolved_legacy_rows' } });
        expect(_testExports._getFolderReconRuntimeTelemetry().membershipStateRowsRefused).toBe(1);
        vi.setSystemTime(Date.now() + reconConfig.membershipUnresolvedRetryMs);
      } else if (withheld) {
        expect(first).toMatchObject({ migration: { retry: true, reason: 'stale_folder_remove_event' } });
        vi.setSystemTime(Date.now() + 100);
      }
      if (withheld) {
        await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());
        expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
        // A re-added ghost is now live and owned; otherwise it is removed.
        if (change === 'a re-add in the ghost\'s folder') expect(nativeRows.get(ghost)).toBe(folders[0].folderId);
        else expect(nativeRows.has(ghost)).toBe(false);
      }
    } finally {
      await incrementalIndexer.disposeIncrementalIndexer();
      delete globalThis.browser.folders;
    }
  });
});

// INVARIANT (2026-10-04; key-scoped in stage 3b): a membership-state
// verdict is acted on only while its evidence stands. A removal yields to a
// converted event for its key in any folder — including one the inventory
// snapshot did not list — and an assignment yields to an event on its row's
// own raw key up to its commit; the refused row is unresolved debt for the
// delayed replay. A change during the commit itself owes the row's candidate
// folders a walk, which repairs the owner.
describe('membership-state verdicts never outlive their evidence', () => {
  afterEach(quiesceFolderReconAfterTest);

  // Production writers: legacy `index_batch` leaves the ownerless row; a
  // capable `index_batch` owns it; the event handler queues the newer add,
  // whose drain finds the row already indexed and writes nothing.
  it.each([
    { ownerless: false, during: 'the state page read' },
    { ownerless: true, during: 'the state page read' },
    { ownerless: false, during: 'the inventory read' },
    { ownerless: true, during: 'the inventory read' },
  ])('keeps a row re-added in a folder loaded after the inventory snapshot: ownerless=$ownerless, re-added during $during', async ({ ownerless, during }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/A', headerMessageIds: [] },
      { folderPath: '/Late', headerMessageIds: ['live@example.com'] },
    ]);
    const key = 'account1:/Late:live@example.com';
    if (ownerless) nativeRows.set(key, null);
    // The snapshot is taken before /Late has loaded.
    const fullInventory = await globalThis.browser.accounts.list();
    const partialInventory = [{
      ...fullInventory[0],
      rootFolder: {
        ...fullInventory[0].rootFolder,
        subFolders: fullInventory[0].rootFolder.subFolders.slice(0, 1),
      },
    }];
    _testExports._setFtsSearch(fts);
    headerIDToWeID.mockResolvedValue(1);
    globalThis.browser.messages.get = vi.fn(async () => ({
      id: 1, headerMessageId: 'live@example.com', folder: { accountId: 'account1', path: '/Late' },
    }));
    getUniqueMessageKey.mockResolvedValue(key);
    buildBatchHeader.mockResolvedValue([{ msgId: key, folderId: folders[1].folderId }]);
    let delivered = false;
    const reAdd = async () => {
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: '/Late', weFolderId: folders[1].weFolderId,
        headerMessageId: 'live@example.com', msgKey: 1, eventType: 'msgAdded',
      });
      await flushPendingUpdates();
      delivered = _testExports._getPendingUpdates().size === 0 && nativeRows.has(key);
    };
    if (during === 'the inventory read') {
      // Delivered while the snapshot that omits /Late is being taken.
      globalThis.browser.accounts.list.mockImplementationOnce(async () => {
        await reAdd();
        return partialInventory;
      });
    } else {
      globalThis.browser.accounts.list.mockResolvedValueOnce(partialInventory);
      const stateRead = fts.listFolderMembershipState.getMockImplementation();
      fts.listFolderMembershipState.mockImplementationOnce(async (...args) => {
        const page = await stateRead(...args);
        await reAdd();
        return page;
      });
    }

    const first = await settleSchedulerTickWithFakeTimers(fts);

    expect(delivered, JSON.stringify(first)).toBe(true);
    expect(fts.removeBatch.mock.calls.flat(2), JSON.stringify(first)).not.toContain(key);
    expect(nativeRows.has(key)).toBe(true);
    // Control: once the folder is listed, the pass completes and keeps it.
    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(nativeRows.has(key)).toBe(true);
  });

  // `account1:/F:Child:hmid@example.com` reads as /F + `Child:hmid@…` or as
  // /F:Child + `hmid@…`; the message moves between those readings.
  function seedAmbiguousRow(extra = []) {
    const fixture = seedMigratedExactFolders([
      { folderPath: '/F:Child', headerMessageIds: [] },
      { folderPath: '/F', headerMessageIds: ['Child:hmid@example.com'] },
      ...extra,
    ]);
    const key = 'account1:/F:Child:hmid@example.com';
    fixture.nativeRows.set(key, null);
    _testExports._setFtsSearch(fixture.fts);
    headerIDToWeID.mockResolvedValue(1);
    globalThis.browser.messages.get = vi.fn(async () => ({
      id: 1, headerMessageId: 'hmid@example.com', folder: { accountId: 'account1', path: '/F:Child' },
    }));
    getUniqueMessageKey.mockResolvedValue(key);
    buildBatchHeader.mockResolvedValue([{ msgId: key, folderId: fixture.folders[0].folderId }]);
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    const move = async () => {
      const [child, parent] = fixture.folders;
      fixture.rowsByURI.get(parent.folderURI).splice(0);
      fixture.rowsByURI.get(child.folderURI).push({ msgKey: 1, headerMessageId: 'hmid@example.com' });
      await _testExports.onExperimentMessageRemoved({
        accountId: 'account1', folderPath: '/F', weFolderId: parent.weFolderId,
        headerMessageId: 'Child:hmid@example.com', msgKey: 1,
      });
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: '/F:Child', weFolderId: child.weFolderId,
        headerMessageId: 'hmid@example.com', msgKey: 1, eventType: 'msgAdded',
      });
      await flushPendingUpdates();
    };
    return { ...fixture, key, move };
  }

  it('never commits an assignment whose own key changed while a later row was classified', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, key, move } = seedAmbiguousRow([
      { folderPath: '/Z', headerMessageIds: ['later@example.com'] },
    ]);
    nativeRows.set('account1:/Z:later@example.com', null);
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    let moved = false;
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      if (uri === folders[2].folderURI && !moved) {
        moved = true;
        await move();
        expect(nativeRows.get(key)).toBeNull();
      }
      return probe(uri, ids);
    });

    await tickThroughUnresolvedReplay(fts, () => _testExports._getFolderMembershipCleanupProven());

    expect(moved).toBe(true);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(fts.assignFolderMembershipBatch.mock.calls.flat(2)).not.toContainEqual(
      { msgId: key, folderId: folders[1].folderId });
    expect(nativeRows.get(key)).toBe(folders[0].folderId);
  });

  it('never commits an assignment whose own key changed after its last probe answered', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, key, move } = seedAmbiguousRow();
    // /F (the positive) is probed last, and the message moves after its
    // probe answered — after the row's last read.
    const candidates = getUniqueMessageKeyCandidates.getMockImplementation();
    getUniqueMessageKeyCandidates.mockImplementation((...args) => candidates(...args)
      .sort((a, b) => b.weFolder.path.length - a.weFolder.path.length));
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    let moved = false;
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      const result = await probe(uri, ids);
      if (uri === folders[1].folderURI && !moved) {
        moved = true;
        await move();
      }
      return result;
    });
    try {
      await tickThroughUnresolvedReplay(fts, () => _testExports._getFolderMembershipCleanupProven());
    } finally {
      getUniqueMessageKeyCandidates.mockImplementation(candidates);
    }

    expect(moved).toBe(true);
    expect(fts.assignFolderMembershipBatch.mock.calls.flat(2)).not.toContainEqual(
      { msgId: key, folderId: folders[1].folderId });
    expect(nativeRows.get(key)).toBe(folders[0].folderId);
  });

  it('owes the candidate folders a walk when they change during the assignment call, and the walks repair the owner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, rowsByURI, key, move } = seedAmbiguousRow();
    // The walk's stale direction probes the folder's msgDB.
    globalThis.browser.tmMsgNotify.probeMessageIds = vi.fn(async (folderURI, headerIds) => ({
      missing: headerIds.filter(id => !rowsByURI.get(folderURI).some(row => row.headerMessageId === id)),
    }));
    fakeNativeFts.indexBatch.mockImplementation(async rows => {
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;
    const assign = fts.assignFolderMembershipBatch;
    let dirtyAfterCommit = null;
    fts.assignFolderMembershipBatch = vi.fn(async (...args) => {
      const result = await assign(...args);
      if (dirtyAfterCommit === null) {
        // The message moves after the native commit, inside the call.
        await move();
        dirtyAfterCommit = false;
      }
      return result;
    });

    await settleSchedulerTickWithFakeTimers(fts);
    dirtyAfterCommit = [..._testExports._getFolderReconDirty()];
    expect(nativeRows.get(key)).toBe(folders[1].folderId);
    expect(dirtyAfterCommit).toEqual(expect.arrayContaining(['account1:/F', 'account1:/F:Child']));

    for (let turn = 0; turn < 60 && nativeRows.get(key) !== folders[0].folderId; turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      await flushPendingUpdates();
      vi.setSystemTime(Date.now() + reconConfig.paceDelayMs);
    }
    expect(nativeRows.get(key)).toBe(folders[0].folderId);
  }, 30_000);

  // INVARIANT (2026-10-04; row-scoped in stage 3b): the commit-time check
  // and the in-call walk mark cover every row of a multi-row assignment
  // batch, not just its first. /A's row sorts first and shares the batch
  // with the ambiguous row; a refused row never holds the rows after it.
  it.each([
    { change: 'the ambiguous row\'s move', refused: true },
    { change: 'mail in an unrelated folder (control)', refused: false },
  ])('commits a batch\'s valid rows and refuses its changed row after $change during classification', async ({ refused }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, key, move } = seedAmbiguousRow([
      { folderPath: '/A', headerMessageIds: ['first@example.com'] },
      { folderPath: '/Z', headerMessageIds: ['later@example.com'] },
      { folderPath: '/Other', headerMessageIds: [] },
    ]);
    const first = 'account1:/A:first@example.com';
    nativeRows.set(first, null);
    nativeRows.set('account1:/Z:later@example.com', null);
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    let changed = false;
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      if (uri === folders[3].folderURI && !changed) {
        changed = true;
        if (refused) await move();
        else {
          await _testExports.onExperimentMessageAdded({
            accountId: 'account1', folderPath: '/Other', weFolderId: folders[4].weFolderId,
            headerMessageId: 'other@example.com', msgKey: 9, eventType: 'msgAdded',
          });
          _testExports._getPendingUpdates().clear();
        }
      }
      return probe(uri, ids);
    });

    const firstTick = await settleSchedulerTickWithFakeTimers(fts);

    expect(changed).toBe(true);
    const [firstCall] = fts.assignFolderMembershipBatch.mock.calls;
    expect(firstCall[0].map(({ msgId }) => msgId)).toEqual(refused ? [first] : [first, key]);
    expect(nativeRows.get(first), JSON.stringify(firstTick)).toBe(folders[2].folderId);
    expect(nativeRows.get(key)).toBe(refused ? null : folders[1].folderId);
    // The row after the refused one still commits in the same tick.
    expect(nativeRows.get('account1:/Z:later@example.com')).toBe(folders[3].folderId);
    const telemetry = _testExports._getFolderReconRuntimeTelemetry();
    expect(telemetry.membershipStatePageRetries).toBe(0);
    expect(telemetry.membershipStateRowsRefused).toBe(refused ? 1 : 0);
    vi.setSystemTime(Date.now() + 100);
    await tickThroughUnresolvedReplay(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(nativeRows.get(first)).toBe(folders[2].folderId);
    if (refused) {
      expect(fts.assignFolderMembershipBatch.mock.calls.flat(2)).not.toContainEqual(
        { msgId: key, folderId: folders[1].folderId });
      expect(nativeRows.get(key)).toBe(folders[0].folderId);
    }
  });

  it('owes a later batch row\'s candidate folders a walk when they change during the call', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, rowsByURI, key, move } = seedAmbiguousRow([
      { folderPath: '/A', headerMessageIds: ['first@example.com'] },
    ]);
    const first = 'account1:/A:first@example.com';
    nativeRows.set(first, null);
    globalThis.browser.tmMsgNotify.probeMessageIds = vi.fn(async (folderURI, headerIds) => ({
      missing: headerIds.filter(id => !rowsByURI.get(folderURI).some(row => row.headerMessageId === id)),
    }));
    fakeNativeFts.indexBatch.mockImplementation(async rows => {
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;
    const assign = fts.assignFolderMembershipBatch;
    let calls = 0;
    fts.assignFolderMembershipBatch = vi.fn(async (...args) => {
      const result = await assign(...args);
      if (calls++ === 0) {
        expect(args[0].map(({ msgId }) => msgId)).toEqual([first, key]);
        // The ambiguous row's message moves after the native commit.
        await move();
      }
      return result;
    });

    await settleSchedulerTickWithFakeTimers(fts);

    expect(calls).toBeGreaterThan(0);
    expect(nativeRows.get(first)).toBe(folders[2].folderId);
    expect(nativeRows.get(key)).toBe(folders[1].folderId);
    expect([..._testExports._getFolderReconDirty()])
      .toEqual(expect.arrayContaining(['account1:/F', 'account1:/F:Child']));
    for (let turn = 0; turn < 60 && nativeRows.get(key) !== folders[0].folderId; turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      await flushPendingUpdates();
      vi.setSystemTime(Date.now() + reconConfig.paceDelayMs);
    }
    expect(nativeRows.get(key)).toBe(folders[0].folderId);
    expect(nativeRows.get(first)).toBe(folders[2].folderId);
  }, 30_000);

  // Writers: legacy `index_batch` leaves the ownerless rows (including a raw
  // key with two live readings); a capable `index_batch` owned /G's row
  // before /G was deleted; zAccount is not loaded yet. A row refused at
  // commit (its own key changed) is counted once as unresolved debt and
  // every other row's effect commits; the delayed replay re-classifies it.
  it('refuses only the changed row at commit, counts it once and replays it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, key, move } = seedAmbiguousRow([
      { folderPath: '/U:Child', headerMessageIds: ['u@example.com'] },
      { folderPath: '/U', headerMessageIds: ['Child:u@example.com'] },
      { folderPath: '/Z', headerMessageIds: ['later@example.com'] },
    ]);
    const ambiguous = 'account1:/U:Child:u@example.com';
    const later = 'account1:/Z:later@example.com';
    const orphan = 'account1:/G:orphan@example.com';
    const ghost = 'account1:/H:ghost@example.com';
    const unloaded = 'zAccount:/Unloaded:kept@example.com';
    nativeRows.set(ambiguous, null);
    nativeRows.set(later, null);
    nativeRows.set(orphan, makeFolderMembershipId('account1', '/G'));
    nativeRows.set(ghost, null);
    nativeRows.set(unloaded, null);
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    let moved = false;
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      // /Z sorts after every other row: the move voids /F:Child's assignment
      // (the first row) after the whole page was classified.
      if (uri === folders[4].folderURI && !moved) {
        moved = true;
        await move();
      }
      return probe(uri, ids);
    });

    const first = await settleSchedulerTickWithFakeTimers(fts);

    expect(moved, JSON.stringify(first)).toBe(true);
    expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(1);
    expect(fts.assignFolderMembershipBatch.mock.calls.flatMap(([batch]) => batch.map(({ msgId }) => msgId))).toEqual([later]);
    expect(nativeRows.get(key)).toBeNull();
    expect(nativeRows.get(later)).toBe(folders[4].folderId);
    expect(nativeRows.has(orphan) || nativeRows.has(ghost)).toBe(false);
    expect(nativeRows.get(ambiguous)).toBeNull();
    expect(nativeRows.get(unloaded)).toBeNull();
    // The terminal page restarts the pass for its unresolved debt (the
    // refused row and the ambiguous one); the refused row counted once.
    expect(first).toMatchObject({ migration: { restart: true, reason: 'unresolved_legacy_rows' } });
    const telemetry = _testExports._getFolderReconRuntimeTelemetry();
    expect(telemetry.membershipStateRowsRefused).toBe(1);
    expect(telemetry.membershipStatePageRetries).toBe(0);
    expect(telemetry.membershipStateRestartUnresolvedReplay).toBe(1);
    expect(_testExports._getFolderMembershipStatePass()).toMatchObject({
      afterMsgId: null, passUnresolved: 0, unloaded: 0, completed: false,
    });

    // The replay assigns the refused row; the ambiguous row stays
    // unresolved (no cutover) and the unloaded account's row is kept.
    await tickThroughUnresolvedReplay(fts, () => nativeRows.get(key) === folders[0].folderId, 10);
    expect(nativeRows.get(key)).toBe(folders[0].folderId);
    expect(nativeRows.get(ambiguous)).toBeNull();
    expect(nativeRows.get(unloaded)).toBeNull();
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
  });

  it('re-checks every assignment batch, not only the first', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, key, move } = seedAmbiguousRow([
      { folderPath: '/A', headerMessageIds: ['first@example.com', 'second@example.com'] },
    ]);
    // /A's two rows sort first and fill one batch, so it commits before the
    // ambiguous row's batch.
    nativeRows.set('account1:/A:first@example.com', null);
    nativeRows.set('account1:/A:second@example.com', null);
    const assign = fts.assignFolderMembershipBatch;
    let moved = false;
    fts.assignFolderMembershipBatch = vi.fn(async (...args) => {
      const result = await assign(...args);
      if (!moved) {
        moved = true;
        await move();
      }
      return result;
    });

    const first = await settleSchedulerTickWithFakeTimers(fts);

    expect(moved, JSON.stringify(first)).toBe(true);
    expect(fts.assignFolderMembershipBatch.mock.calls[0][0]).toHaveLength(reconConfig.membershipAssignBatchSize);
    expect(fts.assignFolderMembershipBatch.mock.calls.flat(2)).not.toContainEqual(
      { msgId: key, folderId: folders[1].folderId });
    expect(nativeRows.get(key)).toBeNull();
    await tickThroughUnresolvedReplay(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    expect(nativeRows.get(key)).toBe(folders[0].folderId);
  });

  it('voids a positive verdict when its key changes in its second candidate folder before the row commits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, rowsByURI, key } = seedAmbiguousRow();
    // /F is probed second.
    const candidates = getUniqueMessageKeyCandidates.getMockImplementation();
    getUniqueMessageKeyCandidates.mockImplementation((...args) => candidates(...args)
      .sort((a, b) => b.weFolder.path.length - a.weFolder.path.length));
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    let removed = false;
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      const page = await probe(uri, ids);
      if (uri === folders[1].folderURI && !removed) {
        removed = true;
        rowsByURI.get(folders[1].folderURI).splice(0);
        await _testExports.onExperimentMessageRemoved({
          accountId: 'account1', folderPath: '/F', weFolderId: folders[1].weFolderId,
          headerMessageId: 'Child:hmid@example.com', msgKey: 1,
        });
      }
      return page;
    });
    try {
      await settleSchedulerTickWithFakeTimers(fts);
      expect(removed).toBe(true);
      expect(nativeRows.get(key)).toBeNull();
      // Retried against the fresh state: no folder holds the message now.
      await tickThroughUnresolvedReplay(fts, () => !nativeRows.has(key));
      expect(nativeRows.has(key)).toBe(false);
    } finally {
      getUniqueMessageKeyCandidates.mockImplementation(candidates);
    }
  });
});


// INVARIANT (2026-10-04): a queued update that names its folder holds only
// that folder's repair in exact mode. The drain-quiet gate inferred the
// folder from the raw key prefix, so a pending add in `/Cold:Hot` (whose raw
// key starts with `/Cold`'s prefix) deferred `/Cold`'s owed walk for as long
// as `/Cold:Hot` kept pending work.
describe('exact-mode drain-quiet gate reads a queued update\'s own folder', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(realDateNow()); });
  afterEach(quiesceFolderReconAfterTest);

  it.each([
    { hotPath: '/Hot', owned: true, deferred: false },
    { hotPath: '/Cold:Hot', owned: true, deferred: false },
    // An entry restored without a folder (an earlier release) falls back to
    // the raw key prefix and still defers the folder whose range holds it.
    { hotPath: '/Cold:Hot', owned: false, deferred: true },
  ])('repairs /Cold while $hotPath has a queued add (owned=$owned): deferred=$deferred', async ({ hotPath, owned, deferred }) => {
    const { fts, folders, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/Cold', headerMessageIds: ['cold@example.com'] },
      { folderPath: hotPath, headerMessageIds: ['hot@example.com'] },
    ]);
    _testExports._setFtsSearch(fts);
    await tickUntil(fts, value => value?.complete === true, 40);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    const [cold, hot] = folders;
    const coldKey = 'account1:/Cold:cold@example.com';
    const hotKey = `account1:${hotPath}:hot@example.com`;
    const event = (folder, id) => ({
      accountId: folder.accountId, folderPath: folder.folderPath, weFolderId: folder.weFolderId,
      headerMessageId: id, msgKey: 1, eventType: 'msgAdded',
    });
    // The real producer of an owed walk: an abandoned queued update for
    // /Cold, whose native row is missing.
    nativeRows.delete(coldKey);
    await _testExports.onExperimentMessageAdded(event(cold, 'cold@example.com'));
    expect((await abandonAllQueued()).dropped).toBe(1);
    expect(_testExports._getFolderReconDirty()).toContain('account1:/Cold');
    vi.setSystemTime(Date.now() + reconConfig.errorDelayMs + 100);
    await _testExports.onExperimentMessageAdded(event(hot, 'hot@example.com'));
    const queue = _testExports._getPendingUpdates();
    expect(queue.get(hotKey)).toMatchObject({ type: 'new', folderKey: `account1:${hotPath}` });
    if (!owned) queue.get(hotKey).folderKey = null;
    globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockClear();

    let result;
    for (let attempt = 0; attempt < 40; attempt++) {
      vi.setSystemTime(Date.now() + 100);
      result = await settleSchedulerTickWithFakeTimers(fts);
      if (result?.foldersDrainBusy || queue.has(coldKey)) break;
    }

    expect(result?.foldersDrainBusy > 0, JSON.stringify(result)).toBe(deferred);
    expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls
      .some(([uri]) => uri === cold.folderURI)).toBe(!deferred);
    expect(queue.has(coldKey)).toBe(!deferred);
    expect(queue.has(hotKey)).toBe(true);
  });
});

// INVARIANT (2026-10-04): an older captured queue entry never dequeues a
// newer intention, even one of the same type in the same millisecond (type +
// timestamp is not an identity). The raw key `account1:/F:Child:x@…` is both
// /F's `Child:x@…` and /F:Child's `x@…`.
describe('a drain never dequeues a same-type intention queued in its millisecond', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    _testExports._setConsecutiveNoProgressCycles(0);
  });
  afterEach(quiesceFolderReconAfterTest);

  it.each([0, 1])('keeps the later add queued after the older add drains; delta=%ims', async (delta) => {
    const { fts, nativeRows, folders, rowsByURI } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: [] },
      { folderPath: '/F:Child', headerMessageIds: [] },
    ]);
    _testExports._setFtsSearch(fts);
    await tickUntil(fts, value => value?.complete === true, 30);
    const key = 'account1:/F:Child:review@example.com';
    const oldEvent = {
      accountId: 'account1', folderPath: '/F', weFolderId: folders[0].weFolderId,
      headerMessageId: 'Child:review@example.com', msgKey: 1, eventType: 'msgAdded',
    };
    const latestEvent = {
      accountId: 'account1', folderPath: '/F:Child', weFolderId: folders[1].weFolderId,
      headerMessageId: 'review@example.com', msgKey: 2, eventType: 'msgAdded',
    };
    rowsByURI.get(folders[0].folderURI).push({ msgKey: 1, headerMessageId: oldEvent.headerMessageId });
    await _testExports.onExperimentMessageAdded(oldEvent);
    const captured = _testExports._getPendingUpdates().get(key);
    expect(captured).toMatchObject({ type: 'new', folderKey: 'account1:/F' });
    let replacement;
    resolveUniqueMessageKey.mockResolvedValue({
      weID: 1, headerID: oldEvent.headerMessageId,
      weFolder: { accountId: 'account1', path: '/F', id: folders[0].weFolderId },
    });
    // While the drain fetches the old add's header, the message is removed
    // and a different one with the same raw key is added, all within
    // `delta` ms of the captured add.
    globalThis.browser.messages.get = vi.fn(async () => {
      if (!replacement) {
        vi.setSystemTime(captured.timestamp + delta);
        rowsByURI.get(folders[0].folderURI).splice(0);
        await _testExports.onExperimentMessageRemoved({ ...oldEvent, eventType: 'msgDeleted' });
        expect(_testExports._getPendingUpdates().get(key).type).toBe('deleted');
        rowsByURI.get(folders[1].folderURI).push({ msgKey: 2, headerMessageId: latestEvent.headerMessageId });
        await _testExports.onExperimentMessageAdded(latestEvent);
        replacement = _testExports._getPendingUpdates().get(key);
        expect(replacement).toMatchObject({
          type: 'new', folderKey: 'account1:/F:Child', timestamp: captured.timestamp + delta,
        });
      }
      return { id: 1, headerMessageId: oldEvent.headerMessageId, folder: { accountId: 'account1', path: '/F' } };
    });
    getUniqueMessageKey.mockResolvedValue(key);
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: key, folderId: makeFolderMembershipId(header.folder.accountId, header.folder.path),
    })));
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    fakeNativeFts.indexBatch.mockImplementation(async (rows, wire) => {
      wire.withFolderIds = true;
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;

    await flushPendingUpdates();

    expect(replacement).toBeDefined();
    // The old drain wrote the old owner and the later add stays queued. Its
    // own drain finds the raw key already indexed, so the later add alone
    // does not repair the owner: the walk does (see the post-proof cases
    // below).
    expect(nativeRows.get(key)).toBe(folders[0].folderId);
    expect(_testExports._getPendingUpdates().get(key)).toBe(replacement);
  });
});

// INVARIANT (2026-10-04): a folder is credited complete for the session only
// while its own local proof still holds at the grant. A delete from /F and an
// add to /F:Child that share one raw key coalesce into one queued add; its
// drain finds the key already indexed under /F and dequeues it without a
// native write or a walk mark, so only /F's local proof records the change.
// An event in an unrelated folder leaves /F's completion standing.
describe('a queued ownership change after the last local proof', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(realDateNow()); });
  afterEach(quiesceFolderReconAfterTest);

  it.each([
    { name: 'a same-millisecond replacement', gapMs: 0, related: true },
    { name: 'a later replacement', gapMs: 1, related: true },
    { name: 'an unrelated-folder add (control)', gapMs: 0, related: false },
  ])('refuses stale completion and repairs the owner after $name', async ({ gapMs, related }) => {
    const { fts, folders, rowsByURI, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['Child:review@example.com'] },
      { folderPath: '/F:Child', headerMessageIds: [] },
      ...(related ? [] : [{ folderPath: '/G', headerMessageIds: [] }]),
    ]);
    _testExports._setFtsSearch(fts);
    const key = 'account1:/F:Child:review@example.com';
    const oldEvent = {
      accountId: 'account1', folderPath: '/F', weFolderId: folders[0].weFolderId,
      headerMessageId: 'Child:review@example.com', msgKey: 1, eventType: 'msgDeleted',
    };
    const target = related ? folders[1] : folders[2];
    const newEvent = {
      accountId: 'account1', folderPath: target.folderPath, weFolderId: target.weFolderId,
      headerMessageId: related ? 'review@example.com' : 'other@example.com', msgKey: 2, eventType: 'msgAdded',
    };
    const eventKey = related ? key : 'account1:/G:other@example.com';
    resolveUniqueMessageKey.mockResolvedValue({
      weID: 2, headerID: newEvent.headerMessageId,
      weFolder: { accountId: 'account1', path: target.folderPath, id: target.weFolderId },
    });
    headerIDToWeID.mockResolvedValue(2);
    globalThis.browser.messages.get = vi.fn(async () => ({
      id: 2, headerMessageId: newEvent.headerMessageId,
      folder: { accountId: 'account1', path: target.folderPath },
    }));
    getUniqueMessageKey.mockResolvedValue(eventKey);
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: eventKey, folderId: makeFolderMembershipId(header.folder.accountId, header.folder.path),
    })));
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    fakeNativeFts.indexBatch.mockImplementation(async (rows, wire) => {
      if (wire) wire.withFolderIds = true;
      for (const row of rows) {
        const stored = nativeRows.get(row.msgId);
        if (stored && stored !== row.folderId) throw new Error('folder_membership_conflict');
        nativeRows.set(row.msgId, row.folderId);
      }
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;
    const storage = globalThis.browser.storage.local;
    const get = storage.get.getMockImplementation();
    let fired = false;
    // The events land while the scheduler reloads the memo after /F's last
    // own check, and drain before the grant.
    storage.get.mockImplementation(async keys => {
      const memoKey = _testExports.FOLDER_RECON_STORAGE_KEY;
      if (!fired && storageData[memoKey]?.folders?.['account1:/F']?.verified
          && JSON.stringify(keys ?? null).includes(memoKey)) {
        fired = true;
        if (related) {
          rowsByURI.get(folders[0].folderURI).splice(0);
          await _testExports.onExperimentMessageRemoved(oldEvent);
          vi.setSystemTime(Date.now() + gapMs);
        }
        rowsByURI.get(target.folderURI).push({ msgKey: 2, headerMessageId: newEvent.headerMessageId });
        await _testExports.onExperimentMessageAdded(newEvent);
        expect(_testExports._getPendingUpdates().get(eventKey).folderKey)
          .toBe(`account1:${target.folderPath}`);
        await flushPendingUpdates();
        expect(_testExports._getPendingUpdates().size).toBe(0);
      }
      return get(keys);
    });
    for (let turn = 0; turn < 40 && !fired; turn++) {
      try { await settleSchedulerTickWithFakeTimers(fts); }
      catch (error) { if (!String(error).includes('folder_changed_during_scan')) throw error; }
      vi.setSystemTime(Date.now() + 100);
    }
    expect(fired).toBe(true);
    if (!related) {
      // The drain indexed the unrelated add; /F's proof still holds.
      expect(nativeRows.get(eventKey)).toBe(target.folderId);
      expect(nativeRows.get(key)).toBe(folders[0].folderId);
      expect(_testExports._getFolderReconSessionDone().has('account1:/F')).toBe(true);
      return;
    }
    // The drain dequeued the add against the old owner without a native
    // write, so only /F's own local proof is false now.
    expect(nativeRows.get(key)).toBe(folders[0].folderId);
    expect(_testExports._getFolderReconSessionDone().has('account1:/F')).toBe(false);
    for (let turn = 0; turn < 60 && nativeRows.get(key) !== folders[1].folderId; turn++) {
      try { await settleSchedulerTickWithFakeTimers(fts); }
      catch (error) { if (!String(error).includes('folder_changed_during_scan')) throw error; }
      await flushPendingUpdates();
      vi.setSystemTime(Date.now() + reconConfig.errorDelayMs);
    }
    expect(nativeRows.get(key)).toBe(folders[1].folderId);
    expect(_testExports._getPendingUpdates().size).toBe(0);
  });
});

// INVARIANT (2026-10-04): a stale pass keeps its cursor across native writes
// in another folder, so a ghost beyond the first stale page is still found
// while every probe overlaps a hot folder's write.
describe('native traffic in another folder preserves the stale cursor', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(realDateNow()); });
  afterEach(quiesceFolderReconAfterTest);

  it('removes a ghost beyond the first stale page despite a native write during every probe', async () => {
    const coldIds = Array.from({ length: reconConfig.stalePageKeys + 1 },
      (_, i) => `a-${String(i).padStart(4, '0')}@example.com`);
    const { fts, folders, rowsByURI, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/Cold', headerMessageIds: coldIds },
      { folderPath: '/Hot', headerMessageIds: [] },
    ]);
    _testExports._setFtsSearch(fts);
    const [cold, hot] = folders;
    const ghost = 'account1:/Cold:z-ghost@example.com';
    nativeRows.set(ghost, cold.folderId);
    fakeNativeFts.indexBatch.mockImplementation(async (rows, wire) => {
      if (wire) wire.withFolderIds = true;
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    const produced = [];
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      const answer = await probe(uri, ids);
      if (uri === cold.folderURI) {
        const id = `hot-${produced.length}@example.com`;
        produced.push(id);
        rowsByURI.get(hot.folderURI).push({ msgKey: produced.length, headerMessageId: id });
        await engineFtsSearch.indexBatch([{ msgId: `account1:/Hot:${id}`, folderId: hot.folderId }]);
      }
      return answer;
    });

    for (let turn = 0; turn < 180 && !_testExports._getFolderReconSessionDone().has('account1:/Cold'); turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + 100);
    }

    expect(produced.length).toBeGreaterThan(0);
    expect(produced.every(id => nativeRows.get(`account1:/Hot:${id}`) === hot.folderId)).toBe(true);
    expect(coldIds.every(id => nativeRows.get(`account1:/Cold:${id}`) === cold.folderId)).toBe(true);
    expect(nativeRows.has(ghost)).toBe(false);
    expect(_testExports._getFolderReconSessionDone()).toContain('account1:/Cold');
  });
});

// INVARIANT (PR 3b §3, P3-R8 R1): with a capable helper, folder repair never
// waits for global membership cleanup. An ownerless row the pass cannot
// resolve keeps cleanup (and therefore orphan/session completion) incomplete,
// but healthy folders are still reconciled exactly, from the first ticks.
describe('exact folder work before global cleanup completes', () => {
  afterEach(quiesceFolderReconAfterTest);

  // A NULL-owned row in /A whose classifier can never decide (the scoped
  // probe misses and every global recheck errors), plus a healthy /Z.
  function seedUnresolvableRowAndHealthyFolder(extraFolders = []) {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const installed = seedMigratedExactFolders([
      { folderPath: '/A', headerMessageIds: ['a-1@example.com'] },
      { folderPath: '/Z', headerMessageIds: [] },
      ...extraFolders,
    ]);
    installed.nativeRows.set('account1:/A:unresolvable@example.com', null);
    recheckMessageInFolder.mockResolvedValue('error');
    _testExports._setFtsSearch(installed.fts);
    return installed;
  }

  async function dropAddition(installed, folder, headerMessageId) {
    installed.rowsByURI.get(folder.folderURI).push({ msgKey: 77, headerMessageId });
    await _testExports.onExperimentMessageAdded({
      accountId: 'account1', folderPath: folder.folderPath, weFolderId: folder.weFolderId,
      headerMessageId, msgKey: 77, eventType: 'msgAdded',
    });
    // The real producer of a dropped addition: a queue-stuck abandonment.
    expect((await abandonAllQueued()).dropped).toBe(1);
  }

  it('repairs a healthy folder while an unresolvable ownerless row holds cleanup, and never completes', async () => {
    const installed = seedUnresolvableRowAndHealthyFolder();
    const healthy = installed.folders[1];
    await dropAddition(installed, healthy, 'missing@example.com');
    const missing = 'account1:/Z:missing@example.com';

    const results = [];
    for (let turn = 0; turn < 40 && !_testExports._getPendingUpdates().has(missing); turn++) {
      results.push(await settleSchedulerTickWithFakeTimers(installed.fts));
      vi.setSystemTime(Date.now() + 100);
    }

    expect(_testExports._getPendingUpdates().has(missing)).toBe(true);
    expect(installed.fts.listFolderMembershipState).toHaveBeenCalled();
    expect(installed.nativeRows.get('account1:/A:unresolvable@example.com')).toBeNull();
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    expect(results.some(result => result?.complete === true)).toBe(false);
    expect(await sessionSettled()).toBe(false);
  }, 30_000);

  it('alternates state-pass and folder slices while cleanup is incomplete', async () => {
    // A session walks every folder once, so four folders give the first
    // folder turns a target each.
    const installed = seedUnresolvableRowAndHealthyFolder([
      { folderPath: '/B', headerMessageIds: ['b-1@example.com'] },
      { folderPath: '/C', headerMessageIds: ['c-1@example.com'] },
    ]);
    // More undecidable rows than one slice's global rechecks can classify,
    // so the pass needs several pass turns.
    for (let i = 0; i < 4 * reconConfig.rechecksPerSlice; i++) {
      installed.nativeRows.set(`account1:/A:undecided-${i}@example.com`, null);
    }
    // Every slice, including the ones armed wakes run: a state page read is
    // a pass slice; a folder reconcile opens with a getFolderState call that
    // asks for the incarnation token (the classifier's probe passes none).
    const sequence = [];
    const listState = installed.fts.listFolderMembershipState.getMockImplementation();
    installed.fts.listFolderMembershipState.mockImplementation((...args) => {
      sequence.push('pass');
      return listState(...args);
    });
    const getFolderState = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementation((...args) => {
      if (args[2]?.ensureIncarnationToken === true) sequence.push('folders');
      return getFolderState(...args);
    });
    for (let turn = 0; turn < 30 && sequence.length < 6; turn++) {
      await settleSchedulerTickWithFakeTimers(installed.fts);
      vi.setSystemTime(Date.now() + 100);
    }
    expect(sequence.slice(0, 6)).toEqual(['pass', 'folders', 'pass', 'folders', 'pass', 'folders']);
  }, 30_000);

  // A pass turn whose state page meets foreground pressure every time still
  // hands the next turn to folder work, so pressure on a long page never
  // starves a healthy folder's repair. pressured: false is the control.
  it.each([{ pressured: true }, { pressured: false }])('repairs a healthy folder when every state page meets pressure: pressured=$pressured', async ({ pressured }) => {
    const installed = seedUnresolvableRowAndHealthyFolder();
    const healthy = installed.folders[1];
    await dropAddition(installed, healthy, 'missing@example.com');
    const missing = 'account1:/Z:missing@example.com';
    let pressureOnce = false;
    getForegroundFetchPressure.mockImplementation(() => {
      if (!pressureOnce) return { active: 0, waiting: 0, chatTyping: false };
      pressureOnce = false;
      return { active: 1, waiting: 0, chatTyping: false };
    });
    const listState = installed.fts.listFolderMembershipState.getMockImplementation();
    installed.fts.listFolderMembershipState.mockImplementation(async (...args) => {
      const page = await listState(...args);
      // The next pressure check after this page sees foreground work.
      if (pressured) pressureOnce = true;
      return page;
    });
    const pressureSkipsBefore = _testExports._getFolderReconRuntimeTelemetry().schedulerPressureSkips;

    try {
      for (let turn = 0; turn < 40 && !_testExports._getPendingUpdates().has(missing); turn++) {
        await settleSchedulerTickWithFakeTimers(installed.fts);
        vi.setSystemTime(Date.now() + 100);
      }
    } finally {
      getForegroundFetchPressure.mockReset();
      getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
    }

    expect(_testExports._getPendingUpdates().has(missing)).toBe(true);
    expect(installed.fts.listFolderMembershipState).toHaveBeenCalled();
    const pressureSkips = _testExports._getFolderReconRuntimeTelemetry().schedulerPressureSkips - pressureSkipsBefore;
    if (pressured) expect(pressureSkips).toBeGreaterThan(0);
    else expect(pressureSkips).toBe(0);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
  }, 30_000);
});

// INVARIANT (PR 3b review): a tick decides exact versus legacy membership
// once, before its first await. A helper whose capability arrives (hello)
// during the tick's awaits never credits orphan/session completion that no
// cleanup pass earned; the next tick, under the new connection, re-walks
// and removes the stale row before completing.
describe('a capability change inside one tick', () => {
  afterEach(quiesceFolderReconAfterTest);

  it('never credits orphan or session completion that no cleanup pass earned', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, nativeRows } = installExactMembershipFolders([
      { folderPath: '/F', headerMessageIds: ['a@example.com'] },
    ], { assigned: true });
    const first = await tickUntil(fts, value => value?.complete === true);
    expect(first).toMatchObject({ complete: true });
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    const stale = 'account1:/Deleted:stale@example.com';
    nativeRows.set(stale, makeFolderMembershipId('account1', '/Deleted'));
    // A reconnect whose hello has not been answered when the tick observes
    // capability, and is answered during the tick's scan-gate read.
    fts.getConnectionGeneration.mockReturnValue(2);
    let capable = false;
    fts.supportsFolderMembership.mockImplementation(() => capable);
    const realGet = globalThis.browser.storage.local.get.getMockImplementation();
    globalThis.browser.storage.local.get.mockImplementation(async (...args) => {
      const keys = [args[0]].flat();
      if (!capable && keys.includes('fts_scan_status')) capable = true;
      return realGet(...args);
    });
    fts.listFolderMembershipState.mockClear();

    const flipped = await settleSchedulerTickWithFakeTimers(fts);

    expect(capable).toBe(true);
    expect(flipped?.complete).not.toBe(true);
    expect(nativeRows.has(stale)).toBe(true);
    // The next ticks run the cleanup pass under the new connection.
    const healed = await tickUntil(fts, value => !nativeRows.has(stale) && value?.complete === true);
    expect(nativeRows.has(stale)).toBe(false);
    expect(healed).toMatchObject({ complete: true });
    expect(fts.listFolderMembershipState).toHaveBeenCalled();
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
  });

  it('never credits completion when capability leaves during the tick with cleanup unproven', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, nativeRows } = installExactMembershipFolders([
      { folderPath: '/A', headerMessageIds: ['a-1@example.com'] },
      { folderPath: '/Z', headerMessageIds: [] },
    ], { assigned: true });
    // A NULL-owner row no recheck can classify keeps global cleanup unproven;
    // its folder's repair backs off, so later ticks have no folder target.
    nativeRows.set('account1:/A:unresolvable@example.com', null);
    recheckMessageInFolder.mockResolvedValue('error');
    let before;
    for (let work = 0, guard = 0; work < 16 && guard < 320; guard++) {
      before = await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + 100);
      if (!isSkippedTick(before)) work++;
    }
    expect(before?.complete).not.toBe(true);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    // A disconnect lands during the tick's scan-gate read: the tick observed
    // capability before its first await, the cleanup pass sees none.
    let capable = true;
    fts.supportsFolderMembership.mockImplementation(() => capable);
    const realGet = globalThis.browser.storage.local.get.getMockImplementation();
    globalThis.browser.storage.local.get.mockImplementation(async (...args) => {
      const keys = [args[0]].flat();
      if (capable && keys.includes('fts_scan_status')) capable = false;
      return realGet(...args);
    });

    const flipped = await tickWorkUntil(fts, () => !capable, 10);

    expect(capable).toBe(false);
    expect(flipped?.complete).not.toBe(true);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    const status = await getIncrementalIndexerStatus();
    expect(status.folderRecon.outcomes.complete).not.toBe(true);
  });
});

// INVARIANT (PR 3b §3.2): a removal or assignment that changes a folder's
// raw-key availability hands that folder off BEFORE the mutation is
// dispatched — its durable terminal-retry authorization is revoked (removals)
// and its walk is marked — so the folder is repaired promptly even when the
// mutation's reply is lost, and a failed revocation removes nothing.
// Like tickUntil, but counts only ticks that did scheduler work: a tick the
// inter-slice floor (or an in-flight timer tick) skipped is not a turn, so a
// slow real event loop cannot use up the turn bound.
// A wake-fired slice can still be running when a settled tick returns. A
// clock jump inside it would count the jump as slice time and raise the
// scheduler's hard floor by it, so large jumps wait for it first.
async function settleInFlightFolderRecon() {
  for (let turn = 0; turn < 50 && _testExports._isFolderReconSchedulerActive(); turn++) {
    await vi.advanceTimersByTimeAsync(_testExports.FOLDER_RECON_CHUNK_DELAY_MS);
    await yieldToRealEventLoop();
  }
  expect(_testExports._isFolderReconSchedulerActive()).toBe(false);
}

const isSkippedTick = result => result?.skipped
  && (result.reason === 'hard_floor' || result.reason === 'busy');

async function tickWorkUntil(fts, done, maxWorkTicks = 30) {
  let result;
  for (let work = 0, guard = 0; work < maxWorkTicks && guard < 20 * maxWorkTicks; guard++) {
    result = await settleSchedulerTickWithFakeTimers(fts);
    vi.setSystemTime(Date.now() + 100);
    if (done(result)) return result;
    if (!isSkippedTick(result)) work++;
  }
  return result;
}

describe('affected-folder handoff for membership removals and assignments', () => {
  afterEach(quiesceFolderReconAfterTest);
  const childKey = 'account1:/F:Child';
  const childMessage = 'account1:/F:Child:x@example.com';

  // Keys the missing direction found absent from the index (each is then
  // enqueued for indexing); the drain may consume the queue entry later.
  function trackMissingFound(fts) {
    const found = new Set();
    const filter = fts.filterNewMessages.getMockImplementation();
    fts.filterNewMessages.mockImplementation(async (...args) => {
      const result = await filter(...args);
      for (const msgId of result.newMsgIds) found.add(msgId);
      return result;
    });
    return found;
  }

  function retryNotBeforeMs(folderKey) {
    return storageData[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders?.[folderKey]
      ?.partialRetryNotBeforeMs || 0;
  }

  // State pages are refused until released, so folder turns alone run.
  function holdStatePages(fts) {
    const read = fts.listFolderMembershipState.getMockImplementation();
    let held = true;
    fts.listFolderMembershipState.mockImplementation(async (...args) => {
      if (held) throw new Error('state page held by the test');
      return read(...args);
    });
    return { release: () => { held = false; } };
  }

  // /F:Child holds x; its row is owned by a deleted /F (stale owner) or by
  // nobody (NULL). Either way /F:Child's owner listing lacks x, the missing
  // direction finds the key indexed, and /F:Child earns durable terminal
  // backoff while the state pass is held.
  async function seedChildWithDurableBackoff(owner) {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const installed = installExactMembershipFolders([
      { folderPath: '/F:Child', headerMessageIds: ['x@example.com'] },
    ], { assigned: true });
    installed.nativeRows.set(childMessage, owner);
    _testExports._setFtsSearch(installed.fts);
    const gate = holdStatePages(installed.fts);
    await tickWorkUntil(installed.fts, () => retryNotBeforeMs(childKey) > Date.now(), 30);
    expect(retryNotBeforeMs(childKey), '/F:Child earned durable backoff').toBeGreaterThan(Date.now());
    expect(installed.fts.filterNewMessages).toHaveBeenCalled();
    expect(_testExports._getPendingUpdates().has(childMessage)).toBe(false);
    return { ...installed, gate, missingFound: trackMissingFound(installed.fts) };
  }

  it('revokes the backoff before a stale-owner removal frees the key, and repairs the folder promptly', async () => {
    const { fts, nativeRows, gate, missingFound } = await seedChildWithDurableBackoff(
      makeFolderMembershipId('account1', '/F'));
    const backoffUntil = retryNotBeforeMs(childKey);
    gate.release();

    await tickWorkUntil(fts, () => missingFound.has(childMessage), 12);

    expect(fts.removeBatch).toHaveBeenCalledWith([childMessage], expect.anything());
    expect(nativeRows.has(childMessage)).toBe(false);
    expect(missingFound.has(childMessage), 'the freed key is found missing and enqueued').toBe(true);
    expect(Date.now()).toBeLessThan(backoffUntil);
  });

  it('writes no storage for a removal when no affected folder holds retry authorization', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, nativeRows } = installExactMembershipFolders([
      { folderPath: '/F:Child', headerMessageIds: ['x@example.com'] },
    ], { assigned: true });
    const ghost = 'account1:/F:Child:gone@example.com';
    nativeRows.set(ghost, makeFolderMembershipId('account1', '/F'));
    const writes = () => globalThis.browser.storage.local.set.mock.calls.length;
    const before = writes();

    const result = await _testExports._runFolderReconSchedulerTick(fts);

    expect(result.migration).toBeDefined();
    expect(fts.removeBatch).toHaveBeenCalledWith([ghost], expect.anything());
    expect(writes()).toBe(before);
  });

  it.each(['read', 'write'])('removes nothing when the revocation fails on storage %s, then repairs after recovery', async (failure) => {
    const { fts, nativeRows, gate, missingFound } = await seedChildWithDurableBackoff(
      makeFolderMembershipId('account1', '/F'));
    const backoffUntil = retryNotBeforeMs(childKey);
    // Storage fails only between the state page read and the end of that
    // pass turn: the revocation is the turn's only storage access there.
    let armed = false;
    const read = fts.listFolderMembershipState.getMockImplementation();
    fts.listFolderMembershipState.mockImplementationOnce(async (...args) => {
      const page = await read(...args);
      armed = true;
      return page;
    });
    const method = failure === 'read' ? 'get' : 'set';
    const storageOp = globalThis.browser.storage.local[method].getMockImplementation();
    globalThis.browser.storage.local[method].mockImplementation(async (...args) => {
      if (armed) throw new Error(`storage ${failure} failed`);
      return storageOp(...args);
    });
    gate.release();

    let failed;
    for (let turn = 0; turn < 3 && !armed; turn++) {
      await settleInFlightFolderRecon();
      vi.setSystemTime(Date.now() + reconConfig.errorDelayMs);
      failed = await _testExports._runFolderReconSchedulerTick(fts);
    }
    armed = false;

    expect(failed.migration).toMatchObject({ failed: true, reason: 'membership_retry_revoke_failed' });
    expect(fts.removeBatch).not.toHaveBeenCalled();
    expect(nativeRows.get(childMessage)).toBe(makeFolderMembershipId('account1', '/F'));
    expect(retryNotBeforeMs(childKey)).toBe(backoffUntil);

    await tickWorkUntil(fts, () => missingFound.has(childMessage), 40);
    expect(nativeRows.has(childMessage)).toBe(false);
    expect(missingFound.has(childMessage), 'the freed key is found missing and enqueued').toBe(true);
    expect(Date.now()).toBeLessThan(backoffUntil);
  });

  it('repairs the folder when a stale-owner removal commits but its reply is lost', async () => {
    const { fts, nativeRows, gate, missingFound } = await seedChildWithDurableBackoff(
      makeFolderMembershipId('account1', '/F'));
    const backoffUntil = retryNotBeforeMs(childKey);
    const remove = fts.removeBatch.getMockImplementation();
    fts.removeBatch.mockImplementationOnce(async (...args) => {
      await remove(...args);
      throw new Error('native reply lost');
    });
    gate.release();

    await tickWorkUntil(fts, () => missingFound.has(childMessage), 12);

    expect(fts.removeBatch).toHaveBeenCalledTimes(1);
    expect(nativeRows.has(childMessage)).toBe(false);
    expect(missingFound.has(childMessage), 'the freed key is found missing and enqueued').toBe(true);
    expect(Date.now()).toBeLessThan(backoffUntil);
  });

  it('credits the folder when its assignment commits but the reply is lost', async () => {
    const { fts, nativeRows, gate, folders } = await seedChildWithDurableBackoff(null);
    const backoffUntil = retryNotBeforeMs(childKey);
    const assign = fts.assignFolderMembershipBatch.getMockImplementation();
    fts.assignFolderMembershipBatch.mockImplementationOnce(async (...args) => {
      await assign(...args);
      throw new Error('native reply lost');
    });
    gate.release();

    await tickWorkUntil(fts, () => _testExports._getFolderReconSessionDone().has(childKey), 12);

    expect(nativeRows.get(childMessage)).toBe(folders[0].folderId);
    expect(_testExports._getFolderReconSessionDone().has(childKey)).toBe(true);
    expect(Date.now()).toBeLessThan(backoffUntil);
  });

  it('backs off a page whose removal is rejected before it commits, with no tight loop of folder attempts', async () => {
    const { fts, nativeRows, gate, missingFound } = await seedChildWithDurableBackoff(
      makeFolderMembershipId('account1', '/F'));
    fts.removeBatch.mockRejectedValue(new Error('disk I/O error'));
    // Slices of /F:Child's reconcile: each opens with a token-creating read.
    const childAttempts = () => globalThis.browser.tmMsgNotify.getFolderState.mock.calls
      .filter(([, folderPath, options]) => folderPath === '/F:Child' && options?.ensureIncarnationToken)
      .length;
    const attemptsBefore = childAttempts();
    gate.release();
    const startedAt = Date.now();

    await tickWorkUntil(fts, () => false, 40);

    // 1 s, 2 s, 4 s, ... between page attempts.
    const elapsedS = (Date.now() - startedAt) / reconConfig.errorDelayMs;
    const bound = Math.floor(Math.log2(elapsedS + 1)) + 1;
    expect(fts.removeBatch.mock.calls.length).toBeGreaterThan(0);
    expect(fts.removeBatch.mock.calls.length, `page attempts after ${elapsedS}s`).toBeLessThanOrEqual(bound);
    // Each page attempt owes /F:Child one walk: a sweep plus its one
    // immediate replay before the durable backoff holds again, each at most
    // a digest slice and a missing-direction slice.
    expect(childAttempts() - attemptsBefore, `/F:Child slices after ${elapsedS}s`)
      .toBeLessThanOrEqual(4 * fts.removeBatch.mock.calls.length);
    expect(nativeRows.has(childMessage)).toBe(true);
  });

  it('hands a folder-work stale removal of an overlapping key to the other folder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, nativeRows } = installExactMembershipFolders([
      { folderPath: '/F', headerMessageIds: ['f-1@example.com'] },
      { folderPath: '/F:Child', headerMessageIds: ['x@example.com'] },
    ], { assigned: true });
    // /F owns a row whose raw key is /F:Child's message: /F's stale
    // direction removes it (no Message-ID Child:x@ in /F), which frees the
    // key /F:Child needs.
    nativeRows.set(childMessage, makeFolderMembershipId('account1', '/F'));
    let staleVerdict = 'error';
    recheckMessageInFolder.mockImplementation(async headerId =>
      (headerId === 'Child:x@example.com' ? staleVerdict : 'absent'));
    _testExports._setFtsSearch(fts);
    const missingFound = trackMissingFound(fts);
    await tickWorkUntil(fts, () => retryNotBeforeMs(childKey) > Date.now(), 40);
    const backoffUntil = retryNotBeforeMs(childKey);
    expect(backoffUntil).toBeGreaterThan(Date.now());

    staleVerdict = 'absent';
    await tickWorkUntil(fts, () => missingFound.has(childMessage), 40);

    expect(nativeRows.has(childMessage)).toBe(false);
    expect(missingFound.has(childMessage), 'the freed key is found missing and enqueued').toBe(true);
    expect(Date.now()).toBeLessThan(backoffUntil);
  });
});

// INVARIANT (PR 3b §3.3): unresolved debt is retried in-session after
// membershipUnresolvedRetryMs, never declared complete; folder work and
// earlier folder deferrals are not held behind that delay.
describe('in-session unresolved retry while cleanup is incomplete', () => {
  afterEach(quiesceFolderReconAfterTest);

  function seed(specs) {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const installed = seedMigratedExactFolders(specs);
    _testExports._setFtsSearch(installed.fts);
    return installed;
  }
  const unresolvedReplays = () =>
    _testExports._getFolderReconRuntimeTelemetry().membershipStateRestartUnresolvedReplay;

  it('waits out the retry delay without reading state pages, then replays from before-first', async () => {
    const { fts, nativeRows } = seed([
      { folderPath: '/A', headerMessageIds: ['a-1@example.com'] },
      { folderPath: '/Z', headerMessageIds: [] },
    ]);
    nativeRows.set('account1:/A:unresolvable@example.com', null);
    recheckMessageInFolder.mockResolvedValue('error');
    await tickWorkUntil(fts, () => unresolvedReplays() > 0
      && _testExports._getFolderReconSessionDone().size === 2, 20);
    const replayDueMs = _testExports._getFolderMembershipStatePass().notBeforeMs;
    expect(replayDueMs).toBeGreaterThan(Date.now());
    const reads = fts.listFolderMembershipState.mock.calls.length;

    const waiting = await tickWorkUntil(fts, result => result?.reason === 'unresolved_retry_wait', 4);
    expect(waiting).toEqual({ complete: false, reason: 'unresolved_retry_wait' });
    expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(reads);

    // From here only the armed wakes run slices: none reads a state page
    // before the replay is due, and one replays from before-first after it.
    const stepMs = reconConfig.membershipUnresolvedRetryMs / 40;
    while (fts.listFolderMembershipState.mock.calls.length === reads
        && Date.now() < replayDueMs + 4 * stepMs) {
      await vi.advanceTimersByTimeAsync(stepMs);
      await yieldToRealEventLoop();
      if (Date.now() < replayDueMs) expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(reads);
    }
    expect(fts.listFolderMembershipState.mock.calls.length).toBeGreaterThan(reads);
    expect(fts.listFolderMembershipState.mock.calls[reads][0]).toBeNull();
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
  });

  it('wakes for a folder deferral that ends before the replay and repairs that folder first', async () => {
    const installed = seed([
      { folderPath: '/A', headerMessageIds: ['a-1@example.com'] },
      { folderPath: '/Z', headerMessageIds: [] },
    ]);
    const { fts, nativeRows, rowsByURI, folders } = installed;
    nativeRows.set('account1:/A:unresolvable@example.com', null);
    recheckMessageInFolder.mockResolvedValue('error');
    await tickWorkUntil(fts, () => unresolvedReplays() > 0
      && _testExports._getFolderReconSessionDone().size === 2, 20);
    const replayDueMs = _testExports._getFolderMembershipStatePass().notBeforeMs;
    // A dropped addition in /Z: the abandonment marks /Z and defers it.
    const missing = 'account1:/Z:missing@example.com';
    rowsByURI.get(folders[1].folderURI).push({ msgKey: 77, headerMessageId: 'missing@example.com' });
    await _testExports.onExperimentMessageAdded({
      accountId: 'account1', folderPath: '/Z', weFolderId: folders[1].weFolderId,
      headerMessageId: 'missing@example.com', msgKey: 77, eventType: 'msgAdded',
    });
    expect((await abandonAllQueued()).dropped).toBe(1);

    const waiting = await tickWorkUntil(fts, result => result?.reason === 'unresolved_retry_wait', 4);
    expect(waiting?.reason).toBe('unresolved_retry_wait');
    // From here only the armed wakes run slices: the folder's first-failure
    // deferral, not the replay, must wake the scheduler.
    const wakeBoundMs = Date.now() + 10 * reconConfig.errorDelayMs;
    expect(wakeBoundMs).toBeLessThan(replayDueMs);
    while (!_testExports._getPendingUpdates().has(missing) && Date.now() < wakeBoundMs) {
      await vi.advanceTimersByTimeAsync(reconConfig.errorDelayMs / 4);
      await yieldToRealEventLoop();
    }
    expect(_testExports._getPendingUpdates().has(missing)).toBe(true);
    expect(Date.now()).toBeLessThan(replayDueMs);
  });

  it('never completes while a ghost is unresolved, and removes it by the delayed replay', async () => {
    const { fts, nativeRows } = seed([{ folderPath: '/A', headerMessageIds: [] }]);
    const ghost = 'account1:/A:ghost@example.com';
    nativeRows.set(ghost, null);
    recheckMessageInFolder.mockResolvedValueOnce('error');
    const results = [];
    await tickWorkUntil(fts, (result) => {
      results.push(result);
      return unresolvedReplays() > 0;
    }, 10);
    const replayDueMs = _testExports._getFolderMembershipStatePass().notBeforeMs;
    for (let turn = 0; turn < 6; turn++) results.push(await settleSchedulerTickWithFakeTimers(fts));
    expect(nativeRows.has(ghost)).toBe(true);
    expect(results.some(result => result?.complete === true)).toBe(false);
    expect(await sessionSettled()).toBe(false);

    await settleInFlightFolderRecon();
    vi.setSystemTime(replayDueMs);
    await tickWorkUntil(fts, () => _testExports._getFolderMembershipCleanupProven(), 10);
    expect(nativeRows.has(ghost)).toBe(false);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    await tickWorkUntil(fts, () => !reconWorkOwed(), 4);
    expect(await sessionSettled()).toBe(true);
  });

  it('adopts a live ownerless row in-session and credits its folder without waiting for its backoff', async () => {
    const { fts, nativeRows, folders } = seed([
      { folderPath: '/A', headerMessageIds: ['live@example.com'] },
    ]);
    const live = 'account1:/A:live@example.com';
    nativeRows.set(live, null);
    globalThis.browser.tmMsgNotify.probeMessageIds.mockRejectedValueOnce(new Error('msgDB unavailable'));
    recheckMessageInFolder.mockResolvedValueOnce('error');
    await tickWorkUntil(fts, () => unresolvedReplays() > 0, 10);
    // The deficit (an ownerless row is in no owner listing) is never credited.
    await tickWorkUntil(fts, () => storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
      ?.folders?.['account1:/A']?.partialRetryNotBeforeMs > Date.now(), 20);
    const checkpoint = storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders['account1:/A'];
    expect(checkpoint.partialRetryNotBeforeMs).toBeGreaterThan(Date.now());
    expect(_testExports._getFolderReconSessionDone().has('account1:/A')).toBe(false);
    expect(nativeRows.get(live)).toBeNull();

    await settleInFlightFolderRecon();
    vi.setSystemTime(_testExports._getFolderMembershipStatePass().notBeforeMs);
    await tickWorkUntil(fts, () => _testExports._getFolderReconSessionDone().has('account1:/A'), 10);
    expect(nativeRows.get(live)).toBe(folders[0].folderId);
    expect(_testExports._getFolderReconSessionDone().has('account1:/A')).toBe(true);
    expect(Date.now()).toBeLessThan(checkpoint.partialRetryNotBeforeMs);
  });

  it('starts with a state-pass slice after a native reconnect and after a generation retirement', async () => {
    const { fts, nativeRows } = seed([
      { folderPath: '/A', headerMessageIds: ['a-1@example.com'] },
      { folderPath: '/Z', headerMessageIds: [] },
    ]);
    for (let i = 0; i < 4 * reconConfig.rechecksPerSlice; i++) {
      nativeRows.set(`account1:/A:undecided-${i}@example.com`, null);
    }
    recheckMessageInFolder.mockResolvedValue('error');
    // Stop where the next slice would be a folder turn.
    await tickWorkUntil(fts, () => fts.listFolderMembershipState.mock.calls.length > 0
      && _testExports._getFolderReconMembershipTurn() === 'folders', 6);
    expect(_testExports._getFolderReconMembershipTurn()).toBe('folders');

    // Record every slice (armed wakes included): a state page read is a pass
    // slice; a folder reconcile opens with an incarnation-token read.
    const sequence = [];
    const listState = fts.listFolderMembershipState.getMockImplementation();
    fts.listFolderMembershipState.mockImplementation((...args) => {
      sequence.push({ slice: 'pass', after: args[0] });
      return listState(...args);
    });
    const getFolderState = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
    globalThis.browser.tmMsgNotify.getFolderState.mockImplementation((...args) => {
      if (args[2]?.ensureIncarnationToken === true) sequence.push({ slice: 'folders' });
      return getFolderState(...args);
    });
    fts.getConnectionGeneration.mockReturnValue(2);
    await tickWorkUntil(fts, () => sequence.length > 0, 3);
    expect(sequence[0]).toEqual({ slice: 'pass', after: null });

    _testExports._resetFolderReconState();
    _testExports._setIsEnabled(true);
    _testExports._setIndexerDisposed(false);
    expect(_testExports._getFolderReconMembershipTurn()).toBe('pass');
  });

  it('arms the rolling re-walk before cleanup completes and repairs a late native removal', async () => {
    const { fts, nativeRows } = seed([
      { folderPath: '/A', headerMessageIds: ['a-1@example.com'] },
      { folderPath: '/Z', headerMessageIds: [] },
    ]);
    nativeRows.set('account1:/Z:unresolvable@example.com', null);
    recheckMessageInFolder.mockResolvedValue('error');
    await tickWorkUntil(fts, () => _testExports._getFolderReconSessionDone().has('account1:/A'), 20);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    expect(_testExports._getFolderReconRollingDueMs()).toBeGreaterThan(0);
    expect(_testExports._getFolderReconNextWalkDueMs().has('account1:/A')).toBe(true);
    const missingFound = new Set();
    const filter = fts.filterNewMessages.getMockImplementation();
    fts.filterNewMessages.mockImplementation(async (...args) => {
      const result = await filter(...args);
      result.newMsgIds.forEach(msgId => missingFound.add(msgId));
      return result;
    });

    // A timed-out native removal commits after /A's certification.
    nativeRows.delete('account1:/A:a-1@example.com');
    await settleInFlightFolderRecon();
    vi.setSystemTime(Date.now() + reconConfig.walkPeriodMs + reconConfig.reverifyIntervalMs);
    await tickWorkUntil(fts, () => missingFound.has('account1:/A:a-1@example.com'), 12);
    expect(missingFound.has('account1:/A:a-1@example.com')).toBe(true);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
  });
});

// DISCLOSED COST (PR 3b §3.2, P3B-R6 R1): exact folder work before cleanup
// means a folder visited before the pass assigns its ownerless rows shows a
// deficit and sweeps its keys for nothing. The waste is one-time and bounded
// by (NULL rows visited early) / missingPageKeys per visit, at most two visits
// (the sweep and its one immediate replay); afterwards the folder is credited
// once the pass assigns it.
describe('mass-NULL migration cost', () => {
  afterEach(quiesceFolderReconAfterTest);

  it.each([
    // /A is first in round-robin but its keys sort after /A-b's ('-' < ':').
    ['after a larger folder', 1200, 3000],
    // Control: /A's rows come first and fit one state page.
    ['first', reconConfig.membershipStatePageSize, 0],
  ])('bounds the wasted sweeps of a folder whose rows the pass reaches %s', async (_label, aRows, otherRows) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const ids = (prefix, count) => Array.from({ length: count },
      (_, index) => `${prefix}-${String(index).padStart(5, '0')}@example.com`);
    const installed = installExactMembershipFolders([
      { folderPath: '/A', headerMessageIds: ids('a', aRows) },
      ...(otherRows > 0 ? [{ folderPath: '/A-b', headerMessageIds: ids('b', otherRows) }] : []),
    ]);
    const { fts, nativeRows, folders } = installed;
    _testExports._setFtsSearch(fts);
    const aKey = 'account1:/A';
    const aOwner = folders[0].folderId;
    const aRowsAssigned = () => [...nativeRows].filter(([msgId, owner]) =>
      msgId.startsWith(`${aKey}:`) && owner === aOwner).length;
    let wastedSweeps = 0;
    const filter = fts.filterNewMessages.getMockImplementation();
    fts.filterNewMessages.mockImplementation(async (rows, ...rest) => {
      if (aRowsAssigned() === 0 && rows.some(row => row.msgId.startsWith(`${aKey}:`))) wastedSweeps++;
      return filter(rows, ...rest);
    });
    const aMemoWrites = () => globalThis.browser.storage.local.set.mock.calls.filter(([patch]) =>
      Object.hasOwn(patch[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders || {}, aKey)).length;
    let aMemoWritesBeforeAssignment = 0;

    const maxTicks = 8 * Math.ceil((aRows + otherRows) / reconConfig.membershipStatePageSize) + 40;
    await tickWorkUntil(fts, () => {
      if (aRowsAssigned() === 0) aMemoWritesBeforeAssignment = aMemoWrites();
      return aRowsAssigned() === aRows;
    }, maxTicks);
    expect(aRowsAssigned()).toBe(aRows);
    // Termination only (the cost bounds are the counters above): one
    // owner-listing page per folder turn, and one active proof at a time
    // (/A-b's may hold the working set). Slack for slices that yield early
    // when the host is loaded.
    await tickWorkUntil(fts, () => _testExports._getFolderReconSessionDone().has(aKey),
      8 * Math.ceil((aRows + otherRows) / reconConfig.membershipListPageSize) + 40);

    const bound = 2 * Math.ceil(aRows / reconConfig.missingPageKeys);
    expect(wastedSweeps).toBeLessThanOrEqual(otherRows > 0 ? bound : 0);
    expect(aMemoWritesBeforeAssignment).toBeLessThanOrEqual(otherRows > 0 ? bound : 0);
    expect(_testExports._getFolderReconSessionDone().has(aKey)).toBe(true);
    expect(_testExports._getPendingUpdates().size).toBe(0);
  }, 60_000);
});

// INVARIANT (stage 3b): a state-pass verdict is voided by changes to its own
// raw key — recorded synchronously at the event ingress and at queue
// admission, before any await — and never by traffic on other keys, so
// ordinary mail cannot hold the pass, and a key ledger overflow or an event
// naming no folder still refuses rather than trusting stale evidence.
describe('state-pass evidence is scoped to the row\'s own key', () => {
  afterEach(quiesceFolderReconAfterTest);

  const eventInfo = (folderPath, headerMessageId, eventType = 'msgAdded') => ({
    accountId: 'account1', folderPath, weFolderId: `we:${folderPath}`,
    headerMessageId, msgKey: 1, eventType,
  });
  const keyChangedSince = (key, since) =>
    !_testExports._folderReconLocalExactKeyUnchangedSince(key, since);

  it.each([
    {
      event: 'add',
      deliver: () => [_testExports.onExperimentMessageAdded(eventInfo('/F', 'a@example.com'))],
      keys: ['account1:/F:a@example.com'],
    },
    {
      event: 'delete',
      deliver: () => [_testExports.onExperimentMessageRemoved(eventInfo('/F', 'a@example.com', 'msgsDeleted'))],
      keys: ['account1:/F:a@example.com'],
    },
    {
      event: 'move',
      deliver: () => [
        _testExports.onExperimentMessageRemoved(eventInfo('/F', 'a@example.com', 'msgsMoveCopyCompleted')),
        _testExports.onExperimentMessageAdded(eventInfo('/G', 'a@example.com', 'msgsMoveCopyCompleted')),
      ],
      keys: ['account1:/F:a@example.com', 'account1:/G:a@example.com'],
    },
    {
      event: 'multi-message batch',
      deliver: () => ['a', 'b', 'c'].map(id =>
        _testExports.onExperimentMessageAdded(eventInfo('/F', `${id}@example.com`, 'msgsClassified'))),
      keys: ['account1:/F:a@example.com', 'account1:/F:b@example.com', 'account1:/F:c@example.com'],
    },
    {
      event: 'add whose Message-ID carries angle brackets',
      deliver: () => [_testExports.onExperimentMessageAdded(eventInfo('/F', '<a@example.com>'))],
      keys: ['account1:/F:a@example.com'],
    },
  ])('records the raw keys of a $event before the listener first awaits', async ({ deliver, keys }) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const since = _testExports._getFolderReconEventSerial();

    const delivered = deliver();

    for (const key of keys) expect(keyChangedSince(key, since), key).toBe(true);
    expect(keyChangedSince('account1:/F:unrelated@example.com', since)).toBe(false);
    await Promise.all(delivered);
  });

  it('records the key of an admission the queue high water rejects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    _testExports._setFtsSearch({});
    for (let i = 0; i < reconConfig.pendingHighWater; i++) {
      _testExports._getPendingUpdates().set(`account1:/F:queued-${i}@example.com`, {
        type: 'new', uniqueKey: `account1:/F:queued-${i}@example.com`, timestamp: Date.now(),
        folderKey: 'account1:/F',
      });
    }
    const late = 'account1:/F:late@example.com';
    getUniqueMessageKey.mockResolvedValue(late);
    const since = _testExports._getFolderReconEventSerial();

    // A stock listener: no experiment ingress records this key.
    expect(keyChangedSince(late, since)).toBe(false);
    incrementalIndexer.onNewMailReceived({ name: 'F' }, [{
      id: 1, headerMessageId: 'late@example.com', folder: { accountId: 'account1', path: '/F' },
    }]);
    await vi.waitFor(() => expect(keyChangedSince(late, since)).toBe(true));

    expect(getUniqueMessageKey).toHaveBeenCalled();
    expect(_testExports._getPendingUpdates().has(late)).toBe(false);
    expect(_testExports._getPendingUpdates().size).toBe(reconConfig.pendingHighWater);
    expect(keyChangedSince('account1:/F:unrelated@example.com', since)).toBe(false);
  });

  // The local key ledger is bounded: a burst on other keys that evicts past a
  // verdict's baseline refuses that row and the page's ghost removal (never
  // trusts them), and the page and the delayed replay go on.
  it('refuses a row whose verdict the local key ledger\'s floor passed, and replays it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['cold@example.com'] },
      { folderPath: '/Other', headerMessageIds: [] },
    ]);
    const cold = 'account1:/F:cold@example.com';
    const later = 'account1:/Other:later@example.com';
    nativeRows.set(cold, null);
    nativeRows.set(later, null);
    _testExports._setFtsSearch(fts);
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    let burst = false;
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      if (!burst && ids[0] === 'cold@example.com') {
        burst = true;
        for (let i = 0; i <= _testExports.FOLDER_RECON_CHANGE_LEDGER_KEY_CAP; i++) {
          _testExports._invalidateFolderReconProofForMessageEvent(eventInfo('/Other', `burst-${i}@example.com`));
        }
      }
      return probe(uri, ids);
    });

    const first = await settleSchedulerTickWithFakeTimers(fts);

    expect(burst).toBe(true);
    expect(nativeRows.get(cold)).toBeNull();
    expect(nativeRows.has(later)).toBe(true);
    const telemetry = _testExports._getFolderReconRuntimeTelemetry();
    expect(telemetry.membershipStateRowsRefused).toBe(2);
    expect(telemetry.membershipStatePageRetries).toBe(0);
    expect(first).toMatchObject({ migration: { restart: true, reason: 'unresolved_legacy_rows' } });
    await tickThroughUnresolvedReplay(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(nativeRows.get(cold)).toBe(folders[0].folderId);
    expect(nativeRows.has(later)).toBe(false);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
  });

  // The native key ledger is bounded too: writes on other keys that evict
  // past the inventory's epoch refuse the removal fence (a page retry), and
  // the next inventory's fresh baseline removes the ghost.
  it('refuses a removal whose baseline the native key ledger\'s floor passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['live@example.com'] },
    ]);
    _resetFtsOperationCoordinatorForTests({ changeLedgerKeyCap: 2 });
    const ghost = 'account1:/F:ghost@example.com';
    nativeRows.set(ghost, null);
    const list = fts.listFolderMembershipState.getMockImplementation();
    fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
      const page = await list(after, limit);
      for (const id of ['x', 'y', 'z']) {
        await runFtsMembershipMutation(async () => ({ ok: true }), null,
          { folderIds: [folders[0].folderId], keys: [`account1:/F:${id}@example.com`] });
      }
      return page;
    });

    const first = await settleSchedulerTickWithFakeTimers(fts);

    expect(first).toMatchObject({ migration: { retry: true, reason: 'stale_folder_remove_fence_lost' } });
    expect(nativeRows.has(ghost)).toBe(true);
    vi.setSystemTime(Date.now() + 100);
    await tickUntil(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(nativeRows.has(ghost)).toBe(false);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
  });

  // Same-key traffic on one live ownerless row, delivered
  // during every state-pass turn for 40 simulated minutes, refuses only that
  // row; a later ghost in cursor order is removed while it continues, and no
  // completion is granted while the row is unresolved. Once the traffic
  // stops, the delayed replay assigns the row.
  it('sustained traffic on one row\'s own key holds neither a later ghost nor the replay after it stops', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['a-live@example.com'] },
    ]);
    const live = 'account1:/F:a-live@example.com';
    const ghost = 'account1:/F:b-ghost@example.com';
    nativeRows.set(live, null);
    nativeRows.set(ghost, null);
    _testExports._setFtsSearch(fts);
    let traffic = true;
    let deliveries = 0;
    const probe = globalThis.browser.tmMsgNotify.probeMessageIds.getMockImplementation();
    globalThis.browser.tmMsgNotify.probeMessageIds.mockImplementation(async (uri, ids) => {
      if (traffic && ids.includes('a-live@example.com')) {
        deliveries++;
        // A delivered copy of the same message: its drain finds the row.
        await _testExports.onExperimentMessageAdded({
          accountId: 'account1', folderPath: '/F', weFolderId: folders[0].weFolderId,
          headerMessageId: 'a-live@example.com', msgKey: 100 + deliveries, eventType: 'msgAdded',
        });
        _testExports._getPendingUpdates().clear();
      }
      return probe(uri, ids);
    });
    const startedAt = Date.now();

    let ghostRemovedAt = null;
    while (Date.now() - startedAt < 40 * 60 * 1000) {
      await settleSchedulerTickWithFakeTimers(fts);
      if (ghostRemovedAt === null && !nativeRows.has(ghost)) ghostRemovedAt = Date.now();
      vi.setSystemTime(Date.now() + 60 * 1000);
    }

    expect(deliveries).toBeGreaterThan(2);
    expect(ghostRemovedAt).not.toBeNull();
    expect(ghostRemovedAt - startedAt).toBeLessThan(reconConfig.membershipUnresolvedRetryMs);
    expect(nativeRows.get(live)).toBeNull();
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(false);
    expect(_testExports._getFolderReconEphemeralEvidence().orphanDone).not.toBe(true);

    traffic = false;
    await tickThroughUnresolvedReplay(fts, () => _testExports._getFolderMembershipCleanupProven());
    expect(nativeRows.get(live)).toBe(folders[0].folderId);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
  }, 30_000);

  // Ported probe: steady mail drained into the ghost's own folder (other
  // keys) during every state read no longer withholds the ghost's removal or
  // a healthy folder's repair.
  it('removes a ghost and repairs a healthy folder under steady mail in the ghost\'s folder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, rowsByURI } = seedMigratedExactFolders([
      { folderPath: '/A', headerMessageIds: ['missing@example.com'] },
      { folderPath: '/F', headerMessageIds: [] },
    ]);
    const ghost = 'account1:/F:aa-ghost@example.com';
    const missing = 'account1:/A:missing@example.com';
    nativeRows.set(ghost, null);
    nativeRows.delete(missing);
    _testExports._setFtsSearch(fts);
    let currentHeader;
    let arrivals = 0;
    headerIDToWeID.mockResolvedValue(1);
    globalThis.browser.messages.get = vi.fn(async () => currentHeader);
    getUniqueMessageKey.mockImplementation(async header => `account1:${header.folder.path}:${header.headerMessageId}`);
    buildBatchHeader.mockImplementation(async headers => headers.map(header => ({
      msgId: `account1:${header.folder.path}:${header.headerMessageId}`,
      folderId: makeFolderMembershipId('account1', header.folder.path),
    })));
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    fakeNativeFts.indexBatch.mockImplementation(async rows => {
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;
    const stateRead = fts.listFolderMembershipState.getMockImplementation();
    fts.listFolderMembershipState.mockImplementation(async (...args) => {
      const page = await stateRead(...args);
      const headerMessageId = `zz-arrival-${arrivals++}@example.com`;
      rowsByURI.get(folders[1].folderURI).push({ msgKey: 10_000 + arrivals, headerMessageId });
      currentHeader = { id: 1, headerMessageId, folder: { accountId: 'account1', path: '/F' } };
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: '/F', weFolderId: folders[1].weFolderId,
        headerMessageId, msgKey: 10_000 + arrivals, eventType: 'msgAdded',
      });
      await flushPendingUpdates();
      return page;
    });

    for (let tick = 0; tick < 20 && (nativeRows.has(ghost) || !_testExports._getPendingUpdates().has(missing)); tick++) {
      await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + reconConfig.paceDelayMs);
    }

    expect(arrivals).toBeGreaterThan(0);
    expect(nativeRows.has(ghost)).toBe(false);
    expect(_testExports._getPendingUpdates().has(missing)).toBe(true);
    expect(_testExports._getFolderReconRuntimeTelemetry().membershipStatePageRetries).toBe(0);
  }, 30_000);

  // Ported PR 3b review probe: independent mail every 4 s, including during
  // a slow global negative, pins neither a stable ownerless row nor the
  // cleanup; the ordinary and the colon-overlapping child folder are both
  // repaired.
  it('an independent 4-second mail cadence holds neither a stable row nor the cleanup', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    const { fts, folders, nativeRows, rowsByURI } = installExactMembershipFolders([
      { folderPath: '/A', headerMessageIds: ['missing@example.com'] },
      { folderPath: '/F', headerMessageIds: ['a-live@example.com'] },
      { folderPath: '/F:Child', headerMessageIds: ['child-missing@example.com'] },
    ], { assigned: true });
    const healthy = 'account1:/A:missing@example.com';
    const child = 'account1:/F:Child:child-missing@example.com';
    const stable = 'account1:/F:a-live@example.com';
    const ghost = 'account1:/F:b-ghost@example.com';
    nativeRows.delete(healthy);
    nativeRows.delete(child);
    nativeRows.set(stable, null);
    nativeRows.set(ghost, null);
    _testExports._setFtsSearch(fts);
    const headers = new Map();
    for (const folder of folders) {
      for (const row of rowsByURI.get(folder.folderURI)) {
        headers.set(row.headerMessageId, {
          id: row.headerMessageId, headerMessageId: row.headerMessageId,
          folder: { accountId: 'account1', path: folder.folderPath },
        });
      }
    }
    headerIDToWeID.mockImplementation(async id => (headers.has(id) ? id : null));
    globalThis.browser.messages.get = vi.fn(async id => headers.get(id));
    getUniqueMessageKey.mockImplementation(async header => `account1:${header.folder.path}:${header.headerMessageId}`);
    buildBatchHeader.mockImplementation(async hs => hs.map(header => ({
      msgId: `account1:${header.folder.path}:${header.headerMessageId}`,
      folderId: makeFolderMembershipId('account1', header.folder.path),
    })));
    populateBatchBody.mockImplementation(async rows => ({ successfulRows: rows, failedMsgIds: [] }));
    fakeNativeFts.indexBatch.mockImplementation(async (rows, wire) => {
      wire.withFolderIds = true;
      for (const row of rows) nativeRows.set(row.msgId, row.folderId);
      return { count: rows.length };
    });
    fts.indexBatch = engineFtsSearch.indexBatch;
    let nextMail = Date.now() + 4000;
    let arrivals = 0;
    const advanceWithMail = async target => {
      while (nextMail <= target) {
        vi.setSystemTime(nextMail);
        nextMail += 4000;
        const id = `zz-arrival-${arrivals++}@example.com`;
        headers.set(id, { id, headerMessageId: id, folder: { accountId: 'account1', path: '/F' } });
        rowsByURI.get(folders[1].folderURI).push({ msgKey: 10_000 + arrivals, headerMessageId: id });
        await _testExports.onExperimentMessageAdded({
          accountId: 'account1', folderPath: '/F', weFolderId: folders[1].weFolderId,
          headerMessageId: id, msgKey: 10_000 + arrivals, eventType: 'msgAdded',
        });
        await flushPendingUpdates();
      }
      vi.setSystemTime(target);
    };
    recheckMessageInFolder.mockImplementation(async () => {
      // A slow global negative on a large mailbox.
      await advanceWithMail(Date.now() + 5000);
      return 'absent';
    });

    for (let tick = 0; tick < 240 && !_testExports._getFolderMembershipCleanupProven(); tick++) {
      await advanceWithMail(Date.now() + 10_000);
      await settleSchedulerTickWithFakeTimers(fts);
      await flushPendingUpdates();
    }

    expect(arrivals).toBeGreaterThan(0);
    expect(nativeRows.get(stable)).toBe(folders[1].folderId);
    expect(nativeRows.has(ghost)).toBe(false);
    expect(_testExports._getFolderMembershipCleanupProven()).toBe(true);
    // Repaired = indexed, or (the child's colon-overlapping key, which this
    // fixture's naive key parser cannot resolve for the drain) enqueued.
    const repaired = key => nativeRows.has(key) || _testExports._getPendingUpdates().has(key);
    for (let tick = 0; tick < 60 && !(nativeRows.has(healthy) && repaired(child)); tick++) {
      await advanceWithMail(Date.now() + 10_000);
      await settleSchedulerTickWithFakeTimers(fts);
      await flushPendingUpdates();
    }
    expect(nativeRows.has(healthy)).toBe(true);
    expect(repaired(child)).toBe(true);
  }, 30_000);
});
