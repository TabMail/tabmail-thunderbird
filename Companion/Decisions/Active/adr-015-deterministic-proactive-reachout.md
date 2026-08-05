# ADR-015: Deterministic Proactive Reachout (Replace Headless LLM)

> Routed out of `DECISIONS.md` § ADR-015 (first of two ADR-015 ids in this file) by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
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
<!-- END PRESERVED BLOCK -->
