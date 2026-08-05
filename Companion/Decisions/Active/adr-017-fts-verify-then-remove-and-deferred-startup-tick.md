# ADR-017: FTS Stale-Entry Removal Requires Verify-Then-Remove; Startup Maintenance Tick Deferred Behind Sync Quiet Period

> Routed out of `DECISIONS.md` § ADR-017 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** The 2026-06-03 weekly maintenance scan removed a live
`[Gmail]/Bin` message from FTS as `removedMissing`; the 2026-06-09 scan
re-indexed it at the *identical* key — proof of a false-positive removal that
left the email missing from search for six days. Mechanism: both
`cleanupMissingEntries` (maintenance) and `_reconcileCleanupStaleEntries`
(boot reconcile Phase 2) decided "stale" from a single folder-constrained
`messages.query` returning empty, which happens transiently while a folder's
msgDB is mid-sync (TB startup, compaction, IMAP resync of rarely-opened
folders like Bin). Compounding it, `initMaintenanceScheduler` ran a due scan
*immediately* at TB launch (`runScheduledMaintenanceTick("startup")`) — the
exact window where boot reconcile already refuses to run (its 60s quiet
period exists for this same race), and the account-liveness check is
account-granular (≥1 queryable folder), offering no per-folder protection.

**Decision:**
1. **Verify-then-remove everywhere FTS entries are removed for "missing".**
   A failed folder-constrained lookup only nominates a *candidate*. Before
   removal, each candidate is re-checked with a fresh GLOBAL
   `messages.query({ headerMessageId })` (`recheckMessageInFolder` in
   `agent/modules/utils.js`): found in the expected account+folder →
   **keep** (transient miss); query succeeded but not found there →
   **remove** (a copy elsewhere doesn't make the folder-scoped key valid);
   query threw → **keep** (never remove on uncertainty; next scan retries).
   Mirrors the PMQ verify-then-drop pattern (2026-05-27).
2. **Defer the startup maintenance tick behind the sync quiet period and
   boot reconcile.** `_scheduleStartupTickWhenQuiet` polls every 10s until
   no sync events for 60s (via `getLastSyncEventMs()`) AND
   `isReconcilePending()` is false, hard-capped at 10 min. At the cap the
   tick runs only when reconcile is done (merely-never-quiet busy mailbox);
   if reconcile is still pending — including a reconcile that failed
   without clearing its flag — the startup tick is skipped and the hourly
   alarm is the due-ness backstop.

**Rationale:**
- A single empty query result is indistinguishable from a mid-sync snapshot;
  only a second successful query carries removal-grade evidence. The recheck
  is also time-separated from the first miss (Phase 2.5 runs after the whole
  validation pass), letting transient states settle.
- The quiet period already existed for reconcile with an explicit comment
  describing this race; maintenance lacked it only because the scans predate
  it. Reusing the same signal keeps one definition of "TB is still syncing".

**Consequences:**
- One extra global `messages.query` (all continuation pages drained — a
  partial auto-paginated first page is NOT proof of absence) per stale
  candidate. Cheap in the steady state (single-digit candidates), but a
  mass-deletion boot (e.g., a multi-thousand-message Trash emptied while TB
  was off) performs one full-profile enumeration per candidate — the scan
  gets slow, which is accepted: it is a background task, both recheck loops
  ping the native FTS host (`ftsSearch.stats()`) on the validation-batch
  cadence so the connection survives, and any Phase 2-LEVEL failure — a
  thrown FTS scan/pagination call or a failed `removeBatch` — blocks the
  reconcile watermark advance (`removeFailed`) so coverage is never claimed
  for verification that didn't happen. Likewise on the ADD side: a thrown
  Phase 1 enqueue (`enqueueFailed > 0`) means a boot-gap message never
  reached the persistent drain queue and also blocks the advance (once
  enqueued, the queue's own persistence + retry guarantees take over). The
  one Phase 1 non-blocker: `queueMessageUpdate`'s silent no-unique-key skip
  — a message that cannot derive a key can never be stored in the
  key-addressed FTS, so blocking on it would pin the window forever.
  Per-entry carve-outs that keep their entry WITHOUT blocking the
  watermark: a per-entry validation throw (`error_skipped`) and an errored
  recheck (`recheck_error`) — see the next bullet for the rationale.
- `recheck_error` keeps the entry but deliberately does NOT block the
  watermark advance: a permanently-erroring entry must not pin the
  watermark (and the window) forever. Cost: an errored-recheck entry whose
  message date is older than 3 weeks can only be cleaned by the (default
  -disabled) monthly scan. Accepted — error verdicts are rare and
  non-destructive.
- Genuinely-deleted messages are still removed (recheck confirms absence);
  externally-moved messages still get their old-folder key removed.
- Periodic (non-startup) ticks are unchanged — verify-then-remove protects
  those paths; only the startup tick gets the quiet-wait. At the 10-min cap
  the startup tick runs only if reconcile is no longer pending; if reconcile
  is still pending at cap, the startup tick is skipped entirely (hourly
  alarm is the backstop) rather than racing it. A stale
  `fts_reconcile_pending` flag cannot stall boots where incremental
  indexing is disabled (`isReconcilePending` returns false when disabled).
- **Weekly-window slip (accepted):** the old code ran a due weekly scan
  immediately at boot; the deferral (≥60s, up to 10 min, or a cap-skip)
  can push it past the configured Wed 9–12 window, slipping it to the next
  week since daily/hourly are off by default. Bounded cost (stale entries
  linger ≤1 extra week; boot reconcile still covers the boot gap), and
  running heavy scans outside the user's configured window was judged
  worse than the slip.
- **Inert quiet-signal configs:** with incremental indexing off — or with
  it on but the tmMsgNotify experiment API unavailable (WebExtension-events
  -only fallback) — no listeners update the sync-quiet signal, so the
  startup deferral degrades to a fixed ~60–70s delay. Verify-then-remove is
  the operative protection in those configurations.
- Does NOT address the structural date-window blind spot (reconcile windows
  are keyed by message Date header, not change time; externally-deleted
  messages sent >3 weeks ago are never cleaned while monthly scans stay
  disabled). That would need an `indexedAt`/`verifiedAt` column in native
  FTS — out of scope here.
<!-- END PRESERVED BLOCK -->
