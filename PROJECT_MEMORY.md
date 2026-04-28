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

---

## Recent Discoveries

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
- Refresh triggers (all → `tmMessageHeaderChip.refreshAll()`):
  1. `messageDisplay.onMessagesDisplayed` (MV3, `theme/background.js`).
  2. `actionCache.setAction` / `clearAction` (await `_writeActionToHdr` first to avoid the parent-process IPC race that would otherwise let the painter read the OLD prop value — see `PLAN_HEADER_CHIP.md` §6).
  3. `actionCache.clearActionByUniqueKey` — symmetric coverage only; today's caller (`onMoved.js:288`) is actually covered by trigger 1 because the new-folder hdr has no mork prop.
  4. Internal MutationObserver on `#headerSubjectSecurityContainer` (50 ms debounced) → recovers after charset/view-source/body-as toggles wipe the header subtree.
- **Known limitation:** `agent/modules/contextMenus.js:230` `clearActionCache` removes IDB keys directly via `idb.remove`, bypassing `actionCache.js` entirely AND not clearing the mork prop. As a result the right-click "Remove TabMail tags" path leaves a stale `tm-action` mork prop and the chip will keep painting after `refreshAll` until the message is re-classified or moved. Pre-existing inconsistency; not addressed by the chip plan.
- **CSS refactor in tmTheme/theme.css** (one-time, landed with chip plan): the four `tr[is="thread-card"].tm-action-{reply,archive,delete,none} .tm-action-chip` rules were relaxed to `.tm-action-chip.tm-action-X` so they paint both the card-row chip and the header chip. The chip carries both classes already; row-level tinting is unaffected (separate rules at `theme.css:704-771`).

---

## Knowledge Gaps

- [ ] Full inventory of experiment APIs currently in use
- [ ] Theme palette structure details and how colors are resolved
