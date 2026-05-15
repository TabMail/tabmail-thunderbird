# Maintenance scan speedup (streaming cursor)

> **Status:** Plan / follow-up. **Depends on
> `PLAN_RECONCILE_WATERMARK.md` landing first.** That plan
> establishes the boot reconcile as the primary correctness surface
> for the boot-cycle gap; this plan makes the periodic maintenance
> scans (hourly / daily / weekly / monthly — collectively "the
> weekly scan" in casual conversation) 5–6× faster by adopting the
> same streaming-cursor pattern the boot reconcile already uses
> successfully.
>
> **Why follow-up, not bundled:** the watermark fix is a small,
> focused diff that lands cleanly. This plan refactors the shared
> validator out of `_reconcileCleanupStaleEntries` and rewrites
> `cleanupMissingEntries` to use it — bigger surface, easier to
> revert independently if it regresses.

## Why this matters

`PLAN_RECONCILE_WATERMARK.md` makes the boot reconcile authoritative
for boot-cycle drops, so the maintenance scans become a true safety
net for runtime listener drops rather than the load-bearing
correctness mechanism. But they're still load-bearing for that
secondary role, and at the current cadence they bite:

- Daily scan over 3 days × tens of thousands of FTS entries hits
  the MV3 service worker suspension envelope.
- Weekly scan over 3 weeks compounds the problem.
- `entryDelayMs=50ms` × 30k entries = 25 min of pure yield time,
  most of which is unnecessary.

The boot reconcile already demonstrates that 10ms per-entry yielding
plus inline validation works fine without native messaging
disconnects. We can lift that pattern.

## Where the slowness lives today

`fts/maintenanceScheduler.js` → `cleanupMissingEntries(ftsSearch,
startDate, endDate, options)`:

**Phase 1 — collect-all (lines ~534-598)**

- Cursor-paginates `queryByDateRange` at 500/chunk
- Accumulates everything into `allEntries[]`
- Dedupes by `msgId` in `seenMsgIds` set
- 100ms yield between query chunks
- For a 3-week window with 30k entries: ~60 chunks, ~6s pre-roll,
  30k entries × ~100 bytes = 3 MB held in memory

**Phase 1.5 — account-liveness pre-check (lines ~608-649)**

- Walks `allEntries[]` to gather unique `accountId`s
- For each accountId: `browser.accounts.get` + `browser.folders.query`
- Skips entries from accounts that fail the check
- O(N) extra walk before any validation can begin

**Phase 2 — batched validation (lines ~654-741)**

- Iterates `allEntries[]` in batches of `validationBatchSize` (50)
- Per entry: `parseUniqueId` → `headerIDToWeID` → record stale
- `entryDelayMs` (50ms) between entries
- `ftsSearch.stats()` keepalive ping per batch
- `batchDelayMs` (100ms) between batches
- Per-batch progress log line

**Phase 3 — chunked removal (lines ~745-775)**

- Splits `entriesToRemove` into chunks of `removeBatchSize` (100)
- One `removeBatch` call per chunk
- 100ms yield between chunks

## What boot reconcile does instead

`fts/incrementalIndexer.js` → `_reconcileCleanupStaleEntries`:

- One `while` loop, cursor-based pagination at 200/chunk
- Validates each entry inline as the chunk streams
- 10ms yield per entry, no per-batch yield, no `stats()` keepalive
- Account-liveness check uses only the first chunk's accounts
- Single `removeBatch(entriesToRemove)` call at the end

The structural difference is collect-all vs streaming. The numerical
difference is 50ms vs 10ms per entry, plus the batch overhead.

## The refactor

### Extract a shared streaming validator

New file: **`fts/staleSweep.js`**

```js
// fts/staleSweep.js
// Shared streaming-cursor stale-entry validator. Used by both
// boot reconcile (Phase 2) and the maintenance scheduler's
// cleanupMissingEntries.

import { headerIDToWeID, log, parseUniqueId } from "../agent/modules/utils.js";
import { logFtsOperation, logFtsBatchOperation } from "../agent/modules/eventLogger.js";

const DEFAULT_CHUNK_SIZE = 200;
const DEFAULT_ENTRY_DELAY_MS = 10;

/**
 * Stream FTS entries in [startDate, endDate], validate each against
 * TB by resolving headerID → weID at the entry's indexed folder,
 * collect stale msgIds, and remove them in a single batch at the end.
 *
 * @param {Object} ftsSearch
 * @param {Date}   startDate
 * @param {Date}   endDate
 * @param {Object} [opts]
 * @param {number} [opts.chunkSize=200]
 * @param {number} [opts.entryDelayMs=10]
 * @param {string} [opts.eventNamespace="reconcile"]  // "reconcile" | "maintenance"
 * @param {Function} [opts.onProgress]                 // optional ({checked, found}) callback
 * @returns {Promise<{checked:number, removed:number, accountsSkipped:number, removedDetails:Array}>}
 */
export async function streamingStaleSweep(ftsSearch, startDate, endDate, opts = {}) {
  const chunkSize     = opts.chunkSize     ?? DEFAULT_CHUNK_SIZE;
  const entryDelayMs  = opts.entryDelayMs  ?? DEFAULT_ENTRY_DELAY_MS;
  const ns            = opts.eventNamespace || "reconcile";
  const onProgress    = opts.onProgress;

  let checked = 0;
  let removed = 0;
  const entriesToRemove = [];
  const removedDetails  = [];

  // Incremental account-liveness: lazily verify each new accountId
  // we encounter, cache the result. This replaces the all-entries
  // pre-scan in maintenance's Phase 1.5.
  const accountStatus = new Map(); // accountId → "available" | "unavailable"
  async function isAccountAvailable(accountId) {
    if (!accountId) return true;
    if (accountStatus.has(accountId)) {
      return accountStatus.get(accountId) === "available";
    }
    try {
      const acct = await browser.accounts.get(accountId);
      if (!acct) {
        accountStatus.set(accountId, "unavailable");
        log(`[StaleSweep] account ${accountId} not found — skipping its entries`, "warn");
        logFtsOperation(`${ns}_stale`, "account_unavailable", { accountId });
        return false;
      }
      const folders = await browser.folders.query({ accountId, limit: 1 });
      if (!folders || folders.length === 0) {
        accountStatus.set(accountId, "unavailable");
        log(`[StaleSweep] account ${accountId} has no queryable folders — skipping`, "warn");
        logFtsOperation(`${ns}_stale`, "account_unavailable", { accountId });
        return false;
      }
      accountStatus.set(accountId, "available");
      return true;
    } catch (e) {
      accountStatus.set(accountId, "unavailable");
      log(`[StaleSweep] account ${accountId} check failed: ${e.message}`, "warn");
      logFtsOperation(`${ns}_stale`, "account_unavailable", { accountId, error: String(e.message || e) });
      return false;
    }
  }

  logFtsBatchOperation(`${ns}_sweep`, "start", {
    startDate: startDate.toISOString(),
    endDate:   endDate.toISOString(),
  });

  let cursorEndMs = endDate.getTime();
  const startMs   = startDate.getTime();

  while (cursorEndMs > startMs) {
    const chunk = await ftsSearch.queryByDateRange(startDate, new Date(cursorEndMs), chunkSize);
    if (!chunk || chunk.length === 0) break;

    for (const entry of chunk) {
      const parsed = parseUniqueId(entry.msgId);
      if (!parsed) { checked++; continue; }

      const { weFolder, headerID } = parsed;

      if (!(await isAccountAvailable(weFolder?.accountId))) {
        checked++;
        continue;
      }

      try {
        const weID = await headerIDToWeID(headerID, weFolder, false, false);
        if (!weID) {
          entriesToRemove.push(entry.msgId);
          removedDetails.push({
            action: "removedMissing",
            msgId:      entry.msgId,
            folderPath: String(weFolder?.path || ""),
            headerID:   String(headerID || ""),
            subject:    String(entry?.subject || ""),
            dateMs:     Number(entry?.dateMs || 0),
          });
          logFtsOperation(`${ns}_stale`, "found", {
            msgId: entry.msgId,
            folderPath: weFolder?.path || "",
            headerID,
            subject: entry.subject || "",
          });
        }
      } catch (e) {
        // On error checking existence, skip — do NOT remove on uncertainty.
        logFtsOperation(`${ns}_stale`, "error_skipped", {
          msgId: entry.msgId,
          folderPath: weFolder?.path || "",
          headerID,
          error: String(e),
        });
      }

      checked++;
      if (onProgress && checked % 100 === 0) {
        onProgress({ checked, found: entriesToRemove.length });
      }

      if (entryDelayMs > 0) {
        await new Promise(r => setTimeout(r, entryDelayMs));
      }
    }

    if (chunk.length < chunkSize) break;
    const oldestMs = chunk[chunk.length - 1]?.dateMs;
    if (typeof oldestMs !== 'number' || oldestMs <= startMs) break;
    const nextCursor = oldestMs - 1;
    if (nextCursor >= cursorEndMs) break;
    cursorEndMs = nextCursor;
  }

  if (entriesToRemove.length > 0) {
    log(`[StaleSweep] Removing ${entriesToRemove.length} stale entries`);
    for (const msgId of entriesToRemove) {
      logFtsOperation(`${ns}_remove`, "removing", { msgId });
    }
    try {
      const result = await ftsSearch.removeBatch(entriesToRemove);
      removed = result.count || 0;
    } catch (e) {
      log(`[StaleSweep] removeBatch failed: ${e}`, "warn");
    }
  }

  const accountsSkipped = Array.from(accountStatus.values())
    .filter(v => v === "unavailable").length;

  logFtsBatchOperation(`${ns}_sweep`, "complete", {
    checked, staleFound: entriesToRemove.length, removed, accountsSkipped,
  });

  return { checked, removed, accountsSkipped, removedDetails };
}
```

### Migrate `_reconcileCleanupStaleEntries`

In `fts/incrementalIndexer.js`, replace the body of
`_reconcileCleanupStaleEntries` with:

```js
async function _reconcileCleanupStaleEntries(ftsSearch, reconcileFromMs) {
  return streamingStaleSweep(
    ftsSearch,
    new Date(reconcileFromMs),
    new Date(),
    { eventNamespace: "reconcile" }
  );
}
```

The reconcile flow becomes a one-liner around the shared helper.
The watermark-completion gate in `runPostInitReconcile` continues to
read `accountsSkipped` from the helper's return value, exactly as
the watermark plan specified.

### Migrate `cleanupMissingEntries`

In `fts/maintenanceScheduler.js`, replace the body of
`cleanupMissingEntries` with a wrapper that calls the helper. The
existing function signature is preserved so the maintenance
scheduler's callers don't change:

```js
async function cleanupMissingEntries(ftsSearch, startDate, endDate, options = {}) {
  const { checked, removed, accountsSkipped, removedDetails } =
    await streamingStaleSweep(ftsSearch, startDate, endDate, {
      eventNamespace: "maintenance",
    });

  return {
    processed: checked,
    removed,
    accountsSkipped,
    removedDetails,
  };
}
```

The 200+ lines of Phase 1 / 1.5 / 2 / 3 inside the old
`cleanupMissingEntries` are deleted.

### Constants

- New constants live in `fts/staleSweep.js` (`DEFAULT_CHUNK_SIZE`,
  `DEFAULT_ENTRY_DELAY_MS`).
- `SETTINGS.ftsCleanup` in `agent/modules/config.js` becomes unused
  once `cleanupMissingEntries` no longer reads it. Remove the
  block. If we ever need per-tier tuning we can plumb `opts.*`
  through from the maintenance scheduler.
- `RECONCILE_QUERY_CHUNK_SIZE` and `RECONCILE_ENTRY_DELAY_MS` in
  `incrementalIndexer.js` also become unused. Remove them.

## Risks & things to verify

1. **Native messaging keepalive over long runs.** The boot reconcile
   tops out at ~7d windows (per watermark plan after first run);
   the weekly scan can hit 21d windows = ~30k entries. The per-batch
   `ftsSearch.stats()` ping in the old code was defensive, and at
   30k entries × 10ms = 5 min the worker is in a different regime
   than the boot reconcile has ever been tested at.
   **Mitigation:** add a long-run test (synthesize 30k entries),
   confirm the native port stays alive end-to-end. If it
   disconnects, add a periodic keepalive *inside the loop* (every
   N entries, not per batch) — but only after we've confirmed it's
   actually needed.

2. **The 50ms → 10ms change has a history.** The comment in
   `config.js:93` says "reduced from 200ms" — implying an earlier
   regression that prompted bumping it up. Check git log /
   commit history for the original incident before going to 10ms.
   If the 200ms→50ms change was about native messaging stability
   under load, the same constraint may apply at 10ms. Reconcile
   running fine at 10ms is suggestive but not conclusive because
   reconcile windows are smaller.

3. **MV3 service worker suspension.** The MV3 background script
   can be suspended even with an active `await`. The boot
   reconcile is short enough (typically <1 min) that this hasn't
   bitten. A 5 min weekly run is more exposed.
   **Mitigation:** the existing keepalive infrastructure
   (`startKeepalive`/`stopKeepalive` referenced in
   `maintenanceScheduler.js`) — confirm it's already active during
   `runMaintenanceScan` and stays active across the streaming
   sweep. The note "Note: Keepalive is always-on, no need to
   start/stop" at maintenanceScheduler.js:796 suggests it is, but
   verify by tracing the call site.

4. **Account-liveness divergence.** Old maintenance Phase 1.5
   walked ALL entries to gather accounts; streaming gathers them
   incrementally. Difference: streaming might validate some entries
   for account X before reaching the first entry of account Y. If
   Y is unavailable, no change — Y's entries are still skipped.
   If X is unavailable but X-cached-as-available is checked first,
   no change either. So the incremental approach should produce
   the same skip set, just at a different time. **Test this** with
   a fixture where account-liveness changes mid-sweep.

5. **Progress reporting model.** Old code logged per-batch progress
   lines for monitoring long scans. New code logs only at start /
   complete + the `onProgress` callback every 100 entries. The
   maintenance scheduler currently doesn't pass `onProgress`;
   decide whether to wire one through for diagnostics or drop the
   per-batch logging entirely. **Recommendation:** wire a
   per-1000-entries progress log via `onProgress` from the
   maintenance side.

6. **Removed-details fan-out.** Old code logged each `removing`
   msgId via `logFtsOperation` before calling `removeBatch`.
   Streaming version does the same. Verify the event volume is
   acceptable when `entriesToRemove.length` is large (e.g., 5000
   stale entries → 5000 `maintenance_remove` log events). If too
   noisy, collapse to a summary event.

## Implementation steps

1. **Create `fts/staleSweep.js`** with `streamingStaleSweep`.
   Includes the incremental account-liveness cache and the
   namespace-parameterised event logging.
2. **Add tests for `streamingStaleSweep`** — copies of the
   reconcile Phase 2 tests, rewritten to import the shared helper
   directly. Plus the new long-run test (30k synthetic entries).
3. **Migrate `_reconcileCleanupStaleEntries`** to a one-liner
   delegating to the helper. Existing reconcile tests should keep
   passing unchanged.
4. **Migrate `cleanupMissingEntries`** to a wrapper around the
   helper. Delete the old Phase 1 / 1.5 / 2 / 3 code. Update
   existing maintenance tests.
5. **Delete dead constants:** `SETTINGS.ftsCleanup` in
   `agent/modules/config.js`; `RECONCILE_QUERY_CHUNK_SIZE` and
   `RECONCILE_ENTRY_DELAY_MS` in `incrementalIndexer.js`.
6. **Long-run validation.** Run a manual 30k-entry sweep against a
   live profile and confirm:
   - No native messaging disconnects
   - No service worker suspension mid-run
   - Total wall time consistent with `entries × 10ms`
7. **Companion files updated:** DECISIONS.md adds an ADR for the
   shared validator (or extends the watermark ADR); TESTS.md adds
   the new test entries; PROJECT_MEMORY.md notes the shared
   helper location.

## Test plan

In `test/fts/staleSweep.test.js` (new file):

1. **Empty range** → `{ checked: 0, removed: 0, accountsSkipped: 0 }`.
2. **All entries present in TB** → checked > 0, removed === 0.
3. **All entries stale** → all in `entriesToRemove`, `removeBatch`
   called once with the full list.
4. **Mixed present + stale** → only stale msgIds in remove batch.
5. **One account unavailable** → that account's entries skipped,
   `accountsSkipped === 1`, others processed normally.
6. **Account becomes available mid-sweep** (cache-warmup test):
   first call returns unavailable, cache holds, later entries from
   the same account skipped consistently.
7. **`parseUniqueId` returns null** → entry counted in `checked`,
   skipped silently.
8. **`headerIDToWeID` throws** → entry counted, logged as
   `error_skipped`, NOT added to remove list.
9. **`removeBatch` throws** → swallow, log; return `removed: 0`
   even though `entriesToRemove.length > 0` (same as today).
10. **Cursor advances correctly** when chunks return exactly
    `chunkSize` entries (boundary case).
11. **Cursor terminates** when chunk smaller than `chunkSize`.
12. **`onProgress` invoked** every 100 entries.
13. **Long-run** — synthesize 5000+ entries, verify wall time
    ≈ `5000 × 10ms = 50s` (with some slack for the async overhead).

Plus regression-only tests on the call sites:

- `_reconcileCleanupStaleEntries` returns same shape as before
  (verified by existing reconcile tests).
- `cleanupMissingEntries` returns `{ processed, removed, ... }` —
  same shape, verified by existing maintenance tests.

## Companion file updates on landing

- `tabmail-thunderbird/DECISIONS.md` — extend the watermark ADR (or
  add a sibling ADR) covering the shared streaming validator: why
  collect-all is wasteful, why streaming + per-entry yield works,
  why the all-entries account pre-scan was redundant.
- `tabmail-thunderbird/PROJECT_MEMORY.md` — note the shared helper
  location (`fts/staleSweep.js`) and that both reconcile and
  maintenance call into it.
- `tabmail-thunderbird/TESTS.md` — add the new `staleSweep` test
  entries.

## Implementation status

- [ ] `PLAN_RECONCILE_WATERMARK.md` landed (prerequisite)
- [ ] Plan reviewed
- [ ] `fts/staleSweep.js` created with `streamingStaleSweep`
- [ ] Tests for `streamingStaleSweep` added
- [ ] `_reconcileCleanupStaleEntries` migrated to delegate
- [ ] `cleanupMissingEntries` migrated to delegate; old phases
      deleted
- [ ] Dead constants removed (`SETTINGS.ftsCleanup`,
      `RECONCILE_QUERY_CHUNK_SIZE`, `RECONCILE_ENTRY_DELAY_MS`)
- [ ] Long-run validation (30k entries) passes without native
      disconnect or worker suspension
- [ ] git-log audit on the 200ms→50ms change history; documented
      decision to go to 10ms
- [ ] DECISIONS.md + PROJECT_MEMORY.md + TESTS.md updated

## Follow-ups beyond this plan

- **Let maintenance scans advance the watermark's `fromMs`.** Once
  the shared helper is in place and maintenance is using it,
  successful weekly scans verify a wider window than reconcile does,
  so they're in a position to pull the watermark's `fromMs`
  backwards (extending verified coverage). Out of scope here.
- **Per-tier `entryDelayMs` tuning.** If the long-run test shows
  10ms is too aggressive for the 30k-entry case but fine for the
  3k-entry case, plumb `entryDelayMs` through as a per-call option
  rather than the single default. Defer until evidence demands it.
