// kbReminderGenerator.js – Extract KB-based reminders directly from KB content
// Thunderbird 145 MV3
// These reminders are parsed directly from the user's knowledge base
// Format expected: "- Reminder: Due YYYY/MM/DD, reminder text"

import { getUserKBPrompt } from "./promptGenerator.js";
import { log } from "./utils.js";

// Storage key for KB reminder list
const KB_REMINDER_STORAGE_KEY = "reminder_kb_list";

/**
 * Generate a simple hash from a string (for KB content comparison)
 * Using DJB2 hash algorithm (fast and good enough for our use case)
 */
function simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 33) ^ str.charCodeAt(i);
  }
  return hash >>> 0;
}

/**
 * Parse reminders directly from KB content
 * Format: "- Reminder: Due YYYY/MM/DD, reminder text"
 * Returns array of { dueDate: "YYYY-MM-DD" | null, content: "reminder text" }
 */
function parseRemindersFromKB(kbContent) {
  if (!kbContent || !kbContent.trim()) {
    return [];
  }

  const reminders = [];
  const lines = kbContent.split('\n');

  // Regex to match: "- Reminder: Due YYYY/MM/DD, reminder text"
  const reminderRegex = /^-\s*Reminder:\s*Due\s+(\d{4})\/(\d{2})\/(\d{2}),\s*(.+)$/i;

  for (const line of lines) {
    const trimmedLine = line.trim();
    const match = trimmedLine.match(reminderRegex);

    if (match) {
      const [, year, month, day, content] = match;
      const dueDate = `${year}-${month}-${day}`;

      reminders.push({
        dueDate,
        content: content.trim(),
      });
    }
  }

  return reminders;
}

/**
 * Filter out past-due reminders (more than 1 day old)
 */
function filterActiveReminders(reminders) {
  const now = new Date();
  // Set to start of today for comparison
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Allow 1 day grace period
  const cutoffDate = new Date(today.getTime() - 24 * 60 * 60 * 1000);

  return reminders.filter(reminder => {
    if (!reminder.dueDate) {
      // No due date = always active
      return true;
    }

    try {
      const dueDate = new Date(reminder.dueDate);
      // Keep if due date is after cutoff (today - 1 day)
      return dueDate >= cutoffDate;
    } catch {
      // Invalid date = keep it
      return true;
    }
  });
}

/**
 * Implementation of KB reminder extraction
 * Parses reminders directly from KB content (no LLM call)
 */
async function _kbReminderGenerationImpl(force = false) {
  try {
    log(`-- KB Reminder -- Starting KB reminder extraction (force=${force})`);

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
            `-- KB Reminder -- ✅ KB content unchanged (hash=${contentHash}), skipping extraction`
          );
          return;
        }

        log(
          `-- KB Reminder -- ⚠️ Need to re-extract: existingReminders=${!!existingReminders}, hashMatch=${existingReminders?.contentHash === contentHash}`
        );
      } catch (e) {
        log(`-- KB Reminder -- ❌ Error checking existing KB reminders: ${e}`, "warn");
      }
    } else {
      log(`-- KB Reminder -- ⚠️ Force flag set, bypassing cache check`);
    }

    log(`-- KB Reminder -- 🚀 Extracting reminders from KB content...`);

    // Parse reminders directly from KB content
    const allReminders = parseRemindersFromKB(userKBContent);
    log(`-- KB Reminder -- Found ${allReminders.length} reminder entries in KB`);

    // Filter out past-due reminders
    const activeReminders = filterActiveReminders(allReminders);
    log(`-- KB Reminder -- ${activeReminders.length} active reminders after filtering`);

    // Store KB reminders with content hash
    const reminderData = {
      reminders: activeReminders,
      contentHash: contentHash,
      generatedAt: Date.now(),
    };

    await browser.storage.local.set({ [KB_REMINDER_STORAGE_KEY]: reminderData });
    log(
      `-- KB Reminder -- ✅ Stored ${activeReminders.length} KB reminders (hash=${contentHash})`
    );
  } catch (e) {
    log(`-- KB Reminder -- Error in KB reminder extraction: ${e}`, "error");
    console.error("KB reminder extraction error:", e);
  }
}

// ----------------------------------------------------------
// Simple debouncing queue for KB reminder updates
// ----------------------------------------------------------
let _kbReminderUpdateState = {
  isRunning: false,
  hasQueuedRequest: false,
  queueTimer: null,
  queuedForce: false,
};

const KB_REMINDER_DEBOUNCE_MS = 2000;

/**
 * Queue handler for KB reminder extraction with debouncing
 */
async function _queueKBReminderGeneration(force = false) {
  log(`-- KB Reminder -- _queueKBReminderGeneration called (force=${force}, isRunning=${_kbReminderUpdateState.isRunning})`);

  if (!_kbReminderUpdateState.isRunning) {
    // Not running, execute immediately
    _kbReminderUpdateState.isRunning = true;
    log(`-- KB Reminder -- Starting KB reminder extraction immediately`);

    // Clear any pending timer since we're executing now
    if (_kbReminderUpdateState.queueTimer) {
      clearTimeout(_kbReminderUpdateState.queueTimer);
      _kbReminderUpdateState.queueTimer = null;
      log(`-- KB Reminder -- Cleared pending debounce timer`);
    }

    try {
      await _kbReminderGenerationImpl(force);
    } catch (e) {
      log(`-- KB Reminder -- Error during KB reminder extraction: ${e}`, "error");
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
    log(`-- KB Reminder -- KB reminder extraction in progress, queuing request (force=${force})`);
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
 * Public API: Extract and store KB reminders based on current knowledge base
 * Uses smart debouncing queue to prevent concurrent updates and collapse rapid calls
 * @param {boolean} force - If true, re-extract even if KB hasn't changed
 */
export async function generateKBReminders(force = false) {
  return _queueKBReminderGeneration(force);
}

/**
 * Cleanup function to cancel any pending KB reminder extraction
 * Should be called when extension is suspending/uninstalling
 */
export function cleanupKBReminderGenerator() {
  if (_kbReminderUpdateState.queueTimer) {
    clearTimeout(_kbReminderUpdateState.queueTimer);
    _kbReminderUpdateState.queueTimer = null;
    log(`-- KB Reminder -- Cancelled pending KB reminder extraction timer`);
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
