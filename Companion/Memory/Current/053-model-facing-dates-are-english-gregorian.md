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
  day header, `memory_search` and `memory_read` result dates, the knowledge base refine's session
  dates (`knowledgebase.js`) and recent-chat context (`chatHistoryQueue.js`), the reminder greeting
  and due labels (`reminderBuilder.js`, `proactiveCheckin.js`), the scheduled-task "It is now ..." line,
  the summary's `email_day_of_week`, and the debug test nudge's time. Output in an English UI is
  unchanged.
- Dates only the user reads (settings and history pages, the message-list thread bubble, the chat's
  event-link tooltip and @-mention list, the archive/delete selection rows) stay in the user's locale.
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
