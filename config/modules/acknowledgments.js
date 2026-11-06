/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The settings page's "Acknowledgments" dialog: every third-party component the
// add-on ships, with its license, linked to its upstream project. The list
// mirrors THIRD_PARTY_LICENSES.md (test/acknowledgments.test.js keeps the two
// in step) and follows the iOS app's AcknowledgmentsView.

export const ACKNOWLEDGMENTS = [
  {
    name: "PDF.js",
    license: "Apache License 2.0",
    copyright: "Copyright 2024 Mozilla Foundation",
    url: "https://github.com/mozilla/pdf.js",
  },
  {
    name: "Adobe CMap resources (bundled with PDF.js)",
    license: "BSD 3-Clause License",
    copyright: "Copyright 1990-2009 Adobe Systems Incorporated",
    url: "https://github.com/mozilla/pdf.js/tree/master/external/bcmaps",
  },
  {
    name: "core-js (bundled inside PDF.js)",
    license: "MIT License",
    copyright:
      "Copyright (c) 2013–2025 Denis Pushkarev (zloirock.ru), Copyright (c) 2025–2026 CoreJS Company (core-js.io)",
    url: "https://github.com/zloirock/core-js",
  },
  {
    name: "diff-match-patch",
    license: "Apache License 2.0",
    copyright: "Copyright 2018 The diff-match-patch Authors",
    url: "https://github.com/google/diff-match-patch",
  },
  {
    name: "jsdiff",
    license: "BSD 3-Clause License",
    copyright: "Copyright (c) 2009-2015, Kevin Decker",
    url: "https://github.com/kpdecker/jsdiff",
  },
];

const DIALOG_ID = "acknowledgments-dialog";
const OPEN_ID = "open-acknowledgments";
const CLOSE_ID = "close-acknowledgments";
const LIST_ID = "acknowledgments-list";

function renderAcknowledgments(listEl) {
  const items = ACKNOWLEDGMENTS.map(({ name, license, copyright, url }) => {
    const link = document.createElement("a");
    link.className = "tm-ack-link";
    link.href = url;
    link.dataset.ackUrl = url;

    const nameEl = document.createElement("span");
    nameEl.className = "tm-ack-name";
    nameEl.textContent = name;

    const licenseEl = document.createElement("span");
    licenseEl.className = "tm-ack-license";
    licenseEl.textContent = license;

    const copyrightEl = document.createElement("span");
    copyrightEl.className = "tm-ack-copyright";
    copyrightEl.textContent = copyright;

    link.append(nameEl, licenseEl, copyrightEl);
    const item = document.createElement("li");
    item.append(link);
    return item;
  });
  listEl.replaceChildren(...items);
}

/**
 * Handles every click the dialog cares about. Synchronous on purpose: the
 * page's click handler calls it before anything it awaits, so preventDefault
 * still stops an upstream link from navigating the settings tab.
 * Returns true when the click was handled.
 */
export function handleAcknowledgmentsClick(e, log) {
  const target = e.target;
  const dialog = document.getElementById(DIALOG_ID);
  if (!dialog) return false;

  if (target?.id === OPEN_ID) {
    renderAcknowledgments(document.getElementById(LIST_ID));
    dialog.showModal();
    return true;
  }

  // A click on the dialog element itself is a click on its backdrop.
  if (target?.id === CLOSE_ID || target === dialog) {
    dialog.close();
    return true;
  }

  const link = target?.closest?.("a[data-ack-url]");
  if (link && dialog.contains(link)) {
    e.preventDefault();
    // The user's own browser, like the page's other external links.
    browser.windows.openDefaultBrowser(link.dataset.ackUrl).catch((err) => {
      log(`[Config] Failed to open ${link.dataset.ackUrl}: ${err}`, "error");
    });
    return true;
  }

  return false;
}
