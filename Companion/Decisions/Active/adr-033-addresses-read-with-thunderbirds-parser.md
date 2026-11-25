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

Thunderbird already parses every address header. `MailServices.headerParser.parseEncodedHeaderW`
reads a raw address header's structure first (quoted strings, quoted pairs, comments, groups)
and decodes encoded words only inside it. `browser.messages` gives the add-on that parse written
back out, one string per mailbox (`author`, `recipients`, `ccList`). That copy is not exact: a
display name that begins and ends with a quote mark is written out without quoting, so reading the
string again can give a different mailbox. `"\"x\" <a@example.com> \"" <b@example.net>` is one
mailbox, b@example.net, named `"x" <a@example.com> "`; its string is
`"x" <a@example.com> " <b@example.net>`, which reads back as a@example.com.

## Decision

- **One parse, Thunderbird's own.** Every address the add-on reads is Thunderbird's parse of the raw
  header. The `tmHdr` experiment's `getAddressFields(messageIds)` returns `parseEncodedHeaderW` over
  the raw address fields Thunderbird stores for each message, `author` (From, else Sender),
  `recipients` (To, else Cc, else Newsgroups) and `ccList` (Cc) (groups flattened), by WebExtension
  message id, many messages in one call. `senderFilter.readAddressFields` and `senderFilter.readSenderEmail` (the first From
  mailbox) read it for the summary's Cc status, the To/From suppress, `isInternalSender`, no-reply
  detection (`messagePrefilter.js`) and the reply-all defaults (`email_reply.js`). The thread view
  (`threadConversation.js`) reads every bubble's sender in one call. The `threadMessages` experiment
  names a sender with the same `parseEncodedHeaderW` on the raw `author` field. The `author`,
  `recipients` and `ccList` strings of a MessageHeader are never parsed.
- **A gone header gives no address.** When a message is gone or its header cannot be read,
  `getAddressFields` returns null for it: no Cc claim, not an own-account or no-reply sender, empty
  reply-all defaults, and the thread bubble shows the thread source's own sender text as it is.
- **No address text of our own.** The hand-written scanner, its caps and the prefilter's regex copy
  are deleted. A name is never read as an address and an address is never read out of a name.
- **Suppress reads only mailbox addresses.** The To/From suppress of the Cc status matches a
  mailbox's own address (plus-tags stripped), no longer an address that appears only inside a
  display name; every From mailbox counts as an author. A wrong suppress only omits the hint; iOS
  (`PromptVariables`) still suppresses on any address in the field text, a difference that can only
  omit the hint on one platform.
- **Tests use Thunderbird's parser.** Tests give each synthetic message raw headers, and the
  experiment stub answers with Thunderbird's JSMime parse of them (`test/helpers/tbAddressParser.js`:
  `tbMessages`, `withTbAddressFields`; JSMime vendored unmodified under `test/vendor/jsmime/`, tests
  only, revision and hash check in its README). Each MessageHeader also carries the strings
  Thunderbird would give, so reading those instead of the parse fails the tests.

## Rationale

The add-on runs inside Thunderbird, whose parser already decided what each mailbox is. A second
parser of our own can only disagree with it, and every disagreement is a name read as an address
(a wrong Cc claim, a wrong own-account or no-reply decision) or a garbled name. Reading the strings
`browser.messages` gives back with Thunderbird's parser would still be a second parse, of a copy
that is not exact. Reading Thunderbird's own result removes the class instead of adding cases to a
scanner.

## Consequences

- One experiment call per message read, and one per thread view for all its bubbles; no call when
  the receiving account has no address, and none on the message-list row-render path.
- The display-name case recorded in the root contract note
  (`Companion/Memory/Current/summary-recipient-status-cc-contract.md`) does not occur on Thunderbird:
  the add-on reads Thunderbird's own parse, in which such a name stays one mailbox's name.
- The supported range is Thunderbird 140.0 to 160.*. Every address header the tests use parses the
  same with the JSMime of Thunderbird 140.0esr, 145 and the vendored revision (its README).
- A message with no To has its Cc as its `recipients` too (Thunderbird stores To, else Cc), so a
  user named only in its Cc is suppressed as a To recipient and gets no Cc hint. That only omits
  the hint, and the strings read before this decision came from the same fields.
- Two display-only name strips in the message-list experiments (`tmMessageListTableView`,
  `tmMessageListCardView`) still use a regex on text Thunderbird already rendered; they read no
  address for any decision.
- Two address reads outside this decision are unchanged: `chat/fsm/emailCompose.js`
  `runStateSendEmailPreview` matches the user's address in `originalMsg.recipients` strings with
  `includes` (headless and ChatLink modes only), and `compose/background.js` `parseComposeEntry`
  splits compose-window recipient text with a regex.

## Compose write-back and reply-all preview (2026-11-25)

The two reads the last item above lists now use Thunderbird's parser.

- **Compose write-back.** An accepted inline edit's recipient changes reach the
  `tmComposeRecipients` experiment as mailboxes to add (`{ name, email }`) and addresses to remove
  (`*` removes every recipient of the field). The write-back no longer parses or formats
  recipient text in `compose/background.js` (`parseComposeEntry` and `formatForCompose` are
  deleted). The one split left there, `toRecipient` in `runInlineComposeEdit`, builds the
  recipient list the model is shown and is never written back. In the same native turn as its
  checks, the experiment reads the window's field (`GetComposeDetails`), takes Thunderbird's parse
  of it (`parseEncodedHeaderW`), drops the removed addresses, appends each added mailbox whose
  address is not there yet, and writes every mailbox with `makeMimeAddress` to native
  `SetComposeDetails`, which takes header text. That is how Thunderbird writes every pill at Send,
  so for a name that Thunderbird reads back as one name, the pills the write makes are what Send
  reads: every address the message goes to is the address of a pill. A name that begins and ends
  with a quote mark is written as the emitter writes it, as it is; Thunderbird then reads its
  text, so an address in it becomes a pill of its own. A name with an unbalanced quote mark (only
  malformed model output gives one) is read as Thunderbird reads such a header itself, for
  example when it fills a reply to a message carrying that mailbox, and the pills it makes show
  before Send; no guard is added over Thunderbird's own parser. Every kept recipient keeps its address and Thunderbird's reading of its name, so a name
  holding quote marks no longer gains backslashes at each write-back. A pill with no address
  (typed text that is not an address) is kept.
- **Thunderbird's own pill step.** Native `SetComposeDetails` makes the address pills by writing the
  field's mailboxes out as display text (names unquoted) and reading that text back with
  `makeFromDisplayAddress`. That reader splits at the first comma after an `@`, even inside a name.
  From Thunderbird 160 it also reads text with a colon and a later semicolon as a group list when
  every entry has an `@`. A recipient whose name holds an `@` before a comma, or a name shaped like
  such a group, therefore becomes more than one pill. Thunderbird does the same when it fills a
  reply-all itself, and the pills show in the window before Send.
- **Compose API recipients are display text.** `compose.setComposeDetails` and `compose.beginNew`
  read each recipient string with `makeFromDisplayAddress`, then write it with `makeMimeAddress`.
  The reply, forward and new-message writes in `chat/fsm/emailCompose.js` pass `Name <email>`, which
  is that display form, so they stay as they are. Quoting the name there changes no pill, and it
  turns the two shapes above into a garbled or empty pill. The experiment's write is the other form:
  header text, for native `SetComposeDetails`.
- **Reply-all preview.** `runStateSendEmailPreview` takes the Cc of a reply that has no recipients
  of its own from `readAddressFields` (the original's `recipients` field). It leaves out only a
  mailbox whose own address is the user's, in any letter case. An address inside a name, or one that
  only contains the user's address, stays.
- **Tests.** `test/helpers/tbComposeRecipients.js` runs Thunderbird's own `MimeJSComponents.sys.mjs`
  and models the compose window's pill steps from Thunderbird's compose code. The file is vendored
  unmodified under `test/vendor/mimejscomponents/` in two versions: Thunderbird 145 (byte-identical
  to 140.0esr) and Thunderbird 161, with hashes in its README. The write-back tests run with both.
