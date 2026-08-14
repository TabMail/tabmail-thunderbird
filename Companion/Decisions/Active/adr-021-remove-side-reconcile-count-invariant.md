<!-- COMPANION-CURRENT-NOTE-BEGIN -->
> **2026-08-13:** Superseded by [ADR-022](adr-022-startup-uid-fts-membership-fingerprints.md). Cached folder counts and memoized count pairs do not prove membership equality; the preserved block remains byte-identical history.
<!-- COMPANION-CURRENT-NOTE-END -->
# ADR-021: Remove-Side Reconcile via Evidence-Triggered Per-Folder Count Invariant (No Date Windows, No Periodic Jobs)

> Routed out of `DECISIONS.md` § ADR-021 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** The remove side (external deletions while TB is off) relied on boot reconcile
Phase 2 — windowed by **message Date** from the watermark, blind to old-dated entries — and the
weekly maintenance scan (heavy, periodic, 3-week reach). The 07/02 weekly scan removed 6 stale
entries that boot reconcile could never see. Owner goals: no date windows, no periodic jobs,
work proportional to drift, works for arbitrarily old emails. The repeatedly-cited
`indexedAt`/`verifiedAt` native-FTS column was REJECTED (verification-by-attention-age is still
periodic scanning, plus a native schema migration).

**Decision:** Add reconcile **Phase 1c** (`_runFolderReconcile`, PLAN_FOLDER_SET_RECONCILE.md),
running after the cursor scan, independent of both the watermark and the cursor store. The
count invariant: with add-side completeness guaranteed (ADR-020 cursors + live events),
FTS-per-folder ⊇ msgDB-per-folder, so per folder `ftsCount > msgCount` ⟹ ghosts provably
exist; `msgCount > ftsCount` (drain-quiet) ⟹ missing adds; equal ⟹ sets equal ⟹ zero work.
- **Native (tabmail-native-fts ≥ 0.10.0):** two generic reader RPCs on the unsharded
  `message_ids` PK — `countMsgIdRange { startKey, endKey }` and paginated
  `listMsgIdRange { startKey, endKey, afterKey?, limit }`. NO schema change, NO msgId parsing
  host-side. The addon computes bounds: folder prefix `P = "<acct>:<path>:"`, `endKey =
  P[..-1] + ";"` (';' = ':'+1); subfolder keys sort before the parent's ':' boundary and are
  excluded. Feature-detected addon-side (one probe per session); old helpers → the phase
  no-ops, logged once (weekly scan remains those users' backstop).
- **Experiment (`tmMsgNotify`):** `getFolderCounts()` — every folder of every account (ALL
  server types, unlike getCursorFolders; local/POP participate in the remove side) via
  `folder.getTotalMessages(false)` (folder cache, no msgDB opens); `probeMessageIds(folderURI,
  ids)` — probes each id against `getMsgHdrForMessageID` (a hash index; TB's own set-diff
  trick) so the stale-finder needs NO msgDB enumeration.
- **Stale direction:** page `listMsgIdRange` → prefix-strip headerMessageIds (exact within the
  folder-scoped range; parseUniqueId would mis-split ':'-bearing folder paths) → probe →
  misses are CANDIDATES ONLY → each confirmed by the ADR-017 `recheckMessageInFolder`
  verify-then-remove (absent → remove; present/error → keep) → single `removeBatch` +
  per-key verify, stats() keepalive every 50 rechecks.
- **Missing direction (RESUMABLE BACKFILL, revised 2026-07-06):** sweeps msgDB keys ASCENDING
  from a persisted per-folder cursor (`missingBackfillKey` in the recon memo, 0 first time),
  resolving via `getMessageInfosForKeys` + `filterNewMessages` and enqueuing reported-new via
  `_enqueueNewFromInfo`. The cursor advances PER KEY (a mid-sweep budget stop never skips an
  un-enqueued key) and climbs to highWater ONCE per folder, then the add-side cursor scan owns
  everything after. Two shared per-run budgets bound the two costs: `scans` (cheap: keys
  examined, default 10000) to climb, `enqueues` (expensive: getFull body fetches, default 200)
  to heal. This REPLACES the original hard deficit cap (`FOLDER_RECON_MISSING_MAX_DEFICIT = 500`,
  which skipped large-deficit folders entirely and merely delegated them to the weekly scan) —
  so the add side no longer relies on the weekly scan for ANY folder, at any deficit size. The
  initial-scan-completion gate is retained (that is the real "don't fight the first full index"
  guard; the cap was never doing that job). Partial sweeps persist the cursor without a
  count-pair memo; reaching the top writes the count-pair and completes.
- **Memo:** `fts_folder_recon_memo` stores the `(msgCount, ftsCount)` pair after a clean pass
  (zero errors in both directions; recounted post-work). A memo hit costs one count RPC and
  does zero work — this also absorbs permanent per-folder bias (unindexable no-key messages).
  Any error → no memo write → retried next boot.
- **Drain-quiet gate:** folders with pending drain entries are skipped (counts in flux) and
  re-checked ONCE when the queue empties (`_maybeScheduleFolderReconRerun`, single-shot/boot).
- **Orphaned-prefix sweep** (folders deleted/renamed while off): only on count evidence
  (`totalAll = count("", "￿") > Σ per-folder counts`, and only when every reported folder was
  actually counted). Keys no existing folder's prefix covers — checked against BOTH the
  experiment's folder list AND an independent `browser.accounts.list(true)` walk (parse edge:
  ':'-in-folder-path keys are kept + logged) — are removed only after passing the same
  ADR-017 recheck.

**Rationale:** Counting a PK range is the cheapest possible drift detector (one RPC per folder
per boot, no msgDB opens), and the superset invariant makes "counts equal" a sound proof of set
equality — so steady-state boots do zero per-message work regardless of archive size or message
age. Verification moves from "scan periodically" to "act on evidence".

**Consequences:**
- Verification hierarchy: live events → boot count-check → folder-scoped set diff (on evidence)
  → weekly scan demoted to an off-by-default escape hatch (SEPARATE follow-up flips the
  default; maintenanceScheduler untouched in this change). The weekly scan still covers the
  narrow equal-counts coincidence (one ghost + one missing add in the same folder between
  checks — also maskable by a memo pair with identical net counts) and native-DB corruption.
- Native helper minor-bumped 0.9.1 → 0.10.0; the RPCs are generic key-range primitives
  (reusable beyond folder reconcile).
- Missing-direction passes memoize the pre-drain ftsCount, so the pair self-corrects on the
  next boot's count movement.
- `recheck_error` keeps the entry AND blocks the memo (unlike the watermark, which
  deliberately advances past recheck errors) — a per-folder memo can afford to retry next
  boot without pinning anything global.
- The orphan sweep's recheck is stricter than the plan required (plan: confirm folder absent →
  removeBatch); rechecking each key too costs one global query per orphan key but keeps ONE
  removal bar everywhere (ADR-017).
<!-- END PRESERVED BLOCK -->
