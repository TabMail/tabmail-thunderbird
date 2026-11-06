# Third-party credits: THIRD_PARTY_LICENSES.md, the license texts, and the Acknowledgments dialog

The settings page ends with an "Acknowledgments" link (`#open-acknowledgments`) that opens a native
`<dialog>` (`#acknowledgments-dialog`). The dialog lists every shipped third-party component with its
license and copyright line, each name linked to its upstream. Same intro line as iOS
`AcknowledgmentsView`. Code: `config/modules/acknowledgments.js` (the `ACKNOWLEDGMENTS` list and
`handleAcknowledgmentsClick`).

**`THIRD_PARTY_LICENSES.md`, the license texts and the dialog are kept in step, and `test/acknowledgments.test.js` fails when they drift:**

1. Every entry under `compose/libs/` and `chat/libs/` appears in a `THIRD_PARTY_LICENSES.md` section,
   either in its heading or as the license file on its **License** line.
2. Every third-party section (one with a **Source**) names a license file under those directories,
   and that file is the upstream text byte for byte (its SHA-256 is pinned in `LICENSE_SHA256`). Every
   file a section heading names exists.
3. Each section's **Version** is the one the shipped files carry (`VERSION_EVIDENCE`): the pdf.js version
   string in both pdf files, the embedded `core-js/blob/v<version>/LICENSE`, and the pinned SHA-256 of
   jsdiff's `diff.min.js`, which carries no version string. CMaps follow pdf.js; diff-match-patch has no
   tagged release. Each section's **Copyright** line is read in the shipped files too
   (`COPYRIGHT_EVIDENCE`), one "Copyright ..." statement at a time.
4. The dialog's entries are exactly the third-party sections: same name (the dialog may add how it
   ships, e.g. "core-js (bundled inside PDF.js)"), upstream URL, license and copyright.

The dialog shows name, license, copyright and upstream (iOS shows name, license and upstream), but no version. Versions
live in `THIRD_PARTY_LICENSES.md`, so a library update touches the document and the pins, not the dialog.

Adding or updating a vendored library therefore means: the file, its upstream `LICENSE-<name>` text beside
it with its pin, a section in `THIRD_PARTY_LICENSES.md` with a version check, and an `ACKNOWLEDGMENTS` entry.

**What ships (audited 2026-11-06):**

| Component | Version | License text shipped at |
|---|---|---|
| PDF.js | 6.3.289 | `chat/libs/pdfjs/LICENSE` |
| Adobe CMap resources | as in pdfjs-dist 6.3.289 | `chat/libs/pdfjs/cmaps/LICENSE` |
| core-js | 3.50.0 | `chat/libs/pdfjs/LICENSE-core-js` |
| diff-match-patch | upstream master (untagged), re-indented | `compose/libs/LICENSE-diff-match-patch` |
| jsdiff | 5.2.0 | `compose/libs/LICENSE-jsdiff` |

- **core-js hides inside pdf.js.** The pdfjs-dist **legacy** build compiles core-js polyfills into both
  `pdf.min.mjs` and `pdf.worker.min.mjs`, and pdfjs-dist ships no core-js license. Check the embedded
  `core-js/blob/v<version>/LICENSE` string when bumping pdf.js, and update the version and text.
- **pdf.js's wasm decoders (OpenJPEG, QCMS, JBIG2) are not shipped.** Only their JS glue is in the worker.
  If `wasm/` is ever bundled, its `LICENSE_*` files must ship with it and be credited.
- `compose/libs/undo-manager.js` was deleted (2026-11-06). It was never loaded (not in the compose
  injection list; `TabMail.undoManager` is never assigned), and it was an independent implementation, not
  the MIT library it credited.

**Dialog mechanics:**
- Links open in the user's default browser (`browser.windows.openDefaultBrowser`), like the page's other
  external links. `handleAcknowledgmentsClick` must run synchronously, first in the page's click handler
  (`config/modules/init.js`), because it calls `preventDefault`. After an `await` that comes too late, and
  the link would navigate the settings tab.
- The dialog's padding sits on `.tm-ack-dialog-content`, so a click whose target is the `<dialog>` itself is a
  backdrop click (closes it). Escape closes it natively.
- The test pins that coupling: `.tm-ack-dialog` has `padding: 0`, `.tm-ack-dialog-content` has the
  padding, and the dialog's only child is that wrapper.
- The test pins `chat/libs/pdfjs/`'s listing. pdfjs-dist also ships `standard_fonts/`, `wasm/` and
  `iccs/`, each with its own third-party licenses; bundling one fails the test until it is credited.
- No palette token exists for a backdrop color, so `::backdrop` keeps the UA default.
- jsdom 26 has `HTMLDialogElement` but no `showModal()`/`close()`; the test stubs both on the instance.
- The dialog tests run through the real `initConfigPage` on the real `config.html`. The test reads
  `init.js`'s imports and stubs every one except `acknowledgments.js` and `dom.js`, so a new import in
  `init.js` needs no test change. That is how the tests pin the handler's place in the page: it opens the
  dialog, cancels a link's navigation during the click, and leaves every other control (Refresh) to its
  own handlers.
- The dialog's colors are checked against the palette: every color declaration in the block uses
  `var(--name)` with no fallback and no literal, and each name is defined in both the light and the dark
  branch of `buildPaletteCSS`.
