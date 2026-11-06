/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Checks a built XPI: nothing web-ext-config.mjs leaves out is in it, and the
// manifest and the license notices are.
//
//   node scripts/check-xpi-contents.mjs <path/to/addon.xpi>
//
// Exits 0 when the XPI is clean, 1 with one line per problem otherwise.

import { execFileSync } from "node:child_process";
import { matchesGlob, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import webExtConfig from "../web-ext-config.mjs";

// web-ext's own ignore patterns (FileFilter's baseIgnoredPatterns in web-ext 9).
export const WEB_EXT_DEFAULT_IGNORES = [
  "**/*.xpi",
  "**/*.zip",
  "**/.*",
  "**/.*/**/*",
  "**/node_modules",
  "**/node_modules/**/*",
];

// Every XPI carries the manifest and the license notices.
export const REQUIRED_FILES = ["manifest.json", "LICENSE", "THIRD_PARTY_LICENSES.md", "TRADEMARKS.md"];

/**
 * True when web-ext leaves `path` (relative, "/"-separated) out of the XPI: a
 * pattern matches the path or one of the folders above it, since web-ext skips
 * a matched folder with everything in it.
 */
export function isIgnored(path, patterns) {
  const parts = path.split("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = parts.slice(0, depth).join("/");
    if (patterns.some((pattern) => matchesGlob(prefix, pattern))) return true;
  }
  return false;
}

/** The problems with an XPI whose entries are `entries`; empty when it is clean. */
export function xpiProblems(entries, ignoreFiles = webExtConfig.ignoreFiles) {
  const files = entries.filter((entry) => !entry.endsWith("/"));
  const patterns = [...WEB_EXT_DEFAULT_IGNORES, ...ignoreFiles];
  return [
    ...files.filter((file) => isIgnored(file, patterns)).map((file) => `excluded file in the XPI: ${file}`),
    ...REQUIRED_FILES.filter((file) => !files.includes(file)).map((file) => `required file missing: ${file}`),
  ];
}

export function listXpi(xpiPath) {
  return execFileSync("unzip", ["-Z1", xpiPath], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
}

function main(argv) {
  const xpiPath = argv[0];
  if (!xpiPath) {
    console.error("usage: node scripts/check-xpi-contents.mjs <path/to/addon.xpi>");
    return 2;
  }
  const entries = listXpi(xpiPath);
  const problems = xpiProblems(entries);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`${xpiPath}: ${problems.length} problem(s)`);
    return 1;
  }
  console.log(`${xpiPath}: ${entries.length} entries, none excluded, notices present`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
