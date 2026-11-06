/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// acknowledgments.test.js — the settings page's open source Acknowledgments dialog.
//
// Three properties:
//  1. Every third-party component the add-on ships is credited: each vendored
//     library under compose/libs/ and chat/libs/ is in THIRD_PARTY_LICENSES.md,
//     its upstream license text ships beside it byte for byte, the version the
//     document records is the one the shipped files carry, and each third-party
//     section there is in the dialog with the same upstream URL, license and
//     copyright line.
//  2. The dialog works through the settings page's real click handler
//     (initConfigPage) on the real config.html: the footer link opens it with
//     every component listed, links open in the default browser without
//     navigating the settings tab, Done or a backdrop click closes it, and every
//     other control still reaches its own handlers.
//  3. Its colors come from the palette, with no fallback, in both themes.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACKNOWLEDGMENTS } from "../config/modules/acknowledgments.js";
import { buildPaletteCSS } from "../theme/palette/palette.build.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const sha256 = (rel) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");

const LICENSES_DOC = read("THIRD_PARTY_LICENSES.md");
const CONFIG_HTML = read("config/config.html");
const VENDOR_DIRS = ["compose/libs", "chat/libs"];

// The text of one "- **Field:** ..." item, its wrapped lines joined.
function field(block, name) {
  const match = block.match(new RegExp(`^- \\*\\*${name}:\\*\\*\\s+([\\s\\S]*?)(?=^- \\*\\*|(?![\\s\\S]))`, "m"));
  return match ? match[1].replace(/\s+/g, " ").trim() : null;
}

const backticked = (text) => [...(text ?? "").matchAll(/`([^`]+)`/g)].map((m) => m[1]);

// The shipped-component sections of THIRD_PARTY_LICENSES.md, in order. Development
// dependencies are not shipped. `paths` are the repo paths a section accounts for: the
// files in its heading and the license file on its License line.
function shippedSections() {
  const shipped = LICENSES_DOC.split(/^## Development dependencies/m)[0];
  return shipped
    .split(/^## /m)
    .slice(1)
    .map((block) => {
      const heading = block.split("\n")[0];
      const licenseLine = field(block, "License");
      const licenseFile = backticked(licenseLine)[0] ?? null;
      return {
        heading,
        name: heading.split(" (")[0],
        headingPaths: backticked(heading),
        licenseFile,
        paths: [...backticked(heading), ...(licenseFile ? [licenseFile] : [])],
        source: field(block, "Source")?.match(/https:\/\/\S+/)?.[0] ?? null,
        license: licenseLine?.split(" (")[0] ?? null,
        copyright: field(block, "Copyright"),
        version: field(block, "Version"),
      };
    });
}

// SHA-256 of each shipped license text. Each equals the upstream file for the
// version shipped: pdfjs-dist 6.3.289's LICENSE and cmaps/LICENSE, core-js
// v3.50.0's LICENSE, diff 5.2.0's LICENSE, and diff-match-patch's LICENSE. A
// library update replaces the text and its pin together.
const LICENSE_SHA256 = {
  "chat/libs/pdfjs/LICENSE": "0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594",
  "chat/libs/pdfjs/cmaps/LICENSE": "aa92ab5a472974865a96fd4a4e9c13bb41bf6fe1b309cb6b8da48bc9e19839a2",
  "chat/libs/pdfjs/LICENSE-core-js": "b87653fff2d44426ab5cd4723cee3b1364dc8d35a0acdf098c54689543123bf8",
  "compose/libs/LICENSE-diff-match-patch": "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30",
  "compose/libs/LICENSE-jsdiff": "eda81a415869e67809f6a9f3fd6056062cb83a462118e07eec5e92b2e0c40ce9",
};

const PDFJS_FILES = ["chat/libs/pdfjs/pdf.min.mjs", "chat/libs/pdfjs/pdf.worker.min.mjs"];
// diff 5.2.0's dist/diff.min.js carries no version string, so its bytes are pinned.
const JSDIFF_MIN_SHA256 = { "5.2.0": "c9bd9f7442db093c796b51b62ae199b619c158fd761a4ca9ac85da58a8024b8c" };

// How each section's recorded version is read back from the shipped files.
// diff-match-patch has no tagged releases, so it records no version number.
const VERSION_EVIDENCE = {
  "PDF.js": (version) => PDFJS_FILES.every((f) => read(f).includes(`"${version}"`)),
  "Adobe CMap resources": (version, pdfjsVersion) => version === `as in \`pdfjs-dist\` ${pdfjsVersion}`,
  "core-js": (version) =>
    PDFJS_FILES.every((f) => read(f).includes(`core-js/blob/v${version}/LICENSE`)),
  "diff-match-patch": (version) => version.startsWith("upstream `master`"),
  jsdiff: (version) => sha256("compose/libs/jsdiff.min.js") === JSDIFF_MIN_SHA256[version],
};

describe("every shipped third-party component is credited", () => {
  it("each vendored library is listed in THIRD_PARTY_LICENSES.md", () => {
    const documented = shippedSections().flatMap((s) => s.paths);
    const vendored = VENDOR_DIRS.flatMap((dir) =>
      readdirSync(join(ROOT, dir)).map((name) => `${dir}/${name}`),
    );
    expect(vendored.length).toBeGreaterThan(0);
    for (const path of vendored) {
      const covered = documented.some((doc) => doc.replace(/\/$/, "") === path);
      expect(covered, `${path} is not in THIRD_PARTY_LICENSES.md`).toBe(true);
    }
  });

  it("every file THIRD_PARTY_LICENSES.md names exists", () => {
    for (const section of shippedSections()) {
      for (const path of section.headingPaths) {
        expect(existsSync(join(ROOT, path)), `${section.heading}: ${path} does not exist`).toBe(true);
      }
    }
  });

  it("each third-party component ships its upstream license text, byte for byte", () => {
    const thirdParty = shippedSections().filter((s) => s.source);
    expect(thirdParty.length).toBeGreaterThan(0);
    for (const section of thirdParty) {
      expect(section.licenseFile, `${section.heading} names no license file`).not.toBeNull();
      expect(VENDOR_DIRS.some((dir) => section.licenseFile.startsWith(`${dir}/`))).toBe(true);
      expect(LICENSE_SHA256[section.licenseFile], `${section.licenseFile} has no pinned upstream text`).toBeDefined();
      expect(sha256(section.licenseFile), `${section.licenseFile} is not the upstream text`).toBe(
        LICENSE_SHA256[section.licenseFile],
      );
    }
    expect(Object.keys(LICENSE_SHA256).sort()).toEqual(thirdParty.map((s) => s.licenseFile).sort());
  });

  it("each third-party component's recorded version is the one its shipped files carry", () => {
    const thirdParty = shippedSections().filter((s) => s.source);
    const pdfjsVersion = thirdParty.find((s) => s.name === "PDF.js")?.version;
    expect(pdfjsVersion).toMatch(/^\d+\.\d+\.\d+$/);
    for (const section of thirdParty) {
      const evidence = VERSION_EVIDENCE[section.name];
      expect(evidence, `${section.name} has no version check`).toBeDefined();
      expect(section.version, `${section.heading} records no version`).not.toBeNull();
      expect(evidence(section.version, pdfjsVersion), `${section.name}: version ${section.version}`).toBe(true);
    }
  });

  it("each third-party section is in the dialog with its upstream, license and copyright", () => {
    // A section without a Source is first-party code kept beside the vendored libs.
    const thirdParty = shippedSections().filter((s) => s.source);
    expect(thirdParty.length).toBeGreaterThan(0);
    for (const section of thirdParty) {
      const entry = ACKNOWLEDGMENTS.find((a) => a.url === section.source);
      expect(entry, `${section.heading} is not in the dialog`).toBeDefined();
      // The dialog may add how it ships, e.g. "core-js (bundled inside PDF.js)".
      expect(entry.name === section.name || entry.name.startsWith(`${section.name} (`),
        `${entry.name} is not named ${section.name}`).toBe(true);
      expect(entry.license).toBe(section.license);
      expect(entry.copyright).toBe(section.copyright);
    }
    // And nothing in the dialog that the document does not record.
    expect(ACKNOWLEDGMENTS.map((a) => a.url).sort()).toEqual(
      thirdParty.map((s) => s.source).sort(),
    );
  });

  it("every entry has a name, a license, a copyright line and an https upstream", () => {
    for (const { name, license, copyright, url } of ACKNOWLEDGMENTS) {
      expect(name).toMatch(/\S/);
      expect(license).toMatch(/\S/);
      expect(copyright).toMatch(/^Copyright /);
      expect(new URL(url).protocol).toBe("https:");
    }
  });
});

// The settings page's own modules that init.js imports, stubbed at the module
// boundary so the real initConfigPage installs its real document listeners. The
// list is read from init.js, so a new import needs no change here. The dialog's
// module and the DOM helper stay real.
const INIT_SOURCE = read("config/modules/init.js");
const REAL_INIT_IMPORTS = new Set(["./acknowledgments.js", "./dom.js"]);

function stubInitImports() {
  const stubs = {};
  for (const [, names, spec] of INIT_SOURCE.matchAll(/import\s*\{([\s\S]*?)\}\s*from\s*"(\.\/[^"]+)";/g)) {
    if (REAL_INIT_IMPORTS.has(spec)) continue;
    const module = {};
    for (const name of names.split(",").map((n) => n.trim()).filter(Boolean)) {
      // create* return the listener they build; everything else is an async handler.
      stubs[name] = name.startsWith("create") ? vi.fn(() => () => {}) : vi.fn(async () => {});
      module[name] = stubs[name];
    }
    vi.doMock(`../config/modules/${spec.slice(2)}`, () => module);
  }
  return stubs;
}

describe("the Acknowledgments dialog on the settings page", () => {
  let dom;
  let stubs;
  let browserApi;
  let log;

  beforeEach(async () => {
    vi.resetModules();
    stubs = stubInitImports();
    dom = new JSDOM(CONFIG_HTML, { url: "moz-extension://tabmail/config/config.html" });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;

    // jsdom has HTMLDialogElement but neither showModal() nor close().
    const dialog = dom.window.document.getElementById("acknowledgments-dialog");
    dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
    dialog.close = vi.fn(() => dialog.removeAttribute("open"));

    browserApi = {
      windows: { openDefaultBrowser: vi.fn(() => Promise.resolve()) },
      runtime: { onMessage: { addListener: vi.fn(), removeListener: vi.fn() }, sendMessage: vi.fn(async () => {}) },
      storage: {
        onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
        local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) },
      },
    };
    globalThis.browser = browserApi;
    globalThis.fetch = vi.fn(() => Promise.reject(new Error("no network in this test")));
    log = vi.fn();

    const { initConfigPage } = await import("../config/modules/init.js");
    await initConfigPage({
      SETTINGS: {},
      getBackendUrl: () => "https://example.com",
      log,
      getPrivacyOptOutAllAiEnabled: () => false,
      setPrivacyOptOutAllAiEnabled: () => {},
    });
    // Start each test from what a click does, not from what loading the page did.
    vi.clearAllMocks();
  });

  afterEach(() => {
    dom.window.dispatchEvent(new dom.window.Event("beforeunload"));
    dom.window.close();
    delete globalThis.window;
    delete globalThis.document;
    delete globalThis.browser;
    delete globalThis.fetch;
  });

  const $ = (id) => dom.window.document.getElementById(id);

  function click(el) {
    const event = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  }

  function openDialog() {
    click($("open-acknowledgments"));
    return [...$("acknowledgments-list").querySelectorAll("a.tm-ack-link")];
  }

  it("sits at the bottom of the page, after every settings section", () => {
    const footer = $("open-acknowledgments").closest("footer");
    expect(footer).not.toBeNull();
    const sections = $("page").querySelectorAll("section");
    const last = sections[sections.length - 1];
    expect(last.compareDocumentPosition(footer) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("carries the iOS intro line", () => {
    expect($("acknowledgments-dialog").textContent).toContain(
      "TabMail is built with the help of these open source libraries. We're grateful to their authors and contributors.",
    );
  });

  it("is named by its heading for screen readers", () => {
    const labelId = $("acknowledgments-dialog").getAttribute("aria-labelledby");
    const label = labelId ? $(labelId) : null;
    expect(label, "aria-labelledby names no element").not.toBeNull();
    expect(label.tagName).toBe("H3");
    expect($("acknowledgments-dialog").contains(label)).toBe(true);
    expect(label.textContent.trim()).toBe("Acknowledgments");
  });

  it("opens from the footer link with every component, and touches no storage, network or other handler", () => {
    expect($("acknowledgments-dialog").hasAttribute("open")).toBe(false);
    const links = openDialog();
    expect($("acknowledgments-dialog").showModal).toHaveBeenCalledTimes(1);
    expect($("acknowledgments-dialog").hasAttribute("open")).toBe(true);
    expect(links.map((a) => ({
      name: a.querySelector(".tm-ack-name").textContent,
      license: a.querySelector(".tm-ack-license").textContent,
      copyright: a.querySelector(".tm-ack-copyright").textContent,
      url: a.getAttribute("href"),
    }))).toEqual(ACKNOWLEDGMENTS);
    // Every link is reachable from the keyboard.
    for (const a of links) expect(a.tabIndex).toBe(0);
    expect(stubs.handleUiTweaksClick).not.toHaveBeenCalled();
    expect(stubs.handleByokClick).not.toHaveBeenCalled();
    expect(browserApi.storage.local.get).not.toHaveBeenCalled();
    expect(browserApi.storage.local.set).not.toHaveBeenCalled();
    expect(browserApi.storage.local.remove).not.toHaveBeenCalled();
    expect(browserApi.runtime.sendMessage).not.toHaveBeenCalled();
    expect(browserApi.windows.openDefaultBrowser).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("lists each component once when opened again", () => {
    openDialog();
    click($("close-acknowledgments"));
    expect(openDialog()).toHaveLength(ACKNOWLEDGMENTS.length);
  });

  it("opens each component's upstream in the default browser, never in the settings tab", () => {
    const links = openDialog();
    expect(links).toHaveLength(ACKNOWLEDGMENTS.length);
    for (const a of links) {
      // A click on text inside the link still opens the link, and the settings
      // tab's navigation is cancelled during the click itself.
      const event = click(a.querySelector(".tm-ack-name"));
      expect(event.defaultPrevented).toBe(true);
      expect(browserApi.windows.openDefaultBrowser).toHaveBeenLastCalledWith(a.getAttribute("href"));
    }
    expect(browserApi.windows.openDefaultBrowser).toHaveBeenCalledTimes(ACKNOWLEDGMENTS.length);
    expect(stubs.handleUiTweaksClick).not.toHaveBeenCalled();
    expect($("acknowledgments-dialog").hasAttribute("open")).toBe(true);
  });

  it("logs when the default browser cannot be opened", async () => {
    browserApi.windows.openDefaultBrowser.mockImplementation(() => Promise.reject(new Error("no browser")));
    click(openDialog()[0]);
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
      expect.stringContaining(ACKNOWLEDGMENTS[0].url),
      "error",
    ));
  });

  it("closes on Done", () => {
    openDialog();
    click($("close-acknowledgments"));
    expect($("acknowledgments-dialog").hasAttribute("open")).toBe(false);
  });

  it("closes on a backdrop click, but not on a click inside its content", () => {
    openDialog();
    click($("acknowledgments-dialog").querySelector(".tm-ack-intro"));
    expect($("acknowledgments-dialog").hasAttribute("open")).toBe(true);
    // A click on the backdrop targets the dialog element itself.
    click($("acknowledgments-dialog"));
    expect($("acknowledgments-dialog").hasAttribute("open")).toBe(false);
  });

  it("leaves every other control to the page's own handlers", async () => {
    const event = click($("refresh-usage"));
    await vi.waitFor(() => expect(stubs.updateQuotaDisplay).toHaveBeenCalledTimes(1));
    expect(event.defaultPrevented).toBe(false);
    expect(stubs.handleUiTweaksClick).toHaveBeenCalledTimes(1);
    expect(stubs.handleByokClick).toHaveBeenCalledTimes(1);
    expect($("acknowledgments-dialog").hasAttribute("open")).toBe(false);
    expect(browserApi.windows.openDefaultBrowser).not.toHaveBeenCalled();
  });
});

describe("the footer link and dialog colors", () => {
  // The rules config.css adds for them: from their comment to the end of the file.
  const CSS = read("config/config.css");
  const marker = "/* Footer link and the open source Acknowledgments dialog */";
  const block = CSS.slice(CSS.indexOf(marker));
  const COLOR_PROPERTY = /^(color|background(-color)?|border(-(top|bottom|left|right))?(-color)?|outline(-color)?)$/;
  const NON_COLOR_TOKEN = /^(none|solid|0|-?\d+(\.\d+)?(px|em|rem|%))$/;

  const declarations = () =>
    [...block.matchAll(/([a-z-]+)\s*:\s*([^;{}]+);/g)].map(([, property, value]) => ({ property, value: value.trim() }));

  it("is found in config.css", () => {
    expect(CSS.indexOf(marker)).toBeGreaterThan(-1);
    expect(declarations().some((d) => COLOR_PROPERTY.test(d.property))).toBe(true);
  });

  it("uses only palette variables, with no fallback and no literal color", () => {
    for (const { property, value } of declarations().filter((d) => COLOR_PROPERTY.test(d.property))) {
      expect(value, `${property}: ${value} has a fallback`).not.toMatch(/var\([^)]*,/);
      const rest = value.replace(/var\(--[\w-]+\)/g, "").split(/\s+/).filter(Boolean);
      for (const token of rest) {
        expect(token, `${property}: ${value} is not a palette color`).toMatch(NON_COLOR_TOKEN);
      }
    }
  });

  it("uses only variables the palette defines for both the light and the dark theme", () => {
    const palette = buildPaletteCSS(JSON.parse(read("theme/palette/palette.data.json")));
    const darkAt = palette.indexOf("@media (prefers-color-scheme: dark)");
    expect(darkAt).toBeGreaterThan(-1);
    const light = palette.slice(0, darkAt);
    const dark = palette.slice(darkAt);
    const used = new Set([...block.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]));
    expect(used.size).toBeGreaterThan(0);
    for (const name of used) {
      expect(light, `${name} is not defined for the light theme`).toContain(`${name}:`);
      expect(dark, `${name} is not defined for the dark theme`).toContain(`${name}:`);
    }
  });
});
