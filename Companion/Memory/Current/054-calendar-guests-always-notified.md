# Calendar guests are always notified (#423)

Every write the calendar bridge (`chat/experiments/tmCalendar/tmCalendar.sys.mjs`) makes to an event that
has guests tells them. There is no argument for it: the tools' `send_invitations` argument is retired, and
nothing is refused for having no one to tell.

## How

The bridge does what Thunderbird's own event dialog does with "Notify attendees" ticked, through the entry
point Thunderbird's transactions use (`CalTransactionManager` -> `cal.itip.checkAndSend`):

- `markGuestsNotified(item, oldItem)` sets `X-MOZ-SEND-INVITATIONS=TRUE` on the item about to be written,
  before the write, when it or the item it replaces has guests. `CalItipMessageSender.buildOutgoingMessages`
  builds no REQUEST or CANCEL without that flag.
- `notifyGuests(op, item, oldItem)` calls `cal.itip.checkAndSend(calIOperationListener[op], item, oldItem,
  { responseMode: calIItipItem.AUTO })` after the write. AUTO, because the chat's confirmation card is the
  user's yes; the default (USER) would ask again.
- Thunderbird then decides who sends: `CalItipOutgoingMessage.send` leaves the message to a calendar that
  schedules itself (`calISchedulingSupport.canNotify`: CalDAV server scheduling, Exchange/Graph
  providers), and otherwise sends iMIP through the calendar's `itip.transport`. The bridge does not guess
  the provider any more.

The writes covered: create (ADD); an edit of an event, the series or one occurrence (MODIFY against the
stored item); the EXDATE added to a series by a one-occurrence edit (MODIFY of the series: Thunderbird turns
an EXDATE-only change into a CANCEL of that occurrence); a delete of an event or a whole series (DELETE,
built from a flagged copy, since the stored item is immutable); a delete of one occurrence or the following
ones (MODIFY of the series without them); a "this and following" split, both writes (MODIFY of the shortened
earlier part, ADD of the new series). Removing every guest still tells them: the old item had them.

The result's `invitations` is `{ ok: true }`, `{ ok: false, error }` (logged with `console.error`; the
write itself stands), or null when there were no guests.

## What it replaced

Before #423 the bridge only reported a policy. `getInvitePolicy` guessed "server" for Exchange-like and
Google CalDAV calendars and "mail" for the rest, and "mail" answered "not implemented yet": no guest on a
plain CalDAV or local calendar was ever told by a TabMail write, whatever `send_invitations` said, and the
X-MOZ flag was never set, so Thunderbird's own scheduling never ran either. The draft iMIP sender
(`sendCalendarInvitations`, unreachable, on dead `itip-service` / bare `itip-transport` contracts) and the
unexposed `setGoogleInvitePolicy` went with it. `send_invitations=true` with no guests was refused
("requires at least one attendee").

## Tests

- `test/calendarGuestsAlwaysNotified.test.js`: every write kind through the real bridge.
- `test/calendarGuestChange.test.js` ("every edit tells the guests"): from the tool's `run` through the
  edit flow, on every scope.
- The harness (`test/helpers/calendarBridgeHarness.js`) records each `checkAndSend` call in `notices`.
