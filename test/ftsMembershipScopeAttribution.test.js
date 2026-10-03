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

  it('removeBatch touches every candidate folder of each key, including a parent range', async () => {
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

  it('a fenced wrapper call is attributed when the fence completes', async () => {
    const since = getFtsMembershipEpoch();
    await withFtsMembershipFence(since, async (token) => {
      await ftsSearch.removeBatch(['account1:/A:four@example.com'], token);
    }, { mutation: true, scope: [A] });
    expect(ftsMembershipUnchangedSince([A], since)).toBe(false);
    expect(ftsMembershipUnchangedSince([B], since)).toBe(true);
  });
});
