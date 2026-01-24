// web_read.js – fetch and extract content from a web URL (TB 141+, MV3)

import { log } from "../../agent/modules/utils.js";

const CONFIG = {
  TIMEOUT_MS: 30000,
  MAX_CONTENT_LENGTH: 500000, // 500KB max
  USER_AGENT: "TabMail/1.0 (Thunderbird Extension; +https://tabmail.app)",
};

/**
 * Parse robots.txt and check if the URL path is allowed
 * @param {string} robotsTxt - The robots.txt content
 * @param {string} path - The URL path to check
 * @param {string} userAgent - The user agent string
 * @returns {boolean} - true if allowed, false if disallowed
 */
function isPathAllowedByRobots(robotsTxt, path, userAgent = "*") {
  try {
    const lines = robotsTxt.split("\n");
    let currentAgent = null;
    let disallowRules = [];
    let allowRules = [];
    
    // Parse robots.txt
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      
      const lowerLine = trimmed.toLowerCase();
      if (lowerLine.startsWith("user-agent:")) {
        const agent = trimmed.substring(11).trim();
        currentAgent = agent;
        // Reset rules when we hit a new user-agent section
        if (agent !== "*" && agent !== userAgent) {
          disallowRules = [];
          allowRules = [];
        }
      } else if (currentAgent === "*" || currentAgent === userAgent) {
        if (lowerLine.startsWith("disallow:")) {
          const rule = trimmed.substring(9).trim();
          if (rule) disallowRules.push(rule);
        } else if (lowerLine.startsWith("allow:")) {
          const rule = trimmed.substring(6).trim();
          if (rule) allowRules.push(rule);
        }
      }
    }
    
    // Check rules: allow rules take precedence over disallow rules
    for (const allowRule of allowRules) {
      if (path.startsWith(allowRule)) {
        log(`[TMDBG Tools] web_read: Path '${path}' explicitly allowed by robots.txt`);
        return true;
      }
    }
    
    for (const disallowRule of disallowRules) {
      if (path.startsWith(disallowRule)) {
        log(`[TMDBG Tools] web_read: Path '${path}' disallowed by robots.txt`);
        return false;
      }
    }
    
    log(`[TMDBG Tools] web_read: Path '${path}' allowed (no matching rules)`);
    return true;
  } catch (e) {
    log(`[TMDBG Tools] web_read: Error parsing robots.txt: ${e}`, "warn");
    // On parse error, be conservative and allow
    return true;
  }
}

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
 * Check robots.txt for the given URL
 * @param {string} url - The full URL to check
 * @returns {Promise<boolean>} - true if allowed, false if disallowed
 */
async function checkRobotsTxt(url) {
  try {
    const urlObj = new URL(url);
    const robotsUrl = `${urlObj.protocol}//${urlObj.host}/robots.txt`;
    
    log(`[TMDBG Tools] web_read: Checking robots.txt at ${robotsUrl}`);
    
    const response = await fetchWithPrivileged(robotsUrl, 5000);
    
    if (response.status !== 200) {
      // If robots.txt doesn't exist (404) or errors, assume allowed
      log(`[TMDBG Tools] web_read: robots.txt returned ${response.status}, assuming allowed`);
      return true;
    }
    
    return isPathAllowedByRobots(response.responseText, urlObj.pathname, CONFIG.USER_AGENT);
  } catch (e) {
    // On any error (timeout, network, etc.), be conservative and allow
    log(`[TMDBG Tools] web_read: Error checking robots.txt: ${e}, assuming allowed`, "warn");
    return true;
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
    
    // Check robots.txt
    const robotsAllowed = await checkRobotsTxt(url);
    if (!robotsAllowed) {
      log(`[TMDBG Tools] web_read: Access disallowed by robots.txt`, "error");
      return { error: "Access to this URL is disallowed by the site's robots.txt" };
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

