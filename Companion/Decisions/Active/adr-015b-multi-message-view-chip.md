# ADR-015 (second definition): Multi-Message-View Chip Is a Sibling Experiment, Not Bundled into ADR-014

> Routed out of `DECISIONS.md` § ADR-015 (SECOND definition of the ADR-015 id in this file; routed as 015b, id preserved verbatim in the block) by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
**Context:** After landing the header chip (ADR-014), we wanted the same iOS-style chip on each `<li>` of `multimessageview.xhtml` (the collapsed-thread / multi-select summary that replaces about:message in the messageBrowser). Two design choices needed pinning down: (1) bundle into `tmMessageHeaderChip` or build a sibling experiment; (2) handle the lifecycle gap that multimessageview is TRANSIENT (only loaded when user clicks a collapsed thread, unlike about:message which is stable).

**Decision:**
1. Build a sibling experiment `theme/experiments/tmMultiMessageChip/` parallel to `tmMessageHeaderChip`. Same passive-painter / direct-`performTaggedAction` / hot-reload-safe contract. New marker class `tm-multi-action-chip` so click delegation never cross-fires with the header chip or the card chip.
2. Per-row hdr resolution uses `gMessageSummary._msgNodes` reverse-mapping (verified against TB upstream `multimessageview.js:122-130, 704`). Keys are `messageKey + folder.URI` (no separator); we parse with `/^(\d+)(\D.*)$/` and resolve via `MailUtils.getExistingFolder` + `folder.GetMessageHeader`. For multi-selection-summarizer rows that map N hdrs to one `<li>`, prefer the hdr whose `headerMessageId` matches `<li>.dataset.messageId` (the thread head per `mmv.js:259`).
3. Lifecycle handling: introduce a single per-doc workhorse `_attachAndPaintDoc(doc)` that idempotently runs `attachChipDelegation_MMC + _attachMessageListMO_MMC + paintMessageListChips`. Called from BOTH `attachToWindow` (initial pass) AND `_repaintAll` (refresh trigger), so the transient multimessageview doc gets attached on first appearance via `onMessagesDisplayed`. The MutationObserver is rooted at `#content` (parent of `#messageList`) per `mmv.js:137`'s `messageList.replaceChildren()` semantics.
4. `actionCache._refreshHeaderChip` renamed to `_refreshChips`; fans out to both `tmMessageHeaderChip.refreshAll` and `tmMultiMessageChip.refreshAll` in parallel via `Promise.all`. The IPC-race-avoidance ordering at the prop-writing sites (`await _writeActionToHdr` BEFORE the fan-out) is preserved.

**Rationale:**
- Sibling experiment per established pattern (`tmMessageListCardView` / `tmMessageListTableView` / `tmMessageHeaderChip` — each owns one DOM region with one lifecycle). Hot-reload independence: a bug in one doesn't take down the other.
- Per `PLAN_TB_LABEL_V2.md` §5a, action constants and helpers MUST be duplicated across experiments because module state isn't reliably shared. Acceptable cost.
- The transient-doc lifecycle problem CANNOT be solved by attach-only-in-`attachToWindow` — multimessageview doesn't exist at experiment-init time in the common case. The `_attachAndPaintDoc`-from-refresh pattern is the load-bearing fix.

**Consequences:**
- Refresh fan-out is now uniform: a single `_refreshChips()` call covers both surfaces, called identically from `setAction`/`clearAction` (after `await _writeActionToHdr`) and `clearActionByUniqueKey` (no await — symmetric coverage only).
- Multi-selection-summarizer rows that group N messages get the chip on the thread-head representative; clicking that chip applies the action to that one message, not the group. Acceptable — matches the visible representation.
- The header chip's existing pattern (attach only in `attachToWindow`) is now arguably fragile if about:message is ever recreated on URL change (e.g., toggling to multimessageview and back). Today it works (TB appears to cache about:message), but a future commit should mirror the `_attachAndPaintDoc`-from-refresh pattern in the header chip too. Documented in `PROJECT_MEMORY.md` "Multi-message-view chip" section as an open followup.
- Known limitation carried over from ADR-014: `contextMenus.js:230` "Remove TabMail tags" bypasses both `actionCache.js` AND mork-prop clearing → chips on BOTH surfaces persist after the bypass call until reclassification or move.
<!-- END PRESERVED BLOCK -->
