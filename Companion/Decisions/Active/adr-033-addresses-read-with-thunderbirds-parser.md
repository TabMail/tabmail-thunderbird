# ADR-033: Every Address Is Read With Thunderbird's Own Parser

**Status:** Accepted (2026-11-25).

## Context

The add-on read email addresses with its own string code: `senderFilter.js` scanned each `author`,
`recipients` and `ccList` entry for anything shaped like an address (quoted strings, comments and
brackets handled by hand, with length caps against slow regex cases), `messagePrefilter.js` kept a
regex copy for no-reply detection, the reply tool split names from addresses with a regex, and the
thread view took the text before the first `<` as the sender's name. A display name can hold any
text, `<`, `,` and `@` included, so each of these could read part of a name as an address, or show
part of an address as a name. iOS replaced its own scanner with SwiftMail's RFC 5322 parser in #214.

Thunderbird already parses every address header. `browser.messages` hands the add-on each From, To
and Cc mailbox as one entry that Thunderbird parsed from the raw header (structure first, encoded
words decoded inside it) and re-quoted, and `browser.messengerUtilities.parseMailboxString` reads an
entry back with the same parser.

## Decision

- **One parser.** Every address the add-on reads goes through Thunderbird's parser:
  `senderFilter.parseMailboxes(entry)` (`messengerUtilities.parseMailboxString`, one call per entry,
  address trimmed and lowercased) for the summary's Cc status, the To/From suppress,
  `isInternalSender`, no-reply detection (`extractEmailFromAuthor`) and the reply-all defaults; the
  thread view's bubble sender (`threadConversation.js`) reads the author entry's name the same way;
  the `threadMessages` experiment names a sender with `MailServices.headerParser.parseEncodedHeaderW`
  on the message header's raw From value.
- **No address text of our own.** The hand-written scanner, its caps and the prefilter's regex copy
  are deleted. A name is never read as an address and an address is never read out of a name.
- **Suppress reads only mailbox addresses.** The To/From suppress of the Cc status matches a
  mailbox's own address (plus-tags stripped), no longer an address that appears only inside a
  display name. A wrong suppress only omits the hint; iOS (`PromptVariables`) still suppresses on any
  address in the field text, a difference that can only omit the hint on one platform.
- **Tests use Thunderbird's parser.** Tests build each entry from a raw header with Thunderbird's
  JSMime (`test/helpers/tbAddressParser.js`; JSMime vendored unmodified under `test/vendor/jsmime/`,
  tests only, revision in its README), so expected values are what Thunderbird gives.

## Rationale

The add-on runs inside Thunderbird, whose parser already decided what each mailbox is. A second
parser of our own can only disagree with it, and every disagreement is a name read as an address
(a wrong Cc claim, a wrong own-account or no-reply decision) or a garbled name. Reading Thunderbird's
own result removes the class instead of adding cases to a scanner.

## Consequences

- One asynchronous messaging call per entry (run together with `Promise.all`); no call when the
  receiving account has no address.
- The display-name case recorded in the root contract note
  (`Companion/Memory/Current/summary-recipient-status-cc-contract.md`) does not occur on Thunderbird:
  Thunderbird hands such a name to the add-on as one escaped mailbox, read as one mailbox.
- A name that ends in a backslash loses that backslash in Thunderbird's re-quoting; the address is
  unaffected.
- Two display-only name strips in the message-list experiments (`tmMessageListTableView`,
  `tmMessageListCardView`) still use a regex on text Thunderbird already rendered; they read no
  address for any decision.
