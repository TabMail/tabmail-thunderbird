import { getUserName } from "../../chat/modules/helpers.js";
import { SETTINGS } from "./config.js";
import * as idb from "./idbStorage.js";
import { processJSONResponse, sendChat } from "./llm.js";
import { analyzeEmailForReplyFilter } from "./messagePrefilter.js";
import { getUserActionPrompt } from "./promptGenerator.js";
import { isInternalSender } from "./senderFilter.js";
import { getSummary } from "./summaryGenerator.js";
import { actionFromLiveTagIds, isMessageInInboxByUniqueKey } from "./tagHelper.js";
import { resolveGmailAction } from "./gmailLabelSync.js";
import {
  extractBodyFromParts,
  getUniqueMessageKey,
  log,
  safeGetFull,
  saveChatLog,
  stripHtml,
} from "./utils.js";

const PFX = "[ActionGen] ";
const ACTION_PREFIX = "action:";
const ACTION_TS_PREFIX = "action:ts:";

// Per-message semaphores to prevent concurrent action generation for the same message
const _actionSemaphores = new Map();

async function _acquireActionSemaphore(uniqueKey) {
  // Ensure semaphore exists atomically
  if (!_actionSemaphores.has(uniqueKey)) {
    _actionSemaphores.set(uniqueKey, { active: false, queue: [] });
  }
  
  const semaphore = _actionSemaphores.get(uniqueKey);
  
  // Atomic check-and-set to prevent race condition
  if (semaphore.active) {
    // Already active, queue this request
    await new Promise((resolve) => semaphore.queue.push(resolve));
    return;
  }
  
  // Mark as active immediately to prevent race condition
  semaphore.active = true;
}

function _releaseActionSemaphore(uniqueKey) {
  const semaphore = _actionSemaphores.get(uniqueKey);
  if (!semaphore) return;
  
  if (semaphore.queue.length > 0) {
    const next = semaphore.queue.shift();
    next();
  } else {
    semaphore.active = false;
    // Clean up empty semaphores to prevent memory leaks
    _actionSemaphores.delete(uniqueKey);
  }
}

// Write-once record for the original agent-assigned action.
// Key format: "action:orig:<uniqueKey>" where <uniqueKey> is the summaryId / header Message-Id.
// This value should never be updated once written.
async function recordOriginalActionOnce(uniqueKey, action) {
  try {
    if (!uniqueKey) return;
    const origKey = ACTION_PREFIX + "orig:" + uniqueKey;
    const existing = await idb.get(origKey);
    if (!existing[origKey]) {
      await idb.set({ [origKey]: action });
      try {
        log(`${PFX}Wrote original action '${action}' for ${uniqueKey}`);
      } catch (_) {}
    }
  } catch (e) {
    try {
      log(
        `${PFX}Failed to write original action for ${uniqueKey}: ${e}`,
        "warn"
      );
    } catch (_) {}
  }
}

// Write-once record for the original user action prompt used during action generation.
// Key format: "action:userprompt:<uniqueKey>" where <uniqueKey> is the summaryId / header Message-Id.
// This value should never be updated once written.
async function recordOriginalUserPromptOnce(uniqueKey, userPrompt) {
  try {
    if (!uniqueKey) return;
    const userPromptKey = ACTION_PREFIX + "userprompt:" + uniqueKey;
    const existing = await idb.get(userPromptKey);
    if (!existing[userPromptKey]) {
      await idb.set({ [userPromptKey]: userPrompt });
      try {
        log(`${PFX}Wrote original user prompt for ${uniqueKey}`);
      } catch (_) {}
    }
  } catch (e) {
    try {
      log(
        `${PFX}Failed to write original user prompt for ${uniqueKey}: ${e}`,
        "warn"
      );
    } catch (_) {}
  }
}

/**
 * Removes expired action entries from idb.
 *
 * The TTL is taken from SETTINGS.actionTTLSeconds. Any entry whose stored
 * timestamp is older than `now - TTL` will be deleted.
 * 
 * Additionally, for action TTL checks, entries for messages that are no longer
 * in inbox are immediately evicted regardless of TTL. This prevents "dangling"
 * cache entries when messages leave inbox but thread bubbles keep the TTL from
 * expiring naturally.
 */
export async function purgeExpiredActionEntries() {
    const ttlMs = SETTINGS.actionTTLSeconds * 1000;
    const cutoff = Date.now() - ttlMs;

    const allKeys = await idb.getAllKeys();
    const payloadsToRemove = new Set();
    const metaToRemove = new Set();

    // Get timestamp entries for action cache
    const timestampKeys = allKeys.filter(key => key.startsWith(ACTION_TS_PREFIX));
    const timestampEntries = await idb.get(timestampKeys);

    // Check entries that are expired by TTL
    for (const [key, val] of Object.entries(timestampEntries)) {
        const ts = val?.ts ?? 0;
        if (typeof ts !== "number" || ts < cutoff) {
            // Derive payload key from meta key
            const uniqueKey = key.slice(ACTION_TS_PREFIX.length);
            const payloadKey = ACTION_PREFIX + uniqueKey;
            payloadsToRemove.add(payloadKey);
            metaToRemove.add(key);
        } else {
            // For action TTL: also check if message is still in inbox, regardless of TTL
            // This prevents dangling entries when messages leave inbox but thread bubbles
            // keep the TTL from expiring naturally.
            const uniqueKey = key.slice(ACTION_TS_PREFIX.length);
            const isInInbox = await isMessageInInboxByUniqueKey(uniqueKey);
            if (!isInInbox) {
                log(`${PFX}Evicting action cache entry (not in inbox): uniqueKey=${uniqueKey}`);
                const payloadKey = ACTION_PREFIX + uniqueKey;
                payloadsToRemove.add(payloadKey);
                metaToRemove.add(key);
            }
        }
    }

    // Robustness: handle legacy/buggy cases where action payload exists but meta ts key is missing.
    // Only target the main action cache payload keys ("action:<uniqueKey>"), not write-once metadata keys.
    const payloadKeys = allKeys.filter((key) => {
        if (!key.startsWith(ACTION_PREFIX)) return false;
        if (key.startsWith(ACTION_TS_PREFIX)) return false;
        if (key.startsWith(ACTION_PREFIX + "orig:")) return false;
        if (key.startsWith(ACTION_PREFIX + "userprompt:")) return false;
        if (key.startsWith(ACTION_PREFIX + "justification:")) return false;
        return true;
    });
    for (const payloadKey of payloadKeys) {
        try {
            const uniqueKey = payloadKey.slice(ACTION_PREFIX.length);
            const metaKey = ACTION_TS_PREFIX + uniqueKey;
            if (!timestampEntries || !Object.prototype.hasOwnProperty.call(timestampEntries, metaKey)) {
                payloadsToRemove.add(payloadKey);
            } else {
                // For orphaned payloads with valid meta: also check inbox status
                const isInInbox = await isMessageInInboxByUniqueKey(uniqueKey);
                if (!isInInbox) {
                    log(`${PFX}Evicting orphaned action cache entry (not in inbox): uniqueKey=${uniqueKey}`);
                    payloadsToRemove.add(payloadKey);
                    metaToRemove.add(metaKey);
                }
            }
        } catch (_) {}
    }

    const toRemove = [...payloadsToRemove, ...metaToRemove];
    if (toRemove.length > 0) {
        await idb.remove(toRemove);
        const removedPayload = payloadsToRemove.size;
        const removedMeta = metaToRemove.size;
        const orphanedPayload = Math.max(0, removedPayload - removedMeta);
        log(`${PFX}Purged ${toRemove.length} expired action entries (payload=${removedPayload}, meta=${removedMeta}, payloadWithoutMeta=${orphanedPayload}).`);
    }
}


export async function getAction(messageHeader, { forceRecompute = false } = {}) {
  log(`${PFX}>>> getAction CALLED for message ${messageHeader.id} subject="${messageHeader.subject}" forceRecompute=${forceRecompute}`);

  // Internal/self-sent messages should never have an action cache entry.
  // We still allow summaries, but skip action generation and skip cache touch/write.
  try {
    const internal = await isInternalSender(messageHeader);
    if (internal) {
      log(`${PFX}Internal/self-sent detected for message ${messageHeader.id}; skipping action (no cache).`);
      return null;
    }
  } catch (_) {}

  const uniqueKey = await getUniqueMessageKey(messageHeader.id);
  log(`${PFX}UniqueKey for ${messageHeader.id}: ${uniqueKey}`);

  const cacheKey = ACTION_PREFIX + uniqueKey;
  const metaKey = ACTION_TS_PREFIX + uniqueKey;

  // Check cache - if it exists, touch it and return (skip when forced recompute)
  if (!forceRecompute) {
    const existing = await idb.get(cacheKey);
    if (existing[cacheKey]) {
      log(`${PFX}>>> Cache HIT for message ${messageHeader.id} (${uniqueKey}): returning cached action="${existing[cacheKey]}" (LLM will NOT run)`);
      // Touch the cache entry by updating its timestamp
      await idb.set({ [metaKey]: { ts: Date.now() } });
      return existing[cacheKey];
    }
  }

  log(`${PFX}Cache MISS for message ${messageHeader.id} (${uniqueKey}) - generating via LLM...`);
  // Acquire per-message semaphore to prevent concurrent generation for the same message
  await _acquireActionSemaphore(uniqueKey);
  try {
    // Check cache again after acquiring semaphore (in case another call populated it)
    if (!forceRecompute) {
      const existingAfterSemaphore = await idb.get(cacheKey);
      if (existingAfterSemaphore[cacheKey]) {
        log(`${PFX}Cache HIT after semaphore for message ${messageHeader.id} (${uniqueKey}): ${existingAfterSemaphore[cacheKey]}`);
        // Touch the cache entry by updating its timestamp
        await idb.set({ [metaKey]: { ts: Date.now() } });
        return existingAfterSemaphore[cacheKey];
      }
    }

    // "First compute wins": check if another TM instance (e.g. iOS) already
    // tagged this message via IMAP. If so, adopt the tag without LLM computation.
    // Skip when forceRecompute is set (user explicitly requested fresh LLM computation).
    if (!forceRecompute) {
      try {
        const freshHeader = await browser.messages.get(messageHeader.id);
        let imapAction = actionFromLiveTagIds(freshHeader?.tags);
        // If IMAP tags already give us an action, use it directly — no need
        // to call the Gmail REST API (avoids latency and potential failures
        // on non-Gmail accounts).  Only fall back to Gmail label check when
        // IMAP keywords are missing (e.g. Gmail labels set via REST API by
        // iOS won't appear as IMAP keywords).
        if (!imapAction) {
          imapAction = await resolveGmailAction(freshHeader, imapAction);
        }
        if (imapAction) {
          log(`${PFX}IMAP/folder tag HIT for ${messageHeader.id} (${uniqueKey}): adopting action="${imapAction}" (no LLM)`);
          await idb.set({ [cacheKey]: imapAction, [metaKey]: { ts: Date.now() } });
          await recordOriginalActionOnce(uniqueKey, imapAction);
          return imapAction;
        }
      } catch (eImapCheck) {
        log(`${PFX}IMAP tag check failed for ${messageHeader.id}: ${eImapCheck}`, "warn");
      }
    }

    // Get the body from the full message to send to the LLM
    const full = await safeGetFull(messageHeader.id);
    const bodyHtml = await extractBodyFromParts(full, messageHeader.id);
    const plainBody = stripHtml(bodyHtml || "");

    // Log extracted body details for debugging (especially for spam emails moved to inbox)
    log(`${PFX}Body extraction for ${uniqueKey}: bodyHtml.length=${bodyHtml?.length ?? 0}, plainBody.length=${plainBody?.length ?? 0}`);
    if ((plainBody?.length ?? 0) < 50) {
      log(`${PFX}Short plainBody for ${uniqueKey}: "${plainBody?.substring(0, 100) ?? ''}"`);
    }

    // DISABLED: Pre-filter for empty body was incorrectly triggering for spam emails moved to inbox
    // The LLM should handle empty/short content cases instead of this heuristic
    // if (!plainBody || plainBody.trim().length === 0) {
    //   log(`${PFX}Plain body is empty for ${uniqueKey}. Returning delete.`);
    //   return "delete";
    // }

    const userName = await getUserName({ fullname: true });

    // Get user-defined action guidelines (if present)
    let userActionPrompt = "";
    try {
      userActionPrompt = await getUserActionPrompt();
    } catch (e) {
      log(`${PFX}Failed to load user_action.md: ${e}`, "error");
    }

    // Get summary data for additional context (todos and summary)
    let summaryData = null;
    try {
      summaryData = await getSummary(messageHeader, false, false);
    } catch (e) {
      log(`${PFX}Failed to get summary data for ${uniqueKey}: ${e}`, "warn");
    }

    // Analyze email for no-reply filter
    const emailFilter = await analyzeEmailForReplyFilter(messageHeader);
    log(`${PFX}Filter status for ${uniqueKey}: isNoReply=${emailFilter.isNoReply}`);

    // Build single consolidated message that backend will process
    const systemMsg = {
      role: "system",
      content: "system_prompt_action",
      user_name: userName,
      user_action_prompt: userActionPrompt || "",
      body: plainBody,
      subject: messageHeader.subject || "Not Available",
      from_sender: messageHeader.author || "Unknown",
      todo: summaryData?.todos || "Not Available",
      summary: summaryData?.blurb || "Not Available",
      is_noreply_address: emailFilter.isNoReply,
    };

    log(`${PFX}Preparing LLM call for ${uniqueKey}. summaryData=${summaryData ? 'EXISTS' : 'NULL'}, blurb="${summaryData?.blurb?.substring(0, 50) || 'N/A'}..."`);

    // Make multiple parallel LLM calls and pick the mode result
    const parallelCalls = SETTINGS.actionGenerationParallelCalls;
    log(`${PFX}>>> Making ${parallelCalls} parallel LLM calls for ${uniqueKey}`);
    
    const promises = Array(parallelCalls).fill().map(() => sendChat([systemMsg]));
    const responses = await Promise.all(promises);

    // Filter out empty responses and parse them
    const validResponses = responses
      .filter(resp => resp?.assistant)
      .map(resp => processJSONResponse(resp.assistant))
      .filter(parsed => parsed.action);
    
    if (validResponses.length === 0) {
      log(`${PFX}No valid LLM responses for ${uniqueKey}`, "warn");
      return null;
    }
    
    // Extract actions and normalize them
    const actions = validResponses
      .map(parsed => parsed.action)
      .filter(action => typeof action === "string")
      .map(action => action.trim().toLowerCase())
      .filter(action => action);
    
    if (actions.length === 0) {
      log(`${PFX}No valid actions found in responses for ${uniqueKey}`, "warn");
      return null;
    }
    
    // Count action occurrences
    const actionCounts = {};
    actions.forEach(action => {
      actionCounts[action] = (actionCounts[action] || 0) + 1;
    });
    
    // Find the maximum count (mode)
    const maxCount = Math.max(...Object.values(actionCounts));
    
    // Get all actions with the maximum count
    const tiedActions = Object.keys(actionCounts).filter(action => actionCounts[action] === maxCount);
    
    // Priority ranking for tie-breaking: delete < archive < none < reply
    const priorityOrder = ["delete", "archive", "none", "reply"];
    
    let selectedAction;
    if (tiedActions.length === 1) {
      selectedAction = tiedActions[0];
    } else {
      // Break tie by choosing the lowest priority action
      selectedAction = priorityOrder.find(action => tiedActions.includes(action)) || tiedActions[0];
      log(`${PFX}Tie detected for ${uniqueKey}, choosing lowest priority: ${selectedAction}`, "info");
    }
    
    log(`${PFX}Action distribution for ${uniqueKey}: ${JSON.stringify(actionCounts)}, selected: ${selectedAction}`);

    // Store the action
    const action = selectedAction;
    await idb.set({ [cacheKey]: action });
    await idb.set({ [metaKey]: { ts: Date.now() } });
    await recordOriginalActionOnce(uniqueKey, action);

    // Store the original user action prompt that was used during generation
    if (userActionPrompt) {
      await recordOriginalUserPromptOnce(uniqueKey, userActionPrompt);
    }

    // Persist full chat exchange for debugging/auditing.
    // Save all responses for debugging purposes
    const allResponses = responses.map((resp, idx) => `Response ${idx + 1}: ${resp}`).join('\n\n');
    saveChatLog("tabmail_action", uniqueKey, [systemMsg], allResponses);

    return action;
  } finally {
    _releaseActionSemaphore(uniqueKey);
  }
}
