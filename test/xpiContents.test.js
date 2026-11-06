/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// xpiContents.test.js — what the add-on package (XPI) contains.
//
// The XPI is the repository's tracked files minus what web-ext leaves out
// (web-ext-config.mjs plus web-ext's own defaults). Properties:
//  1. Only the add-on ships: its top-level entries are exactly the runtime
//     folders, the manifest and the license notices; no test, repository
//     document or developer note does.
//  2. Nothing the add-on loads is left out (every path the manifest names).
//  3. scripts/check-xpi-contents.mjs fails a built XPI that carries an excluded
//     file or lacks the manifest or a license notice, and passes a clean one.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_FILES,
  WEB_EXT_DEFAULT_IGNORES,
  isIgnored,
  xpiProblems,
} from "../scripts/check-xpi-contents.mjs";
import webExtConfig from "../web-ext-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = join(ROOT, "scripts/check-xpi-contents.mjs");
const PATTERNS = [...WEB_EXT_DEFAULT_IGNORES, ...webExtConfig.ignoreFiles];

// What the add-on is made of. A new top-level entry has to be added here or to
// web-ext-config.mjs, so nothing reaches the XPI by default.
const SHIPPED_TOP_LEVEL = [
  "LICENSE",
  "THIRD_PARTY_LICENSES.md",
  "TRADEMARKS.md",
  "agent",
  "chat",
  "chatlink",
  "compose",
  "config",
  "fts",
  "gui",
  "icons",
  "manifest.json",
  "marketplace",
  "popup",
  "prompts",
  "templates",
  "theme",
  "updates",
  "welcome",
];

const trackedFiles = () =>
  execFileSync("git", ["-C", ROOT, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const shippedFiles = () => trackedFiles().filter((file) => isIgnored(file, PATTERNS) === false);

describe("the files web-ext packs", () => {
  it("are the add-on only: its runtime folders, the manifest and the license notices", () => {
    const topLevel = [...new Set(shippedFiles().map((file) => file.split("/")[0]))].sort();
    expect(topLevel).toEqual([...SHIPPED_TOP_LEVEL].sort());
  });

  it("include no test, repository document or developer note", () => {
    const shipped = shippedFiles();
    const unwanted = shipped.filter((file) =>
      /^(test|Companion|design|scripts)\//.test(file) ||
      /(^|\/)(README[^/]*\.md|ARCHITECTURE\.md|README\.txt)$/.test(file) ||
      /^(AGENTS|CLAUDE|DECISIONS|PROJECT_MEMORY|PROJECT_STRUCTURE|TESTS)\.md$/.test(file) ||
      /^(package(-lock)?\.json|vitest\.config\.js|web-ext-config\.mjs)$/.test(file),
    );
    expect(unwanted).toEqual([]);
    // The repository does have such files, so the check above is not vacuous.
    expect(trackedFiles().filter((file) => /^test\//.test(file)).length).toBeGreaterThan(0);
    expect(trackedFiles()).toContain("chat/ARCHITECTURE.md");
  });

  it("keep the prompt documents the add-on loads", () => {
    const prompts = trackedFiles().filter((file) => /^prompts\/.*\.md$/.test(file));
    expect(prompts.length).toBeGreaterThan(0);
    for (const file of prompts) expect(isIgnored(file, PATTERNS), file).toBe(false);
  });

  it("include every file the manifest names", () => {
    const manifest = read("manifest.json");
    const named = new Set();
    JSON.parse(manifest, (_key, value) => {
      if (typeof value === "string" && /^[\w-]+(\/[\w.-]+)+$|^[\w-]+\.(js|html|json|svg|png)$/.test(value)) {
        named.add(value);
      }
      return value;
    });
    const files = [...named].filter((path) => existsSync(join(ROOT, path)));
    expect(files.length).toBeGreaterThan(5);
    for (const path of files) expect(isIgnored(path, PATTERNS), path).toBe(false);
  });

  it("is configured with options web-ext accepts", () => {
    // web-ext rejects a config file with an option it does not know.
    expect(Object.keys(webExtConfig)).toEqual(["ignoreFiles"]);
    expect(webExtConfig.ignoreFiles.every((pattern) => typeof pattern === "string")).toBe(true);
  });

  it("no longer come from .web-extignore, which web-ext never reads", () => {
    expect(existsSync(join(ROOT, ".web-extignore"))).toBe(false);
  });
});

describe("isIgnored", () => {
  it("leaves out a matched folder with everything in it, as web-ext does", () => {
    expect(isIgnored("test/deep/nested.test.js", ["test"])).toBe(true);
    expect(isIgnored("chat/test/x.js", ["test"])).toBe(false);
    expect(isIgnored("theme/palette/README.md", ["**/README*.md"])).toBe(true);
    expect(isIgnored("README.md", ["**/README*.md"])).toBe(true);
    expect(isIgnored(".codex/hooks.json", WEB_EXT_DEFAULT_IGNORES)).toBe(true);
    expect(isIgnored("agent/modules/utils.js", PATTERNS)).toBe(false);
  });
});

describe("xpiProblems", () => {
  const clean = [...REQUIRED_FILES, "agent/", "agent/background.js", "prompts/agent_summary.md"];

  it("passes a clean XPI", () => {
    expect(xpiProblems(clean)).toEqual([]);
  });

  it("reports every excluded file", () => {
    expect(xpiProblems([...clean, "test/a.test.js", "Companion/x.md", "chat/ARCHITECTURE.md", ".env"])).toEqual([
      "excluded file in the XPI: test/a.test.js",
      "excluded file in the XPI: Companion/x.md",
      "excluded file in the XPI: chat/ARCHITECTURE.md",
      "excluded file in the XPI: .env",
    ]);
  });

  it("reports a missing manifest or license notice", () => {
    for (const required of REQUIRED_FILES) {
      expect(xpiProblems(clean.filter((entry) => entry !== required))).toEqual([
        `required file missing: ${required}`,
      ]);
    }
  });
});

describe("scripts/check-xpi-contents.mjs on a built XPI", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function buildXpi(files) {
    dir = mkdtempSync(join(tmpdir(), "tm-xpi-"));
    const src = join(dir, "src");
    for (const file of files) {
      mkdirSync(dirname(join(src, file)), { recursive: true });
      writeFileSync(join(src, file), "x");
    }
    const xpi = join(dir, "addon.xpi");
    execFileSync("zip", ["-q", "-r", xpi, "."], { cwd: src });
    return xpi;
  }

  const run = (xpi) => spawnSync(process.execPath, [CHECK, xpi], { encoding: "utf8" });

  it("passes a clean XPI", () => {
    const result = run(buildXpi([...REQUIRED_FILES, "agent/background.js"]));
    expect(result.status).toBe(0);
  });

  it("fails an XPI that ships a test file, naming it", () => {
    const result = run(buildXpi([...REQUIRED_FILES, "agent/background.js", "test/a.test.js"]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("excluded file in the XPI: test/a.test.js");
  });

  it("fails an XPI without its license notices", () => {
    const result = run(buildXpi(["manifest.json", "agent/background.js"]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required file missing: THIRD_PARTY_LICENSES.md");
  });
});

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
