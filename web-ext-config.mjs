/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// web-ext configuration. web-ext reads this file only from its working
// directory, or when given with --config, so release builds pass it with
// --config. Patterns resolve against the source directory; a matched folder is
// left out with everything in it. web-ext already leaves out dotfiles,
// node_modules and *.xpi / *.zip.
//
// scripts/check-xpi-contents.mjs checks a built XPI against this list, and
// test/xpiContents.test.js keeps the list in step with the repository.

export default {
  ignoreFiles: [
    // Repository documents and developer tooling, not part of the add-on.
    "AGENTS.md",
    "CLAUDE.md",
    "CODE_OF_CONDUCT.md",
    "CONTRIBUTING.md",
    "Companion",
    "DECISIONS.md",
    "PROJECT_MEMORY.md",
    "PROJECT_STRUCTURE.md",
    "README.md",
    "SECURITY.md",
    "TESTS.md",
    "design",
    "package.json",
    "package-lock.json",
    "scripts",
    "test",
    "vitest.config.js",
    "web-ext-config.mjs",
    // Developer notes inside the add-on's folders.
    "**/ARCHITECTURE.md",
    "**/README*.md",
    "**/README.txt",
    // Local build and test output, never committed.
    "coverage",
    "cov_out",
    "dist",
    "secrets",
    "config.local.json",
    "**/*.log",
    "**/*.key",
    "**/*.pem",
  ],
};
