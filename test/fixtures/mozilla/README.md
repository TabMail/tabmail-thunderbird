# Thunderbird calendar code used by tests

Unmodified copies of three files Thunderbird ships, so tests can check the
calendar bridge against the date, length and recurrence code Thunderbird
actually runs, instead of against a fake of it. All are under the Mozilla
Public License 2.0, like this repository.

| File | Source (comm-central revision 226a299e) | SHA-256 |
|---|---|---|
| `Ical.sys.mjs` | `calendar/base/modules/Ical.sys.mjs` | `968a58922da7b61cbc57655f9772bd70d2977237f7f9621c1ef3e2922c87173e` |
| `CalDateTime.sys.mjs` | `calendar/base/src/CalDateTime.sys.mjs` | `d37e2a6644317141b17ba8839e4fc1f1bbb822ea8389a997a9241b2eb7b2010d` |
| `CalDuration.sys.mjs` | `calendar/base/src/CalDuration.sys.mjs` | `db8c9afb17c48e742cc8f3037ff0eaac96619b3d35856097f22ee7dd02a46d8b` |

Fetched from `https://raw.githubusercontent.com/mozilla/releases-comm-central/226a299e/<path>`.
That revision is Thunderbird 161.0a1, newer than the versions the add-on
supports; the tests check the bridge against this one revision only. Recurrence
expansion differs between versions (BYSETPOS was rewritten in 159), which is why
the bridge does not translate rule parts whose expansion changed.

Used by `test/calendarRecurrenceNative.test.js`, whose first test checks the
hashes above, and through `test/helpers/nativeCalendarDates.js` by the series
time tests. They are test inputs only and are never loaded by the add-on.
