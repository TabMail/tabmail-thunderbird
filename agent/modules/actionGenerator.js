/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { getUserName } from "../../chat/modules/helpers.js";
import { SETTINGS } from "./config.js";
import * as idb from "./idbStorage.js";
import { processJSONResponse, sendChat } from "./llm.js";
import { analyzeEmailForReplyFilter } from "./messagePrefilter.js";
import { getUserActionPrompt } from "./promptGenerator.js";
import { isInternalSender } from "./senderFilter.js";
import { getSummary } from "./summaryGenerator.js";
import { beginAutomaticWork, payloadKey, purgeExpired, setAction, touchAction } from "./actionCache.js";
import {
  extractBodyFromParts,
  getRealSubject,
  getUniqueMessageKey,
  indexHeader,
  log,
  safeGetFull,
  saveChatLog,
  stripHtml,
} from "./utils.js";

const PFX = "[ActionGen] ";

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

export function purgeExpiredActionEntries() {
  return purgeExpired({ cutoffTs: Date.now() - SETTINGS.actionTTLSeconds * 1000 });
}

async function _finalAction(header, action) {
  if (action !== "reply") return action;
  try {
    const folder = header.folder;
    let nativeKey = -1;
    try { nativeKey = await browser.tmHdr.getMsgKey(folder.id, header.id, folder.path); } catch (_) {}
    if (await browser.tmHdr.getReplied(folder.id, nativeKey, folder.path, header.headerMessageId || "")) return "none";
  } catch (_) {}
  return action;
}

export async function getAction(messageHeader, { forceRecompute = false, token } = {}) {
  log(`${PFX}>>> getAction CALLED for message ${messageHeader.id} subject="${messageHeader.subject}" forceRecompute=${forceRecompute}`);

  const uniqueKey = await getUniqueMessageKey(messageHeader);
  token ??= beginAutomaticWork(uniqueKey);
  try { indexHeader(messageHeader); } catch (_) {}
  const cachedResult = async value => {
    await touchAction(uniqueKey);
    const finalAction = await _finalAction(messageHeader, value);
    if (finalAction !== value) await setAction(messageHeader, finalAction, { token });
    return finalAction;
  };

  // Internal/self-sent messages should never have an action cache entry.
  // We still allow summaries, but skip action generation and skip cache touch/write.
  try {
    const internal = await isInternalSender(messageHeader);
    if (internal) {
      log(`${PFX}Internal/self-sent detected for message ${messageHeader.id}; skipping action (no cache).`);
      return null;
    }
  } catch (_) {}

  log(`${PFX}UniqueKey for ${messageHeader.id}: ${uniqueKey}`);

  const cacheKey = payloadKey(uniqueKey);

  // Check cache. No IMAP/Gmail "verify remote tag" branch anymore —
  // cross-instance sync is covered by the Device Sync probe below.
  if (!forceRecompute) {
    const existing = await idb.get(cacheKey);
    if (existing[cacheKey]) {
      log(`${PFX}>>> Cache HIT for message ${messageHeader.id} (${uniqueKey}): returning cached action="${existing[cacheKey]}" (LLM will NOT run)`);
      // Touch the cache entry by updating its timestamp
      return cachedResult(existing[cacheKey]);
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
        return cachedResult(existingAfterSemaphore[cacheKey]);
      }
    }

    // Device sync probe: fire non-blocking, race with local body fetch.
    // Don't block on the 2s WebSocket timeout — overlap device sync latency with body I/O.
    let deviceSyncProbePromise = null;
    if (!forceRecompute) {
      try {
        const { probeAICache } = await import("./deviceSync.js");
        deviceSyncProbePromise = probeAICache(messageHeader.headerMessageId, "action");
      } catch (probeErr) {
        log(`${PFX}Device sync probe init failed for ${uniqueKey}: ${probeErr}`, "warn");
      }
    }

    // Get the body from the full message to send to the LLM
    const full = await safeGetFull(messageHeader.id, messageHeader);

    // Check if device sync resolved during body fetch (natural ~50-500ms window).
    if (deviceSyncProbePromise) {
      try {
        const peerAction = await Promise.race([
          deviceSyncProbePromise,
          new Promise((r) => setTimeout(() => r(null), 500)),
        ]);
        if (peerAction) {
          log(`${PFX}Device sync cache HIT for ${uniqueKey} — using peer action="${peerAction}" (LLM skipped)`);
          const action = await _finalAction(messageHeader, peerAction);
          await setAction(messageHeader, action, { token, meta: { orig: action } });
          return action;
        }
      } catch (probeErr) {
        log(`${PFX}Device sync probe failed for ${uniqueKey}: ${probeErr}`, "warn");
      }
    }

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

    // Analyze email for no-reply and unsubscribe filters
    // This comprehensive check includes full message analysis
    const emailFilter = await analyzeEmailForReplyFilter(messageHeader, full, plainBody);
    log(`${PFX}Filter status for ${uniqueKey}: isNoReply=${emailFilter.isNoReply}, hasUnsubscribe=${emailFilter.hasUnsubscribe}`);

    // Build single consolidated message that backend will process
    const systemMsg = {
      role: "system",
      content: "system_prompt_action",
      user_name: userName,
      user_action_prompt: userActionPrompt || "",
      body: plainBody,
      subject: (await getRealSubject(messageHeader)) || "Not Available",
      from_sender: messageHeader.author || "Unknown",
      todo: summaryData?.todos || "Not Available",
      summary: summaryData?.blurb || "Not Available",
      is_noreply_address: emailFilter.isNoReply,
      has_unsubscribe_link: emailFilter.hasUnsubscribe,
    };

    log(`${PFX}Preparing LLM call for ${uniqueKey}. summaryData=${summaryData ? 'EXISTS' : 'NULL'}, blurb="${summaryData?.blurb?.substring(0, 50) || 'N/A'}..."`);

    // Make multiple parallel LLM calls and pick the mode result
    const parallelCalls = SETTINGS.actionGenerationParallelCalls;
    log(`${PFX}>>> Making ${parallelCalls} parallel LLM calls for ${uniqueKey}`);
    
    const promises = Array(parallelCalls).fill().map(() => sendChat([systemMsg]));
    const responses = await Promise.all(promises);

    // Extract action value directly via regex — resilient to truncated JSON
    // from provider output limits (reasoning tokens can exhaust the budget).
    // The "action" field is always emitted first, so even truncated responses have it.
    const validResponses = responses
      .filter(resp => resp?.assistant)
      .map(resp => {
        // Try JSON parse first, fall back to regex extraction
        const parsed = processJSONResponse(resp.assistant);
        if (parsed?.action) return parsed;
        // Regex fallback for truncated JSON
        const match = resp.assistant.match(/"action"\s*:\s*"(\w+)"/);
        if (match) return { action: match[1] };
        return null;
      })
      .filter(parsed => parsed?.action);
    
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

    const action = await _finalAction(messageHeader, selectedAction);
    await setAction(messageHeader, action, { token, meta: { orig: action, userprompt: userActionPrompt || undefined } });

    // Persist full chat exchange for debugging/auditing.
    // Save all responses for debugging purposes
    const allResponses = responses.map((resp, idx) => `Response ${idx + 1}: ${resp}`).join('\n\n');
    saveChatLog("tabmail_action", uniqueKey, [systemMsg], allResponses);

    return action;
  } finally {
    _releaseActionSemaphore(uniqueKey);
  }
}
