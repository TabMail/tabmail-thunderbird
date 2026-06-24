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

**Context:** LLM communication uses naive ISO 8601 timestamps without timezone offsets. JavaScript's `new Date()` parsing of naive strings is inconsistent across engines.

**Decision:**
1. All tools that accept timestamp parameters MUST resolve the user's timezone via `Intl.DateTimeFormat().resolvedOptions().timeZone` and interpret naive timestamps in that timezone.
2. An optional `timezone` parameter (IANA identifier) SHOULD be accepted, defaulting to the user's browser timezone.
3. Tool responses MUST include the `timezone` used in the result object.
4. Naive ISO 8601 remains the standard format for LLM ↔ tool communication.

**Reference implementation:** `calendar_search.js`, `proactive_schedule_alarm.js`.

**Consequences:**
- Every new tool with timestamp params needs ~5 lines of TZ resolution boilerplate
- All timestamp tool results include a `timezone` field
- LLM prompts stay simple — just send naive timestamps

---

## ADR-015: Deterministic Proactive Reachout (Replace Headless LLM)

**Context:** The proactive check-in feature sent the full reminder list to a headless LLM call every time reminders changed. This was wasteful, non-deterministic, slow, and over-engineered.

**Decision:**
1. Replace headless LLM calls with two deterministic JS triggers: (a) new reminder formed with due date within N days, (b) `browser.alarms` wake-up X minutes before due date/time.
2. Use template-based messages with string interpolation instead of LLM-generated text.
3. Deduplication via `reached_out` IDs — per-reminder, per-trigger-type tracking.
4. Dedicated `reminder_add`/`reminder_del` tools — structured params instead of requiring KB format.
5. `change_setting` tool replaces `proactive_toggle_checkin`.

**Rationale:**
- Deterministic logic is faster, cheaper, and more predictable than LLM-based decisions
- Dedicated reminder tools reduce LLM cognitive load
- Template messages are sufficient for notifications

**Consequences:**
- Proactive reachout behavior is now fully auditable in JS code
- No more headless LLM token spend for notification decisions
- Old tools (`proactive_schedule_alarm`, `proactive_toggle_checkin`) removed at v1.1.0
- Notification settings stored under `notifications.*` namespace

---

## ADR-016: iOS Is Canonical for Tag-Teach and KB-Refinement Flows

**Context:** Two long-running LLM refinement flows exist in both TB and iOS:
(1) tag-teach — refine `user_action.md` when the user overrides an agent-assigned tag; (2) KB refinement — refine `user_kb.md` from chat session turns. The default project stance (ADR-IOS-008) is "TB is the reference implementation." For these two flows specifically, an audit concluded iOS has the correct design for trigger timing, concurrency guards, and merge strategy. TB had three gaps: (a) no post-response re-read guard in tag-teach (concurrent device-sync or config-page edits during the LLM flight could clobber updates); (b) KB refinement fired per assistant turn rather than at session idle-end (LLM spam, mid-session clobbering); (c) `_kbUpdateImpl` used direct-replace instead of the 3-way merge already implemented correctly in `_periodicKbUpdateImpl`.

**Decision:** For these two flows, iOS is the canonical reference. TB is aligned by three changes:
1. `autoUpdateUserPrompt.js` — insert a re-read guard after `sendChat` returns; skip patch apply if `user_action.md` drifted during the backend call.
2. Move `periodicKbUpdate()` trigger from `converse.js` (per-assistant-turn) to `init.js` `_insertSessionBreak()` (session-boundary). Fires on both page-load and idle-driven breaks; internal gates (min exchanges, cooldown) unchanged.
3. `_kbUpdateImpl()` — replace direct-replace with `mergeFlatField(base, local, remote)`, mirroring the existing pattern in `_periodicKbUpdateImpl()`. Future-proofs the conversation-memo path even though it is currently unreachable (chat.js omits `conversationHistory`; background.js guard filters empty calls).

**Rationale:**
- Re-read guard defends against cross-flow writers that bypass the per-flow semaphore (device sync, config-page edits).
- Session-boundary trigger matches the user's mental model of "I finished chatting" and avoids per-turn LLM spend.
- 3-way merge is strictly safer than direct-replace with no behavioral cost when nothing has drifted.

**Consequences:**
- TB KB refinement now runs at most once per session boundary instead of once per assistant turn.
- `kbUpdate()` retains future value once the chat-close path is rewired to pass session turns; the merge logic is correct regardless.
- Deviates from "TB is reference" for these flows only. All other AI processing parity rules (ADR-IOS-008) continue to treat TB as canonical.

---

## ADR-014: Header Chip Is a Passive Painter; Click Targets the Chip's Own Message

**Context:** The iOS-style action chip needed to also appear in the message preview-pane header (`#expandedButtonsBox`). The card-view chip already exists (`tmMessageListCardView`). For the header chip, two design choices needed pinning down: (1) whether to share state with `tmMessageListCardView` or build a sibling experiment, and (2) what the click should act on — the current 3-pane selection (like the Tab key) or the chip's own message.

**Decision:**
1. Build a sibling experiment `theme/experiments/tmMessageHeaderChip/`. Never write action state — read `tm-action` mork prop, with `_actionFromKeywords_MHC` legacy fallback. The chip is purely a *display* of `action:<uniqueKey>` IDB state surfaced via the prop.
2. The chip carries its own `data-tm-we-msg-id`. Click → `onActionChipClick` event → MV3 calls `performTaggedAction({id: weMsgId})` directly, bypassing the selection-based `triggerTagActionKey`.
3. CSS refactor: relax the four per-action chip rules in `tmTheme/theme.css` from `tr[is="thread-card"].tm-action-X .tm-action-chip` to `.tm-action-chip.tm-action-X` so the same paint rules cover both surfaces. Card-row tinting (separate ruleset) is unaffected.

**Rationale:**
- Sibling experiment instead of extending the card view: the header lives in the chrome `about:message` document and must also work in standalone `messageWindow.xhtml`; the card view is `mail:3pane`-scoped and patches `ThreadCard.prototype.fillRow`. Different lifecycles → mixing would muddy both. Per `PLAN_TB_LABEL_V2.md` §5a, experiments don't reliably share module state, so a sibling with copied action constants is the right shape.
- Click acts on chip's message, not selection: selection can drift between paint and click (snippet-fetch repaints can shift selection); standalone message windows have no `mailTabs` selection at all (`mailTabs.getSelectedMessages` is empty); embedding `weMsgId` on the chip itself eliminates both failure modes.
- CSS scope relaxation: the four per-action rules' bodies never referenced row-scoped CSS variables — the `tr[is="thread-card"]` ancestor scoping was vestigial. Relaxing it lets one ruleset paint both surfaces with no row-side change. The header chip additionally carries a `tm-header-action-chip` marker class so click delegation can scope to header chips and never accidentally fire on a card chip.

**Consequences:**
- Refresh triggers: `messageDisplay.onMessagesDisplayed` (MV3) + `actionCache.setAction`/`clearAction`/`clearActionByUniqueKey` (MV3) + internal MutationObserver on `#headerSubjectSecurityContainer` (50 ms debounce). At the prop-writing sites, `_writeActionToHdr` MUST be `await`ed before `_refreshHeaderChip` fires — parallel dispatch would let the painter read the OLD mork prop because both calls are parent-process IPC roundtrips. See PLAN_HEADER_CHIP.md §6.
- `clearActionByUniqueKey` calls `_refreshHeaderChip` only as symmetric coverage — today's caller (`onMoved.js:288`) is actually covered by `onMessagesDisplayed` firing on the post-move new-folder hdr. The trigger exists for hypothetical future call sites where the mork prop has been cleared independently.
- Known limitation: `contextMenus.js:230` `clearActionCache` bypasses `actionCache.js` AND doesn't clear the mork prop, so "Remove TabMail tags" via right-click leaves the chip stale. Pre-existing inconsistency, not addressed here.

---

## ADR-015: Multi-Message-View Chip Is a Sibling Experiment, Not Bundled into ADR-014

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

---

## ADR-016: Reconcile Window Bounded by Persistent Watermark, Not FTS-Newest Date

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

---

## ADR-017: FTS Stale-Entry Removal Requires Verify-Then-Remove; Startup Maintenance Tick Deferred Behind Sync Quiet Period

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

---

## ADR-018: Body Extraction for FTS/Snippets Is HTML-First with an HTML-Document Guard on the text/plain Fallback

**Context:** Card snippets and FTS bodies are derived by `fts/bodyExtract.js extractPlainText()`. It originally preferred the `text/plain` MIME part verbatim and only stripped `text/html` when no plain part existed. A real-world sender (survey platform, 2026-06) shipped `multipart/alternative` whose text/plain part contained the **full HTML document** — the card snippet rendered raw `<!DOCTYPE html>...` source, and the raw HTML was indexed into native FTS (then re-served by `safeGetFull`'s FTS-synthetic path, which labels stored bodies `text/plain`). iOS was immune because its `EmailFilter.extractPlainText` prefers `htmlBody` and converts it.

**Decision:** Flip `extractPlainText()` to HTML-first, matching iOS:
1. Prefer `text/html` parts → `stripHtml()`; use the result if non-blank.
2. Fall back to `text/plain`, **guarded**: if the assembled text starts with an HTML document marker (`<!DOCTYPE` / `<html` + whitespace/`>`, case-insensitive, leading whitespace allowed), run it through `stripHtml()` instead of trusting it.
3. `snippetCache` prefix bumped `snippet_v3:` → `snippet_v4:` (the designed invalidation mechanism for extraction-logic changes; the 90-day IDB TTL would otherwise keep stale raw-HTML snippets for months).

**Rationale:** The HTML part is what the user actually sees rendered — deriving search/snippet text from it makes garbage plain-text alternatives (raw HTML, whitespace-only, 1-char stubs) irrelevant. The guard covers the two cases preference order can't: mislabeled single-part HTML mail, and FTS-synthetic bodies indexed before this fix (strips at read time; already-polluted index rows are deliberately left in place — they heal on any future reindex). The guard is document-start-only by design: a generic "looks like HTML" tag heuristic corrupts legitimate plain text containing angle brackets (quoted addresses, code, `a < b`) — same reasoning as iOS `BodyRenderer`'s display-path comment. iOS mirrors the guard in `EmailFilter.looksLikeHTMLDocument` (Shared/Parse/EmailFilter.swift).

**Consequences:**
- Snippets/FTS now reflect rendered content; immune to malformed text/plain alternatives.
- `stripHtml` (DOMParser) now runs for every multipart message at index time, not just HTML-only mail — acceptable: indexing is batched background work, and iOS pays the same cost by design.
- FTS-indexed text for multipart mail changes from the sender's plain part to stripped HTML going forward; old rows are not migrated (search-equivalent in practice).
- AI features unaffected: `extractBodyFromParts` (utils.js) is a separate extractor whose callers always `stripHtml()` afterward.

---

## ADR-LICENSE: Relicensed to MPL 2.0 (PolyForm Noncommercial → MPL 2.0)

**Context:** The TabMail Thunderbird add-on was source-available under PolyForm Noncommercial 1.0.0, which bars commercial use and is not OSI-approved open source. To make the desktop client genuinely open — auditable and forkable — and to match the iOS client's positioning, the add-on is relicensed.

**Decision:** Relicense the add-on to the **Mozilla Public License 2.0**, in place (no history rewrite). Per-file MPL headers added; root `LICENSE` carries the full MPL 2.0 text. Shipped as **v1.6.0** (the `1.6.0` tag is the relicense). Its partner crate `tabmail-native-fts` (the native-messaging FTS host) is relicensed in lockstep (bumped to `0.9.0`); the iOS client moved to MPL 2.0 at the same time.

**Rationale:** MPL 2.0 is OSI-approved weak copyleft at file granularity — modifications to MPL files stay open, while integrators may ship proprietary surrounding code; GPL-compatible via the secondary-license clause; well understood by enterprise legal. Lets anyone read, build, contribute to, or fork the add-on while protecting our changes.

**Consequences:**
- The add-on (XPI source + `marketplace/` listing) is genuinely open source.
- The hosted TabMail backend (AI orchestration, prompt content, infra) and signing identities stay proprietary — out of scope.
- The "TabMail" name and logo remain trademarks (see `TRADEMARKS.md`); forks must rebrand.
- Contributions require a DCO sign-off (`git commit -s`).

---

## ADR-019: Popup Billing/Usage Nudge — Tier-Branched, Driven by Cached `/whoami` (TB port of ADR-IOS-044)

**Context:** When a TB user is throttled (a Basic user exhausts their monthly priority budget → slow queue; a BYOK user with no own key runs permanently on the slow shared queue per global ADR-025), nothing surfaced it — AI processing just silently slowed. iOS already solved this with an inbox banner (ADR-IOS-044). On TB the most obvious analog is the toolbar **popup** (the "agent window" entry point), which already renders `/whoami` usage and already has a keyed toolbar red-dot mechanism.

**Decision:**
1. **Pure decision in a leaf module.** `agent/modules/billingBanner.js` exports `decideBillingBanner({planTier, queueMode, quotaPercentage, hasOwnApiKeys}) → "upgrade" | "byok" | null` — a direct port of iOS `UsageThrottleStore.banner`. `isThrottled = queue_mode === "slow" || queue_mode === "blocked" || quota_percentage >= 100` (`QUOTA_THROTTLE_PERCENT`; "blocked" is TB's hard-cap state, strictly worse than slow). Branch: **Basic + throttled → "upgrade"**, **BYOK + no own key → "byok"**, **Pro / unknown / no-subscription → null**.
2. **No new network call.** The popup already fetches `/whoami` in `updateAuthStatus`; `updateBillingBanner(data)` reuses that same response. `hasOwnApiKeys` = `Object.keys(buildByokPayload()).length > 0` (parity with iOS `byokBundle != nil` — a tier with provider ≠ tabmail + key + model).
3. **Two popup banners** (`popup.html` `#upgrade-pro-warning` / `#byok-setup-warning`), styled like the existing `consent`/`setup`/`fts` warnings. "Upgrade to Pro" → `browser.windows.openDefaultBrowser("https://tabmail.ai/pricing")` (the site's canonical clean URL; same target as the config page's own Upgrade button). "Set up your API keys" → opens/focuses the Settings tab and **deep-links to the BYOK section**.
4. **BYOK deep-link** = one-shot `storage.local.tabmailPendingScrollByok` flag (mirrors iOS's `pendingScroll` UserDefaults). The popup sets it before opening Settings; `config/modules/init.js` consumes it after its load batch (fresh tab) AND via the existing `configStorageListener` (already-open tab), scrolling `#byok-settings` into view with a brief palette-based `.tm-deeplink-highlight` pulse, then clearing the flag.
5. **Proactive toolbar dot via a new `"billing"` warning key.** The popup `reportWarning("billing", …)` (immediate) AND persists `storage.local.tabmailBillingBanner` (`"upgrade"|"byok"|null`); `chat/background.js` reads it on startup + `storage.onChanged` → `setWarning("billing", …)` — same storage-relay pattern as `consent`/`server` (ZERO extra network). Cleared on sign-out / logged-out / Pro / healthy.

**Rationale:** Reusing the existing `/whoami` fetch + the keyed-warning infra means a minimal, parity-faithful addition with no new polling and no ADR-004 concerns. Branching on tier keeps each cohort's message + destination correct without a backend change. iOS is the de-facto reference for this specific feature.

**Consequences:**
- Banner/dot accuracy tracks `/whoami` cadence (recomputed on each popup open). A just-added BYOK key clears the nudge on the next popup open rather than instantly (iOS's `refreshKeyState()` immediacy was intentionally not ported — self-heals, acceptable for a non-urgent nudge).
- A new top-level warning condition is now a one-line `case` in `decideBillingBanner` + (if persisted) a storage key the background mirrors.
- Pure logic is unit-tested (`test/billingBanner.test.js`); the popup/config wiring is browser-API glue (not unit-tested, consistent with the rest of `popup.js`).

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
