// kbReminderGenerator.js – Generate KB-based reminders
// Thunderbird 142 MV3
// These reminders are based solely on the user's knowledge base content
// and are separate from email-based reminders generated from summaries

import { formatTimestampForAgent, getUserName } from "../../chat/modules/helpers.js";
import { SETTINGS } from "./config.js";
import { processJSONResponse, sendChat } from "./llm.js";
import { getUserKBPrompt } from "./promptGenerator.js";
import { log, saveChatLog } from "./utils.js";

// Storage key for KB reminder list
const KB_REMINDER_STORAGE_KEY = "reminder_kb_list";

// ----------------------------------------------------------
// Simple debouncing queue for KB reminder updates
// - First call executes immediately
// - Subsequent calls while one is running get queued
// - After completion, queued requests run after debounce delay
// ----------------------------------------------------------
let _kbReminderUpdateState = {
  isRunning: false,
  hasQueuedRequest: false,
  queueTimer: null,
  queuedForce: false,
};

const KB_REMINDER_DEBOUNCE_MS = SETTINGS.reminderGeneration?.debounceMs || 2000;

/**
 * Generate a simple hash from a string (for KB content comparison)
 * Using DJB2 hash algorithm (fast and good enough for our use case)
 */
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i); // hash * 33 + c
  }
  return hash >>> 0; // Convert to unsigned 32-bit integer
}

/**
 * Implementation of KB reminder generation
 * Analyzes knowledge base only to generate helpful reminders
 */
async function _kbReminderGenerationImpl(force = false) {
  try {
    log(`-- KB Reminder -- Starting KB reminder generation (force=${force})`);

    // Get user KB content
    const userKBContent = (await getUserKBPrompt()) || "";

    // Calculate hash of KB content to detect changes
    const contentHash = simpleHash(userKBContent);

    log(`-- KB Reminder -- Current KB content hash: ${contentHash}`);

    // Check if we already have reminders for this KB state
    if (!force) {
      try {
        log(`-- KB Reminder -- Checking if we have reminders for current KB state...`);
        const stored = await browser.storage.local.get(KB_REMINDER_STORAGE_KEY);
        const existingReminders = stored[KB_REMINDER_STORAGE_KEY];

        if (existingReminders) {
          log(
            `-- KB Reminder -- Stored hash: ${existingReminders.contentHash}, Current hash: ${contentHash}, Match: ${existingReminders.contentHash === contentHash}`
          );
        }

        if (
          existingReminders &&
          existingReminders.contentHash === contentHash &&
          Array.isArray(existingReminders.reminders)
        ) {
          log(
            `-- KB Reminder -- ✅ KB content unchanged (hash=${contentHash}), skipping generation`
          );
          return;
        }

        log(
          `-- KB Reminder -- ⚠️ Need to regenerate: existingReminders=${!!existingReminders}, hashMatch=${existingReminders?.contentHash === contentHash}`
        );
      } catch (e) {
        log(`-- KB Reminder -- ❌ Error checking existing KB reminders: ${e}`, "warn");
      }
    } else {
      log(`-- KB Reminder -- ⚠️ Force flag set, bypassing cache check`);
    }

    log(`-- KB Reminder -- 🚀 KB content changed or no reminders, generating new KB reminders...`);

    // Get user name for system prompt
    const userName = await getUserName({ fullname: true });

    // Build system message for LLM
    const systemMsg = {
      role: "system",
      content: "system_prompt_kb_reminder",
      user_name: userName,
      user_kb_content: userKBContent,
      time_stamp: formatTimestampForAgent(),
    };

    const requestStartTime = Date.now();

    let assistantResp;
    try {
      // Add timeout wrapper around sendChat
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("KB reminder LLM request timeout after 60s")), 60000)
      );

      const sendChatPromise = sendChat([systemMsg], { ignoreSemaphore: true });

      assistantResp = await Promise.race([sendChatPromise, timeoutPromise]);
    } catch (error) {
      const requestDuration = Date.now() - requestStartTime;
      log(`-- KB Reminder -- LLM request failed after ${requestDuration}ms: ${error}`, "error");
      saveChatLog("tabmail_kb_reminder_failed", Date.now(), [systemMsg], `ERROR: ${error}`);
      return;
    }

    const requestDuration = Date.now() - requestStartTime;
    log(`-- KB Reminder -- LLM request completed in ${requestDuration}ms`);

    // Log the chat exchange for debugging
    saveChatLog("tabmail_kb_reminder", Date.now(), [systemMsg], assistantResp);

    if (!assistantResp) {
      log(`-- KB Reminder -- LLM returned empty response for KB reminder generation`, "warn");
      return;
    }

    // Parse strict JSON: { reminders: [...] }
    const parsed = processJSONResponse(assistantResp) || {};

    if (!Array.isArray(parsed.reminders)) {
      log(
        `-- KB Reminder -- Invalid response format. Expected 'reminders' array, got: ${JSON.stringify(parsed).slice(0, 200)}`,
        "error"
      );
      return;
    }

    const reminders = parsed.reminders;
    log(`-- KB Reminder -- Generated ${reminders.length} KB reminders`);

    // Validate reminder format
    // Note: Date conversion (relative to absolute) is now handled by backend post-processor
    const validReminders = reminders.filter((r) => {
      if (typeof r !== "object" || r === null) return false;
      if (typeof r.content !== "string" || !r.content.trim()) return false;
      if (r.dueDate !== null && typeof r.dueDate !== "string") return false;
      return true;
    });

    if (validReminders.length !== reminders.length) {
      log(
        `-- KB Reminder -- Filtered out ${reminders.length - validReminders.length} invalid reminders`,
        "warn"
      );
    }

    // Store KB reminders with content hash
    const reminderData = {
      reminders: validReminders,
      contentHash: contentHash,
      generatedAt: Date.now(),
    };

    await browser.storage.local.set({ [KB_REMINDER_STORAGE_KEY]: reminderData });
    log(
      `-- KB Reminder -- ✅ Stored ${validReminders.length} KB reminders (hash=${contentHash})`
    );
  } catch (e) {
    log(`-- KB Reminder -- Error in KB reminder generation: ${e}`, "error");
    console.error("KB reminder generation error:", e);
  }
}

/**
 * Queue handler for KB reminder generation with debouncing
 */
async function _queueKBReminderGeneration(force = false) {
  log(`-- KB Reminder -- _queueKBReminderGeneration called (force=${force}, isRunning=${_kbReminderUpdateState.isRunning})`);

  if (!_kbReminderUpdateState.isRunning) {
    // Not running, execute immediately
    _kbReminderUpdateState.isRunning = true;
    log(`-- KB Reminder -- Starting KB reminder generation immediately`);

    // Clear any pending timer since we're executing now
    if (_kbReminderUpdateState.queueTimer) {
      clearTimeout(_kbReminderUpdateState.queueTimer);
      _kbReminderUpdateState.queueTimer = null;
      log(`-- KB Reminder -- Cleared pending debounce timer`);
    }

    try {
      await _kbReminderGenerationImpl(force);
    } catch (e) {
      log(`-- KB Reminder -- Error during KB reminder generation: ${e}`, "error");
    } finally {
      _kbReminderUpdateState.isRunning = false;

      // After completion, check if there's a queued request
      if (_kbReminderUpdateState.hasQueuedRequest) {
        log(
          `-- KB Reminder -- Queued request found, scheduling with debounce (${KB_REMINDER_DEBOUNCE_MS}ms)`
        );
        const queuedForce = _kbReminderUpdateState.queuedForce;
        _kbReminderUpdateState.hasQueuedRequest = false;
        _kbReminderUpdateState.queuedForce = false;

        _kbReminderUpdateState.queueTimer = setTimeout(async () => {
          _kbReminderUpdateState.queueTimer = null;
          log(
            `-- KB Reminder -- Debounce timer expired, executing queued request (force=${queuedForce})`
          );
          await _queueKBReminderGeneration(queuedForce);
        }, KB_REMINDER_DEBOUNCE_MS);
      } else {
        log(`-- KB Reminder -- No queued requests, idle`);
      }
    }
  } else {
    // Already running, queue a request
    log(`-- KB Reminder -- KB reminder generation in progress, queuing request (force=${force})`);
    _kbReminderUpdateState.hasQueuedRequest = true;

    // If this request has force=true, remember it for the queued execution
    if (force) {
      _kbReminderUpdateState.queuedForce = true;
    }

    // Clear existing timer if any (this implements the debounce - only last call matters)
    if (_kbReminderUpdateState.queueTimer) {
      clearTimeout(_kbReminderUpdateState.queueTimer);
      _kbReminderUpdateState.queueTimer = null;
      log(`-- KB Reminder -- Cleared existing debounce timer for new queued request`);
    }
  }
}

/**
 * Public API: Generate and store KB reminders based on current knowledge base
 * Uses smart debouncing queue to prevent concurrent updates and collapse rapid calls
 * @param {boolean} force - If true, regenerate even if KB hasn't changed
 */
export async function generateKBReminders(force = false) {
  return _queueKBReminderGeneration(force);
}

/**
 * Cleanup function to cancel any pending KB reminder generation
 * Should be called when extension is suspending/uninstalling
 */
export function cleanupKBReminderGenerator() {
  if (_kbReminderUpdateState.queueTimer) {
    clearTimeout(_kbReminderUpdateState.queueTimer);
    _kbReminderUpdateState.queueTimer = null;
    log(`-- KB Reminder -- Cancelled pending KB reminder generation timer`);
  }
  _kbReminderUpdateState.hasQueuedRequest = false;
  _kbReminderUpdateState.queuedForce = false;
}

/**
 * Get KB reminders from storage
 * @returns {Promise<Array>} Array of KB reminder objects
 */
export async function getKBReminders() {
  try {
    const stored = await browser.storage.local.get(KB_REMINDER_STORAGE_KEY);
    const reminderData = stored[KB_REMINDER_STORAGE_KEY];
    
    if (reminderData && Array.isArray(reminderData.reminders)) {
      return reminderData.reminders;
    }
    return [];
  } catch (e) {
    log(`-- KB Reminder -- Error getting KB reminders: ${e}`, "error");
    return [];
  }
}

