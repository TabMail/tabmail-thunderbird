# ADR-032: The Search Index Stores an Email's Calendar Invites Raw; email_read Formats Them When It Reads

**Status:** Accepted (2026-11-12). Issue #412.

## Context

`email_read` shows the assistant the calendar invites (`text/calendar` parts) in an email. For a
message the native search index already holds, `safeGetFull` returns the index's plain-text copy, which
has no MIME parts, so the invite text came from the index's `message_meta.parsedIcsAttachments`
column. Until #412 the indexer stored the parser's FORMATTED output there. A fix to the parser (#412:
an all-day invite was named a day early west of UTC, with clock times) therefore never reached a
message indexed before it: the stored text was served as it was, and a reindex wrote the same stored
text again (the indexer takes it from the index copy; the attachment-flag repair copies it).

## Decision

- **Store raw.** Every writer stores the invite parts as they came, at full length (root rule 11):
  `""` for a message with no calendar part, else one JSON object
  `{"tabmailStoredIcs":1,"parts":[{filename,contentType,partName,text}, ...]}` (`encodeStoredIcs`,
  `chat/modules/icsParser.js`), every part in message order, with the part details the formatted text
  prints. JSON keeps several parts apart with no separator that an invite's own text could contain.
  A bare `BEGIN:VCALENDAR` concatenation was considered and not used: it loses the file name, content
  type and part name the formatted output shows, and needs a separator an invite could contain.
- **Format at read.** `email_read` formats stored parts with `formatIcsAttachmentsAsString`, the same
  parser and output as a live parse of the message.
- **Old rows heal on first read.** A stored value `storedIcsParts` cannot read (non-empty and not the
  JSON above: the formatted text earlier versions stored) counts as ABSENT and is never shown.
  `email_read` reads the invites again from the message itself through ONE `safeGetFull` mode,
  `{ skipIndex: true }` (skips the index tier and a cached index copy; `getFull` stays inside
  `safeGetFull`), shows them, and writes the raw parts back (`rewriteStoredIcs` in `fts/indexer.js`,
  background command `rewriteStoredIcs`: the stored row removed and re-added with every other column
  as stored, under the membership fence, as the attachment-flag repair does). The indexer, writing a
  row again from an index copy, re-derives an old value the same way.
- **Empty means none.** An empty stored value means the message had no calendar part (the old
  formatter printed a header line for any calendar part found, even an unreadable one), so it is
  never re-derived and costs no download.
- **Offline.** When the message cannot be read (an IMAP message not kept on this computer and the
  server unreachable), `email_read` returns the indexed body with the invite simply absent: never an
  error and never the old text. The old value stays stored and heals on a later read.
- native-fts is unchanged: the column and its RPCs carry the new value as text.

## Consequences

- A parser fix reaches every indexed message the next time it is read.
- The first `email_read` of an old row with an invite reads the message itself (a download for IMAP
  mail not kept offline) and re-adds one index row (the row's embedding is computed again).
- Offline, an old row's invite is not shown until it can be re-derived (before #412 the assistant saw
  the stored text, wrong for all-day invites west of UTC).
- The attachment-flag repair copies the stored value as it is (no download by design); an old value it
  copies still heals on read.

Pinned by `test/emailReadAllDayInvite.test.js` (index-served: heal + write-back, stored raw formatted
with no download, offline absent, empty not re-derived; LA and Auckland), `test/ftsAttachmentFlagRepair.test.js`
(fresh index stores raw parts at full length, several parts; index copy kept; old value re-derived or
kept offline; `rewriteStoredIcs`) and `test/getFullCacheCleanup.test.js` (`skipIndex`).
