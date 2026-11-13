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

## Amendment (2026-11-13, #387): the hour the clocks repeat carries its UTC offset

**Context:** The night the clocks go back, the naive digits of one hour (half an hour in a few zones) name two
moments. A naive time inside that hour cannot say which pass it means, so an occurrence starting in one pass
could not be told from one in the other, and a bare time two occurrences share named neither.

**Decision:** Naive ISO 8601 stays the wire format for every other time. A time whose digits name two moments
on the clock it is printed on is printed with its UTC offset in parentheses, `2026-11-01T01:30:00 (UTC-4)`
then `2026-11-01T01:30:00 (UTC-5)` (label `UTC±H[:MM]`, `UTC+0` for zero). The calendar edit and delete tools
take that form back as the one moment it names: as `recurrence_id` or `exdates_add`, the occurrence starting
then; as an edit's `start_iso`/`end_iso`, that exact moment, whatever `timezone` the edit names, through the
same conversion and refusals as any other time. A bare time that names one occurrence in each pass is
answered with both values and an instruction to ask the user; nothing is written. Any other note in
parentheses is not read. The backend's calendar read, edit and delete texts state the form from protocol
1.11.6.

**Consequences:**
- The tool layer's printer and parser live in `chat/modules/repeatedHour.js`; the calendar bridge has
  standalone twins (`shownIso`, `parseShownIso`, `momentNamedBy`), pinned alike by
  `test/calendarRepeatedHourOffset.test.js`.
- A suffixed value is never given to `new Date`, which may skip the note and read another moment.
- `calendar_read` rows sort by instant, not by text.
- Detail: `Companion/Memory/Current/050-calendar-recurrence-one-format.md` (split point paragraph).
