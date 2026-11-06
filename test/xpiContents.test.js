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
//  2. Nothing the add-on loads is left out: every file in a runtime folder ships
//     except developer notes, and so does every path the manifest names.
//  3. The check reads the ignore patterns as web-ext does (case-sensitive, dot
//     names, matched folders), compared with web-ext 9.1.0's own verdicts.
//  4. scripts/check-xpi-contents.mjs fails a built XPI that carries an excluded
//     file or lacks the manifest or a license notice, and passes a clean one,
//     also when run through a symlinked path.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WEB_EXT_DEFAULT_IGNORES, globToRegExp, isIgnored, xpiProblems } from "../scripts/xpi-contents.mjs";
import * as webExtConfigModule from "../web-ext-config.mjs";
import webExtConfig from "../web-ext-config.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = join(ROOT, "scripts/check-xpi-contents.mjs");
const PATTERNS = [...WEB_EXT_DEFAULT_IGNORES, ...webExtConfig.ignoreFiles];

// What the add-on is made of. A new top-level entry has to be added here or to
// web-ext-config.mjs, so nothing reaches the XPI by default.
// The manifest and the license notices every XPI must carry. Written out here,
// not taken from the check, so a notice dropped from the check fails a test.
const NOTICES = ["manifest.json", "LICENSE", "THIRD_PARTY_LICENSES.md", "TRADEMARKS.md"];

// Developer notes inside the runtime folders: the only files there that stay out.
const DEVELOPER_NOTE = /(^|\/)(README[^/]*\.md|README\.txt|ARCHITECTURE\.md)$/;

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

  it("include every file in a runtime folder except developer notes", () => {
    const runtimeFolders = SHIPPED_TOP_LEVEL.filter((entry) => !NOTICES.includes(entry) && !/\.md$/.test(entry));
    const inRuntimeFolders = trackedFiles().filter((file) => runtimeFolders.includes(file.split("/")[0]));
    // pdf.js's worker and CMap license are among them: the oracle is not vacuous.
    expect(inRuntimeFolders).toContain("chat/libs/pdfjs/pdf.worker.min.mjs");
    expect(inRuntimeFolders).toContain("chat/libs/pdfjs/cmaps/LICENSE");
    const missing = inRuntimeFolders.filter((file) => !DEVELOPER_NOTE.test(file) && isIgnored(file, PATTERNS));
    expect(missing).toEqual([]);
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
    // web-ext merges a config file's named exports into its default export and
    // rejects any option it does not know.
    expect(Object.keys(webExtConfigModule)).toEqual(["default"]);
    expect(Object.keys(webExtConfig)).toEqual(["ignoreFiles"]);
    expect(webExtConfig.ignoreFiles.every((pattern) => typeof pattern === "string")).toBe(true);
  });

  it("no longer come from .web-extignore, which web-ext never reads", () => {
    expect(existsSync(join(ROOT, ".web-extignore"))).toBe(false);
  });
});

// web-ext 9.1.0's own verdicts: its FileFilter, asked for the path and each folder
// above it, with the one pattern as its only ignore.
const WEB_EXT_VERDICTS = [
  ["assets/README.md", "**/README*.md", true],
  ["README.md", "**/README*.md", true],
  ["docs/README-dev.md", "**/README*.md", true],
  ["assets/README.MD", "**/README*.md", false],
  ["readme.md", "**/README*.md", false],
  ["README.md.orig", "**/README*.md", false],
  ["a/b/build.log", "**/*.log", true],
  ["build.LOG", "**/*.log", false],
  ["a/.x.log", "**/*.log", false],
  [".github/x.log", "**/*.log", false],
  ["a/x.log.gz", "**/*.log", false],
  ["server.pem", "**/*.pem", true],
  ["KEY.KEY", "**/*.key", false],
  [".hidden", "**/.*", true],
  ["a/.hidden", "**/.*", true],
  [".codex/hooks.json", "**/.*/**/*", true],
  ["a/.codex/b/c.json", "**/.*/**/*", true],
  ["x.xpi", "**/*.xpi", true],
  ["a/b.ZIP", "**/*.zip", false],
  ["node_modules/x/y.js", "**/node_modules", true],
  ["a/node_modules/y.js", "**/node_modules/**/*", true],
  ["test", "test", true],
  ["test/a/b.js", "test", true],
  ["chat/test/x.js", "test", false],
  ["Test/x.js", "test", false],
  ["testing/x.js", "test", false],
  ["chat/ARCHITECTURE.md", "**/ARCHITECTURE.md", true],
  ["ARCHITECTURE.md", "**/ARCHITECTURE.md", true],
  ["welcome/assets/README.txt", "**/README.txt", true],
  ["config.local.json", "config.local.json", true],
  ["a/config.local.json", "config.local.json", false],
];

describe("isIgnored", () => {
  it.each(WEB_EXT_VERDICTS)("%s against %s is what web-ext decides (%s)", (path, pattern, ignored) => {
    expect(isIgnored(path, [pattern])).toBe(ignored);
  });

  it("reads every pattern the add-on and web-ext use", () => {
    for (const pattern of PATTERNS) expect(() => globToRegExp(pattern), pattern).not.toThrow();
  });

  it("refuses glob syntax it does not read, instead of misreading it", () => {
    for (const pattern of ["**/*.{log,key}", "a?.js", "[ab].js", "!test", "a/**", "a//b"]) {
      expect(() => globToRegExp(pattern), pattern).toThrow();
    }
  });
});

describe("xpiProblems", () => {
  const clean = [...NOTICES, "agent/", "agent/background.js", "prompts/agent_summary.md"];

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
    for (const required of NOTICES) {
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
    return buildXpiIn(join(dir, "first"), files);
  }

  function buildXpiIn(base, files) {
    const src = join(base, "src");
    for (const file of files) {
      mkdirSync(dirname(join(src, file)), { recursive: true });
      writeFileSync(join(src, file), "x");
    }
    const xpi = join(base, "addon.xpi");
    execFileSync("zip", ["-q", "-r", xpi, "."], { cwd: src });
    return xpi;
  }

  const run = (xpi, check = CHECK) => spawnSync(process.execPath, xpi ? [check, xpi] : [check], { encoding: "utf8" });

  it("passes a clean XPI", () => {
    const result = run(buildXpi([...NOTICES, "agent/background.js"]));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("none excluded, notices present");
  });

  it("fails an XPI that ships a test file, naming it", () => {
    const result = run(buildXpi([...NOTICES, "agent/background.js", "test/a.test.js"]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("excluded file in the XPI: test/a.test.js");
  });

  it("fails an XPI without its license notices", () => {
    const result = run(buildXpi(["manifest.json", "agent/background.js"]));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("required file missing: THIRD_PARTY_LICENSES.md");
  });

  it("checks the XPI when run through a symlinked path", () => {
    // macOS's /tmp is itself a symlink to /private/tmp.
    const xpi = buildXpi([...NOTICES, "agent/background.js", "test/a.test.js"]);
    const link = join(dir, "addon-link");
    symlinkSync(ROOT, link);
    const failed = run(xpi, join(link, "scripts/check-xpi-contents.mjs"));
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("excluded file in the XPI: test/a.test.js");
    const clean = buildXpiIn(join(dir, "clean"), [...NOTICES, "agent/background.js"]);
    const passed = run(clean, join(link, "scripts/check-xpi-contents.mjs"));
    expect(passed.status).toBe(0);
    expect(passed.stdout).toContain("none excluded, notices present");
  });

  it("fails without an XPI path, and on a file that is not an XPI", () => {
    expect(run(undefined).status).toBe(2);
    dir = mkdtempSync(join(tmpdir(), "tm-xpi-"));
    const notXpi = join(dir, "not.xpi");
    writeFileSync(notXpi, "not a zip");
    const result = run(notXpi);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("none excluded");
  });
});

function read(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}
