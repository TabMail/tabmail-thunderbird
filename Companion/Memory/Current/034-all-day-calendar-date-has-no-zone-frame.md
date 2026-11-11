# An all-day calendar item is a DATE with no zone; never key it by its epoch

An RFC 5545 all-day value (`DTSTART;VALUE=DATE`) has no time zone and no instant. ical.js, which
backs `calIDateTime`, deliberately skips zone conversion for `isDate` values, so
`toEpochMsUTC(startDate)` and `startDate.nativeTime` of a floating DATE (an imported all-day event)
yield **UTC midnight of the calendar date**. Every consumer that re-expresses that epoch in the
user's zone then names the **previous day** anywhere west of UTC (#47): the grouped summary put a
holiday under the day before, and the `start_iso` the summary printed did not find the item on
lookup.

**Correction (#265, 2026-11-09):** "a DATE's epoch time is UTC midnight" holds only for a floating or
UTC DATE. `nativeTime` is `toUnixTime()`, which subtracts the DATE's own zone offset
(`Time.utcOffset`: 0 only for floating and UTC), so a DATE that carries a zone (an all-day event
made in a zone, as TabMail's create does: `toCalIDateTime` in the user's zone, then `isDate = true`)
reports midnight **in that zone**. Day arithmetic on a DATE therefore uses its digits
(`dayDigitsFrom`, `dayDateFrom`), and comparisons use `compare`, never the epoch, whatever zone
it carries. The harness's DATE follows its zone too.

**Written with no zone (#303, 2026-11-10):** every all-day value the bridge builds from a create or
an edit is now a DATE with no zone, as Thunderbird's own event dialog writes one
(`calendar-item-iframe.js` `onUpdateAllDay`: `gStartTimezone = gEndTimezone = cal.dtz.floating`).
`asAllDayDate(dt)` sets `isDate = true` and relabels `dt` floating (`cal.timezoneService.floating`;
the digits stay as read, a relabel converts nothing). Its callers:
- `createCalendarEvent` (start and end);
- `toCalIDateTimeInFrameOf`, which returns it first for an all-day edit, so every edit (whole
  series, one occurrence, the following part of a split) gets a floating DATE. An all-day edit is one
  with `all_day: true`, or one that leaves `all_day` out on an all-day item: the edit keeps the
  item's kind, as the edit tool's schema says ("Leave empty to keep existing"). Before #309 a missing
  `all_day` read as false, so new dates for an all-day event made it a timed one at midnight. This
  is the one place an edit's kind is decided: `applyDurationPreservation` (and its mirror) writes
  the converter's values as given (`test/calendarEditKeepsAllDay.test.js`). Two edits of an
  all-day item are refused before anything is written (`editTimesError`, `allDayEditError` until
  #350, which also refuses a start and an end of different kinds and a timed end before the start;
  an end alone keeps the item's own start, so its all-day end is compared with that start, after the times are
  applied, in `modifyCalendarEvent` and in the split's following part), and the message tells the
  assistant to ask the user: a `start_iso` or `end_iso` with a time of day and no `all_day` (the
  user may want a timed event or that date all day; a date at midnight, `T00:00:00` as the read
  tools show one, is a date), and an all-day end on or before the start (an all-day end is the day
  after the last day, RFC 5545 DTEND is exclusive, so it would be a zero-length event). Until this
  refusal, #309's converter kept such an edit all-day and dropped the time unasked. The edit tool
  gets these refusals before its confirmation card, so the assistant can ask the user first:
  `_runEditCalendarEvent` calls `modifyCalendarEvent` with `check_only: true` for every edit (#339;
  until then only for an edit that gives times), and the bridge runs the same edit up to its first
  write and returns without writing (the split too), so the rule is not copied into the tool.
  A create has the same end rule (#316):
  `createCalendarEvent` refuses an all-day event whose end is on or before its start, before
  anything is written, with a message that says what to send (the next day as `end_iso`), and the
  create tool gets it before its card the same way (`check_only` on `createCalendarEvent`, sent
  with the times (and `timezone` when given), the calendar and `all_day` only). A create's kind
  is stated, so it has no time-of-day refusal (`test/calendarCreateAllDayEnd.test.js`);
- `applyRecurrenceToItem`, which relabels an all-day item's start and end before it writes a rule,
  so a rule-only edit or a split's new rule on a series stored with a zoned start keeps the day its
  bare-date UNTIL names. Relabelling a DATE moves none of the series' dates: Thunderbird's
  `onStartDateChange` diffs the two starts in UTC, where a DATE keeps its digits.

Why it matters beyond display: ical.js compares a rule's UNTIL with each occurrence by instant
(`toUnixTime`), and a bare-date UNTIL is at offset 0, so west of UTC an all-day series with a zoned
start lost its last day, and a split of it was refused. A floating DATE's instant is its digits at
offset 0, so the last day is admitted.

**Every write of an all-day series writes plain dates (#329, 2026-11-10; Google Calendar's rule: an
all-day value is a DATE with no zone, and a date-start rule's UNTIL is a plain date).** Series stored
with zoned all-day DATEs (TabMail's before #303, or another app's) are not migrated; the next write
rewrites them. `asAllDayItem(item)` relabels, through `asAllDayDate`, every DATE of an all-day item:
DTSTART and DTEND, each EXDATE and RDATE date, and each changed occurrence's RECURRENCE-ID and its own
DTSTART/DTEND when they are dates (the exception is cloned, relabelled and stored again with
`modifyException(ex, true)`, which replaces the entry under the same `getRidKey`, as
`onStartDateChange` re-keys one). Timed values in those lists (an occurrence moved to a time of day,
a date-time EXDATE or RDATE) are left as they are. A rule's date-time UNTIL (released versions up to
v1.11.1 wrote every UNTIL as a UTC date-time from `new Date(until)`, and some apps do) is written as
a plain date: the bound's date in the start's stored zone, which is the last day Thunderbird shows
for the zoned series (ical.js compares the bound with each start at midnight in that zone). So a
bound in the local evening west of UTC does not gain the next day and one at local midnight east of
UTC does not lose its day. A date-only bound older versions wrote as `T000000Z` keeps the day it
showed (west of UTC, the day before the date the user gave); restoring the given date there would
move the other forms, and old data gets no code of its own, so it is left as shown (decided
2026-11-10; the user can give the series a new last day). The digits stay, so nothing moves:
`onStartDateChange` diffs the starts in UTC, where a DATE keeps its day (diff zero; comm-central also
converts each RECURRENCE-ID into the new start's or a matching RDATE's zone, which for a DATE is a
relabel), and `getRidKey` of a zoned DATE is its digits (converted to UTC, a relabel), so a changed
occurrence and an excluded date stay keyed to their occurrence. Its callers: an edit of the whole
series (`modifyCalendarEvent`, scope series, before its excluded dates and time change, also a
title-only edit), `applyRecurrenceToItem` (any rule written), and both parts of a split (the earlier
part before its cap is written, the following part once its recurrence is attached, before the time
change). `addExdateToItem` writes an all-day RECURRENCE-ID as a plain date. A one-occurrence edit
(this_only) writes no series dates: the series keeps whatever zone it has, the exception's
RECURRENCE-ID is the series' slot as stored, and its new dates are plain (`toCalIDateTimeInFrameOf`);
its `exdates_add` are written plain on the zoned parent (keyed by date, harmless). A rewritten series
west of UTC with a date UNTIL regains the day its UNTIL names, which Thunderbird dropped from the
zoned copy (the date the user and Google read it as); that is the only occurrence change (a
date-time UNTIL keeps its last day, above), and the split tests
compare the parts with the same series written with plain dates. The split's refusal of an earlier
part that would lose a day before the split (a look-back comparison of RECURRENCE-IDs) is deleted:
a zoned all-day start was its only trigger, and none reaches it now. Superseded (#303 to #329): values copied from a stored series kept its zone (the split's
following part when the edit restated no dates, `splitDt`, and EXDATEs, `addExdateToItem` cloning
the RECURRENCE-ID); stored zoned series were left as they were, only an edit that restated their dates
or wrote a rule rewrote the start and end floating, and the split's refusal guarded the rest. The harness moves dates as Thunderbird does for this: its
`onStartDateChange` diffs two DATEs by their days (in UTC, relabelled; read field by field, so a
Thunderbird date from `test/fixtures/mozilla` takes part too), and a DATE's `addDuration` adds whole
days only (ical.js `Time.adjust`). Pinned by `test/calendarAllDayHasNoZone.test.js`,
`test/calendarRecurrenceFormat.test.js` (split invariant over zoned east/west and plain all-day kinds)
and `test/calendarRecurrenceNative.test.js` (Thunderbird's own ical.js: the zoned start loses the
UNTIL's day, the rewritten one keeps it)
(TZ=America/Vancouver; harness `timezoneService.floating` is `FLOATING_ZONE`).

## The frame-free contract (PR #48)

- The bridge (`tmCalendar.sys.mjs`) emits `isAllDay`, `startDay`, `endDay` (`YYYY-MM-DD` from the
  DATE's own `year`/`month + 1`/`day` — `calIDateTime.month` is 0-based) on every `queryCalendarItems`
  row and on `getCalendarEventDetails`. `startMs`/`endMs` stay UTC midnight; they are still the sort
  key for timed items.
- An all-day `RECURRENCE-ID` is a DATE too. The bridge emits it as `${day}T00:00:00`
  (`allDayNaiveIso`), the shape `toNaiveIso` round-trips unchanged. `toNaiveIso` reads a bare `YYYY-MM-DD` from the model
  as that date at `T00:00:00` (#313; before, `new Date` read it as UTC midnight, a day early west of
  UTC), and returns null for input that is not a date, which the create and edit tools refuse before
  the card instead of using the current time.
- Consumers key an all-day row by `startDay`, never by the epoch: `calendar_search` uses
  `localMidnightOfDay(startDay)` for the day key and ordering; `calendar_event_read` renders
  `start_iso`/`end_iso` as `${day}T00:00:00` and matches a `start_iso` lookup on the day.
- The confirmation cards (#312, #358) are consumers too. The edit and delete cards read the stored
  times through `shownEventTimesIso(details)` (keyed by `startDay`/`endDay`), never
  `new Date(details.start)`, and the edit, delete and create cards print every start and end through
  ONE formatter, `formatCardTime(naiveIso, { allDay, endAfter, timezone })` in `chat/modules/helpers.js`.
  An all-day value prints as `<Weekday> YYYY/MM/DD` from its date digits only, never through the
  DATE's epoch or a zone: the weekday and the day before come from `new Date(Date.UTC(y, m - 1,
  d + shift))` read back through the getUTC* getters only (the zone-free day arithmetic
  `isValidPlainDate` and the bridge's `dayDigitsFrom` use; a local getter names the previous day
  west of UTC, a local constructor the previous day east of it); an all-day end prints the last
  day, the day before the exclusive DTEND, never before the start shown beside it (`endAfter`), so a
  DTEND equal to DTSTART shows one day, as Google Calendar does. A timed value prints through
  `formatNaiveIsoInTimezone`, unchanged. All-day change lines read **Start date**/**End date** (the
  new value's kind decides), timed ones **Start time**/**End time**. A new value's kind is `all_day`
  when given, else the event's own. The edit card decides "changed" by the naive values and their
  kinds (all-day by day; timed by digits, and always shown when `timezone` is given), not by
  comparing formatted strings, which outside UTC showed an unchanged all-day start as a change. The
  Scope line names an all-day occurrence (`recurrence_id`, `recurrenceIdSlot`) by its date, taking
  the kind from the event read. Pinned by `test/calendarCardAllDayDates.test.js` (Thunderbird's own
  dates, west and east of UTC, plus a four-year sweep from today over every month end, year end and
  leap day against a local-noon oracle).

## The second filter that dropped the item

`queryCalendarItemsInternal` asked the provider for items in `[start, end)` and then re-filtered
the answer with `calIDateTime.compare`. Those are NOT the same test: `compare` treats a DATE as equal
to any date-time on the same day, so the ±60 s window `calendar_event_read` builds around an
all-day `start_iso` satisfied the provider (`compare(end) == 0`, not `< 0`) and was dropped by the
bridge. The provider's bounded range query is now the only window filter. Grade the fix on what it
deleted; do not reintroduce a bridge-side overlap pass "for safety".

## How it is pinned

`test/calendarAllDayFrame.test.js` pins the process zone to `America/Vancouver` before any Date
arithmetic and runs BOTH sides: consumers with a hand-written `startDay`, and the real bridge
executed in `node:vm` via `test/helpers/calendarBridgeHarness.js` — a fake `calIDateTime` keeping
the semantics that matter (a DATE made without a zone reports UTC-midnight `nativeTime`, one with a
zone reports midnight in it, and `compare` is CalDateTime's: date-only when either side is a DATE,
the other side read in this side's zone; by digits when either side is floating). Reinstating the compare filter fails the tight-window and `start_iso`
lookup tests. A consumer test with a hand-written `startDay` proves nothing about whether the bridge
emits one; keep the producer-backed tests when touching the bridge.
