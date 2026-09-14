# Contextual compose preview

Autocomplete presentation uses `compose/modules/preview.js`, backed by `previewModel.js` and the shared `richText.js` text/range projection. The preview is a sibling of the message BODY, and the active sentence uses a blue overlay underline with no background fill. Text-node range rectangles place underline fragments in the same external host; this replaces CSS Highlight decorations, which are unavailable on Thunderbird 145. Rendering and dismissal must never reconstruct the draft DOM.

The bubble shows the proposed sentence plus muted context on its intersecting rendered lines only. Inserted/amended runs use a blue accent tint inside the bubble; deletion text is absent. Tab and the Accept button apply the complete displayed suggestion; Esc and Dismiss discard it. Next-sentence continuations and full empty-draft suggestions remain supported. Shift+Tab acceptance is removed.

Disable suggestions is a clickable bubble action. The persistent bottom control appears only when disabled and offers Enable suggestions. Both controls use the existing `autocompleteEnabled` preference and the same local toggle handlers as Shift+Esc. The old keyboard-hints visibility preference no longer controls compose presentation.

Native HTML acceptance must preserve formatting, signatures, quotes, and native undo. The current insertion command is guarded by exact text projection checks; DOM emulation is not evidence of native Gecko undo behavior. Test the real Thunderbird editor before merge when changing this path. The legacy diff-span helpers retained in source are not used by the preview renderer.

Send cleanup uses its own bounded preview guard. It must let inline-edit/IME visibility restoration finish; canceling that timer can leave suggestions hidden after a failed or canceled send. The former timer-cancellation behavior is superseded.

The preview surface is 92% opaque in both themes, has an 8px minimum horizontal viewport inset, and scales source typography to 90% while retaining relative emphasis. The source underline remains at the original draft geometry; smaller preview text may wrap differently.

Final visual refinement uses12px internal horizontal padding, a3% accent tint and muted context. Visible shortcut badges precede clickable actions. For nonblank drafts, appended proposals show one next sentence; acceptance preserves and immediately renders the cached remainder, including cursor-jump hints for other sentences. Dismissal clears the proposal. Empty drafts retain full initial acceptance.

Request lifecycle parity: native preview acceptance preserves the former idle reset, pending-request cancellation, and deferred draft-text sync. Typing reuses the existing autohide/adherence policy; matching suggested characters skip scheduling. The unchanged LOCAL completion path starts GLOBAL with the full assumed-accepted proposal, independent of the one-sentence display. Acceptance does not introduce a new GLOBAL request.

Accepted spelling context: after acceptance, the compose session retains its accepted text in memory. A subsequent small letter edit inside an existing word can send one previous sentence (at most 512 characters, edit at most 64 characters) as `previousAcceptedSentence`. New sentences, whole-word replacements, blank drafts, broad rewrites, and oversized sentences omit it. The generator sends `previous_accepted_sentence` to the backend but excludes it from saved debug history. The backend uses it only as spelling reference; current wording remains authoritative. This does not alter request scheduling or LOCAL/GLOBAL selection.

Cmd-K uses the same translucent preview palette and compose-width inset surface. It preserves the existing textarea height growth and scrolling; Enter submits and Shift+Enter inserts a newline, with IME Enter excluded from submission. Opening the editor removes the suggestion surface immediately. Its bottom-right row uses clickable Enter Edit draft, Esc Dismiss, and ⇧Enter Newline controls.

Preview content now lives in a shadow tree because Thunderbird encodes more than BODY. Preview and underline CSS is supplied synchronously by the compose script inside that tree. Tests serialize the whole document; native checks must decode HTML text and inspect saved/reopened MIME, not search raw highlighted HTML. Range replacements bypass the typing-adherence shortcut and use ordinary request invalidation. The pre-existing mixed inline/block projection issue is tracked separately as #42.

Inline editor labels opt out of spellcheck. Its placeholder and textarea share the suggestion inset without nested padding or a left scrollbar gutter; the busy overlay is transparent over the existing surface. Native edit application triggers a presentation-only wipe above the user-text region, canceled by typing, pointer activity, scrolling, or resizing; it respects reduced motion and never rebuilds authored HTML.

Suggestion and Cmd-K action rows share `composeActionCSS` and the `tm-compose-actions` class, including button hover/focus, keycaps, spacing, typography, and palette. Cmd-K installs the same stylesheet text in its document; the suggestion includes it in its shadow tree.

Cmd-K reapplies the active compose window/editor focus after the native insertion, matching the former post-stream cleanup order. Delayed iframe focus attempts are gated on a connected popup so they cannot outlive it. Native caret painting still requires owner smoke verification.

HTML sentence previews preserve synthetic paragraph boundaries when a correction replaces trailing layout whitespace with a space. Without this normalization, punctuation plus a block separator could be placed outside the paragraph in the detached fragment, fail validation, and silently close the bubble. Tests cover DIV/P paragraphs with keyboard and clicked acceptance, unchanged paragraph structure, and no repeated proposal. This is distinct from the inherited inline-to-block projection issue #42.

Signature cursors now show navigation to an existing body correction without changing editable offsets, request extraction, or signature protection. A regression checks jump-only rendering and Tab navigation without accepting. Follow-up #44 tracks shared Near cursor/Docked at bottom placement; inherited malformed Cmd-K responses missing Body are tracked in #45 with a characterization fixture, not repaired in this GUI change.

Cmd-K action labels now live in a shadow tree with shared action CSS, rather than relying only on spellcheck=false in the compose document. Keyboard, click, and pending-request dismissal regressions exercise the shadow controls; native spellcheck painting awaits owner verification.

Owner-authorized #45 recovery: empty/whitespace parsed edit bodies retry once with an explicit Body label requirement and tools disabled. A second empty result returns an error without proposed metadata/history. Cmd-K keeps the instruction and shows a retryable error; dismissed requests cannot apply, and conversation history commits only after a successful native body transaction. No heuristic unlabeled-body extraction was added.
