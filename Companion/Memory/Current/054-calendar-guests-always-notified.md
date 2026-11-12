# Calendar guests are always notified (#423)

Every write the calendar bridge (`chat/experiments/tmCalendar/tmCalendar.sys.mjs`) makes to an event that
has guests tells them. There is no argument for it: the tools' `send_invitations` argument is retired, and
nothing is refused for having no one to tell.

## How

The bridge does what Thunderbird's own event dialog does with "Notify attendees" ticked, the way Thunderbird's
transactions do it (`CalTransactionManager`: `CalModifyTransaction` writes
`cal.itip.prepareSequence(item, oldItem)`, then `_dispatch` calls `cal.itip.checkAndSend`):

- `prepareGuestWrite(item, oldItem)` sets `X-MOZ-SEND-INVITATIONS=TRUE` on the item about to be written
  (`CalItipMessageSender.buildOutgoingMessages` builds no REQUEST or CANCEL without it) and, for a
  modification, returns `cal.itip.prepareSequence(item, oldItem)` (SEQUENCE bumped on a major change; a copy
  when bumped), when it or the item it replaces has guests.
- `notifyGuests(op, item, oldItem, { exdateRids })` does what `checkAndSend` does, with Thunderbird's own
  `CalItipMessageSender` (`resource:///modules/CalItipMessageSender.sys.mjs`), the invited-attendee check
  included, `responseMode: AUTO` (the chat's confirmation card is the user's yes; the default USER asks again).
  It keeps `send()`'s answer, which `checkAndSend` drops: no transport for the calendar (no email identity)
  or a refused send is reported as `{ ok: false, error }`, never taken as sent.
- Thunderbird decides who sends: `CalItipOutgoingMessage.send` leaves the message to a calendar that
  schedules itself (`calISchedulingSupport.canNotify`: CalDAV server scheduling, Exchange/Graph providers)
  and otherwise sends iMIP through `cal.itip.getImipTransport(item)`. The bridge does not guess the provider.

### The item before goes to the sender as a flagged copy

For a change that only adds an EXDATE, `buildOutgoingMessages` swaps in the ORIGINAL item's occurrence at that
date and reads `X-MOZ-SEND-INVITATIONS` from it, and an occurrence proxy reads it from its stored parent
(`CalItemBase.getProperty`). A stored event synced from a server has no flag, so the bridge passes the sender
a flagged copy of the item before (every MODIFY), or no CANCEL would be built.

### No message built is never success

`sendGuestNotice` returns `{ ok: true }` only when a message was built and `send()` took it. Built nothing:
`reason: "not_organizer"` when the user is a guest of the event (Thunderbird sends at most the user's reply;
the words say the other guests were not notified because the user is a guest), else `reason: "no_message"`
(owner the only attendee, or nothing the guests are sent). `send()` refused: `reason: "send_failed"`.

### Scheduling agent, as the event dialog sets it

The dialog calls `cal.itip.adaptScheduleAgent(item)` before saving (comm-central
`calendar/base/content/item-editing/calendar-item-iframe.js` onCommandSave). On a CalDAV calendar with
server scheduling (`capabilities.autoschedule.supported`) and `forceEmailScheduling`, an organizer's write
marks the attendees `SCHEDULE-AGENT=CLIENT`, so the server stays quiet while Thunderbird emails
(`canNotify` is false then); otherwise guests get two notices. `prepareGuestWrite` does the same: Thunderbird's
`cal.itip.adaptScheduleAgent` where it exists (it is a dialog-window function on esr140), else the same code
copied from `calendar/base/modules/utils/calItipUtils.sys.mjs`. A created event is put on its calendar
before the write, as the dialog does, so the choice can read it.

### An occurrence edit that also excludes dates

The occurrence is written first; then the stored series is read again and a copy of it gets the EXDATEs
(the stored item is immutable; before #423 the EXDATEs were added to the stored item itself and lost).

### One cancellation per excluded date

`buildOutgoingMessages` turns a modification that only adds EXDATEs into a CANCEL of the FIRST added date
only ("xxx todo: support multiple"), so the guests would turn up to the other cancelled dates. When a write adds
several EXDATEs and changes nothing else (checked with `cal.item.compareContent` against the stored item
with those dates excluded, which ignores SEQUENCE, DTSTAMP and the notify flag), `notifyGuests` sends one
notice per date: a step from the item before to the same item with that one date excluded, which the sender
cancels. A write that changes more is one REQUEST carrying every EXDATE. The single write is unchanged.

### Failure is said, the change kept

The bridge's `invitations` is null (no guests), `{ ok: true }` (every notice handed on) or the first
`{ ok: false, error }` (logged with `console.error`). `chat/modules/calendarGuestNotice.js` turns it into the
bubble line and the tool result sentence: on failure, "The change was saved, but the guests could NOT be
notified: <why>. Tell the user ..."; on success, "handed to Thunderbird to send" (never "sent", since
delivery is Thunderbird's or the server's). The raw `invitations` object is no longer in the tool results.

The writes covered: create (ADD); an edit of an event, the series or one occurrence (MODIFY against the
stored item); the EXDATEs added to a series by a one-occurrence edit (MODIFY of the series); a delete of an
event or a whole series (DELETE, built from a flagged copy, since the stored item is immutable); a delete of
one occurrence or the following ones (MODIFY of the series without them; for "following", the shortened rule
is one REQUEST); a "this and following" split, both writes (MODIFY of the shortened earlier part, ADD of
the new series). Removing every guest still tells them: the old item had them.

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
- The harness (`test/helpers/calendarBridgeHarness.js`) stands in a recording `CalItipMessageSender`
  (`notices`, each with `sent`; `guestNoticeSend` makes send() fail or throw), a `checkAndSend` that drops
  send()'s answer as Thunderbird's does, `prepareSequence` (`sequenced`) and a content-only `compareContent`.
- `test/fsmPrevStateCompletion.test.js`: the create result carries the notice sentence.
