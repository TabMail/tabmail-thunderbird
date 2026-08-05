# ADR-016 (second definition): Reconcile Window Bounded by Persistent Watermark, Not FTS-Newest Date

> Routed out of `DECISIONS.md` § ADR-016 (SECOND definition of the ADR-016 id in this file; routed as 016b, id preserved verbatim in the block) by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** The FTS boot reconcile (`fts/incrementalIndexer.js`,
`runPostInitReconcile`) is responsible for catching the gap between
TB syncing on startup and the experiment listener being registered.
Originally, `_getReconcileFrom` computed its window lower bound from
`max(FTS message dateMs) - 1 day`. The May 2026 incident log
(`tabmail_event_log_2026-05-15T16-18-13-464Z.json`) showed the
weekly maintenance scan cleaning up 11 stale entries that the boot
reconcile should have caught — messages dated 2026-05-04 through
2026-05-11 that were deleted server-side during a 15-day TB-offline
period and remained as stale FTS entries on resume.

Root cause: the FTS-newest date is a *forward-looking* freshness
signal ("how new is our data") being used as a *backward-looking*
verification watermark ("how far back have we re-verified that FTS
matches IMAP"). During the 60s quiet-period wait after listener
registration, the listener already indexes newly-arrived mail,
advancing `max(FTS dateMs)` to "today" — so `_getReconcileFrom`'s
window collapses to ~1 day regardless of how long TB was offline.

**Decision:** Replace the FTS-newest signal with a persistent
watermark stored in `browser.storage.local` under
`fts_reconcile_watermark`:

```
{ version: 1, fromMs: <int>, completedAtMs: <int> }
```

Semantics: *"At `completedAtMs`, FTS was verified consistent with
IMAP for all messages dated ≥ `fromMs`."* Boot reconcile reads
`(completedAtMs - 1 day overlap)` as the window lower bound. If no
watermark exists (first run / wiped storage / corrupt / future-dated),
fall back to 7 days.

Phase 2 of the boot reconcile writes the watermark on clean
completion (no exception, `accountsSkipped === 0`). A runtime
heartbeat (every 10 min while the listener is healthy) advances
`completedAtMs` forward — but never `fromMs`, and never *creates* a
watermark. The heartbeat trusts the listener for runtime correctness,
the same trust model that says "drops only happen at the boot
cycle"; periodic maintenance scans remain the safety net for
runtime listener drops.

**Rationale:**

- **The two signals are conceptually different.** FTS-newest tells
  us how recent our newest indexed message is; the watermark tells
  us how far back we've actively re-verified. Conflating them
  caused the boot-gap bug.
- **No sanity floor.** If TB was offline for 200 days, the next
  boot reconciles 201 days. Any cap (90d, 365d) would silently
  leave older drops uncorrected; FTS would become incoherent.
- **System-wide watermark, not per-account.** The boot gap is
  system-wide; if any account was unavailable during Phase 2, we
  conservatively don't advance the watermark at all (next boot
  retries with the same or wider window).
- **Heartbeat advances completedAtMs only, never fromMs.** Only
  Phase 2 has the standing to extend the verified lower bound,
  because only Phase 2 actually re-iterates FTS entries against
  IMAP. The heartbeat just attests that the listener has stayed
  healthy in the meantime.
- **Heartbeat refuses to *create* a watermark.** Synthesising one
  from a heartbeat would claim verification we never performed.
  Boot reconcile is the sole minter.
- **Defensive guards** (`Number.isFinite`, ≤0, future-dated → 1d
  ahead) fall back to the 7-day window on any corruption or clock
  skew. The heartbeat additionally re-checks an `_indexerDisposed`
  flag *after* its async storage read to prevent a pending
  heartbeat from clobbering freshly-cleared state.

**Consequences:**

- **Fixes the May 2026 regression.** A 15-day-old watermark
  produces a ~16-day reconcile window. The boot reconcile now
  catches what only the weekly maintenance scan caught before.
- **Removes the FTS-flakiness retry loop from `_getReconcileFrom`.**
  No FTS query → no need for `RECONCILE_MAX_RETRIES`,
  `RECONCILE_INITIAL_DELAY_MS`, `RECONCILE_MAX_DELAY_MS`. Code
  shrinks; `_getReconcileFrom` becomes a ~25-line storage read.
- **Runtime cost:** ~6 storage writes per hour from the heartbeat
  (negligible). One write per clean boot reconcile.
- **First-deploy migration:** users with existing FTS but no
  watermark get a one-time 7-day window on their first post-deploy
  boot. Anything stale older than that on day 1 still gets caught
  by the weekly maintenance scan (the safety net we always had).
- **Rollback:** code revert is clean (one file changed). The
  `fts_reconcile_watermark` storage key becomes harmless dead data
  if reverted.
- **Follow-up surfaced:** the weekly maintenance scan is 5–6×
  slower than the boot reconcile because it uses a collect-all
  three-phase pattern rather than streaming-cursor with 10ms
  per-entry yields. With boot reconcile now authoritative for the
  boot gap, the weekly scan can be refactored to share the
  streaming validator and become non-load-bearing. See
  `PLAN_MAINTENANCE_SCAN_SPEEDUP.md`.
<!-- END PRESERVED BLOCK -->
