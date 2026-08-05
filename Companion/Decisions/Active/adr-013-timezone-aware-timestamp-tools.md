# ADR-013: Tools That Accept Timestamps Must Be Timezone-Aware

> Routed out of `DECISIONS.md` § ADR-013 by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `DECISIONS.md`.

<!-- BEGIN PRESERVED BLOCK -->
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
<!-- END PRESERVED BLOCK -->
