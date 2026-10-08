# A model-written "-- " signature block shows the signature twice

Recorded 2026-10-08. Owner report: accepting a compose suggestion sometimes left two signatures, mostly in drafts the chat agent composed, and with the "-- " delimiter.

- **Cause.** Thunderbird inserts the identity signature itself as a `.moz-signature` element (HTML and plain-text compose alike; in plain text it is a `div`, in HTML a `div` or `pre`). The autocomplete projection stops at that element, so the model never sees the signature and `system_prompt_compose` says "NEVER include signatures". The chat agent can still read the user's earlier mail (`email_read`/`email_search`), which ends in the same "-- " signature, and sometimes copies it into the draft body. The content script inserted that body unchanged above Thunderbird's element: two signatures.
- **What was not the cause.** The native `insertHTML` transaction (`applyComposeEdits`) keeps exactly one `.moz-signature` across repeated accepts, empty-draft proposals, HTML/plain-text, paragraph/non-paragraph mode, replies with the signature above the quote, and a From switch (native `nsMsgCompose::SetIdentity` replaces the top-level signature). All checked in Thunderbird Beta 158.0b3. `_renderWithExistingDiffs` (the old `tm-quote-separator` rebuild) has no callers.
- **Fix.** `TabMail.withoutAddedSignature(editor, original, proposed)` in `compose/modules/richText.js`. It cuts a proposal at its first `-- ` line (`/^--[^\S\r\n]*$/m`) and trims trailing whitespace only when all three hold:
  - the user has not written in the draft yet (`original.trim()` is empty);
  - the draft has its own `.moz-signature` (one inside `blockquote` or `.moz-forward-container` belongs to quoted or forwarded mail and does not count);
  - every line from the delimiter on is part of that signature's text, compared on letters and digits after NFKC and lower-casing.

  The comparison works on letters and digits because model output reaches the compose script through `sendChat` → `normalizeUnicode`, which applies NFKC, folds quotes and turns U+00A0 into a space, and the model may re-wrap lines. The filter is applied in `core.js` to every suggestion (autocomplete, cached agent replies, direct agent-draft insertion) and in `inlineEditor.js` to Cmd-K results. A result that is only a signature counts as empty, so Cmd-K shows its retryable error.
- **Why only empty drafts (tier-1 review, 2026-10-08, rounds 2–5).** The first versions also filtered drafts the user had written in, guarding the user's text with heuristics:
  - a typed-delimiter check (Gecko stores a typed "-- " in HTML as `--&nbsp;`);
  - an exact-line guard (missed NFKC echoes and re-wrapped lines);
  - a joined-string guard (cut a user's "Tom" because "tomorrow" contains it);
  - letter/digit keys (blind to a user's `:)` or emoji line).

  Each round found another way to delete text the user wrote. Agent drafts are inserted only into an empty draft (background `getSuggestion` offers the cached reply only then), and Cmd-K on an empty draft is the other compose-from-nothing path, so restricting the cut to empty drafts removes the whole class.
- **Kept unchanged.** These are left alone; each shows two signatures (the pre-fix cosmetic outcome) rather than risking text:
  - any draft the user has written in, including a signature the model copies while editing typed text;
  - drafts without their own signature;
  - proposals without a delimiter;
  - a copied block that does not match the current signature, such as an older signature or extra lines.

  A copied signature WITHOUT "-- " is not detected.
- **Native reproduction.** Headless Thunderbird Beta, throwaway profile (`-profile <tmp> -no-remote -marionette -remote-allow-system-access -headless`), identity with a plain-text signature, plain-text new message. The compose modules were loaded into the editor window with `Cu.Sandbox(contentWindow, {sandboxPrototype, wantXrays:false})` plus `Cu.evalInSandbox`, because `loadSubScript` refuses `file:` URIs there. A `getCorrectionFromServer` stub returned the agent's signed body. `main`: two signatures for both direct insertion and Tab acceptance, and for an HTML draft with a linked HTML signature and a plain-text reply with the signature above the quote. Fixed modules: one in each. Run the whole scenario inside the sandbox: chrome↔content promise bridging failed with "Permission denied to access property then".
- Tests:
  - `test/agentDraftInsertion.test.js`:
    - the real tracker/background/API round trip, direct and accepted;
    - a reply whose quote carries a signature;
    - no own signature, including a bare delimiter;
    - a quoted or forwarded copy of the same signature;
    - a different signature;
    - a draft the user has written in is never filtered: a copied signature, a typed `--&nbsp;` delimiter, contact lines and a `:)` line under a model-added delimiter;
    - copies cut at the first delimiter: two copies, a re-wrapped copy, full-width digits, a capitalised copy;
    - non-delimiter dash lines, including ones followed by signature text;
    - a signature-only suggestion.
  - `test/autocompleteLifecycle.test.js`:
    - "Cmd-K in an empty signed draft shows the signature once";
    - "Cmd-K keeps lines the user wrote below a delimiter the model added";
    - "Cmd-K keeps a signature delimiter the user typed in an HTML draft";
    - the `error` (no-body) outcome of "retains inline history only after successful application".
