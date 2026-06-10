/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// idbStorage.test.js — Regression tests for the lazy IndexedDB open in
// agent/modules/idbStorage.js.
//
// Background: dbPromise used to be created eagerly at module load. In any
// context without an `indexedDB` global (vitest node workers loading the
// module via persistentChatStore.js), the executor's ReferenceError rejected
// a promise with no consumer — a flaky "Unhandled Rejection" in full-suite
// runs that NO caller try/catch could intercept (module evaluation itself
// succeeds; only the orphan promise rejects). The open must be deferred to
// first use so an awaiter exists the moment the promise is created.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// idbStorage.js has no module imports — only globals (indexedDB, browser,
// navigator) — so each test controls the environment and re-imports fresh.

let savedIndexedDB;

beforeEach(() => {
  vi.resetModules();
  savedIndexedDB = globalThis.indexedDB;
  delete globalThis.indexedDB;
});

afterEach(() => {
  if (savedIndexedDB === undefined) {
    delete globalThis.indexedDB;
  } else {
    globalThis.indexedDB = savedIndexedDB;
  }
});

// ---------------------------------------------------------------------------
// Minimal fake indexedDB — just enough for open + get/put transactions.
// ---------------------------------------------------------------------------

function installFakeIndexedDB() {
  const data = new Map();
  const open = vi.fn(() => {
    const req = {};
    queueMicrotask(() => {
      const db = {
        objectStoreNames: { contains: () => true },
        transaction() {
          const store = {
            get(k) {
              const r = {};
              queueMicrotask(() => {
                r.result = data.get(k);
                r.onsuccess?.();
              });
              return r;
            },
            put(rec) {
              data.set(rec.key, rec);
            },
          };
          const tx = { objectStore: () => store };
          // Complete after the per-request microtasks have run
          queueMicrotask(() => queueMicrotask(() => tx.oncomplete?.()));
          return tx;
        },
      };
      req.result = db;
      req.onsuccess?.();
    });
    return req;
  });
  globalThis.indexedDB = { open };
  return { open, data };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('idbStorage lazy open', () => {
  it('importing the module without indexedDB produces no unhandled rejection', async () => {
    const rejections = [];
    const onRejection = (reason) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);

    try {
      await import('../agent/modules/idbStorage.js');
      // Give node time to surface any unhandled rejection (emitted at the
      // end of a macrotask turn)
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));

      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('rejects into the caller when indexedDB is unavailable at first use', async () => {
    const mod = await import('../agent/modules/idbStorage.js');
    // The failure must be deliverable to the caller's try/catch — not orphaned
    await expect(mod.get('some-key')).rejects.toThrow(/indexedDB/);
  });

  it('does not open the database at import time, only on first use', async () => {
    const { open } = installFakeIndexedDB();

    const mod = await import('../agent/modules/idbStorage.js');
    expect(open).not.toHaveBeenCalled();

    await mod.set({ k1: 'v1' });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('reuses the same connection across calls (single open)', async () => {
    const { open } = installFakeIndexedDB();

    const mod = await import('../agent/modules/idbStorage.js');
    await mod.set({ k1: 'v1' });
    const out = await mod.get('k1');

    expect(out).toEqual({ k1: 'v1' });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
