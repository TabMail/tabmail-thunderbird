# Calendar recurrence: the tools read a rule in the fields they write

The calendar tools used to read a rule as a raw RRULE string (`RRULE: FREQ=WEEKLY;UNTIL=20991101T065959Z`)
and write it as structured fields (`freq`, `interval`, `count`, `until`, `byDay`, `byMonthDay`, `byMonth`,
`wkst`). Restating a rule meant translating between the two, including turning a UTC `UNTIL` instant back into
a date, so a wrong translation silently changed the series (#261). The iOS app's calendar tools follow the
same design (tabmail-ios #421).

## The one format

- **Producer:** the bridge (`tmCalendar.sys.mjs`, `recurrenceFieldsOfItem`) emits `recurrence` on every
  `queryCalendarItems` row and on `getCalendarEventDetails`. It is null when the event does not repeat. The
  raw `recurrenceRRule` field is gone.
- **Printing:** `chat/modules/recurrence.js` prints it as `recurrence: {"freq":"WEEKLY","byDay":["MO"],"until":"2099-10-31"}`
  in `calendar_event_read`, and as ` (↻ {...})` in the `calendar_search`/`calendar_read` listing.
- **Only the stated fields are shown.** Thunderbird never stores `INTERVAL=1` or `WKST=MO` (ical.js `Recur.toString`
  omits both), so neither is ever shown.
- **The rule is read from `recurrenceInfo` only** (`ruleValuesOfItem` / `rruleOfItem`, used by both read tools and
  by the split): the fields describe its first rule item. **Thunderbird 140-160 expands EVERY rule item** (no
  `MAX_RULES` before comm-central 161), and an imported EXRULE becomes one more of them: `CalRecurrenceRule` is
  always positive (`isNegative: false`, "We don't support EXRULE anymore") and its `icalProperty` always names
  itself RRULE. That holds before comm-central bug 2082832 (2026-10-28: "Keep EXRULE properties as EXRULE, and
  don't expand them"; "Only expand the first recurrence rule"); from that change on an EXRULE reads back as a
  negative EXRULE, `isRuleItem` skips it, a restatement keeps it, and it never reaches `other`. So a series another app wrote with two RRULEs (RFC 5545: SHOULD NOT) or an RFC 2445 EXRULE repeats
  by both. Each further rule is shown in `other` as `RRULE:<value>`, so restating the fields (which writes one rule)
  is refused and `{}` clears them all. A split of such a series keeps only the capped first rule on the earlier part
  (#265). Correction: this note used to say an
  EXRULE is never expanded and is kept by a write; Thunderbird's own source says otherwise. RRULE is a
  promoted property of `calItemBase`: Thunderbird neither imports it into the item's properties when parsing nor
  serializes it, so `getProperty("RRULE")` returns only an in-memory echo a caller set, which survives `clone()` and
  Thunderbird's own event dialog and can name an older rule. TabMail no longer sets it.
- **`until` (read)** is the last day the stored bound admits, read the way Thunderbird (ical.js) expands the rule.
  UNTIL is inclusive (RFC 5545 3.3.10). A `Z` value is that instant; a DATE or floating value is its digits at
  offset 0 (ical.js compares both at offset 0). In the frame occurrences are expanded in (the start's zone for a
  timed zoned event, offset 0 for an all-day or floating one), the bound's day is the last day when its time of day
  is at or after the start's time of day, otherwise the day before; an all-day series ends on the bound's day.
  Converting the instant into a zone and taking its date was wrong whenever the bound's time is before the
  occurrence time, e.g. every split cap (split minus one second) read one day late.
- **BYSETPOS:** one weekday at one position folds to its ordinal (`BYDAY=TU;BYSETPOS=2` becomes `2TU`) only where
  BYDAY is the only day filter: MONTHLY, or YEARLY with at most one BYMONTH, and never with a BYMONTHDAY. BYSETPOS
  counts within the days the other parts name, so `BYDAY=FR;BYMONTHDAY=1,...,14;BYSETPOS=-1` is the second Friday,
  while `-1FR` with that BYMONTHDAY names no day at all. Elsewhere
  (`FREQ=YEARLY;BYMONTH=3,9;BYDAY=TU;BYSETPOS=2` is only the 2nd Tuesday of March) BYSETPOS stays in `other`.
- **`other`:** anything else goes there, e.g. BYWEEKNO, BYYEARDAY, BYHOUR, BYSETPOS with several days, or a FREQ the schema has no value for. The read line then adds "the edit tool cannot express these; omit recurrence to keep the rule".

## Writing

- **Validation at the tool boundary only:** `recurrenceArgError` runs in `calendar_event_create` and `calendar_event_edit` before the confirmation card. It refuses an invalid field with `recurrence.<field> has an invalid value "<value>": <allowed>`. The checks:
  - `freq` is in the enum and is required unless the object is `{}` on an edit; on create `{}` is refused too
    (there is no rule to clear, so it would make a one-off event out of a request to repeat), and create's messages
    never suggest `{}`;
  - `interval` and `count` are positive integers;
  - only the eight fields (and `other`, refused below) are accepted; any other key (`bySetPos`, `byHour`) is refused
    rather than reaching Thunderbird's schema check after the card;
  - `until` is a real plain date `YYYY-MM-DD` (the last day of the series); a date-time is refused, because it
    cannot be stored in the start's value type (RFC 5545 3.3.10) and the read side only ever shows a plain date;
  - `byDay` matches `^[+-]?([1-9]|[1-4][0-9]|5[0-3])?(MO|TU|WE|TH|FR|SA|SU)$`;
  - `byMonthDay` is ±1..31, `byMonth` is 1..12, and `wkst` is a day code;
  - `other` cannot be written.

  Fields are checked one by one, not in combination: `count` with `until`, a positioned `byDay` outside MONTHLY or
  YEARLY or beyond ±5 in MONTHLY, and `byMonthDay` with WEEKLY are written as given (#275).

  A non-object `recurrence` (e.g. the RRULE string the read tools printed before) is refused by create and edit
  alike; create used to drop it silently and make a single event.

  Because invalid input is refused there, the bridge's `buildRRuleValueFromDetails` passes values through without its own checks.
- **`{}` clears the rule (edit only):** `recurrenceInfo` becomes null. It used to default to WEEKLY. On create it is refused. `null` in an edit is the same as omitting the field.
- **Plain-date `until`** is the end of that day:
  - an all-day series gets a bare DATE;
  - a floating event gets `T235959`;
  - otherwise it is 23:59:59 in the event's zone, rendered as UTC.

  So the named day's occurrence stays in the series, and reading the stored value gives the same day back.
- **One writer of a rule, `setRuleOnItem`,** used by an edit (`applyRecurrenceToItem`), the split's cap and the
  split's new series. It replaces only the RRULE items in the item's own `recurrenceInfo` (iterating a copy:
  `getRecurrenceItems` is live, and deleting while iterating skips the next item) and creates a `recurrenceInfo`
  only when there is none. On an edit, EXDATE/RDATE items and changed occurrences stay with the series; they used
  to be dropped by a fresh `recurrenceInfo`. The split's cap still starts from a fresh `recurrenceInfo` (below).
- **Split ("this and following"):** unchanged in what it keeps. The capped earlier part gets a fresh
  `recurrenceInfo` holding only the capped rule (through `setRuleOnItem`), so it keeps none of its EXDATEs, RDATEs,
  changed occurrences or further rules, and no RDATE from the split on (one is not bounded by UNTIL) is left beside
  the new series. The new series starts as a fresh event with only a rule. Keeping the earlier part's exceptions and
  rules and carrying later ones over is #265. The capped rule is not read back and compared with the one written: Thunderbird re-serializes a rule
  in its own part order (FREQ, COUNT, INTERVAL above 1, the BY-parts, UNTIL, then WKST unless MO), so such a
  comparison refused every split of a rule with a week start. A rebuild of the earlier part that throws refuses the
  split before anything is written.
- **Restated rules with `other` parts are refused,** for every edit scope: an edit that restates the rule of a
  series whose stored rule has `other` parts is refused before the card by `otherPartsRefusal`, because restating
  would drop those parts. The stored rule is fetched with the edit's `calendar_id`; when it cannot be read, a
  restatement is refused too. `{}` (stop repeating) is allowed.
- **A `recurrence_id` targets one occurrence** unless `edit_scope` is `this_and_following`, even with `edit_scope`
  `all`, and a rule set on an occurrence never takes effect (#274).
- **No rule comparison.** Neither client compares a restated rule with the stored one above the provider boundary. TB writes the rule through to Thunderbird's calendar.

## How it is pinned

- `test/calendarRecurrenceFormat.test.js` runs under TZ=America/Vancouver, with the real bridge in `node:vm` via `test/helpers/calendarBridgeHarness.js`. The harness's `fakeRecurrenceInfo` and `recurrenceItem` model RRULE/RDATE/EXDATE items by `icalProperty.propertyName` (RDATE/EXDATE with their `date`), changed occurrences (`exceptions`), and a LIVE `getRecurrenceItems` list; `fixedZone` and `FLOATING_ZONE` model a zone other than the user's and floating time; the calendar has `addItem` and creatable events, so the real create and split run.
- The read and round-trip tests assert OCCURRENCES, not strings: `lastDayAdmitted` expands a daily series the way ical.js does, independently of the bridge, for four start kinds (user's zone, another zone east of UTC, floating, all-day) and bounds from every writer. A test that compares the fields read back with the fields written stays green when both sides use the same wrong frame.
- The harness models what Thunderbird does with a rule: `fakeRecurrenceRule` re-serializes its value as
  CalRecurrenceRule does (`canonicalRule`), a cloned event clones its recurrence info, and appending to a recurrence
  info without a base item throws as `appendRecurrenceItem` does.
- MONTHLY folds are pinned by occurrence too: `monthlyDays` enumerates RFC 5545 days independently of the bridge, and
  a rule read and written back must name the same days over 24 months, or restating it must be refused.
- `test/calendarTools.test.js` covers the refusal wiring before the card.
- Bridge accessor calls (`untilDayFromIcs`, `untilForRRule` → `getTimezoneService`; `setRuleOnItem` → `getIcsService`) are listed in the exhaustive census in `test/calendarServiceAcquisition.test.js`.
