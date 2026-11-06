# Third-party credits: THIRD_PARTY_LICENSES.md, the license texts, and the Acknowledgments dialog

The settings page ends with an "Acknowledgments" link (`#open-acknowledgments`) that opens a native
`<dialog>` (`#acknowledgments-dialog`). The dialog lists every shipped third-party component with its
license and copyright line, each name linked to its upstream. Same intro line as iOS
`AcknowledgmentsView`. Code: `config/modules/acknowledgments.js` (the `ACKNOWLEDGMENTS` list and
`handleAcknowledgmentsClick`).

**Three places are kept in step, and `test/acknowledgments.test.js` fails when they drift:**

1. Every entry under `compose/libs/` and `chat/libs/` appears in a `THIRD_PARTY_LICENSES.md` section,
   either in its heading or as the license file on its **License** line.
2. Every third-party section (one with a **Source**) names a license file under those directories,
   and that file holds that license's text. Every file a section heading names exists.
3. The dialog's entries are exactly the third-party sections: same upstream URL, license and copyright.

Adding a vendored library therefore means: the file, its `LICENSE-<name>` text beside it, a section in
`THIRD_PARTY_LICENSES.md`, and an `ACKNOWLEDGMENTS` entry.

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
- No palette token exists for a backdrop color, so `::backdrop` keeps the UA default.
- jsdom 26 has `HTMLDialogElement` but no `showModal()`/`close()`; the test stubs both on the instance.
