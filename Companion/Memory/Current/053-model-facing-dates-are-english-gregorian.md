# Dates the assistant reads or the add-on writes are English Gregorian (#405)

Recorded 2026-11-11.

## What Thunderbird does

Thunderbird's JS default locale is its UI language, in the extension's pages too. Measured in
Thunderbird 159 with the Thai language pack and `intl.locale.requested = th`: `navigator.language`
and `browser.i18n.getUILanguage()` are `th`, and `Intl.DateTimeFormat().resolvedOptions()` is
`{ locale: "th", calendar: "buddhist", numberingSystem: "latn" }`. The add-on's own `formatDayHeader`
(`calendar_search`, `toLocaleDateString(undefined, ...)` before the fix) printed 2026-11-12 as
`วันพฤหัสบดีที่ 12 พฤศจิกายน 2569`: the Buddhist year, Latin digits. A Persian UI gives the Persian
calendar (1405) in Persian digits (Node's ICU, same data). The header is the only date the assistant
sees for a timed occurrence, so a reply or an event it creates or moves could carry the wrong year.

## The rule

- `formatGregorianDate(date, options)` (`agent/modules/gregorianDate.js`, no imports, safe to load
  anywhere) prints every date the assistant reads or the add-on writes: `Intl.DateTimeFormat("en-US",
  { ...options, calendar: "gregory", numberingSystem: "latn" })`. Its callers: the `calendar_search`
  day header, `memory_search` and `memory_read` result dates, the reminder greeting and due labels
  (`reminderBuilder.js`, `proactiveCheckin.js`), the scheduled-task "It is now ..." line, the
  summary's `email_day_of_week`, and the debug test nudge's time. Also the knowledge base refine's
  session dates (`knowledgebase.js` `_kbUpdateImpl`) and recent-chat context (`chatHistoryQueue.js`
  `getRecentChatHistoryForPrompt`), which are currently unreachable or test-only: `kbUpdate` is only
  called with a `conversationHistory` its one sender never sends, and `getRecentChatHistoryForPrompt`
  has no caller outside the tests; they were moved because the fence covers them. Output in an English
  UI is unchanged for valid dates.
- The helper throws `RangeError` on an Invalid Date (`Intl.DateTimeFormat#format`), where
  `toLocaleDateString` returned "Invalid Date". A caller that can receive a model-written date checks
  it first: `_formatDueLabel` returns "" for an unparseable due date such as `not-a-date`, as its twin
  `formatDueDate` in `reminderBuilder.js` does, so the new-reminder nudge still goes out
  (`test/proactiveNewReminderInvalidDueDate.test.js`).
- Gregorian/ISO is the one normal form wherever a date is stored, sent or parsed; the user's calendar
  only changes what is drawn (owner, 2026-11-12). So a date is never kept as a locale string and parsed
  back: the event-link tooltip (`markdown.js`) keeps the event's `start`/`end` as `tmCalendar` returns
  them (epoch ms) and formats them only in `showTooltip`, with fixed English names
  (`test/eventLinkTooltipDate.test.js`); the archive/delete selection rows carry `dateMs` (the header's
  time; `buildInboxContext` entries carry it too), `renderEmailSelectionList` sorts by it and formats
  it only where it draws a row (`test/emailSelectionListDateOrder.test.js`). Before, en-GB read
  12 November back as 11 December, and a Thai string kept the Buddhist year.
- Dates only the user reads (settings and history pages, the message-list thread bubble, the chat's
  @-mention list, the drawn archive/delete selection row) stay in the user's locale.
- The day header matches the iOS twin exactly: `formatDayHeader("2099-12-30", tz)` is
  "Wednesday, December 30, 2099" for any default locale (`modelFacingDatesGregorian.test.js`), in
  every zone, both sides of the date line (#406, below).
- **A date-only value is formatted as a date, never as an instant in a zone (#406, 2026-11-11).** A
  calendar day (`YYYY-MM-DD`: a day key, an all-day date) has no zone and no instant. Building an
  instant from it (`Date.UTC(y, m - 1, d, 12)`, "noon to dodge DST") and formatting that in the
  user's zone names the next day at UTC+12 and later (noon UTC is already tomorrow in Auckland,
  Fiji, Tonga, Kiritimati, Kamchatka), and midnight-UTC instants name the previous day west of UTC.
  The `calendar_search` day header did exactly this, so a Thursday's events were listed under
  "Friday" for a New Zealand user. `formatGregorianDay(dayKey, options)` (`gregorianDate.js`)
  prints such a value: UTC midnight of the digits, formatted with `timeZone: "UTC"` (a caller's
  `timeZone` is overridden), so neither the user's zone nor the process zone can move it. Use it
  for every date-only value the assistant reads; the `timezone` the header reports is unchanged.
  The old `CHAT_SETTINGS.middayHourForDateHeader` is gone.
  **The event-link tooltip (#407, 2026-11-12):** an all-day event's link carries `allDay`, `startDay` and `endDay` (from `getCalendarEventDetails` through `resolveEventDetails`), never its instant, and `showTooltip` prints `Thursday, Nov 12` (or `Thursday, Nov 12 -- Saturday, Nov 14`, last day by `allDayLastDay` in `helpers.js`, which `formatCardTime` shares) then `All day` through `formatGregorianDay`; before, west of UTC it named the previous day with a time (`test/eventLinkAllDayTooltip.test.js`, the real bridge in four zones). The @-mention list's date (`resolveEventDetails` `startDate`, user's locale) has the same cause and fix: an all-day event's day is built from `startDay` and formatted with `timeZone: "UTC"`, so it reads `11/12/2099` (en-US) or `12/11/2099` (en-GB) in every zone and typing that date finds it. Timed events are unchanged.
  An unknown `timezone` argument (e.g. "NZDT") is refused once, where it enters
  `buildCalendarSummary`, before the range is resolved or the calendar queried: `calendar_search`
  and `calendar_read` return `Unknown time zone "NZDT". Use an IANA zone such as
  "Pacific/Auckland".` and nothing is cached, so a corrected retry in the same turn lists afresh.
  The check is the same `Intl.DateTimeFormat` construction the zone conversion uses, so it refuses
  exactly the zones that conversion would have turned into "now" (an empty or wrong listing).
  Pinned by `test/calendarDayHeaderDateLine.test.js` (exact "Thursday, November 12, 2099" for the
  key 2099-11-12 in zones from Pago Pago to Kiritimati, a one-year sweep against a digit oracle,
  `run()` with an explicit zone east of UTC+12, and the unknown-zone refusal followed by a
  corrected retry) and `test/gregorianDay.test.js` (the helper under several process zones,
  options zones and default locales).
- Digit-built formatters (`formatTimestampForAgent`, `formatCardTime`, `toIsoNoMs`, `toNaiveIso`)
  use `Date` getters, which are always Gregorian; they need no locale. Explicit `"en-US"` or `"en-CA"`
  `Intl` calls that only extract parts (`formatToParts`, a zone offset, a `YYYY-MM-DD` key) are
  Gregorian too and stay as they are.
- `Intl.DateTimeFormat().resolvedOptions().timeZone` reads the zone only; it is fine.

## How it is pinned

- `test/localeDateFence.test.js` lists, by file, function and method, every `toLocaleString`,
  `toLocaleDateString`, `toLocaleTimeString` and `Intl.DateTimeFormat` call whose locale is left to
  the user (no argument, `undefined`, `[]`, or anything but an English literal) in the add-on's source,
  and compares with an exact allowlist of display-only uses (and `Number.prototype.toLocaleString`
  counts), each with its reason. A new call fails until it goes through `formatGregorianDate` or is
  listed as display-only.
- `test/modelFacingDatesGregorian.test.js` stubs the default locale to `th` and `fa`
  (`test/helpers/defaultLocale.js`: wraps the three Date methods and `Intl.DateTimeFormat` so a call
  with no locale gets the stub's) and checks the paths above against digit-built oracles.

## How it was measured

A throwaway profile with `user.js` (`intl.locale.requested = th`, `extensions.autoDisableScopes = 0`,
`extensions.langpacks.signatures.required = false`, `devtools.console.stdout.content = true`, update,
telemetry and default-client prompts off), the Thai language pack from Mozilla's release directory
(`releases/<version>/linux-x86_64/xpi/th.xpi`, unsigned; checked against `SHA256SUMS`) dropped in
`extensions/` as `langpack-th@thunderbird.mozilla.org.xpi`, and the add-on sideloaded as a proxy file
(`extensions/<add-on id>` holding the path of a copy of the source whose manifest's background is a
probe script). Thunderbird ran with `MOZ_HEADLESS=1 ... -headless -no-remote -profile <dir>`; the probe
imported `chat/tools/calendar_search.js` and `calendar_read.js`, ran them, and `console.log`ged the
result to stdout. The locale applies on the first start. In that headless profile the bridge's
`queryCalendarItems` returned no items from the default Home calendar (an event made through
`createCalendarEvent` was found by `getCalendarEventDetails`), so the header was read from the day
headers `calendar_read` builds for every day in range, not from an event row; memory 052 creates its
own calendars instead.
