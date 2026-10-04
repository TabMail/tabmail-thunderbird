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
  reverifyIntervalMs: 20 * 60 * 1000,
  walkPeriodMs: 24 * 60 * 60 * 1000,
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
  releaseMessageList: vi.fn(async () => {}),
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
  releaseMessageList,
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

  it('releases an invalidated active proof and proves the folder again from a fresh scan', async () => {
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

      // The event also ends the slice, as every message event does, and the
      // invalidated proof is released rather than reused: the folder is
      // proven again from a fresh scan.
      await expect(settleSchedulerTickWithFakeTimers(fts)).rejects.toThrow('folder_changed_during_scan');
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();

      vi.setSystemTime(Date.now() + 1000);
      await settleSchedulerTickWithFakeTimers(fts);
      expect(globalThis.browser.tmMsgNotify.beginFolderMessageScan.mock.calls.map(call => call[0]))
        .toEqual(['none://repair-0', 'none://repair-0']);
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
      expect(_testExports._isFolderReconPending()).toBe(true);

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
      expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._isFolderReconPending()).toBe(true);
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

      for (let turn = 0; turn < 8 && _testExports._isFolderReconPending(); turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 1000);
      }
      expect(_testExports._isFolderReconPending()).toBe(false);
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

      // Invalidation, the pending flag and the wake are all synchronous with
      // owner release; nothing waits on storage.
      expect(_testExports._getFolderReconSessionDone()).not.toContain('account1:/A');
      expect(_testExports._getFolderReconActiveProofKey()).toBeNull();
      expect(_testExports._getFolderReconEphemeralEvidence()).toEqual({
        deferred: 0,
        failures: 0,
        orphanDone: false,
        hasOrphanPass: false,
        dirty: ['account1:/A'],
      });
      expect(_testExports._isFolderReconPending()).toBe(true);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();

      _testExports._setFtsSearch(null);
      vi.clearAllTimers();
      vi.setSystemTime(Date.now() + 1000);
      const reproved = await settleSchedulerTickWithFakeTimers(fts);
      expect(reproved.missingEnqueued).toBe(1);
      expect(_testExports._getPendingUpdates().has(liveKey)).toBe(true);
      expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._clearFolderReconPendingIfCurrent(
        _testExports._getFolderReconGeneration(),
        _testExports._getFolderReconEventSerial(),
      )).toBe(true);
      const lease = await acquireMutatedExclusiveLease();
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(true);
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

  it('synchronously clears every generation-local proof class before marking pending and waking', () => {
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
    const pendingAt = handler.indexOf('_markFolderReconPending()');
    const wakeAt = handler.indexOf('_wakeFolderRecon(');
    expect(pendingAt).toBeGreaterThan(dirtyAt);
    expect(wakeAt).toBeGreaterThan(pendingAt);
    expect(handler).not.toContain('await');
  });

  it('does not invalidate verified session evidence for a read-only exclusive owner', async () => {
    const fts = installEmptyFolders([['account1', '/A']]);
    _testExports._setFtsSearch(null);
    await _testExports._runFolderReconSchedulerTick(fts);
    expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');
    expect(_testExports._clearFolderReconPendingIfCurrent(
      _testExports._getFolderReconGeneration(),
      _testExports._getFolderReconEventSerial(),
    )).toBe(true);

    const lease = await acquireFtsExclusiveOperation('maintenance-read');
    lease.release();
    await Promise.resolve();

    expect(_testExports._getFolderReconSessionDone()).toContain('account1:/A');
    expect(_testExports._getFolderReconDirty()).not.toContain('__all__');
    expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(true);
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
    expect(_testExports._isFolderReconPending()).toBe(true);
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

      for (let turn = 0; turn < 10 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        await _testExports._runFolderReconSchedulerTick(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
        && (!_testExports._getFolderMembershipCutoverProven()
          || !_testExports._getFolderReconSessionDone().has('account1:/Keep'));
        turn++) {
        await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 100);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
      _testExports._setFtsSearch(null);

      let result = null;
      for (let turn = 0; turn < 8 && _testExports._isFolderReconPending(); turn++) {
        result = await settleSchedulerTickWithFakeTimers(fts);
        vi.setSystemTime(Date.now() + 1000);
      }

      expect(result).toMatchObject({ complete: true });
      expect(nativeKeys).toEqual(new Set([live]));
      expect(globalThis.browser.tmMsgNotify.getFolderState).toHaveBeenCalledOnce();
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      // kept row holds the marker while a capped re-inventory retry is armed.
      expect(second).toMatchObject({ complete: false, reason: 'unloaded_accounts' });
      expect(_testExports._isFolderReconPending()).toBe(true);
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

      // The cold account's rows hold the marker; the loaded account's stale
      // row is removed after one live global recheck.
      expect(result).toMatchObject({ complete: false, reason: 'unloaded_accounts' });
      expect(_testExports._isFolderReconPending()).toBe(true);
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

  it('keeps reconciliation pending when work is dirtied while the completing tick is suspended', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-21T00:00:00Z'));
    try {
      const fts = installEmptyFolders([['account1', '/A']]);
      _testExports._setFtsSearch(fts);
      await _testExports._runFolderReconSchedulerTick(fts);
      vi.setSystemTime(Date.now() + 1000);
      expect(_testExports._isFolderReconPending()).toBe(true);

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
      await completing;

      expect(_testExports._isFolderReconPending()).toBe(true);
      expect(await incrementalIndexer.isReconcilePending()).toBe(true);

      // Control: without the concurrent dirtying, the same tick clears it.
      vi.setSystemTime(Date.now() + reconConfig.errorDelayMs * 64);
      for (let turn = 0; turn < 6 && _testExports._isFolderReconPending(); turn++) {
        await _testExports._runFolderReconSchedulerTick(fts);
        vi.setSystemTime(Date.now() + reconConfig.errorDelayMs * 64);
      }
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(true);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(reconConfig.errorDelayMs - 1);
      expect(globalThis.browser.accounts.list).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      // The timer callback intentionally starts a bounded scheduler turn.
      // Settle the in-flight tick on the real event loop, then its permanent
      // strict storage tail, after each small virtual turn instead of widening
      // the amount of virtual scheduling the test accepts.
      for (let turn = 0; turn < 20 && _testExports._isFolderReconPending(); turn++) {
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
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._isFolderReconPending()).toBe(true);

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
      expect(_testExports._isFolderReconPending()).toBe(false);
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

  it('keeps cutover for a producer-less NULL row behind the cursor and classifies it on the next session pass', async () => {
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

      // A NULL row has no revoke site any more: this session keeps its cutover.
      for (let turn = 0; turn < 5; turn++) {
        vi.setSystemTime(Date.now() + 100);
        await settleSchedulerTickWithFakeTimers(fts);
      }
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      expect(nativeRows.get(orphan)).toBeNull();

      // The next session's pass starts before-first and classifies the row: no
      // live message, so it is removed as a ghost before cutover.
      _testExports._resetFolderReconState();
      _testExports._setIsEnabled(true);
      _testExports._setIndexerDisposed(false);
      fts.listFolderMembershipState.mockClear();
      for (let turn = 0; turn < 20 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await settleSchedulerTickWithFakeTimers(fts);
      }
      expect(fts.listFolderMembershipState.mock.calls[0][0]).toBeNull();
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
    ['runtime disable', async (fts) => {
      // The only runtime toggle is a dispose + init lifecycle.
      await incrementalIndexer.disposeIncrementalIndexer();
      storageData.chat_ftsIncrementalEnabled = true;
      await incrementalIndexer.initIncrementalIndexer(fts);
      // init restarts the sync-quiet window; let it elapse before ticking.
      vi.setSystemTime(Date.now() + reconConfig.syncQuietMs + 1);
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
      const { fts } = seedCompletedAssignedFolder(P * 2 + 1);
      await _testExports._runFolderReconSchedulerTick(fts);
      expect(fts.listFolderMembershipState.mock.calls.map(([after]) => after)).toEqual([null]);
      // A rename and its reversal: the inventory the next tick reads is unchanged.
      for (const listener of [...renameListeners]) {
        listener({ accountId: 'account1', path: '/F' }, { accountId: 'account1', path: '/F' });
      }
      for (let turn = 0; turn < 8 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
        vi.setSystemTime(Date.now() + 100);
        await _testExports._runFolderReconSchedulerTick(fts);
      }

      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
      const { fts, nativeRows } = seedCompletedAssignedFolder(1);
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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

  it('assigns an ownerless live row read by the state pass instead of revoking cutover', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
    try {
      const { fts, nativeRows } = seedCompletedAssignedFolder(2);
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
  const reconciliationIdle = () => !_testExports._isFolderReconPending()
    && !_testExports._isFolderReconSchedulerActive();
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
      expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(true);

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
        expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._clearFolderReconPendingIfCurrent(
        _testExports._getFolderReconGeneration(),
        _testExports._getFolderReconEventSerial(),
      )).toBe(true);
      _testExports._setIsEnabled(false);
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/B' });
      for (let turn = 0; turn < 5; turn++) await yieldToRealEventLoop();
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
      expect(_testExports._isFolderReconPending()).toBe(false);

      // Positive control: the same event on an enabled indexer marks it pending.
      _testExports._setIsEnabled(true);
      _testExports._setFtsSearch(installEmptyFolders([['account1', '/A']]));
      events.folders.onDeleted.emit({ accountId: 'account1', path: '/B' });
      for (let turn = 0; turn < 5; turn++) await yieldToRealEventLoop();
      expect(_testExports._isFolderReconPending()).toBe(true);
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
// marker, and the orphan stage completes once per binding.
// ---------------------------------------------------------------------------


// Folders already migrated: every live header row is owned, the durable
// migration record covers the inventory, so ticks go straight to the pass.
function seedMigratedExactFolders(specs, options) {
  const installed = installExactMembershipFolders(specs, options);
  for (const folder of installed.folders) {
    for (const row of installed.rowsByURI.get(folder.folderURI)) {
      installed.nativeRows.set(`account1:${folder.folderPath}:${row.headerMessageId}`, folder.folderId);
    }
  }
  storageData[_testExports.FOLDER_RECON_STORAGE_KEY] = {
    version: 3,
    roundRobinCursor: null,
    folders: {},
    folderMembershipMigration: {
      version: 1,
      inventoryCount: installed.folders.length,
      inventorySha256: framedDigest(installed.folders.map(folder =>
        `${folder.folderId}\u0000account1\u0000${folder.folderPath}`)),
      completedFolderIds: Object.fromEntries(installed.folders.map(folder => [folder.folderId, true])),
    },
  };
  return installed;
}

async function tickUntil(fts, done, maxTicks = 30) {
  let result;
  for (let turn = 0; turn < maxTicks; turn++) {
    result = await settleSchedulerTickWithFakeTimers(fts);
    vi.setSystemTime(Date.now() + 100);
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

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
    expect(nativeRows.get(row)).toBe(makeFolderMembershipId('account1', '/F'));
    expect(recheckMessageInFolder).toHaveBeenCalledWith('late-sync@example.com', expect.objectContaining({
      accountId: 'account1', path: '/F',
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

    expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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

    expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
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
    // The deferred row is re-read by the next slice, never skipped.
    fts.listFolderMembershipState.mockClear();
    await settleSchedulerTickWithFakeTimers(fts);
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
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);
    expect(_testExports._getFolderMembershipStatePass().completed).toBe(false);
    expect(_testExports._getFolderReconEphemeralEvidence().orphanDone).toBe(false);
    expect(_testExports._isFolderReconPending()).toBe(true);

    await settleSchedulerTickWithFakeTimers(fts);
    expect(nativeRows.has(ghosts[5])).toBe(false);

    await tickUntil(fts, result => result?.complete === true);
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
    expect(_testExports._isFolderReconPending()).toBe(false);
  });

  it('lets the global query decide after a scoped query throws, and takes a continuation-page scoped positive without one', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([
      { folderPath: '/F', headerMessageIds: ['paged@example.com'] },
    ]);
    const thrown = 'account1:/F:thrown@example.com';
    const paged = 'account1:/F:paged@example.com';
    nativeRows.set(thrown, null);
    nativeRows.set(paged, null);
    const scoped = globalThis.browser.messages.query.getMockImplementation();
    globalThis.browser.messages.query.mockImplementation(async args => {
      if (args.headerMessageId === 'thrown@example.com') throw new Error('scoped query failed');
      if (args.headerMessageId === 'paged@example.com') return { messages: [], id: 'list-1' };
      return scoped(args);
    });
    globalThis.browser.messages.continueList = vi.fn(async () => ({ messages: [{ id: 7 }] }));
    recheckMessageInFolder.mockResolvedValue('present');

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    const owner = makeFolderMembershipId('account1', '/F');
    expect(nativeRows.get(thrown)).toBe(owner);
    expect(nativeRows.get(paged)).toBe(owner);
    expect(recheckMessageInFolder.mock.calls.map(([headerId]) => headerId)).toEqual(['thrown@example.com']);
  });

  it('migrates many already-owned rows without any message query', async () => {
    const headerMessageIds = Array.from({ length: reconConfig.membershipStatePageSize * 2 + 3 },
      (_, index) => `owned-${String(index).padStart(4, '0')}@example.com`);
    const { fts } = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds }]);

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

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
    for (let fired = 0; fired < 200 && !done(); fired++) await fireSchedulerTimer();
    return done();
  }

  it('keeps NULL and owned rows of an unloaded account, proves cutover and holds the marker', async () => {
    const { nativeRows, fts } = seedWithColdAccount();

    await runUntilRetryArmed(fts);

    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
    expect(_testExports._getFolderMembershipStatePass().unloaded).toBe(2);
    expect(nativeRows.get(coldNull)).toBeNull();
    expect(nativeRows.get(coldOwned)).toBe(makeFolderMembershipId('account2', '/Archive'));
    expect(fts.removeBatch).not.toHaveBeenCalled();
    expect(_testExports._isFolderReconPending()).toBe(true);
    expect(_testExports._getFolderReconRuntimeTelemetry().membershipStateRestartRevoked).toBe(0);
    // The kept rows were never queried: no live query can see an unloaded account.
    expect(recheckMessageInFolder).not.toHaveBeenCalled();
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
    expect(_testExports._isFolderReconPending()).toBe(true);
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
    expect(_testExports._isFolderReconPending()).toBe(true);
    expect(_testExports._getFolderMembershipStatePass().unloaded).toBe(2);
  });

  it('keeps no timer after dispose while the retry is armed', async () => {
    const { fts } = seedWithColdAccount();
    await runUntilRetryArmed(fts);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    await incrementalIndexer.disposeIncrementalIndexer();

    expect(vi.getTimerCount()).toBe(0);
  });

  it('migrates a late-loading account on the retry tick and then clears the marker', async () => {
    const installed = seedWithColdAccount();
    const { nativeRows, fts } = installed;
    await runUntilRetryArmed(fts);

    // No topology event: the account simply appears in the next inventory read.
    loadAccount2(installed);

    expect(await runTimersUntil(() => !_testExports._isFolderReconPending())).toBe(true);
    expect(nativeRows.get(coldNull)).toBe(makeFolderMembershipId('account2', '/Archive'));
    expect(nativeRows.get(coldOwned)).toBe(makeFolderMembershipId('account2', '/Archive'));
    expect(fts.removeBatch).not.toHaveBeenCalled();
  });

  it('holds the marker for seeded rows under an empty inventory, then progresses once the account loads', async () => {
    const installed = installExactMembershipFolders([]);
    const { nativeRows, fts } = installed;
    nativeRows.set('account1:/F:kept@example.com', null);
    nativeRows.set('account1:/F:owned@example.com', makeFolderMembershipId('account1', '/F'));
    _testExports._setFtsSearch(fts);

    await runUntilRetryArmed(fts);

    expect(_testExports._isFolderReconPending()).toBe(true);
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

    expect(await runTimersUntil(() => !_testExports._isFolderReconPending())).toBe(true);
    expect(nativeRows.get('account1:/F:kept@example.com')).toBe(makeFolderMembershipId('account1', '/F'));
  });

  it('completes and clears the marker for an empty inventory over an empty index', async () => {
    const { fts } = installExactMembershipFolders([]);
    _testExports._setFtsSearch(fts);

    await settleSchedulerTickWithFakeTimers(fts);
    await runTimersUntil(() => !_testExports._isFolderReconPending() || vi.getTimerCount() === 0);

    expect(_testExports._isFolderReconPending()).toBe(false);
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

// A queued update of an account outside the inventory keeps the marker set
// without blocking any folder's work.
const HELD_KEY = 'account9:/Held:held@example.com';
function holdMarkerWithQueuedUpdate() {
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
    expect(_testExports._isFolderReconPending()).toBe(true);

    // Control: the overlap disappears with the inventory change.
    globalThis.browser.accounts.list.mockResolvedValue([{
      id: 'account1', type: 'imap',
      rootFolder: { path: '/', isRoot: true, subFolders: [{ path: '/F', subFolders: [] }] },
    }]);
    const result = await tickUntil(fts, value => value?.complete === true);

    expect(result).toMatchObject({ complete: true });
    expect(keys.has(zGone)).toBe(false);
    expect(recheckMessageInFolder).toHaveBeenCalledOnce();
    expect(_testExports._isFolderReconPending()).toBe(false);
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
    expect(_testExports._isFolderReconPending()).toBe(false);
  });

  it.each([
    ['an equal count basis', []],
    ['a walk after a count mismatch', ['account1:/Gone:x@example.com']],
  ])('keeps a legacy orphan completion from %s across a later drain write', async (_label, ghosts) => {
    const { fts, keys } = installLegacyKeyIndex(['/Keep'], ghosts);
    holdMarkerWithQueuedUpdate();

    await tickUntil(fts, () => _testExports._getFolderReconOrphanPass()?.complete === true);
    expect(_testExports._getFolderReconOrphanPass()?.complete).toBe(true);
    expect(_testExports._isFolderReconPending()).toBe(true);
    for (const ghost of ghosts) expect(keys.has(ghost)).toBe(false);

    // The queued update drains: one indexBatch into a known folder.
    _testExports._getPendingUpdates().clear();
    await runFtsMembershipMutation(async () => ({ count: 1 }));
    fts.countMsgIdRange.mockClear();
    fts.listMsgIdRange.mockClear();
    fts.fingerprintMsgIdRange.mockClear();
    const result = await settleSchedulerTickWithFakeTimers(fts);

    expect(result).toMatchObject({ complete: true });
    expect(_testExports._isFolderReconPending()).toBe(false);
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
    holdMarkerWithQueuedUpdate();

    await tickUntil(fts, () => _testExports._getFolderMembershipStatePass()?.completed === true);
    await settleSchedulerTickWithFakeTimers(fts);
    expect(nativeRows.has(former)).toBe(false);
    expect(nativeRows.get('account1:/F:X:a@example.com')).toBe(makeFolderMembershipId('account1', '/F'));
    expect(nativeRows.get('account1:/F:X:b@example.com')).toBe(makeFolderMembershipId('account1', '/F:X'));
    expect(_testExports._isFolderReconPending()).toBe(true);

    _testExports._getPendingUpdates().clear();
    await runFtsMembershipMutation(async () => ({ count: 1 }));
    fts.listFolderMembershipState.mockClear();
    // The write raises the scheduler's quiet floor; the next ticks wait it out.
    const result = await tickUntil(fts, value => value?.complete === true, 40);

    expect(result).toMatchObject({ complete: true });
    expect(_testExports._isFolderReconPending()).toBe(false);
    expect(fts.listFolderMembershipState).not.toHaveBeenCalled();
  });

  it('does not let a completed exact pass survive an inventory change', async () => {
    const installed = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds: [] }]);
    const { fts } = installed;
    holdMarkerWithQueuedUpdate();
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
    expect(_testExports._isFolderReconPending()).toBe(true);
    const result = await tickUntil(fts, value => value?.complete === true);
    expect(result).toMatchObject({ complete: true });
  });

  it('documents #111: a late exact-mode commit after the completed pass stays until the next pass', async () => {
    const { nativeRows, fts } = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds: [] }]);
    await tickUntil(fts, value => value?.complete === true);
    expect(_testExports._isFolderReconPending()).toBe(false);

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
    await _testExports._abandonPendingUpdates([{ ...update }]);
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
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);

    // Resolution: /F:X's copy goes away and the flaky query recovers.
    rowsByURI.set(folders[1].folderURI, []);
    rowsByURI.get(folders[0].folderURI).push({ msgKey: 9, headerMessageId: 'b-flaky@example.com' });
    recheckMessageInFolder.mockResolvedValue('absent');
    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
    for (let turn = 0; turn < 60 && !_testExports._getFolderMembershipCutoverProven(); turn++) {
      await settleSchedulerTickWithFakeTimers(fts);
      vi.setSystemTime(Date.now() + 100);
      const id = `drained-${written++}@example.com`;
      rowsByURI.get(folders[0].folderURI).push({ msgKey: 1000 + written, headerMessageId: id });
      await runFtsMembershipMutation(async () => {
        nativeRows.set(`account1:/F:${id}`, folders[0].folderId);
        return { count: 1 };
      });
    }
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
    for (const id of headerMessageIds) {
      expect(nativeRows.get(`account1:/F:${id}`)).toBe(folders[0].folderId);
    }

    // Phase 2: quiet ticks complete reconciliation.
    const result = await tickUntil(fts, value => value?.complete === true, 60);
    expect(result).toMatchObject({ complete: true });
    expect(_testExports._isFolderReconPending()).toBe(false);
    expect(populateBatchBody).not.toHaveBeenCalled();
  });
});

describe('drain body fetches (unchanged by reconciliation)', () => {
  afterEach(() => {
    _testExports._getPendingUpdates().clear();
    delete storageData.fts_pending_updates;
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
    expect(_testExports._isFolderReconPending()).toBe(false);
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
    delete storageData.fts_pending_updates;
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

      await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

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

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    expect(fts.removeBatch.mock.calls.flat(2)).not.toContain(LIVE);
    expect(nativeRows.get(LIVE)).toBe(folders[0].folderId);
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    expect(fts.removeBatch.mock.calls.flat(2)).toContain(LIVE);
    expect(nativeRows.has(LIVE)).toBe(false);
  });

  // The per-folder stale direction removes an already-owned row the folder
  // no longer holds. A re-add delivered after its absence verdict queues the
  // message but writes nothing native, so only the event serial can withhold
  // the removal of a row that is live again.
  it.each([false, true])('withholds an owned stale-row removal when the re-add is delivered first; delivered=%s', async (delivered) => {
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
  it.each([false, true])('withholds an owned stale-row removal when the re-add is delivered while the removal fence is acquiring; readd=%s', async (readd) => {
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
    delete storageData.fts_pending_updates;
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
  const settled = value => value?.complete === true && !_testExports._isFolderReconPending();
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
    expect((await _testExports._abandonPendingUpdates([{ ...update }], 'queue_stuck')).dropped).toBe(1);
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
        expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(true);
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
        expect(_testExports._isFolderReconPending()).toBe(false);
      });

      it.each([false, true])('is repaired in-session after clearPendingUpdates abandoned both events; swapped=%s', async (swapped) => {
        const { fts, rowsByURI, nativeRows, folders } = installTokenFolders(specs);
        await finishSession(fts);
        if (swapped) swapA(rowsByURI, folders);
        const now = Date.now();
        _testExports._getPendingUpdates().set(A3, { uniqueKey: A3, type: 'new', timestamp: now, folderKey: 'account1:/A' });
        _testExports._getPendingUpdates().set(A2, { uniqueKey: A2, type: 'deleted', timestamp: now, folderKey: 'account1:/A' });
        await incrementalIndexer.clearPendingUpdates();
        expect(_testExports._getPendingUpdates().size).toBe(0);
        expect(_testExports._isFolderReconPending()).toBe(true);

        await settleWithDrain(fts, nativeRows, folders[0].folderId, 10 * 60_000);

        expect(nativeRows.has(A2)).toBe(!swapped);
        expect(nativeRows.has(A3)).toBe(swapped);
        expect(_testExports._isFolderReconPending()).toBe(false);
      });
    });
  });

  describe('membership safety of the UID tier and the full projection', () => {
    it('never certifies a msgDB replaced during a UID-tier scan', async () => {
      const { fts, folders, tokens, rowsByURI, nativeRows } = installTokenFolders([specs[0]]);
      await finishSession(fts);
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
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(storageData[_testExports.FOLDER_RECON_STORAGE_KEY].folders['account1:/A']).toBeUndefined();
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
      expect(_testExports._isFolderReconPending()).toBe(false);
      expect(globalThis.browser.storage.local.set).not.toHaveBeenCalled();
    });

    // A message event for another folder voids the stamp the digest's first
    // native page captured, at each point after that page.
    it.each([
      ['after the terminal native page', 'terminal_page'],
      ['during the UID enumeration', 'uid_scan'],
      ['during the closing read', 'closing_read'],
    ])('never certifies a UID-tier hit whose native-page stamp was invalidated %s; a fresh attempt does', async (_name, moment) => {
      const { fts, folders } = installTokenFolders([{ folderPath: '/Big', headerMessageIds: many }]);
      await finishSession(fts);
      const invalidate = () => _testExports._invalidateFolderReconProofForEvent('account1', '/Elsewhere');
      const hook = { ran: false, certifiedBefore: null };
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
      expect(_testExports._isFolderReconPending()).toBe(true);

      await finishSession(fts);
      expect(_testExports._getFolderReconSessionDone()).toEqual(new Set([BIG]));
      expect(_testExports._isFolderReconPending()).toBe(false);
      expect(memoFor(BIG)).toMatchObject({ verified: true, incarnationToken: expect.any(String) });
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
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(true);

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
      expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
      expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._isFolderReconPending()).toBe(false);

      expect(await rollUntil(fts, due, () => queued(A2), due + 3 * intervalMs)).toBe(true);
      expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._isFolderReconPending()).toBe(false);
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
        expect(_testExports._isFolderReconPending()).toBe(true);
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
      expect(_testExports._isFolderReconPending()).toBe(false);
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
        expect(_testExports._isFolderReconPending()).toBe(false);
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
      expect(_testExports._getFolderMembershipCutoverProven()).toBe(true);
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
    expect(_testExports._getFolderMembershipCutoverProven()).toBe(false);

    expect(await underTraffic(fts, () => _testExports._getFolderMembershipCutoverProven())).toBe(true);
    expect(_testExports._getFolderMembershipStatePass()).toMatchObject({ completed: true });
  });

  it('re-earns cutover after a capable reconnect despite events every 4 s', async () => {
    const { fts } = installExactMembershipFolders(specs);
    _testExports._setFtsSearch(fts);
    expect(await underTraffic(fts, () => _testExports._getFolderMembershipCutoverProven())).toBe(true);

    // The reconnect revokes cutover; it is re-earned only by a state pass
    // bound to the new connection generation.
    fts.getConnectionGeneration.mockReturnValue(2);
    fts.listFolderMembershipState.mockClear();
    expect(await underTraffic(fts, () => _testExports._getFolderMembershipCutoverProven()
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

describe('membership assignment scoped query list lifecycle', () => {
  const ROW = 'account1:/F:scoped@example.com';
  const HIT = { id: 5, headerMessageId: 'scoped@example.com' };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(realDateNow());
  });
  afterEach(() => {
    _testExports._setIsEnabled(false);
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  function seedUnassignedRow() {
    const installed = seedMigratedExactFolders([{ folderPath: '/F', headerMessageIds: [] }]);
    installed.nativeRows.set(ROW, null);
    globalThis.browser.messages = {
      ...globalThis.browser.messages,
      query: vi.fn(),
      continueList: vi.fn(),
    };
    return installed;
  }

  it('assigns on a terminal scoped positive with no global query and no list to release', async () => {
    const { fts, nativeRows, folders } = seedUnassignedRow();
    globalThis.browser.messages.query.mockResolvedValue({ messages: [HIT] });

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    expect(nativeRows.get(ROW)).toBe(folders[0].folderId);
    expect(recheckMessageInFolder).not.toHaveBeenCalled();
    expect(releaseMessageList).not.toHaveBeenCalled();
  });

  it('releases an open list when a sync event interrupts its continuation, then assigns on retry', async () => {
    const { fts, nativeRows, folders } = seedUnassignedRow();
    let interrupted = false;
    globalThis.browser.messages.query.mockImplementation(async () => (interrupted
      ? { messages: [HIT] }
      : { id: 'list-1', messages: [] }));
    globalThis.browser.messages.continueList.mockImplementation(async () => {
      interrupted = true;
      // A real Thunderbird event lands while the continuation is in flight.
      await _testExports.onExperimentMessageAdded({
        accountId: 'account1', folderPath: '/F', headerMessageId: 'other@example.com', msgKey: 9, eventType: 'msgAdded',
      });
      _testExports._getPendingUpdates().clear();
      return { id: 'list-1', messages: [HIT] };
    });

    const first = await settleSchedulerTickWithFakeTimers(fts);
    expect(first).toMatchObject({ complete: false, migration: { retry: true } });
    expect(releaseMessageList).toHaveBeenCalledWith('list-1');
    expect(nativeRows.get(ROW)).toBeNull();
    expect(recheckMessageInFolder).not.toHaveBeenCalled();

    vi.setSystemTime(Date.now() + 100);
    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());
    expect(nativeRows.get(ROW)).toBe(folders[0].folderId);
  });

  it('releases the list when a continuation fails and lets the global query decide', async () => {
    const { fts, nativeRows, folders } = seedUnassignedRow();
    globalThis.browser.messages.query.mockResolvedValue({ id: 'list-1', messages: [] });
    globalThis.browser.messages.continueList.mockRejectedValue(new Error('list busy'));
    recheckMessageInFolder.mockResolvedValue('present');

    await tickUntil(fts, () => _testExports._getFolderMembershipCutoverProven());

    expect(releaseMessageList).toHaveBeenCalledWith('list-1');
    expect(recheckMessageInFolder).toHaveBeenCalled();
    expect(nativeRows.get(ROW)).toBe(folders[0].folderId);
  });
});
