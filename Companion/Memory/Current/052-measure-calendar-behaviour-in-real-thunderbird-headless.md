# Measure calendar behaviour in real Thunderbird: headless, a throwaway profile, Marionette

When a test harness and Thunderbird might disagree (an issue "seen in the test harness, unconfirmed in
real Thunderbird"), measure Thunderbird itself before changing product code. #390 was such a case: the
harness answered "No entries matched." for a plain occurrence of a floating all-day weekly series looked
up by `start_iso` west of UTC; Thunderbird 159 found it, on a memory and a storage calendar alike.

## How

- A new temp directory with a `profile/` holding only a `user.js` (`marionette.port`, updates,
  telemetry and the default-client and account-setup prompts off). No account, no sign-in.
- Start the release binary for that process only, west of UTC:
  `TZ=America/Los_Angeles MOZ_HEADLESS=1 MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1 <Thunderbird.app>/Contents/MacOS/thunderbird --headless --marionette --no-remote -profile <tmp>/profile`.
  Without `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` Marionette refuses the chrome context. Headless mode
  shows no window and no Dock icon (`lsappinfo` lists no app for the PID).
- A small Marionette client (TCP, `length:json` frames: `WebDriver:NewSession`,
  `Marionette:SetContext {value: "chrome"}`, `WebDriver:ExecuteScript` with a script that returns a
  promise, `Marionette:Quit`) runs JS with `ChromeUtils`, `cal`, `Cc`/`Ci`.
- The bridge runs as the experiment loader runs it: a classic script in a system-principal
  `Cu.Sandbox` (`wantXrays: false`, `ChromeUtils` and `ReadableStream` as global properties, `Cc`,
  `Ci`, `Cu`, `Cr`, `Services`, `console` assigned). `loadSubScript` refuses a `file:` URL, so read
  the text with `IOUtils.readUTF8` and `Cu.evalInSandbox` it; its top-level functions
  (`queryCalendarItemsInternal`, ...) are then properties of the sandbox.
- A test calendar: `cal.manager.createCalendar("memory" | "storage", Services.io.newURI("moz-<type>-calendar://"))`,
  `registerCalendar`, items from Thunderbird's own ICS parser (`@mozilla.org/calendar/ics-parser;1`,
  `parseString`, `getItems`, which attaches changed occurrences to their series) and `addItem`.
- Thunderbird's calendar sources for reading are in `Contents/Resources/omni.ja` (`unzip -p ... modules/CalRecurrenceInfo.sys.mjs`).

## What #390 showed about Thunderbird's expansion

- `CalRecurrenceInfo.calculateDates` asks each rule and date for the range made date-times
  (`cal.dtz.ensureDateTime`) from `searchStart`, the range's start moved back by the series' length, then
  skips each item's leading dates that end at or before the range's start (`rangeStart.compare(date + length) < 0`
  keeps a date).
- `CalRecurrenceRule.getOccurrences` compares each occurrence with the range by ical.js `Time.compare`
  on copies made date-times (`isDate = false`): by instant, a DATE at midnight in its own zone, floating
  at offset 0. Not `CalDateTime.compare`, which takes a DATE by its date alone.
- `CalRecurrenceDate.getOccurrences` (RDATE, EXDATE) compares with `CalDateTime.compare`, over
  `[searchStart, rangeEnd)`.

The harness (`test/helpers/calendarBridgeHarness.js`, `ruleOccurrences` and `seriesOccurrences`) now
does all three. Before, the rule compared with `CalDateTime.compare` and from the range's own start, so
a floating all-day occurrence ended a `start_iso` window (±60 s around local midnight, the same date in
UTC) and was never returned; a changed occurrence was found because it goes through `checkIfInRange`.
Pinned by `test/calendarEditResultText.test.js` (every occurrence of the measured series, plain and moved,
read back by the `start_iso` the read prints; the all-day split round trip through the read tool).
Consequence for tests: a range that ends on a date is no longer "the whole day" for an all-day series
in a zone; `test/calendarRecurrenceFormat.test.js`'s split range ends at 12:00 UTC so every zone it
uses has the same last day.
