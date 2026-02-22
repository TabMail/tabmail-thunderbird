import * as idb from "./idbStorage.js";
import { processSummaryResponse, sendChat } from "./llm.js";
// We'll build placeholder messages directly
import { formatTimestampForAgent, getUserName } from "../../chat/modules/helpers.js";
import { SETTINGS } from "./config.js";
import { analyzeEmailForReplyFilter } from "./messagePrefilter.js";
import {
  extractBodyFromParts,
  getUniqueMessageKey,
  indexHeader,
  log,
  safeGetFull,
  saveChatLog,
  stripHtml,
} from "./utils.js";

const PFX = "[SummaryGen] ";
const SUMMARY_PREFIX = "summary:";
const SUMMARY_TS_PREFIX = "summary:ts:";

// Per-message semaphores to prevent concurrent summary generation for the same message
const _summarySemaphores = new Map();

async function _acquireSummarySemaphore(uniqueKey) {
  // Ensure semaphore exists atomically
  if (!_summarySemaphores.has(uniqueKey)) {
    _summarySemaphores.set(uniqueKey, { active: false, queue: [] });
  }
  
  const semaphore = _summarySemaphores.get(uniqueKey);
  
  // Atomic check-and-set to prevent race condition
  if (semaphore.active) {
    // Already active, queue this request
    await new Promise((resolve) => semaphore.queue.push(resolve));
    return;
  }
  
  // Mark as active immediately to prevent race condition
  semaphore.active = true;
}

function _releaseSummarySemaphore(uniqueKey) {
  const semaphore = _summarySemaphores.get(uniqueKey);
  if (!semaphore) return;
  
  if (semaphore.queue.length > 0) {
    const next = semaphore.queue.shift();
    next();
  } else {
    semaphore.active = false;
    // Clean up empty semaphores to prevent memory leaks
    _summarySemaphores.delete(uniqueKey);
  }
}


/**
 * Removes expired summary entries from idb.
 *
 * The TTL is taken from SETTINGS.summaryTTLSeconds. Any entry whose stored
 * timestamp is older than `now - TTL` will be deleted.
 */
export async function purgeExpiredSummaryEntries() {
    const ttlMs = SETTINGS.summaryTTLSeconds * 1000;
    const cutoff = Date.now() - ttlMs;

    const allKeys = await idb.getAllKeys();
    const payloadsToRemove = new Set();
    const metaToRemove = new Set();

    // Get timestamp entries for summary cache
    const timestampKeys = allKeys.filter(key => key.startsWith(SUMMARY_TS_PREFIX));
    const timestampEntries = await idb.get(timestampKeys);

    for (const [key, val] of Object.entries(timestampEntries)) {
        const ts = val?.ts ?? 0;
        if (typeof ts !== "number" || ts < cutoff) {
            // Derive payload key from meta key
            const uniqueKey = key.slice(SUMMARY_TS_PREFIX.length);
            const payloadKey = SUMMARY_PREFIX + uniqueKey;
            payloadsToRemove.add(payloadKey);
            metaToRemove.add(key);
        }
    }

    // Robustness: handle legacy/buggy cases where payload exists but meta ts key is missing.
    // Treat any payload without a matching SUMMARY_TS_PREFIX meta key as expired.
    const payloadKeys = allKeys.filter(key => key.startsWith(SUMMARY_PREFIX) && !key.startsWith(SUMMARY_TS_PREFIX));
    for (const payloadKey of payloadKeys) {
        try {
            const uniqueKey = payloadKey.slice(SUMMARY_PREFIX.length);
            const metaKey = SUMMARY_TS_PREFIX + uniqueKey;
            if (!timestampEntries || !Object.prototype.hasOwnProperty.call(timestampEntries, metaKey)) {
                payloadsToRemove.add(payloadKey);
            }
        } catch (_) {}
    }

    const toRemove = [...payloadsToRemove, ...metaToRemove];
    if (toRemove.length > 0) {
        await idb.remove(toRemove);
        const removedPayload = payloadsToRemove.size;
        const removedMeta = metaToRemove.size;
        const orphanedPayload = Math.max(0, removedPayload - removedMeta);
        log(`[Summary] Purged ${toRemove.length} expired summary entries (payload=${removedPayload}, meta=${removedMeta}, payloadWithoutMeta=${orphanedPayload}).`);
    }
}

/**
 * Retrieves a cached summary object for a message using its header ID.
 *
 * This function only supports retrieval from the cache and does not perform any
 * fallback or heavy computation to generate a summary if it is missing.
 * It is intended for fast lookups when the summary has already been generated and stored.
 *
 * @param {string} headerId - The header ID of the message (typically the unique Message-Id).
 * @returns {Promise<Object|null>} The cached summary object if found, or null if not present in cache.
 */
export async function getSummaryWithHeaderId(headerId) {
  const cacheKey = SUMMARY_PREFIX + headerId;
  const cachedEntry = (await idb.get(cacheKey))[cacheKey];
  if (cachedEntry) {
    return cachedEntry;
  }
  return null;
}

/**
 * Retrieves a summary object for a message using its header.
 *
 * This function performs a cache lookup first, and if not found, it generates
 * a summary using the generateSummary function.
 *
 * @param {Object} messageHeader - The header object of the message.
 * @param {boolean} [highPriority=false] - Whether to prioritize the summary generation.
 * @param {boolean} [cacheOnly=false] - Whether to only return cached data without generating a new summary.
 * @returns {Promise<Object|null>} The summary object if found or generated, or null if not found and cacheOnly is true.
 */
export async function getSummary(
  messageHeader,
  highPriority = false,
  cacheOnly = false
) {
  const uniqueKey = await getUniqueMessageKey(messageHeader.id);
  if (!uniqueKey) return null;

  const cacheKey = SUMMARY_PREFIX + uniqueKey;
  const metaKey = SUMMARY_TS_PREFIX + uniqueKey;

  // Fast-path: if a cached summary exists, return it immediately and skip heavy safeGetFull() work.
  try {
    const cachedEntry = (await idb.get(cacheKey))[cacheKey];
    if (cachedEntry) {
      log(`[Summary] Cache HIT for message ${messageHeader.id} (${uniqueKey})`, 'debug');
      // Touch the cache entry by updating its timestamp.
      // IMPORTANT: Do not await here; cache-hit should be as fast as possible for UI snappiness.
      // If this write fails, we still return the cached summary.
      idb
        .set({ [metaKey]: { ts: Date.now() } })
        .catch((e) => log(`[Summary] Cache HIT meta touch failed for ${uniqueKey}: ${e}`, "warn"));
      const result = {
        id: uniqueKey,
        blurb: cachedEntry.blurb,
        detailed: cachedEntry.detailed || "",
        todos: cachedEntry.todos || "",
        reminder: cachedEntry.reminder || null, // Object or null
        body: "", // Not needed when we return from cache
        subject: messageHeader.subject,
        fromSender: messageHeader.author,
      };
      indexHeader(messageHeader);
      return result;
    }
  } catch (cacheErr) {
    // log(`[TMDBG Summary] Cache lookup failed for ${uniqueKey}: ${cacheErr}`);
  }
  log(`[Summary] Cache MISS for message ${messageHeader.id} (${uniqueKey}) - generating via LLM...`);
  if (cacheOnly) {
    // If we arrive here, it means we don't have it cached, and we don't want the heavy path to run: signal absence with empty fields
    return {
      id: uniqueKey,
      blurb: "",
      detailed: "",
      todos: "",
      reminder: null, // Object or null
      body: "",
      subject: messageHeader.subject,
      fromSender: messageHeader.author,
    };
  }

  // Acquire per-message semaphore to prevent concurrent generation for the same message
  await _acquireSummarySemaphore(uniqueKey);
  try {
    // Heavy path – fetch full message and generate summary.
    try {
      const res = await generateSummary(messageHeader, highPriority);
      if (res) {
        indexHeader(messageHeader);
        return res;
      }
    } catch (e) {
      // log(`Error fetching summary for ${uniqueKey}: ${e}`);
    }
  } finally {
    _releaseSummarySemaphore(uniqueKey);
  }

  return null;
}

export async function generateSummary(messageHeader, highPriority = false) {
  const uniqueKey = await getUniqueMessageKey(messageHeader.id);
  const cacheKey = SUMMARY_PREFIX + uniqueKey;
  const metaKey = SUMMARY_TS_PREFIX + uniqueKey;

  // Check cache again after acquiring semaphore (in case another call populated it)
  try {
    const cachedEntry = (await idb.get(cacheKey))[cacheKey];
    if (cachedEntry) {
      log(`[Summary] Cache HIT in generateSummary for message ${messageHeader.id} (${uniqueKey})`, 'debug');
      // Touch the cache entry by updating its timestamp
      await idb.set({ [metaKey]: { ts: Date.now() } });
      return {
        id: uniqueKey,
        blurb: cachedEntry.blurb,
        detailed: cachedEntry.detailed || "",
        todos: cachedEntry.todos || "",
        reminder: cachedEntry.reminder || null, // Object or null
        body: "", // Not needed when we return from cache
        subject: messageHeader.subject,
        fromSender: messageHeader.author,
      };
    }
  } catch (cacheErr) {
    // Continue with generation if cache check fails
  }

  const full = await safeGetFull(messageHeader.id);
  const bodyHtml = await extractBodyFromParts(full, messageHeader.id);
  const plainBody = stripHtml(bodyHtml || "");

  // Log extracted body details for debugging (especially for spam emails moved to inbox)
  log(`${PFX}Body extraction for ${uniqueKey}: bodyHtml.length=${bodyHtml?.length ?? 0}, plainBody.length=${plainBody?.length ?? 0}`);
  if (plainBody.length < 50) {
    log(`${PFX}Short plainBody for ${uniqueKey}: "${plainBody.substring(0, 100)}"`);
  }

  // DISABLED: Pre-filter for HTML-only emails was incorrectly triggering for spam emails moved to inbox
  // The LLM should handle empty/short content cases instead of this heuristic
  // if (plainBody.length < 5) {
  //   const promoted = {
  //     todos: "None",
  //     blurb: "HTML-only email; likely promotional content.",
  //     reminder: null, // No reminder for promotional content
  //   };
  //   await idb.set({ [cacheKey]: promoted });
  //   await idb.set({ [metaKey]: { ts: Date.now() } });
  //   return promoted;
  // }

  // Get user name and KB content for system prompt
  const userName = await getUserName({ fullname: true });
  let userKBContent = "";
  try {
    const { getUserKBPrompt } = await import("./promptGenerator.js");
    userKBContent = (await getUserKBPrompt()) || "";
  } catch (e) {
    log(`${PFX}Failed to load KB for summary: ${e}`, "warn");
  }

  // Analyze email for no-reply filter
  const emailFilter = await analyzeEmailForReplyFilter(messageHeader);
  log(`[Summary] Filter status for ${uniqueKey}: isNoReply=${emailFilter.isNoReply}`);

  // Format email date with day of week for LLM context
  const emailDateObj = messageHeader.date ? new Date(messageHeader.date) : new Date();
  const emailDateFormatted = formatTimestampForAgent(emailDateObj);
  const emailDayOfWeek = emailDateObj.toLocaleDateString("en-US", { weekday: "long" });

  // Build single consolidated message that backend will process
  // Note: We send email_date (not current_time) so LLM reasons relative to the email
  const systemMsg = {
    role: "system",
    content: "system_prompt_summary",
    user_name: userName,
    user_kb_content: userKBContent,
    subject: messageHeader.subject || "Not Available",
    from_sender: messageHeader.author || "Unknown",
    email_date: emailDateFormatted,
    email_day_of_week: emailDayOfWeek,
    body: plainBody,
    is_noreply_address: emailFilter.isNoReply,
  };

  const resp = await sendChat([systemMsg], { ignoreSemaphore: highPriority, disableTools: false });
  if (!resp?.assistant) {
    log(`${PFX}LLM returned empty summary for ${uniqueKey}`, "error");
    return null;
  }

  const result = processSummaryResponse(resp.assistant);
  
  // Note: Date validation/correction is now handled by the backend post-processor
  // The backend converts relative dates (e.g., "next Thursday") to absolute YYYY-MM-DD
  // and ensures dates are in the future relative to the email date
  
  log(`${PFX}Summary result for ${uniqueKey}: has reminder=${!!result.reminder}, reminder type=${typeof result.reminder}`);
  if (result.reminder) {
    log(`${PFX}Reminder details: dueDate=${result.reminder.dueDate}, content="${result.reminder.content?.slice(0, 40)}..."`);
  }

  // Cache
  await idb.set({ [cacheKey]: result });
  await idb.set({ [metaKey]: { ts: Date.now() } });

  // Persist full chat exchange for debugging/auditing.
  saveChatLog("tabmail_summary", uniqueKey, [systemMsg], assistantResp);

  // Add more things to output for compatibility with old code
  result.id = uniqueKey;
  result.body = bodyHtml;
  result.subject = messageHeader.subject;
  result.fromSender = messageHeader.author;
  
  // Ensure reminder field exists as object or null (backward compatibility)
  if (!result.reminder) {
    result.reminder = null;
  }

  return result;
}
