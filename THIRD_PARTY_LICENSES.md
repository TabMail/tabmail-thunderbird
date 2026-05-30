# Third-Party Licenses

The TabMail Thunderbird add-on bundles the following third-party components.
These are **not** covered by the add-on's MPL-2.0 license; each retains its own
license as noted below. They live under `compose/libs/` and keep their original
copyright/license headers.

---

## diff-match-patch (`compose/libs/diff-match-patch.js`)

- **Source:** https://github.com/google/diff-match-patch
- **License:** Apache License 2.0
- **Copyright:** The diff-match-patch Authors (Google)
- **Usage:** Character-level diffing for the compose / inline-edit UX.

## jsdiff (`compose/libs/jsdiff.min.js`)

- **Source:** https://github.com/kpdecker/jsdiff
- **License:** BSD 3-Clause License
- **Copyright:** Kevin Decker
- **Usage:** Text diffing utilities for compose suggestions.

## JavaScript-Undo-Manager (`compose/libs/undo-manager.js`)

- **Source:** https://github.com/ArthurClemens/JavaScript-Undo-Manager
- **License:** MIT License
- **Copyright:** Arthur Clemens
- **Usage:** Lightweight undo/redo stack in the composer (trimmed copy).

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

See `package.json` for exact versions.
