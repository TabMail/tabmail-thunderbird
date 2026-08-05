# Experiment API Inventory (24 APIs) + Upstream Candidacy (Tier A/B/C)

> Routed out of `PROJECT_MEMORY.md` § Experiment API Inventory (24 APIs) + Upstream Candidacy by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
> Full inventory of `experiment_apis` in `manifest.json` (each = `<area>/experiments/<name>/{schema.json,*.sys.mjs}`). Compiled 2026-06-18 for the "can these become real upstream MV3 APIs?" question. Upstream process: prototype as experiment → file issue + contribute generalized version to `github.com/thunderbird/webext-experiments` (MPL2, **design principles: high-level, NO Thunderbird-specific details, no magic numbers**, lint) → on accept, Bugzilla bug in product **Thunderbird / component "Add-Ons: Extensions API"** with schema+impl → land in comm-central via Phabricator → "Since Thunderbird NN" → deprecate experiment. The design-principle filter is the real gate: most of ours are TabMail-specific (`tm-action`, action chips, 108px row height) and must be generalized to the *capability primitive* underneath before they'd be accepted.

**Tier A — strong upstream candidates (generic capability, clean shape, others want it):**
- `glodaSearch` (chat/) — gloda FTS + cross-folder conversation threading. No stock equivalent. → propose `messages` full-text + conversation API.
- `tmCalendar` (chat/) — calICalendarManager CRUD + recurrence split + duration preservation. **Aligns with ACTIVE upstream work** (webext-experiments/calendar; March 2026 digest: "enhance the Calendar API ahead of the next ESR"). Best first contribution — push our recurrence/CalDAV CRUD into the existing draft.
- `tmHdr` flags portion (`getReplied`/`getFlags`/`getHasRe`) — stock `MessageHeader` exposes read/flagged/junk but NOT replied/forwarded. Small clean addition to the `MessageHeader` type.
- `threadMessages` (theme/) — nsIMsgThread ancestor/sibling walk. Fold into a conversation API alongside glodaSearch.
- `messageSelection` (chat/) — thread-pane selection + `onSelectionChanged`. `mailTabs.getSelectedMessages()` exists; **gap = the change event**. Propose the event only.
- `tmMsgNotify` (agent/) — msgAdded/Classified/Deleted/MoveCopy bridge. **Largely covered by stock `messages.onNewMailReceived/onMoved/onCopied/onDeleted/onUpdated` already** — verify the residual gap (msgsClassified, payload/timing) before proposing.

**Tier B — possible but needs generalization/negotiation:**
- `tmHdr` action portion (`setAction`/`getAction` = mork string props) — needs a generic `messages.{get,set}CustomProperty` (persisted per-message annotation). Widely wanted; must be generic, not `tm-action`.
- `tmPrefs` (gui/) — raw `Services.prefs` bridge is a NON-STARTER upstream (security). Only the intent-level bits are candidates: per-server check interval → accounts API; threaded/unthreaded → `mailTabs` view settings.
- `keyOverride` (theme/) — mail-window Tab/Shift+Tab/hotkey capture; partial overlap with stock `commands` API.

**Tier C — poor upstream candidates (TabMail-specific UI/CSS, workarounds, or platform issues):**
- Passive painters / chrome-DOM injection: `tmTheme`, `tmMessageListCardView`, `tmMessageListTableView`, `tmMessageHeaderChip`, `tmMultiMessageChip`, `tmPreviewGate`, `threadTooltip`, `threadPaneDisplayToggle` — the legitimate generic need underneath (row tint, chips, snippets, card/table toggle) maps to a **"message-list custom column / row decoration" API**; `tagSort` already rides `ThreadPaneColumns.addCustomColumn`, so a WebExtension custom-column API is the realistic (large) generalization.
- `staleRowFilter`, `tmPreviewGate` — TB bug/flicker workarounds → correct upstream contribution is the **bug fix**, not an API.
- `tmKeepAlive` (keepalive/) — MV3 background-lifetime hack; platform issue, solve via TB's event-page/persistent-background model, not a custom API.
- `tmUpdates` (gui/) — addon-update check + app restart; restart intentionally not exposed; partial overlap with `management`.
- `tmTweaks` (gui/) — spaces toolbar + system fonts; chrome-level, too app-specific.
- `tmWebFetch` (chat/) — CORS-bypass fetch; **likely NOT needed** — stock MV3 `fetch` works from the background with declared `host_permissions` (`<all_urls>` for the web_read tool). Audit whether the experiment can just be deleted.
- `tmGmailLabels` (agent/) — OAuth2 token + Gmail REST (CORS bypass). Security-sensitive (raw token); TB unlikely to expose. Also **partly vestigial** post-ADR-022/ADR-IOS-036 (action tags are local-only now) — confirm remaining readers before investing.
<!-- END PRESERVED BLOCK -->
