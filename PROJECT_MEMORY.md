# TabMail Thunderbird Add-on - Project Memory

> **Thunderbird add-on specific knowledge.** Claude reads this before every task and updates it when discovering something new. For cross-cutting knowledge, see `../PROJECT_MEMORY.md`.

**Last updated:** 2026-02-16

---

## Directory Tree

```
agent/          # Email processing & classification
chat/           # Chat interface & tools
  tools/        # Tool implementations
    core.js     # Tool registry — update when adding tools
compose/        # Smart autocomplete
theme/          # Theming system
  palette/      # Color palette definitions
manifest.json   # MV3 manifest (version source of truth)
```

---

## Key Files

| What | Where |
|------|-------|
| Extension manifest | `manifest.json` (version source of truth) |
| Color palette | `theme/palette/palette.data.json` |
| Tool registry | `chat/tools/core.js` |
| Proactive checkin | `agent/modules/proactiveCheckin.js` |
| Notification config | `agent/modules/config.js` (`notifications` section) |

---

## Tool Inventory (Client-Side, v1.1.0+)

| Tool | Purpose |
|------|---------|
| `reminder_add` | Create a reminder (structured params: text, due_date, due_time) |
| `reminder_del` | Delete a reminder by text match |
| `task_add` | Create a scheduled task (recurring via schedule_days, or one-off via schedule_date) |
| `task_del` | Delete a scheduled task by text match |
| `change_setting` | Change notification settings (proactive toggle, window, advance, grace, task.enabled, task.advance_minutes) |

---

## Proactive Notifications (Deterministic Reachout)

Background agent that proactively reaches out to users via the chat window when reminders need their attention. **Fully deterministic — no headless LLM calls.**

**Two triggers:**
1. **New reminder formed** — when `onInboxUpdated()` detects a new reminder (hash change) or `reminder_add` is called, checks if the reminder qualifies (reply-tagged, due within N days). Template-based message with clickable email references.
2. **Due date/time approaching** — `browser.alarms` wake-up fires X minutes before a reminder's due date/time. Collects all qualifying reminders in the advance+grace window and sends a batch notification.

**Deduplication:** `reached_out` IDs stored per reminder hash, per trigger type. A reminder can notify once for "new_reminder" and once for "due_approaching".

**Replaced (v1.1.0):** `proactive_schedule_alarm`, `proactive_toggle_checkin` tools, `system_prompt_proactive_checkin.md`, `agent_proactive_checkin.md`, `expandSystemPromptProactiveCheckin` in `promptExpander.ts`.

---

## Server Tool Context

`sendChat()` and `sendChatWithTools()` in `llm.js` include `client_timezone` in the payload when tools are enabled. The backend passes this as `ServerToolContext { timezone }` to server tool implementations.

### Reminder Time Granularity
KB format: `Reminder: Due YYYY/MM/DD [HH:MM], <text>` or `Reminder: <text>` (no date). Parsed by `kbReminderGenerator.js`. Summary prompt extracts optional due time via `Reminder due time:` field.

---

## Known Quirks

- Auto-formatter may reorder imports — this is expected, don't fight it
- Hot-reloading requires proper listener/timer cleanup
- `runtime.onMessage` with async handlers breaks other listeners in Thunderbird — never use async there
- **Every KB operation must call `saveChatLog`** — Any function in `knowledgebase.js` that makes an LLM call (via `sendChatRaw`) must call `saveChatLog()` with the systemMsg and response afterward (and on error). This is the debug log mechanism.
- **Caret dead-zone before `tm-quote-separator`** — A caret at the END of the user's text, immediately before the `contenteditable="false"` `tm-quote-separator`, silently drops keystrokes (Gecko fires `beforeinput` but no `input`). Fixed by an editable `<br class="tm-edit-anchor">` injected before the separator via the shared `TabMail._appendQuoteSeparatorWithAnchor()` — used by BOTH separator-injection sites (`diff.js _applyFragmentToEditor` and `dom.js setEditorPlainText`); keep them unified through that helper. `tm-edit-anchor` is in all three skip-lists (extraction / cursor placement / offset counting) so it never affects the text model or offsets. Do NOT relax the separator's `contenteditable="false"` — it's load-bearing (prevents the older "text wipe" bug). See Recent Discoveries 2026-05-26.
- **Quote-collapse false positive on newsletter `>>` links** — `quoteAndSignature.js`'s bare-`>` fallback pattern (`type: "quoted"`, `fallbackOnly`) used to fire on a SINGLE line starting with `>`. HTML newsletters whose link text is `›› Read the full story` (rendered from `&gt;&gt;`) become a line starting with `>` in the DOM detection text, so a lone link collapsed nearly the whole email (`data-pattern="quoted"` marker visible in the rendered HTML). Fix: the `quoted` entry now has a `multiLineCheck` requiring a RUN of `config.quotedFallbackMinConsecutiveLines` (=2) consecutive `>`-prefixed lines — iOS parity with `AutoSizingHTMLView.swift` `collapseQuotesJS` (lines ~1156-1166), which already required 2 consecutive `>` lines. Both the plain-text path and the DOM/HTML render path go through `findBoundaryInPlainText`, so the one guard covers both. Real plaintext quotes (multi-line `>` runs) and all attribution/structured boundaries are unaffected (they're non-fallback candidates that win earlier anyway). Tests in `test/quoteAndSignature.test.js` ("quoted fallback requires consecutive '>' lines"). NOTE: a residual is possible if 2+ `>>` links are rendered as adjacent lines (e.g. a stacked feedback block `›› Loved it / ›› Needs improvement / ›› Not good at all`); iOS shares this since both dedupe consecutive newlines when building detection text — acceptable (small bottom-of-email block vs. the whole message).

---

## Recent Discoveries

### 2026-06-17 — Native FTS install prompt + `connectNative` availability gotcha
- **Gotcha:** `browser.runtime.connectNative("tabmail_fts")` does **NOT throw synchronously** when the native-messaging host manifest is missing — it returns a port and the failure arrives asynchronously via `port.onDisconnect` (with `port.error`). The old `fts/nativeEngine.js isNativeFtsAvailable()` used a connect+`disconnect()`+try/catch probe, so it returned `true` even when the helper was **not installed**. It had zero callers (latent bug).
- **Reliable signal:** module flag `ftsHostAvailable` in `nativeEngine.js` set from the **init handshake** outcome (`init`/`hello` RPC success or update-pending → `true`; `catch` / non-update `onDisconnect` → `false`; starts `null` = unknown). Exposed via `nativeFtsSearch.getHostAvailability()` → `engine.js` `getFtsHelperAvailable()`. `isNativeFtsAvailable()` was repointed to `ftsHostAvailable === true`.
- **Install-prompt feature (shown only when `available === false`; `null` never nags):** toolbar **red-dot icon** (`agent/modules/icon.js setActionWarning` swaps to `icons/tab-warning.svg` / `tab-greyed-warning.svg`, generated = base logo + a root-level red `<circle>`; set in `chat/background.js` after `initFtsEngine()`), **popup banner** `#fts-missing-warning` (`popup/popup.js updateFtsHelperPrompt()`), **settings CTA** `#fts-not-installed` (`config/modules/fts.js updateFtsStatus()`). All open `https://tabmail.ai/download#fts-helper` via `browser.windows.openDefaultBrowser`. **NOTE:** `browser.action.setBadgeText` does NOT render reliably in TB's unified toolbar (badge was invisible in testing) — the icon swap is the real signal; `setActionWarning` still sets a best-effort badge too. The icon is a function of BOTH auth state (greyed when signed out) and the warning flag, deduped by path in `applyActionIcon()`.
- **New background command `getFtsAvailability`** lives in `chat/background.js`'s always-registered `chatRuntimeMessageListener` — NOT in `engine.js attachCommandInterface()`, because that interface only attaches **after** `initNativeFts()` succeeds (so it's absent in exactly the missing-helper case we need to report). Returns `{ available: true|false|null }`.
- Download-page deep-link target `tabmail.ai/download#fts-helper` is the FTS Helper tab (see `PLAN_ATN_DISTRIBUTION.md` §1.6 / Phase 2). Tests: `test/icon.test.js` badge cases.

### 2026-06-10 — Weekly-scan corrections diagnosed: two distinct gap classes (not one bug)
Analysis of the 06/03 + 06/09 weekly maintenance corrections (event log unusable — `debugMode` off since 2026-05-17, so `debug_event_log` has zero events for any of the corrected messages; gaps Apr 8–22 / Apr 28–May 13 confirm it tracks debug toggling).
- **Class 1 — date-window blind spot (most `removedMissing`, all in `/[Gmail]/Bin` or INBOX):** Both reconcile Phase 1 & 2 AND the maintenance cleanup bound their windows by **message Date header** (`fromDate` / FTS `dateMs`), but staleness is a function of **when the change happened**. A message *sent* before the watermark window but *deleted externally* (iOS, Gmail web, server expunge of Bin) during a TB-off gap is invisible to boot reconcile; it waits up to a week for the weekly scan (3-week reach). Mirror gap on the add side: an arrival during the boot gap with an old/forged Date header (conference spam) is missed by Phase 1's `messages.query({fromDate})`. **Messages sent >3 weeks ago are NEVER cleaned/recovered** since the monthly scan is disabled by default. Structural; would need an `indexedAt`/`verifiedAt` column in native FTS to fix properly.
- **Class 2 — false-positive `removedMissing` (proven by data):** `calendar-d8decaee…@google.com` was removed as missing at `account3:/[Gmail]/Bin` on 06/03 and re-indexed at the **identical key** on 06/09 → it was in Bin all along. `cleanupMissingEntries` (maintenanceScheduler.js) has NO sync-quiet-period guard — boot reconcile explicitly added one for this exact race ("during sync, messages.query can return inconsistent snapshots… mark valid entries as stale"), and `runScheduledMaintenanceTick("startup")` can fire a due weekly scan immediately at TB launch while folder msgDBs are mid-sync. Account-liveness check is account-granular only (≥1 queryable folder), no per-folder protection for rarely-synced folders like Bin. A false removal then leaves the email **missing from search for up to a week** (boot reconcile won't re-add it once its Date falls behind the watermark window).
- **FIXED (same day, ADR-017):** (1) Verify-then-remove — `recheckMessageInFolder` in `agent/modules/utils.js` (fresh GLOBAL `messages.query({headerMessageId})`, verdicts present/absent/error); Phase 2.5 in `cleanupMissingEntries` AND `_reconcileCleanupStaleEntries` re-checks every stale candidate, removing only on a SUCCESSFUL query confirming absence from the indexed folder (present → keep, error → keep). New events: `maintenance_stale`/`reconcile_stale` × `recheck_present`/`recheck_error`. (2) Startup tick deferred — `_scheduleStartupTickWhenQuiet` in maintenanceScheduler polls (10s) until 60s sync-quiet (`getLastSyncEventMs()`) AND `isReconcilePending()` false, 10-min hard cap; both helpers newly exported from incrementalIndexer. Tests: `recheckMessageInFolder.test.js`, `maintenanceCleanupVerify.test.js`, `maintenanceStartupTick.test.js`, + verify cases in `ftsReconcile.test.js`. Class 1 (date-window blind spot) intentionally NOT addressed — needs native FTS `indexedAt` column.

### 2026-06-10 — Flaky "Unhandled Rejection: indexedDB is not defined" in full-suite vitest runs (fixed)
- `agent/modules/idbStorage.js` created `dbPromise` EAGERLY at module load; in vitest node workers (no `indexedDB` global) the executor's ReferenceError rejected a promise with no consumer → intermittent run-level "Unhandled Errors" attributed to whichever test file (usually `chatTools.test.js`) was running. **No caller try/catch can intercept this** — module evaluation succeeds, only the orphan promise rejects. Fix: defer creation to first `withStore()` call (`getDb()` memoized), so an awaiter exists the moment the promise is created. Pattern rule: **never create a module-level promise that can reject before any consumer attaches**. Regression tests: `test/idbStorage.test.js` (mutation-verified: 2/4 fail against the eager version).

### 2026-05-27 — PMQ processMessage path: infinite retry on a deleted message (fixed)
- **Symptom:** `[TMDBG HeaderResolver] ALL STAGES FAILED` → `[TMDBG PMQ] Could not resolve message … will retry` looping forever every ~10s after a message was **deleted** (not moved) from the inbox.
- **Root cause:** `agent/modules/messageProcessorQueue.js` `_processOneItem` — the processMessage (AI pipeline) path only evicts a "left inbox" item via the `isInboxFolder(header.folder)` check (`:384`), which needs a resolved `header`. A *deleted* message never resolves (all 3 resolver stages incl. the global query fail), so that check is never reached, and the `!weId`/`!header` branches returned `status:"retry"` unconditionally — no attempt counter, no confirmation query. The `tagCleanupOnLeaveInbox` path already had verify-then-drop (`cleanupVerifyAfterAttempts`); the processMessage path did not. Config `agentQueues.processMessage.maxResolveAttempts: 5` was declared with comment "…before dropping" but **was never read anywhere** — the drop-after-N intent was specced and never wired up.
- **Fix:** wired `maxResolveAttempts` into the processMessage path, mirroring the proven tagCleanup verify-then-drop. After N consecutive resolve failures it does a broad `browser.messages.query({ headerMessageId })`; drops ONLY when the query SUCCEEDS and returns empty (confirmed deleted from the whole account). A thrown query is treated as transient → keeps retrying (honors "never drop on resolve failure alone"). If the broad query unexpectedly finds the message (resolve glitch), it recovers and processes it. Updated the file's EVICTION POLICY header comment (added reason #4). Tests: `test/messageProcessorQueue.test.js` (5 cases — below-threshold no-query, confirmed-empty drop, throw=retry, found=recover, clean-resolve happy path).

### 2026-05-26 — BYOK (bring-your-own-key) implemented
- **Two configurable tiers, autocomplete fixed to TabMail.** TB BYOK exposes **Light** (wire `background`) + **Heavy** (wire `interactive`) — mirrors iOS. Autocomplete is NOT BYOK-configurable (latency-critical → always our Groq pool); the payload never carries an `autocomplete` tier. See `PLAN_BYOK_SUPPORT.md` §6.1.
- **Modules.** `agent/modules/byokStorage.js` (leaf: storage.local read/write + `assembleByokPayload`/`buildByokPayload` + `isModelAvailable` — pure, no config-layer imports so `llm.js` can import it without a cycle). `config/modules/byokSettings.js` (UI handlers + catalog/list-models fetch + labels/ZDR/cost copy). `config/modules/byokSmoke.js` (connectivity test). Wired into `config/modules/init.js` (change/click/input handlers + load batch) and the `<section id="byok-settings">` in `config.html`.
- **UI layout (iOS tier-rows + APIKeysView split, inline).** Tier blocks (`#byok-light-provider`/`#byok-heavy-provider` + per-tier model `<select>` + a "key needed" hint) carry only provider + model. A dedicated **API Keys subsection** (`#byok-api-keys` → `#byok-keys-list`) below renders **one card for EVERY provider, always shown** (not just in-use ones — matches iOS APIKeysView; lets users pre-enter keys, keys always visible so persistence is obvious). Key shared per provider → `byok.key.<provider>`. Cards built dynamically + idempotent (`byok-key-<provider>-{input,show,paste,test,test-result,remove,status,getkey,zdr}`). All handlers document-delegated (in `init.js`); routing helpers `tierFromElementId` + `providerFromKeyId`. "Test API Connectivity" + "Remove key" are per provider.
- **sendChatCompletions MUST stay exported** from `llm.js` — `byokSmoke.js` imports it. `test/byokImportContract.test.js` guards this (loads real modules, no mocks; stubs `browser`/`window`). It was briefly un-exported and only failed at runtime in TB, not in the (mocked) unit tests — see [[feedback_mock_hides_export_mismatch]].
- **Storage keys (`browser.storage.local`, NEVER `storage.sync`):** `byok.<tier>.provider` (light/heavy, default `tabmail`), `byok.<tier>.<provider>.model`, `byok.key.<provider>` (key shared per provider across tiers). `provider === 'tabmail'` is the off-state (no master toggle). Persists across restarts (profile-scoped), same store as the Supabase/OAuth tokens.
- **Keys NEVER leave the device — guarded on both sync axes:** (1) Firefox Sync — `byokStorage` uses `storage.local` only (never `storage.sync`); `test/byok.test.js` has a throwing `storage.sync` spy that fails if any path touches it (R-CLIENT-3). (2) TabMail device-sync (`deviceSync.js`, which DOES go off-device to the sync worker) syncs a fixed allow-list `VALID_FIELDS = composition/action/kb/templates/disabledReminders/taskCache` — no `byok.*`; guarded by a source-scan test asserting `deviceSync.js` never references `byok` (R-CLIENT-2). **Decision: NOT encrypted at rest** — a WebExtension has no OS keychain and any decrypt key would sit on the same disk (theater); parity with how TB itself + our OAuth tokens are stored. The achievable protection is "never synced/never sent to our servers" (above + §7), which IS enforced.
- **Request wiring.** `llm.js` injects `byok` into `payloadWithOptions` (the construction site, ~line 528): if the caller didn't already set `payload.byok` (the smoke does), it calls `buildByokPayload()`. Backend resolves the tier from the system prompt and ignores `byok` when empty → default installs send byte-identical requests. Snake_case `api_key`.
- **Gemini `thought_signature` needs NO TB fix (verified).** TB's tool loop (`llm.js:816-836` streaming / `938-958` non-streaming) round-trips `conversation_state` as opaque parsed JSON — it keeps the backend's assistant message verbatim and only `push`es tool-result messages, so Gemini's `extra_content.google.thought_signature` survives for free. The iOS equivalent bug was strictly a Swift typed-decode artifact.
- **Smoke uses TB's real prompts (NOT iOS's).** iOS forces `system_prompt_compose/summary`, which are NOT registered for the Thunderbird platform — TB only registers `system_prompt_agent` (tier **heaviest** → BYOK `interactive`) and `system_prompt_fsm` (tier **medium** → BYOK `background`). The smoke validates the key + model access via `POST /byok/list-models`, then runs ONE real `/completions/chat` via `system_prompt_agent` forcing `date_to_day` and checks `byok_routed` + the day-name fragment. No backend changes, no `/byok/test`.
- **Tests:** `test/byok.test.js` (payload shape, autocomplete-never-emitted, storage round-trip, model-access, smoke evaluate/run).

### 2026-05-26
- **Compose caret insertion dead-zone (Tab-accept at end of message)** — A collapsed caret at the END of the user's last text node, immediately before the `contenteditable="false"` `tm-quote-separator`, is a Gecko insertion dead-zone: `beforeinput` fires but no `input` happens, so keystrokes are silently dropped. Surfaced after Tab-accepting an autocomplete suggestion at the very end of the message. The empty-text-node "anchor" added in commit `83b7be8` (which fixed the earlier *text wipe* — typed text being absorbed into the CE=false separator and discarded during extraction) does NOT satisfy Gecko; only a real **editable `<br>`** does. Fix: inject `[text-node][<br class="tm-edit-anchor">][separator]`, moving one `<br>` OUT of the separator (`brCount-1`) so total line count / sent-email spacing is unchanged; `tm-edit-anchor` added to all three skip-lists (`_getCleanedEditorTextWithOptionsRecursive`, `_setCursorByOffsetInternal`, `traverseAndCount`) so it contributes zero to text/offsets. **Two injection sites existed and the fix initially missed one**: `diff.js _applyFragmentToEditor` (autocomplete render) and `dom.js setEditorPlainText` (inline-edit / Cmd+K). Both now go through the shared `TabMail._appendQuoteSeparatorWithAnchor(fragment, quoteBoundaryNode, editor, logLabel)` (defined in `diff.js`) so they can't diverge again. Only the FIRST keystroke after a *programmatic* caret placement needs the anchor — once Gecko is live-editing it maintains a valid caret, so fast typing isn't affected. Tests: `test/cursorQuoteGuard.test.js` (skip-list + injection structure), `test/autocompleteLifecycle.test.js`. Commit history: diagnostics `587b08c` → fix `590e174` → refactor `af68f87` → remove-diagnostics `67b5d91`.

### 2026-05-15
- **Boot reconcile bounded by persistent watermark, not FTS-newest date** (ADR-016, `PLAN_RECONCILE_WATERMARK.md`). `browser.storage.local.fts_reconcile_watermark = { version: 1, fromMs, completedAtMs }`. `_getReconcileFrom` in `fts/incrementalIndexer.js` reads it and returns `completedAtMs - 1 day`, or a 7-day fallback if missing/corrupt/future-dated. Phase 2 writes the watermark only on clean completion (no exception, `accountsSkipped === 0`). A 10-min heartbeat (`_heartbeatBumpWatermark`) advances `completedAtMs` during runtime; never touches `fromMs`; refuses to create a watermark; skipped if drain queue is stalled or `_indexerDisposed` is true. Heartbeat re-checks `_indexerDisposed` AFTER the storage read to prevent stale writes after a `dispose()` mid-read. Diagnosed from `tabmail_event_log_2026-05-15T16-18-13-464Z.json` — 11 stale entries dated 2026-05-04 → 2026-05-11 had been caught by weekly maintenance, not boot reconcile, because the boot reconcile window had collapsed to ~1 day after the listener indexed new mail during the 60s quiet wait. Follow-up: `PLAN_MAINTENANCE_SCAN_SPEEDUP.md` for refactoring the weekly scan to share the streaming validator.

### 2026-02-03
- **Session history architecture (v1.2.9)**: Prior-session chat messages are no longer sent as actual conversation turns to the LLM. Instead, `init.js` serializes them into text and injects via `recent_chat_history` field in the system message. Backend expands this into a `chat_converse_history` prompt section (user+ack pair). This ensures the LLM treats prior sessions as background memory, not active conversation.

### 2026-02-01
- Added `reminder_add`, `reminder_del`, `change_setting` client-side tools (v1.1.0)
- Added IANA timezone to KB reminder format (`[America/Vancouver]` suffix), timezone-aware due date resolution in proactive checkin
- Added "Notified" badge to Reminders tab in prompts settings page
- Replaced LLM-based proactive check-in with deterministic reachout
- Enabled `sendChat()` to support server-side tool execution via `enableServerTools` option
- Removed: `proactive_schedule_alarm`, `proactive_toggle_checkin` tools, proactive check-in prompts, prompt expander function

---

## Cross-Instance IMAP Tagging

- **"First compute wins"**: Before LLM action computation, `getAction()` checks for existing `tm_*` IMAP tags (from another TM instance). If found, adopts the tag without LLM.
- **Gmail REST API fallback**: `importActionFromImapTag()` and `getAction()` also check Gmail label membership via `readActionFromGmailFolders()` when IMAP keywords return nothing. This detects tags set by iOS (which uses Gmail REST API labels, not IMAP keywords).
- **Gmail label sync**: `gmailLabelSync.js` uses `tmGmailLabels` experiment for OAuth2 tokens → Gmail REST API. `syncGmailTagFolder()` writes labels, `readActionFromGmailFolders()` reads them. Labels are created/maintained as hidden (`labelListVisibility: "labelHide"`).
- IDB cache import: `importActionFromImapTag()` in `tagHelper.js` — idempotently writes IMAP tag (or Gmail label) action into IDB cache for thread aggregation.
- Entry points that check: `getAction()` (semaphore path), `processCandidatesInFolder()` (startup scan), `onNewMailReceived` (new mail).
- Override: context menu manual tagging always wins. Debug "Recompute Action" passes `forceRecompute: true` flag through `processMessage` → `getAction()` to bypass IMAP tag check.
- Tag watcher (`_syncActionCacheFromMessageTagsToInboxCopies`): updates IDB cache when IMAP tag *differs* from cached action (external change from another instance); skips when they match (idempotent/self-tag).

---

## Header chip (preview pane)

- **Experiment**: `theme/experiments/tmMessageHeaderChip/` — passive painter for the iOS-style action chip in `#expandedButtonsBox` of the message preview header. Plan: `PLAN_HEADER_CHIP.md`. Decision: ADR-014.
- Reads `tm-action` mork prop on the displayed `gMessage`; never writes action state. `_actionFromKeywords_MHC` is the legacy fallback for pre-Phase-2b messages.
- Chip carries `tm-action-chip tm-header-action-chip tm-action-X` plus inline `--tag-color` (for `:focus-visible` outline) and `data-tm-we-msg-id`. The marker class `tm-header-action-chip` lets the doc-level click delegation scope to header chips and never accidentally fire on a card chip.
- Click → `tmMessageHeaderChip.onActionChipClick` event → MV3 `_onHeaderChipClick` (in `theme/background.js`) → `performTaggedAction({id: weMsgId})`. **Bypasses `triggerTagActionKey`** so the action targets the chip's own message regardless of selection drift; works in standalone `messageWindow.xhtml` (no `mailTabs` selection).
- Refresh triggers (all → `tmMessageHeaderChip.refreshAll()` via the unified `_refreshChips` fan-out):
  1. `messageDisplay.onMessagesDisplayed` (MV3, `theme/background.js`).
  2. `actionCache.setAction` / `clearAction` (await `_writeActionToHdr` first to avoid the parent-process IPC race that would otherwise let the painter read the OLD prop value — see `PLAN_HEADER_CHIP.md` §6).
  3. `actionCache.clearActionByUniqueKey` — symmetric coverage only; today's caller (`onMoved.js:288`) is actually covered by trigger 1 because the new-folder hdr has no mork prop.
  4. Internal MutationObserver on `#headerSubjectSecurityContainer` (50 ms debounced) → recovers after charset/view-source/body-as toggles wipe the header subtree.
- **Known limitation:** `agent/modules/contextMenus.js:230` `clearActionCache` removes IDB keys directly via `idb.remove`, bypassing `actionCache.js` entirely AND not clearing the mork prop. As a result the right-click "Remove TabMail tags" path leaves a stale `tm-action` mork prop and the chip will keep painting after `refreshAll` until the message is re-classified or moved. Pre-existing inconsistency; not addressed by the chip plan. Affects BOTH the header chip AND the multi-message-view chip.
- **CSS refactor in tmTheme/theme.css** (one-time, landed with header chip plan): the four `tr[is="thread-card"].tm-action-{reply,archive,delete,none} .tm-action-chip` rules were relaxed to `.tm-action-chip.tm-action-X` so they paint the card-row chip, the header chip, AND the multi-message-view chip. All three chip surfaces carry the base + per-action class already; row-level tinting is unaffected (separate rules at `theme.css:704-771`).

## Multi-message-view chip (collapsed-thread / multi-select summary)

- **Experiment**: `theme/experiments/tmMultiMessageChip/` — passive painter for the iOS-style action chip on each `<li>` row of `multimessageview.xhtml`. Plan: `PLAN_MULTI_MESSAGE_CHIP.md`. Decision: ADR-015.
- Reads `tm-action` mork prop per-row hdr. Per-row hdr is resolved from `gMessageSummary._msgNodes` (the upstream TB script's own dict; see `multimessageview.js:122-130, 704`) by reverse-mapping `<li>` → hdrs, then disambiguating multi-selection-summarizer rows by `<li>.dataset.messageId` (the thread-head's RFC Message-ID per `multimessageview.js:259`).
- Chip carries `tm-action-chip tm-multi-action-chip tm-action-X` plus inline `--tag-color` and `data-tm-we-msg-id`. Distinct marker class from the header chip so click delegations don't cross-fire (defensive — different docs anyway).
- Click → `tmMultiMessageChip.onActionChipClick` → MV3 `_onMultiMessageChipClick` → `performTaggedAction({id: weMsgId})`. Same direct-acting contract as the header chip.
- **Structural difference from the header chip:** multimessageview is a TRANSIENT document (only loaded when user clicks a collapsed thread / multi-selects). `attachToWindow` finds zero docs at extension load. The single per-doc workhorse `_attachAndPaintDoc` (idempotent attach helpers + paint) is called from BOTH `attachToWindow` AND `_repaintAll`, so the transient doc gets attached lazily on first `onMessagesDisplayed`. List-rebuild MO is rooted at `#content` (parent of `#messageList`) per `multimessageview.js:137`'s `replaceChildren()` semantics. See `PLAN_MULTI_MESSAGE_CHIP.md` §4.1, §4.4.
- `actionCache._refreshChips` (renamed from `_refreshHeaderChip` when this surface landed) fans out to BOTH `tmMessageHeaderChip.refreshAll` and `tmMultiMessageChip.refreshAll` in parallel via `Promise.all` after the IPC-race-avoidance `await _writeActionToHdr`.
- **Open followup (out of scope of this surface):** `tmMessageHeaderChip` attaches delegation+MO only inside `attachToWindow`, not inside `_repaintAll`. If about:message is ever recreated on URL change (e.g., toggle to multimessageview and back), the new doc has no delegation. Today it works (TB likely caches about:message), but the multi-msg pattern (idempotent attach inside refresh) is the safer one. Worth a future commit to mirror.

## Action state is mork-prop-only (Phase 0 onwards)

- TabMail no longer writes `tm_*` IMAP keywords / Gmail labels / Exchange categories anywhere. See `agent/modules/tagHelper.js:1-13` header: "Post Phase 0: ADD-path tag writes ... all removed. Action state lives in IDB only."
- Action state is propagated via `actionCache.setAction` → `_writeActionToHdr` → `tmHdr.setAction` → `hdr.setStringProperty("tm-action", …)`. The mork prop is the canonical local-render state; IDB is the cross-device cache.
- `onMoved.js`/`tagCleanup.js` `browser.messages.update({tags: ...})` calls REMOVE legacy `tm_*` keywords, never add them — they're scrubbing leftover server pollution.
- **Legacy `_actionFromKeywords*` fallback** survives in 4 experiments — `tmMessageListCardView`, `tmMessageListTableView`, `tmMessageHeaderChip`, `tagSort` — for messages tagged before Phase 0. All four are now marked `@deprecated`. The new `tmMultiMessageChip` (and any future surface) skips this fallback outright. Remove the deprecated readers from the older experiments once legacy `tm_*` keywords have decayed out of users' inboxes.

---

## tagSort: must save/restore selection around `view.sort()`

`theme/experiments/tagSort/tagSort.sys.mjs` calls `view.sort(BY_DATE, …)` then `view.sort(BY_CUSTOM, …)` from its delayed-resort path. We previously had a JS msgHdr-based save/restore around these calls, removed it because per-folder threaded INBOX (`nsMsgThreadedDBView::Sort`) preserves selection internally via `SaveAndClearSelection`/`RestoreSelection` (`mailnews/base/src/nsMsgThreadedDBView.cpp:301, 324, 343, 390`).

That removal silently broke the **Unified Inbox / smart-folder INBOX** path. `nsMsgXFVirtualFolderDBView` inherits `Sort` from `nsMsgSearchDBView`, which for `kThreadedDisplay | kGroupBySort` delegates to `nsMsgGroupView::RebuildView` (`mailnews/base/src/nsMsgSearchDBView.cpp:1108`, `mailnews/base/src/nsMsgGroupView.cpp:493`). `RebuildView` only saves the **current** selected msgKey — not the full ranges, and the symptom was the highlighted card silently going away ~30 s after a click (the `DELAYED_SORT_MS` window in `tagSort.sys.mjs:69`).

Fix landed: wrap the `view.sort()` calls in `applySort` and `applyDateOnlySort` with TB's canonical URI-based `threadPane.saveSelection()` / `threadPane.restoreSelection({ notify: false })` (`mail/base/content/about3Pane.js:5765, 5814`). This is the same contract TB itself uses around `cmd_expandAllThreads`/`cmd_collapseAllThreads` (`about3Pane.js:7300, 7310`). `notify:false` skips re-firing the "select" event so the message pane doesn't redraw.

**Do not re-remove this wrapper just because per-folder INBOX seems to work without it** — the unified-inbox path needs it.

---

## Knowledge Gaps

- [ ] Full inventory of experiment APIs currently in use
- [ ] Theme palette structure details and how colors are resolved
