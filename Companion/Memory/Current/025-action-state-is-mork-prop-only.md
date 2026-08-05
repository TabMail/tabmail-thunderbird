# Action state is mork-prop-only (Phase 0 onwards)

> Routed out of `PROJECT_MEMORY.md` § Action state is mork-prop-only (Phase 0 onwards) by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
- TabMail no longer writes `tm_*` IMAP keywords / Gmail labels / Exchange categories anywhere. See `agent/modules/tagHelper.js:1-13` header: "Post Phase 0: ADD-path tag writes ... all removed. Action state lives in IDB only."
- Action state is propagated via `actionCache.setAction` → `_writeActionToHdr` → `tmHdr.setAction` → `hdr.setStringProperty("tm-action", …)`. The mork prop is the canonical local-render state; IDB is the cross-device cache.
- `onMoved.js`/`tagCleanup.js` `browser.messages.update({tags: ...})` calls REMOVE legacy `tm_*` keywords, never add them — they're scrubbing leftover server pollution.
- **Legacy `_actionFromKeywords*` fallback** survives in 4 experiments — `tmMessageListCardView`, `tmMessageListTableView`, `tmMessageHeaderChip`, `tagSort` — for messages tagged before Phase 0. All four are now marked `@deprecated`. The new `tmMultiMessageChip` (and any future surface) skips this fallback outright. Remove the deprecated readers from the older experiments once legacy `tm_*` keywords have decayed out of users' inboxes.
<!-- END PRESERVED BLOCK -->
