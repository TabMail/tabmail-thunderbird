# tagSort: must save/restore selection around view.sort()

> Routed out of `PROJECT_MEMORY.md` § tagSort: must save/restore selection around `view.sort()` by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
`theme/experiments/tagSort/tagSort.sys.mjs` calls `view.sort(BY_DATE, …)` then `view.sort(BY_CUSTOM, …)` from its delayed-resort path. We previously had a JS msgHdr-based save/restore around these calls, removed it because per-folder threaded INBOX (`nsMsgThreadedDBView::Sort`) preserves selection internally via `SaveAndClearSelection`/`RestoreSelection` (`mailnews/base/src/nsMsgThreadedDBView.cpp:301, 324, 343, 390`).

That removal silently broke the **Unified Inbox / smart-folder INBOX** path. `nsMsgXFVirtualFolderDBView` inherits `Sort` from `nsMsgSearchDBView`, which for `kThreadedDisplay | kGroupBySort` delegates to `nsMsgGroupView::RebuildView` (`mailnews/base/src/nsMsgSearchDBView.cpp:1108`, `mailnews/base/src/nsMsgGroupView.cpp:493`). `RebuildView` only saves the **current** selected msgKey — not the full ranges, and the symptom was the highlighted card silently going away ~30 s after a click (the `DELAYED_SORT_MS` window in `tagSort.sys.mjs:69`).

Fix landed: wrap the `view.sort()` calls in `applySort` and `applyDateOnlySort` with TB's canonical URI-based `threadPane.saveSelection()` / `threadPane.restoreSelection({ notify: false })` (`mail/base/content/about3Pane.js:5765, 5814`). This is the same contract TB itself uses around `cmd_expandAllThreads`/`cmd_collapseAllThreads` (`about3Pane.js:7300, 7310`). `notify:false` skips re-firing the "select" event so the message pane doesn't redraw.

**Do not re-remove this wrapper just because per-folder INBOX seems to work without it** — the unified-inbox path needs it.
<!-- END PRESERVED BLOCK -->
