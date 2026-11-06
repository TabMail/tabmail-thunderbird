# What the XPI contains: web-ext-config.mjs, and how release builds read it

The add-on package is built with `web-ext build` from a `git archive` export of the release ref, so
the XPI is every tracked file minus what web-ext leaves out. Two sources decide what is left out:

- web-ext's own defaults: dotfiles and dot-folders, `node_modules`, `*.xpi`, `*.zip`.
- `ignoreFiles` in `web-ext-config.mjs`: repository documents (README, CLAUDE, AGENTS, DECISIONS,
  PROJECT_*, TESTS, SECURITY, CONTRIBUTING, CODE_OF_CONDUCT), `Companion/`, `design/`, `test/`,
  `scripts/`, `package*.json`, `vitest.config.js`, the config itself, developer notes inside runtime
  folders (`**/ARCHITECTURE.md`, `**/README*.md`, `**/README.txt`), and local build output.

**web-ext reads a config file only from its working directory (or the home directory), or when given
`--config`.** It never looks in `--source-dir`. A release build runs from elsewhere with
`--source-dir <export>`, so it must pass `--config <export>/web-ext-config.mjs`. A `.web-extignore` file
is not a web-ext feature at all: the one this repo had until 2026-11-06 was never read, and every
release up to 1.11.0 shipped `test/`, `Companion/` and the internal docs (1056 entries, 5.9 MB, against
623 entries, 4.5 MB with the config).

web-ext matches every path, folders included, with multimatch (minimatch, default options) after
resolving the pattern against the source directory. Matching is **case-sensitive**, and `*` or `**` never
match a name that starts with a dot unless the pattern's segment does. A matched folder is skipped with everything in it, so a plain top-level name such as
`test` leaves out the whole folder, while `chat/test` would not be matched by it. The config file may
export only option names web-ext knows: it merges named exports into the config and rejects unknown ones.

**Checks:**
- `test/xpiContents.test.js` applies the same rules to `git ls-files` and pins the shipped top-level
  entries to an explicit list (runtime folders, `manifest.json`, `LICENSE`, `THIRD_PARTY_LICENSES.md`,
  `TRADEMARKS.md`). A new top-level entry fails it until it is added to that list or to `ignoreFiles`.
  It also checks that every file inside a runtime folder ships except developer notes (an explicit
  name pattern in the test, independent of the config), so an ignore line that drops a runtime file
  such as pdf.js's worker fails it; that every file the manifest names ships; and that the config
  module exports only `default` with only `ignoreFiles`.
- `scripts/xpi-contents.mjs` holds the rules: web-ext's defaults, the required notices, and
  `globToRegExp`, a small case-sensitive reader of the `*`/`**` syntax the lists use. It throws on any
  other glob syntax rather than misreading it. **Do not use `node:path` `matchesGlob` here:** on macOS it
  matches case-insensitively (even `path.posix`), so `**/*.log` would match `build.LOG`, which web-ext
  keeps. The test pins the reader to web-ext 9.1.0's own verdicts for case, dot names and folders.
- `scripts/check-xpi-contents.mjs <xpi>` lists a built XPI (`unzip -Z1`) and fails (exit 1) on any file the
  rules leave out, a missing manifest or license notice, or an unreadable XPI; exit 2 without a path.
  Release builds run it after `web-ext build`. It is a CLI only and runs unconditionally: an "am I the
  main module" guard comparing `process.argv[1]` with `import.meta.url` silently skipped the check
  (exit 0) when run through a symlinked path such as macOS's `/tmp`, because node resolves the module
  URL through symlinks and `path.resolve` does not.
