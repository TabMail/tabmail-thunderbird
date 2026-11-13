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
  in `calendar_event_read`, and as ` (↻ {...})` in the `calendar_search`/`calendar_read` listing. The delete card
  (`calendarDelete.js`, #355) adds `Repeating event: every occurrence will be deleted` for a repeating event deleted
  whole, `delete_scope` 'all' (keyed on `isRecurring`, so a series by added dates alone gets it too) and
  `Repeats <words>` from `recurrenceInWords`, the iOS card's wording (`every 2 weeks on Monday, Wednesday (10 times)`,
  count over until, `(1 time)`). A rule with `other` parts or no `freq` gets no Repeats line: a part left out would
  name a different rule (iOS words the known parts instead). Superseded (#373): one occurrence was removed only with
  the edit tool's `exdates_add`, and the delete always removed the whole item; see "Deleting by scope".
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
    the DATE's own digits, `dayDigitsFrom`/`dayDateFrom`: a DATE's epoch time depends on its zone, 034; in the
    start's value type, RFC 5545 3.3.10: UTC `…Z` for a zoned start, a floating `…THHMMSS` with no Z for a floating
    one, #392. Thunderbird showed the same occurrences with the old UTC cap, since it reads a floating value at
    offset 0, but apps that read floating times in the viewer's zone did not) and
    the following part's copy keeps UNTIL, with COUNT reduced to the occurrences still to come (`getOccurrences`
    from the start up to the split). A rule is expanded from its event's start, so a carried rule must make an
    occurrence at the split (`aligned`, checked with `getOccurrences` over [split, just after]); otherwise the split
    is refused, since the following part would not keep its dates. A new rule for the following part (`recurrence`)
    replaces the carried rules, so their alignment does not matter; the split point is an occurrence either way. A
    rule's UNTIL is compared with the split by `compare`, never by epoch time: an all-day UNTIL names a date, and
    west of UTC a DATE's day starts after the UTC midnight that date names, so an epoch comparison dropped a last
    occurrence on the split day.
  - **Both parts are written as plain dates (#329):** an all-day series' parts have every DATE relabelled
    with no zone (`asAllDayItem`, 034) before the cap is written, so the earlier part's bare-date UNTIL (the
    day before the split) keeps that day in Thunderbird's expansion. ical.js compares a rule's UNTIL by instant
    (`Time.compare`, `toUnixTime`: an occurrence in its start's zone, a DATE at midnight there; a bare-date or
    floating UNTIL at offset 0), so a start that kept a zone west of UTC fell after a bare-date UNTIL of its
    own day. Superseded: until #329 the earlier part's occurrences over the two days before the split were
    compared with the series' by RECURRENCE-ID and a mismatch refused the split ("the part before ... would
    not keep every occurrence ..."), which refused every daily split of a zoned all-day series west of UTC.
    The comparison is deleted, not kept as a guard: its only trigger was a zoned all-day start; a timed cap is
    the split minus one second by instant, and a plain all-day cap keeps its day.
  - **Dates and changed occurrences:** EXDATEs, RDATEs and changed occurrences before the split stay on the earlier
    part; those from the split on move to the following part (an RDATE is not bounded by UNTIL, so one left on the
    earlier part would still happen). The following part's recurrence info is a clone of the series' (Thunderbird's
    `CalRecurrenceInfo.clone` clones items and exceptions) with `item` set to the new event, which makes it the
    changed occurrences' parent; the calendar's id assignment renames them (`onIdChange`).
  - **Thunderbird has no "this and following" primitive** (`MODIFY_FOLLOWING` throws `NS_ERROR_NOT_IMPLEMENTED`),
    so the bridge builds the two parts itself.
  - **A time change since 2026-11-11 (ADR-031)** applies to the following part only, after its recurrence is
    attached, through the same code as a whole series (*Whole-series time change* below): `resolveEditTimes`
    reads the edit against the occurrence the split names, as Thunderbird builds it; a new start resets the part's
    changed occurrences and excluded dates (the earlier part keeps its own), then the edit's own excluded dates
    are added, then `writeSeriesTimes` writes the part's start and the end `afterElapsed(start, W)`; an end alone
    gives the part and each changed occurrence it carries the new wall-clock length `W` (`applyNewLength`). The
    part starts at the split as `writeSeriesTimes(newEv, splitDt, seriesLength(cappedClone))` (an all-day part as a
    plain date), so an all-day series stored with zoned dates keeps its days across a clock change (#330, #368);
    its rules' date-time UNTIL is read in the series' stored zone (`asAllDayItem(newEv, master.startDate)`).
    Superseded: the paragraph that follows, from "so Thunderbird's".
  - **A time change** (before 2026-11-11) (`start_iso`/`end_iso`/`all_day`) applies to the following part only, after its recurrence is
    attached, so Thunderbird's `onStartDateChange` moves its EXDATEs, RDATEs, each non-COUNT rule's UNTIL and the
    changed occurrences' RECURRENCE-IDs by the same amount, as an edit of a whole series does; since #287 the
    following part then moves as a whole series does (`shiftSeriesWithStart`, *Whole-series time change* below:
    its changed occurrences still at their slots and its rule's days go with it, which closes #328, where a part
    moved to another day kept naming the old days; one given its own time keeps it). Superseded: the changed
    occurrences kept their own times; then (first #287 version) every changed occurrence moved. The new times are read in the user's zone (or the edit's `timezone`; one Thunderbird does not know is refused by name, nothing written, for create and every edit scope: `toCalIDateTime` throws it outside its own null-returning try, #314; before, it was read in the user's zone) and
    written in the series' frame (`toCalIDateTimeInFrameOf`, for every edit through `applyDurationPreservation`;
    as Google Calendar does, a start alone keeps the length and an end alone changes only the end, the start kept
    being the item's own: the event's, one occurrence's current start, the split's slot; until #350 an end alone
    moved the start back by the stored length, which moved a whole series' occurrences and the occurrence a
    split starts at):
    a zoned series' own zone at the same instant, a floating series at the user's clock digits, kept floating (the
    inverse of `asShown`), as Thunderbird's event dialog keeps an event's zone. Read straight in the user's zone,
    a new start moved the series into it: its rule expanded there (a Thursday east of UTC can be a Wednesday in
    the user's zone), and `onStartDateChange`'s offset between a floating and a zoned start was the user's UTC
    offset plus the change, so excluded, added and changed dates no longer met the occurrences (#301). An all-day
    value (an edit to all day included) is the date as read with no zone (`asAllDayDate`, #303, note 034); an
    edit from all day to timed is written as read. An edit that leaves `all_day` out keeps the item's kind, all-day
    or timed (the edit tool's "Leave empty to keep existing"; #309, note 034); one that gives an all-day item a time
    of day without `all_day`, or whose all-day end would fall on or before its start, is refused before anything is
    written, asking the user (`editTimesError`, formerly `allDayEditError`, in the split too; note 034); so is a start
    and an end of different kinds (a side the edit leaves out keeps its kind; #318) and a timed end before the start
    (an end at the start is written, a zero-length event as Google makes one; the refusal explains that an end alone keeps
    the start only when no start was given, and a split's names the slot its part starts at). The same check runs on the
    occurrence the edit names (`applyEditToNamedOccurrence`). **A change of kind needs both times (#288, #349,
    2026-11-11):** an `all_day` other than the stored kind (the event's, the occurrence's on `this_only`, the
    series' on `all` and on a split) without both `start_iso` and `end_iso` is refused before the card with nothing
    written, on every scope, by `kindChangeTimesError` (checked first in `editTimesErrorOf` for one event, one occurrence and a series given no time, and once in
    `resolveEditTimes`, before `timesLeft`, against the occurrence read against, for series and split time edits); the message names both fields and says an all-day `end_iso` is the
    day after the last day. The dates are not derived from the stored ones (a timed event made all-day can span
    other days; one made timed needs the time of day and length the user wants). The `changes` answer of the check
    no longer has an `all_day` term: a change of kind is in `times`. A change of the series' kind named at an
    occurrence changed on its own (on `all` at the first occurrence, or a split) is read against the series' plain
    occurrence there (`slot`), the same swap `resolveEditTimes` makes for the series' own start: read against an
    occurrence already of the kind asked, that occurrence's own dates restated and were dropped, and the edit was
    answered "Nothing changed" while every other occurrence kept its kind. The swap never fires when the edit changes
    the NAMED occurrence's kind (`changesNamedKind`): then the edit is read against that occurrence, so its old times
    are the card's (an occurrence moved in time and made the other kind shows its own 14:00, not the slot's 10:00,
    as #369 requires). The kind is checked ONCE, before `timesLeft`, against the occurrence read against
    (`kindChangeTimesError(!!ref.startDate.isDate, patch)`): any change of kind needs both times (2026-11-12). So at an occurrence made the other kind on its own, `all_day` of the series' kind is a
    change of that occurrence's kind: given alone or with a start alone (the series' time or another) it is refused
    for both times; with both times (the series' own, or another end) it is made from that occurrence on, the card
    and the write agree. Before (2026-11-12 review), the series'-own-start swap read such an edit against the slot:
    the series' own times restated and it answered "Nothing changed", a start alone did too, and another end showed
    "All-day event: yes -> no" on the card while the write left that occurrence all-day. On `all` with no time the
    series path does not read the named occurrence. Superseded: `all_day` alone changed nothing
    while the card showed "All-day: no → yes" and the edit reported success, and from an occurrence on it split the
    series into two identical parts; a change to timed with a start only kept the all-day length as a 24-hour timed
    event (one-off and `this_only`), and on a series it got the mixed-kinds refusal. Pinned by
    `test/calendarAllDayAloneWest.test.js` and `test/calendarAllDayAloneEast.test.js` (cases in
    `test/helpers/allDayAloneCases.js`).
  - **`exdates_add`** go to the part their RECURRENCE-ID falls in (see *Excluded dates* below), added before the
    time change so they move with the part.
  - **A split at an occurrence that was changed on its own** (X), since 2026-11-11 (ADR-031): X is named by its own
    printed start. A new start resets X and every changed occurrence of the part (Google's "this and following"),
    so the part starts at the new time with no changed occurrence; X's own start restated, or the series' own start at X, is no change (X keeps its time, `timesLeft` and the rule in
    `resolveEditTimes`), unless the edit changes X's kind: it is then read against X, made with both times and refused
    with fewer (#288, #349); an end alone is a length
    `W` measured from X's own start: X ends at the end given and the part starts at its slot and lasts `W` (an end
    before X's start gets the usual "the event would end before it starts" text; the "keeps its own start" and
    "their usual time" prefixes are gone); every field the edit names is written over X and the part's other
    changed occurrences (`applyEditToChangedOccurrences`). Superseded (2026-11-10 to 2026-11-11): the text below.
  - **A split at an occurrence that was changed on its own** (X) is made in one write (2026-11-10): "from X on, new
    time" applies the time to X and everything after it, and X keeps its rename. X is carried
    into the following part with its own fields, then takes the edit there (`applyEditToNamedOccurrence`): with
    a new start, the part's start and end; with an end alone, the part's end, keeping its own start (the part
    starts at the slot, and the card names X by its own start and states its original time, `recurrenceIdSlot`
    from `getCalendarEventDetails`; an end before X's start is refused); every field the edit names (title, location, description, busy/free);
    its own changes the edit does not name are kept. A guest change is not made there: the bridge's one guest merge
    makes it on every item the split covers, X included (051). Every changed occurrence of the part whose own
    start, end or place the split changes (X, ones at their slots moved with the part) has its own attendees
    asked again, each found as stored by moving its RECURRENCE-ID back by the part's start change; one that keeps
    its own time and place keeps its answers. Superseded (#265): such an edit was refused (`SPLIT_FIELDS_OF_AN_OCCURRENCE`),
    naming a two-step route (X alone with `this_only`, then the following ones from the next occurrence), which
    left a partial result if the second step never came. `recurrence: {}` at X is still refused (below).
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
    A guest change (`add_attendees`, `remove_attendees`) is applied to the new series and to each changed
    occurrence carried into it, each on its own list, by the one merge every edit uses (`applyGuestChange`, #332, #333,
    [051-calendar-attendee-list-edits-keep-entries.md](051-calendar-attendee-list-edits-keep-entries.md)); a guest-only
    split at a changed occurrence is therefore made. Until then a flat list (`patch.attendees`) was written through
    `setAttendeeList` (#297) and a changed attendee list at a changed occurrence was refused. The organizer is the series' (copied with it, every parameter kept): the edit's
    `organizer_email`, which the edit tool fills with the calendar's own address whenever it has a `calendar_id`, is
    not passed to the split, as an edit of a whole series never sets one. Superseded: the split used to write it as
    the organizer, which dropped the organizer's parameters (`SENT-BY`, `SCHEDULE-*`) and, on a meeting someone else
    organizes, named the user as its organizer.
    **Superseded 2026-11-12 by [054](054-calendar-own-organizer-when-guests.md) (#423):** `organizer_email` is never
    used; both parts of a split with guests and no organizer take the calendar's own address (`organizerId`); an
    existing organizer is still kept with every parameter.
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
    whose end or count cannot be read; a series that repeats by added dates alone (no rule to divide); an `exdates_add` value that names no occurrence; a rule item that cannot be rewritten (an immutable item throws); a time
    change between all-day and timed when the following part carries an RDATE or the edit's own EXDATE (a new start
    has reset its changed occurrences and excluded dates first, since 2026-11-11; before, those were refused too), or
    (without a new rule) a rule with UNTIL (RFC 5545 needs them in the start's value type, and moving the start
    keeps theirs; the same `kindChangeError` as a whole-series edit, below); and `recurrence: {}` at an occurrence that was changed on its own (the one event left would
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
  with the series (the order #295 reported reversed). **An edit of one occurrence (`this_only`) with `exdates_add` is
  refused** by the bridge before anything is written, the check before the card included (#298, owner option B,
  2026-11-12; `ONE_OCCURRENCE_EXDATES_ERROR`): the assistant makes the edit without `exdates_add`, then removes each
  other occurrence with `calendar_event_delete` (`delete_scope` 'this_only'), each on its own card; the two are never
  combined in one save. iOS already refuses the same combination (`exdates_add` is a call of its own there, tabmail-ios
  #694). An event that does not repeat keeps the "not the start of an occurrence" refusal. Superseded (#298): the
  excluded dates of one occurrence's edit were written to the stored series in place after the card; Thunderbird's
  stored items are immutable, so the write threw, was caught, the series was saved unchanged and the edit reported
  success. Superseded: the values were parsed as raw times and
  written as given after the time change, so a moved occurrence named by its printed start was not removed, and
  on a moved series the value named a time no occurrence had any more.
- **Restated rules with `other` parts are refused,** for every edit scope: an edit that restates the rule of a
  series whose stored rule has `other` parts is refused before the card by `otherPartsRefusal`, because restating
  would drop those parts. The stored rule is fetched with the edit's `calendar_id`; when it cannot be read, a
  restatement is refused too. `{}` (stop repeating) is allowed.
- **Whole-series time change (#287), as calendar apps make it (Google Calendar is the reference).** Applies to
  an edit of a repeating event with `start_iso`/`end_iso` whose scope resolves to `all`, unless it stops the
  repeat (`recurrence: {}`).
  - **Since 2026-11-11 (ADR-031): reset like Google, a wall-clock length.** One decision point,
    `resolveEditTimes(item, patch, tz, namedRid)`: the edit's times are read against the occurrence it names (or
    the first), as Thunderbird builds it (`info.getOccurrenceFor`/`createProxy`); a time it only restates is
    dropped by the one no-change rule `timesLeft` (every scope; an end is dropped only when no new start is kept;
    a restated time is compared as the read tools print it, `restates`/`shownNaiveIso`); the series' own start named at an occurrence moved on its own is no change (that occurrence keeps its time) and an
    end is then measured from the first slot, unless the edit changes that occurrence's kind: it is then read against
    that occurrence, made with both times and refused with fewer. An edit that changes the series' kind, named at an
    occurrence already of that kind, is read against the series' plain occurrence there (`slot`) (#288, #349). The length `W` is the end's clock digits minus the start's (`clockSeconds`), or
    the series' own (`seriesLength`); `editTimesErrorOf` refuses on it with main's texts. A new start resets every
    changed occurrence and excluded date (`resetChangedOccurrences`; added dates and EXRULEs stay; the edit's own
    `exdates_add` are added after it; stopping the repeat resets nothing), then `writeSeriesTimes` writes the start
    and the end `afterElapsed(start, W)` (the instant Thunderbird reads `W` after the start, so every plain
    occurrence, rid plus the stored elapsed length, ends at the end given; null on the first pass of a repeated
    hour, refused), then `shiftSeriesWithStart` moves the rule's days on a move to another day. An end alone
    gives every changed occurrence of the series' kind its own start plus `W` (`applyNewLength`); one made
    all-day or timed on its own keeps its times, and an end alone named at it is refused (`NAMED_OTHER_KIND_ERROR` when the edit gives no
    `all_day`; with an `all_day` that changes its kind, the change-of-kind refusal, both times, comes first).
    A time given in another zone reaches the series' frame only through `atInstantInFrameOf` (`intoFrameOf`, used
    by `toCalIDateTimeInFrameOf`; a null result and digits the given zone skips are refusals). The check returns
    `changes`, `times` (`seriesEditTimes`/`shownEditTimes`: the named occurrence as printed, then as written) and
    `resetsChangedOccurrences`; the card's time lines come from `times` and it adds "Occurrences you changed
    individually will be reset, and deleted ones will come back." The keep-my-edits text below, and
    `applyEditToNamedOccurrence`, are superseded (deleted).
  - **The first occurrence is the one Thunderbird expands first (#386, #404, 2026-11-11).** ONE primitive,
    `firstOccurrenceOf` (earliest start Thunderbird expands: an excluded date is none, a changed occurrence
    at its own time), used in three places: `getCalendarEventDetails` with no `recurrence_id` shows the series
    at it (so `calendar_event_read`, both cards and the no-`recurrence_id` routing in `routeSeriesTimeChange`
    read it; a series with no occurrence left shows its stored start); `isFirstOccurrence` is "rid is its
    RECURRENCE-ID" (`recurrenceIdIsFirst`, so the edit's `all` routing and the delete's "this and following from the first = all" routing; the `all` refusal in `modifyCalendarEvent`; the split refusal; the delete's `this_and_following` refusal);
    and an `all` time change with no `recurrence_id` is read against it (`namedRid` in `modifyCalendarEvent`).
    Before, all three used DTSTART: with the first date excluded, the read printed a date with no
    occurrence, the documented path (name the start_iso the read shows) was refused by `occurrenceNamedBy`,
    an edit naming the first visible occurrence was routed to a split that left an earlier part with no
    occurrence (later `all` edits never reached it), and an edit with no `recurrence_id` on the first
    visible date was asked "just that date, or every later one?". The series moves by the named
    occurrence's change from its slot (coordinator ruling, option A): `resolveEditTimes` reads the slot in
    the item's frame (`intoFrameOf`) and `seriesStartFor` moves the new start back by the clock gap from
    DTSTART to that slot (whole days by the date digits for an all-day start), so UNTIL, COUNT and RDATEs keep
    their dates; as every new start does (ADR-031), every excluded date comes back, the first one included.
    Writing the named occurrence's new start straight into DTSTART moved UNTIL/RDATE by the whole gap and
    kept COUNT counting the excluded date: one extra occurrence at the end. The card's `to` is the named
    occurrence at its slot as written (`resolved.named`). A split names its part's own start, so its gap is
    0. The same holds when DTSTART is no occurrence at all (a rule naming other weekdays: Thunderbird does not
    expand a non-matching DTSTART), so the read no longer prints a time nothing starts at. A first occurrence moved on its own is now shown at its own times; an end alone with no
    `recurrence_id` is still a new length for the whole series (`writeSeriesTimes` + `applyNewLength`),
    measured from the start the read shows. Accepted limit: a first occurrence made all-day (or timed) on its own
    in a series of the other kind refuses an end alone with no `recurrence_id` (`NAMED_OTHER_KIND_ERROR`, nothing
    written; before, the length was measured from DTSTART's slot). Known corner: a first occurrence moved ahead of an earlier slot
    is "first" by start, so a split at it is refused though an earlier part would keep one occurrence (a
    refusal, nothing written). Pinned by `test/calendarSeriesFirstExcluded.test.js` and two rows of
    `test/calendarRecurrenceFormat.test.js` (a split at the first occurrence after a start that is none).
  - **Named from the first occurrence** (a `recurrence_id` whose occurrence's RECURRENCE-ID is the series' start,
    `isFirstOccurrence`, even if it was moved on its own; or no `recurrence_id` and the new start, or for an end
    alone the new end, on the series' own date as the read tools show it, `shownEventTimesIso` in
    `calendar_event_read.js`): a plain shift of every occurrence. Thunderbird's `onStartDateChange` moves
    EXDATE/RDATE, UNTIL and the RECURRENCE-IDs by the start's change in UTC; `shiftSeriesWithStart` (bridge,
    after `editTimesError`) handles the changed occurrences as calendar apps keep the user's edits
    (2026-11-10): one still at its slot (its own start, moved by that UTC amount, lands on its
    moved RECURRENCE-ID; changed only in title, notes, place, guests or length) moves by the same amount and keeps
    its changes, its own length included (a field the edit names is then written over every changed occurrence,
    #351, *An "All events" edit* below); one given its own start keeps its own start and end, only its RECURRENCE-ID moved (so it still
    replaces its slot and shows once). An end alone moves no start, so it changes no changed occurrence (#350
    kept this rule as it was), and excluded dates stay excluded. A first occurrence the edit names by `recurrence_id` takes the edit (its
    times and named fields, `applyEditToNamedOccurrence`: a new start gives it the series' start and end, an end
    alone the series' end with its own start kept), even when given its own time; with no `recurrence_id`
    none is named. Superseded: (first #287 version) every changed occurrence moved by the shift, one given its own
    time included (a 9:00 series moved to 10:00 took one moved to 11:00 to 12:00, a time nobody chose); (before
    #287) the changed occurrences kept their times while their RECURRENCE-IDs moved. And on a move to another day (days counted from the date digits in the old start's zone)
    the rule's plain BYDAY weekdays and positive BYMONTHDAY days (`ruleShiftedByDays`); a WEEKLY rule with
    INTERVAL > 1 also moves its WKST (default MO), as ical.js groups the days into weeks from it. Refused,
    writing nothing, wherever ical.js would expand the shifted rule to other dates than the old ones moved: an
    ordinal or signed BYDAY, BYSETPOS, BYYEARDAY, BYWEEKNO, a BYMONTHDAY outside 1..28 before or after the move
    (`DAYS_IN_SHORTEST_MONTH`), a MONTHLY rule on its start's day moved off 1..28 or into another month, a
    YEARLY one on its start's day on a leap day or moved across the end of February, plain BYDAY with BYMONTH
    or (MONTHLY/YEARLY) INTERVAL > 1, BYMONTH on a DAILY or WEEKLY rule, a BYMONTH the move leaves, an EXRULE,
    a time change of a rule with BYHOUR/BYMINUTE/BYSECOND, and a new rule (with `freq`) given with a move to another day (make the move, then
    the rule, in two edits). A change between all-day and timed (`kindChangeError`, one check for the series
    and the split's following part, made before the same-start return, since `compare` takes only the date of a
    DATE) is refused, on its own day as on another, when the series still carries a non-rule item once the new start has
    reset its changed occurrences and excluded dates (`resetChangedOccurrences`): an added date (RDATE) or a date the
    same edit excludes (`exdates_add`) ("change it in the calendar app"), or, without a new rule, a rule with UNTIL ("give
    the repeat rule again ... in the same edit"; a new rule is written in the start's value type). Thunderbird's
    `onStartDateChange` does compute a UTC amount between a DATE (its digits at UTC midnight) and a time, and
    moves those dates by it in their own value type, so they leave their occurrences: changed occurrences are
    duplicated, excluded dates come back (also so on main, before #287). A DATE EXDATE removes a timed
    occurrence by its day (the first 8 characters of the occurrence's own date in its zone, a changed one by its
    RECURRENCE-ID, bug 734245), as the harness's `seriesOccurrences`
    now does. Superseded: (first version) the changed occurrences kept their times on such a move while their
    RECURRENCE-IDs moved; (second) a same-day change was let through and a day move refused only with changed
    occurrences, advising "make the move first", which led into the same-day breakage.
  - **Named from a later occurrence:** the edit tool rewrites `edit_scope` to `this_and_following` before the card
    (`routeSeriesTimeChange`, using `getCalendarEventDetails`' optional `recurrence_id` → `recurrenceIdIsFirst`,
    absent when it names no single occurrence), so the card, the bridge and the result agree; the following part
    gets the same shift. A `recurrence_id` that names no occurrence is refused by the bridge's check before the card
    (#339). Superseded: the read also gave `recurrenceIdError`, which the tool returned as its own refusal.
    The bridge refuses an `all` time change named from a later occurrence, naming `this_and_following`.
  - **Unclear:** no `recurrence_id` and another date → the tool refuses before the card, telling the model to ask
    "just that date, or that date and every later one".
  - A `recurrence_id` without `edit_scope` stays `this_only`. Superseded (before #287): an `all` move set the
    series' start to the given date and kept the rule's days and the changed occurrences' times, so a move named
    from a later occurrence dropped the earlier ones and shifted UNTIL, EXDATEs and exceptions for attendees.
  - Daylight saving (open): when the shift itself crosses a change, the UTC amount leaves the moved
    EXDATEs/RDATEs/RECURRENCE-IDs an hour off the wall-clock occurrences (Thunderbird's own behaviour).
- **Edit scope (#274):** only `this_only` (explicit, or a `recurrence_id` with no `edit_scope`) edits one
  occurrence. `edit_scope` `all` edits the series and ignores `recurrence_id` (except for a time change, above): the bridge's lookup in
  `modifyCalendarEvent` reads `recurrence_id` (through `occurrenceNamedBy`) only for `this_only`. Before #274 the lookup always resolved the
  occurrence, so an `all` edit with a `recurrence_id` changed (or created) that one exception while the card and the
  result said the whole series. A `recurrence` (a rule, or `{}`) on a `this_only` edit is refused before the card
  in `_runEditCalendarEvent`, as Thunderbird never expands a rule written onto an occurrence; the edit used to report
  success while the series kept its rule.
- **An "All events" edit writes each field it names over every occurrence (#351), as Google Calendar's "All
  events" edit does.** On `edit_scope` `all`, `applyEditToChangedOccurrences` (bridge, in `modifyCalendarEvent`
  after the rule is written and before the check's return, so the check and the write run it alike) gives every
  changed occurrence of the series each non-time field the edit names: title, location, description (in every
  form: `X-ALT-DESC`, `X-MOZ-HTML` and `X-MOZ-ALT-DESC` go, as on the series) and busy/free. Guests are not made
  there: `applyGuestChangeToSeries` already changes every changed occurrence's own list (051). A field the edit
  does not name keeps each occurrence's own value; the step writes no time (start, end and all-day are the
  time rules', above, unchanged), and an excluded occurrence stays excluded. The plain occurrences
  take the fields from the series itself. A split (`this_and_following`) does the same over its following
  part, in `splitRecurringEvent` after the occurrence it starts at takes the edit and before the attendee
  answers are decided: every changed occurrence carried into the part takes each field the split names, so a
  new place asks that occurrence's attendees again (the split's rule, above); the earlier part's keep their own.
  `this_only` changes one occurrence.
  - **A field the edit only restates is no change** (2026-11-11; Google Calendar leaves an occurrence's own
    value alone when the field is not changed in its form, and that form, opened from an occurrence, holds the
    occurrence's own values). ONE comparison, `restatedFields` in `chat/tools/calendar_event_edit.js`: a named
    title, place, notes or busy/free equal to what `getCalendarEventDetails` reads. Those details hold the
    series' fields, or, when the read names an occurrence (`recurrence_id`, which the tool passes on a split),
    that occurrence's own (`editableFieldsOf(named.occurrence)`; start, end and kind stay the series'). The
    notes are read as `queryCalendarItems` reads them (DESCRIPTION). The confirmation card
    (`formatChangesForDisplay`) shows no line for those fields and shows the real old value of the others, and
    on `all` and `this_and_following` the tool drops them from the edit before the check, with the same details
    the card then shows, so the card, the check and the write see one edit: an occurrence changed on its own
    keeps its own value of a restated field. A split at an occurrence changed on its own compares with that
    occurrence: "from Wednesday on, back in Room A" when Wednesday to Friday were each moved to Room B is a
    change, written to Wednesday and every carried occurrence (their attendees asked again; the plain ones
    keep their answers, as the place equals the series'). When the details cannot be read, such an edit is
    refused before the card ("could not read this event"). Since 2026-11-11 the tool prunes on every scope and
    reads the details with the `recurrence_id` on `this_only` too, and `getCalendarEventDetails` prints the named
    occurrence's own start, end and kind (a series without one: its first occurrence as Thunderbird builds it), so
    the card's header and old values are the occurrence's (#369, fixed). Superseded: `this_only` was not pruned and
    its card compared with the series, not the occurrence (#369).
  - **`""` removes the location or the notes, on every scope (#383).** The edit names a field when it gives a
    string for it, `""` included; omitting it keeps the field (the schema's "Omit to keep existing"). That is the
    bridge's own presence test (`typeof patch.x === "string"`; Thunderbird's `setProperty` deletes an empty value,
    and the notes' HTML copies go as for any new notes), the iOS tool's on the same schema, and `contacts_edit`'s.
    The add-on above the bridge applies the same rule in all three places that decide presence, so the card, the
    check and the write see one edit: `normalizeArgs` keeps an empty `location`/`description`; `restatedFields`
    compares it with the stored value read as a string (`""` over an empty field is restated, so no line and no
    write; over "Room A" it is a change); and the card shows the line with the new value as `(cleared)`, the iOS
    card's word ("Room A → **(cleared)**"). Superseded: `normalizeArgs` tested truthiness, so `""` was dropped
    before the check, the card showed no line (or "no changes detected"), nothing was written, and the edit was
    still reported as made. The title has the same truthiness test and is a separate question (#384).
    Pinned by `test/calendarEditClearsField.test.js` (incl. the guards: `""` over an empty place or empty notes on
    an `all` edit is restated, so an occurrence with its own keeps it).
  - **Thunderbird 159 reads HTML notes only from DESCRIPTION's ALTREP, never from X-ALT-DESC** (checked by
    scanning its `omni.ja`: no "X-ALT-DESC" anywhere). The bridge still deletes X-ALT-DESC, X-MOZ-HTML and
    X-MOZ-ALT-DESC when notes are cleared or replaced without HTML, because other CalDAV clients may show them.
    Notes held only as X-ALT-DESC read as empty through `getCalendarEventDetails` (it reads DESCRIPTION), so a
    `""` over them is restated and the copy stays (rare; such notes come from an external client).
  - Superseded: on an `all` edit a changed occurrence kept its own title, place, notes and busy/free, so an
  occurrence renamed or moved once never took a later rename of the series (only a first occurrence named on a
  time change took the edit's fields); a split's carried changed occurrences kept theirs too, except the one it
  starts at; (first #351 version) a restated field was written over every changed occurrence while the card
  showed no line for it; and (second #351 version) the comparison read the series' values on a split too, so
  "back in Room A" at an occurrence moved to Room B changed nothing, and the details carried no notes, so
  restated notes overwrote every changed occurrence's own and the card showed the old notes as "(empty)".
  Pinned through the real bridge and its read path by `test/calendarAllEventsFieldEdit.test.js` (every
  occurrence reads each named field, every other field and both times as before, the same occurrences shown;
  the split's carried occurrences and their answers; the HTML copies; restated title, place, notes and
  busy/free from the tool's `run` through the card; a split at an occurrence with its own place and its own
  notes; the refusal when the event cannot be read; `this_only` setting an occurrence back to the series'
  place; a control for `this_only`).
- **No rule comparison.** Neither client compares a restated rule with the stored one above the provider boundary. TB writes the rule through to Thunderbird's calendar. (The split's attendee rule, above, compares in the bridge only to decide whether answers are asked again; it never refuses or skips a write.)
- **The model is told about these series edits from protocol 1.11.4** (2026-11-11, #382). The backend serves
  the calendar edit text and agent prompt that describe them (an occurrence named by its start as
  `calendar_event_read` shows it, an edit of every occurrence named at its first one, a new start resetting the
  series, an end alone changing only the length) from protocol 1.11.4; below it the model is told an occurrence
  named on "all" is ignored. `SETTINGS.protocolVersion` is 1.11.4; TB-212 keeps it at 1.11.4 or later.

## Deleting by scope (#373)

- `calendar_event_delete` takes `delete_scope` ('this_only', 'this_and_following', 'all') and `recurrence_id` for a
  repeating event, as the edit takes `edit_scope`. **No default scope:** a repeating event with none is refused before
  the card with the question "Just this one, this and following, or all of them?"; an unknown value is refused by
  name (the edit's `normalizeArgs` drops one silently); an occurrence scope without `recurrence_id`, and a
  `recurrence_id` the tool cannot read, are refused. An event that does not repeat is deleted as before, whatever
  the scope says.
- **One builder for the split and the delete:** `earlierPartBefore(master, rid)` in the bridge is the split's earlier
  part (every rule capped before the slot by `splitRule`, added and excluded dates and changed occurrences from the
  slot on dropped, all-day dates written plain by `asAllDayItem`). `splitRecurringEvent` writes it and adds the
  following part; the delete's 'this_and_following' writes it in place of the series (`modifyItem`), so the named
  occurrence and every later one go and nothing is added or lengthened. The EXRULE and unreadable COUNT/UNTIL
  refusals come with it; the split's no-rule and alignment refusals stay in the split (they concern the following
  part), so a series of added dates alone can be cut.
- **The cut is at the slot** (the RECURRENCE-ID): an occurrence moved on its own is named where it is now
  (`occurrenceNamedBy`) and the series is cut at its original time; a later-slot occurrence moved before the cut's
  day goes, an earlier-slot one moved past it stays (Google and iOS cut the same way). The card then also says
  "(from <start>, originally <slot>)", from `getCalendarEventDetails`' `recurrenceIdSlot`.
- **First occurrence = all:** 'this_and_following' at the first occurrence (`recurrenceIdIsFirst`) is routed to 'all'
  by the tool before the card, so the card says every occurrence goes and the item is deleted. The bridge refuses it
  if it ever arrives.
- 'this_only' excludes the occurrence on a clone of the series (`asAllDayItem`, `addExdateToItem`), as the series
  edit's excluded dates do; the stored item is never changed in place.
- **Check before the card:** the tool reads the details with the `recurrence_id` (the card's Start is the named
  occurrence), routes the scope, then calls `deleteCalendarEvent` with `check_only: true`, which runs every refusal
  and returns before the invitation step and the write. The check and the confirmed write pass the same arguments
  (`deleteCallArgs`: event id, routed scope, recurrence_id; no calendar, so the first calendar holding the id, as
  the card's read). The card, the bubble after the write and the tool result each name the scope. The bubble names
  no date ("This and every later occurrence deleted; earlier ones stay"): the cut is at the slot, which for an
  occurrence moved on its own is not where it is now, and the card already states both. A check that throws or
  answers nothing fails the call (`exec_fail`) before the card; it never leaves the converse waiting. The bridge's
  old `confirm` argument and its window.confirm branch are gone (the only caller always confirmed via the card).
- A this-and-following split or delete named at a time after a COUNT series' last occurrence names no occurrence,
  so it is refused and the series is unchanged: neither can lengthen a series (#272).
- The cap's value type (#392) lives in the shared builder, so a floating timed series' cut gets a floating UNTIL
  (no Z) on the delete as on the split. Thunderbird drops the named occurrence with either form (it reads both at
  offset 0); a Z cap misled apps that read floating times on the viewer's clock, which east of UTC kept it.
  Superseded: "not handled here, a separate fix in the cap", whose premise (Thunderbird keeps it west of UTC) was
  wrong.

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
  The same loop pins the earlier part's UNTIL in its start's value type for every kind, floating included (no Z).
- `test/calendarSplitFloatingWest.test.js` and `test/calendarSplitFloatingEast.test.js` (cases in
  `test/helpers/floatingSplitCases.js`, Los Angeles and Sydney, on Thunderbird's own dates) split floating timed
  series (daily at 00:00 to 23:30, and six-hourly): the named occurrence and every later one are the following
  part's only, every earlier one stays in the earlier part, and the earlier part's UNTIL is floating and before
  the named occurrence (#392).
- `seriesOccurrences` drops a changed occurrence whose RECURRENCE-ID an EXDATE names, as `calculateDates` does;
  excluded-date tests assert the occurrence is gone, so an EXDATE at a moved occurrence's start (not its id) fails.
  `test/calendarOccurrenceRoundTrip.test.js` feeds a changed occurrence's printed start, through the edit tool's
  normalizer, into `exdates_add` for each start kind.
- `test/calendarSplitKeepsProperties.test.js` pins the following part as a copy of the series (#291): every property
  and parameter, reminder, category, attachment, the organizer and each attendee entry; the edit's fields change only
  what they name; the series' organizer stays whatever `organizer_email` the edit tool fills in (through `modifyCalendarEvent`, also at a changed occurrence with only excluded dates); a changed attendee list; and (superseded 2026-11-12 by 054, #423: `organizer_email` is never used; a series with guests and no organizer gets the calendar's own address, pinned in `test/calendarOwnOrganizer.test.js`)
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
- Deleting by scope (#373): `test/calendarSeriesDeleteScopeWest.test.js`/`East` (cases in
  `test/helpers/seriesDeleteCases.js`, the flow helper `remove()` in `seriesEditFlow.js`), the user west and east
  of UTC with series in both zones, every date relative to today: exactly the scope goes (occurrences by slot before
  and after), nothing added or lengthened, earlier occurrences keep every value, card = write (Start = the read
  tool's start, the scope line, the relay, the result), every refusal before the card, routing (first = all for
  this and following, while this only at the first occurrence removes just it; an event that does not repeat), a
  check that throws or answers nothing (`exec_fail`, nothing written), moved occurrences (the bubble names no
  date), all-day in plain and zoned dates, the last occurrence, COUNT series, a split and a delete after a COUNT
  series' end (refused, unchanged; #272), a floating timed series' cut (no Z on the UNTIL, the named occurrence
  gone; #392), the next clock change. Stored series are made read-only (`readOnlySeries` in the harness: the recurrence
  info's mutators throw, a clone is mutable), so a write to the stored item instead of a copy fails. The split's
  earlier part is pinned value by value in `test/calendarRecurrenceFormat.test.js` ("split: the earlier part, value
  by value, and the refusals").
- The delete card's lines (#355): `test/calendarSeriesDeleteCard.test.js`, through the real bridge and delete states
  (series by id and by an occurrence row, added dates alone, `other` rules, UNTIL agreeing with `calendar_event_read`,
  one-off control), and the `recurrenceInWords` table in `test/calendarRecurrenceFormat.test.js` (every position
  word and suffix, all month names).
- **One check before the card (#339):** the edit tool calls `modifyCalendarEvent` with `check_only: true` for every
  edit, after its routing, and fails the call with the bridge's refusal. The bridge returns from the check at its
  first write, in both paths: in `modifyCalendarEvent` just before the save (until #298, just before the excluded
  dates of one occurrence went to its series, a write that path no longer makes), in `splitRecurringEvent` just before the earlier part is written. So
  every refusal is made by the check, the split's new-rule write failure and its refusal to stop repeating at an
  occurrence changed on its own included (before #339 these two came after the check, so the card was shown for an
  edit the write then refused). Everything above works on clones. The tool keeps only its own argument checks (a
  date it cannot read, `event_id`, a rule on one occurrence, `recurrenceArgError`, `otherPartsRefusal`), the
  question when no occurrence is named on another date, and its refusal when it cannot read the event to route.
  Deleted copies: "edit_scope needs recurrence_id" (in the tool and in the edit flow; the bridge's message took the
  tool's wording, which names how to find it), and the tool's "new repeat rule with a move to another day", which
  compared the date text in the user's zone and so refused a move that is the same day in the series' own zone
  (the bridge counts days in the series' zone, `NEW_RULE_MOVE`). `getCalendarEventDetails` no longer returns
  `recurrenceIdError`. An event_id that names no event gets `EDIT_EVENT_NOT_FOUND_ERROR` from both paths, which
  tells the assistant to look the event up again (calendar_search or calendar_read) and not to retry the same id:
  before #339 an edit giving no times got that guidance from the list state's read, and the bridge's own text was
  a terse "event not found". The census of the two functions' refusals is
  `test/calendarEditRefusedBeforeCard.test.js`.
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
  `asShown`, `asAllDayDate`, `intoFrameOf`, `restates` → `getTimezoneService`; `writeRuleItem` → `getIcsService`) are listed in the exhaustive census in `test/calendarServiceAcquisition.test.js`
  (2026-11-11: `toCalIDateTimeInFrameOf`, `shownNaiveIso`, `shiftSeriesWithStart` and the split no longer call it).
- Series time edits (2026-11-11, ADR-031) on Thunderbird's own date code (`test/helpers/nativeCalendarDates.js`,
  the CalDuration fixture) and an independent 2099 offset table (`test/helpers/zoneOffsetTable.js`, checked
  against Intl): `calendarSeriesTimePrimitives` (sweeps of `afterElapsed`, `atInstantInFrameOf`, `intoFrameOf`,
  `shownNaiveIso`, `applyNewLength`), `calendarSeriesTimesWest`/`East` (every occurrence ends at the end given,
  the named one read back, the card equal to the read, Thunderbird's own length, restated printed times no
  change, floating digits kept), `calendarSeriesTimeRefusals`, `calendarSeriesReset`, `calendarEditNoChange`
  (the no-change path, the check failing, the check's declared names), `calendarEditCardOccurrence` (#369) and
  the source fence `calendarSeriesTimeFence` (no `getInTimezone`, `.compare(` or `sameTime(` in the owned
  functions; `nativeTime`, `subtractDate(`, `addDuration(` only where listed). The flow helper
  `test/helpers/seriesEditFlow.js` runs an edit through the tool, the card and the read tools.
