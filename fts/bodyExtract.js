/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// fts/bodyExtract.js
// Extractor: prefer stripped text/html (the authoritative rendered content; mirrors
// iOS EmailFilter.extractPlainText); fall back to text/plain with an HTML-document
// guard. Ignore attachments.

import { log, stripHtml } from "../agent/modules/utils.js";

// A body that *starts* with an HTML document marker is mislabeled HTML — some
// senders put the full HTML document into the text/plain MIME part. A document
// marker at position zero is never legitimate prose, so this cannot match normal
// plain text that merely contains angle brackets (addresses, code, "a < b").
function looksLikeHtmlDocument(text) {
  return /^\s*(<!doctype\b|<html[\s>])/i.test(text || "");
}

export async function extractPlainText(full, messageId) {
  try {
    // Prefer text/html: it is what the user actually sees rendered. The
    // text/plain alternative is sender-supplied and can be garbage (raw HTML,
    // whitespace-only, or a 1-char stub alongside a full HTML part).
    const htmls = [];
    walk(full, (part) => {
      const ct = (part.contentType || "").toLowerCase();
      if (ct.startsWith("text/html") && typeof part.body === "string") {
        htmls.push(part.body);
      }
    });
    if (htmls.length) {
      const text = stripHtml(htmls.join("\n"));
      if (text.trim()) return text;
    }

    // Fallback: text/plain. Also covers safeGetFull's FTS-synthetic results
    // (a single text/plain node with parts: []). Guarded: don't trust the
    // declared content type — strip if the body is actually an HTML document.
    const pieces = [];
    walk(full, (part) => {
      const ct = (part.contentType || "").toLowerCase();
      if (ct.startsWith("text/plain") && typeof part.body === "string") {
        pieces.push(part.body);
      }
    });
    const plain = pieces.join("\n");
    if (looksLikeHtmlDocument(plain)) return stripHtml(plain);
    return plain;
  } catch (e) {
    log(`[TMDBG FTS] Failed to extract text from message ${messageId}: ${e}`, "warn");
    return "";
  }
}

function walk(node, cb) {
  if (!node) return;
  if (node.parts && node.parts.length) {
    for (const p of node.parts) walk(p, cb);
  } else {
    cb(node);
  }
}

// stripHtml is now imported from utils.js - it uses DOMParser for proper HTML
// parsing, handles block elements intelligently, and handles entities properly.
