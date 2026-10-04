/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// attachment_read_pdf.js – returns the text of a PDF attachment, a page range per call.
//
// The PDF is downloaded with browser.messages.getAttachmentFile and parsed locally by the bundled
// pdf.js (chat/modules/pdfText.js). The text goes to the model for the current request only; it
// is never cached or stored (ADR-004).

import { log, resolveUniqueMessageKey } from "../../agent/modules/utils.js";
import { bundledCMapUrl, extractPdfText, hasPdfSignature, loadBundledPdfjs, PDF_TEXT_OUTCOME } from "../modules/pdfText.js";

const CONFIG = {
  MAX_FILE_BYTES: 25 * 1024 * 1024,
  MAX_PAGES_PER_CALL: 20,
  // Bounds the text handed to the model's context window per call; the reader continues
  // with next_start_page.
  MAX_OUTPUT_CHARS: 100000,
  PARSE_TIMEOUT_MS: 20000,
  // How far into the file the "%PDF-" header may sit (readers tolerate leading junk).
  SIGNATURE_SCAN_BYTES: 1024,
};

// pdfjs/cMapUrl are injectable for tests; production uses the bundled copy.
const defaultDeps = {
  loadPdfjs: loadBundledPdfjs,
  cMapUrl: () => bundledCMapUrl(),
};

export function isPdfAttachment(att) {
  const type = String(att?.contentType || "").toLowerCase().split(";")[0].trim();
  const name = String(att?.name || "").toLowerCase();
  return type === "application/pdf" || name.endsWith(".pdf");
}

const quoteNames = (atts) => atts.map((a) => `"${a.name}"`).join(", ");

// undefined/null → null (not given); otherwise a whole number >= 1, or NaN when invalid.
function parsePageArg(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isInteger(n) && n >= 1 ? n : NaN;
}

function formatMegabytes(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function chooseAttachment(attachments, requestedName) {
  const pdfs = attachments.filter(isPdfAttachment);
  if (requestedName) {
    const named = attachments.filter((a) => a?.name === requestedName);
    if (named.length === 0) {
      return {
        error: pdfs.length
          ? `no attachment named "${requestedName}"; PDF attachments on this email: ${quoteNames(pdfs)}`
          : `no attachment named "${requestedName}", and this email has no PDF attachments`,
      };
    }
    if (named.length > 1) {
      return { error: `this email has several attachments named "${requestedName}", so this tool cannot tell which one to read` };
    }
    if (!isPdfAttachment(named[0])) {
      return { error: `attachment "${requestedName}" is not a PDF` };
    }
    return { attachment: named[0] };
  }
  if (pdfs.length === 0) return { error: "this email has no PDF attachments" };
  if (pdfs.length > 1) {
    return { error: `this email has several PDF attachments; set attachment_name to one of: ${quoteNames(pdfs)}` };
  }
  return { attachment: pdfs[0] };
}

function formatResult(uniqueId, attachment, result) {
  const lines = [];
  lines.push(`unique_id: ${uniqueId}`);
  lines.push(`attachment: ${attachment.name}`);
  lines.push(`total_pages: ${result.totalPages}`);
  lines.push(`pages_read: ${result.firstPage === result.lastPage ? result.firstPage : `${result.firstPage}-${result.lastPage}`}`);
  if (result.nextStartPage !== null) lines.push(`next_start_page: ${result.nextStartPage}`);

  const notes = [];
  if (result.cutPage !== null) {
    const shown = result.pages[0].text.length;
    notes.push(`page ${result.cutPage} is longer than one call can return; only its first ${shown} of ${result.pages[0].cutFrom} characters are shown`);
  }
  if (result.stoppedAtOutputLimit) {
    notes.push(`stopped at the per-call text limit; continue with start_page ${result.nextStartPage}`);
  }
  if (result.pages.every((p) => !p.text && !p.unreadable)) {
    notes.push("none of these pages has any text; the PDF is probably scanned images, and text recognition is not available");
  }
  for (const note of notes) lines.push(`note: ${note}`);

  lines.push("text:");
  for (const p of result.pages) {
    lines.push(`[page ${p.page}]`);
    if (p.unreadable) lines.push("(this page could not be read)");
    else lines.push(p.text || "(no text on this page)");
  }
  return lines.join("\n");
}

export async function run(args = {}, options = {}, deps = defaultDeps) {
  try {
    const uniqueId = args?.unique_id;
    if (!uniqueId || typeof uniqueId !== "string") {
      log(`[TMDBG Tools] attachment_read_pdf: invalid or missing unique_id: ${uniqueId}`, "error");
      return { error: "invalid or missing unique_id" };
    }

    const startPage = parsePageArg(args?.start_page) ?? 1;
    const endPage = parsePageArg(args?.end_page);
    if (Number.isNaN(startPage)) return { error: "start_page must be a whole number of 1 or more" };
    if (Number.isNaN(endPage)) return { error: "end_page must be a whole number of 1 or more" };
    if (endPage !== null && endPage < startPage) return { error: "end_page must not be before start_page" };

    const requestedName = typeof args?.attachment_name === "string" ? args.attachment_name : "";

    const resolved = await resolveUniqueMessageKey(uniqueId);
    if (!resolved) {
      log(`[TMDBG Tools] attachment_read_pdf: unique_id did not have one live structured match: ${uniqueId}`, "error");
      return { error: "Invalid unique_id" };
    }
    const { weID } = resolved;

    let attachments;
    try {
      attachments = (await browser.messages.listAttachments(weID)) || [];
    } catch (e) {
      log(`[TMDBG Tools] attachment_read_pdf: listAttachments failed for ${weID}: ${e}`, "error");
      return { error: "could not list the email's attachments" };
    }

    const choice = chooseAttachment(attachments, requestedName);
    if (choice.error) return { error: choice.error };
    const attachment = choice.attachment;

    if (Number(attachment.size) > CONFIG.MAX_FILE_BYTES) {
      return { error: `the PDF is too large to read (${formatMegabytes(attachment.size)}; the limit is ${formatMegabytes(CONFIG.MAX_FILE_BYTES)})` };
    }

    let bytes;
    try {
      const file = await browser.messages.getAttachmentFile(weID, attachment.partName);
      bytes = new Uint8Array(await file.arrayBuffer());
    } catch (e) {
      log(`[TMDBG Tools] attachment_read_pdf: download failed for ${weID} part=${attachment.partName}: ${e}`, "error");
      return { error: "could not download the attachment" };
    }
    // The listed size is the server's figure; the bytes are the authority.
    if (bytes.length > CONFIG.MAX_FILE_BYTES) {
      return { error: `the PDF is too large to read (${formatMegabytes(bytes.length)}; the limit is ${formatMegabytes(CONFIG.MAX_FILE_BYTES)})` };
    }
    if (!hasPdfSignature(bytes, CONFIG.SIGNATURE_SCAN_BYTES)) {
      return { error: "the file is not a readable PDF (it is damaged or not really a PDF)" };
    }

    // pdf.js transfers the bytes to its worker, which empties `bytes`; take the size first.
    const byteCount = bytes.length;
    const pdfjs = await deps.loadPdfjs();
    const result = await extractPdfText(bytes, { startPage, endPage }, {
      pdfjs,
      cMapUrl: deps.cMapUrl(),
      limits: {
        maxPages: CONFIG.MAX_PAGES_PER_CALL,
        maxOutputChars: CONFIG.MAX_OUTPUT_CHARS,
        timeoutMs: CONFIG.PARSE_TIMEOUT_MS,
      },
    });
    log(`[TMDBG Tools] attachment_read_pdf: weID=${weID} part=${attachment.partName} bytes=${byteCount} outcome=${result.outcome}`);

    switch (result.outcome) {
      case PDF_TEXT_OUTCOME.OK:
        return formatResult(uniqueId, attachment, result);
      case PDF_TEXT_OUTCOME.ENCRYPTED:
        return { error: "the PDF is password-protected, so its text cannot be read" };
      case PDF_TEXT_OUTCOME.MALFORMED:
        return { error: "the file is not a readable PDF (it is damaged or not really a PDF)" };
      case PDF_TEXT_OUTCOME.TIMEOUT:
        return { error: "reading the PDF took too long and was stopped" };
      case PDF_TEXT_OUTCOME.PAST_END:
        return { error: `start_page ${startPage} is past the last page (the PDF has ${result.totalPages} pages)` };
      default:
        return { error: "the PDF could not be read" };
    }
  } catch (e) {
    log(`[TMDBG Tools] attachment_read_pdf failed: ${e}`, "error");
    return { error: String(e || "unknown error in attachment_read_pdf") };
  }
}

export const _testing = { CONFIG };
