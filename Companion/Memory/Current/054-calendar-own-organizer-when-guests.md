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

## Where it runs

- create: after the attendees, before `addItem`; no longer depends on `send_invitations`.
- edit `all` (the series clone), `this_only` (the occurrence clone only; its series is not written for it),
  one-off: after the guest change, before `modifyItem`. Reverses the old "don't set organizer during modify".
- split: on the new series AND the earlier part, before the ask-again step, so the organizer (same address as
  an attendee entry) is not reset to NEEDS-ACTION.
- delete `this_only` / `this_and_following`: on the series written in place (`replacement`), after `check_only`.
- whole-event `deleteItem`: unchanged; writing an organizer first would itself be an invitation.

`send_invitations`, `sendCalendarInvitations`, `getInvitePolicy` etc. stay for now (cleanup is TB #429).
Supersedes the 050 statements that an edit's organizer is whatever `organizer_email` the tool fills in.
Tests: `test/calendarOwnOrganizer.test.js` (harness `loadCalendarBridge` takes `calendarProperties`).
