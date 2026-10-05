/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
  indexBatch: vi.fn(async () => ({ count: 0 })),
  removeBatch: vi.fn(async () => ({ count: 0 })),
  clear: vi.fn(async () => ({ ok: true })),
  assignFolderMembershipBatch: vi.fn(async () => ({ ok: true })),
  supportsFolderMembershipSummary: vi.fn(() => true),
  folderMembershipSummary: vi.fn(async () => ({ ok: true, ownerlessRows: 1, strayTrustedRows: 2, strayUntrustedRows: 3 })),
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
  ftsMembershipKeysUnchangedSince,
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

// The native helper changes only the declared owner of a row it receives
// with a folderId (it fills a NULL owner; a different stored owner aborts the
// batch). A folder whose raw key range merely holds the key is untouched.
describe('owner-known writes are attributed to their owners alone', () => {
  const childKey = 'account1:/F:Child:nine@example.com';
  const sentWithFolderIds = async (rows, wire) => {
    wire.withFolderIds = true;
    return { count: rows.length };
  };

  it('an index the helper received with folderIds touches its owner and not the folder whose key range holds the key', async () => {
    native.indexBatch.mockImplementationOnce(sentWithFolderIds);
    const changed = await touched(() => ftsSearch.indexBatch([{ msgId: childKey, folderId: CHILD }]));
    expect(changed(CHILD)).toBe(true);
    expect(changed(PARENT)).toBe(false);
  });

  // An older helper receives the legacy row shape and changes key ranges.
  it.each([
    ['sent in the legacy shape', async (rows, wire) => { wire.withFolderIds = false; return { count: rows.length }; }],
    ['never reported as sent', async () => { throw new Error('Native FTS helper not connected'); }],
  ])('an index %s is attributed by key', async (_label, implementation) => {
    native.indexBatch.mockImplementationOnce(implementation);
    const changed = await touched(() => ftsSearch.indexBatch([{ msgId: childKey, folderId: CHILD }]).catch(() => {}));
    expect(changed(CHILD)).toBe(true);
    expect(changed(PARENT)).toBe(true);
    expect(changed(A)).toBe(false);
  });

  it.each([
    { shape: 'with folderIds', withFolderIds: true },
    { shape: 'legacy', withFolderIds: false },
  ])('a fenced index sent $shape is attributed by what was sent when the fence completes', async ({ withFolderIds }) => {
    native.indexBatch.mockImplementationOnce(async (rows, wire) => {
      wire.withFolderIds = withFolderIds;
      return { count: rows.length };
    });
    const since = getFtsMembershipEpoch();
    await withFtsMembershipFence(since, async (token) => {
      await ftsSearch.indexBatch([{ msgId: childKey, folderId: CHILD }], token);
    }, { mutation: true, scope: [A] });
    expect(ftsMembershipUnchangedSince([CHILD], since)).toBe(false);
    expect(ftsMembershipUnchangedSince([PARENT], since)).toBe(withFolderIds);
  });

  it('an assignment touches its owner and not the folder whose key range holds the key', async () => {
    const changed = await touched(() => ftsSearch.assignFolderMembershipBatch([{ msgId: childKey, folderId: CHILD }]));
    expect(changed(CHILD)).toBe(true);
    expect(changed(PARENT)).toBe(false);
  });

  // A legacy helper's key-only removal cannot name the owner it deleted.
  it('a legacy removal still touches every folder whose key range holds the key', async () => {
    const changed = await touched(() => ftsSearch.removeBatch([childKey]));
    expect(changed(CHILD)).toBe(true);
    expect(changed(PARENT)).toBe(true);
  });
});

// INVARIANT: a removal changes only the folders whose rows it deleted. A
// helper that reports those owners (`removedFolderIds`, with
// `removedOwnerless` counting deleted rows that had none) is attributed to
// them alone; any reply that cannot vouch for every deleted row's owner, and
// any failed call, keeps the conservative key-range attribution.
describe('removals are attributed to the owners the helper reports', () => {
  const COLD = makeFolderMembershipId('account1', '/Cold');
  const HOT = makeFolderMembershipId('account1', '/Cold:Hot');
  const hotKey = 'account1:/Cold:Hot:one@example.com';
  const childKey = 'account1:/F:Child:nine@example.com';
  const parentKey = 'account1:/F:eight@example.com';

  beforeEach(() => {
    registerFtsMembershipFolders([A, B, PARENT, CHILD, COLD, HOT]);
  });

  it('a removal in /Cold:Hot no longer touches /Cold', async () => {
    native.removeBatch.mockResolvedValueOnce({ ok: true, count: 1, removedFolderIds: [HOT], removedOwnerless: 0 });
    const changed = await touched(() => ftsSearch.removeBatch([hotKey]));
    expect(changed(HOT)).toBe(true);
    expect(changed(COLD)).toBe(false);
  });

  it('a mixed batch of owned, absent and duplicate ids touches exactly the reported owners', async () => {
    native.removeBatch.mockResolvedValueOnce({
      ok: true, count: 2, removedFolderIds: [CHILD, PARENT], removedOwnerless: 0,
    });
    const absentKey = 'account1:/A:absent@example.com';
    const changed = await touched(() => ftsSearch.removeBatch([childKey, parentKey, absentKey, childKey]));
    expect(changed(CHILD)).toBe(true);
    expect(changed(PARENT)).toBe(true);
    expect(changed(A)).toBe(false);
    expect(changed(B)).toBe(false);
  });

  it('a removal that deleted nothing touches no folder but still records its keys', async () => {
    native.removeBatch.mockResolvedValueOnce({ ok: true, count: 0, removedFolderIds: [], removedOwnerless: 0 });
    const since = getFtsMembershipEpoch();
    await ftsSearch.removeBatch([childKey]);
    expect(ftsMembershipUnchangedSince([CHILD], since)).toBe(true);
    expect(ftsMembershipUnchangedSince([PARENT], since)).toBe(true);
    expect(ftsMembershipKeysUnchangedSince([childKey], since)).toBe(false);
  });

  it.each([
    { label: 'a legacy reply without owners', reply: { count: 1 } },
    { label: 'owners that are not an array', reply: { count: 1, removedFolderIds: CHILD, removedOwnerless: 0 } },
    { label: 'an empty owner id', reply: { count: 1, removedFolderIds: [CHILD, ''], removedOwnerless: 0 } },
    { label: 'a non-string owner id', reply: { count: 1, removedFolderIds: [7], removedOwnerless: 0 } },
    { label: 'a deleted ownerless row', reply: { count: 2, removedFolderIds: [CHILD], removedOwnerless: 1 } },
    { label: 'no ownerless count', reply: { count: 1, removedFolderIds: [CHILD] } },
  ])('$label keeps key attribution', async ({ reply }) => {
    native.removeBatch.mockResolvedValueOnce(reply);
    const changed = await touched(() => ftsSearch.removeBatch([childKey]));
    expect(changed(CHILD)).toBe(true);
    expect(changed(PARENT)).toBe(true);
    expect(changed(A)).toBe(false);
  });

  it.each([
    { label: 'throws', fail: () => { throw new Error('native refused'); } },
    { label: 'times out', fail: () => { throw new Error('Native RPC timeout: removeBatch'); } },
  ])('a removal that $label keeps key attribution', async ({ fail }) => {
    native.removeBatch.mockImplementationOnce(async () => fail());
    const changed = await touched(() => ftsSearch.removeBatch([childKey]).catch(() => {}));
    expect(changed(CHILD)).toBe(true);
    expect(changed(PARENT)).toBe(true);
  });

  it('a fenced removal is attributed to the reported owner when the fence completes', async () => {
    native.removeBatch.mockResolvedValueOnce({ ok: true, count: 1, removedFolderIds: [CHILD], removedOwnerless: 0 });
    const since = getFtsMembershipEpoch();
    await withFtsMembershipFence(since, async (token) => {
      await ftsSearch.removeBatch([childKey], token);
    }, { mutation: true, scope: { keys: [] } });
    expect(ftsMembershipUnchangedSince([CHILD], since)).toBe(false);
    expect(ftsMembershipUnchangedSince([PARENT], since)).toBe(true);
    expect(ftsMembershipKeysUnchangedSince([childKey], since)).toBe(false);
  });

  it('a fenced removal with a deleted ownerless row keeps key attribution', async () => {
    native.removeBatch.mockResolvedValueOnce({ ok: true, count: 2, removedFolderIds: [CHILD], removedOwnerless: 1 });
    const since = getFtsMembershipEpoch();
    await withFtsMembershipFence(since, async (token) => {
      await ftsSearch.removeBatch([childKey, parentKey], token);
    }, { mutation: true, scope: { keys: [] } });
    expect(ftsMembershipUnchangedSince([CHILD], since)).toBe(false);
    expect(ftsMembershipUnchangedSince([PARENT], since)).toBe(false);
  });
});

// INVARIANT (stage 3b): every native mutation wrapper reports the exact raw
// keys it attempts — whether or not its folder attribution uses them — so
// a key-scoped state-pass verdict is voided by any write to its key.
describe('native mutation wrappers attribute their exact keys', () => {
  const key = 'account1:/F:Child:nine@example.com';
  const other = 'account1:/F:Child:ten@example.com';

  async function keysTouched(write) {
    const since = getFtsMembershipEpoch();
    await write();
    return candidate => !ftsMembershipKeysUnchangedSince([candidate], since);
  }

  it.each([
    { label: 'a capable indexBatch', write: () => {
      native.indexBatch.mockImplementationOnce(async (rows, wire) => { wire.withFolderIds = true; return { count: rows.length }; });
      return ftsSearch.indexBatch([{ msgId: key, folderId: CHILD }]);
    } },
    { label: 'a failed capable indexBatch', write: () => {
      native.indexBatch.mockImplementationOnce(async (rows, wire) => { wire.withFolderIds = true; throw new Error('native refused'); });
      return ftsSearch.indexBatch([{ msgId: key, folderId: CHILD }]).catch(() => {});
    } },
    { label: 'a legacy indexBatch', write: () => ftsSearch.indexBatch([{ msgId: key, folderId: CHILD }]) },
    { label: 'an assignment', write: () => ftsSearch.assignFolderMembershipBatch([{ msgId: key, folderId: CHILD }]) },
    { label: 'a removal', write: () => ftsSearch.removeBatch([key]) },
  ])('$label records its row\'s key and no other', async ({ write }) => {
    const changed = await keysTouched(write);
    expect(changed(key)).toBe(true);
    expect(changed(other)).toBe(false);
  });

  it('a fenced wrapper call records its key when the fence completes', async () => {
    const since = getFtsMembershipEpoch();
    await withFtsMembershipFence(since, async (token) => {
      await ftsSearch.removeBatch([key], token);
      expect(ftsMembershipKeysUnchangedSince([key], since)).toBe(true);
    }, { mutation: true, scope: { keys: [] } });
    expect(ftsMembershipKeysUnchangedSince([key], since)).toBe(false);
    expect(ftsMembershipKeysUnchangedSince([other], since)).toBe(true);
  });
});

describe('native mutation wrappers apply the native write', () => {
  const one = 'account1:/A:one@example.com';
  const two = 'account1:/A:two@example.com';

  // A stateful stand-in for the helper's rows and owners, for one call each.
  function statefulNative() {
    const rows = new Map();
    native.indexBatch.mockImplementationOnce(async (batch, wire) => {
      wire.withFolderIds = true;
      for (const row of batch) rows.set(row.msgId, row.folderId);
      return { count: batch.length };
    });
    native.removeBatch.mockImplementationOnce(async ids => {
      let count = 0;
      for (const id of ids) if (rows.delete(id)) count++;
      return { count };
    });
    native.assignFolderMembershipBatch.mockImplementationOnce(async assignments => {
      for (const { msgId, folderId } of assignments) rows.set(msgId, folderId);
      return { assigned: assignments.length };
    });
    native.clear.mockImplementationOnce(async () => {
      rows.clear();
      return { ok: true };
    });
    return rows;
  }

  it('index, assignment, removal and clear change the native rows and return the helper\'s result', async () => {
    const rows = statefulNative();
    expect(await ftsSearch.indexBatch([{ msgId: one, folderId: A }, { msgId: two, folderId: null }])).toEqual({ count: 2 });
    expect(await ftsSearch.assignFolderMembershipBatch([{ msgId: two, folderId: A }])).toEqual({ assigned: 1 });
    expect([...rows]).toEqual([[one, A], [two, A]]);
    expect(await ftsSearch.removeBatch([one])).toEqual({ count: 1 });
    expect([...rows]).toEqual([[two, A]]);
    expect(await ftsSearch.clear()).toEqual({ ok: true });
    expect(rows.size).toBe(0);
  });

  it.each(['indexBatch', 'removeBatch', 'assignFolderMembershipBatch', 'clear'])('%s propagates a native failure and still records the change', async (method) => {
    native[method].mockImplementationOnce(async () => { throw new Error('native write failed'); });
    const args = {
      indexBatch: [[{ msgId: one, folderId: A }]],
      removeBatch: [[one]],
      assignFolderMembershipBatch: [[{ msgId: one, folderId: A }]],
      clear: [],
    }[method];
    const since = getFtsMembershipEpoch();
    await expect(ftsSearch[method](...args)).rejects.toThrow('native write failed');
    expect(ftsMembershipUnchangedSince([A], since)).toBe(false);
  });
});

describe('membership summary pass-through', () => {
  it('forwards the capability and the summary request and reply unchanged', async () => {
    native.supportsFolderMembershipSummary.mockReturnValueOnce(false);
    expect(ftsSearch.supportsFolderMembershipSummary()).toBe(false);
    expect(ftsSearch.supportsFolderMembershipSummary()).toBe(true);

    await expect(ftsSearch.folderMembershipSummary(['folder-a', 'folder-b'], ['account1']))
      .resolves.toEqual({ ok: true, ownerlessRows: 1, strayTrustedRows: 2, strayUntrustedRows: 3 });
    expect(native.folderMembershipSummary).toHaveBeenCalledWith(['folder-a', 'folder-b'], ['account1']);
  });
});
