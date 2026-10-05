# The native FTS helper is owned by the background; other pages ask it

Recorded 2026-10-04. Found in the tier-1 review of `inbox_read` attachment flags (TB PR #123), then fixed for every caller.

- **Each extension page has its own copy of every module.** The chat window (`chat/chat.html`), compose and settings pages import `fts/engine.js` / `fts/nativeEngine.js` as separate module instances from the background (memory 014). Only the background's `chat/background.js` runs `initFtsEngine()`, so only its copy holds the helper's port.
- **A call from a page used to start a second helper.** `nativeRPC` → `ensureConnected` → `initNativeFts` → `runtime.connectNative("tabmail_fts")` in the page's copy. Firefox creates one `NativeApp` (one helper process) per connecting context and ties it to that page (`NativeApp` in `NativeMessaging.sys.mjs`; MDN `runtime.connectNative`: the app runs until the page that created the port is destroyed). The second process ran hello (including the self-update check and its CDN fetch), init, profile detection, migration and the embedding-model load, and it could write to the same database outside the background helper's ordering.
- **Paths that did this before 2026-10-04:**
  - `safeGetFull`'s index step (`_getFtsSearch` → `ftsSearch.getMessageByMsgId`, and `ftsSearch.stats()` in its miss diagnostics). Reached from chat `email_read` and compose.
  - #123's first draft of `_getAttachmentFlags` (fixed before merge).
- **The rule now, enforced in `fts/nativeEngine.js`:**
  - `initNativeFts()` marks this context as the owner (`ownsNativeHelper()`). Only `initFtsEngine` calls it.
  - `ensureConnected` and `recheckAvailability` refuse to connect in a context that is not the owner, so an RPC there rejects with "Native FTS helper not connected" and never spawns a process.
  - With "use FTS search" off, the background never calls `initFtsEngine`, so no context owns the helper and nothing starts one (before, a `safeGetFull` call connected it lazily).
- **How a caller reaches the index:** `ftsRequest(cmd, fields, direct)` in `fts/ftsRequest.js`. In the owner it calls `direct({ ftsSearch, memorySearch })`. Anywhere else it sends `{type: "fts", cmd, ...fields}` to the background, whose `attachCommandInterface` handler answers: undefined when nothing handled it (engine not up), `{error}` when the command threw. Callers: `safeGetFull` (`getMessageByMsgId`, `stats`), `inboxContext._getAttachmentFlags` (`getAttachmentFlags`).
- **Before adding an index read or write:** call it through `ftsRequest` unless the code only ever runs in the background. A new `cmd` needs a case in `attachCommandInterface`.
- Tests: `test/nativeHelperOwnership.test.js` (no connect from a non-owner, owner connects, `ftsRequest` both ways), `test/getFullCacheCleanup.test.js` ("outside the context that owns the native helper"), `test/inboxContextAttachments.test.js`.
- Not every module caller needs `ftsRequest`: `indexChatSession` (`fts/memoryIndexer.js`) is reached only from `_kbUpdateImpl` (`kbUpdate`, in the background on `kb-update-from-window-close`), so its direct call runs in the owner. `periodicKbUpdate`, which does run in the chat window, indexes turns through `indexChatTurn`, already a runtime message. Corrected in tier-1 review, 2026-10-04.
