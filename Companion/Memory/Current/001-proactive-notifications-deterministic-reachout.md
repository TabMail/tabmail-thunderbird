# Proactive Notifications (Deterministic Reachout) — triggers, dedup, what v1.1.0 replaced

> Routed out of `PROJECT_MEMORY.md` § Proactive Notifications (Deterministic Reachout) by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
Background agent that proactively reaches out to users via the chat window when reminders need their attention. **Fully deterministic — no headless LLM calls.**

**Two triggers:**
1. **New reminder formed** — when `onInboxUpdated()` detects a new reminder (hash change) or `reminder_add` is called, checks if the reminder qualifies (reply-tagged, due within N days). Template-based message with clickable email references.
2. **Due date/time approaching** — `browser.alarms` wake-up fires X minutes before a reminder's due date/time. Collects all qualifying reminders in the advance+grace window and sends a batch notification.

**Deduplication:** `reached_out` IDs stored per reminder hash, per trigger type. A reminder can notify once for "new_reminder" and once for "due_approaching".

**Replaced (v1.1.0):** `proactive_schedule_alarm`, `proactive_toggle_checkin` tools, `system_prompt_proactive_checkin.md`, `agent_proactive_checkin.md`, `expandSystemPromptProactiveCheckin` in `promptExpander.ts`.
<!-- END PRESERVED BLOCK -->
