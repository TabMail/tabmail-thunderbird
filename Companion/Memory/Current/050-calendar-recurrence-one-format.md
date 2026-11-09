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
- **Only the stated fields are shown.** `interval` 1 and `wkst` MO are omitted.
- **`until` (read)** is the last day of the series in the event's zone:
  - A UTC `UNTIL` instant is converted with `calIDateTime.getInTimezone`. A timed event uses its start's zone; an all-day or floating event uses the user's zone.
  - A DATE or a floating value is read by its digits.
- **BYSETPOS:** one weekday at one position folds to its ordinal (`BYDAY=TU;BYSETPOS=2` becomes `2TU`).
- **`other`:** anything else goes there, e.g. BYWEEKNO, BYYEARDAY, BYHOUR, BYSETPOS with several days, or a FREQ the schema has no value for. The read line then adds "the edit tool cannot express these; omit recurrence to keep the rule".

## Writing

- **Validation at the tool boundary only:** `recurrenceArgError` runs in `calendar_event_create` and `calendar_event_edit` before the confirmation card. It refuses an invalid field with `recurrence.<field> has an invalid value "<value>": <allowed>`. The checks:
  - `freq` is in the enum and is required unless the object is `{}`;
  - `interval` and `count` are positive integers;
  - `until` is a real date or date-time, and `count` with `until` is refused;
  - `byDay` matches `^[+-]?([1-9]|[1-4][0-9]|5[0-3])?(MO|TU|WE|TH|FR|SA|SU)$`;
  - `byMonthDay` is ±1..31, `byMonth` is 1..12, and `wkst` is a day code;
  - `other` cannot be written.

  Because invalid input is refused there, the bridge's `buildRRuleValueFromDetails` passes values through without its own checks.
- **`{}` clears the rule:** `recurrenceInfo` becomes null and the RRULE property is deleted. It used to default to WEEKLY. `null` in an edit is the same as omitting the field.
- **Plain-date `until`** is the end of that day:
  - an all-day series gets a bare DATE;
  - a floating event gets `T235959`;
  - otherwise it is 23:59:59 in the event's zone, rendered as UTC.

  So the named day's occurrence stays in the series. A date-time `until` is the instant it names, as before.
- **Writing a rule replaces only the RRULE item** in the existing `recurrenceInfo`. EXDATE/RDATE items and changed occurrences stay with the series; they used to be dropped by a fresh `recurrenceInfo`.
- **Restated rules with `other` parts are refused.** An edit (`all` or `this_and_following`) that restates the rule of a series whose stored rule has `other` parts is refused before the card by `otherPartsRefusal`, because restating would drop those parts. `{}` (stop repeating) is allowed.
- **No rule comparison.** Neither client compares a restated rule with the stored one above the provider boundary. TB writes the rule through to Thunderbird's calendar.

## How it is pinned

- `test/calendarRecurrenceFormat.test.js` runs under TZ=America/Vancouver, with the real bridge in `node:vm` via `test/helpers/calendarBridgeHarness.js`. The harness's `fakeRecurrenceInfo` and `recurrenceItem` model RRULE/RDATE/EXDATE items by `icalProperty.propertyName`.
- `test/calendarTools.test.js` covers the refusal wiring before the card.
- New bridge accessor calls (`eventZone`, `untilDayFromIcs`, `untilForRRule` → `getTimezoneService`) are listed in the exhaustive census in `test/calendarServiceAcquisition.test.js`.
