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
  is refused and `{}` clears them all. A split of such a series divides every rule at the split (#265, below).
  Correction: this note used to say an
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
  Near a daylight saving change that wall-clock reading can be off by the zone's shift: Thunderbird's own zone conversion
  (`CalDateTime.getInTimezone`, ical.js `convertToZone`) can move the instant near the autumn change, and a bound
  in the skipped spring interval reads that much late with the instant kept (a split cap on the change day, for a start
  in the hour before it, read as the change day). So for a timed series the day is shown only when Thunderbird's
  own comparison, by instant, agrees: the stored bound and the bound the edit tool would write for that day
  (`untilForRRule`) each keep that day's occurrence at the start's time of day and not the next day's
  (`occurrenceInstantOn`, `resetTo` in the start's frame, as ical.js's iterator compares `last` with UNTIL).
  Otherwise the bound stays in `other`, and restating the rule is refused. (An earlier version checked only that
  the converted value kept its `nativeTime`; that guarded the conversion, not the day, and missed the spring gap.)
  The day is read at the start's time of day, so a rule that also repeats at other times of day (BYHOUR,
  BYMINUTE, BYSECOND, or a FREQ finer than DAILY, all of which the fields cannot write) keeps its UNTIL in
  `other`: its last occurrence can fall on another day (e.g. `FREQ=DAILY;BYHOUR=9,17` with a start at 17:00 and
  a bound at 10:00 read one day early). Only other apps write these parts.
- **BYSETPOS** is always shown in `other`, never folded into an ordinal byDay, so restating such a rule is refused.
  RFC 5545 makes `BYDAY=TU;BYSETPOS=2` and `BYDAY=2TU` the same within a month, but Thunderbird 140 to 158 (the
  BYSETPOS code before its 159 rewrite) expand the BYSETPOS form with an extra first occurrence when the series
  start is not itself an occurrence, and never select day 1 at positions -4 and -5. A fold correct on one version
  dropped or added occurrences on another. (Earlier versions of this change folded one weekday at one position for
  MONTHLY and one-month YEARLY rules; the fold was deleted rather than narrowed, as the simplest safe reading.)
- **`other`:** anything else goes there, e.g. BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR, or a FREQ the schema has no value for. The read line then adds "the edit tool cannot express these; omit recurrence to keep the rule".

## Writing

- **Validation at the tool boundary only:** `recurrenceArgError` runs in `calendar_event_create` and `calendar_event_edit` before the confirmation card. It refuses an invalid field with `recurrence.<field> has an invalid value "<value>": <allowed>`. The checks:
  - `freq` is in the enum and is required unless the object is `{}` on an edit; on create `{}` is refused too
    (there is no rule to clear, so it would make a one-off event out of a request to repeat), and create's messages
    suggest neither `{}` nor leaving recurrence out to keep a rule (create's `other` refusal says to create the
    series in the calendar app; edit's says to omit recurrence to keep the stored rule);
  - `interval` and `count` are positive integers;
  - only the eight fields (and `other`, refused below) are accepted; any other key (`bySetPos`, `byHour`) is refused
    rather than reaching Thunderbird's schema check after the card;
  - `until` is a real plain date `YYYY-MM-DD` (the last day of the series); a date-time is refused, because it
    cannot be stored in the start's value type (RFC 5545 3.3.10) and the read side only ever shows a plain date;
  - `byDay` matches `^(?:[+-]?(?:[1-9]|[1-4][0-9]|5[0-3]))?(MO|TU|WE|TH|FR|SA|SU)$`: a sign only before a position,
    as RFC 5545's BYDAY grammar has it (`+MO` and `-TU` are refused);
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
- **One writer of a rule value, `writeRuleItem`,** which writes a value into one rule item in place (so the rule
  keeps its position; the first is the one the fields describe). `setRuleOnItem` (an edit, through
  `applyRecurrenceToItem`, and a new rule for a split's following part) creates one rule through it and replaces
  only the RRULE items in the item's own `recurrenceInfo` (iterating a copy: `getRecurrenceItems` is live, and
  deleting while iterating skips the next item), creating a `recurrenceInfo` only when there is none. On an edit,
  EXDATE/RDATE items and changed occurrences stay with the series; they used to be dropped by a fresh
  `recurrenceInfo`. The split rewrites each rule item through `writeRuleItem` (below).
- **Split ("this and following") keeps the series (#265).** The two parts together make exactly the occurrences the
  series made. Both are built before anything is written:
  - **Split point: `occurrenceNamedBy`, the one resolver for every edit that names an occurrence** (a split, and an
    edit of one occurrence, #285). `recurrence_id` is the occurrence's `start_iso` as the read tools print it: in
    the user's zone whatever `timezone` the edit names (that zone is for the edit's new times), an all-day
    occurrence as its date; the read tools print an occurrence's `recurrence_id` as that same value. A floating
    time is printed at its own digits on the user's clock (`asShown` relabels it into the user's zone before the
    read paths take its epoch; ical.js gives floating offset 0, so its raw epoch read in the user's zone named
    another time, which the edit then could not match). Thunderbird's own expansion decides which occurrence starts
    there: `recurrenceInfo.getOccurrences` over `OCCURRENCE_LOOKUP_REACH_MS` either side (every rule, RDATE and
    EXDATE, and a changed occurrence at its own time), matched with `calIDateTime.compare` (by instant; a DATE by
    date; floating time by its digits). No occurrence, or more than one, is refused and nothing is written:
    `getOccurrenceFor` makes up a proxy for any time, and saving that adds an occurrence the series never had (#285).
    The series divides at the occurrence's RECURRENCE-ID (its slot), read in the series' own zone (a RECURRENCE-ID
    can be stored in another, e.g. UTC, and the following part's rule expands in its start's zone), so a changed
    occurrence splits where it belongs and the following part starts in the series' zone. When the edit has more
    than one calendar to look in, the first that holds the event decides; a refusal there is the answer. A split at or before the first
    occurrence is refused (edit the whole series). Superseded: `occurrenceIdInSeries` read
    `recurrence_id` in the series' own zone, which is not what the read tools print for a series in another zone,
    and an RDATE scan stood in for the existence check, which a new rule waived.
  - **Each rule (`splitRule`):** a rule whose UNTIL is before the split stays on the earlier part unchanged and is
    not carried on; a COUNT rule whose count is used up before the split likewise. Otherwise the earlier part's copy
    is capped (UNTIL/COUNT dropped, `UNTIL` = split minus one second, or the day before for an all-day series, from
    the DATE's own digits, `dayDigitsFrom`/`dayDateFrom`: a DATE's epoch time depends on its zone, 034) and
    the following part's copy keeps UNTIL, with COUNT reduced to the occurrences still to come (`getOccurrences`
    from the start up to the split). A rule is expanded from its event's start, so a carried rule must make an
    occurrence at the split (`aligned`, checked with `getOccurrences` over [split, just after]); otherwise the split
    is refused, since the following part would not keep its dates. A new rule for the following part (`recurrence`)
    replaces the carried rules, so their alignment does not matter; the split point is an occurrence either way. A
    rule's UNTIL is compared with the split by `compare`, never by epoch time: an all-day UNTIL names a date, and
    west of UTC a DATE's day starts after the UTC midnight that date names, so an epoch comparison dropped a last
    occurrence on the split day.
  - **The earlier part keeps its last occurrences, in Thunderbird's expansion:** after the cap, the earlier part's
    occurrences over the two days before the split (`OCCURRENCE_LOOKUP_REACH_MS`) must be the series' there, by
    RECURRENCE-ID, or the split is refused before anything is written. ical.js compares a rule's UNTIL by instant
    (`Time.compare`, `toUnixTime`: an occurrence in its start's zone, a DATE at midnight there; a bare-date or
    floating UNTIL at offset 0), so an all-day start that carries a zone west of UTC falls after a bare-date UNTIL
    of its own day and the cap at the day before the split drops it. Only all-day dates the assistant wrote carry a
    zone (#303); a split whose day before is no occurrence (a weekly rule) is unaffected.
  - **Dates and changed occurrences:** EXDATEs, RDATEs and changed occurrences before the split stay on the earlier
    part; those from the split on move to the following part (an RDATE is not bounded by UNTIL, so one left on the
    earlier part would still happen). The following part's recurrence info is a clone of the series' (Thunderbird's
    `CalRecurrenceInfo.clone` clones items and exceptions) with `item` set to the new event, which makes it the
    changed occurrences' parent; the calendar's id assignment renames them (`onIdChange`).
  - **Thunderbird has no "this and following" primitive** (`MODIFY_FOLLOWING` throws `NS_ERROR_NOT_IMPLEMENTED`),
    so the bridge builds the two parts itself.
  - **A time change** (`start_iso`/`end_iso`/`all_day`) applies to the following part only, after its recurrence is
    attached, so Thunderbird's `onStartDateChange` moves its EXDATEs, RDATEs, each non-COUNT rule's UNTIL and the
    changed occurrences' RECURRENCE-IDs by the same amount, as an edit of a whole series does (the changed
    occurrences keep their own times). The new times are read in the user's zone (or the edit's `timezone`) and
    written in the series' frame (`toCalIDateTimeInFrameOf`, for every edit through `applyDurationPreservation`):
    a zoned series' own zone at the same instant, a floating series at the user's clock digits, kept floating (the
    inverse of `asShown`), as Thunderbird's event dialog keeps an event's zone. Read straight in the user's zone,
    a new start moved the series into it: its rule expanded there (a Thursday east of UTC can be a Wednesday in
    the user's zone), and `onStartDateChange`'s offset between a floating and a zoned start was the user's UTC
    offset plus the change, so excluded, added and changed dates no longer met the occurrences (#301). An all-day
    value, and an edit to or from all day, are written as read. `all_day` alone
    changes nothing: the start and end it applies to come from `start_iso`/`end_iso`, so a change to or from
    all-day comes with them (and `all_day` is not one of the fields that make a split at a changed occurrence
    refused, below).
  - **`exdates_add`** go to the part their RECURRENCE-ID falls in (see *Excluded dates* below), added before the
    time change so they move with the part.
  - **A split at an occurrence that was changed on its own** carries that occurrence into the following part with
    its own times and fields, so an edit's title, location, description, busy/free, attendees, start or end
    (`SPLIT_FIELDS_OF_AN_OCCURRENCE`, a start equal to its own included) would not reach it while the edit
    reported success. Such an edit is refused, naming the way that works: change the occurrence alone
    (`this_only`), then this and the following ones from the next occurrence. `exdates_add`, `recurrence` and
    `all_day` alone are allowed there (the edit's `organizer_email` never reaches the split, below; listing it
    refused every such split, since the edit tool fills it in for every edit that names a calendar).
  - **The following part is a copy of the series (#291),** made as Thunderbird copies an event (`calendar-clipboard.js`
    paste: `item.clone()` and a new id; nothing else is stripped): `master.clone()` with its id cleared, which the calendar
    fills on `addItem` (`onIdChange` then renames its changed occurrences); its recurrence info is replaced by the
    series' from the split on. It keeps every property and parameter, reminder, category, attachment and
    relation, the organizer, and each attendee with every parameter. Until #291 it was a blank `calIEvent` given only
    the title, times, location, plain description, busy/free, attendee addresses and organizer, so everything else was
    lost on every split since the split first shipped. Provider identity lives outside the item (CalDAV href/etag in
    the calendar's metadata, keyed by the id), so a new id is enough. The edit's fields change only what they name:
    `""` removes a location; a new description is written through `descriptionText` (Thunderbird's setter drops the
    HTML version, the `ALTREP` parameter) and removes `X-ALT-DESC`, `X-MOZ-HTML` and `X-MOZ-ALT-DESC`, as an edit does.
    A changed attendee list (`patch.attendees`, delta already applied) keeps the series' entry for each address still
    on it (matched without regard to case, as `getAttendeeById`), in the list's order, and adds the rest at
    `NEEDS-ACTION` with `RSVP=TRUE`. The organizer is the series' (copied with it, every parameter kept): the edit's
    `organizer_email`, which the edit tool fills with the calendar's own address whenever it has a `calendar_id`, is
    not passed to the split, as an edit of a whole series never sets one. Superseded: the split used to write it as
    the organizer, which dropped the organizer's parameters (`SENT-BY`, `SCHEDULE-*`) and, on a meeting someone else
    organizes, named the user as its organizer.
  - **Attendee answers on the following part: one rule shared with iOS (Thunderbird parity).** Kept, unless the split
    reschedules the following occurrences: start, end or duration, all-day vs timed, a zone change (even at the same
    instant: the later occurrences then follow the new zone's daylight saving time, and Thunderbird's
    `prepareSequence` hashes DTSTART with its TZID, so it counts as a change), a new rule other than the one carried
    on, or location. Then every attendee but the
    organizer (same address as ORGANIZER) gets `PARTSTAT=NEEDS-ACTION` and `RSVP=TRUE`, other parameters kept. A value
    the edit only restates is no change (compared with the split occurrence's slot: `sameTime` on start and end, by zone and instant, the
    new rule's values against `splitRule`'s carried values, the location string); a new rule differing from the
    carried one only in form counts as a change, the safe direction (asking again only asks; a kept `ACCEPTED` on a
    moved meeting claims an answer nobody gave). Not a reschedule: title, description, busy/free, `exdates_add`
    (removing occurrences asks nobody anything new). The earlier part is untouched. Sources: Thunderbird never resets
    the STORED copy on a save (no PARTSTAT write in the editor, `CalTransactionManager` or `prepareSequence`);
    `cal.itip.prepareSequence` bumps SEQUENCE on a change to DTSTART, DTEND, DURATION, DUE, RDATE, RRULE, EXDATE,
    STATUS or LOCATION, and `CalItipMessageSender.buildOutgoingMessages` then sends every attendee at `NEEDS-ACTION`
    with `RSVP=TRUE`; RFC 6638 3.2.8 has a scheduling server reset every attendee but the organizer on a reschedule.
    The client does it here because the following part is a NEW resource, which a server's reset (for a changed one)
    never reaches. Core Thunderbird has no this-and-following edit to compare with (`promptOccurrenceModification`'s
    MODIFY_FOLLOWING throws NS_ERROR_NOT_IMPLEMENTED). This is the one place a rule is compared, and only to decide
    whether answers are asked again (see *No rule comparison* below). Superseded: the first version kept the answers for
    a start relabelled into another zone at the same instant, which on a series kept in a zone with other daylight
    saving dates kept `ACCEPTED` for occurrences an hour from the times answered.
  - **Refused, writing nothing:** an EXRULE (a negative rule, comm-central 161+) the split cannot keep; a rule
    whose end or count cannot be read; a series that repeats by added dates alone (no rule to divide); a change
    to an occurrence that was changed on its own (above); an `exdates_add` value that names no occurrence; a rule item that cannot be rewritten (an immutable item throws); a time
    change between all-day and timed when the following part carries an EXDATE, RDATE or changed occurrence, or
    (without a new rule) a rule with UNTIL (RFC 5545 needs them in the start's value type, and moving the start
    keeps theirs); and `recurrence: {}` at an occurrence that was changed on its own (the one event left would
    lose its changes).
  - The capped rule is not read back and compared with the one written: Thunderbird re-serializes a rule in its own
    part order (FREQ, COUNT, INTERVAL above 1, the BY-parts, UNTIL, then WKST unless MO), so such a comparison
    refused every split of a rule with a week start.
- **Excluded dates (`exdates_add`) name occurrences by their start (#265, #295),** the same contract as
  `recurrence_id`: each value is an occurrence's `start_iso` as the read tools print it, in the user's zone,
  resolved by `exdatesNamedBy` through `occurrenceNamedBy` in the series as it is before the edit. Thunderbird
  names an occurrence by its RECURRENCE-ID, which for a changed occurrence is its slot, not its start, so the
  occurrence is removed at its RECURRENCE-ID, in the series' zone, with Thunderbird's own `removeOccurrenceAt`
  (`addExdateToItem`): the EXDATE, and the changed copy removed with it. An EXDATE alone is not enough:
  `CalRecurrenceInfo.calculateDates` applies one only to a query whose range (its start moved back by the series'
  duration) holds its date, so a changed occurrence moved to another day still showed on that day. A value that names no occurrence (or more than one) is
  refused before anything is written, for every scope. On the whole series and on a split the EXDATEs are added
  before the time change, so a value names the occurrence the user read and `onStartDateChange` moves the EXDATE
  with the series (the order #295 reported reversed). An edit of one occurrence still writes them to the series
  (#298: not saved while the parent item is immutable). Superseded: the values were parsed as raw times and
  written as given after the time change, so a moved occurrence named by its printed start was not removed, and
  on a moved series the value named a time no occurrence had any more.
- **Restated rules with `other` parts are refused,** for every edit scope: an edit that restates the rule of a
  series whose stored rule has `other` parts is refused before the card by `otherPartsRefusal`, because restating
  would drop those parts. The stored rule is fetched with the edit's `calendar_id`; when it cannot be read, a
  restatement is refused too. `{}` (stop repeating) is allowed.
- **A `recurrence_id` targets one occurrence** unless `edit_scope` is `this_and_following`, even with `edit_scope`
  `all`, and a rule set on an occurrence never takes effect (#274).
- **No rule comparison.** Neither client compares a restated rule with the stored one above the provider boundary. TB writes the rule through to Thunderbird's calendar. (The split's attendee rule, above, compares in the bridge only to decide whether answers are asked again; it never refuses or skips a write.)

## How it is pinned

- `test/calendarRecurrenceFormat.test.js` runs under TZ=America/Vancouver, with the real bridge in `node:vm` via `test/helpers/calendarBridgeHarness.js`. The harness's `fakeRecurrenceInfo` and `recurrenceItem` model RRULE/RDATE/EXDATE items by `icalProperty.propertyName` (RDATE/EXDATE with their `date`), changed occurrences (`exceptions`), and a LIVE `getRecurrenceItems` list; `fixedZone` and `FLOATING_ZONE` model a zone other than the user's and floating time; the calendar has `addItem` and creatable events, so the real create and split run.
- The read and round-trip tests assert OCCURRENCES, not strings: `lastDayAdmitted` expands a daily series the way ical.js does, independently of the bridge, for four start kinds (user's zone, another zone east of UTC, floating, all-day) and bounds from every writer. A test that compares the fields read back with the fields written stays green when both sides use the same wrong frame.
- The harness models what Thunderbird does with a rule: `fakeRecurrenceRule` re-serializes its value as
  CalRecurrenceRule does (`canonicalRule`), a cloned event clones its recurrence info (each item and changed
  occurrence), and appending to a recurrence info without a base item throws as `appendRecurrenceItem` does. A rule
  expands through Thunderbird's own ical.js (`getOccurrences`: the start's digits stepped, read in the start's frame,
  UNTIL compared as CalDateTime does); setting a master's start runs `onStartDateChange` and setting its id
  `onIdChange`; changed occurrences are keyed by `getRidKey`. `seriesOccurrences` expands a whole series (rules,
  RDATEs less EXDATEs, changed occurrences at their own time) as CalRecurrenceInfo does.
- Split tests assert OCCURRENCES: for each start kind and for an unbounded, a COUNT and an UNTIL rule with EXDATEs,
  RDATEs and changed occurrences on both sides of the split, the two parts' occurrences together equal the series'.
- `seriesOccurrences` drops a changed occurrence whose RECURRENCE-ID an EXDATE names, as `calculateDates` does;
  excluded-date tests assert the occurrence is gone, so an EXDATE at a moved occurrence's start (not its id) fails.
  `test/calendarOccurrenceRoundTrip.test.js` feeds a changed occurrence's printed start, through the edit tool's
  normalizer, into `exdates_add` for each start kind.
- `test/calendarSplitKeepsProperties.test.js` pins the following part as a copy of the series (#291): every property
  and parameter, reminder, category, attachment, the organizer and each attendee entry; the edit's fields change only
  what they name; the series' organizer stays whatever `organizer_email` the edit tool fills in (through `modifyCalendarEvent`, also at a changed occurrence with only excluded dates); a changed attendee list; and
  the attendee-answer rule, kept for each non-rescheduling field and a restated value (all-day and floating series
  included, and a start restated in the user's zone, which is written in the series' own zone or kept floating, so no
  later occurrence moves, checked with `seriesOccurrences`), asked again of all but the organizer for each
  rescheduling one, a start given the same digits in the user's zone (another instant) included. The harness models CalItemBase for it: `fakeAttendee` (CalAttendee with `clone`), attendees,
  organizer, alarms, categories and attachments cloned with the event, property parameters, `setProperty` of an empty
  value deleting the property, and `descriptionText` as DESCRIPTION dropping its `ALTREP`.
- MONTHLY folds are pinned by occurrence too: `monthlyDays` enumerates RFC 5545 days independently of the bridge, and
  a rule read and written back must name the same days over 24 months, or restating it must be refused.
- `test/calendarTools.test.js` covers the refusal wiring before the card, and that a valid rule reaches the card
  with every field.
- `test/calendarRecurrenceNative.test.js` runs the bridge against Thunderbird's own date and recurrence code
  (`test/fixtures/mozilla/Ical.sys.mjs` and `CalDateTime.sys.mjs`, unmodified copies of comm-central 226a299e,
  Thunderbird 161.0a1, pinned by revision and SHA-256 in that directory's README and checked by the test), because
  the fakes convert zones with JavaScript dates, which always keep the instant and never land in a skipped hour.
  In a zone changing at 02:00 and one changing at midnight, around both changes, for starts including the hour
  before each change: a bound a split writes (an occurrence minus one second) and a last day the tools write each
  read back as the last occurrence's day and restate to the same native occurrences, or read with UNTIL in `other`;
  the same for bounds other apps store; a rule repeating at other times of day (BYHOUR, HOURLY, BYMINUTE,
  BYSECOND) shows its last occurrence's day or keeps UNTIL in `other`; and a BYSETPOS rule reads with BYSETPOS in
  `other`. One revision only:
  version differences in recurrence expansion are why BYSETPOS is not folded. A written last day just before a
  spring change at midnight, for a start in the first hour, keeps one more occurrence (#280, writer; left out of that
  sweep). A monthly and a yearly rule with a stored UNTIL read their last day and restate to the same occurrences.
- Bridge accessor calls (`boundFromIcs`, `occurrenceInstantOn`, `untilForRRule` → `getTimezoneService`;
  `asShown`, `toCalIDateTimeInFrameOf` → `getTimezoneService`; `writeRuleItem` → `getIcsService`) are listed in the exhaustive census in `test/calendarServiceAcquisition.test.js`.
