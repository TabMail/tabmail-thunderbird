# Boot-cycle reconcile watermark

> **Status:** Plan / pre-implementation. Captured 2026-05-15 from the
> investigation of `tabmail_event_log_2026-05-15T16-18-13-464Z.json`,
> which showed the weekly maintenance scan removing 11 stale FTS
> entries that the boot reconcile should have caught.
>
> **Scope:** Boot cycle ONLY. The drop we're chasing is a single
> well-defined gap: between TB shutdown and the next TB boot's
> reconcile completing, server-side state can diverge from FTS, and
> the current boot reconcile fails to re-verify the right window.
>
> Runtime drift (TB running for days, listener silently dropping an
> event) is **out of scope** for this plan. The existing daily /
> weekly maintenance scans (`fts/maintenanceScheduler.js`) catch that
> path today — they're inefficient, which is exactly why we need boot
> reconcile to be the primary correctness mechanism so the periodic
> scans become a true belt-and-suspenders rather than the load-bearing
> safety net.

## The drop, precisely

`fts/incrementalIndexer.js` boot flow:

1. `initIncrementalIndexer(ftsSearch)`
2. `restorePendingUpdates()` — replays persisted in-flight ops from
   prior session.
3. `setupExperimentListeners()` — `tmMsgNotify.onMessageAdded` /
   `onMessageRemoved` are **live from this point on**. New IMAP sync
   discoveries start flowing into `_pendingUpdates`.
4. `_scheduleReconcileWhenQuiet()` — sets a 60s quiet-period timer.
   During this wait, the listener keeps firing, `_pendingUpdates`
   drains, FTS gets new rows.
5. After 60s of quiet, `runPostInitReconcile(ftsSearch)`:
   1. `_getReconcileFrom(ftsSearch)` — queries FTS for newest dateMs,
      returns `newest - 1 day`. **This is where the contamination
      lives.**
   2. Phase 1: `browser.messages.query({fromDate: reconcileFrom})`,
      enqueue each as `'new'`. Drain loop indexes anything FTS
      doesn't already have.
   3. Phase 2: `_reconcileCleanupStaleEntries(ftsSearch,
      reconcileFromMs)` — walks FTS entries with dateMs in that same
      window, calls `headerIDToWeID` to verify the message still
      exists in TB at its indexed folder, removes the ones that don't.

The semantic the code wants Phase 2 to enforce is **"for all FTS
entries dated in `[reconcileFrom, now]`, FTS state is consistent with
IMAP."**

The semantic `_getReconcileFrom` actually computes is **"how new is
our newest FTS entry, minus a day of overlap"** — a forward-looking
freshness signal being used as a backward-looking verification
watermark. They are different quantities. The drop we're chasing
falls in the gap between them.

On the 2026-05-13 resume (after 15 days of TB not running):

- The 60s quiet wait elapsed without ever being quiet long enough?
  Actually it eventually fired — the log shows `reconcileFrom:
  2026-05-12T16:12:08` for the first run.
- That value implies "newest FTS row at the moment `_getReconcileFrom`
  ran was dated 2026-05-13T16:12:08." Which means the listener
  already indexed at least one 2026-05-13 message during the quiet
  wait.
- So Phase 2's window was 2026-05-12 16:12 → now. ~1 day.
- The 11 stale entries had message dates 2026-05-04 through
  2026-05-11 (Gmail Bin auto-purges, etc., that happened during the
  15-day offline window). All outside Phase 2's window. Untouched.
- Weekly maintenance scan on 2026-05-13T16:08 (which uses a much
  wider date range) caught them and emitted `maintenance_stale` →
  `maintenance_remove`.

The log shows zero `fts:onMessageDeleted` / `fts:onMessageMoved` for
any of the 11 — TB's IMAP sync on resume didn't surface them as
deletions to the experiment listener at all. Plausibly the server
state was already "this UID never existed for you" by the time TB
asked. That's a TB/IMAP concern we don't try to fix here. The boot
reconcile is supposed to be the catch-all for exactly that class of
drop — and right now it isn't.

## Design

### Persistent watermark

One key in `browser.storage.local`, system-wide (not per-account):

```js
fts_reconcile_watermark: {
  version: 1,
  fromMs:        <int>,  // 'from' bound of the last successfully
                         //   completed reconcile (Phase 1 + Phase 2
                         //   both clean, no skipped accounts)
  completedAtMs: <int>,  // wall-clock when that reconcile finished
}
```

Semantics: **"At `completedAtMs`, FTS was verified consistent with
IMAP for all messages dated ≥ `fromMs`."**

Per-system is correct because the drop is system-wide: TB boots once,
all accounts come online together. A flaky account stalls the whole
watermark advance, which is the conservative behavior we want (we'd
rather re-verify the whole window next boot than mark the flaky
account "verified" on incomplete evidence).

### Window computation

The fix is **minimal**: drop the FTS-date dependency entirely.
`_getReconcileFrom` no longer queries FTS — it just reads the
persistent watermark (or returns a 7d fallback if there isn't one
yet). The FTS-flakiness retry loop goes away too: there's nothing to
retry.

```js
const WATERMARK_KEY = "fts_reconcile_watermark";
const ONE_DAY = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_FALLBACK_MS = 7 * ONE_DAY;

async function _getReconcileFrom() {
  const now = Date.now();
  const stored = await browser.storage.local.get(WATERMARK_KEY);
  const wm = stored?.[WATERMARK_KEY];

  if (!wm
      || typeof wm.completedAtMs !== "number"
      || typeof wm.fromMs !== "number"
      || wm.completedAtMs <= 0                 // negative / zero — corrupt
      || wm.completedAtMs > now + ONE_DAY) {   // future-dated → clock skew
    // Missing / corrupt / future-dated → first-run-style fallback.
    log(`[FTS Reconcile] No usable watermark; using 7d fallback`);
    return now - SEVEN_DAYS_FALLBACK_MS;
  }

  return wm.completedAtMs - ONE_DAY;
}
```

Computed **once** at the top of `runPostInitReconcile`, captured into
`reconcileFrom`, and both Phase 1 and Phase 2 use the captured value.
(Already the existing pattern — we're not adding a new race.)

Note: this removes `ftsSearch` from the function signature. Callers
just call `_getReconcileFrom()`. The old retry-with-backoff scaffold
(`RECONCILE_MAX_RETRIES`, `RECONCILE_INITIAL_DELAY_MS`,
`RECONCILE_MAX_DELAY_MS`) becomes dead code and is removed.

**First-deploy behavior:** users running this for the first time
have no watermark, so the first boot reconciles a 7-day window.
After that boot completes, the watermark is established and all
subsequent boots use it. There is no migration step. Anything stale
older than 7 days at first-deploy time still gets caught by the
weekly maintenance scan — same safety net as today.

### Watermark write rules

After `runPostInitReconcile` reaches the bottom of its `try` block
without an exception, AND `cleanupResult` indicates Phase 2 didn't
skip due to unavailable accounts, write:

```js
await browser.storage.local.set({
  [WATERMARK_KEY]: {
    version: 1,
    fromMs: reconcileFrom,
    completedAtMs: Date.now(),
  },
});
```

**Skip the write** if:

- Phase 2 threw and was caught by `runPostInitReconcile`'s outer
  `catch` (we already log `reconcile error` there).
- `_reconcileCleanupStaleEntries` had `unavailableAccounts.size > 0`
  (it already logs `reconcile_stale accounts_unavailable`; we need
  to propagate this signal up — see "Plumbing changes" below).
- Phase 1 threw (currently caught per-message; if the outer `try`
  rethrows, same as above).

Skipping leaves the watermark pointing at the previous
`completedAtMs`. Next boot recomputes a window from that older
timestamp → wider window → retries the verification.

### Watermark advance during runtime (heartbeat)

Without a runtime advance, the watermark freezes at the last boot's
completion time. A TB-on-7d-then-off-2d scenario would force a 9-day
reconcile on next boot instead of the 3-day reconcile we actually
need.

**The two fields advance on different signals:**

- **`fromMs`** is the lower bound of a window that was actually
  re-verified by Phase 2. It only changes when a full boot reconcile
  runs and writes a new fromMs. Runtime never advances it.
- **`completedAtMs`** is "we still believe consistency holds, as of
  this wall-clock time." Phase 2 establishes it at boot. During
  runtime, a heartbeat creeps it forward.

The runtime advance trusts the listener: every minute the experiment
listener is healthy is another minute where we can attest "FTS is
still consistent for messages dated ≥ fromMs." This is exactly the
trust model already stated for the scope of this plan ("our drop ONLY
happens in the boot cycle"). If runtime drops do occur, the existing
daily/weekly maintenance scans catch them, same as today.

**Heartbeat implementation** (interval: 10 min — small enough that
the offline-gap penalty is bounded, large enough that storage churn
is negligible: ~4 writes/hour):

```js
const HEARTBEAT_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let _watermarkHeartbeatTimer = null;
// Disposal flag — heartbeat checks this AFTER its storage read, before
// the write. A dispose() that fires between the read and the write
// would otherwise let a pending heartbeat write stale data into the
// freshly-cleared state. Reset to false in init.
let _indexerDisposed = false;

async function _heartbeatBumpWatermark() {
  if (!_isEnabled || !_experimentListenersActive || _indexerDisposed) return;

  // Drain-stall guard: if pending updates are sitting unprocessed,
  // the listener fired but the queue isn't draining. Heartbeat
  // would falsely claim "all consistent" while events sit pending.
  if (_pendingUpdates.size > 0) {
    const oldestTs = Math.min(
      ...Array.from(_pendingUpdates.values()).map(u => u.timestamp)
    );
    if (Date.now() - oldestTs > HEARTBEAT_INTERVAL_MS * 2) {
      log("[FTS Heartbeat] Skipped: drain stalled");
      return;
    }
  }

  const stored = await browser.storage.local.get(WATERMARK_KEY);
  const wm = stored?.[WATERMARK_KEY];

  // Refuse to *create* a watermark — only boot reconcile may do that.
  // If no watermark exists yet, the heartbeat is a no-op.
  if (!wm || typeof wm.fromMs !== "number") return;

  // Re-check disposal AFTER the async read but BEFORE the write —
  // a dispose() that ran during the read should not lose to a stale
  // heartbeat write.
  if (_indexerDisposed) return;

  await browser.storage.local.set({
    [WATERMARK_KEY]: {
      version: 1,
      fromMs: wm.fromMs,           // unchanged
      completedAtMs: Date.now(),   // creeps forward
    },
  });
}
```

**Lifecycle:**

- Started by `runPostInitReconcile` immediately after writing the
  successful-completion watermark. Not before — heartbeat firing
  during reconcile could write a `completedAtMs` claiming consistency
  while Phase 2 is actively finding stale entries.
- Stopped in `disposeIncrementalIndexer` (alongside the other timer
  cleanups).
- Single timer per indexer instance; defensively `clearInterval` and
  re-set if the indexer is re-initialized.

**Resulting timeline for the on-7d-then-off-2d scenario:**

```
T0   boot, reconcile completes → wm = {fromMs:T0-1d, completedAtMs:T0}
T0..T7d  heartbeat (×~1000) → completedAtMs creeps to ≈T7d
T7d  TB shutdown, wm persisted with completedAtMs ≈ T7d
T9d  TB boots → reconcileFrom = (T7d - 1d) = T6d
     Phase 2 window = (T6d, T9d) ≈ 3 days. ✓
```

**What runtime advance explicitly does NOT do:**

- Does not bump the watermark from the listener's per-message
  success path. The watermark would claim more than the listener
  actually verifies.
- Does not advance `fromMs`. Only Phase 2 has the standing to do
  that, because only Phase 2 re-iterates FTS entries against IMAP.
- Does not run during boot reconcile. Heartbeat starts after Phase 2
  completes successfully.
- Does not synthesize a watermark when none exists. A fresh install /
  cleared storage stays unwritten until boot reconcile establishes
  it.

## Plumbing changes

1. **`_reconcileCleanupStaleEntries` return shape.** Currently
   `{ checked, removed }`. Add `accountsSkipped: <int>` (the size of
   `unavailableAccounts`). Caller uses this to gate the watermark
   write. Existing log lines already record this internally; just
   surface it on the return value.

2. **`runPostInitReconcile` clean-completion gate.** Today it does:
   ```js
   const cleanupResult = await _reconcileCleanupStaleEntries(...);
   await browser.storage.local.remove(RECONCILE_STORAGE_KEY);
   ```
   becomes:
   ```js
   const cleanupResult = await _reconcileCleanupStaleEntries(...);
   const clean = cleanupResult.accountsSkipped === 0;
   if (clean) {
     await browser.storage.local.set({
       [WATERMARK_KEY]: {
         version: 1,
         fromMs: reconcileFrom,
         completedAtMs: Date.now(),
       },
     });
   }
   await browser.storage.local.remove(RECONCILE_STORAGE_KEY);
   ```
   The `RECONCILE_STORAGE_KEY` (the "reconcile pending" flag) still
   clears unconditionally — its purpose is "did reconcile run at
   all," not "did it advance the watermark." The watermark is the
   new correctness signal.

3. **No changes to** the quiet-period scheduler, the experiment
   listeners, the drain loop, or `_reconcileCleanupStaleEntries`'s
   internal cursor logic. Window contents are still
   `queryByDateRange(reconcileFromMs, now)` — we're only changing
   what `reconcileFromMs` resolves to.

## Race & pitfall audit

| Scenario | Behavior under proposed design |
|---|---|
| Listener indexes new mail during the 60s quiet wait | `ftsFreshFrom` shrinks (current bug), but `watermarkFrom` from previous session is independent of FTS state, so `min(ftsFreshFrom, watermarkFrom)` still covers the gap. **The fix.** |
| First boot ever (no watermark) | Watermark missing → 7d fallback. Same as today's empty-FTS path. |
| Watermark corrupted / wrong schema version | Treated as missing → 7d fallback. Verified by the `typeof` guards. |
| Clock moved backwards (future-dated watermark) | Future-dated → treated as missing → 7d fallback. Logged. |
| Phase 2 throws | Watermark NOT written → next boot recomputes from older `completedAtMs` → wider window. |
| One account unavailable | `accountsSkipped > 0` → watermark NOT written → next boot retries. |
| TB restarts back-to-back (fast cycle) | 2nd boot reads watermark from a few minutes ago → narrow window → cheap reconcile. Same as today's behavior in that case. |
| 30/90/200-day offline | Watermark from 30/90/200d ago → 30/90/200d window. Expensive but correct. No floor by design. |
| `browser.storage.local.set` throws | Watermark not advanced → next boot recomputes from previous watermark. No correctness loss; just one extra reconcile cycle of the same window. |
| Phase 1 races with concurrent listener events | Already handled by `acquireEnqueueMutex` and FTS dedup. Unchanged. |
| Two concurrent reconcile runs (shouldn't happen, but defensive) | `_scheduleReconcileWhenQuiet` clears `_reconcileQuietTimer` on each call. Quiet-period scheduler enforces single execution. If somehow two ran, both would write the watermark; last-writer-wins is safe — both encode true facts. |

## Performance

`_reconcileCleanupStaleEntries` chunks FTS reads at 200 entries
(`RECONCILE_QUERY_CHUNK_SIZE`) and yields 10ms between entries
(`RECONCILE_ENTRY_DELAY_MS`). Plus a keepalive `ftsSearch.stats()`
per batch.

Rough budget for a window of N days at K msgs/day:

| Days offline | Entries to check | Wall time (10ms each) |
|---|---|---|
| 1 | ~500 | ~5s |
| 7 | ~3,500 | ~35s |
| 30 | ~15,000 | ~2.5m |
| 90 | ~45,000 | ~7.5m |
| 365 | ~180,000 | ~30m |

All run in the MV3 background script after the 60s quiet period, so
they don't block UI. The keepalive pings prevent service-worker
suspension during long runs. If long-offline reconciles turn out to
be a real product concern (vs. a once-per-vacation event), we can
parallelize the `headerIDToWeID` lookups — but that's a perf follow-
up, not a correctness one.

## Tests

New file `test/fts/reconcileWatermark.test.js` (or extend an existing
incrementalIndexer test). All Vitest, mock `browser.storage.local`
and a stub `ftsSearch`.

1. **No watermark + empty FTS** → returns `now - 7d`.
2. **No watermark + FTS newest 1h ago** → returns `(newest - 1d)`,
   approximately `now - 25h`.
3. **Watermark 5 min old + FTS newest 1h ago** → returns
   `min(watermark.completedAt - 1d, newest - 1d)` ≈ `now - 25h`.
4. **Watermark 15 days old + FTS newest 1h ago** → returns
   `watermark.completedAt - 1d` ≈ `now - 16d`. **(regression for the
   May 2026 incident).**
5. **Watermark future-dated by 2 days** → returns 7d fallback.
6. **Watermark with `version: 2` (unknown)** → treated as missing →
   7d fallback. (Defensive even though we don't have v2 yet.)
7. **Watermark with `fromMs` non-numeric** → 7d fallback.
8. **Watermark 200 days old** → returns `now - 201d`. No floor.
9. **Clean reconcile completion** writes a watermark with
   `fromMs === reconcileFrom`, `completedAtMs ≈ now`.
10. **Phase 2 throws** → watermark NOT written. Storage key
    unchanged.
11. **`accountsSkipped > 0`** → watermark NOT written.
12. **Integration:** simulate `setupExperimentListeners` firing an
    `onExperimentMessageAdded` during the quiet wait that advances
    `ftsSearch`'s newest dateMs to "now", verify that
    `_getReconcileFrom` STILL returns the watermark-derived value,
    not the FTS-derived one. This is the bug repro.

### Heartbeat tests

13. **Heartbeat with no watermark stored** → no-op (refuses to
    create one).
14. **Heartbeat with listener inactive** → no-op.
15. **Heartbeat with `_isEnabled = false`** → no-op.
16. **Heartbeat with valid watermark + healthy queue** → writes new
    `completedAtMs ≈ Date.now()`, leaves `fromMs` unchanged.
17. **Heartbeat with pending update older than `2 ×
    HEARTBEAT_INTERVAL_MS`** → no-op (drain-stall guard).
18. **Heartbeat with pending updates all fresh** → writes
    (transient queue is normal, not a fault).
19. **Heartbeat across the 7d-on / 2d-off scenario** (advance fake
    timers): after 7d of heartbeats, simulate dispose + 2d gap +
    re-init; assert `_getReconcileFrom` returns ≈ `now - 3d`.
20. **Heartbeat does not run during boot reconcile**: assert
    `_watermarkHeartbeatTimer === null` before `runPostInitReconcile`
    sets it, and that it is set only after the successful-completion
    branch.

Also reproduce the actual May 2026 scenario as a fixture:

- Seed watermark `{ completedAtMs: 2026-04-28T05:00Z }`.
- Stub `ftsSearch.queryByDateRange` to return a 2026-05-13 entry as
  newest (as the listener would have produced).
- Call `_getReconcileFrom`.
- Assert returned timestamp ≤ 2026-04-27T05:00Z (i.e., the window
  covers the offline gap).

## Companion files to update on landing

- `tabmail-thunderbird/DECISIONS.md` — new ADR for the watermark:
  what it replaces (FTS-newest as window source), the semantic
  distinction (forward-looking freshness vs backward-looking
  verification), and why no sanity floor.
- `tabmail-thunderbird/PROJECT_MEMORY.md` — short note in the FTS
  section: where the watermark lives, what advances it, that the
  listener does NOT advance it (deliberate).
- `tabmail-thunderbird/TESTS.md` — add the new test cases above.

## Weekly maintenance vs boot reconcile: why one is faster

Side-by-side of the two stale-cleanup paths, both calling the same
`headerIDToWeID` per-entry primitive against TB:

| Aspect | Boot reconcile Phase 2 (`_reconcileCleanupStaleEntries`) | Weekly maintenance (`cleanupMissingEntries`) |
|---|---|---|
| Iteration shape | **Streaming**: fetch a chunk, validate inline, advance cursor | **Three-phase**: collect-all → validate-batched → remove-batched |
| Memory footprint | ~200 entries at a time (one chunk) | All entries in the window held in `allEntries[]` |
| Query chunk size | 200 (`RECONCILE_QUERY_CHUNK_SIZE`) | 500 (`ftsCleanup.queryChunkSize`) |
| Per-entry yield | **10ms** (`RECONCILE_ENTRY_DELAY_MS`) | **50ms** (`ftsCleanup.entryDelayMs`) — 5× slower |
| Per-batch yield | None (only per-entry) | 100ms after every 50 entries (`batchDelayMs`) |
| Keepalive ping | None — every `headerIDToWeID` is itself an `await` hitting TB, keeping the worker warm | `ftsSearch.stats()` after every 50 entries |
| Account-liveness pre-check | First chunk only | Walk **all** collected entries first to gather account set |
| Removal | Single `removeBatch(entriesToRemove)` at the end | Chunked: 100 per batch with `batchDelayMs` between |
| Progress logging | One line per chunk | Per-batch progress lines |

For a representative 30k-entry weekly window, the per-entry delay
alone costs `30000 × 50ms = 25 min`, vs `30000 × 10ms = 5 min` for
the reconcile pattern. Add the collect-all Phase 1 (60 chunks ×
~100ms = 6s pre-roll plus the memory cost), the all-entries account
scan, and the per-batch yields, and the weekly scan is 5–6× slower
than it needs to be.

### Where the speedup goes

The full refactor — extract a shared `fts/staleSweep.js` helper,
migrate both reconcile and maintenance to call it, drop the dead
`SETTINGS.ftsCleanup` block — is captured in
**`PLAN_MAINTENANCE_SCAN_SPEEDUP.md`** as a follow-up. That plan
depends on this one landing first (it touches
`_reconcileCleanupStaleEntries`, which this plan modifies for the
`accountsSkipped` return value).

## What this plan deliberately doesn't address

- **Periodic-runtime drift.** The daily/weekly maintenance scans in
  `fts/maintenanceScheduler.js` continue to be the safety net for
  listener events dropped while TB is running. Making those scans
  cheaper by adopting the streaming pattern (see the comparison
  section above) is a follow-up plan.
- **Maintenance advancing `fromMs`.** Once the weekly scan is
  refactored to share the streaming validator, it would be in a
  position to advance `fromMs` (not just `completedAtMs`) since it
  re-verifies a wider window than reconcile. Out of scope here for
  the same reason — land the minimal boot fix first.
- **TB IMAP not emitting `msgsDeleted` on resume.** Likely a real bug
  but lives in TB / the experiment, not the indexer. Documenting it
  as the failure mode that motivated this fix is enough for now.
- **Per-account isolation.** Boot is system-wide; reconcile is
  system-wide; watermark is system-wide. If we ever find a use case
  where one account's reconcile failure should not block another's
  watermark advance, revisit then.

## Implementation status

- [x] Plan reviewed
- [x] `_getReconcileFrom` rewritten: reads watermark only (no FTS
      query, no retry loop); 7d fallback for missing/corrupt/future.
      Guards tightened to `Number.isFinite` (catches NaN/Infinity)
      during test development.
- [x] Dead code removed: `RECONCILE_MAX_RETRIES`,
      `RECONCILE_INITIAL_DELAY_MS`, `RECONCILE_MAX_DELAY_MS`.
      `RECONCILE_FALLBACK_WINDOW_MS` and `RECONCILE_OVERLAP_MS`
      kept as named constants (used directly).
- [x] `_reconcileCleanupStaleEntries` returns `accountsSkipped`
- [x] `runPostInitReconcile` writes watermark on clean completion
      (Phase 2 clean + `accountsSkipped === 0`)
- [x] Heartbeat timer (`_heartbeatBumpWatermark`) added at 10 min,
      started after successful boot reconcile, cleared in dispose
- [x] Heartbeat drain-stall guard wired to `_pendingUpdates`
- [x] Hardening: `_indexerDisposed` flag, set early in dispose,
      re-checked in heartbeat after the async read
- [x] Hardening: `completedAtMs > 0` guard (catches corrupt zero
      or negative timestamps)
- [x] Tests added (boot reconcile + heartbeat) — 23 cases in
      `test/reconcileWatermark.test.js`
- [x] Existing test `ftsReconcile.test.js` updated for new return
      shape (`accountsSkipped: 0`)
- [x] Full test suite passes (113 files, 3,239 tests)
- [x] DECISIONS.md (ADR-016) + PROJECT_MEMORY.md updated
- [x] May 2026 regression fixture passes (15-day-old watermark →
      ~16-day reconcile window)

## Follow-up plans (not this fix)

- Refactor weekly maintenance to use the streaming-cursor pattern
  (lift shared helper from `_reconcileCleanupStaleEntries`); drop
  `entryDelayMs` from 50ms to 10ms; remove per-batch
  `ftsSearch.stats()` keepalive. See the comparison section above.
- Once the weekly scan shares the streaming validator, let it
  advance `fromMs` (not just `completedAtMs`) so the watermark
  reflects the wider window the weekly verifies.
