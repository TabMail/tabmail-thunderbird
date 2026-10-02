/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeFolderMembershipId } from '../fts/folderMembershipIdentity.js';

const reconConfig = {
  folderScanPageSize: 250,
  membershipAssignBatchSize: 1000,
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
  getUniqueMessageKey,
  headerIDToWeID,
  parseUniqueId,
  recheckMessageInFolder,
  resolveUniqueMessageKey,
} = await import('../agent/modules/utils.js');
const { buildBatchHeader, populateBatchBody } = await import('../fts/indexer.js');
const {
  acquireFtsExclusiveOperation,
  clearOwnedFtsScanStatus,
  getFtsMembershipEpoch,
  runFtsMembershipMutation,
  writeOwnedFtsScanStatus,
} = await import('../fts/operationCoordinator.js');
const incrementalIndexer = await import('../fts/incrementalIndexer.js');
const { _testExports, flushPendingUpdates, getIncrementalIndexerStatus } = incrementalIndexer;

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

function installExactMembershipFolders(specs, { conflictingMsgId = null } = {}) {
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
    probeMessageIds: vi.fn(async () => ({ missing: [] })),
  };
  const nativeRows = new Map();
  for (let index = 0; index < folders.length; index++) {
    for (const row of rowsByURI.get(folders[index].folderURI)) {
      const msgId = `account1:${folders[index].folderPath}:${row.headerMessageId}`;
      nativeRows.set(msgId, msgId === conflictingMsgId ? 'wrong-folder' : null);
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
    assignFolderMembershipBatch: vi.fn(async assignments => {
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
    }),
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
    removeBatch: vi.fn(async ids => {
      for (const id of ids) nativeRows.delete(id);
      return { count: ids.length };
    }),
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
    orphanBasis: { phase: 'test-basis' },
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
  // The failed drain must leave its fairness maps populated without making
  // the durable marker precondition of the exclusive-invalidation test true.
  globalThis.browser.storage.local.set
    .mockRejectedValueOnce(new Error('marker storage unavailable'));
  _testExports._setFtsSearch(fts);
  await flushPendingUpdates();
  expect(_testExports._getPendingUpdates().has(uniqueKey)).toBe(true);
  _testExports._getPendingUpdates().clear();
  delete storageData.fts_pending_updates;
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
      expect(storageData.fts_pending_updates).toEqual(expect.arrayContaining([
        expect.objectContaining({
          uniqueKey: queuedKey,
          type: 'moved',
          timestamp: captured.timestamp + 1,
        }),
      ]));
      expect(storageData.fts_reconcile_pending).toBeTruthy();

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
      expect(storageData.fts_reconcile_pending).toBeTruthy();
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
      expect(storageData.fts_reconcile_pending).toBeTruthy();
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
      storageData.fts_reconcile_pending = 123;
      _testExports._setFtsSearch(null);

      for (let turn = 0; turn < 8 && storageData.fts_reconcile_pending; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 1000);
      }
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');
      await seedDrainFailureEvidence(fts);
      _testExports._setFtsSearch(fts);
      _testExports._setFolderReconEphemeralEvidenceForTests?.({
        folderKey: 'account1:/A',
        deferredAt: Date.now() + 60_000,
        failureCount: 3,
        orphanDone: true,
        orphanBasis: { phase: 'test-basis' },
      });
      const seededEvidence = _testExports._getFolderReconEphemeralEvidence?.();
      if (seededEvidence) {
        expect(seededEvidence).toMatchObject({
          deferred: 3,
          failures: 2,
          orphanDone: true,
          hasOrphanBasis: true,
          dirty: ['account1:/Drain'],
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
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(vi.getTimerCount()).toBe(timersBeforeRelease);
      lease.release();

      expect(_testExports._getFolderReconSessionDone()).not.toContain('account1:/A');
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();
      expect(_testExports._getFolderReconEphemeralEvidence()).toEqual({
        deferred: 0,
        failures: 0,
        orphanDone: false,
        hasOrphanBasis: false,
        dirty: ['__all__', 'account1:/Drain'],
      });
      // The listener's in-memory invalidation is synchronous with release;
      // only the serialized durable marker and its subsequent wake are async.
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(vi.getTimerCount()).toBe(timersBeforeRelease);

      await _testExports._reconStorageTransaction(
        _testExports._getFolderReconGeneration(),
        () => {},
      );
      for (let turn = 0; turn < 50 && vi.getTimerCount() === 0; turn++) {
        await Promise.resolve();
      }
      expect(storageData.fts_reconcile_pending).toBeTruthy();
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      _testExports._setFtsSearch(null);
      vi.clearAllTimers();
      vi.setSystemTime(Date.now() + 1000);
      const reproved = await settleSchedulerTickWithFakeTimers(fts);
      expect(reproved.missingEnqueued).toBe(1);
      expect(_testExports._getPendingUpdates().has(liveKey)).toBe(true);
      expect(storageData.fts_reconcile_pending).toBeTruthy();
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('retries a failed post-exclusive marker before waking normal reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      seedExclusiveMembershipEvidence();
      const lease = await acquireMutatedExclusiveLease();
      globalThis.browser.storage.local.set
        .mockRejectedValueOnce(new Error('marker storage unavailable'));

      lease.release();

      // Membership proof is discarded synchronously with owner release even
      // though its durable retry marker has not yet been written.
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();
      expect(_testExports._getFolderReconEphemeralEvidence()).toEqual({
        deferred: 0,
        failures: 0,
        orphanDone: false,
        hasOrphanBasis: false,
        dirty: ['__all__'],
      });
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);

      await _testExports._reconStorageTransaction(
        _testExports._getFolderReconGeneration(),
        () => {},
      );
      for (let turn = 0; turn < 10 && vi.getTimerCount() === 0; turn++) {
        await Promise.resolve();
      }
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1); // private marker retry only

      await vi.advanceTimersByTimeAsync(reconConfig.errorDelayMs - 1);
      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(1);
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await _testExports._reconStorageTransaction(
        _testExports._getFolderReconGeneration(),
        () => {},
      );

      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(2);
      expect(storageData.fts_reconcile_pending).toBeTruthy();
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1); // ordinary scheduler wake after persistence
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('cancels a failed exclusive-marker timer on runtime disable and resumes it on re-enable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      seedExclusiveMembershipEvidence();
      const generation = _testExports._getFolderReconGeneration();
      const lease = await acquireMutatedExclusiveLease();
      globalThis.browser.storage.local.set
        .mockRejectedValueOnce(new Error('marker storage unavailable'));
      lease.release();
      await _testExports._reconStorageTransaction(generation, () => {});
      for (let turn = 0; turn < 10 && vi.getTimerCount() === 0; turn++) {
        await Promise.resolve();
      }
      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      storageData.chat_ftsIncrementalEnabled = false;
      await incrementalIndexer.updateIncrementalIndexerSettings();

      expect(_testExports._getFolderReconGeneration()).toBe(generation);
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(
        reconConfig.errorDelayMs + reconConfig.paceDelayMs,
      );
      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(1);
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();

      // The same generation must resume its durable __all__ intent without a
      // second exclusive mutation or an unrelated event.
      storageData.chat_ftsIncrementalEnabled = true;
      await incrementalIndexer.updateIncrementalIndexerSettings();
      await _testExports._reconStorageTransaction(generation, () => {});
      for (let turn = 0; turn < 10 && vi.getTimerCount() === 0; turn++) {
        await Promise.resolve();
      }

      expect(_testExports._getFolderReconGeneration()).toBe(generation);
      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(2);
      expect(storageData.fts_reconcile_pending).toBeTruthy();
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      storageData.chat_ftsIncrementalEnabled = false;
      await incrementalIndexer.updateIncrementalIndexerSettings();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    ['succeeds', true],
    ['fails', false],
  ])('does not stale-wake when an in-flight exclusive marker write %s across a runtime toggle', async (_name, writeSucceeds) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    const markerWrite = deferred();
    try {
      seedExclusiveMembershipEvidence();
      const generation = _testExports._getFolderReconGeneration();
      const lease = await acquireMutatedExclusiveLease();
      globalThis.browser.storage.local.set.mockImplementationOnce(async obj => {
        await markerWrite.promise;
        Object.assign(storageData, obj);
      });
      lease.release();
      for (let turn = 0;
        turn < 10 && globalThis.browser.storage.local.set.mock.calls.length === 0;
        turn++) {
        await Promise.resolve();
      }
      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(1);

      storageData.chat_ftsIncrementalEnabled = false;
      await incrementalIndexer.updateIncrementalIndexerSettings();
      expect(_testExports._getFolderReconGeneration()).toBe(generation);
      expect(vi.getTimerCount()).toBe(0);

      if (writeSucceeds) markerWrite.resolve();
      else markerWrite.reject(new Error('in-flight marker write failed'));
      await _testExports._reconStorageTransaction(generation, () => {});
      for (let turn = 0; turn < 10; turn++) await Promise.resolve();

      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      expect(Boolean(storageData.fts_reconcile_pending)).toBe(writeSucceeds);

      storageData.chat_ftsIncrementalEnabled = true;
      await incrementalIndexer.updateIncrementalIndexerSettings();
      await _testExports._reconStorageTransaction(generation, () => {});
      for (let turn = 0; turn < 10 && vi.getTimerCount() === 0; turn++) {
        await Promise.resolve();
      }

      expect(storageData.fts_reconcile_pending).toBeTruthy();
      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(
        writeSucceeds ? 1 : 2,
      );
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      markerWrite.resolve();
      storageData.chat_ftsIncrementalEnabled = false;
      await incrementalIndexer.updateIncrementalIndexerSettings();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('clears a private marker timer handle before checking runtime ownership', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url)),
      'utf8',
    );
    const retry = source.match(
      /async function _attemptExclusiveMarkerRetry[\s\S]*?\n}\n\nfunction _ensureExclusiveMarkerRetry/,
    )?.[0] || '';
    const callback = retry.match(
      /owner\.timer = setTimeout\(\(\) => \{([\s\S]*?)\n\s*}, FOLDER_RECON_ERROR_DELAY_MS\)/,
    )?.[1] || '';
    expect(callback.length, 'private timer callback extraction is non-vacuous')
      .toBeGreaterThan(100);
    const clearAt = callback.indexOf('owner.timer = null');
    const guardAt = callback.indexOf('_isExclusiveMarkerRetryOwnerCurrent(owner)');
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(guardAt).toBeGreaterThan(clearAt);
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
  ])('cancels a stale post-exclusive marker retry on %s', async (_name, cancelOwner) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      seedExclusiveMembershipEvidence();
      const lease = await acquireMutatedExclusiveLease();
      globalThis.browser.storage.local.set
        .mockRejectedValueOnce(new Error('marker storage unavailable'));
      lease.release();
      await _testExports._reconStorageTransaction(
        _testExports._getFolderReconGeneration(),
        () => {},
      );
      for (let turn = 0; turn < 10 && vi.getTimerCount() === 0; turn++) {
        await Promise.resolve();
      }
      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(1);

      await cancelOwner();
      await vi.advanceTimersByTimeAsync(
        reconConfig.errorDelayMs + reconConfig.paceDelayMs,
      );

      expect(globalThis.browser.storage.local.set).toHaveBeenCalledTimes(1);
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(globalThis.browser.accounts.list).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('synchronously clears every generation-local proof class before marker restore and wake', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../fts/incrementalIndexer.js', import.meta.url)),
      'utf8',
    );
    const handler = source.match(
      /function _handleExclusiveFtsMembershipChange[\s\S]*?\n}/,
    )?.[0] || '';
    const markerRetry = source.match(
      /async function _attemptExclusiveMarkerRetry[\s\S]*?\n}\n\nfunction _ensureExclusiveMarkerRetry/,
    )?.[0] || '';
    expect(handler.length, 'exclusive invalidation handler extraction is non-vacuous')
      .toBeGreaterThan(500);
    expect(markerRetry.length, 'exclusive marker retry extraction is non-vacuous')
      .toBeGreaterThan(600);
    for (const state of [
      '_folderReconSessionDone.clear()',
      '_folderReconSessionDeferred.clear()',
      '_folderReconFailureCounts.clear()',
      '_folderReconDrainFailureDeferred.clear()',
      '_folderReconDrainFailureCounts.clear()',
      '_folderReconOrphanDone = false',
      '_folderReconOrphanBasis = null',
      '_releaseFolderReconActiveProof(null, "invalidation")',
      '_folderReconDirty.add("__all__")',
    ]) {
      expect(handler).toContain(state);
    }
    const markerAt = handler.indexOf('_ensureExclusiveMarkerRetry(generation)');
    expect(markerAt).toBeGreaterThan(handler.indexOf('_folderReconDirty.add("__all__")'));
    const durableAt = markerRetry.indexOf('await _ensureFolderReconPendingMarker()');
    const wakeAt = markerRetry.indexOf('_wakeFolderRecon(');
    expect(durableAt).toBeGreaterThan(0);
    expect(wakeAt).toBeGreaterThan(durableAt);
  });

  it('does not invalidate verified session evidence for a read-only exclusive owner', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    _testExports._setFtsSearch(null);
    await _testExports._runFolderReconSchedulerTick(fts);
    expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');

    const lease = await acquireFtsExclusiveOperation('maintenance-read');
    lease.release();
    await Promise.resolve();

    expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');
    expect(_testExports._getFolderReconDirty()).not.toContain('__all__');
    expect(storageData.fts_reconcile_pending).toBeUndefined();
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
    await new Promise(resolve => setTimeout(resolve, 20));
    const resumed = await _testExports._runFolderReconSchedulerTick(fts);
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
      for (let i = 0; i <= reconConfig.pendingHighWater; i++) {
        await _testExports.onExperimentMessageAdded({
          accountId: 'account1',
          folderPath: '/INBOX',
          headerMessageId: `m-${i}@example.com`,
          msgKey: i + 1,
          eventType: 'msgAdded',
        });
      }
      expect(_testExports._getPendingUpdates().size).toBe(reconConfig.pendingHighWater);
      expect(storageData.fts_reconcile_pending).toBeTruthy();
      expect(populateBatchBody).not.toHaveBeenCalled();
    } finally {
      _testExports._setIsEnabled(false);
      vi.useRealTimers();
    }
  });

  it('advances the durable round-robin cursor so a later folder runs next', async () => {
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
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].roundRobinCursor).toBe('account1:/B');
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
    storageData.fts_reconcile_pending = 123;
    _testExports._setFtsSearch(fts);

    const result = await _testExports._runFolderReconSchedulerTick(fts);

    expect(result).toMatchObject({ skipped: true, reason: 'ambiguous_folder_keyspace' });
    expect(globalThis.browser.tmMsgNotify.probeMessageIds).not.toHaveBeenCalled();
    expect(fts.listMsgIdRange).not.toHaveBeenCalled();
    expect(fts.countMsgIdRange).not.toHaveBeenCalled();
    expect(fts.removeBatch).not.toHaveBeenCalled();
    expect(storageData.fts_reconcile_pending).toBe(123);
    expect(Object.values(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]?.folders || {}))
      .not.toContainEqual(expect.objectContaining({ verified: true }));
    const status = await getIncrementalIndexerStatus();
    expect(status.folderRecon).toMatchObject({ ambiguousGroups: 1, ambiguousFolders: 2 });
    expect(JSON.stringify(status.folderRecon)).not.toMatch(/account1|\/INBOX|live@example/);
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
      storageData.fts_reconcile_pending = 123;

      const outcomes = [];
      for (let turn = 0; turn < 10; turn++) {
        outcomes.push(await _testExports._runFolderReconSchedulerTick(fts));
        vi.setSystemTime(Date.now() + 100);
        if (_testExports._getFolderMembershipCutoverProven()
            && _testExports._getFolderReconSessionDone().size === folders.length) break;
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
      expect(globalThis.browser.tmMsgNotify.probeMessageIds).not.toHaveBeenCalled();
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
    const conflictingMsgId = 'account1:/F:suffix:child@example.com';
    const { fts } = installExactMembershipFolders([
      {
        folderPath: '/F:suffix',
        folderId: 'opaque-child',
        headerMessageIds: ['child@example.com'],
      },
    ], { conflictingMsgId });

    const result = await _testExports._runFolderReconSchedulerTick(fts);

    expect(result).toMatchObject({
      complete: false,
      migration: { failed: true, reason: 'folder_assignment_failed' },
    });
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
    expectOnlyBoundedFolderMembershipReads(fts);
    expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
      ?.folderMembershipMigration?.completedFolderIds?.[
        makeFolderMembershipId('account1', '/F:suffix')
      ]).not.toBe(true);
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
        && (!_testExports._getFolderMembershipCutoverProven()
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
        && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);

      const nfcMembershipId = makeFolderMembershipId('account1', specs[0].folderPath);
      const nfdMembershipId = makeFolderMembershipId('account1', specs[1].folderPath);
      expect(nfcMembershipId).not.toBe(nfdMembershipId);
      expect(new Set(nativeRows.values())).toEqual(new Set([
        nfcMembershipId,
        nfdMembershipId,
      ]));

      // Simulate a restart whose Thunderbird session minted different
      // MailFolder.id values, with the durable migration needing to replay
      // its idempotent per-folder assignment proof.
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
      const migration = storageData[_testExports.FOLDER_RECON_STORAGE_KEY]
        .folderMembershipMigration;
      migration.completedFolderIds = {};
      migration.cutoverProven = false;
      fts.assignFolderMembershipBatch.mockClear();
      _testExports._resetFolderReconState();
      _testExports._setIsEnabled(true);
      _testExports._setIndexerDisposed(false);
      _testExports._setFtsSearch(fts);
      _testExports._setLastSyncEventMs(0);

      for (let turn = 0; turn < 40
        && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        const result = await settleSchedulerTickWithFakeTimers(fts);
        expect(result?.migration?.reason).not.toBe('folder_assignment_failed');
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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

  it('keeps cutover incomplete when a global state row has no unique live owner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/F',
        folderId: 'opaque-parent',
        headerMessageIds: [],
      }]);
      nativeRows.set('account1:/Gone:orphan@example.com', null);

      await _testExports._runFolderReconSchedulerTick(fts); // empty folder scan
      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts); // durable state-pass reset
      vi.setSystemTime(Date.now() + 100);
      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({
        complete: false,
        migration: { failed: true, restart: true, reason: 'unresolved_legacy_rows' },
      });
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      expect(nativeRows.get('account1:/Gone:orphan@example.com')).toBeNull();
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
      await _testExports._runFolderReconSchedulerTick(fts); // empty folder scan
      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts); // session reset
      vi.setSystemTime(Date.now() + 100);

      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({
        complete: false,
        migration: { failed: true, restart: true, reason: 'unresolved_legacy_rows' },
      });
      expect(nativeRows.has(mismatched)).toBe(true);
      expect(fts.removeBatch).not.toHaveBeenCalled();
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('treats a live-scan assignment for a vanished native row as an accounted no-op', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const msgId = 'account1:/F:vanished@example.com';
      const { nativeRows, fts } = installExactMembershipFolders([{
        folderPath: '/F',
        folderId: 'opaque-parent',
        headerMessageIds: ['vanished@example.com'],
      }]);
      nativeRows.delete(msgId);

      const scanResult = await _testExports._runFolderReconSchedulerTick(fts);

      expect(scanResult).toMatchObject({
        complete: false,
        migration: { folderProgress: true, folderComplete: true },
      });
      expect(fts.assignFolderMembershipBatch).toHaveBeenCalledWith([{
        msgId,
        folderId: makeFolderMembershipId('account1', '/F'),
      }], expect.anything());
      expect(fts.filterNewMessages).not.toHaveBeenCalled();
      expect(nativeRows.has(msgId)).toBe(false);
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);

      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts); // durable state-pass reset
      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts);
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
      storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
        version: 3,
        roundRobinCursor: null,
        folders: {},
        folderMembershipMigration: {
          version: 1,
          inventoryCount: 1,
          inventorySha256: framedDigest([
            `${makeFolderMembershipId('account1', '/F')}\u0000account1\u0000/F`,
          ]),
          completedFolderIds: { [makeFolderMembershipId('account1', '/F')]: true },
          stateAfterMsgId: null,
          passMembershipEpoch: null,
          passMutated: false,
          passUnresolved: 0,
          cutoverProven: false,
        },
      };

      for (let turn = 0; turn < 20
        && (!_testExports._getFolderMembershipCutoverProven()
          || !_testExports._getFolderReconSessionDone().has('account1:/F'));
        turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
        && (!_testExports._getFolderMembershipCutoverProven()
          || nativeRows.has(stale[0])); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(nativeRows.has(stale[0])).toBe(false);
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
        && (!_testExports._getFolderMembershipCutoverProven()
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

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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

  it('removes a post-cutover orphan by authoritative unknown folderId without reparsing', async () => {
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
      for (let turn = 0; turn < 30
        && (!_testExports._getFolderMembershipCutoverProven()
          || !_testExports._getFolderReconSessionDone().has('account1:/Keep'));
        turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }
      const orphan = 'account1:/Former:sender@[IPv6:2001:db8::1]';
      nativeRows.set(orphan, 'opaque-former');

      for (let turn = 0; turn < 20 && nativeRows.has(orphan); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

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
        && (!_testExports._getFolderMembershipCutoverProven()
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
      const { fts, nativeRows, folders } = installExactMembershipFolders([{
        folderPath: '/Z', headerMessageIds: ['zz-1@example.com'],
      }]);
      await settleSchedulerTickWithFakeTimers(fts); // folder scan assigns every row
      vi.setSystemTime(Date.now() + 100);
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
        // the real membership coordinator.
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
        expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
        return;
      }
      // The pass judged an inventory the rename overtook: no cutover from it.
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      const stateReadsBefore = fts.listFolderMembershipState.mock.calls.length;
      for (let turn = 0; turn < 12 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        vi.setSystemTime(Date.now() + 1000);
        await settleSchedulerTickWithFakeTimers(fts);
      }
      // A fresh pass over the new inventory earns it and drops the old owner.
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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

  it('cancels a metadata-only scan at a pressure boundary without minting cutover', async () => {
    const { fts } = installExactMembershipFolders([
      {
        folderPath: '/F',
        folderId: 'opaque-parent',
        headerMessageIds: ['parent@example.com'],
      },
    ]);
    const pageStarted = deferred();
    const allowPage = deferred();
    globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementationOnce(async () => {
      pageStarted.resolve();
      await allowPage.promise;
      return { rows: [{ msgKey: 1, headerMessageId: 'parent@example.com' }], done: true };
    });

    const running = _testExports._runFolderReconSchedulerTick(fts);
    await pageStarted.promise;
    getForegroundFetchPressure.mockReturnValue({ active: 1, waiting: 0, chatTyping: false });
    allowPage.resolve();
    const result = await running;

    expect(result).toMatchObject({ skipped: true, reason: 'pressure' });
    expect(globalThis.browser.tmMsgNotify.cancelFolderMessageScan)
      .toHaveBeenCalledWith('membership-1');
    expect(fts.assignFolderMembershipBatch).not.toHaveBeenCalled();
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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
      }]);
      const folderId = makeFolderMembershipId('account1', '/F');
      await settleSchedulerTickWithFakeTimers(fts); // folder scan assigns every row
      vi.setSystemTime(Date.now() + 100);
      const behindCursor = 'account1:/F:drift-0000-new@example.com';
      fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
        const page = await fts.listFolderMembershipState.getMockImplementation()(after, limit);
        // New mail, indexed with its owner, lands behind the cursor.
        await runFtsMembershipMutation(async () => { nativeRows.set(behindCursor, folderId); });
        return page;
      });

      const first = await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 100);
      const second = await _testExports._runFolderReconSchedulerTick(fts);

      expect(first).toMatchObject({ complete: false, migration: { membershipStateProgress: true } });
      expect(second.migration).toBeUndefined();
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
      }]);
      let capable = true;
      fts.supportsFolderMembership.mockImplementation(() => capable);
      await _testExports._runFolderReconSchedulerTick(fts); // folder scan
      vi.setSystemTime(Date.now() + 100);
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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
      }]);
      const stale = 'account1:/Deleted:stale@example.com';
      nativeRows.set(stale, makeFolderMembershipId('account1', '/Deleted'));
      await settleSchedulerTickWithFakeTimers(fts); // folder scan
      vi.setSystemTime(Date.now() + 100);
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

      for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }

      expect(nativeRows.has(stale)).toBe(false);
      expect(fts.removeBatch).toHaveBeenCalledWith([stale], expect.anything());
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      // Same page retried (null), then a full replay after the removal (null).
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after))
        .toEqual([null, null, null]);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('restarts a live metadata scan after a cross-slice folder mutation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const { fts } = installExactMembershipFolders([{
        folderPath: '/F',
        folderId: 'opaque-parent',
        headerMessageIds: ['parent@example.com'],
      }]);
      globalThis.browser.tmMsgNotify.readFolderMessageScanPage
        .mockResolvedValueOnce({
          rows: [{ msgKey: 1, headerMessageId: 'parent@example.com' }],
          done: false,
        })
        .mockResolvedValueOnce({
          rows: [{ msgKey: 1, headerMessageId: 'parent@example.com' }],
          done: true,
        });

      await _testExports._runFolderReconSchedulerTick(fts);
      _testExports._invalidateFolderReconProofForEvent('account1', '/F');
      vi.setSystemTime(Date.now() + 100);
      const restarted = await _testExports._runFolderReconSchedulerTick(fts);

      expect(globalThis.browser.tmMsgNotify.cancelFolderMessageScan)
        .toHaveBeenCalledWith('membership-1');
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).toHaveBeenCalledTimes(2);
      expect(restarted).toMatchObject({
        complete: false,
        migration: { folderProgress: true, folderComplete: true },
      });
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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
      storageData.fts_reconcile_pending = 123;
      _testExports._setFtsSearch(null);

      let result = null;
      for (let turn = 0; turn < 8 && storageData.fts_reconcile_pending; turn++) {
        result = await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 1000);
      }

      expect(result).toMatchObject({ complete: true });
      expect(nativeKeys).toEqual(new Set([live]));
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledOnce();
      expect(storageData.fts_reconcile_pending).toBeUndefined();
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
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(await incrementalIndexer.isReconcilePending()).toBe(false);
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
        countMsgIdRange: vi.fn(async () => ({ count: 0 })),
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
      storageData.fts_reconcile_pending = 123;
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
      expect(first.orphan.orphanRemoved).toBe(0);
      vi.setSystemTime(Date.now() + 1000);
      const second = await runTick();

      expect(second).toMatchObject({ complete: true });
      // An empty inventory is a cold Thunderbird, not an empty mailbox: the row
      // survives, no recheck was even attempted, and nothing was removed.
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
        countMsgIdRange: vi.fn(async () => ({ count: 0 })),
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
      storageData.fts_reconcile_pending = 123;
      _testExports._setFtsSearch(fts);

      let result = null;
      for (let turn = 0; turn < 20 && !(result?.complete); turn++) {
        // Drive the tick's cooperative yields under fake timers until it settles.
        let settled = false;
        const tick = _testExports._runFolderReconSchedulerTick(fts).then(value => { settled = true; return value; });
        for (let step = 0; step < 200 && !settled; step++) {
          await vi.advanceTimersByTimeAsync(_testExports.FOLDER_RECON_ENTRY_DELAY_MS);
        }
        result = await tick;
        vi.setSystemTime(Date.now() + 1000);
      }

      expect(result).toMatchObject({ complete: true });
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

  it('restores a pending marker dirtied while its prior clear is suspended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const first = {
        uniqueKey: 'account1:/A:first@example.com', type: 'new', timestamp: 1,
        folderKey: 'account1:/A', metadata: {},
      };
      _testExports._getPendingUpdates().set(first.uniqueKey, first);
      await _testExports._abandonPendingUpdates([first], 'seed_marker');
      const fts = installEmptyFolders([['account1', '/A']]);
      _testExports._setFtsSearch(fts);
      vi.setSystemTime(Date.now() + reconConfig.errorDelayMs);
      await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 1000);

      const removeStarted = deferred();
      const allowRemove = deferred();
      globalThis.browser.storage.local.remove.mockImplementationOnce(async key => {
        removeStarted.resolve();
        await allowRemove.promise;
        delete storageData[key];
      });
      const completing = _testExports._runFolderReconSchedulerTick(fts);
      await removeStarted.promise;
      const concurrent = {
        uniqueKey: 'account1:/A:late@example.com', type: 'deleted', timestamp: 2,
        folderKey: 'account1:/A', metadata: {},
      };
      _testExports._getPendingUpdates().set(concurrent.uniqueKey, concurrent);
      const dirtying = _testExports._abandonPendingUpdates([concurrent], 'clear_race');
      await Promise.resolve();
      allowRemove.resolve();
      await Promise.all([completing, dirtying]);

      expect(storageData.fts_reconcile_pending).toBeTruthy();
      expect(await incrementalIndexer.isReconcilePending()).toBe(true);
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
      await _testExports._runFolderReconSchedulerTick(fts); // first range-count basis
      await _testExports._runFolderReconSchedulerTick(fts); // second basis + completion

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
    // The retired cursor walker remains test-exported for ADR-020 heartbeat
    // compatibility, but has no production caller and can only use the same
    // bounded scan-token pages as current reconciliation.
    expect(indexer.match(/_runCursorScan\(/g)).toHaveLength(1);
    const boundedLegacy = indexer.match(
      /async function _listCursorKeysAboveKeyCooperatively[\s\S]*?\n}\n\nasync function _runCursorScan/,
    )?.[0] || '';
    expect(boundedLegacy.length).toBeGreaterThan(500);
    expect(boundedLegacy).toContain('beginFolderMessageScan');
    expect(boundedLegacy).toContain('readFolderMessageScanPage');
    expect(boundedLegacy).not.toContain('.listKeysAboveKey(');
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
      storageData.fts_reconcile_pending = 123;
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
      // A failed seed keeps the durable marker so a restart retries too.
      expect(storageData.fts_reconcile_pending).toBe(123);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(reconConfig.errorDelayMs - 1);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      // The timer callback intentionally starts a bounded scheduler turn.
      // Settle the in-flight tick on the real event loop, then its permanent
      // strict storage tail, after each small virtual turn instead of widening
      // the amount of virtual scheduling the test accepts.
      for (let turn = 0; turn < 20 && storageData.fts_reconcile_pending; turn++) {
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
      expect(storageData.fts_reconcile_pending).toBeUndefined();
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
      storageData.fts_reconcile_pending = 123;
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
      expect(storageData.fts_reconcile_pending).toBe(123);
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
      // The disabled late continuation commits no proof: pending marker, memo
      // and native rows are untouched and no wake timer is left armed.
      expect(storageData.fts_reconcile_pending).toBe(123);
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
    const removeStarted = deferred();
    const releaseRemove = deferred();
    let tick = null;
    try {
      const fts = installEmptyFolders([]);
      storageData.fts_reconcile_pending = 123;
      _testExports._setFtsSearch(fts);
      globalThis.browser.storage.local.remove.mockImplementationOnce(async (key) => {
        removeStarted.resolve();
        await releaseRemove.promise;
        delete storageData[key];
      });
      tick = _testExports._runFolderReconSchedulerTick(fts);
      await removeStarted.promise;
      expect(_testExports._isFolderReconSchedulerActive()).toBe(true);
      expect(storageData.fts_reconcile_pending).toBe(123);

      const deadlineMs = 50;
      let slowYields = 0;
      // One real-loop turn that outlasts the deadline and during which the
      // tick durably completes. Completion already observable before the
      // deadline decision must win.
      const slowYield = async () => {
        slowYields++;
        await new Promise(resolve => realSetTimeout(resolve, deadlineMs + 20));
        releaseRemove.resolve();
        await expect(tick).resolves.toMatchObject({ complete: true });
        await yieldToRealEventLoop();
      };
      await expect(settleInFlightSchedulerTickWithFakeTimers(deadlineMs, slowYield))
        .resolves.toBeUndefined();
      expect(slowYields).toBe(1);
      expect(_testExports._isFolderReconSchedulerActive()).toBe(false);
      expect(storageData.fts_reconcile_pending).toBeUndefined();
      expect(globalThis.browser.storage.local.remove).toHaveBeenCalledWith('fts_reconcile_pending');
    } finally {
      releaseRemove.resolve();
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

  it('rejects old-generation completion before it can overwrite memo or remove a newer marker', async () => {
    const readStarted = deferred();
    const allowRead = deferred();
    const generation = _testExports._getFolderReconGeneration();
    globalThis.browser.storage.local.get.mockImplementationOnce(async () => {
      readStarted.resolve();
      await allowRead.promise;
      return {
        [_testExports.FOLDER_RECON_STORAGE_KEY]: { version: 3, folders: {} },
        fts_reconcile_pending: 111,
      };
    });
    const oldWrite = _testExports._reconStorageTransaction(generation, state => {
      state.removePending = true;
      state.memo.roundRobinCursor = 'account1:/old';
    });
    await readStarted.promise;
    _testExports._resetFolderReconState();
    storageData.fts_reconcile_pending = 222;
    storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
      version: 3,
      folders: { 'account1:/new': { verified: false } },
    };
    allowRead.resolve();

    await expect(oldWrite).rejects.toThrow(/folder_recon_cancelled/);
    expect(storageData.fts_reconcile_pending).toBe(222);
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
  it.each([false, true])('matches current native membership after terminal local refresh: concurrentRemove=%s', async (concurrentRemove) => {
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
        if (terminalArmed && concurrentRemove && concurrentWrites === 0) {
          await runFtsMembershipMutation(async () => {
            nativeRows.delete(newKey);
            concurrentWrites++;
          });
        }
        return result;
      });
      for (let turn = 0; turn < 35 && !refreshed; turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 1000);
      }
      expect(refreshed).toBe(true);
      expect(fts.filterNewMessages).toHaveBeenCalledWith([{ msgId: oldKey }]);
      expect(concurrentWrites).toBe(concurrentRemove ? 1 : 0);
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

// INVARIANT (2026-10-02 release-profile heap: 11,268 old/new copies of the
// whole ~57 KiB fts_folder_recon_memo held by storage.onChanged): the global
// membership-state pass and its cutover are volatile, per-session proof. A
// capable multi-page pass must never rewrite the durable memo; the only
// durable migration facts are the inventory record and per-folder completion.
describe('volatile membership-state pass (memo storage churn)', () => {
  function memoWrites() {
    return globalThis.browser.storage.local.set.mock.calls.filter(([patch]) =>
      Object.prototype.hasOwnProperty.call(patch, _testExports.FOLDER_RECON_STORAGE_KEY));
  }

  function seedCompletedAssignedFolder(headerCount) {
    const folderId = makeFolderMembershipId('account1', '/F');
    const headerMessageIds = Array.from(
      { length: headerCount },
      (_, index) => `state-${String(index).padStart(5, '0')}@example.com`,
    );
    const installed = installExactMembershipFolders([{ folderPath: '/F', headerMessageIds }]);
    for (const msgId of installed.nativeRows.keys()) installed.nativeRows.set(msgId, folderId);
    storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
      version: 3,
      roundRobinCursor: null,
      folders: {},
      folderMembershipMigration: {
        version: 1,
        inventoryCount: 1,
        inventorySha256: framedDigest([`${folderId}\u0000account1\u0000/F`]),
        completedFolderIds: { [folderId]: true },
      },
    };
    return installed;
  }

  it('cuts over a capable multi-page state pass without writing the memo', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const pageSize = reconConfig.membershipStatePageSize;
      const { fts } = seedCompletedAssignedFolder(pageSize * 2 + 1);
      const durableBefore = JSON.stringify(
        storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folderMembershipMigration);
      const writesBefore = memoWrites().length;
      let migrationTicks = 0;
      for (let turn = 0; turn < 20 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        const result = await settleSchedulerTickWithFakeTimers(fts);
        if (result?.migration) {
          migrationTicks++;
          expect(memoWrites().length, `memo written during state-pass turn ${turn}`)
            .toBe(writesBefore);
        }
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      // The cutover turn may continue into per-folder work, which owns its
      // own checkpoints; it must not touch the durable migration record.
      expect(memoWrites().every(([patch]) => JSON.stringify(
        patch[_testExports.FOLDER_RECON_STORAGE_KEY].folderMembershipMigration,
      ) === durableBefore)).toBe(true);
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
        const { fts } = seedCompletedAssignedFolder(rowCount);
        const expectedReads = Math.floor(rowCount / P) + 1;
        for (let turn = 0; turn < expectedReads; turn++) {
          expect(_testExports._getFolderMembershipCutoverProven(),
            `no cutover before native terminal evidence (read ${turn})`).toBe(false);
          const result = await _testExports._runFolderReconSchedulerTick(fts);
          expect(result?.migration?.restart, `no restart on read ${turn}`).toBeUndefined();
          vi.setSystemTime(Date.now() + 100);
        }

        expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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

  it.each(['absent', 'changed'])(
    'writes only the new inventory and the completion for a multi-page folder scan (%s inventory)',
    async (inventoryState) => {
      vi.useFakeTimers();
      vi.setSystemTime(realDateNow());
      try {
        const headerMessageIds = Array.from(
          { length: reconConfig.folderScanPageSize * 2 + 1 },
          (_, index) => `scan-${String(index).padStart(5, '0')}@example.com`,
        );
        const { fts, nativeRows } = installExactMembershipFolders([{
          folderPath: '/F', headerMessageIds,
        }]);
        const folderId = makeFolderMembershipId('account1', '/F');
        if (inventoryState === 'changed') {
          storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
            version: 3,
            roundRobinCursor: null,
            folders: {},
            folderMembershipMigration: {
              version: 1,
              inventoryCount: 1,
              inventorySha256: framedDigest([
                `${makeFolderMembershipId('account1', '/Gone')}\u0000account1\u0000/Gone`,
              ]),
              // A removed folder's completion is pruned, never reused.
              completedFolderIds: { [makeFolderMembershipId('account1', '/Gone')]: true },
            },
          };
        }
        const migrationResults = [];
        for (let turn = 0; turn < 40
          && !_testExports._getFolderMembershipCutoverProven(); turn++) {
          migrationResults.push((await settleSchedulerTickWithFakeTimers(fts))?.migration);
          vi.setSystemTime(Date.now() + 100);
        }

        expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
        expect([...nativeRows.values()].every(owner => owner === folderId)).toBe(true);
        const migrationWrites = memoWrites().map(([patch]) =>
          patch[_testExports.FOLDER_RECON_STORAGE_KEY].folderMembershipMigration);
        expect(migrationWrites).toEqual([
          {
            version: 1,
            inventoryCount: 1,
            inventorySha256: framedDigest([`${folderId}\u0000account1\u0000/F`]),
            completedFolderIds: {},
          },
          {
            version: 1,
            inventoryCount: 1,
            inventorySha256: framedDigest([`${folderId}\u0000account1\u0000/F`]),
            completedFolderIds: { [folderId]: true },
          },
        ]);
        // One uninterrupted three-page scan: non-terminal pages write nothing.
        expect(migrationResults.filter(result => result?.folderProgress))
          .toEqual([
            { complete: false, folderProgress: true, folderComplete: false },
            { complete: false, folderProgress: true, folderComplete: false },
            { complete: false, folderProgress: true, folderComplete: true },
          ]);
      } finally {
        _testExports._setIsEnabled(false);
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it('keeps completions of present folders across an inventory change and rescans a re-added folder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts } = installExactMembershipFolders([
        { folderPath: '/A', headerMessageIds: ['a@example.com'] },
        { folderPath: '/B', headerMessageIds: ['b@example.com'] },
      ]);
      const idA = makeFolderMembershipId('account1', '/A');
      const idB = makeFolderMembershipId('account1', '/B');
      const accounts = await globalThis.browser.accounts.list();
      const subFolders = accounts[0].rootFolder.subFolders;
      const folderB = subFolders.find(folder => folder.path === '/B');
      const migrationRecord = () =>
        storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folderMembershipMigration;
      // Metadata-only scans (second argument true) are the migration's
      // assignment scans; per-folder reconciliation scans are not.
      const scannedURIs = () => globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls
        .filter(([, metadataOnly]) => metadataOnly === true)
        .map(([uri]) => uri);
      const untilCutover = async () => {
        for (let turn = 0; turn < 20 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
          await settleSchedulerTickWithFakeTimers(fts);
          vi.setSystemTime(Date.now() + 100);
        }
        expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      };
      await untilCutover();
      expect(migrationRecord().completedFolderIds).toEqual({ [idA]: true, [idB]: true });

      // /B removed: its completion is pruned, /A's is kept and written at once.
      subFolders.splice(subFolders.indexOf(folderB), 1);
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockClear();
      await settleSchedulerTickWithFakeTimers(fts);
      expect(migrationRecord().completedFolderIds).toEqual({ [idA]: true });
      expect(migrationRecord().inventoryCount).toBe(1);

      // Restart, then /B re-added: only /B is rescanned.
      _testExports._resetFolderReconState();
      _testExports._setIsEnabled(true);
      subFolders.push(folderB);
      vi.setSystemTime(Date.now() + 100);
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockClear();
      const rescan = await settleSchedulerTickWithFakeTimers(fts);
      expect(rescan.migration).toMatchObject({ folderProgress: true, folderComplete: true });
      expect(scannedURIs()).toEqual(['none://membership-1']);
      vi.setSystemTime(Date.now() + 100);
      await untilCutover();
      expect(migrationRecord().completedFolderIds).toEqual({ [idA]: true, [idB]: true });
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

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
      const { fts, nativeRows, folders } = seedCompletedAssignedFolder(rowCount);
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
      while (!_testExports._getFolderMembershipCutoverProven() && slices < sliceBudget) {
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

      expect(_testExports._getFolderMembershipCutoverProven(),
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
      const { fts, nativeRows, rowsByURI, folders } = seedCompletedAssignedFolder(P + 1);
      const ahead = 'account1:/F:zz-late@example.com';
      const read = fts.listFolderMembershipState.getMockImplementation();
      fts.listFolderMembershipState.mockImplementationOnce(async (after, limit) => {
        const page = await read(after, limit);
        // A legacy-shaped row lands AHEAD of the cursor (forced fake).
        nativeRows.set(ahead, null);
        rowsByURI.get(folders[0].folderURI).push({ msgKey: 999, headerMessageId: 'zz-late@example.com' });
        return page;
      });

      const results = [];
      for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        results.push((await _testExports._runFolderReconSchedulerTick(fts))?.migration);
        vi.setSystemTime(Date.now() + 100);
      }

      // Page two sees the NULL row and assigns it; that pass replays.
      expect(results[1]).toMatchObject({ restart: true });
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
      const { fts, nativeRows } = seedCompletedAssignedFolder(P + 1);
      await _testExports._runFolderReconSchedulerTick(fts); // page one
      vi.setSystemTime(Date.now() + 100);
      // G1 capable -> G2 legacy writes an ownerless row behind the cursor,
      // no tick observes it -> G3 capable.
      nativeRows.set('account1:/F:aaa-legacy@example.com', null);
      fts.getConnectionGeneration.mockReturnValue(3);

      await _testExports._runFolderReconSchedulerTick(fts);

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after))
        .toEqual([null, null]);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('revokes on the first exact read when a NULL row appeared behind the cursor with no producer', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows } = seedCompletedAssignedFolder(P + 1);
      const orphan = 'account1:/F:aaa-unowned@example.com';
      await _testExports._runFolderReconSchedulerTick(fts); // page one
      vi.setSystemTime(Date.now() + 100);
      nativeRows.set(orphan, null); // forced fake: no production producer exists
      await _testExports._runFolderReconSchedulerTick(fts); // terminal page
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      fts.listFolderMembershipState.mockClear();

      for (let turn = 0; turn < 20 && _testExports._getFolderMembershipCutoverProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await settleSchedulerTickWithFakeTimers(fts);
        expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(orphan);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      expect(nativeRows.has(orphan)).toBe(true);
      vi.setSystemTime(Date.now() + 100);
      fts.listFolderMembershipState.mockClear();
      await _testExports._runFolderReconSchedulerTick(fts);
      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
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
      const { fts, nativeRows, rowsByURI, folders } = seedCompletedAssignedFolder(P + 1);
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

      const faulted = await _testExports._runFolderReconSchedulerTick(fts);
      getForegroundFetchPressure.mockReturnValue({ active: 0, waiting: 0, chatTyping: false });
      expect(faulted.skipped === true || faulted.migration?.failed === true).toBe(true);

      for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      const cursors = fts.listFolderMembershipState.mock.calls.map(([after]) => after);
      // Faulted page one, its same-page retry, page two, then a full replay.
      expect(cursors.filter(after => after === null).length).toBeGreaterThanOrEqual(3);
      expect(cursors.at(-2)).toBeNull();
      if (mutator === 'remove') expect(nativeRows.has(target)).toBe(false);
      else expect(nativeRows.get(target)).toBe(folders[0].folderId);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('re-scans after an interrupted inventory write and never skips the folder', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const headerMessageIds = Array.from(
        { length: reconConfig.folderScanPageSize + 1 },
        (_, index) => `retry-${String(index).padStart(5, '0')}@example.com`,
      );
      const { fts, nativeRows } = installExactMembershipFolders([{
        folderPath: '/F', headerMessageIds,
      }]);
      const folderId = makeFolderMembershipId('account1', '/F');
      globalThis.browser.storage.local.set.mockRejectedValueOnce(new Error('disk full'));
      await expect(_testExports._runFolderReconSchedulerTick(fts)).rejects.toThrow('disk full');
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY]).toBeUndefined();
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan).not.toHaveBeenCalled();

      // Restart: a new generation, nothing carried over.
      _testExports._resetFolderReconState();
      _testExports._setIsEnabled(true);
      const migrationResults = [];
      for (let turn = 0; turn < 10
        && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        migrationResults.push((await settleSchedulerTickWithFakeTimers(fts))?.migration);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      // The folder is scanned again from its first page before any state page.
      expect(migrationResults.slice(0, 2)).toEqual([
        { complete: false, folderProgress: true, folderComplete: false },
        { complete: false, folderProgress: true, folderComplete: true },
      ]);
      expect([...nativeRows.values()].every(owner => owner === folderId)).toBe(true);
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
      const { fts } = seedCompletedAssignedFolder(P + 1);
      const stored = storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folderMembershipMigration;
      Object.assign(stored, {
        stateAfterMsgId: 'account1:/F:state-00049@example.com',
        passMembershipEpoch: 7,
        passMutated: false,
        passUnresolved: 0,
        cutoverProven: true,
        updatedAtMs: Date.now(),
      });

      const first = await _testExports._runFolderReconSchedulerTick(fts);

      expect(first).toMatchObject({ complete: false, migration: { membershipStateProgress: true } });
      expect(fts.listFolderMembershipState).toHaveBeenCalledTimes(1);
      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      // No per-folder or orphan reconciliation before the full pass.
      expect(fts.listFolderMembership).not.toHaveBeenCalled();
      expect(fts.listMsgIdRange).not.toHaveBeenCalled();
      expect(fts.fingerprintMsgIdRange).not.toHaveBeenCalled();
      expect(memoWrites()).toHaveLength(0);

      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts);
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      expect(fts.listFolderMembershipState.mock.calls[1][0])
        .toBe('account1:/F:state-00049@example.com');
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  async function earnCutover(fts) {
    for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
      await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 100);
    }
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
    ['runtime disable', async () => {
      storageData.chat_ftsIncrementalEnabled = false;
      await incrementalIndexer.updateIncrementalIndexerSettings();
      storageData.chat_ftsIncrementalEnabled = true;
      await incrementalIndexer.updateIncrementalIndexerSettings();
    }],
    ['inventory change', async () => {
      // A folder created in Thunderbird (no rows yet); its own assignment
      // scan runs first, then the pass restarts before-first.
      const accounts = await globalThis.browser.accounts.list();
      accounts[0].rootFolder.subFolders.push({ id: 'session-new', path: '/New', subFolders: [] });
      const base = globalThis.browser.tmMsgNotify.getFolderState.getMockImplementation();
      globalThis.browser.tmMsgNotify.getFolderState.mockImplementation(async (accountId, folderPath) =>
        (folderPath === '/New'
          ? { accountId, folderPath, folderURI: 'none://membership-new', serverType: 'none' }
          : base(accountId, folderPath)));
      const begin = globalThis.browser.tmMsgNotify.beginFolderMessageScan.getMockImplementation();
      globalThis.browser.tmMsgNotify.beginFolderMessageScan.mockImplementation(async (uri) =>
        (uri === 'none://membership-new'
          ? { token: 'membership-new', accountId: 'account1', folderPath: '/New' }
          : begin(uri)));
      const read = globalThis.browser.tmMsgNotify.readFolderMessageScanPage.getMockImplementation();
      globalThis.browser.tmMsgNotify.readFolderMessageScanPage.mockImplementation(async (token, limit) =>
        (token === 'membership-new' ? { rows: [], done: true } : read(token, limit)));
    }],
  ])('revokes cutover and restarts the pass before-first after %s', async (_name, change) => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts } = seedCompletedAssignedFolder(P + 1);
      await earnCutover(fts);

      await change(fts);
      vi.setSystemTime(Date.now() + 100);
      for (let turn = 0; turn < 10 && fts.listFolderMembershipState.mock.calls.length === 0; turn++) {
        await _testExports._runFolderReconSchedulerTick(fts);
        expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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
      const { fts } = seedCompletedAssignedFolder(0);
      fts.listFolderMembershipState.mockImplementationOnce(async () => {
        fts.getConnectionGeneration.mockReturnValue(2);
        return { ok: true, entries: [], done: true };
      });

      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({
        complete: false,
        migration: { restart: true, reason: 'membership_state_binding_changed' },
      });
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts);
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after)).toEqual([null, null]);
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
      const { fts } = seedCompletedAssignedFolder(P + 1);
      await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 100);
      expect(fts.listFolderMembershipState.mock.calls.at(-1)[0]).toBeNull();
      fts.listFolderMembershipState.mockImplementationOnce(async () => page());

      const result = await _testExports._runFolderReconSchedulerTick(fts);

      expect(result).toMatchObject({ complete: false, migration: { failed: true, reason } });
      expect(fts.listFolderMembershipState.mock.calls.at(-1)[0]).not.toBeNull();
      expect(_testExports._getFolderReconRuntimeTelemetry().membershipStateRestartPageInvalid).toBe(1);
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      vi.setSystemTime(Date.now() + 100);
      await _testExports._runFolderReconSchedulerTick(fts);
      expect(fts.listFolderMembershipState.mock.calls.at(-1)[0]).toBeNull();
      for (let turn = 0; turn < 4 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
      const { fts, nativeRows } = seedCompletedAssignedFolder(1);
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      fts.removeBatch.mockImplementation(removeBatch);
      for (let turn = 0; turn < 4 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }
      expect(nativeRows.has(staleRow)).toBe(false);
      // Same page retried, then the sticky replay pass that earns cutover.
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after)).toEqual([null, null, null]);
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
    } finally {
      _testExports._setIsEnabled(false);
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('revokes cutover and keeps the row when the post-cutover orphan sweep meets an ownerless row', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows } = seedCompletedAssignedFolder(1);
      await earnCutover(fts);
      // No production writer leaves a NULL owner on a capable helper; the
      // orphan sweep must still fail closed rather than judge the row.
      const ownerless = 'account1:/F:zz-ownerless@example.com';
      nativeRows.set(ownerless, null);
      for (let turn = 0; turn < 10 && _testExports._getFolderMembershipCutoverProven(); turn++) {
        await _testExports._runFolderReconSchedulerTick(fts);
        vi.setSystemTime(Date.now() + 100);
      }
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
      expect(nativeRows.has(ownerless)).toBe(true);
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
      const { fts } = seedCompletedAssignedFolder(1);
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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
      const { fts } = seedCompletedAssignedFolder(P + 1);
      await earnCutover(fts);
      fts.listFolderMembership.mockClear();

      for (let turn = 0; turn < 3; turn++) {
        await _testExports._runFolderReconSchedulerTick(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(fts.listFolderMembershipState).not.toHaveBeenCalled();
      expect(fts.listFolderMembership).toHaveBeenCalled();
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
  const reconciliationIdle = () => storageData.fts_reconcile_pending === undefined
    && !_testExports._isFolderReconSchedulerActive();

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
      expect(storageData.fts_reconcile_pending).toBeDefined();
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
      expect(storageData.fts_reconcile_pending).toBeDefined();

      expect(await driveTimersUntil(() => reconciliationIdle()
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      expect(vi.getTimerCount()).toBe(0);

      globalThis.browser.accounts.list.mockResolvedValue([{
        id: 'account1', type: 'none',
        rootFolder: {
          path: '/', isRoot: true,
          subFolders: [{ id: 'session-folder-0', path: '/Keep', subFolders: [] }],
        },
      }]);
      const statePagesBefore = fts.listFolderMembershipState.mock.calls.length;
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/Gone' });

      expect(await driveTimersUntil(() => reconciliationIdle()
        && !nativeRows.has('account1:/Gone:gone@example.com'))).toBe(true);
      expect(fts.listFolderMembershipState.mock.calls.slice(statePagesBefore)[0][0]).toBeNull();
      expect(nativeRows.get('account1:/Keep:keep@example.com'))
        .toBe(makeFolderMembershipId('account1', '/Keep'));
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
              && (mode !== 'exact' || _testExports._getFolderMembershipCutoverProven())) {
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
        expect(vi.getTimerCount()).toBe(0);
        fired = true;
        swapTopology();
      }
      const scansBefore = when === 'idle' ? scan.mock.calls.length : 0;
      // The inventory the scheduler reads afterwards is the one it verified.
      expect(await globalThis.browser.accounts.list()).toEqual(inventory);

      if (swapped) {
        const ok = await driveTimersUntil(async () => fired && staleGone() && await missingFound());
        expect(ok).toBe(true);
        expect(storageData.fts_reconcile_pending).toBeDefined();
      } else {
        expect(await driveTimersUntil(() => fired && reconciliationIdle()
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

      expect(await driveTimersUntil(() => reconciliationIdle()
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
      if (mode === 'exact') expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);

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
        if (!reconnected && parent && _testExports._getFolderMembershipCutoverProven()) {
          reconnected = true;
          helper.reconnect();
        }
        return result;
      });
      await incrementalIndexer.initIncrementalIndexer(fts);

      expect(await driveTimersUntil(() => reconnected && reconciliationIdle())).toBe(true);
      expect(nativeRows.get(childRow)).toBe(makeFolderMembershipId('account1', '/F:Child'));
      expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(childRow);
      expect(nativeRows.has(ghostRow)).toBe(false);
      expect(fts.listMsgIdRange).not.toHaveBeenCalled();
      expect(fts.fingerprintMsgIdRange.mock.calls.filter(([start, end]) => start !== '' || end !== ''))
        .toEqual([]);
      // Recovery re-earned exact cutover on the new connection and verified both folders.
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
      _testExports._setIsEnabled(false);
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/B' });
      for (let turn = 0; turn < 5; turn++) await yieldToRealEventLoop();
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
      expect(storageData.fts_reconcile_pending).toBeUndefined();

      // Positive control: the same event on an enabled indexer persists intent.
      _testExports._setIsEnabled(true);
      _testExports._setFtsSearch(installEmptyFolders([['account1', '/A']]));
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/B' });
      for (let turn = 0; turn < 5; turn++) await yieldToRealEventLoop();
      expect(storageData.fts_reconcile_pending).toBeDefined();
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
