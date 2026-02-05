import { SETTINGS } from "./config.js";
import "./quoteAndSignature.js";
import { getAndClearThink } from "./thinkBuffer.js";

// Lazy-loaded FTS search reference for direct API access (avoids runtime.sendMessage issues)
let _ftsSearchRef = null;
let _ftsSearchLoadAttempted = false;

/**
 * Get the FTS search API directly (for use in background script context).
 * Returns null if FTS is not available or not yet initialized.
 */
async function _getFtsSearch() {
  if (_ftsSearchRef) return _ftsSearchRef;
  if (_ftsSearchLoadAttempted) return null;
  _ftsSearchLoadAttempted = true;
  try {
    const { ftsSearch } = await import("../../fts/engine.js");
    if (ftsSearch) {
      _ftsSearchRef = ftsSearch;
      return ftsSearch;
    }
  } catch (e) {
    // FTS engine not available - this is expected if FTS is disabled or not initialized
    console.log(`[TMDBG GetFull] FTS engine import failed (expected if FTS disabled): ${e}`);
  }
  return null;
}

let activeGetFullCount = 0;
const MAX_CONCURRENT_GETFULL = 1;

// safeGetFull strategy config (avoid scattering magic numbers in logic)
const SAFE_GETFULL_CONFIG = {
  logPrefix: "[TMDBG GetFull]",
  // When native FTS has the message, we can often avoid a heavy messages.getFull().
  // This synthetic shape is "full-like" enough for our body extraction paths.
  ftsSynthetic: {
    contentType: "text/plain",
  },
  diag: {
    ftsMissLogMax: SETTINGS.getFullDiag?.ftsMissLogMax,
    ftsMissLogMinIntervalMs: SETTINGS.getFullDiag?.ftsMissLogMinIntervalMs,
    ftsEmptyLogMax: SETTINGS.getFullDiag?.ftsEmptyLogMax,
    ftsEmptyLogMinIntervalMs: SETTINGS.getFullDiag?.ftsEmptyLogMinIntervalMs,
    ftsHitLogMax: SETTINGS.getFullDiag?.ftsHitLogMax,
    ftsHitLogMinIntervalMs: SETTINGS.getFullDiag?.ftsHitLogMinIntervalMs,
    ftsStatsLogMax: SETTINGS.getFullDiag?.ftsStatsLogMax,
    ftsStatsLogMinIntervalMs: SETTINGS.getFullDiag?.ftsStatsLogMinIntervalMs,
    ftsNoResponseLogMax: SETTINGS.getFullDiag?.ftsNoResponseLogMax,
    ftsNoResponseLogMinIntervalMs: SETTINGS.getFullDiag?.ftsNoResponseLogMinIntervalMs,
  },
};

const SAFE_GETFULL_DIAG_STATE = {
  ftsMissLogs: 0,
  ftsMissLastMs: 0,
  ftsEmptyLogs: 0,
  ftsEmptyLastMs: 0,
  ftsHitLogs: 0,
  ftsHitLastMs: 0,
  ftsStatsLogs: 0,
  ftsStatsLastMs: 0,
  ftsNoResponseLogs: 0,
  ftsNoResponseLastMs: 0,
};

// ----------------------------------------------------------
// Request ID generation for SSE tool orchestration
// ----------------------------------------------------------

/**
 * Generates a unique collision-resistant request ID using:
 * - High-resolution timestamp
 * - Random component
 * - Simple hash of local network info (if available)
 * 
 * Format: req_<timestamp>_<random>_<hash>
 * Example: req_1730000000000_a3f2b1_7c4e
 * 
 * @returns {string} Unique request ID
 */
export async function generateRequestId() {
  try {
    // High-resolution timestamp (milliseconds)
    const timestamp = Date.now();
    
    // Random component (6 hex chars = 24 bits)
    const random = Math.floor(Math.random() * 0xFFFFFF).toString(16).padStart(6, '0');
    
    // Simple hash component based on available local info
    let hashComponent = '0000';
    try {
      // Try to get some local identifying information for collision resistance
      // Use combination of user agent, screen dimensions, and timezone offset
      const localInfo = [
        navigator.userAgent,
        screen.width,
        screen.height,
        new Date().getTimezoneOffset(),
        navigator.hardwareConcurrency || 0,
        navigator.language,
      ].join('|');
      
      // Simple hash (FNV-1a style)
      let hash = 2166136261;
      for (let i = 0; i < localInfo.length; i++) {
        hash ^= localInfo.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      hashComponent = (Math.abs(hash) % 0xFFFF).toString(16).padStart(4, '0');
    } catch (e) {
      // Fallback to another random component if local info fails
      hashComponent = Math.floor(Math.random() * 0xFFFF).toString(16).padStart(4, '0');
    }
    
    return `req_${timestamp}_${random}_${hashComponent}`;
  } catch (e) {
    // Ultimate fallback: UUID-style random ID
    log(`[RequestID] Failed to generate structured ID: ${e}, using fallback`, 'warn');
    return `req_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
  }
}

// ----------------------------------------------------------
// Reusable alarm helpers for MV3 suspension-safe scheduling
// ----------------------------------------------------------
const _alarmNameToListener = new Map(); // Map<string, Function>

/**
 * Ensures a browser alarm exists with the given name and schedule, and that
 * the provided onAlarm handler is registered exactly once. Any previous alarm
 * with the same name is cleared before re-creation. Duplicate listeners are
 * avoided across hot reloads.
 *
 * @param {Object} params
 * @param {string} params.name - Unique alarm name.
 * @param {number} params.periodMinutes - Recurrence interval in minutes (>=1).
 * @param {number|null} [params.delayMinutes=null] - First-fire delay in minutes; defaults to periodMinutes when null.
 * @param {Function} params.onAlarm - Callback invoked when this named alarm fires.
 */
export async function ensureAlarm({ name, periodMinutes, delayMinutes = null, onAlarm }) {
  try {
    const p = Math.max(1, Math.ceil(Number(periodMinutes || 1)));
    const d = delayMinutes == null ? p : Math.max(0, Math.ceil(Number(delayMinutes)));

    // Replace or attach listener exactly once per name
    const prev = _alarmNameToListener.get(name);
    if (prev && prev !== onAlarm) {
      try { browser.alarms.onAlarm.removeListener(prev); } catch (_) {}
      _alarmNameToListener.delete(name);
    }
    if (!_alarmNameToListener.has(name)) {
      const wrapped = (alarm) => {
        if (alarm && alarm.name === name) {
          try { log(`[Alarms] Alarm fired: ${name} @ ${new Date().toISOString()}`); } catch (_) {}
          try { onAlarm(); } catch (e) { try { log(`[Alarms] Handler error for ${name}: ${e}`, 'error'); } catch (_) {} }
        }
      };
      browser.alarms.onAlarm.addListener(wrapped);
      _alarmNameToListener.set(name, wrapped);
    }

    // Clear and recreate the alarm schedule
    await browser.alarms.clear(name);
    await browser.alarms.create(name, { delayInMinutes: d, periodInMinutes: p });
    try { log(`[Alarms] Scheduled '${name}' every ${p} minute(s) (delay ${d}m)`); } catch (_) {}
  } catch (e) {
    try { log(`[Alarms] ensureAlarm failed for '${name}': ${e}`, 'error'); } catch (_) {}
    throw e;
  }
}

/**
 * Clears an alarm and detaches its registered listener, if any.
 * @param {string} name - Alarm name to clear and detach.
 */
export async function clearAlarm(name) {
  try {
    await browser.alarms.clear(name);
    const prev = _alarmNameToListener.get(name);
    if (prev) {
      try { browser.alarms.onAlarm.removeListener(prev); } catch (_) {}
      _alarmNameToListener.delete(name);
    }
    try { log(`[Alarms] Cleared alarm '${name}' and detached listener`); } catch (_) {}
  } catch (e) {
    try { log(`[Alarms] Failed to clear alarm '${name}': ${e}`, 'error'); } catch (_) {}
  }
}

// getFull cache – in-memory storage with TTL based on uniqueHeaderID
const getFullCache = new Map(); // Map<uniqueKey, { data, timestamp }>
let getFullCacheCleanupTimer = null;
let getFullCacheCleanupAlarmName = "agent-getfull-cleanup";

function enforceGetFullCacheMaxEntries(reason = "unknown") {
  try {
    const maxEntries = Number(SETTINGS.getFullMaxCacheEntries);
    if (!Number.isFinite(maxEntries) || maxEntries <= 0) return;
    if (getFullCache.size <= maxEntries) return;

    // Evict least-recently-used entries by timestamp.
    const entries = [];
    for (const [k, v] of getFullCache.entries()) {
      entries.push([k, Number(v?.timestamp) || 0]);
    }
    entries.sort((a, b) => a[1] - b[1]); // oldest first

    const toRemove = getFullCache.size - maxEntries;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      getFullCache.delete(entries[i][0]);
    }
    log(`getFull cache maxEntries enforced (${reason}): removed ${Math.min(toRemove, entries.length)} entries, size=${getFullCache.size}`);
  } catch (e) {
    log(`getFull cache maxEntries enforcement failed: ${e}`, "warn");
  }
}

/**
 * Cleans up expired entries from the getFull cache.
 * Called periodically to prevent memory leaks.
 */
function cleanupGetFullCache() {
  const now = Date.now();
  const ttlMs = SETTINGS.getFullTTLSeconds * 1000;
  let removedCount = 0;

  for (const [key, entry] of getFullCache.entries()) {
    if (now - entry.timestamp > ttlMs) {
      getFullCache.delete(key);
      removedCount++;
    }
  }

  if (removedCount > 0) {
    log(`getFull cache cleanup: removed ${removedCount} expired entries, ${getFullCache.size} remaining`);
  }

  // Also enforce an absolute max size to prevent memory explosion even within TTL.
  enforceGetFullCacheMaxEntries("cleanup");
}

/**
 * Starts the periodic cleanup timer for the getFull cache.
 * Safe to call multiple times.
 */
function startGetFullCacheCleanup() {
  // Clear any leftover old interval timer (for hot-reload safety)
  try { clearInterval(getFullCacheCleanupTimer); } catch (_) {}
  getFullCacheCleanupTimer = null;

  const minutes = Math.max(1, Math.ceil(Number(SETTINGS.getFullCleanupIntervalMinutes || 5)));
  ensureAlarm({
    name: getFullCacheCleanupAlarmName,
    periodMinutes: minutes,
    delayMinutes: minutes,
    onAlarm: () => {
      try { cleanupGetFullCache(); } catch (e) { log(`[Alarms] getFull cleanup exception: ${e}`, 'error'); }
    },
  }).catch((e) => {
    log(`[Alarms] getFull cleanup ensureAlarm failed: ${e}`, 'error');
  });
}

/**
 * Stops the periodic cleanup timer for the getFull cache.
 * Called during extension shutdown/suspension.
 */
export function stopGetFullCacheCleanup() {
  if (getFullCacheCleanupTimer) {
    clearInterval(getFullCacheCleanupTimer);
    getFullCacheCleanupTimer = null;
    log("getFull cache cleanup timer stopped");
  }
  try { clearAlarm(getFullCacheCleanupAlarmName); } catch (_) {}
}

/**
 * Clears all entries from the getFull cache.
 * Useful for debugging or manual cache invalidation.
 */
export function clearGetFullCache() {
  const size = getFullCache.size;
  getFullCache.clear();
  if (size > 0) {
    log(`getFull cache cleared: removed ${size} entries`);
  }
}

export async function safeGetFull(id) {
  // Start cleanup timer on first cache usage
  startGetFullCacheCleanup();

  // Fetch header once so we can:
  // - Derive the unique cache key without double-fetching
  // - Use headerMessageId to query native FTS before doing expensive getFull
  let header = null;
  try {
    header = await browser.messages.get(id);
  } catch (eHeader) {
    log(`${SAFE_GETFULL_CONFIG.logPrefix} Failed to fetch header for ${id}: ${eHeader}`, "warn");
  }

  // Get unique key for cache lookup
  const uniqueKey = header ? await getUniqueMessageKey(header) : await getUniqueMessageKey(id);
  if (!uniqueKey) {
    log(`Unable to generate unique key for message ${id}, skipping cache`, "warn");
    // Fallback to non-cached version
    while (activeGetFullCount >= MAX_CONCURRENT_GETFULL) {
      await new Promise(r => setTimeout(r, 50));
    }
    activeGetFullCount++;
    try {
      log(`getFull cache miss for ${uniqueKey}, fetching fresh data`, "warn");
      return await browser.messages.getFull(id);
    } finally {
      activeGetFullCount--;
    }
  }

  // Check cache first
  const cachedEntry = getFullCache.get(uniqueKey);
  if (cachedEntry) {
    // Cache hit - always use it and refresh the timestamp
    // Expiration only happens during periodic cleanup, not on access
    cachedEntry.timestamp = Date.now();
    log(`getFull cache hit for ${uniqueKey}, TTL refreshed`);
    return cachedEntry.data;
  }

  // Cache miss: try native FTS lookup by unique key before getFull.
  // This helps for IMAP folders like [Gmail]/All Mail where preview generation can be empty.
  try {
    // Use the canonical unique key (accountId:folderPath:headerMessageId) when available.
    // FTS indexes by this unique id (even though the RPC name says "msgId").
    const headerMessageIdRaw = header?.headerMessageId || "";
    const msgId = String(headerMessageIdRaw || "").replace(/[<>]/g, "");
    const ftsKey = uniqueKey || msgId;
    if (ftsKey) {
      // Use direct FTS API call instead of runtime.sendMessage
      // (runtime.sendMessage doesn't work within the same background script context)
      const ftsSearchApi = await _getFtsSearch();
      const ftsRes = ftsSearchApi ? await ftsSearchApi.getMessageByMsgId(ftsKey) : null;
      const body = ftsRes?.body || "";
      if (typeof ftsRes === "undefined") {
        try {
          const now = Date.now();
          const maxLogs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsNoResponseLogMax) || 0;
          const minIntervalMs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsNoResponseLogMinIntervalMs) || 0;
          if (
            SAFE_GETFULL_DIAG_STATE.ftsNoResponseLogs < maxLogs &&
            (now - SAFE_GETFULL_DIAG_STATE.ftsNoResponseLastMs) >= minIntervalMs
          ) {
            SAFE_GETFULL_DIAG_STATE.ftsNoResponseLogs += 1;
            SAFE_GETFULL_DIAG_STATE.ftsNoResponseLastMs = now;
            const details = {
              uniqueKey,
              ftsKey,
              weId: id,
              headerMessageId: header?.headerMessageId || "",
              accountId: header?.folder?.accountId || "",
              folderPath: header?.folder?.path || "",
            };
            log(
              `[TMDBG SnippetDiag][BG] ${SAFE_GETFULL_CONFIG.logPrefix} native FTS no response ${JSON.stringify(details)}`,
              "warn"
            );
          }
        } catch (_) {}
      }
      if (typeof body === "string" && body.trim()) {
        const syntheticFull = {
          // Markers for debugging
          __tmSynthetic: true,
          __tmSource: "nativeFts",
          // Minimal "full-like" shape used by our extractors.
          contentType: SAFE_GETFULL_CONFIG.ftsSynthetic.contentType,
          body,
          // Best-effort headers for downstream logic (unsubscribe detection may still rely on body heuristics).
          headers: {
            ...(header?.subject ? { subject: [String(header.subject)] } : {}),
            ...(header?.author ? { from: [String(header.author)] } : {}),
            ...(header?.recipients ? { to: [String(header.recipients)] } : {}),
            ...(header?.ccList ? { cc: [String(header.ccList)] } : {}),
            ...(msgId ? { "message-id": [`<${msgId}>`] } : {}),
          },
          parts: [],
        };

        getFullCache.set(uniqueKey, { data: syntheticFull, timestamp: Date.now() });
        enforceGetFullCacheMaxEntries("ftsHit");
        log(`${SAFE_GETFULL_CONFIG.logPrefix} native FTS hit for ${uniqueKey} (cached synthetic full)`);
        try {
          const now = Date.now();
          const maxLogs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsHitLogMax) || 0;
          const minIntervalMs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsHitLogMinIntervalMs) || 0;
          if (
            SAFE_GETFULL_DIAG_STATE.ftsHitLogs < maxLogs &&
            (now - SAFE_GETFULL_DIAG_STATE.ftsHitLastMs) >= minIntervalMs
          ) {
            SAFE_GETFULL_DIAG_STATE.ftsHitLogs += 1;
            SAFE_GETFULL_DIAG_STATE.ftsHitLastMs = now;
            const details = {
              uniqueKey,
              ftsKey,
              weId: id,
              headerMessageId: header?.headerMessageId || "",
              accountId: header?.folder?.accountId || "",
              folderPath: header?.folder?.path || "",
              bodyLen: typeof body === "string" ? body.length : 0,
            };
            log(
              `[TMDBG SnippetDiag][BG] ${SAFE_GETFULL_CONFIG.logPrefix} native FTS hit ${JSON.stringify(details)}`
            );
          }
        } catch (_) {}
        return syntheticFull;
      }
      if (ftsRes && typeof ftsRes === "object") {
        try {
          const now = Date.now();
          const maxLogs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsEmptyLogMax) || 0;
          const minIntervalMs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsEmptyLogMinIntervalMs) || 0;
          if (
            SAFE_GETFULL_DIAG_STATE.ftsEmptyLogs < maxLogs &&
            (now - SAFE_GETFULL_DIAG_STATE.ftsEmptyLastMs) >= minIntervalMs
          ) {
            SAFE_GETFULL_DIAG_STATE.ftsEmptyLogs += 1;
            SAFE_GETFULL_DIAG_STATE.ftsEmptyLastMs = now;
            const details = {
              uniqueKey,
              ftsKey,
              weId: id,
              headerMessageId: header?.headerMessageId || "",
              accountId: header?.folder?.accountId || "",
              folderPath: header?.folder?.path || "",
              ftsKeys: Object.keys(ftsRes || {}),
              bodyLen: typeof body === "string" ? body.length : 0,
            };
            log(
              `[TMDBG SnippetDiag][BG] ${SAFE_GETFULL_CONFIG.logPrefix} native FTS empty body ${JSON.stringify(details)}`,
              "warn"
            );
          }
        } catch (_) {}
      } else {
        log(`[TMDBG SnippetDiag][BG] ${SAFE_GETFULL_CONFIG.logPrefix} native FTS miss for ${uniqueKey}`, "warn");
      }
      try {
        const now = Date.now();
        const maxLogs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsStatsLogMax) || 0;
        const minIntervalMs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsStatsLogMinIntervalMs) || 0;
        if (
          SAFE_GETFULL_DIAG_STATE.ftsStatsLogs < maxLogs &&
          (now - SAFE_GETFULL_DIAG_STATE.ftsStatsLastMs) >= minIntervalMs
        ) {
          SAFE_GETFULL_DIAG_STATE.ftsStatsLogs += 1;
          SAFE_GETFULL_DIAG_STATE.ftsStatsLastMs = now;
          // Use direct FTS API call instead of runtime.sendMessage
          const ftsApi = await _getFtsSearch();
          const stats = ftsApi ? await ftsApi.stats() : null;
          log(
            `[TMDBG SnippetDiag][BG] ${SAFE_GETFULL_CONFIG.logPrefix} FTS stats at miss ${JSON.stringify(stats || {})}`,
            "warn"
          );
          const statsKeys = stats && typeof stats === "object" ? Object.keys(stats) : [];
          if (!stats || statsKeys.length === 0) {
            try {
              // Use browser.storage.local directly instead of runtime.sendMessage
              const stored = await browser.storage.local.get(["fts_initial_scan_complete", "fts_scan_status"]);
              const scanStatus = {
                initialComplete: stored.fts_initial_scan_complete || false,
                scanStatus: stored.fts_scan_status || { isScanning: false, scanType: "none" }
              };
              log(
                `[TMDBG SnippetDiag][BG] ${SAFE_GETFULL_CONFIG.logPrefix} FTS scan status at miss ${JSON.stringify(scanStatus || {})}`,
                "warn"
              );
            } catch (_) {}
            try {
              // Import nativeEngine to get host info directly
              const { nativeFtsSearch } = await import("../../fts/nativeEngine.js");
              const hostInfoRaw = nativeFtsSearch?.getHostInfo?.() || null;
              const hostInfo = {
                connected: !!hostInfoRaw,
                hostInfo: hostInfoRaw,
              };
              log(
                `[TMDBG SnippetDiag][BG] ${SAFE_GETFULL_CONFIG.logPrefix} FTS host info at miss ${JSON.stringify(hostInfo || {})}`,
                "warn"
              );
            } catch (_) {}
          }
        }
      } catch (_) {}
      try {
        const now = Date.now();
        const maxLogs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsMissLogMax) || 0;
        const minIntervalMs = Number(SAFE_GETFULL_CONFIG?.diag?.ftsMissLogMinIntervalMs) || 0;
        if (
          SAFE_GETFULL_DIAG_STATE.ftsMissLogs < maxLogs &&
          (now - SAFE_GETFULL_DIAG_STATE.ftsMissLastMs) >= minIntervalMs
        ) {
          SAFE_GETFULL_DIAG_STATE.ftsMissLogs += 1;
          SAFE_GETFULL_DIAG_STATE.ftsMissLastMs = now;
          const details = {
            uniqueKey,
            ftsKey,
            weId: id,
            headerMessageId: header?.headerMessageId || "",
            accountId: header?.folder?.accountId || "",
            folderPath: header?.folder?.path || "",
          };
          log(
            `[TMDBG SnippetDiag][BG] ${SAFE_GETFULL_CONFIG.logPrefix} native FTS miss details ${JSON.stringify(details)}`,
            "warn"
          );
        }
      } catch (_) {}
    }
  } catch (eFts) {
    log(`${SAFE_GETFULL_CONFIG.logPrefix} native FTS lookup failed for ${uniqueKey}: ${eFts}`, "warn");
  }

  // Cache miss or expired, fetch fresh data
  while (activeGetFullCount >= MAX_CONCURRENT_GETFULL) {
    await new Promise(r => setTimeout(r, 50));
  }
  activeGetFullCount++;
  try {
    log(`getFull cache miss for ${uniqueKey}, fetching fresh data`, "warn");
    const data = await browser.messages.getFull(id);
    
    // Cache the result
    getFullCache.set(uniqueKey, {
      data: data,
      timestamp: Date.now()
    });
    enforceGetFullCacheMaxEntries("getFull");
    log(`getFull cached for ${uniqueKey}, cache size: ${getFullCache.size}`);
    
    return data;
  } finally {
    activeGetFullCount--;
  }
}

/**
 * Logs a message with a consistent prefix for easy identification.
 * @param {string} message - The message to log.
 */
export function log(message, level = 'info') {
  // Always log errors; otherwise respect verboseLogging flag.
  const prefix = `[TabMail Agent] ${message}`;
  if (level === 'error') {
    console.error(prefix);
    return;
  }

  if (!SETTINGS.verboseLogging) {
    return; // Suppress info/debug when not verbose.
  }

  if (level === 'warn') {
    console.warn(prefix);
  } else {
    console.log(prefix);
  }
}

/**
 * Helper function to truncate and format text for logging.
 * @param {string} text - The text to format.
 * @param {number} [length=80] - The maximum length of the truncated text.
 * @returns {string} - The formatted string.
 */
export function formatForLog(text, length = SETTINGS.logTruncateLength) {
    if (!text) return "''";
    return text.replace(/\\r?\\n|\\r/g, " ").substring(0, length).trim() + "...";
}

/**
 * Recursively traverses DOM nodes to convert HTML to plain text,
 * intelligently adding newlines for block-level elements.
 * This logic is inspired by _getCleanedEditorTextWithOptionsRecursive from dom.js.
 * @param {Node} node The DOM node to process.
 * @returns {string} The plain text representation.
 */
function recursiveHtmlToText(node) {
    let finalText = "";
    if (!node) return "";

    // Base case: Text nodes
    if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
    }
    
    // Handle elements
    if (node.nodeType === Node.ELEMENT_NODE) {
        const tagName = node.tagName.toUpperCase();

        // <br> is a simple newline
        if (tagName === 'BR') {
            return '\n';
        }

        // Recursively process child nodes
        let innerText = "";
        for (const child of Array.from(node.childNodes)) {
            innerText += recursiveHtmlToText(child);
        }

        // Add a newline after block elements if they don't already end with one
        const isBlock = [
            'P', 'DIV', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'TR', 'HR', 'PRE'
        ].includes(tagName);

        if (isBlock && !innerText.endsWith('\n')) {
            innerText += '\n';
        }
        
        return innerText;
    }

    return ""; // Ignore other node types (comments, etc.)
}

/**
 * Strips HTML tags from a string to get plain text, preserving line breaks.
 * @param {string} html - The HTML string.
 * @returns {string} - The plain text.
 */
export function stripHtml(html) {
    if (!html) return "";
    try {
        const doc = new DOMParser().parseFromString(html, "text/html");
        // We start traversal from the body, and clean up at the end.
        let text = recursiveHtmlToText(doc.body);
        // Consolidate multiple blank lines into one or two.
        return text.replace(/(\n\s*){3,}/g, '\n\n').trim();
    } catch (e) {
        log(`Failed to parse HTML, falling back to simple textContent. Error: ${e}`);
        // Fallback for malformed HTML or other errors
        const doc = new DOMParser().parseFromString(html, "text/html");
        return doc.body.textContent || "";
    }
}

/**
 * Extracts only the user-written part of an email body, stripping out
 * quotes from previous emails in the thread. Uses DOM selectors for HTML
 * and regex patterns for plain text.
 * @param {string} body - The full email body (HTML or plain text).
 * @param {string} contentType - The content type ('text/html' or 'text/plain').
 * @returns {string} - The user-written content as plain text.
 */
export function extractUserWrittenContent(body, contentType) {
    if (!body) return "";

    const qd = globalThis.TabMailQuoteDetection;

    // For HTML content, check for inline answers in the DOM structure first,
    // then extract text and use text-based detection.
    let textContent = body;
    if (contentType && contentType.startsWith("text/html")) {
        try {
            const doc = new DOMParser().parseFromString(body, "text/html");

            // Check for inline answers via DOM structure (blockquote interleaving).
            // recursiveHtmlToText doesn't add ">" markers for blockquotes, so the
            // plain text detection can't catch this — we need the DOM check here.
            if (qd && qd.hasInlineAnswersInDOM && qd.hasInlineAnswersInDOM(doc.body)) {
                log(`Inline answers detected in HTML email (DOM) — returning full text`);
                textContent = recursiveHtmlToText(doc.body);
                return String(textContent || "").replace(/(\n\s*){3,}/g, '\n\n').trim();
            }

            textContent = recursiveHtmlToText(doc.body);
        } catch (e) {
            log(`Failed to parse HTML for user content extraction. Error: ${e}`);
            // Fallback: use body as-is
        }
    }

    // Use text-based quote detection (single source of truth)
    const boundary = qd && qd.findBoundaryInPlainText ? qd.findBoundaryInPlainText(textContent) : null;
    if (!boundary) {
        return String(textContent || "").replace(/(\n\s*){3,}/g, '\n\n').trim();
    }

    // If inline answers detected (plain text with ">" markers), return full text —
    // the user's inline responses need the quoted context to be understood.
    if (boundary.hasInlineAnswers) {
        log(`Inline answers detected in plain text email — returning full text`);
        return String(textContent || "").replace(/(\n\s*){3,}/g, '\n\n').trim();
    }

    log(`Quote boundary found: type="${boundary.type}" at line ${boundary.lineIndex}`, "warn");
    const lines = String(textContent || "").split(/\r?\n/);
    return lines.slice(0, boundary.lineIndex).join('\n').replace(/(\n\s*){3,}/g, '\n\n').trim();
}



/**
 * Generates a globally unique key for a message, used for all caching.
 * Returns accountId:folderPath:headerMessageId format for consistency with FTS database.
 * @param {browser.messages.MessageId|Object|string} input - Can be:
 *   - WebExtension message ID (number) - will fetch header via browser.messages.get
 *   - Message header object - will use directly
 *   - Object with {headerMessageId, weFolder} - will use directly
 * @param {browser.folders.MailFolder} [weFolder] - Mandatory weFolder object when input is headerMessageId string
 * @returns {Promise<string|null>} A unique key in format "accountId:folder:headerMessageId", or null if invalid input.
 */
export async function getUniqueMessageKey(input, weFolder = null) {
    try {
        let messageHeader = null;
        let cleanHeaderMessageId = null;
        let accountId = null;
        let folderPath = null;

        // Handle different input types
        if (typeof input === 'number') {
            // Case 1: WebExtension message ID - fetch header
            messageHeader = await browser.messages.get(input);
            cleanHeaderMessageId = messageHeader.headerMessageId.replace(/[<>]/g, "");
            accountId = messageHeader.folder?.accountId || "";
            folderPath = messageHeader.folder?.path || "";
        } else if (typeof input === 'object' && input !== null) {
            // Case 2: Full message header object
            messageHeader = input;
            cleanHeaderMessageId = messageHeader.headerMessageId.replace(/[<>]/g, "");
            accountId = messageHeader.folder?.accountId || "";
            folderPath = messageHeader.folder?.path || "";
        } else if (typeof input === 'string' && weFolder !== null) {
            // Case 3: headerMessageId string with weFolder parameter
            cleanHeaderMessageId = input.replace(/[<>]/g, "");
            accountId = weFolder?.accountId || "";
            folderPath = weFolder?.path || "";
        } else {
            log(`ERROR: Invalid input type for getUniqueMessageKey: ${typeof input}`, "error");
            return null;
        }

        // Validate we have the required components
        if (!cleanHeaderMessageId) {
            log(`ERROR: Could not extract headerMessageId from input`, "error");
            return null;
        }

        // Return in consistent format: accountId:folderPath:headerMessageId
        return `${accountId}:${folderPath}:${cleanHeaderMessageId}`;
    } catch (error) {
        log(`ERROR: Could not generate unique message key. ${error}`, "error");
        return null;
    }
}

/**
 * Extracts the most suitable text body from message parts recursively.
 * Prefers plain text, but falls back to converting HTML to text.
 * @param {browser.messages.MessagePart[]} parts - The parts of the message.
 * @returns {string} - The extracted body content as plain text.
 */
export async function extractBodyFromParts(parts, rootMessageId) {
    if (!parts) return "";
    const list = Array.isArray(parts) ? parts : [parts];
    try {
        const topTypes = list.map(p => p?.contentType || "").join(",");
        // log(`[TMDBG Body] extractBodyFromParts start: parts=${list.length} topTypes=[${topTypes}]`);
    } catch (_) {}

    // Debug: recursively log structure up to a limited depth
    try {
        const summarize = (arr, depth = 0) => {
            if (!Array.isArray(arr) || depth > 3) return;
            for (const p of arr) {
                const ct = p?.contentType || "";
                const len = typeof p?.body === "string" ? p.body.length : 0;
                const hasBody = typeof p?.body === "string";
                const childCount = Array.isArray(p?.parts) ? p.parts.length : 0;
                const partName = p?.partName || "";
                const size = typeof p?.size === "number" ? p.size : undefined;
                const headers = p?.headers || {};
                const hct = headers && (headers["content-type"]?.[0] || headers["Content-Type"]?.[0] || "");
                const hcte = headers && (headers["content-transfer-encoding"]?.[0] || headers["Content-Transfer-Encoding"]?.[0] || "");
                const hdisp = headers && (headers["content-disposition"]?.[0] || headers["Content-Disposition"]?.[0] || "");
                // log(`[TMDBG Body] ${" ".repeat(depth)}part ct='${ct}' hasBody=${hasBody} bodyLen=${len} children=${childCount} part='${partName}' size=${size ?? ""} h.ct='${hct}' h.cte='${hcte}' h.cd='${hdisp}'`);
                if (!hasBody && childCount === 0 && /text\/plain/i.test(ct)) {
                    // log(`[TMDBG Body] ${" ".repeat(depth)}leaf text/plain without body. This may be an embedded rfc822 part or provider omission.`);
                }
                if (childCount > 0) summarize(p.parts, depth + 1);
            }
        };
        summarize(list, 0);
    } catch (_) {}

    // 1. Prefer plain text part
    let textPart = list.find(p => p.contentType && p.contentType.startsWith("text/plain"));
    if (textPart && typeof textPart.body === "string") {
        try {
            // log(`[TMDBG Body] text/plain part found (len=${textPart.body.length}). Raw sample='${formatForLog(textPart.body)}'`);
            // log(`[TMDBG BodyDump] text/plain raw:\n${textPart.body}`);
        } catch (_) {}
        return textPart.body;
    }
    if (textPart && !textPart.body && textPart.partName && typeof textPart.size === "number" && textPart.size > 0 && rootMessageId) {
        try {
            // log(`[TMDBG Body] text/plain has no inline body; attempting getAttachmentFile for part='${textPart.partName}' size=${textPart.size}`);
            const file = await browser.messages.getAttachmentFile(rootMessageId, textPart.partName);
            const raw = await file.text();
            // log(`[TMDBG Body] fetched text/plain via attachment file (len=${raw.length}).`);
            return raw;
        } catch (e) {
            // log(`[TMDBG Body] failed to fetch text/plain attachment for part='${textPart.partName}': ${e}`);
        }
    }

    // 2. Fallback to HTML part
    let htmlPart = list.find(p => p.contentType && p.contentType.startsWith("text/html"));
    if (htmlPart && htmlPart.body) {
        try {
            // log(`[TMDBG Body] text/html part found (len=${htmlPart.body.length}). Raw sample='${formatForLog(htmlPart.body)}'`);
            // log(`[TMDBG BodyDump] text/html raw:\n${htmlPart.body}`);
        } catch (_) {}
        const cleaned = stripHtml(htmlPart.body);
        // try { log(`[TMDBG Body] text/html stripped length=${cleaned.length}. Sample='${formatForLog(cleaned)}'`); } catch (_) {}
        if (cleaned) return cleaned;
        // Fallback: crude tag removal if DOM parsing produced empty text (malformed HTML etc.)
        return htmlPart.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    if (htmlPart && !htmlPart.body && htmlPart.partName && typeof htmlPart.size === "number" && htmlPart.size > 0 && rootMessageId) {
        try {
            // log(`[TMDBG Body] text/html has no inline body; attempting getAttachmentFile for part='${htmlPart.partName}' size=${htmlPart.size}`);
            const file = await browser.messages.getAttachmentFile(rootMessageId, htmlPart.partName);
            const rawHtml = await file.text();
            // log(`[TMDBG Body] fetched text/html via attachment file (len=${rawHtml.length}).`);
            const cleaned = stripHtml(rawHtml);
            // try { log(`[TMDBG Body] text/html(strm) stripped length=${cleaned.length}. Sample='${formatForLog(cleaned)}'`); } catch (_) {}
            if (cleaned) return cleaned;
            return rawHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        } catch (e) {
            // log(`[TMDBG Body] failed to fetch text/html attachment for part='${htmlPart.partName}': ${e}`);
        }
    }

    // 3. Look in sub-parts for multipart/alternative etc.
    for (const part of list) {
        if (part.parts) {
            // try { log(`[TMDBG Body] Descending into sub-parts for contentType='${part.contentType || ""}' parts=${part.parts.length}`); } catch (_) {}
            const body = await extractBodyFromParts(part.parts, rootMessageId);
            if (body) {
                return body;
            }
        }
    }

    // No body found – log diagnostic once.
    // log(`[TMDBG Body] extractBodyFromParts returning empty result (parts traversed=${list.length}).`);
    return "";
}

/**
 * Executes an array of promise-generating functions in batches to avoid
 * overwhelming the Thunderbird API with too many concurrent requests.
 * @param {Array<Function<Promise>>} promiseFactories - An array of functions that each return a promise.
 * @param {number} concurrency - The number of promises to run in each batch.
 * @returns {Promise<Array<any>>} A promise that resolves with an array of all results.
 */
export async function runPromisesInBatches(promiseFactories, concurrency) {
    let allResults = [];
    for (let i = 0; i < promiseFactories.length; i += concurrency) {
        const batchFactories = promiseFactories.slice(i, i + concurrency);
        const batchPromises = batchFactories.map(factory => factory());
        const batchResults = await Promise.all(batchPromises);
        allResults.push(...batchResults);
    }
    return allResults;
} 

// Sanitizes file names by replacing characters that are invalid on most filesystems.
export function sanitizeFilename(name) {
    return name.replace(/[\\/:*?"<>|]/g, "_");
}

// Saves a chat log (messages + assistant response) to the user's Downloads
// folder, respecting the SETTINGS.debugMode flag.
// `prefix` should be something like "tabmail_summary" or "tabmail_action".
export async function saveChatLog(prefix, id, messages, assistantContent) {
    if (!SETTINGS.debugMode) return;
    try {
        // Inject ephemeral thinking content into the assistant entry we add for saving only.
        const think = getAndClearThink();
        const blob = new Blob([
            JSON.stringify(
                messages.concat([{ role: "assistant", content: assistantContent, thinking: think || undefined }]),
                null,
                2
            )
        ], { type: "application/json" });

        const url = URL.createObjectURL(blob);
        const sanitizedName = sanitizeFilename(`${prefix}_${id}.json`);
        const folder = SETTINGS.logFolder || "logs"; // Defaults to "logs" if not configured
        const filename = `${folder}/${sanitizedName}`;
        await browser.downloads.download({ url, filename, saveAs: false });
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {}
} 
 
// Saves a tool-call log object to the user's Downloads folder (inside SETTINGS.logFolder).
// Use this to persist what tool the agent attempted to call (name + args), and optionally results.
// payload is any JSON-serializable object containing details you want to persist.
export async function saveToolCallLog(prefix, id, payload) {
    if (!SETTINGS.debugMode) return;
    try {
        const blob = new Blob([
            JSON.stringify(payload, null, 2)
        ], { type: "application/json" });

        const url = URL.createObjectURL(blob);
        const sanitizedName = sanitizeFilename(`${prefix}_${id}.json`);
        const folder = SETTINGS.logFolder || "logs";
        const filename = `${folder}/${sanitizedName}`;
        await browser.downloads.download({ url, filename, saveAs: false });
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch {}
}

/**
 * Internal helper that resolves a special-use folder (e.g. "trash", "archives")
 * for the account that owns the provided message header.
 *
 * @param {browser.messages.MessageHeader} header - The full message header.
 * @param {string} specialUse - One of the MailFolderSpecialUse enum values.
 * @returns {Promise<browser.folders.MailFolder|null>} The matching folder or null.
 */
async function getSpecialFolderForHeader(header, specialUse) {
  if (!header || !header.folder || !header.folder.accountId) {
    log("getSpecialFolderForHeader called with invalid header", "warn");
    return null;
  }

  try {
    const matches = await browser.folders.query({
      accountId: header.folder.accountId,
      specialUse: [specialUse],
      limit: 1,
    });
    if (matches && matches.length > 0) {
      return matches[0];
    }
    log(`No folder with specialUse='${specialUse}' found for account ${header.folder.accountId}`, "warn");
  } catch (e) {
    log(`Error querying for ${specialUse} folder: ${e}`, "error");
  }
  return null;
}

// Public helpers specifically for Trash and Archive.
export async function getTrashFolderForHeader(header) {
  return getSpecialFolderForHeader(header, "trash");
}

export async function getArchiveFolderForHeader(header) {
  return getSpecialFolderForHeader(header, "archives");
} 

/**
 * Returns Sent folders for a specific accountId.
 * Uses accounts.get(accountId, true) when available for efficient traversal,
 * otherwise falls back to folders.getSubFolders from the account's root.
 * @param {string} accountId
 * @returns {Promise<browser.folders.MailFolder[]>}
 */
export async function getSentFoldersForAccount(accountId) {
  const results = [];
  try {
    let account = null;
    try {
      // Prefer API that includes subfolders directly
      account = await browser.accounts.get(accountId, true);
    } catch (_) {
      // Fallback path: reconstruct minimal account object
      const all = await browser.accounts.list();
      account = all.find(a => a.id === accountId) || null;
    }
    if (!account) return results;

    const consider = (f) => {
      if (!f) return;
      const uses = Array.isArray(f.specialUse) ? f.specialUse.map(s => String(s).toLowerCase()) : [];
      if (uses.includes("sent") || f.type === "sent") results.push(f);
    };

    if (Array.isArray(account.folders) && account.folders.length > 0) {
      const stack = [...account.folders];
      while (stack.length) {
        const f = stack.pop();
        consider(f);
        if (Array.isArray(f?.subFolders) && f.subFolders.length) stack.push(...f.subFolders);
      }
      return results;
    }

    // Fallback: enumerate from rootFolder
    if (account.rootFolder && account.rootFolder.id) {
      consider(account.rootFolder);
      try {
        const sub = await browser.folders.getSubFolders(account.rootFolder.id, true);
        for (const f of sub) consider(f);
      } catch (e) {
        log(`[Utils] getSentFoldersForAccount: subfolder enumeration failed for account ${accountId}: ${e}`, "warn");
      }
    }
  } catch (e) {
    log(`[Utils] getSentFoldersForAccount failed for account ${accountId}: ${e}`, "warn");
  }
  return results;
}

/**
 * Resolves the correct identity for a message based on the message's account.
 * This is crucial for replies/forwards to use the correct sender identity
 * in multi-account setups.
 * 
 * @param {number|object} messageOrId - Message ID or message header object with folder.accountId
 * @returns {Promise<{identityId: string, email: string, name: string}|null>} The identity info or null if not found
 */
export async function getIdentityForMessage(messageOrId) {
  try {
    let accountId = null;

    // Handle both message ID and message header object
    if (typeof messageOrId === "number") {
      const msgHeader = await browser.messages.get(messageOrId);
      accountId = msgHeader?.folder?.accountId;
    } else if (messageOrId?.folder?.accountId) {
      accountId = messageOrId.folder.accountId;
    }

    if (!accountId) {
      log(`[Utils] getIdentityForMessage: no accountId found`, "warn");
      return null;
    }

    const account = await browser.accounts.get(accountId);
    if (!account?.identities?.length) {
      log(`[Utils] getIdentityForMessage: no identities for account ${accountId}`, "warn");
      return null;
    }

    // Use the default identity for this account (match by account email, or first one)
    const defaultIdentity = account.identities.find(id => id.email === account.email) || account.identities[0];

    if (defaultIdentity?.id) {
      log(`[Utils] getIdentityForMessage: resolved identityId=${defaultIdentity.id} (email=${defaultIdentity.email}) for account ${accountId}`);
      return {
        identityId: defaultIdentity.id,
        email: defaultIdentity.email || "",
        name: defaultIdentity.name || "",
      };
    }

    return null;
  } catch (e) {
    log(`[Utils] getIdentityForMessage failed: ${e}`, "warn");
    return null;
  }
}

// ----------------------------------------------------------
// Header index helper – populated by various modules so that the background
// worker can resolve Message-Id to numeric id instantly.
// ----------------------------------------------------------

export const headerIndex = new Map(); // Map<headerId, { weID, weFolder }>

export function indexHeader(header) {
    // Keep call sites synchronous but run async logic internally so we can
    // leverage getUniqueMessageKey() without refactoring callers.
    (async () => {
        try {
            if (!header || !header.id) {
                return;
            }

            // Delegate key generation to shared helper to avoid drift.
            const uniqueKey = await getUniqueMessageKey(header.id);
            if (!uniqueKey) {
                console.warn("Agent: Unable to derive unique key via getUniqueMessageKey for header", header);
                return;
            }

            headerIndex.set(uniqueKey, {
                id: header.id,
                folder: header.folder,
            });
        } catch (e) {
            console.error("Agent IDX error adding", e);
        }
    })();
}

/**
 * Updates headerIndex mapping for a moved message by removing old mapping and adding new one.
 * This ensures both forward and inverse mapping work correctly after a message move.
 * @param {Object} beforeHeader - The message header before the move
 * @param {Object} afterHeader - The message header after the move
 */
export async function updateHeaderIndexForMovedMessage(beforeHeader, afterHeader) {
    try {
        if (!beforeHeader || !afterHeader || !beforeHeader.id || !afterHeader.id) {
            log(`[TMDBG HeaderIndex] Invalid headers for move update: before=${!!beforeHeader}, after=${!!afterHeader}`, "warn");
            return;
        }

        // Generate unique keys for both before and after states using header objects directly
        // This avoids trying to fetch messages via browser.messages.get() since they might not be found
        // Note: These will be different because folderPath changes in the uniqueKey format
        const beforeKey = await getUniqueMessageKey(beforeHeader);
        const afterKey = await getUniqueMessageKey(afterHeader);

        if (!beforeKey || !afterKey) {
            log(`[TMDBG HeaderIndex] Failed to generate keys for move update: before=${beforeKey}, after=${afterKey}`, "warn");
            return;
        }

        // Remove old mapping if it exists (using the old uniqueKey with old folderPath)
        if (headerIndex.has(beforeKey)) {
            headerIndex.delete(beforeKey);
            log(`[TMDBG HeaderIndex] Removed old mapping for moved message: ${beforeKey}`);
        } else {
            log(`[TMDBG HeaderIndex] No old mapping found to remove for moved message: ${beforeKey}`);
        }

        // Add new mapping (using the new uniqueKey with new folderPath)
        headerIndex.set(afterKey, {
            id: afterHeader.id,
            folder: afterHeader.folder,
        });
        log(`[TMDBG HeaderIndex] Added new mapping for moved message: ${afterKey} -> weID=${afterHeader.id}`);

        // Broadcast idMapRemap to all chat windows so their idTranslation maps update
        // This ensures LLM-stored numeric IDs now point to the new unique_id
        try {
            await browser.runtime.sendMessage({
                command: "idMapRemap",
                oldRealId: beforeKey,
                newRealId: afterKey,
            });
            log(`[TMDBG HeaderIndex] Broadcast idMapRemap: ${beforeKey} -> ${afterKey}`);
        } catch (eBroadcast) {
            // Expected to fail if no chat windows are open - that's fine
            if (!String(eBroadcast).includes("Could not establish connection")) {
                log(`[TMDBG HeaderIndex] idMapRemap broadcast note: ${eBroadcast}`);
            }
        }

        // Debug check: check if the afterKey is working via browser.messages.get
        const afterHeaderDebug = await browser.messages.get(afterHeader.id);
        if (afterHeaderDebug) {
            log(`[TMDBG HeaderIndex] Debug check: afterKey is working via browser.messages.get: ${afterKey} -> weID=${afterHeaderDebug.id}`);
        } else {
            log(`[TMDBG HeaderIndex] Debug check: afterKey is not working via browser.messages.get: ${afterKey}`);
        }

    } catch (e) {
        log(`[TMDBG HeaderIndex] Error updating headerIndex for moved message: ${e}`, "error");
    }
}

/**
 * Removes headerIndex mapping for a deleted message.
 * This cleans up stale entries when messages are deleted.
 * @param {Object} deletedHeader - The message header that was deleted (contains folder info from before deletion)
 */
export async function removeHeaderIndexForDeletedMessage(deletedHeader) {
    try {
        if (!deletedHeader || !deletedHeader.id) {
            log(`[TMDBG HeaderIndex] Invalid header for deletion cleanup: ${!!deletedHeader}`, "warn");
            return;
        }

        // Generate unique key for the deleted message using the header object directly
        // This avoids trying to fetch the message via browser.messages.get() since it's already deleted
        const uniqueKey = await getUniqueMessageKey(deletedHeader);
        if (!uniqueKey) {
            log(`[TMDBG HeaderIndex] Failed to generate key for deletion cleanup`, "warn");
            return;
        }

        // Remove mapping if it exists
        if (headerIndex.has(uniqueKey)) {
            headerIndex.delete(uniqueKey);
            log(`[TMDBG HeaderIndex] Removed mapping for deleted message: ${uniqueKey}`);
        } else {
            log(`[TMDBG HeaderIndex] No mapping found to remove for deleted message: ${uniqueKey}`);
        }

    } catch (e) {
        log(`[TMDBG HeaderIndex] Error removing headerIndex for deleted message: ${e}`, "error");
    }
}



/**
 * Parses a uniqueId string to extract the weFolder and headerID components.
 *
 * The uniqueId is expected to be in the format "accountId:folderPath:headerID".
 *
 * @param {string} uniqueId - The unique ID string in the format "accountId:folderPath:headerID".
 * @returns {{weFolder: objectj, headerID: string} | null} - An object containing the weFolder and headerID, or null if the input is invalid.
 */
export function parseUniqueId(uniqueId) {
    
    if (!uniqueId || typeof uniqueId !== 'string') {
        log(`[TMDBG Tools] parseUniqueId: invalid or missing unique_id: ${uniqueId}`, "warn");
        return null;
    }

    const colonIndex = uniqueId.indexOf(':');
    if (colonIndex === -1) {
        log(`[TMDBG Tools] parseUniqueId: invalid unique_id format: ${uniqueId}`, "warn");
        return null;
    }

    const colonIndex2 = uniqueId.indexOf(':', colonIndex + 1);
    if (colonIndex2 === -1) {
        log(`[TMDBG Tools] parseUniqueId: invalid unique_id format: ${uniqueId}`, "warn");
        return null;
    }
    
    const accountId = uniqueId.substring(0, colonIndex);
    const folderPath = uniqueId.substring(colonIndex + 1, colonIndex2);
    const headerID = uniqueId.substring(colonIndex2 + 1);
    
    if (!headerID) {
        log(`[TMDBG Tools] parseUniqueId: empty headerID in unique_id: ${uniqueId}`, "warn");
        return null;
    }

    // re construct weFolder
    const weFolder = {
        accountId: accountId,
        path: folderPath,
    };

    return { weFolder, headerID };
}

/**
 * Resolves a headerID to one or more WebExtension message IDs (weID).
 * 
 * This function uses a robust three-stage algorithm:
 * 1. Try headerIndex resolution + validation with browser.messages.get()
 * 2. If stage 1 fails, try messages.query with the provided folder
 * 3. If stage 2 fails, try messages.query without folder as final fallback (unless disabled)
 *
 * @param {string} headerID - The cleaned Message-ID of the message header.
 * @param {object} [weFolder=null] - (Optional) The weFolder to narrow the search and improve query speed.
 * @param {boolean} [multiple=false] - If true, returns all matching message IDs as an array; if false, returns the first match as a single ID.
 * @param {boolean} [allowGlobalFallback=true] - If false, skips the global query fallback (Stage 3). Useful for cleanup operations.
 * @returns {Promise<number|number[]|null>} - Resolves to a single message ID, an array of message IDs, or null/empty array if not found.
 */
export async function headerIDToWeID(headerID, weFolder = null, multiple = false, allowGlobalFallback = true) {
    try {
        if (!headerID || typeof headerID !== 'string') {
            log(`[TMDBG HeaderResolver] Invalid headerID: ${headerID}`, "warn");
            return multiple ? [] : null;
        }

        const resolverPrefix = multiple ? "[TMDBG MultiHeaderResolver]" : "[TMDBG HeaderResolver]";

        // STAGE 1: Try headerIndex resolution + validation (only for single resolution)
        if (!multiple) {
            const lookupKey = await getUniqueMessageKey(headerID, weFolder);
            if (lookupKey) {
                const indexEntry = headerIndex.get(lookupKey);
                if (indexEntry && indexEntry.id) {
                    // Validate that the message still exists AND is the correct message.
                    // weIds can be silently reassigned during rapid batch moves/deletes,
                    // so we must verify the headerMessageId matches — not just that
                    // *some* message exists at this weId.
                    try {
                        const validationHeader = await browser.messages.get(indexEntry.id);
                        if (validationHeader) {
                            const resolvedHeaderId = (validationHeader.headerMessageId || "").replace(/[<>]/g, "");
                            if (resolvedHeaderId === headerID) {
                                return indexEntry.id;
                            }
                            // weId was reassigned to a different message — stale cache entry
                            log(`${resolverPrefix} STAGE 1: weId ${indexEntry.id} reassigned (expected headerID=${headerID}, got=${resolvedHeaderId}) — invalidating cache`);
                            headerIndex.delete(lookupKey);
                        } else {
                            // Delete stale entry to prevent repeated failed lookups
                            headerIndex.delete(lookupKey);
                        }
                    } catch (validationError) {
                        // Delete stale entry to prevent repeated failed lookups
                        headerIndex.delete(lookupKey);
                    }
                }
            }
        }

        // STAGE 2: Try messages.query with folder (if provided)
        if (weFolder) {
            try {
                let queryOptions = {};
                // Resolve folder and add to queryOptions
                if (typeof weFolder === "object" && weFolder.accountId && weFolder.path) {
                    try {
                        // Resolve to a real MailFolder (to get its .id)
                        const [target] = await browser.folders.query({
                            accountId: weFolder.accountId,
                            path: weFolder.path,
                            limit: 1,
                        });
                        if (target && target.id) {
                            queryOptions.folderId = target.id;  // <-- messages.query expects folderId, not folder
                        } else {
                            log(`${resolverPrefix} STAGE 2: Could not resolve folderId for ${weFolder.accountId}:${weFolder.path}`, "warn");
                        }
                    } catch (e) {
                        log(`${resolverPrefix} STAGE 2: Failed to resolve folderId for query constraint: ${e}`, "warn");
                    }
                }

                const queryResult = await browser.messages.query({
                    ...queryOptions,
                    headerMessageId: headerID
                });
                
                if (queryResult && queryResult.messages && queryResult.messages.length > 0) {
                    if (multiple) {
                        const weIDs = queryResult.messages.map(message => message.id);
                        // Cache all results
                        try {
                            queryResult.messages.forEach(message => {
                                indexHeader(message);
                            });
                        } catch (e) {
                            log(`${resolverPrefix} STAGE 2: Failed to cache some resolved messages: ${e}`, "warn");
                        }
                        return weIDs;
                    } else {
                        const message = queryResult.messages[0];
                        // Cache this result
                        try {
                            indexHeader(message);
                        } catch (e) {
                            log(`${resolverPrefix} STAGE 2: Failed to cache resolved message: ${e}`, "warn");
                        }
                        return message.id;
                    }
                }
            } catch (stage2Error) {
                log(`${resolverPrefix} STAGE 2: messages.query with folder threw error: ${stage2Error}`, "warn");
            }
        }

        // STAGE 3: Try messages.query without folder (final fallback) - only if allowed
        if (allowGlobalFallback) {
            try {
                const queryResult = await browser.messages.query({
                    headerMessageId: headerID
                });
                
                if (queryResult && queryResult.messages && queryResult.messages.length > 0) {
                    if (multiple) {
                        const weIDs = queryResult.messages.map(message => message.id);
                        // Cache all results
                        try {
                            queryResult.messages.forEach(message => {
                                indexHeader(message);
                            });
                        } catch (e) {
                            log(`${resolverPrefix} STAGE 3: Failed to cache some resolved messages: ${e}`, "warn");
                        }
                        return weIDs;
                    } else {
                        const message = queryResult.messages[0];
                        // Cache this result
                        try {
                            indexHeader(message);
                        } catch (e) {
                            log(`${resolverPrefix} STAGE 3: Failed to cache resolved message: ${e}`, "warn");
                        }
                        return message.id;
                    }
                }
            } catch (stage3Error) {
                log(`${resolverPrefix} STAGE 3: messages.query without folder threw error: ${stage3Error}`, "warn");
            }
        }

        // All stages failed
        log(`${resolverPrefix} ALL STAGES FAILED - No message found for headerID '${headerID}'`, "warn");
        return multiple ? [] : null;
        
    } catch (e) {
        log(`[TMDBG HeaderResolver] Exception in headerIDToWeID: ${e}`, "error");
        log(`[TMDBG HeaderResolver] Stack trace: ${e.stack}`, "error");
        return multiple ? [] : null;
    }
}



/**
 * Creates a debounced function that delays invoking the func until after `wait`
 * milliseconds have elapsed since the last time the debounced function was invoked.
 * @param {Function} func The function to debounce.
 * @param {number} wait The number of milliseconds to delay.
 * @returns {Function} Returns the new debounced function.
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * Aggressively normalizes Unicode characters to standard ASCII equivalents.
 * Handles dashes, quotes, spaces, and other problematic characters while
 * preserving intentional multiple spaces.
 * @param {string} text - The text to normalize
 * @returns {string} - The normalized text
 */
export function normalizeUnicode(text) {
    if (!text || typeof text !== 'string') return text;
    
    return text
        .normalize('NFKC')
        // Replace various dash/hyphen characters with standard hyphen
        .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, '-')
        // Replace various quote characters with standard quotes
        .replace(/[\u2018\u2019\u201B]/g, "'")  // Single quotes (added more variants)
        .replace(/[\u201C\u201D\u201E\u201F]/g, '"')  // Double quotes (added more variants)
        // Replace various apostrophe and prime characters
        .replace(/[\u2032\u2035]/g, "'")  // Prime symbols
        // Replace fullwidth brackets with standard brackets
        .replace(/\u3010/g, '[')  // Fullwidth left square bracket 【
        .replace(/\u3011/g, ']')  // Fullwidth right square bracket 】
        // Replace various space characters with regular space (preserving multiple spaces)
        .replace(/[\u00A0\u202F\u2007\u2008\u2009\u200A\u200B\u2028\u2029\u205F\u3000]/g, ' ')
        // Replace ellipsis character with three dots
        .replace(/\u2026/g, '...');
} 