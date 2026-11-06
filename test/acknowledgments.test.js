/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// acknowledgments.test.js — the settings page's open source Acknowledgments dialog.
//
// Two properties:
//  1. Every third-party component the add-on ships is credited: each vendored
//     library under compose/libs/ and chat/libs/ is in THIRD_PARTY_LICENSES.md,
//     its full license text ships beside it, and each third-party section there
//     is in the dialog with the same upstream URL, license and copyright line.
//  2. The dialog works on the real config.html: the footer link opens it with
//     every component listed, links open in the default browser without
//     navigating the settings tab, and Done or a backdrop click closes it.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => readFileSync(join(ROOT, rel), "utf8");

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
        headingPaths: backticked(heading),
        licenseFile,
        paths: [...backticked(heading), ...(licenseFile ? [licenseFile] : [])],
        source: field(block, "Source")?.match(/https:\/\/\S+/)?.[0] ?? null,
        license: licenseLine?.split(" (")[0] ?? null,
        copyright: field(block, "Copyright"),
      };
    });
}

// Words every copy of each license's text contains.
const LICENSE_TEXT_MARKERS = {
  "Apache License 2.0": ["Apache License", "Version 2.0"],
  "BSD 3-Clause License": ["Redistributions in binary form must reproduce", "Neither the name of"],
  "MIT License": ["Permission is hereby granted, free of charge"],
};

let dom;
let ACKNOWLEDGMENTS;
let handleAcknowledgmentsClick;
let openDefaultBrowser;
let log;

beforeEach(async () => {
  vi.resetModules();
  dom = new JSDOM(CONFIG_HTML, { url: "moz-extension://tabmail/config/config.html" });
  const { document } = dom.window;
  globalThis.document = document;

  // jsdom has HTMLDialogElement but neither showModal() nor close().
  const dialog = document.getElementById("acknowledgments-dialog");
  dialog.showModal = vi.fn(() => dialog.setAttribute("open", ""));
  dialog.close = vi.fn(() => dialog.removeAttribute("open"));

  openDefaultBrowser = vi.fn(() => Promise.resolve());
  globalThis.browser = { windows: { openDefaultBrowser } };
  log = vi.fn();

  ({ ACKNOWLEDGMENTS, handleAcknowledgmentsClick } = await import(
    "../config/modules/acknowledgments.js"
  ));
  document.addEventListener("click", (e) => handleAcknowledgmentsClick(e, log));
});

afterEach(() => {
  dom.window.close();
  delete globalThis.document;
  delete globalThis.browser;
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

  it("each third-party component ships its full license text", () => {
    const thirdParty = shippedSections().filter((s) => s.source);
    expect(thirdParty.length).toBeGreaterThan(0);
    for (const section of thirdParty) {
      expect(section.licenseFile, `${section.heading} names no license file`).not.toBeNull();
      expect(VENDOR_DIRS.some((dir) => section.licenseFile.startsWith(`${dir}/`))).toBe(true);
      const markers = LICENSE_TEXT_MARKERS[section.license];
      expect(markers, `${section.heading}: unknown license ${section.license}`).toBeDefined();
      const text = read(section.licenseFile);
      for (const marker of markers) {
        expect(text, `${section.licenseFile} is not the ${section.license} text`).toContain(marker);
      }
    }
  });

  it("each third-party section is in the dialog with its upstream, license and copyright", () => {
    // A section without a Source is first-party code kept beside the vendored libs.
    const thirdParty = shippedSections().filter((s) => s.source);
    expect(thirdParty.length).toBeGreaterThan(0);
    for (const section of thirdParty) {
      const entry = ACKNOWLEDGMENTS.find((a) => a.url === section.source);
      expect(entry, `${section.heading} is not in the dialog`).toBeDefined();
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

describe("the Acknowledgments dialog on the settings page", () => {
  it("sits at the bottom of the page, after every settings section", () => {
    const footer = $("open-acknowledgments").closest("footer");
    expect(footer).not.toBeNull();
    const page = $("page");
    const sections = page.querySelectorAll("section");
    const last = sections[sections.length - 1];
    expect(last.compareDocumentPosition(footer) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("carries the iOS intro line", () => {
    expect($("acknowledgments-dialog").textContent).toContain(
      "TabMail is built with the help of these open source libraries. We're grateful to their authors and contributors.",
    );
  });

  it("opens from the footer link with every component, its license and upstream", () => {
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
  });

  it("lists each component once when opened again", () => {
    openDialog();
    click($("close-acknowledgments"));
    expect(openDialog()).toHaveLength(ACKNOWLEDGMENTS.length);
  });

  it("opens a component's upstream in the default browser, not in the settings tab", () => {
    const links = openDialog();
    const pdfjs = links.find((a) => a.textContent.includes("PDF.js"));
    // A click on the name, inside the link, still opens the link.
    const event = click(pdfjs.querySelector(".tm-ack-name"));
    expect(event.defaultPrevented).toBe(true);
    expect(openDefaultBrowser).toHaveBeenCalledWith("https://github.com/mozilla/pdf.js");
    expect($("acknowledgments-dialog").hasAttribute("open")).toBe(true);
  });

  it("logs when the default browser cannot be opened", async () => {
    openDefaultBrowser.mockImplementation(() => Promise.reject(new Error("no browser")));
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

  it("leaves every other click on the page to the page's own handlers", () => {
    const status = $("status");
    const event = click(status);
    expect(event.defaultPrevented).toBe(false);
    expect(handleAcknowledgmentsClick({ target: status, preventDefault() {} }, log)).toBe(false);
    expect(openDefaultBrowser).not.toHaveBeenCalled();
  });
});

describe("the settings page's click handler", () => {
  it("runs the dialog's handler before anything it awaits, so a link click can still be prevented", () => {
    const init = read("config/modules/init.js");
    const body = init.split("configDOMListeners.documentClickHandler = async (e) => {")[1];
    expect(body).toBeDefined();
    const ackAt = body.indexOf("handleAcknowledgmentsClick(e, log)");
    const firstAwait = body.indexOf("await ");
    expect(ackAt).toBeGreaterThan(-1);
    expect(ackAt).toBeLessThan(firstAwait);
  });
});
