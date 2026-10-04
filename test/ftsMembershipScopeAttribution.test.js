/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  indexBatch: vi.fn(async () => ({ count: 0 })),
  removeBatch: vi.fn(async () => ({ count: 0 })),
  clear: vi.fn(async () => ({ ok: true })),
  assignFolderMembershipBatch: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: {} }));
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../fts/nativeEngine.js', () => ({
  initNativeFts: vi.fn(async () => true),
  nativeFtsSearch: native,
  nativeMemorySearch: {},
}));
vi.mock('../fts/maintenanceScheduler.js', () => ({}));
vi.mock('../fts/incrementalIndexer.js', () => ({}));
vi.mock('../fts/memoryIndexer.js', () => ({}));

const { ftsSearch } = await import('../fts/engine.js');
const {
  _resetFtsOperationCoordinatorForTests,
  ftsMembershipUnchangedSince,
  getFtsMembershipEpoch,
  registerFtsMembershipFolders,
  withFtsMembershipFence,
} = await import('../fts/operationCoordinator.js');
const { makeFolderMembershipId } = await import('../fts/folderMembershipIdentity.js');

const A = makeFolderMembershipId('account1', '/A');
const B = makeFolderMembershipId('account1', '/B');
const PARENT = makeFolderMembershipId('account1', '/F');
const CHILD = makeFolderMembershipId('account1', '/F:Child');

beforeEach(() => {
  _resetFtsOperationCoordinatorForTests();
  // Keys are attributed to the folders reconciliation registered.
  registerFtsMembershipFolders([A, B, PARENT, CHILD]);
  vi.clearAllMocks();
});

async function touched(write) {
  const since = getFtsMembershipEpoch();
  await write();
  return folderId => !ftsMembershipUnchangedSince([folderId], since);
}

describe('native mutation wrappers attribute their folder scope', () => {
  it('indexBatch touches the rows\' folders and no other', async () => {
    const changed = await touched(() => ftsSearch.indexBatch([
      { msgId: 'account1:/A:one@example.com', folderId: A },
    ]));
    expect(native.indexBatch).toHaveBeenCalledTimes(1);
    expect(changed(A)).toBe(true);
    expect(changed(B)).toBe(false);
  });

  it('removeBatch touches every registered folder whose key range holds the key, including a parent range', async () => {
    const changed = await touched(() => ftsSearch.removeBatch(['account1:/F:Child:two@example.com']));
    expect(changed(CHILD)).toBe(true);
    expect(changed(PARENT)).toBe(true);
    expect(changed(A)).toBe(false);
  });

  it('assignFolderMembershipBatch touches the assigned owners', async () => {
    const changed = await touched(() => ftsSearch.assignFolderMembershipBatch([
      { msgId: 'account1:/B:three@example.com', folderId: B },
    ]));
    expect(changed(B)).toBe(true);
    expect(changed(A)).toBe(false);
  });

  it('clear and an unattributable key touch every folder', async () => {
    expect((await touched(() => ftsSearch.clear()))(A)).toBe(true);
    expect((await touched(() => ftsSearch.removeBatch(['no-split'])))(A)).toBe(true);
  });

  it('with registered folders, a key touches only its real candidate folders and indexBatch its explicit owner', async () => {
    registerFtsMembershipFolders([A, PARENT]);
    const removed = await touched(() => ftsSearch.removeBatch(['account1:/F:Child:five@example.com']));
    expect(removed(PARENT)).toBe(true);
    expect(removed(CHILD)).toBe(false);
    expect(removed(A)).toBe(false);

    const indexed = await touched(() => ftsSearch.indexBatch([
      { msgId: 'account1:/B:six@example.com', folderId: B },
    ]));
    expect(indexed(B)).toBe(true);
    expect(indexed(A)).toBe(false);
  });

  it('before any inventory, a key touches no folder and an explicit owner still does', async () => {
    _resetFtsOperationCoordinatorForTests();
    const removed = await touched(() => ftsSearch.removeBatch(['account1:/A:seven@example.com']));
    expect(removed(A)).toBe(false);
    const indexed = await touched(() => ftsSearch.indexBatch([
      { msgId: 'account1:/A:eight@example.com', folderId: A },
    ]));
    expect(indexed(A)).toBe(true);
  });

  // A Message-ID is untrusted input of any length. Attribution must not
  // build or hash a path per ":" (quadratic in the key's length): the work
  // is bounded by the registered paths. Keys stay below V8's string-hash
  // length cutoff so every tried path is really hashed.
  it('attributes a batch of long colon-heavy keys through the wrapper in time bounded by the registered paths', async () => {
    const keys = 50;
    const pairs = 8000;
    const hot = makeFolderMembershipId('account1', '/H:x');
    registerFtsMembershipFolders([A, hot]);
    const batch = Array.from({ length: keys }, (_, n) => `account1:/H:x:${'a:'.repeat(pairs)}${n}@example.com`);
    const started = performance.now();
    const removed = await touched(() => ftsSearch.removeBatch(batch));
    const indexed = await touched(() => ftsSearch.indexBatch(batch.map(msgId => ({ msgId, folderId: hot }))));
    const fenced = ftsMembershipUnchangedSince({ msgIds: batch }, getFtsMembershipEpoch() - 1);
    const elapsedMs = performance.now() - started;
    expect(removed(hot)).toBe(true);
    expect(removed(A)).toBe(false);
    expect(indexed(hot)).toBe(true);
    expect(fenced).toBe(false);
    // Trying every ":" hashes ~3 * 10^9 code units here.
    expect(elapsedMs).toBeLessThan(1000);
  });

  it('a fenced wrapper call is attributed when the fence completes', async () => {
    const since = getFtsMembershipEpoch();
    await withFtsMembershipFence(since, async (token) => {
      await ftsSearch.removeBatch(['account1:/A:four@example.com'], token);
    }, { mutation: true, scope: [A] });
    expect(ftsMembershipUnchangedSince([A], since)).toBe(false);
    expect(ftsMembershipUnchangedSince([B], since)).toBe(true);
  });
});
