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

**Written with no zone (#303, 2026-11-10):** every all-day value the bridge writes is now a DATE
with no zone, as Thunderbird's own event dialog writes one (`calendar-item-iframe.js`: for an
all-day event, `gStartTimezone = gEndTimezone = cal.dtz.floating`). `asAllDayDate(dt)` sets
`isDate = true` and relabels `dt` floating (`cal.timezoneService.floating`; the digits stay as read,
a relabel converts nothing). Its callers: `createCalendarEvent` (start and end) and
`toCalIDateTimeInFrameOf`, which returns it first when `patch.all_day`, so every edit (whole
series, one occurrence, the following part of a split) and the duration-preservation mirror get a
floating DATE without the mirror changing. Why it matters beyond display: ical.js compares a rule's
UNTIL with each occurrence by instant (`toUnixTime`), and a bare-date UNTIL is at offset 0, so west
of UTC an all-day series with a zoned start lost its last day, and a split of it was refused (the
earlier part's check, 050). A floating DATE's instant is its digits at offset 0, so the last day is
admitted. Series stored with a zoned all-day start (TabMail's before #303, or another app's) are
left as they are (no migration); an edit that restates their dates rewrites them floating, and the
split's refusal still guards them. Pinned by `test/calendarAllDayHasNoZone.test.js`
(TZ=America/Vancouver; harness `timezoneService.floating` is `FLOATING_ZONE`).

## The frame-free contract (PR #48)

- The bridge (`tmCalendar.sys.mjs`) emits `isAllDay`, `startDay`, `endDay` (`YYYY-MM-DD` from the
  DATE's own `year`/`month + 1`/`day` — `calIDateTime.month` is 0-based) on every `queryCalendarItems`
  row and on `getCalendarEventDetails`. `startMs`/`endMs` stay UTC midnight; they are still the sort
  key for timed items.
- An all-day `RECURRENCE-ID` is a DATE too. The bridge emits it as `${day}T00:00:00`
  (`allDayNaiveIso`), the one shape `toNaiveIso` round-trips unchanged; a bare `YYYY-MM-DD` re-parses
  as UTC midnight and shifts a day west of UTC.
- Consumers key an all-day row by `startDay`, never by the epoch: `calendar_search` uses
  `localMidnightOfDay(startDay)` for the day key and ordering; `calendar_event_read` renders
  `start_iso`/`end_iso` as `${day}T00:00:00` and matches a `start_iso` lookup on the day.

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
