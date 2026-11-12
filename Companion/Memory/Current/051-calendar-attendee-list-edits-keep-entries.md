# Calendar edits: an attendee change keeps everyone still on the list as stored

The calendar edit tool changes attendees as a delta (`add_attendees`, `remove_attendees`). The chat's edit flow
(`chat/fsm/calendarEdit.js`) passes the delta to the bridge as given. The bridge (`tmCalendar.sys.mjs`) applies
it, with one function, to each item the edit covers.

## The rule (#297, #332, #333)

- ONE merge, in the bridge: `applyGuestChange(item, { add, remove })`. Nothing above the bridge reads the
  stored guests or merges. (A merge in the edit flow runs where the items are not: it can only see one list.)
- The items an edit covers, each changed on its OWN list:
  - a one-off event: the event;
  - `this_only`: that occurrence (its own list when it was changed before, else the series' list it starts from);
  - `all`: the series and every occurrence changed on its own (`applyGuestChangeToSeries`);
  - `this_and_following`: the new series and every changed occurrence carried into it. The earlier part
    keeps its guests. A split at a changed occurrence is made, guests and every other field the edit names
    included (#287): that occurrence takes the edit and keeps its own changes the edit does not name.
- An occurrence with guests of its own keeps its own differences apart from what the change names: a guest
  it added stays, a guest it removed stays removed unless the change adds them.
- Reading an address (`attendeeAddress`): trimmed, every leading `mailto:` dropped (any case, spaces after
  it), compared in lower case. Stored ids and the edit's addresses are read the same way. A removal of
  exactly `*` (after trimming) removes everyone; `mailto:*` names no one. Additions of `*` or nothing are dropped.
- Removals first, then each addition not already listed, once, in the order given. An addition whose address
  was on the item before the change (removed and added back in one edit, or a list restated after `*`) gets its
  stored entry back, answer included; it is placed with the additions. A new guest is a new
  `calIAttendee` at `NEEDS-ACTION` with `RSVP=TRUE`, its address in the case it was written, and a name
  only when the edit gives one.
- Everyone who stays keeps their entry exactly as stored: their answer (`PARTSTAT`), `RSVP`, role, user
  type, name and every other parameter, in their stored order. Thunderbird's own event dialog does the
  same: it keeps the attendee objects it does not change.
- Guests are always told (#423): `send_invitations` is retired and nothing is refused for having no one
  to tell. Every write of an item with guests, before or after it, is handed to Thunderbird's scheduling
  (see [054-calendar-guests-always-notified.md](054-calendar-guests-always-notified.md)). Until #423,
  `send_invitations` was checked after the change and refused an edited item that ended with no guests.
  An edit of an event that has guests need not restate them.
- The experiment's `schema.json` declares `add_attendees` / `remove_attendees` on `modifyCalendarEvent` and
  on the split's patch; a flat `attendees` list is declared only for `createCalendarEvent`. A guest item's
  `name` is `"optional": true` (a schema property is required unless marked optional).
- The confirmation card lists the people added and removed, with no count: the lists an edit covers can differ.

## What it replaced

Before #297, whole-series and single-occurrence edits removed every attendee and created a fresh one per
address (email, name, `RSVP=TRUE`, no answer). Everyone who stayed lost their answer, role and other
parameters on every attendee change, and the reset reached the calendar where the other attendees see it.
The split's following part kept entries since #291; #297 moved that step into the shared helper.

From #297 until #332/#333, the edit flow merged the delta (`applyAttendeeDelta`) against the SERIES' list and
handed the bridge one flat list (`patch.attendees`), written to one item by `setAttendeeList`. A this-only
edit of an occurrence with its own guests overwrote them with the series' list (#332), and a whole-series or
this-and-following change never reached the changed occurrences (#333). Both functions are gone.

## Related

- The split's own rule for asking attendees again when it reschedules the following part:
  [050-calendar-recurrence-one-format.md](050-calendar-recurrence-one-format.md).
- Tests: `test/calendarAttendeeChangeKeepsEntries.test.js` checks the rule for all three edit kinds and for
  an occurrence already changed on its own.
- Tests: `test/calendarGuestChange.test.js` runs the table of guest changes from the tool's `run` for every scope,
  with each bridge call checked against `schema.json`.
