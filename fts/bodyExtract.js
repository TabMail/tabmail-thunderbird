// fts/bodyExtract.js
// Conservative extractor: prefer text/plain; fallback to stripped HTML; ignore attachments.

import { log, stripHtml } from "../agent/modules/utils.js";

export async function extractPlainText(full, messageId) {
  try {
    const pieces = [];
    walk(full, (part) => {
      const ct = (part.contentType || "").toLowerCase();
      if (ct.startsWith("text/plain") && typeof part.body === "string") {
        pieces.push(part.body);
      }
    });
    if (pieces.length > 0) return pieces.join("\n");

    // Fallback: text/html -> convert to plain text using DOMParser
    const htmls = [];
    walk(full, (part) => {
      const ct = (part.contentType || "").toLowerCase();
      if (ct.startsWith("text/html") && typeof part.body === "string") {
        htmls.push(part.body);
      }
    });
    if (htmls.length) return stripHtml(htmls.join("\n"));

    return "";
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
