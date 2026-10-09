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

## Update 2026-10-08 (latest) — only a last paragraph that is EXACTLY the signature is dropped

Tier-1 round 2 showed the per-line rule below still dropped text that was not the signature: lines
of signature words finishing the draft's own sentence or list in the same paragraph ("The agreement
was signed by" / "Pat Example, Example Co"; "Please ship it to:" / "12 Main St" / "Springfield";
"The winner is" / "Pat Example"), and a final paragraph holding PART of the signature as content (an
address the email asks for). Under the owner's rule (a missed copy is fine, a dropped line is a
catastrophe) the rule is now, in `withoutAddedSignature` alone (`_addedSignatureStart` and the
`addedSignature` config thresholds are deleted):

- **A copy** is the draft's LAST paragraph (it starts after a blank line, a "-- " line or the start
  of the draft) whose sorted words equal the signature's sorted words EXACTLY (same words, same
  counts; any line breaks, order, case, NFKC, punctuation), with a word on every line. Words are
  letters with combining marks, digits and symbols (`\p{S}`, so an emoji added to a copy keeps it);
  punctuation is ignored. A "-- " line just above it (blank lines between allowed) goes with it. The
  cut repeats, so two copies go.
- **Now kept** (were dropped; two signatures, never a drop): a partial copy (missing a word or a
  line), a copy sharing a paragraph with the sign-off or any other line (including under a
  non-delimiter dash line), a copy with an extra or repeated word or an emoji, and the name-only
  signature's name as the sign-off ("Best," / "Pat Example" — this reverses the owner-accepted cut
  below, in the safe direction). An older or edited copy was already kept.
- **Now dropped** (was kept): a copy of a one-word signature in a paragraph of its own.
- **Residual (not owner-reviewed):** a last paragraph whose words are exactly the signature's is
  dropped even if it was meant as content, e.g. a final "Pat Example?" / "Example Co?" asking who
  should sign. Without the "-- " line nothing distinguishes it from a copy.
- **Tests:** `test/agentDraftInsertion.test.js` ("a copied signature is dropped", "a suggestion that
  does not end in a copy stays whole" with every round-2 example, and the seeded invariant "never
  drops anything but whole copies of the signature", whose oracle is written independently of the
  production helpers and fails on the previous rule); Cmd-K rows in `test/autocompleteLifecycle.test.js`.

## Update 2026-10-08 (later) — only lines made ENTIRELY of signature words are ever dropped

Owner: *"no drops … It's okay if we accidentally leak it in, but if we accidentally remove it,
that's a catastrophe."* So the walk below now stops at the first line with ANY word the signature
lacks (or no word at all), not just at a line with no signature word: mixed lines are never in the
block. Supersedes the "A line in the copy's OWN paragraph that shares a signature word IS" rule and
the older/edited-copy tolerance in the section below. What remains tolerated: case, NFKC, re-wrapping,
missing lines or words, no "-- " line. **Now kept (two signatures):** an older or edited copy that
has any word the current signature lacks (old company, new phone number). Pinned by an invariant
test, "never drops a line with a word the signature lacks (seeded random drafts)": 2000 seeded
drafts, the result is always a prefix and every removed line is a "-- " line or all signature words.

## Update 2026-10-08 — a copy is matched on its words with tolerance, not on "-- "

Owner, after the first fix: an older or edited copy should not show two signatures either, the
"-- " line is too fragile to depend on, and nothing that is not the signature may be dropped.
`withoutAddedSignature` now matches the END of the draft against the draft's own signature
(`_addedSignatureStart`, `TabMail.config.addedSignature`). It still runs only on drafts the user
has not written in, and only a signature of the draft's own (quoted/forwarded ones do not count)
supplies the words.

- **Words.** Letters with their combining marks (`\p{M}`: without them Devanagari, Thai and similar
  scripts split into consonant fragments and a different name matched) and digits, after NFKC and
  lower-casing, from the signature's line-aware
  projection (`indexComposeText`; `textContent` runs an HTML signature's lines together across
  `<br>`). Each signature word matches at most as often as the signature has it.
- **The walk.** From the last line up, stopping at the first line with NO signature word, and at a
  blank line once the block has a line: a paragraph after a copy ("See you then.", `:)`, even
  "Example Co is hiring!") or above it is never in the block. A line in the copy's OWN paragraph
  that shares a signature word IS (that is how an edited line, a new phone number, is tolerated),
  so same-paragraph text after a copy that shares a signature word can be cut (tier-1 round 1, F2).
  A copy split by a blank line is cut below it only while the part above is too small to count. Only a line made entirely of signature words may start the block, so "Thanks, Pat
  Example, Example Co" is never cut. Among the possible starts, the block with the most signature
  words over other words wins (a sign-off "Pat" above a copy only adds a repeat, so it stays); on
  a tie, the smaller block.
- **Thresholds** (config): `MIN_MATCHED_WORDS` 2, `MIN_PRECISION` 0.7 (block words that are
  signature words), `MIN_RECALL` 0.6 (signature words present). A "-- " line just above the block
  (blank lines between allowed) goes with it as cleanup only. The cut repeats, so two copies go.
- **Now dropped** (were kept): an older or edited copy (new title, number, company), a copy without
  a "-- " line, a copy under a non-delimiter dash line.
- **Still kept** (two signatures, never a drop): a draft the user has written in; anything after
  the copy; a sign-off on the signature line; a copy too far off; half of the signature (`-- \nPat
  Example` of a two-line signature: without the "-- " evidence it is a sign-off) — this one WAS cut
  before; a one-word signature; a sign-off name when the signature has more (e.g. a phone number).
  A name-only signature's copy of the name in the sign-off IS cut (it equals the signature, which
  Thunderbird shows right below). **Owner-accepted 2026-10-08:** both the kept half copy (even with
  its "-- " line: the owner does not want the dash relied on) and the cut name-only sign-off.
- **Tests:** `test/agentDraftInsertion.test.js` ("a copied signature is dropped", "a suggestion that
  does not end in a copy stays whole", "tolerance boundary", "matched-word boundary", "only a
  delimiter just above the copy goes with it"); Cmd-K rows in `test/autocompleteLifecycle.test.js`.
  Every rule has a mutant the suite kills; the own-signature guard was deleted as redundant (no
  own signature ⇒ no words ⇒ no cut).
