# ADR-020: Add-Side Reconcile Keyed on Per-Folder msgKey/UID Cursors, Not Date Windows

> Routed out of `DECISIONS.md` § ADR-020 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** The 2026-06-29 weekly scan corrected 352 missing FTS entries — all in account3's
lazily-synced Gmail secondary folders (All Mail / Sent / Spam / Bin), dated exactly 06/17–06/23.
That week's mail was sent/filed from other clients; TB's copies arrived in one bulk catch-up
while nothing was listening (TB fires `nsIMsgFolderNotificationService` events during startup
sync before the addon is loaded). Boot reconcile Phase 1 could not recover them: its window is
`messages.query({fromDate: watermark.completedAtMs − 1d})` — keyed on the **message Date
header** — and the watermark had advanced to "now" (TB ran all week; INBOX was fine), so those
messages fell permanently outside every subsequent boot window. This is the add-side of the
Class-1 date-window blind spot (2026-06-10 diagnosis), proven systematic. Same bug class iOS
fixed with ADR-IOS-042: local arrival order and Date header are decorrelated, so no date-keyed
window of any width expresses "new to our local msgDB since we last looked". Widening the window
(e.g. 3 weeks) was rejected: it costs ~a weekly scan's TB→FTS pass per boot and still has the
same hole. Buffering events in the experiment was rejected: the addon-not-loaded window has no
experiment running.

**Decision:** Add reconcile **Phase 1b** (`_runCursorScan`, PLAN_RECONCILE_CURSOR.md): per-folder
persistent cursors `storage.local["fts_folder_cursors"]` mapping `accountId:folderPath` →
`{uidValidity, highestKeySeen}`. For IMAP folders msgKey = IMAP UID (arrival-ordered, monotonic
per UIDVALIDITY). On boot, everything above each folder's cursor is enqueued into the existing
persistent drain queue regardless of Date header (FTS dedup via filterNewMessages). New
`tmMsgNotify` functions (`getCursorFolders`, `listKeysAboveKey`, `getMessageInfosForKeys`)
expose msgDB fingerprints and key enumeration; `onMessageAdded` payloads gain `msgKey`. Rules:
- **Advance only on full success** per folder (any enqueue/RPC failure keeps the old cursor →
  retry next boot). Independent of the watermark in both directions.
- **First run seeds** to highWater without enumeration (pre-deploy history belongs to the
  initial scan / weekly). New folder or UIDVALIDITY reset → capped full scan from key 0
  (`CURSOR_FULL_SCAN_MAX_KEYS`, newest keys win, truncation logged loudly).
- **Heartbeat advance**: delivered `onMessageAdded` events record per-folder session-max keys;
  the existing 10-min heartbeat merges them into stored cursors (only advancing existing
  entries — the boot scan is the sole minter; shared drain-stall guard with the watermark bump)
  so each boot's diff stays small.
- msgDB-unreadable folders are skipped, never seeded/advanced. Non-IMAP accounts (local/POP/
  NNTP/RSS) are excluded — weaker msgKey semantics; they keep events + date-window + weekly.
- Cursor-scan enqueues do NOT bump `_lastSyncEventMs` (not sync events; must not starve the
  maintenance startup tick's quiet signal).

**Rationale:** The cursor is the arrival-ordered signal the Date header cannot provide — the
exact ADR-IOS-042 doctrine ("sync windows by UID, never date") applied to TB's reconcile.
Steady-state boot cost ≈ one msgDB fingerprint per folder; after a real gap, cost is
proportional to genuinely new-to-us headers only.

**Consequences:**
- Closes the add-side boot-gap for IMAP folders regardless of message dates; the 06/29 incident
  class becomes a next-boot recovery instead of an up-to-7-day search outage.
- Not covered (weekly scan remains the backstop, unchanged from today): backfill below the
  cursor (offline-sync-window deepening), local/POP folders, drain-queue stuck-entry drops
  after the cursor advanced, and the remove side (still wants a native-FTS `indexedAt` column).
- Date-keyed Phase 1 is retained (cheap, covers non-IMAP + recent-dated arrivals); candidate
  for retirement after the cursor path has soak time.
- `getCursorFolders` opens each IMAP folder's msgDB once per boot (post-quiet-period); folders
  with missing/out-of-date summaries are skipped without forcing a rebuild.
<!-- END PRESERVED BLOCK -->
