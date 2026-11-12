# 054 — An event saved with guests names the calendar's own address as organizer (#423)

2026-11-12. Owner rule: notices to guests are the calendar server's. A scheduling server (Google CalDAV,
Exchange add-ons, RFC 6638 CalDAV) notifies guests only of a stored event whose ORGANIZER is its own user, so
every item the bridge writes with guests must name that address. The add-on itself sends nothing: no `cal.itip`,
no `CalItipMessageSender`, no `SCHEDULE-AGENT`.

## The rule (one helper, `setOwnOrganizerIfGuests(item, calendar)` in `tmCalendar.sys.mjs`)

- The address is `calendar.getProperty("organizerId")` on the calendar being written, the property
  Thunderbird's own event dialog uses (CalDAV: the server's `calendar-user-address-set`; otherwise
  `mailto:` + the calendar's email identity). The name is `organizerCN` when it has one. `mailto:` is added only
  when missing.
- Set only when the item has guests and no organizer. An existing organizer is never changed, with every
  parameter (`SENT-BY`, `SCHEDULE-*`, `CN`): the user may be a guest of someone else's meeting.
- An event without guests gets no organizer (as Thunderbird's dialog).
- Never an address from the model: the old create path that set `organizer_email` (behind `send_invitations`)
  is gone; the argument is ignored. Its card line `Organizer:` is gone too.
- No address (`organizerId` empty, e.g. identity "None"): the event is saved with its guests and no
  organizer, no fallback, and the bridge returns `guest_notice` ("This calendar has no email address of its own,
  so the event was saved without an organizer and its server is not told to notify the guests."), which the fsm
  appends to the reply and `completeExecution` passes on. No reply text claims guests were emailed.

- Local calendar (owner ruling 2026-11-12): a write with guests to a calendar kept only on this computer
  (`calendar.type === "storage"`, Thunderbird's CalStorageCalendar) returns `guest_notice` "This calendar is kept
  only on this computer, so no one is emailed about it." (it takes precedence over the no-address line). Plain
  CalDAV stays silent; Google and Outlook are unchanged. One helper, `guestNoticeOf(calendar, results)`, builds
  the notice on create, every edit scope (a split counts both parts) and delete this_only / this_and_following.

## Where it runs

- create: after the attendees, before `addItem`; no longer depends on `send_invitations`.
- edit `all` (the series clone), one-off: after the guest change, before `modifyItem`. Reverses the old
  "don't set organizer during modify".
- edit `this_only` (review r1, corrected r2, 2026-11-12), only for a REAL occurrence (`base.recurrenceId` and
  `base.parentItem !== base`: in Thunderbird a one-off event is its own `parentItem`, so a one-off edit takes the
  plain path). The occurrence first takes its series' organizer when it has none of its own (address, name and
  flag only). The series is written ONCE, with the occurrence as its changed occurrence (`modifyException`), when
  the occurrence ends with an organizer AND the resource has guests (the series, any changed occurrence or the
  edited occurrence) AND `giveSeriesOrganizer` changes something: the series lacks an organizer, or any changed
  occurrence lacks one. Then the series and every changed occurrence carry the same ORGANIZER (RFC 6638 3.2.4.2
  same-organizer-in-all-components; a strict server refuses a mixed resource). Otherwise the occurrence is written
  as before. A guest-less series never gets an organizer from this path, even when a changed occurrence has one.
- "has guests" for a series means the series or any changed occurrence has some; every changed occurrence without
  an organizer gets the series' person (`organizerLike`: address, name and organizer flag only, never server
  parameters such as SCHEDULE-STATUS), on every series write above; one with its own organizer keeps it.
- split: on the new series AND the earlier part, before the ask-again step, so the organizer (same address as
  an attendee entry) is not reset to NEEDS-ACTION.
- delete `this_only` / `this_and_following`: on the series written in place (`replacement`), after `check_only`.
- whole-event `deleteItem`: unchanged; writing an organizer first would itself be an invitation.

`send_invitations`, `sendCalendarInvitations`, `getInvitePolicy` etc. stay for now (cleanup is TB #429).
Supersedes the 050 statements that an edit's organizer is whatever `organizer_email` the tool fills in.
Tests: `test/calendarOwnOrganizer.test.js` (harness `loadCalendarBridge` takes `calendarProperties`).
`guest_notice` is declared in the experiment's `schema.json` returns of createCalendarEvent, modifyCalendarEvent
and splitRecurringEvent (the schema check the guest-change tests run caught it undeclared, 2026-11-12). A
this_only edit that writes the series replaces the stored series object: tests read the stored item back from the
calendar, not the original fixture object.
