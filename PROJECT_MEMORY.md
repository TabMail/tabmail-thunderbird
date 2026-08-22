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
| `change_setting` | Change user-facing settings (proactive toggle, window, advance, grace, task.enabled, task.advance_minutes, **compose.autocomplete_enabled**, calendar.default_event_duration_minutes) |

---

## Proactive Notifications (Deterministic Reachout)

- **[Triggers, dedup, and what v1.1.0 replaced](Companion/Memory/Current/001-proactive-notifications-deterministic-reachout.md)** — new-reminder-formed (`onInboxUpdated()` hash change / `reminder_add`) + due-approaching (`browser.alarms`, advance+grace batch); dedup by `reached_out` id per reminder per trigger type.

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
- **[Caret dead-zone before `tm-quote-separator`](Companion/Memory/Current/002-caret-dead-zone-before-quote-separator.md)** — Gecko fires `beforeinput` but no `input`, silently dropping keystrokes; fixed by an editable `<br class="tm-edit-anchor">` via the shared `TabMail._appendQuoteSeparatorWithAnchor()`. Do NOT relax the separator's `contenteditable="false"` — it prevents the older text-wipe bug.
- **[Quote-collapse false positive on newsletter `>>` links](Companion/Memory/Current/003-quote-collapse-false-positive-newsletter-links.md)** — the bare-`>` fallback fired on a SINGLE line, so one `›› Read the full story` link collapsed the email; now needs a run of `quotedFallbackMinConsecutiveLines` (=2), iOS parity.

---

## Recent Discoveries

### 2026-08-22 — Native FTS optimize is one full, parameterless call
- **[Detail](Companion/Memory/Current/029-native-fts-optimize-one-shot-contract.md)** — helper `optimize` ignores parameters and returns only `{ok:true}` after a full writer-thread FTS5 optimize. Maintenance must never invent slice budgets, progress, size, or convergence; malformed acknowledgments fail the optimize phase closed while the completed maintenance repair remains successful.

### 2026-08-13 — Native FTS signing-key cutover uses one bridge release + reinstall fallback (ADR-023)
- **[Detail](Companion/Decisions/Active/adr-023-native-fts-routine-signing-key-cutover.md)** — v0.11.1 is the dual-key bridge; the pending signer was promoted on 2026-08-13 after the bridge and Thunderbird fallback were verified. v0.11.2 removes the previous public key. Thunderbird 1.7.2+ gives pre-0.11.1 helpers a distinct `unsupported` state and reinstall CTA that preserves the local index and needs no Thunderbird restart.

### 2026-08-21 — UID/FTS membership proof becomes cooperative and restart-safe (ADR-022)
- **[Detail](Companion/Decisions/Active/adr-022-startup-uid-fts-membership-fingerprints.md)** — bounded lazy pages feed UTF-8-byte/SQLite-`BINARY` digests; unchanged verified IMAP folders use a UID-only/native fast proof, with changed/unknown/non-IMAP folders taking the full exact projection. Memo v3 distinguishes before-first from key 0 and binds cursor/backoff to exact proof/epoch. The writer-preferred coordinator includes manual cleanup and coalesces exclusive mutation attempts into one post-release invalidation; its generation-owned private retry makes the durable marker succeed before normal scheduling wakes, cancels on runtime disable, and re-arms retained intent on same-generation re-enable. Slow fingerprints/storage stay outside short fences, and page/digest boundaries preempt. Fresh canonical inventory prunes removed identities and empty inventory still cleans orphans; legacy colon-overlap keys fail closed pending issue #20. One phase-tagged active-folder proof avoids repeated large-folder scans without arbitrary cache limits; rejected/abandoned drain work releases it across bounded folder fairness while retaining the durable queue. Race-safe pending markers, shared `IMAPDeleted|Expunged` proof membership, ≥50%-idle scheduling, and aggregate-only live/persisted telemetry preserve huge-profile noninterference. Bodies stay queue→drain→`SafeGetFull`; native helper 0.11.0.

### 2026-07-09 — Quote collapse swallowed the ENTIRE message on inline `<font>` boundaries (MailPlug/Zimbra) — block-walk prior-content guard
- **[Detail](Companion/Memory/Current/004-quote-collapse-inline-font-boundary.md)** — detection was correct (`data-pattern="original-message"`); the Step 2 block-ancestor walk climbed past the inline `<font>` to `div.moz-text-html`. Test-mock gotcha: `getComputedStyle` returned `display:block` for every tag but SPAN/A, making the bug class structurally untestable.

### 2026-07-08 — BYOK model picker: "Recommended" (catalog) + "All models (from your API key)" (live)
- **[Detail](Companion/Memory/Current/005-byok-model-picker-recommended-plus-live.md)** — `populateModelSelect`/`computeModelGroups`/`dedupeLiveModels`; **never overwrite a non-empty saved model** ("absent from one fetch" is not evidence it's gone); `_liveModelsEpoch` stops a stale in-flight fetch poisoning the cache; `_populateGeneration` re-checked after EVERY await.

### 2026-07-04 — Summary `recipient_status` (cc detection, positive evidence)
- **[Detail](Companion/Memory/Current/006-summary-recipient-status-cc-positive-evidence.md)** — address literally in `ccList`, not in To, user not the author; omitted when unsure (the SMTP envelope is discarded at delivery, so not-in-To proves nothing). `senderFilter.classifyRecipientStatus`; `_extractAllEmails` is global per entry.

### 2026-07-03 — Remove-side folder reconcile landed (Phase 1c, ADR-021 / PLAN_FOLDER_SET_RECONCILE.md)
- **[Detail](Companion/Memory/Current/007-remove-side-folder-reconcile-phase-1c.md)** — `_runFolderReconcile` + `fts_folder_recon_memo`; headerMessageIds extracted by PREFIX STRIP, never `parseUniqueId` (it mis-splits ':'-bearing folder paths → false removal); `recheck_error` blocks the memo; orphan sweep only on `totalAll > Σ`.

### 2026-07-01 — Weekly-scan mass corrections (06/29: 352 indexed) = the ADD-side Class-1 date-window blind spot at scale (event log off → inferred, high confidence)
- **[Detail](Companion/Memory/Current/008-weekly-scan-mass-corrections-add-side-blind-spot.md)** — Phase 1's `messages.query({fromDate})` keys on the **message Date header**, and the watermark had advanced to "now", so lazily-synced Gmail folders dated 06/17–06/23 fell outside every boot window. Same decorrelation as ADR-IOS-042.

### 2026-06-30 — WhatsApp (ChatLink) linking disabled in Settings UI (v1.6.10)
- **[Detail](Companion/Memory/Current/009-whatsapp-chatlink-linking-disabled.md)** — `WHATSAPP_LINKING_DISABLED = true` in `config/modules/chatlink.js`; the background bridge and `chatlink/modules/*` are left INTACT. **Re-enabling needs the flag AND the `#whatsapp-link-row` markup reverted.** Not a master kill-switch.

### 2026-06-28 — `normalizeUnicode` dash rule is now line-start-only (utils.js)
- **[Detail](Companion/Memory/Current/010-normalize-unicode-dash-rule-line-start-only.md)** — the load-bearing reason is **LLM response parsing** (models emit `– item` where the parsers expect `- item`), not cosmetics; inline em-dashes stay. iOS `AIHelpers.swift` mirrors it; iOS compose/reply is deliberately NOT normalized.

### 2026-06-27 — Compose autocomplete: master on/off + Shift+Esc kill-switch + Settings section + more-visible banner (v1.6.8)
- **[Detail](Companion/Memory/Current/011-compose-autocomplete-master-toggle-shift-esc.md)** — single source of truth `storage.local.autocompleteEnabled` read by three surfaces; gate point is `core.js triggerCorrection`; Shift+Esc REPURPOSED from toggle-diff-overlay; one reused `state.reenableFetchTimer` collapses the double re-fetch.

### 2026-06-24 — Popup billing/usage nudge (Upgrade to Pro / Set up your API keys) — ADR-019
- **[Detail](Companion/Memory/Current/012-popup-billing-usage-nudge.md)** — `decideBillingBanner(...)`, port of iOS `UsageThrottleStore.banner`. **NOT A BUG: a Pro account over quota shows NO banner** (intentional, iOS parity). Zero extra network; `isZeroQuotaPlan` renders "N/A of monthly quota"; debug override checked FIRST. **Addendum 2026-08-18: `isZeroQuotaPlan` re-keyed `plan_tier === "BYOK"` → `limit_cost_cents === 0`** (wire quota signal, not a growing tier list) so Trial/any future zero-priority-budget plan gets N/A with no client release; strict `===`, absent field ⇒ false; iOS still keys on tier — keep the two BEHAVIORALLY aligned.

### 2026-06-17 — Native FTS install prompt + `connectNative` availability gotcha
- **[Detail](Companion/Memory/Current/013-native-fts-install-prompt-connectnative-gotcha.md)** — `connectNative()` does NOT throw synchronously when the host manifest is missing (failure arrives via `port.onDisconnect`), so the old probe returned `true` with no helper; use the init-handshake status (`ftsHostStatus`, with legacy boolean availability derived from it). `setBadgeText` does not render in TB's unified toolbar — the icon swap is the real signal.

### 2026-06-17 — Proactive `setup` + `server` toolbar warnings (issue #12)
- **[Detail](Companion/Memory/Current/014-proactive-setup-and-server-toolbar-warnings.md)** — sharing `setupChecks.js` between popup and background is mandatory (divergent computation flips the dot on every popup open); `llm.js` must NOT call `setWarning` directly (different module instance) — it relays via storage. Health does not flip on 401/403/429.

### 2026-06-18 — Native-FTS helper auto-detect: NO Thunderbird restart needed
- **[Detail](Companion/Memory/Current/015-native-fts-helper-auto-detect-no-restart.md)** — hosts resolve at `connectNative()` time, so a mid-session install is picked up without a restart; do NOT tell users to restart or wire this into `restartForUpdate`. `recheckAvailability()` bypasses the 60 s cooldown.

### 2026-06-10 — Weekly-scan corrections diagnosed: two distinct gap classes (not one bug)
- **[Detail](Companion/Memory/Current/016-weekly-scan-corrections-two-gap-classes.md)** — Class 1: windows bound by **message Date** but staleness is a function of **when the change happened** (structural). Class 2: `cleanupMissingEntries` had no sync-quiet guard — a message in Bin all along was removed 06/03, re-indexed at the identical key 06/09. Fixed by ADR-017.

### 2026-06-10 — Flaky "Unhandled Rejection: indexedDB is not defined" in full-suite vitest runs (fixed)
- **[Detail](Companion/Memory/Current/017-eager-module-level-promise-rejection-idbstorage.md)** — `idbStorage.js` built `dbPromise` at module load, so the ReferenceError rejected a promise with no consumer and surfaced as run-level errors blamed on an unrelated test file; **no caller try/catch can intercept it**. Rule: never create a module-level promise that can reject before a consumer attaches.

### 2026-05-27 — PMQ processMessage path: infinite retry on a deleted message (fixed)
- **[Detail](Companion/Memory/Current/018-pmq-infinite-retry-on-deleted-message.md)** — `maxResolveAttempts` was declared with a "…before dropping" comment and never read anywhere; eviction needed a resolved header, which a deleted message never has. Now mirrors tagCleanup verify-then-drop: drop ONLY on a successful empty broad query; a throw keeps retrying.

### 2026-05-26 — BYOK (bring-your-own-key) implemented
- **[Detail](Companion/Memory/Current/019-byok-implemented-thunderbird.md)** — Light→`background`, Heavy→`interactive`, autocomplete never BYOK. **Keys never leave the device, guarded on both sync axes** (`storage.local` only + `deviceSync.js` `VALID_FIELDS` allow-list, R-CLIENT-2/3). NOT encrypted at rest, deliberately. `sendChatCompletions` must stay exported from `llm.js`.

### 2026-05-26
- **[Detail](Companion/Memory/Current/020-compose-caret-insertion-dead-zone-tab-accept.md)** — only a real editable `<br class="tm-edit-anchor">` satisfies Gecko; the empty-text-node anchor (`83b7be8`) does not. One `<br>` moves OUT of the separator so spacing is unchanged. **Two injection sites existed and the fix initially missed one.**

### 2026-05-15
- **[Detail](Companion/Memory/Current/021-boot-reconcile-watermark-not-fts-newest.md)** — `fts_reconcile_watermark = {version, fromMs, completedAtMs}`; the heartbeat advances `completedAtMs` only, never `fromMs`, and refuses to CREATE a watermark. The old window collapsed to ~1 day because the listener indexed new mail during the 60 s quiet wait.

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

- **["First compute wins", Gmail REST label fallback, tag watcher](Companion/Memory/Current/022-cross-instance-imap-tagging.md)** — `getAction()` adopts an existing `tm_*` IMAP tag / Gmail label instead of calling the LLM (`importActionFromImapTag`, `readActionFromGmailFolders`, `gmailLabelSync.js`). **⚠ Flagged STALE by the 2026-06-18 liveness sweep below** — `readActionFromGmailFolders` is comment-only post-ADR-IOS-036. Not corrected here (compaction is a move, not an edit).

---

## Header chip (preview pane)

- **[Passive painter, refresh triggers, reuse-branch tooltip rule](Companion/Memory/Current/023-header-chip-preview-pane.md)** — `tmMessageHeaderChip` reads the `tm-action` mork prop and never writes; clicks carry `data-tm-we-msg-id` and bypass `triggerTagActionKey`. **The idempotent-update branch must refresh `title` too** — a 2026-06-25 bug froze the tooltip on all three painters.

## Multi-message-view chip (collapsed-thread / multi-select summary)

- **[Per-`<li>` painter on the TRANSIENT multimessageview doc](Companion/Memory/Current/024-multi-message-view-chip.md)** — `tmMultiMessageChip`; per-row hdr from `gMessageSummary._msgNodes` disambiguated by `<li>.dataset.messageId`; `_attachAndPaintDoc` must be called from `_repaintAll` too because the doc does not exist at extension load.

## Action state is mork-prop-only (Phase 0 onwards)

- **[No `tm_*` keywords / Gmail labels / Exchange categories are written anywhere](Companion/Memory/Current/025-action-state-is-mork-prop-only.md)** — state flows `actionCache.setAction` → `_writeActionToHdr` → `tmHdr.setAction` → `hdr.setStringProperty("tm-action", …)`; `messages.update({tags})` calls only REMOVE legacy keywords. `@deprecated` `_actionFromKeywords*` survives in 4 experiments.

---

## tagSort: must save/restore selection around `view.sort()`

- **[Wrap `view.sort()` in `saveSelection()` / `restoreSelection({notify:false})`](Companion/Memory/Current/026-tagsort-save-restore-selection-around-sort.md)** — per-folder threaded INBOX preserves selection internally, but the Unified Inbox path (`nsMsgXFVirtualFolderDBView` → `nsMsgGroupView::RebuildView`) saves only the current msgKey. **Do not re-remove this wrapper because per-folder INBOX seems fine without it.**

---

## Experiment API Inventory (24 APIs) + Upstream Candidacy

- **[Full 24-API inventory, the upstream process, and the Tier A/B/C verdicts](Companion/Memory/Current/027-experiment-api-inventory-upstream-candidacy.md)** — the design-principle filter (high-level, no Thunderbird-specific detail, no magic numbers) is the real gate. Tier A: `glodaSearch`, `tmCalendar`, `tmHdr` flags, `threadMessages`, `messageSelection`, `tmMsgNotify`.

### Liveness sweep verdicts (2026-06-18, evidence-backed)
- **[Per-experiment DEAD/KEEP/LIVE verdicts with evidence](Companion/Memory/Current/028-experiment-liveness-sweep-verdicts-2026-06-18.md)** — `threadTooltip`/`threadMessages` DEAD; `tmWebFetch` **KEEP** (an earlier "REPLACEABLE" verdict was WRONG — arbitrary-URL CORS bypass + `describeNetworkError()`); `glodaSearch` LIVE (native FTS stores no `References`/`In-Reply-To`); `staleRowFilter` KEEP pending TB 145 evidence.

## Knowledge Gaps

- [ ] Theme palette structure details and how colors are resolved
