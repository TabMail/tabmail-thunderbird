# ADR-027: Chat Memory Has a User-Set Size Limit, Default 1 GB

**Status:** Accepted (2026-10-17, owner). Helper side: native-fts ADR-NF-008. TabMail Voice
uses the same helper mechanism with its own setting.

## Context

The native helper's chat memory database (`memory.db`, one row per chat exchange, searched by
`memory_search` / `memory_read`) had no size bound. Owner 2026-10-17: memory must have a limit,
user-configurable on the settings page, defaulting to 1 GB, which holds almost everything.

## Decision

- **Setting:** `memorySizeLimitBytes` in `browser.storage.local`. Choices are 100 MB, 250 MB,
  500 MB, 1 GB (default), 2 GB and 5 GB, listed in `SETTINGS.memoryManagement` (1024-based). An
  unset value, or any value that is not an offered choice, reads as the default
  (`fts/memorySizeLimit.js`).
- **Enforcement is the helper's.** `nativeMemorySearch.indexBatch` reads the limit once, before
  the call, and sends `maxBytes` with every memory write. The helper then removes the oldest
  entries until the used size fits. Changing the limit on the Chat History tab stores it, then
  sends `memoryTrim`, which applies it at once and gives the freed disk space back.
- **Capability-gated:** the helper's `hello` must advertise `capabilities.memorySizeLimitV1`.
  Without it:
  - writes keep the legacy `{ rows }` shape;
  - `trim()` answers `{ ok: false, unsupported: true }` without an RPC;
  - the tab says the limit applies once the search helper updates.
  The stored setting takes effect as soon as an updated helper connects.
- **UI:** a usage row at the top of the Chat History tab, styled like the Settings plan-usage
  bar:
  - "Memory used: X of Y";
  - a native `<progress>` bar;
  - a size-limit `<select>`;
  - a one-line note.
  "Used" is the helper's `usedBytes` (pages in use), the measure the limit counts. An older
  helper's `dbBytes` (file size) is shown instead. The "DB Size" stat moved into this row.

## Consequences

- Memory the limit removes is gone from `memory_search`; the oldest conversations go first, which
  the note on the tab states.
- Nothing is stored that was not stored before (ADR-004 unaffected); the limit only removes.
- Tests: `test/memorySizeLimit.test.js` covers:
  - the setting;
  - the wire, with and without the capability;
  - the usage row and the limit change (store, then trim, then status).
