# Contextual compose preview

The latest direction is the first section of `index.html`; collapsed sections retain earlier visual explorations.

The native compose body remains authoritative in HTML and plain-text modes. A pointer-free preview sits beside the active sentence’s rendered lines. Unchanged same-line context is muted, unchanged sentence wording is neutral, and inserted or amended text is highlighted. Deleted wording is omitted. No additional context lines are shown.

Tab or Accept applies the complete displayed suggestion; Esc or Dismiss drops it. Disable suggestions lives in the preview. When disabled, the bottom floater contains only Enable suggestions. Controls support mouse clicks. There is no Shift+Tab acceptance or transition animation. A continuation may include the next sentence. Empty drafts preview the complete suggestion before acceptance.

`previewModel.js` reuses sentence diff computation. `richText.js` supplies shared text offsets and DOM ranges. `preview.js` renders outside the message body; source underlines use measured text-node rectangles in the same overlay, without inserting spans into the draft. Acceptance clones the editable region, applies escaped text edits, validates the resulting text projection, and submits one native HTML editor command. Unrepresentable structural edits fail closed.

Thunderbird Beta 156.0 native visual, formatting, and undo/redo smoke checks passed; reproducible guarded probes and limits are documented in `test/manual/README.md`. JSDOM checks validate models, payloads, and lifecycle invariants; they do not prove Gecko transaction behavior.

The preview surface is 92% opaque in both themes, has an 8px minimum horizontal viewport inset, and scales source typography to 90% while retaining relative emphasis. The source underline remains at the original draft geometry; smaller preview text may wrap differently.
