# ADR-022: Startup UID/FTS Membership Fingerprints Replace Count Inference and Automatic Scans

> Authored directly in the routed tree on 2026-08-13 rather than extracted from `DECISIONS.md`; the manifest's `sha256_preserved_block` is `-` and the index carries only the keyword-bearing summary.

**Context:** Weekly scans in July/August 2026 repeatedly removed old ghosts from Gmail Bin even after ADR-020/021. The count design had two unsound assumptions: `getTotalMessages(false)` is cached state, and equal cardinality does not imply equal membership (one ghost plus one missing key cancels). A highest UID alone detects additions but not arbitrary deletions; HIGHESTMODSEQ detects change but also advances for flag-only changes and does not identify the changed UID.

**Decision:** Make startup reconciliation an exact, collision-resistant membership proof:

- `browser.accounts.list(true)` supplies the supported folder inventory; `tmMsgNotify.getFolderState(accountId,path)` reads one folder at a time and, for IMAP, returns `UIDVALIDITY`, an SHA-256 digest of sorted local msgDB keys (IMAP UIDs), UID count, and HIGHESTMODSEQ telemetry. UID hashing is chunked into 1 MiB native hash updates; it reads local integer keys only. Per-folder Experiment calls permit an event-loop yield between summary-DB opens and record lookup/open/hash timings for diagnostics.
- Native helper ≥0.11.0 adds reader RPC `fingerprintMsgIdRange(startKey,endKey)` over ordered `message_ids` keys. It hashes each UTF-8 key as `u64be(length) || bytes`; no schema/reindex change.
- `fts_folder_recon_memo` v2 records only checkpoints established after exact msgDB-key and native-key fingerprints match. On steady IMAP startup, unchanged UID and FTS fingerprints preserve that equality without reading headers or bodies.
- If either signal changes, or no v2 checkpoint exists, `fingerprintFolderMessages()` hashes the folder's exact de-duplicated `account:path:Message-ID` set from local headers. A mismatch always runs both stale and missing directions, including equal-count swaps. Missing additions use the durable drain; the folder is fingerprinted again after drain before becoming verified. Any error/budget truncation remains explicitly unverified.
- Non-IMAP folders have no stable UID contract and therefore take the exact local-header fingerprint path each boot.
- Orphan-prefix evidence remains `native total > sum of all known folder ranges`; removal still requires ADR-017 verification.
- `runPostInitReconcile()` no longer performs the date-window `messages.query`, UID-cursor scan, or date-window FTS cleanup automatically. The fingerprint proof is date-independent and supersedes those automatic passes.
- Periodic hourly/daily/weekly/monthly alarms and the startup maintenance tick are retired and migrated off. Full Maintenance Scan / Full Reindex remain explicit user repair tools.
- Removal-event extraction now falls back to `folder.server.key`, carries `msgKey`, and rejects any partial `accountId`/folder/Message-ID key instead of queueing malformed deletes.
- Privileged Experiment modules cannot assume Web-platform globals (`TextEncoder` is absent in TB 154 Beta); exact Message-ID hashing uses a local UTF-8 encoder so the API cannot fail during module evaluation.

**Rationale:** A digest of actual membership answers the relevant question; counts and recent-UID watermarks do not. The steady-state cost is local sequential key work: on the measured ~295k-key profile, the native full-range pass was ~0.02–0.05 s warm, and a representative Node sort+SHA pass over 295k integer UIDs was ~24 ms. This is qualitatively cheaper than WebExtension message enumeration, body fetching, or the throttled weekly validator. Changed folders pay for header enumeration and exact repair; unchanged folders never do.

**Consequences:**

- “Guaranteed” means a SHA-256 collision-resistant equality proof of Thunderbird's synchronized local msgDB versus native FTS, not a mathematical proof and not a direct unsynchronized server query.
- The first 0.11.0 startup computes exact header fingerprints to establish v2 checkpoints. Later IMAP boots normally use only UID + native-key digests.
- Flag-only changes do not cause work because the UID digest is authoritative; HIGHESTMODSEQ is diagnostic only.
- Very large repairs remain budgeted for UI safety, but cannot be memoized as clean; the startup pending marker remains until a clean post-drain rerun or a later restart.
- ADR-020 cursor and ADR-016 watermark helpers remain for compatibility/tests, but no longer drive the automatic startup path. ADR-021's verify-then-remove, resumable missing scan, and orphan safeguards are retained after the trigger changes.
