# Calendar edits: an attendee change keeps everyone still on the list as stored

The calendar edit tool changes attendees as a delta (`add_attendees`, `remove_attendees`). The chat's edit flow
(`chat/fsm/calendarEdit.js`, `applyAttendeeDelta`) merges the delta into the event's current list and hands the
bridge one flat list, `patch.attendees` (`{email, name}` per address).

## The rule (#297)

- Every edit that writes that list goes through ONE bridge helper, `setAttendeeList(item, list)` in
  `tmCalendar.sys.mjs`: a whole-series edit, a single-occurrence edit and the following part of a
  "this and following" split.
- Everyone still on the list keeps their entry exactly as stored: their answer (`PARTSTAT`), `RSVP`, role,
  user type, name and every other parameter. Addresses are matched without regard to case and without
  `mailto:` (`attendeeAddress`; Thunderbird's `getAttendeeById` also ignores case, but compares the whole
  id). The saved order is the list's order.
- An attendee the list adds is a new `calIAttendee` at `NEEDS-ACTION` with `RSVP=TRUE`, and a name only
  when the list gives one.
- Thunderbird's own event dialog does the same for everyone it keeps: it keeps the attendee objects it
  does not change. (Its defaults for an attendee it adds are its own.)
- A single-occurrence edit starts from that occurrence's own entries. An occurrence already changed on
  its own keeps its own answers, not the series' answers.

## What it replaced

Before #297, whole-series and single-occurrence edits removed every attendee and created a fresh one per
address (email, name, `RSVP=TRUE`, no answer). Everyone who stayed lost their answer, role and other
parameters on every attendee change, and the reset reached the calendar where the other attendees see it.
The split's following part kept entries since #291; #297 moved that step into the shared helper.

## Related

- The split's own rule for asking attendees again when it reschedules the following part:
  [050-calendar-recurrence-one-format.md](050-calendar-recurrence-one-format.md).
- Tests: `test/calendarAttendeeChangeKeepsEntries.test.js` checks the rule for all three edit kinds and for
  an occurrence already changed on its own.
