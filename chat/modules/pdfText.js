/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// pdfText.js – bounded, text-only PDF extraction for the attachment_read_pdf tool.
//
// Uses the bundled pdf.js (chat/libs/pdfjs, see THIRD_PARTY_LICENSES.md). pdf.js parses in its
// own Web Worker, so a heavy PDF cannot block the page running the chat. Only the text layer is
// read: no rendering, no fonts, no forms or XFA, and no scripting (that lives in pdf.js's viewer
// sandbox, which is not bundled). pdf.js 6 has no eval path, and the add-on CSP forbids eval.

import { log } from "../../agent/modules/utils.js";

export const PDF_TEXT_OUTCOME = Object.freeze({
  OK: "ok",
  ENCRYPTED: "encrypted",
  MALFORMED: "malformed",
  TIMEOUT: "timeout",
  PAST_END: "past_end",
  FAILED: "failed",
});

const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

/**
 * True when the "%PDF-" header occurs within the first `scanBytes` bytes. The PDF specification
 * lets readers accept leading junk before the header, so the check is a window, not offset 0.
 */
export function hasPdfSignature(bytes, scanBytes) {
  const limit = Math.min(bytes.length, scanBytes) - PDF_SIGNATURE.length;
  for (let i = 0; i <= limit; i++) {
    let match = true;
    for (let j = 0; j < PDF_SIGNATURE.length; j++) {
      if (bytes[i + j] !== PDF_SIGNATURE[j]) { match = false; break; }
    }
    if (match) return true;
  }
  return false;
}

let pdfjsPromise = null;

/** Lazily loads the bundled pdf.js, pointing it at the bundled worker. */
export function loadBundledPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("../libs/pdfjs/pdf.min.mjs")
      .then((lib) => {
        lib.GlobalWorkerOptions.workerSrc = browser.runtime.getURL("chat/libs/pdfjs/pdf.worker.min.mjs");
        return lib;
      })
      .catch((e) => {
        pdfjsPromise = null;
        throw e;
      });
  }
  return pdfjsPromise;
}

export function bundledCMapUrl() {
  return browser.runtime.getURL("chat/libs/pdfjs/cmaps/");
}

function pageTextFromContent(textContent) {
  let text = "";
  for (const item of textContent?.items || []) {
    // Marked-content markers carry no `str`.
    if (typeof item?.str !== "string") continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text.replace(/[ \t]+\n/g, "\n").trim();
}

// Cut `text` to `max` UTF-16 units without splitting a surrogate pair.
function cutToLength(text, max) {
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/**
 * Extracts the text of pages [startPage, endPage] (1-based, inclusive).
 *
 * `endPage` null means "as far as the page cap allows". The range is clamped to the document
 * and to `limits.maxPages`. Text is accumulated until `limits.maxOutputChars`: a page that
 * would overflow it is left for the next call (`nextStartPage`), except when it is the FIRST
 * page of the call, which is cut at the limit so every call makes progress. This cap bounds
 * what is handed to the model's context window; nothing is stored either way.
 *
 * The whole call shares one deadline, `limits.timeoutMs`. Each call gets its own pdf.js worker,
 * which is terminated outright at the deadline: `loadingTask.destroy()` waits for the worker to
 * acknowledge, and a worker busy in one long step (a small stream that inflates to a huge one)
 * answers only when that step ends.
 *
 * @param {Uint8Array} data  PDF bytes. pdf.js transfers the buffer to its worker.
 * @param {{ startPage: number, endPage: number|null }} range
 * @param {{ pdfjs: object, cMapUrl: string, limits: { maxPages: number, maxOutputChars: number, timeoutMs: number } }} deps
 */
export async function extractPdfText(data, range, { pdfjs, cMapUrl, limits }) {
  const worker = new pdfjs.PDFWorker();
  const loadingTask = pdfjs.getDocument({
    data,
    worker,
    cMapUrl,
    cMapPacked: true,
    disableFontFace: true,
    useSystemFonts: false,
    enableXfa: false,
    isOffscreenCanvasSupported: false,
    stopAtErrors: false,
    verbosity: 0,
  });

  let timer = null;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ outcome: PDF_TEXT_OUTCOME.TIMEOUT }), limits.timeoutMs);
  });
  // Once the deadline wins, `work` is abandoned: it may reject when the task is destroyed, or stay
  // pending forever after the worker is terminated. Nothing awaits it, and the catch keeps a
  // rejection from surfacing as unhandled.
  const work = readPages(loadingTask, range, limits).catch(classifyError);

  const result = await Promise.race([work, deadline]);
  clearTimeout(timer);
  if (result.outcome === PDF_TEXT_OUTCOME.TIMEOUT) {
    worker.destroy();
    loadingTask.destroy().catch(() => {});
    return result;
  }
  try {
    await loadingTask.destroy();
  } catch (e) {
    log(`[pdfText] destroy failed: ${e}`, "warn");
  }
  worker.destroy();
  return result;
}

function classifyError(e) {
  const name = e?.name || "";
  if (name === "PasswordException") return { outcome: PDF_TEXT_OUTCOME.ENCRYPTED };
  if (name === "InvalidPDFException") return { outcome: PDF_TEXT_OUTCOME.MALFORMED };
  log(`[pdfText] PDF could not be read: ${name} ${e?.message || e}`, "warn");
  return { outcome: PDF_TEXT_OUTCOME.FAILED };
}

async function readPages(loadingTask, range, limits) {
  const doc = await loadingTask.promise;
  const totalPages = doc.numPages;
  if (!Number.isInteger(totalPages) || totalPages < 1) {
    return { outcome: PDF_TEXT_OUTCOME.MALFORMED };
  }
  if (range.startPage > totalPages) {
    return { outcome: PDF_TEXT_OUTCOME.PAST_END, totalPages };
  }

  const firstPage = range.startPage;
  const capPage = firstPage + limits.maxPages - 1;
  const lastRequested = Math.min(range.endPage ?? capPage, capPage, totalPages);

  const pages = [];
  let usedChars = 0;
  let cutPage = null;
  let stoppedAt = null;

  for (let pageNumber = firstPage; pageNumber <= lastRequested; pageNumber++) {
    let text = "";
    let unreadable = false;
    try {
      const page = await doc.getPage(pageNumber);
      text = pageTextFromContent(await page.getTextContent());
      page.cleanup();
    } catch (e) {
      // A damaged page does not make the rest of the document unreadable.
      if (e?.name === "PasswordException") throw e;
      log(`[pdfText] page ${pageNumber} could not be read: ${e?.name || ""} ${e?.message || e}`, "warn");
      unreadable = true;
    }

    if (usedChars + text.length > limits.maxOutputChars) {
      if (pages.length === 0) {
        pages.push({ page: pageNumber, text: cutToLength(text, limits.maxOutputChars), unreadable, cutFrom: text.length });
        cutPage = pageNumber;
      } else {
        stoppedAt = pageNumber;
      }
      break;
    }
    pages.push({ page: pageNumber, text, unreadable });
    usedChars += text.length;
  }

  const lastPage = pages[pages.length - 1].page;
  let nextStartPage = null;
  if (stoppedAt !== null) nextStartPage = stoppedAt;
  else if (lastPage < totalPages) nextStartPage = lastPage + 1;

  return {
    outcome: PDF_TEXT_OUTCOME.OK,
    totalPages,
    firstPage,
    lastPage,
    pages,
    cutPage,
    stoppedAtOutputLimit: stoppedAt !== null,
    nextStartPage,
  };
}
