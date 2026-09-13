# Contextual compose preview

Autocomplete presentation uses `compose/modules/preview.js`, backed by `previewModel.js` and the shared `richText.js` text/range projection. The preview is a sibling of the message BODY, and the active sentence uses a blue CSS-highlight underline with no background fill. Rendering and dismissal must never reconstruct the draft DOM.

The bubble shows the proposed sentence plus muted context on its intersecting rendered lines only. Inserted/amended runs use a blue accent tint inside the bubble; deletion text is absent. Tab and the Accept button apply the complete displayed suggestion; Esc and Dismiss discard it. Next-sentence continuations and full empty-draft suggestions remain supported. Shift+Tab acceptance is removed.

Disable suggestions is a clickable bubble action. The persistent bottom control appears only when disabled and offers Enable suggestions. Both controls use the existing `autocompleteEnabled` preference and the same local toggle handlers as Shift+Esc. The old keyboard-hints visibility preference no longer controls compose presentation.

Native HTML acceptance must preserve formatting, signatures, quotes, and native undo. The current insertion command is guarded by exact text projection checks; DOM emulation is not evidence of native Gecko undo behavior. Test the real Thunderbird editor before merge when changing this path. The legacy diff-span helpers retained in source are not used by the preview renderer.

Send cleanup uses its own bounded preview guard. It must let inline-edit/IME visibility restoration finish; canceling that timer can leave suggestions hidden after a failed or canceled send. The former timer-cancellation behavior is superseded.
