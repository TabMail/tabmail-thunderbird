# Third-Party Licenses

The TabMail Thunderbird add-on bundles the following third-party components.
These are **not** covered by the add-on's MPL-2.0 license; each retains its own
license as noted below. They live under `compose/libs/` and `chat/libs/`, unmodified except where a
section says otherwise,
and each component's full license text ships beside it in the file named on its
**License** line. The settings page's Acknowledgments dialog
(`config/modules/acknowledgments.js`) lists the same components.

---

## PDF.js (`chat/libs/pdfjs/`)

- **Source:** https://github.com/mozilla/pdf.js — the `pdfjs-dist` npm release,
  copied unmodified: `legacy/build/pdf.min.mjs`, `legacy/build/pdf.worker.min.mjs`,
  `cmaps/` and `LICENSE`.
- **Version:** 6.3.289
- **License:** Apache License 2.0 (`chat/libs/pdfjs/LICENSE`)
- **Copyright:** Copyright 2024 Mozilla Foundation
- **Usage:** Extracts the text of PDF attachments for the chat agent's
  `attachment_read_pdf` tool, in its own worker. Text only: no rendering, scripting or forms.

## Adobe CMap resources (`chat/libs/pdfjs/cmaps/`)

- **Source:** https://github.com/mozilla/pdf.js/tree/master/external/bcmaps — shipped inside
  the `pdfjs-dist` release above, unmodified.
- **Version:** as in `pdfjs-dist` 6.3.289
- **License:** BSD 3-Clause License (`chat/libs/pdfjs/cmaps/LICENSE`)
- **Copyright:** Copyright 1990-2009 Adobe Systems Incorporated
- **Usage:** Character maps PDF.js needs to extract CJK text from PDFs whose fonts are not
  embedded.

## core-js (compiled into `chat/libs/pdfjs/pdf.min.mjs` and `chat/libs/pdfjs/pdf.worker.min.mjs`)

- **Source:** https://github.com/zloirock/core-js — the polyfills the `pdfjs-dist` legacy
  build compiles in. `pdfjs-dist` does not ship core-js's license, so it is added beside it.
- **Version:** 3.50.0
- **License:** MIT License (`chat/libs/pdfjs/LICENSE-core-js`)
- **Copyright:** Copyright (c) 2013–2025 Denis Pushkarev (zloirock.ru), Copyright (c)
  2025–2026 CoreJS Company (core-js.io)
- **Usage:** Part of PDF.js; not used on its own.

## diff-match-patch (`compose/libs/diff-match-patch.js`)

- **Source:** https://github.com/google/diff-match-patch
  (`javascript/diff_match_patch_uncompressed.js`)
- **Version:** upstream `master` (the project has no tagged releases); re-indented, otherwise
  unmodified
- **License:** Apache License 2.0 (`compose/libs/LICENSE-diff-match-patch`)
- **Copyright:** Copyright 2018 The diff-match-patch Authors
- **Usage:** Character-level diffing for the compose / inline-edit UX.

## jsdiff (`compose/libs/jsdiff.min.js`)

- **Source:** https://github.com/kpdecker/jsdiff — the npm `diff` release's
  `dist/diff.min.js`, unmodified.
- **Version:** 5.2.0
- **License:** BSD 3-Clause License (`compose/libs/LICENSE-jsdiff`)
- **Copyright:** Copyright (c) 2009-2015, Kevin Decker
- **Usage:** Text diffing utilities for compose suggestions.

## patience-diff (`compose/libs/patience-diff.js`)

- A first-party implementation of the Patience Diff algorithm, kept alongside
  the bundled diff libraries for a consistent compose-libs environment. Licensed
  under this project's MPL-2.0 like the rest of the add-on source.

---

## Development dependencies

The following are **development-only** dependencies (test tooling) and are **not**
shipped in the add-on XPI:

- **vitest** — MIT License — https://github.com/vitest-dev/vitest
- **@vitest/coverage-v8** — MIT License — https://github.com/vitest-dev/vitest
- **acorn** — MIT License — https://github.com/acornjs/acorn
- **fake-indexeddb** — Apache License 2.0 — https://github.com/dumbmatter/fakeIndexedDB
- **jsdom** — MIT License — https://github.com/jsdom/jsdom

See `package.json` for exact versions.
