# TabMail Thunderbird Add-on - Architectural Decisions

> **Check this file before proposing alternatives.** For cross-cutting decisions, see `../DECISIONS.md`.

---

## ADR-002: Manifest V3 Only

**Context:** Thunderbird supports MV2 and MV3. MV2 is being deprecated.

**Decision:** MV3 exclusively. No MV2 fallbacks.

**Rationale:** Future-proof, better security model, aligns with browser extension ecosystem direction.

**Consequences:**
- Cannot use MV2-only APIs
- Service worker patterns required (no persistent background pages)
- More restrictive messaging patterns

---

## ADR-006: Palette System for All Colors

**Context:** UI must support dark and light themes consistently.

**Decision:** All colors come from `theme/palette/palette.data.json`. No hardcoded colors. No fallback colors.

**Rationale:** Single source of truth. Theming issues become immediately visible instead of silently degraded.

**Consequences:**
- Must update palette file to add any new color
- Broken themes fail visibly (intentional)
- Consistent look across all components

---

## ADR-007: No Async runtime.onMessage Handlers

**Context:** WebExtension `runtime.onMessage` supports async handlers in browsers, but Thunderbird's implementation differs.

**Decision:** Never use async handlers for `runtime.onMessage` in the Thunderbird add-on.

**Rationale:** Async handlers break other message listeners in Thunderbird, causing dropped messages and race conditions.

**Consequences:**
- Must use synchronous return patterns or explicit `sendResponse` callbacks
- More verbose message handler code
- Reliable message delivery

---

## ADR-008: No Inline Code Strings

**Context:** Code could be embedded as strings or kept in separate files.

**Decision:** Always use separate `.js` files. Never inline code as strings.

**Rationale:** Proper syntax highlighting, linting, formatting, version control diffs, and editor support.

**Consequences:**
- More files (trivial downside)
- Better developer experience across the board

---

## ADR-013: Tools That Accept Timestamps Must Be Timezone-Aware

- **[Full ADR](Companion/Decisions/Active/adr-013-timezone-aware-timestamp-tools.md)** — naive ISO 8601 stays the LLM ↔ tool wire format (`new Date()` parsing of naive strings is inconsistent across engines); every timestamp-taking tool resolves `Intl.DateTimeFormat().resolvedOptions().timeZone`, SHOULD accept an optional IANA `timezone` param, and MUST return the `timezone` used. Reference impls: `calendar_search.js`, `proactive_schedule_alarm.js`.

---

## ADR-015: Deterministic Proactive Reachout (Replace Headless LLM)

- **[Full ADR](Companion/Decisions/Active/adr-015-deterministic-proactive-reachout.md)** — replaces the headless-LLM check-in with two deterministic JS triggers (new reminder within N days; `browser.alarms` X minutes before due) + template messages + `reached_out` per-reminder/per-trigger dedup. Dedicated `reminder_add`/`reminder_del`; `change_setting` replaces `proactive_toggle_checkin`; old tools removed at v1.1.0; settings under `notifications.*`.

---

## ADR-016: iOS Is Canonical for Tag-Teach and KB-Refinement Flows

- **[Full ADR](Companion/Decisions/Active/adr-016-ios-canonical-tag-teach-kb-refinement.md)** — the ONE deliberate exception to "TB is the reference implementation" (ADR-IOS-008), for these two flows only. Three TB alignments: a post-`sendChat` re-read guard in `autoUpdateUserPrompt.js` (device sync / config-page edits bypass the per-flow semaphore); `periodicKbUpdate()` moved from per-assistant-turn to `_insertSessionBreak()`; `_kbUpdateImpl()` direct-replace → `mergeFlatField(base, local, remote)`.

---

## ADR-014: Header Chip Is a Passive Painter; Click Targets the Chip's Own Message

- **[Full ADR](Companion/Decisions/Active/adr-014-header-chip-passive-painter.md)** — sibling experiment `tmMessageHeaderChip`, never writes action state; the chip carries its own `data-tm-we-msg-id` and clicks call `performTaggedAction({id: weMsgId})` directly, **bypassing** selection-based `triggerTagActionKey` (selection drifts between paint and click; standalone `messageWindow.xhtml` has no `mailTabs` selection). `await _writeActionToHdr` BEFORE the refresh or the painter reads the OLD mork prop (parent-process IPC).

---

## ADR-015: Multi-Message-View Chip Is a Sibling Experiment, Not Bundled into ADR-014

- **[Full ADR](Companion/Decisions/Active/adr-015b-multi-message-view-chip.md)** — sibling `tmMultiMessageChip` with its own `tm-multi-action-chip` marker class; per-row hdr via `gMessageSummary._msgNodes` reverse-map + `<li>.dataset.messageId`. The transient-doc lifecycle CANNOT be solved by attaching only in `attachToWindow` — `_attachAndPaintDoc` called from `_repaintAll` too is the load-bearing fix. `_refreshHeaderChip` renamed `_refreshChips`, fans out via `Promise.all`.

---

## ADR-016: Reconcile Window Bounded by Persistent Watermark, Not FTS-Newest Date

- **[Full ADR](Companion/Decisions/Active/adr-016b-reconcile-window-persistent-watermark.md)** — FTS-newest is a *forward-looking* freshness signal being used as a *backward-looking* verification watermark, so the window collapsed to ~1 day however long TB was offline. `fts_reconcile_watermark = {version, fromMs, completedAtMs}` means "at `completedAtMs`, FTS was verified consistent with IMAP for all messages dated ≥ `fromMs`". **No sanity floor** (any cap silently leaves older drops uncorrected); heartbeat advances `completedAtMs` only and refuses to MINT a watermark.

---

## ADR-017: FTS Stale-Entry Removal Requires Verify-Then-Remove; Startup Maintenance Tick Deferred Behind Sync Quiet Period

- **[Full ADR](Companion/Decisions/Active/adr-017-fts-verify-then-remove-and-deferred-startup-tick.md)** — a single empty folder-scoped `messages.query` is indistinguishable from a mid-sync snapshot, so it only nominates a CANDIDATE; `recheckMessageInFolder` re-checks with a fresh GLOBAL `messages.query({headerMessageId})` — found → keep, succeeded-but-absent → remove, **threw → keep (never remove on uncertainty)**. `_scheduleStartupTickWhenQuiet` polls to 60 s sync-quiet + reconcile-not-pending, 10-min cap. Enumerates exactly which failures block the watermark advance vs which are per-entry carve-outs (`error_skipped`, `recheck_error`).

---

## ADR-018: Body Extraction for FTS/Snippets Is HTML-First with an HTML-Document Guard on the text/plain Fallback

- **[Full ADR](Companion/Decisions/Active/adr-018-body-extraction-html-first.md)** — a `multipart/alternative` whose text/plain part held the full HTML document rendered raw `<!DOCTYPE html>` in card snippets and polluted native FTS. `extractPlainText()` now prefers `text/html` → `stripHtml()`, with the text/plain fallback guarded by a **document-start-only** marker test (a generic "looks like HTML" heuristic corrupts legitimate plain text containing `<`). `snippet_v3:` → `snippet_v4:` is the designed invalidation mechanism.

---

## ADR-LICENSE: Relicensed to MPL 2.0 (PolyForm Noncommercial → MPL 2.0)

- **[Full ADR](Companion/Decisions/Active/adr-license-mpl-2.0-relicense.md)** — relicensed in place (no history rewrite), per-file MPL headers, shipped as **v1.6.0**; `tabmail-native-fts` relicensed in lockstep (0.9.0) and iOS at the same time. The hosted backend, prompt content and signing identities stay proprietary; "TabMail" name and logo remain trademarks (forks must rebrand); contributions require DCO `git commit -s`.

---

## ADR-019: Popup Billing/Usage Nudge — Tier-Branched, Driven by Cached `/whoami` (TB port of ADR-IOS-044)

- **[Full ADR](Companion/Decisions/Active/adr-019-popup-billing-usage-nudge.md)** — pure `decideBillingBanner({planTier, queueMode, quotaPercentage, hasOwnApiKeys})` in a leaf module, a direct port of iOS `UsageThrottleStore.banner`: Basic+throttled → `"upgrade"`, BYOK+no-key → `"byok"`, **Pro / unknown / no-subscription → null**. NO new network call (reuses the popup's `/whoami`); `"billing"` warning key relayed through `storage.local.tabmailBillingBanner` like `consent`/`server`.

---

## ADR-020: Add-Side Reconcile Keyed on Per-Folder msgKey/UID Cursors, Not Date Windows

- **[Full ADR](Companion/Decisions/Active/adr-020-add-side-reconcile-per-folder-cursors.md)** — local arrival order and the Date header are decorrelated, so **no date-keyed window of any width expresses "new to our local msgDB since we last looked"** (ADR-IOS-042 doctrine applied to TB). Phase 1b `_runCursorScan` + `fts_folder_cursors` (`accountId:folderPath` → `{uidValidity, highestKeySeen}`); advance only on full per-folder success; first run seeds without enumeration; UIDVALIDITY reset → capped full scan; non-IMAP accounts excluded. Widening the window and buffering events in the experiment were both rejected, with reasons.

---

## ADR-021: Remove-Side Reconcile via Evidence-Triggered Per-Folder Count Invariant (No Date Windows, No Periodic Jobs)

- **[Full ADR](Companion/Decisions/Active/adr-021-remove-side-reconcile-count-invariant.md)** — with add-side completeness guaranteed, FTS-per-folder ⊇ msgDB-per-folder, so per folder `ftsCount > msgCount` ⟹ ghosts, `msgCount > ftsCount` (drain-quiet) ⟹ missing adds, equal ⟹ zero work. Phase 1c `_runFolderReconcile` on generic `countMsgIdRange`/`listMsgIdRange` PK-range RPCs (no schema change, no host-side msgId parsing). The `indexedAt`/`verifiedAt` column was REJECTED. Missing direction is a RESUMABLE backfill (revised 2026-07-06) that replaced the hard `FOLDER_RECON_MISSING_MAX_DEFICIT = 500` cap.

---

## Template for New Decisions

```markdown
## ADR-XXX: [Title]

**Context:** [What situation led to this decision?]

**Decision:** [What did we decide?]

**Rationale:** [Why?]

**Consequences:**
- [Trade-offs, both positive and negative]
```
