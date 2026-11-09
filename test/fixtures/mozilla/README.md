# Thunderbird calendar code used by tests

Unmodified copies of two files Thunderbird ships, so tests can check the
recurrence bridge against the date and recurrence code Thunderbird actually
runs, instead of against a fake of it. Both are under the Mozilla Public
License 2.0, like this repository.

| File | Source (comm-central revision 226a299e) | SHA-256 |
|---|---|---|
| `Ical.sys.mjs` | `calendar/base/modules/Ical.sys.mjs` | `968a58922da7b61cbc57655f9772bd70d2977237f7f9621c1ef3e2922c87173e` |
| `CalDateTime.sys.mjs` | `calendar/base/src/CalDateTime.sys.mjs` | `d37e2a6644317141b17ba8839e4fc1f1bbb822ea8389a997a9241b2eb7b2010d` |

Fetched from `https://raw.githubusercontent.com/mozilla/releases-comm-central/226a299e/<path>`.
Used by `test/calendarRecurrenceNative.test.js`. They are test inputs only and
are never loaded by the add-on.
