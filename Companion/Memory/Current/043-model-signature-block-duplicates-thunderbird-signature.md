# A model-written "-- " signature block shows the signature twice

Recorded 2026-10-08. Owner report: accepting a compose suggestion sometimes left two signatures, mostly in drafts the chat agent composed, and with the "-- " delimiter.

- **Cause.** Thunderbird inserts the identity signature itself as a `.moz-signature` element (HTML and plain-text compose alike; in plain text it is a `div`, in HTML a `div` or `pre`). The autocomplete projection stops at that element, so the model never sees the signature and `system_prompt_compose` says "NEVER include signatures". The chat agent can still read the user's earlier mail (`email_read`/`email_search`), which ends in the same "-- " signature, and sometimes copies it into the draft body. The content script inserted that body unchanged above Thunderbird's element: two signatures.
- **What was not the cause.** The native `insertHTML` transaction (`applyComposeEdits`) keeps exactly one `.moz-signature` across repeated accepts, empty-draft proposals, HTML/plain-text, paragraph/non-paragraph mode, replies with the signature above the quote, and a From switch (native `nsMsgCompose::SetIdentity` replaces the top-level signature). All checked in Thunderbird Beta 158.0b3. `_renderWithExistingDiffs` (the old `tm-quote-separator` rebuild) has no callers.
- **Fix.** `TabMail.withoutAddedSignature(editor, original, proposed)` in `compose/modules/richText.js`. It cuts a proposal at its first delimiter line (`/^--[^\S\r\n]*$/m`) and trims trailing whitespace only when all of these hold:
  - the draft has its own `.moz-signature` (one inside `blockquote` or `.moz-forward-container` belongs to quoted or forwarded mail and does not count);
  - the user's text has no delimiter line;
  - every line of the cut block is part of that signature's text (a positive match: the block is a copy of the draft's own signature);
  - no line the user wrote sits in the cut block without also being a line of the kept part (the model may put a delimiter above contact lines the user typed). It must be compared line by line: with the kept part joined into one string, a user's "Tom" was cut because "tomorrow" contains it (round 4).

  Both comparisons use letters and digits only, after NFKC and lower-casing. Model output reaches the compose script through `sendChat` → `normalizeUnicode` (NFKC, folded quotes, U+00A0 → space) and may re-wrap lines, so an exact line match missed verbatim echoes and deleted user text (tier-1 review rounds 2 and 3, 2026-10-08). The delimiter's whitespace class includes U+00A0 because Gecko's HTML editor stores a typed "-- " line as `--&nbsp;` (plain-text compose keeps a plain space; checked natively). It is applied in `core.js` to every suggestion (autocomplete, cached agent replies, direct agent-draft insertion) and in `inlineEditor.js` to Cmd-K results. A result that is only a signature counts as empty, so Cmd-K shows its retryable error.
- **Kept unchanged.** These are left alone:
  - a delimiter the user typed, including a bare one;
  - lines the user wrote below a delimiter the model added;
  - drafts without their own signature;
  - proposals without a delimiter;
  - a copied block that does not match the current signature, such as an older signature or one with extra lines. That case shows two signatures, the pre-fix cosmetic outcome, rather than risking user text.

  A copied signature WITHOUT "-- " is not detected.
- **Native reproduction.** Headless Thunderbird Beta, throwaway profile (`-profile <tmp> -no-remote -marionette -remote-allow-system-access -headless`), identity with a plain-text signature, plain-text new message. The compose modules were loaded into the editor window with `Cu.Sandbox(contentWindow, {sandboxPrototype, wantXrays:false})` plus `Cu.evalInSandbox`, because `loadSubScript` refuses `file:` URIs there. A `getCorrectionFromServer` stub returned the agent's signed body. `main`: two signatures for both direct insertion and Tab acceptance, and for an HTML draft with a linked HTML signature and a plain-text reply with the signature above the quote. Fixed modules: one in each. Run the whole scenario inside the sandbox: chrome↔content promise bridging failed with "Permission denied to access property then".
- Tests:
  - `test/agentDraftInsertion.test.js`:
    - the real tracker/background/API round trip, direct and accepted;
    - a reply whose quote carries a signature;
    - no own signature, including a bare delimiter;
    - a quoted or forwarded copy of the same signature;
    - a user-typed delimiter, in plain-text, `--&nbsp;` and bare shapes;
    - user lines below a model-added delimiter, including a no-break space, a curly apostrophe, a split line, a capitalised echo, and a name a kept word contains;
    - a copy that differs from the own signature;
    - a sign-off matching a signature line;
    - two copies (cut at the first delimiter);
    - a re-wrapped copy;
    - full-width digits;
    - non-delimiter dash lines, including ones followed by signature text (they pin the delimiter anchors);
    - a signature-only suggestion.
  - `test/autocompleteLifecycle.test.js`:
    - "Cmd-K in a signed draft shows the signature once";
    - "Cmd-K keeps lines the user wrote below a delimiter the model added";
    - "Cmd-K keeps a signature delimiter the user typed in an HTML draft".
