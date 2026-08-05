# Cross-Instance IMAP Tagging — first compute wins, Gmail label fallback (FLAGGED STALE by the 2026-06-18 liveness sweep)

> Routed out of `PROJECT_MEMORY.md` § Cross-Instance IMAP Tagging by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
- **"First compute wins"**: Before LLM action computation, `getAction()` checks for existing `tm_*` IMAP tags (from another TM instance). If found, adopts the tag without LLM.
- **Gmail REST API fallback**: `importActionFromImapTag()` and `getAction()` also check Gmail label membership via `readActionFromGmailFolders()` when IMAP keywords return nothing. This detects tags set by iOS (which uses Gmail REST API labels, not IMAP keywords).
- **Gmail label sync**: `gmailLabelSync.js` uses `tmGmailLabels` experiment for OAuth2 tokens → Gmail REST API. `syncGmailTagFolder()` writes labels, `readActionFromGmailFolders()` reads them. Labels are created/maintained as hidden (`labelListVisibility: "labelHide"`).
- IDB cache import: `importActionFromImapTag()` in `tagHelper.js` — idempotently writes IMAP tag (or Gmail label) action into IDB cache for thread aggregation.
- Entry points that check: `getAction()` (semaphore path), `processCandidatesInFolder()` (startup scan), `onNewMailReceived` (new mail).
- Override: context menu manual tagging always wins. Debug "Recompute Action" passes `forceRecompute: true` flag through `processMessage` → `getAction()` to bypass IMAP tag check.
- Tag watcher (`_syncActionCacheFromMessageTagsToInboxCopies`): updates IDB cache when IMAP tag *differs* from cached action (external change from another instance); skips when they match (idempotent/self-tag).
<!-- END PRESERVED BLOCK -->
