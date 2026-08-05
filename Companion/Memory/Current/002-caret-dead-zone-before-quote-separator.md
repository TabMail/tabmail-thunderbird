# Caret dead-zone before tm-quote-separator (Gecko drops keystrokes)

> Routed out of `PROJECT_MEMORY.md` § Known Quirks by the `companion-compact` skill on 2026-08-05. The block between the markers below is the inline text **byte-for-byte** — nothing was reworded, merged, reordered or truncated. Index line: `PROJECT_MEMORY.md`.

<!-- BEGIN PRESERVED BLOCK -->
- **Caret dead-zone before `tm-quote-separator`** — A caret at the END of the user's text, immediately before the `contenteditable="false"` `tm-quote-separator`, silently drops keystrokes (Gecko fires `beforeinput` but no `input`). Fixed by an editable `<br class="tm-edit-anchor">` injected before the separator via the shared `TabMail._appendQuoteSeparatorWithAnchor()` — used by BOTH separator-injection sites (`diff.js _applyFragmentToEditor` and `dom.js setEditorPlainText`); keep them unified through that helper. `tm-edit-anchor` is in all three skip-lists (extraction / cursor placement / offset counting) so it never affects the text model or offsets. Do NOT relax the separator's `contenteditable="false"` — it's load-bearing (prevents the older "text wipe" bug). See Recent Discoveries 2026-05-26.
<!-- END PRESERVED BLOCK -->
