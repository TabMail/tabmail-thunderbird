// reminderStateStore.js – Minimal state store for disabled reminders
// Thunderbird 145 MV3
//
// Only stores hashes of DISABLED reminders. Key miss = enabled.
// Orphaned hashes are cleaned up when buildReminderList syncs.

import { log } from "./utils.js";

// Storage key for disabled reminder hashes
const DISABLED_REMINDERS_KEY = "disabled_reminders";

/**
 * Generate a stable hash for a reminder
 * - For message reminders: use uniqueId (stable across regenerations)
 * - For KB reminders: hash the content
 * @param {Object} reminder - Reminder object
 * @returns {string} Stable hash key
 */
export function hashReminder(reminder) {
  if (reminder.source === "message" && reminder.uniqueId) {
    return `m:${reminder.uniqueId}`;
  } else if (reminder.source === "kb") {
    // Simple hash of content for KB reminders
    const content = reminder.content || "";
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return `k:${hash.toString(36)}`;
  }
  // Fallback
  return `o:${(reminder.content || "").slice(0, 32)}`;
}

/**
 * Get set of disabled hashes from storage
 * @returns {Promise<Set<string>>}
 */
export async function getDisabledHashes() {
  try {
    const stored = await browser.storage.local.get({ [DISABLED_REMINDERS_KEY]: [] });
    return new Set(stored[DISABLED_REMINDERS_KEY] || []);
  } catch (e) {
    log(`[ReminderState] Error loading disabled hashes: ${e}`, "error");
    return new Set();
  }
}

/**
 * Save disabled hashes to storage
 * @param {Set<string>} disabledSet
 */
async function saveDisabledHashes(disabledSet) {
  try {
    await browser.storage.local.set({ [DISABLED_REMINDERS_KEY]: Array.from(disabledSet) });
  } catch (e) {
    log(`[ReminderState] Error saving disabled hashes: ${e}`, "error");
  }
}

/**
 * Sync: remove orphaned disabled hashes (ones not in fresh reminders)
 * @param {Array} freshReminders - Array of reminder objects (must have hash property)
 */
export async function syncState(freshReminders) {
  try {
    const disabledSet = await getDisabledHashes();
    if (disabledSet.size === 0) return; // Nothing to sync
    
    const freshHashes = new Set(freshReminders.map(r => r.hash));
    let orphaned = 0;
    
    for (const hash of disabledSet) {
      if (!freshHashes.has(hash)) {
        disabledSet.delete(hash);
        orphaned++;
      }
    }
    
    if (orphaned > 0) {
      log(`[ReminderState] Removed ${orphaned} orphaned disabled entries`);
      await saveDisabledHashes(disabledSet);
    }
  } catch (e) {
    log(`[ReminderState] Error syncing state: ${e}`, "error");
  }
}

/**
 * Set enabled status for a reminder hash (idempotent)
 * @param {string} hash - Reminder hash
 * @param {boolean} enabled - Whether enabled (true = remove from disabled, false = add to disabled)
 */
export async function setEnabled(hash, enabled) {
  const disabledSet = await getDisabledHashes();
  
  if (enabled) {
    disabledSet.delete(hash);
  } else {
    disabledSet.add(hash);
  }
  
  await saveDisabledHashes(disabledSet);
  log(`[ReminderState] Set ${hash} enabled=${enabled} (disabled count: ${disabledSet.size})`);
}
