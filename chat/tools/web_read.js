/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// web_read.js – fetch and extract content from a web URL (TB 141+, MV3)
//
// A page is read because the user asked for it, as a browser opens one, so robots.txt (written for
// crawlers, RFC 9309) is not consulted. tmWebFetch names TabMail in the User-Agent, so a site can
// still tell it apart.

import { log } from "../../agent/modules/utils.js";

const CONFIG = {
  TIMEOUT_MS: 30000,
  MAX_CONTENT_LENGTH: 500000, // 500KB max
};

/**
 * Fetch URL using privileged experimental API (bypasses CORS)
 * @param {string} url - The URL to fetch
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{status: number, statusText: string, responseText: string, contentType: string}>}
 */
async function fetchWithPrivileged(url, timeout) {
  try {
    log(`[TMDBG Tools] web_read: Using tmWebFetch.fetch() for ${url}`);
    const response = await browser.tmWebFetch.fetch(url, { timeout });
    log(`[TMDBG Tools] web_read: tmWebFetch.fetch() returned status ${response.status}`);
    return response;
  } catch (e) {
    log(`[TMDBG Tools] web_read: tmWebFetch.fetch() failed: ${e}`, "error");
    throw e;
  }
}

/**
 * Strip HTML tags and extract readable text content
 * @param {string} html - The HTML content
 * @returns {string} - Plain text content
 */
function extractTextFromHTML(html) {
  try {
    // Create a temporary DOM element to parse HTML
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/html");
    
    // Remove script, style, and other non-content elements
    const elementsToRemove = doc.querySelectorAll("script, style, nav, footer, header, aside, iframe, noscript");
    elementsToRemove.forEach(el => el.remove());
    
    // Get text content
    let text = doc.body.textContent || "";
    
    // Clean up whitespace
    text = text.replace(/\n\s*\n\s*\n/g, "\n\n"); // Collapse multiple newlines
    text = text.replace(/[ \t]+/g, " "); // Collapse multiple spaces
    text = text.trim();
    
    return text;
  } catch (e) {
    log(`[TMDBG Tools] web_read: Error parsing HTML: ${e}`, "warn");
    // Fallback: simple regex-based tag stripping
    return html
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
      .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }
}

/**
 * Fetch and read content from a URL
 * @param {object} args - Tool arguments
 * @param {string} args.url - The URL to read
 * @returns {Promise<string|object>} - Content string or error object
 */
export async function run(args = {}, options = {}) {
  try {
    const url = args?.url;
    
    log(`[TMDBG Tools] web_read: Starting with url='${url}'`);
    
    // Validate URL
    if (!url || typeof url !== "string") {
      log(`[TMDBG Tools] web_read: invalid or missing url`, "error");
      return { error: "invalid or missing url" };
    }
    
    let urlObj;
    try {
      urlObj = new URL(url);
      if (urlObj.protocol !== "http:" && urlObj.protocol !== "https:") {
        log(`[TMDBG Tools] web_read: invalid protocol '${urlObj.protocol}'`, "error");
        return { error: "Only http:// and https:// URLs are supported" };
      }
    } catch (e) {
      log(`[TMDBG Tools] web_read: invalid URL format: ${e}`, "error");
      return { error: "Invalid URL format" };
    }
    
    // Fetch the content
    log(`[TMDBG Tools] web_read: Fetching content from ${url}`);
    
    let response;
    try {
      response = await fetchWithPrivileged(url, CONFIG.TIMEOUT_MS);
    } catch (e) {
      log(`[TMDBG Tools] web_read: Fetch failed: ${e}`, "error");
      return { error: `Failed to fetch URL: ${e.message || String(e)}` };
    }

    // tmWebFetch resolves (not rejects) network errors to preserve details
    if (response.error) {
      log(`[TMDBG Tools] web_read: Network error: ${response.errorMessage}`, "error");
      return { error: `Failed to fetch URL: ${response.errorMessage}` };
    }

    if (response.status !== 200) {
      log(`[TMDBG Tools] web_read: HTTP error ${response.status} ${response.statusText}`, "error");
      return { error: `HTTP error: ${response.status} ${response.statusText}` };
    }
    
    // Get content
    let content = response.responseText;
    
    // Check content length
    if (content.length > CONFIG.MAX_CONTENT_LENGTH) {
      log(`[TMDBG Tools] web_read: Content too large (${content.length} bytes), truncating`, "warn");
      content = content.substring(0, CONFIG.MAX_CONTENT_LENGTH);
    }
    
    // Get content type
    const contentType = response.contentType;
    log(`[TMDBG Tools] web_read: Content-Type: ${contentType}`);
    
    // Extract text if HTML
    let text = content;
    if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
      log(`[TMDBG Tools] web_read: Extracting text from HTML`);
      text = extractTextFromHTML(content);
    }
    
    log(`[TMDBG Tools] web_read: Successfully fetched content (${text.length} chars)`);
    
    // Format response
    const lines = [];
    lines.push(`URL: ${url}`);
    lines.push(`Content-Type: ${contentType}`);
    lines.push(`Content-Length: ${text.length} characters`);
    lines.push("");
    lines.push("Content:");
    lines.push(text);
    
    return lines.join("\n");
  } catch (e) {
    log(`[TMDBG Tools] web_read failed: ${e}`, "error");
    return { error: String(e || "unknown error in web_read") };
  }
}

