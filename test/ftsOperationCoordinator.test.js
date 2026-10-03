/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const storageData = {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async key => ({ [key]: storageData[key] })),
      set: vi.fn(async obj => Object.assign(storageData, obj)),
    },
  },
};

async function coordinator() {
  return import('../fts/operationCoordinator.js');
}

function deferred() {
  let resolve;
  const promise = new Promise(res => { resolve = res; });
  return { promise, resolve };
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const key of Object.keys(storageData)) delete storageData[key];
  try {
    const mod = await coordinator();
    mod._resetFtsOperationCoordinatorForTests();
  } catch (_) {}
});

describe('native FTS operation coordinator', () => {
  it('routes the initial scan through one owned exclusive lifetime', () => {
    const source = fs.readFileSync(fileURLToPath(new URL('../chat/background.js', import.meta.url)), 'utf8');
    const start = source.indexOf('async function runInitialFtsScan()');
    const end = source.indexOf('// Get current FTS scan status', start);
    const body = source.slice(start, end);
    const acquireAt = body.indexOf('await acquireFtsExclusiveOperation(');
    const firstStatusAt = body.indexOf('await writeOwnedFtsScanStatus(');
    const indexAt = body.indexOf('await indexMessages(');
    const completedAt = body.indexOf(`[FTS_INITIAL_SCAN_KEY]: true`);

    expect(acquireAt).toBeGreaterThanOrEqual(0);
    expect(firstStatusAt).toBeGreaterThan(acquireAt);
    expect(indexAt).toBeGreaterThan(firstStatusAt);
    expect(completedAt).toBeGreaterThan(indexAt);
    expect(body).toMatch(/finally\s*{[\s\S]*clearOwnedFtsScanStatus\([\s\S]*\.release\(\)/);
    expect(body).not.toMatch(/\[FTS_INITIAL_SCAN_KEY\]: true[\s\S]*catch\s*\([^)]*\)\s*{[\s\S]*\[FTS_INITIAL_SCAN_KEY\]: true/);
  });

  it('is writer-preferred and asks an active bounded reconcile lease to cancel', async () => {
    const mod = await coordinator();
    const recon = mod.tryAcquireFtsReconcileLease();
    expect(recon).toBeTruthy();

    const foregroundPromise = mod.acquireFtsExclusiveOperation('full');
    expect(recon.cancelRequested).toBe(true);
    expect(mod.tryAcquireFtsReconcileLease()).toBeNull();

    recon.release();
    const foreground = await foregroundPromise;
    expect(mod.tryAcquireFtsReconcileLease()).toBeNull();
    foreground.release();
    expect(mod.tryAcquireFtsReconcileLease()).toBeTruthy();
  });

  it('does not let an old release clear a newer operation owner', async () => {
    const mod = await coordinator();
    const first = await mod.acquireFtsExclusiveOperation('full');
    first.release();
    const second = await mod.acquireFtsExclusiveOperation('smart');

    first.release();
    expect(mod.getFtsOperationState()).toMatchObject({
      exclusive: true,
      exclusiveKind: 'smart',
    });
    second.release();
  });

  it('rejects a membership fence when a mutation started after the caller check', async () => {
    const mod = await coordinator();
    const expectedEpoch = mod.getFtsMembershipEpoch();
    await mod.runFtsMembershipMutation(async () => ({ count: 1 }));

    await expect(mod.withFtsMembershipFence(expectedEpoch, async () => 'unsafe'))
      .rejects.toThrow(/membership_epoch_changed/);
  });

  it('serializes a foreground mutation behind a short reconciliation fence', async () => {
    const mod = await coordinator();
    const held = deferred();
    const entered = deferred();
    const order = [];
    const expectedEpoch = mod.getFtsMembershipEpoch();
    const fence = mod.withFtsMembershipFence(expectedEpoch, async () => {
      order.push('fence');
      entered.resolve();
      await held.promise;
    });
    await entered.promise;
    const mutation = mod.runFtsMembershipMutation(async () => { order.push('mutation'); });
    await Promise.resolve();
    expect(order).toEqual(['fence']);
    held.resolve();
    await Promise.all([fence, mutation]);
    expect(order).toEqual(['fence', 'mutation']);
  });

  it('lets the wrapped native mutator reuse its fence without deadlock and advances once', async () => {
    const mod = await coordinator();
    const epoch = mod.getFtsMembershipEpoch();
    let nativeCalls = 0;
    const fenced = mod.withFtsMembershipFence(epoch, async (membershipFenceToken) => {
      await mod.runFtsMembershipMutation(async () => { nativeCalls++; }, membershipFenceToken);
    }, { mutation: true });

    await expect(Promise.race([
      fenced.then(() => 'complete'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 100)),
    ])).resolves.toBe('complete');
    expect(nativeCalls).toBe(1);
    expect(mod.getFtsMembershipEpoch()).toBe(epoch + 1);

    // Completion released membership ownership: an ordinary writer can enter,
    // and it contributes exactly its own single epoch advance.
    await mod.runFtsMembershipMutation(async () => { nativeCalls++; });
    expect(nativeCalls).toBe(2);
    expect(mod.getFtsMembershipEpoch()).toBe(epoch + 2);
  });

  it('coalesces throwing and successful exclusive mutations into one post-release notification', async () => {
    const mod = await coordinator();
    const notifications = [];
    const removeListener = mod.addFtsExclusiveMembershipChangeListener((event) => {
      notifications.push({
        event,
        operationState: mod.getFtsOperationState(),
      });
    });
    const lease = await mod.acquireFtsExclusiveOperation('full');

    await mod.runFtsMembershipMutation(async () => ({ count: 1 }));
    await expect(mod.runFtsMembershipMutation(async () => {
      throw new Error('partial native rebuild');
    })).rejects.toThrow('partial native rebuild');

    expect(notifications).toEqual([]);
    expect(mod.getFtsOperationState()).toMatchObject({ exclusive: true });
    lease.release();
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      event: {
        kind: 'full',
        startEpoch: 0,
        endEpoch: 2,
      },
      operationState: { exclusive: false },
    });
    lease.release();
    expect(notifications).toHaveLength(1);
    removeListener();
  });

  it('does not notify for a read-only exclusive lifetime', async () => {
    const mod = await coordinator();
    const listener = vi.fn();
    const removeListener = mod.addFtsExclusiveMembershipChangeListener(listener);
    const lease = await mod.acquireFtsExclusiveOperation('maintenance-read');

    lease.release();

    expect(listener).not.toHaveBeenCalled();
    removeListener();
  });

  it('writes status for a live owner and only that owner can clear its run', async () => {
    const mod = await coordinator();
    const first = await mod.acquireFtsExclusiveOperation('full');
    await mod.writeOwnedFtsScanStatus(first, { scanType: 'reindex' });
    first.release();
    const second = await mod.acquireFtsExclusiveOperation('smart');
    await mod.writeOwnedFtsScanStatus(second, { scanType: 'smart' });

    await mod.clearOwnedFtsScanStatus(first);
    expect(storageData.fts_scan_status).toMatchObject({
      isScanning: true,
      scanType: 'smart',
      runId: second.runId,
    });
    await mod.clearOwnedFtsScanStatus(second);
    expect(storageData.fts_scan_status).toMatchObject({ isScanning: false, scanType: 'none' });
    second.release();
  });

  it('queues owned clear after in-flight progress and rejects late progress resurrection', async () => {
    const mod = await coordinator();
    const lease = await mod.acquireFtsExclusiveOperation('embedding');
    const writeEntered = deferred();
    const allowWrite = deferred();
    browser.storage.local.set.mockImplementationOnce(async obj => {
      writeEntered.resolve();
      await allowWrite.promise;
      Object.assign(storageData, obj);
    });

    const progress = mod.writeOwnedFtsScanStatus(lease, {
      scanType: 'embeddingRebuild',
      progress: { processed: 1 },
    });
    await writeEntered.promise;
    const clear = mod.clearOwnedFtsScanStatus(lease);
    await expect(mod.writeOwnedFtsScanStatus(lease, {
      scanType: 'embeddingRebuild',
      progress: { processed: 2 },
    })).rejects.toThrow(/owner_lost/);

    allowWrite.resolve();
    await Promise.allSettled([progress]);
    await clear;
    lease.release();
    expect(storageData.fts_scan_status).toMatchObject({
      isScanning: false,
      scanType: 'none',
      runId: lease.runId,
    });
  });

  it('normalizes foreign and legacy active status as interrupted without a TTL', async () => {
    const mod = await coordinator();
    storageData.fts_scan_status = {
      isScanning: true,
      scanType: 'maintenance',
      startTime: 1,
    };

    await mod.normalizeInterruptedFtsScanStatus();

    expect(storageData.fts_scan_status).toMatchObject({
      isScanning: false,
      scanType: 'none',
      interrupted: true,
    });
    expect(JSON.stringify(storageData.fts_scan_status)).not.toMatch(/ttl|expires/i);
  });
});

describe('folder-scoped membership change ledger', () => {
  const C = 'folder-cold';
  const H = 'folder-hot';

  it('keeps a proof about one folder valid across mutations attributed to another', async () => {
    const mod = await coordinator();
    const since = mod.getFtsMembershipEpoch();
    await mod.runFtsMembershipMutation(async () => {}, null, new Set([H]));
    await mod.runFtsMembershipMutation(async () => {}, null, new Set([H]));

    expect(mod.getFtsMembershipEpoch()).toBe(since + 2);
    expect(mod.ftsMembershipUnchangedSince([C], since)).toBe(true);
    expect(mod.ftsMembershipUnchangedSince([H], since)).toBe(false);
    expect(mod.ftsMembershipUnchangedSince('*', since)).toBe(false);
  });

  it('invalidates every folder on a wildcard or unscoped mutation', async () => {
    const mod = await coordinator();
    const since = mod.getFtsMembershipEpoch();
    await mod.runFtsMembershipMutation(async () => {});
    expect(mod.ftsMembershipUnchangedSince([C], since)).toBe(false);

    const after = mod.getFtsMembershipEpoch();
    expect(mod.ftsMembershipUnchangedSince([C], after)).toBe(true);
    await mod.runFtsMembershipMutation(async () => {}, null, '*');
    expect(mod.ftsMembershipUnchangedSince([C], after)).toBe(false);
  });

  it('attributes a mutation that throws after a partial commit', async () => {
    const mod = await coordinator();
    const since = mod.getFtsMembershipEpoch();
    await expect(mod.runFtsMembershipMutation(async () => {
      throw new Error('native failed mid-batch');
    }, null, new Set([C]))).rejects.toThrow('native failed mid-batch');
    expect(mod.ftsMembershipUnchangedSince([C], since)).toBe(false);
    expect(mod.ftsMembershipUnchangedSince([H], since)).toBe(true);
  });

  it('records fenced mutator scopes with the fence advance, including on a throw', async () => {
    const mod = await coordinator();
    const since = mod.getFtsMembershipEpoch();
    await mod.withFtsMembershipFence(since, async (token) => {
      await mod.runFtsMembershipMutation(async () => {}, token, new Set([C]));
      // Still inside the mutex: nothing is recorded before the fence ends.
      expect(mod.ftsMembershipUnchangedSince([C], since)).toBe(true);
    }, { mutation: true });
    expect(mod.getFtsMembershipEpoch()).toBe(since + 1);
    expect(mod.ftsMembershipUnchangedSince([C], since)).toBe(false);
    expect(mod.ftsMembershipUnchangedSince([H], since)).toBe(true);

    const second = mod.getFtsMembershipEpoch();
    await expect(mod.withFtsMembershipFence(second, async (token) => {
      await mod.runFtsMembershipMutation(async () => {}, token, new Set([H]));
      throw new Error('verify failed after the commit');
    }, { mutation: true })).rejects.toThrow('verify failed after the commit');
    expect(mod.ftsMembershipUnchangedSince([H], second)).toBe(false);
    expect(mod.ftsMembershipUnchangedSince([C], second)).toBe(true);

    // A fenced native call that throws may have partially committed.
    const third = mod.getFtsMembershipEpoch();
    await expect(mod.withFtsMembershipFence(third, async (token) => {
      await mod.runFtsMembershipMutation(async () => {
        throw new Error('native failed mid-batch');
      }, token, new Set([C]));
    }, { mutation: true })).rejects.toThrow('native failed mid-batch');
    expect(mod.ftsMembershipUnchangedSince([C], third)).toBe(false);
    expect(mod.ftsMembershipUnchangedSince([H], third)).toBe(true);
  });

  it('lets a scoped fence pass unrelated traffic and refuses a change to its folder', async () => {
    const mod = await coordinator();
    const since = mod.getFtsMembershipEpoch();
    await mod.runFtsMembershipMutation(async () => {}, null, new Set([H]));

    const ran = vi.fn();
    await mod.withFtsMembershipFence(since, ran, { mutation: true, scope: [C] });
    expect(ran).toHaveBeenCalledTimes(1);
    await expect(mod.withFtsMembershipFence(since, ran, { scope: [H] }))
      .rejects.toThrow('membership_epoch_changed');
    // The unscoped fence keeps the global rule.
    await expect(mod.withFtsMembershipFence(since, ran))
      .rejects.toThrow('membership_epoch_changed');
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it('never grants validity across an evicted ledger entry', async () => {
    const mod = await coordinator();
    mod._resetFtsOperationCoordinatorForTests({ changeLedgerCap: 2 });
    const old = mod.getFtsMembershipEpoch();
    await mod.runFtsMembershipMutation(async () => {}, null, new Set(['f1']));
    const mid = mod.getFtsMembershipEpoch();
    await mod.runFtsMembershipMutation(async () => {}, null, new Set(['f2']));
    await mod.runFtsMembershipMutation(async () => {}, null, new Set(['f3']));

    // f1 was evicted: a stamp from before its change cannot be judged and is
    // invalid for every folder, including ones never touched.
    expect(mod.ftsMembershipUnchangedSince(['f1'], old)).toBe(false);
    expect(mod.ftsMembershipUnchangedSince(['never-touched'], old)).toBe(false);
    // A stamp at or after the floor is still judged per folder.
    expect(mod.ftsMembershipUnchangedSince(['f1'], mid)).toBe(true);
    expect(mod.ftsMembershipUnchangedSince(['f2'], mid)).toBe(false);
  });

  it('clears the ledger on reset', async () => {
    const mod = await coordinator();
    await mod.runFtsMembershipMutation(async () => {}, null, new Set([C]));
    mod._resetFtsOperationCoordinatorForTests();
    expect(mod.getFtsMembershipEpoch()).toBe(0);
    expect(mod.ftsMembershipUnchangedSince([C], 0)).toBe(true);
  });
});
