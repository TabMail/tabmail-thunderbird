# ADR-031: A Series' Time Edit Has One Decision Point, a Wall-Clock Length and One Zone Conversion

**Status:** Accepted (2026-11-11). Issues #369, #365, #330, #368, #326 (excluded dates and changed
occurrences), the series halves of #352 and #317. Detail: note 050 (*Whole-series time change*, *Split*).

## Context

A time change of a repeating series (`edit_scope` `all`, or `this_and_following` over the part a split
starts) was read and written by several pieces of code, each with its own idea of the series' length
and of the zone a time is read in:

- the length was Thunderbird's elapsed DTEND minus DTSTART, so a series whose first night spans a clock
  change gave every later night an hour more or less than the user asked for (#365), and an all-day
  series stored with zoned dates lost a day across the spring change (#330, #368);
- a named occurrence changed on its own took the edit through its own function, with its own
  end-before-start text, and the changed occurrences of the series kept their own times
  ("keep my edits") while their RECURRENCE-IDs moved, which for a change between all-day and timed left
  them, and the excluded dates, in the old value type (#326);
- stored values were converted into another zone with `getInTimezone`, which lands an hour off near a
  clock change;
- the confirmation card read its old values from the series, not the occurrence the edit names, and
  compared times in its own way (#369).

Google Calendar is the reference: a new start of "All events" resets every occurrence changed on its
own and brings back the deleted ones; an end alone changes the length; a time the event already has is
no change.

## Decision

- **One decision point.** `resolveEditTimes(item, patch, tz, namedRid)` reads the edit's times against
  the occurrence it names (or the first), as Thunderbird builds it (`createProxy`), and returns the new
  start in the item's frame and the length, or a refusal. The series' own start, named at an occurrence
  moved on its own, is the time the series already has: no change, and an end is then measured from the
  first slot. Every scope drops a time the edit only restates by one rule, `timesLeft` (an end is
  dropped only when no new start is kept), so a single event, one occurrence, a series and a split
  agree on "no change".
- **One writer.** `writeSeriesTimes(item, start, length)` is the only writer of a series' or a part's
  start and end.
- **The length is wall-clock.** `W` is the end's clock digits minus the start's, read against the named
  occurrence. The stored end is `afterElapsed(start, W)`: the instant Thunderbird reads `W` after the start,
  so every plain occurrence (rid plus the stored elapsed length, added by the clock) ends at the end given.
  A changed occurrence of the series' kind takes its own start plus `W` by the clock (`applyNewLength`);
  one made all-day or timed on its own keeps its times. An all-day length is whole days by the date digits.
- **A new start resets.** `resetChangedOccurrences` removes every changed occurrence and every excluded
  date of the series (or of the following part) before the edit's own excluded dates are added; added
  dates and EXRULEs stay. Stopping the repeat resets nothing. The check before the card reports it
  (`resetsChangedOccurrences`) and the card says so.
- **One zone conversion.** A time given in another zone reaches the event's frame only through
  `atInstantInFrameOf` (whole days by the clock, then the elapsed rest), via `intoFrameOf`. A null result
  (the first pass of a repeated hour, which the frame cannot store) and digits the given zone skips are
  refusals made before any write. No function on the edit path calls `getInTimezone`; a source fence
  test parses the bridge and pins it.
- **The card and the no-change path read the check.** The check (`check_only`) returns `changes`,
  `times` (from the named occurrence as printed to that occurrence as written) and
  `resetsChangedOccurrences`; the card's time lines come only from `times` (no Timezone line), and
  `changes: false` ends the edit with "Nothing changed", no card and no write. A check that throws or
  answers nothing refuses the edit before the card.
- **Refused, writing nothing:** an end before the start (the usual text, measured on `W`); an end alone
  named at an occurrence made all-day or timed on its own; a first occurrence that would end inside the
  first pass of the repeated hour; a change between all-day and timed while added dates, excluded dates
  the same edit gives, or (without a new rule) an UNTIL would be left in the other value type.

## Consequences

- Every plain occurrence ends at the end given, across clock changes, and a restated printed time is
  never a change.
- An occurrence changed on its own is lost on a new start, as in Google Calendar; the card warns first.
- Trade-off: a few corner cases are plain refusals rather than a result an hour off (an end in the first
  pass of the repeated hour on the first occurrence; a time in another zone that is the first pass of
  the repeated hour in the event's zone). When the first occurrence spans a clock change its stored end
  is an hour off the end given, though Thunderbird shows every occurrence with the end given.
- Deleted: the named-occurrence edit function, the keep-my-edits move of changed occurrences, the
  split's slot-based end-before-start text, and the zone conversion of stored values on the edit path.
  `applyDurationPreservation` keeps one caller (single events and one occurrence).

## Alternatives rejected

- Keep the elapsed length and fix each corner: every corner was one more conversion with its own
  hour-off case.
- Keep changed occurrences on a start change ("keep my edits"): their RECURRENCE-IDs move by a UTC
  amount, which leaves them off their slots on a change of kind or across a clock change; the reference
  app resets them.
- Convert stored values with `getInTimezone`: the source of the hour-off results.
