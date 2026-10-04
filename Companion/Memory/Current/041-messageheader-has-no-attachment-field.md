# Thunderbird's MessageHeader has no attachment field

Recorded 2026-10-04 after an attachment-only email (a PDF, no body text) was reported by the chat agent's `email_read` as `has_attachments: no`.

- **The WebExtension `MessageHeader` type has no `hasAttachments` property.** Thunderbird 157's `messages.json` schema and the `convert` in `ExtensionMessages.sys.mjs` expose no attachment field, so `header.hasAttachments` is always `undefined` and `Boolean(header.hasAttachments)` is always `false`. Nothing errors. Before this fix, four places read it: `email_read`, `inboxContext` (feeds `inbox_read` and the inbox prompt context), `email_search` (through the index column below), and `fts/indexer.js`.
- **The database flag is correct.** `nsMsgMessageFlags.Attachment` (`0x10000000`) is set on the msgDB header when the header arrives. It was measured on the reported message: flags `0x10000081` in its IMAP folder's `.msf`.
- **Where each reader gets attachments now:**
  - `email_read` → `browser.messages.listAttachments(weId)`. It parses the MIME, is authoritative, and also yields the names, types and sizes it lists after the body in iOS's format (`  - name (contentType, size bytes)`). If the call fails, the tool prints `has_attachments: unknown`, never `no`.
  - `inboxContext` and `email_search` → `tmHdr.getHasAttachmentBulk(items)`, which reads the database flag. It looks headers up **by Message-ID only**: these callers hold WebExtension ids, and a WebExtension id read as a msgKey can name a different message. The `getRepliedBulk`/`getHasReBulk` items still pass `key: msg.id`. That is a known wrong-message hazard, left for a follow-up.
  - `email_search` matches each hit's `accountId:folderPath:Message-ID` key against the account's live folders (`getUniqueMessageKeyCandidates`), because folder paths and Message-IDs may both contain `:`.
- **The FTS `hasAttachments` column is always 0.** `fts/indexer.js` builds it from `m.hasAttachments`. `email_search` no longer reads it, so it needs no reindex. Do not start reading it again unless the indexer is fixed and the index is rebuilt.
- **`safeGetFull` cannot answer "has attachments".** Its native-FTS tier returns a synthetic message (`__tmSynthetic`, `parts: []`), so anything that walks `full.parts` sees no parts on an FTS hit. The `email_read` ICS scan has the same gap on FTS hits (follow-up). The in-memory cache was not the cause of this bug.

Before reading any field of a WebExtension type, check Thunderbird's schema for it. A missing field reads as `undefined` and coerces to a plausible default.
