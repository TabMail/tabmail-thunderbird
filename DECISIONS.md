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

## Template for New Decisions

```markdown
## ADR-XXX: [Title]

**Context:** [What situation led to this decision?]

**Decision:** [What did we decide?]

**Rationale:** [Why?]

**Consequences:**
- [Trade-offs, both positive and negative]
```
