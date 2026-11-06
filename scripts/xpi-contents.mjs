/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a built XPI may contain: nothing web-ext-config.mjs leaves out, and the
// manifest and the license notices. scripts/check-xpi-contents.mjs runs this on
// a built XPI; the tests import it.

import { execFileSync } from "node:child_process";
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

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A pattern as web-ext's matcher (minimatch, default options) reads it, for the
 * syntax the ignore lists use: `*` within one path segment and `**` for any
 * number of segments. Matching is case-sensitive on every platform, and a `*` or
 * `**` never matches a name that starts with a dot unless the pattern's own
 * segment does. Other glob syntax throws, so a pattern this cannot read fails
 * the check instead of being misread.
 */
export function globToRegExp(pattern) {
  if (/[?[\]{}()!+@\\]/.test(pattern)) throw new Error(`unsupported glob syntax in ${JSON.stringify(pattern)}`);
  const segments = pattern.split("/");
  if (segments.includes("") || segments[segments.length - 1] === "**") {
    throw new Error(`unsupported glob shape in ${JSON.stringify(pattern)}`);
  }
  const source = segments
    .map((segment) => {
      if (segment === "**") return "(?:(?!\\.)[^/]+/)*";
      const body = segment.split("*").map(escapeRegExp).join("[^/]*");
      return `${segment.startsWith(".") ? "" : "(?!\\.)"}${body}/`;
    })
    .join("");
  return new RegExp(`^${source.slice(0, -1)}$`);
}

/**
 * True when web-ext leaves `path` (relative, "/"-separated) out of the XPI: a
 * pattern matches the path or one of the folders above it, since web-ext skips
 * a matched folder with everything in it.
 */
export function isIgnored(path, patterns) {
  const matchers = patterns.map(globToRegExp);
  const parts = path.split("/");
  for (let depth = 1; depth <= parts.length; depth++) {
    const prefix = parts.slice(0, depth).join("/");
    if (matchers.some((matcher) => matcher.test(prefix))) return true;
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
