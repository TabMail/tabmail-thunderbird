// reminderBuilder.js – Build reminder list on-demand from message reminders + KB reminders
// Thunderbird 145 MV3
// This module combines reminders from two sources:
// 1. Message-based reminders: From summary cache (per-message reminders)
// 2. KB-based reminders: From knowledge base (generated when KB updates)

import { buildInboxContext } from "./inboxContext.js";
import { getKBReminders } from "./kbReminderGenerator.js";
import { getDisabledHashes, hashReminder, syncState } from "./reminderStateStore.js";
import { getSummaryWithHeaderId } from "./summaryGenerator.js";
import { log } from "./utils.js";

// Re-export setEnabled for convenience (used by background.js message handlers)
export { setEnabled } from "./reminderStateStore.js";

/**
 * Extract message reminders from inbox
 * Scans inbox context and collects reminder from each message's summary
 * @returns {Promise<Array>} Array of reminder objects with source info
 */
async function collectMessageReminders() {
  try {
    log(`[ReminderBuilder] Collecting message reminders from inbox...`);

    // Get inbox context (JSON string with array of message summaries)
    const inboxContextJson = await buildInboxContext();
    
    if (!inboxContextJson) {
      log(`[ReminderBuilder] Empty inbox context, no message reminders`, "warn");
      return [];
    }

    // Parse inbox context
    let inboxItems = [];
    try {
      inboxItems = JSON.parse(inboxContextJson);
      if (!Array.isArray(inboxItems)) {
        log(`[ReminderBuilder] Inbox context is not an array: ${typeof inboxItems}`, "error");
        return [];
      }
    } catch (e) {
      log(`[ReminderBuilder] Failed to parse inbox context JSON: ${e}`, "error");
      return [];
    }

    log(`[ReminderBuilder] Found ${inboxItems.length} messages in inbox context`);

    // Collect reminders from each message
    const messageReminders = [];
    let skippedReplied = 0;
    
    for (const item of inboxItems) {
      try {
        // Skip messages that have already been replied to
        if (item.replied === true) {
          log(`[ReminderBuilder] Skipping message (already replied): "${item.subject?.slice(0, 60)}..."`);
          skippedReplied++;
          continue;
        }

        // Get full summary data for this message to access reminder field
        // Use uniqueId (not internalId) as it matches the cache key format
        const uniqueId = item.uniqueId;
        if (!uniqueId) continue;

        const summaryData = await getSummaryWithHeaderId(uniqueId);
        if (!summaryData) {
          log(`[ReminderBuilder] No summary data for message ${uniqueId} (${item.subject?.slice(0, 40)}...)`);
          continue;
        }
        
        if (!summaryData.reminder) {
          log(`[ReminderBuilder] No reminder field in summary for message ${uniqueId} (${item.subject?.slice(0, 40)}...)`);
          continue;
        }

        // Reminder should be an object with dueDate and content
        const reminderData = summaryData.reminder;
        
        // Validate reminder structure
        if (typeof reminderData !== "object" || !reminderData.content || reminderData.content.trim() === "") {
          // Invalid or empty reminder, skip
          continue;
        }

        // Extract reminder in standard format
        const reminder = {
          content: reminderData.content.trim(),
          dueDate: reminderData.dueDate || null, // May have due date from summary
          dueTime: reminderData.dueTime || null, // Optional HH:MM time
          source: "message",
          action: item.action || "", // Action classification (reply/archive/delete/"")
          messageId: item.internalId, // Keep internalId for reference
          uniqueId: uniqueId, // Also keep uniqueId
          subject: item.subject || "Unknown",
          from: item.from || "Unknown",
        };

        messageReminders.push(reminder);
        log(`[ReminderBuilder] Added message reminder: "${reminder.content.slice(0, 80)}..." (dueDate: ${reminder.dueDate || "none"})`);
      } catch (e) {
        log(`[ReminderBuilder] Error processing reminder for message ${item.uniqueId || item.internalId}: ${e}`, "warn");
        continue;
      }
    }

    log(`[ReminderBuilder] Collected ${messageReminders.length} message reminders from ${inboxItems.length} messages (${skippedReplied} already replied)`);
    return messageReminders;
  } catch (e) {
    log(`[ReminderBuilder] Error collecting message reminders: ${e}`, "error");
    return [];
  }
}

/**
 * Build complete reminder list by combining message and KB reminders
 * Adds hash to each reminder and syncs state (removing orphaned disabled entries)
 * @param {Object} options - Options for building the list
 * @param {boolean} options.includeDisabled - If true, include disabled reminders (default: false)
 * @returns {Promise<Object>} Object with combined reminders array and metadata
 */
export async function buildReminderList({ includeDisabled = false } = {}) {
  try {
    log(`[ReminderBuilder] Building complete reminder list (includeDisabled=${includeDisabled})...`);

    // Collect reminders from both sources in parallel
    const [messageReminders, kbReminders, disabledHashes] = await Promise.all([
      collectMessageReminders(),
      getKBReminders(),
      getDisabledHashes(),
    ]);

    log(`[ReminderBuilder] Collected ${messageReminders.length} message reminders and ${kbReminders.length} KB reminders`);

    // Add source tag to KB reminders if not present
    const taggedKBReminders = kbReminders.map((r) => ({
      ...r,
      source: "kb",
    }));

    // Combine all reminders and add hash + enabled status
    const allRemindersRaw = [...messageReminders, ...taggedKBReminders].map((r) => {
      const hash = hashReminder(r);
      return {
        ...r,
        hash,
        enabled: !disabledHashes.has(hash),
      };
    });

    // Sync state to remove orphaned disabled entries (async, non-blocking)
    syncState(allRemindersRaw).catch((e) => {
      log(`[ReminderBuilder] State sync error (non-fatal): ${e}`, "warn");
    });

    // Filter out disabled reminders unless includeDisabled is true
    let allReminders = allRemindersRaw;
    let disabledCount = allRemindersRaw.filter((r) => !r.enabled).length;
    
    if (!includeDisabled && disabledCount > 0) {
      allReminders = allRemindersRaw.filter((r) => r.enabled);
      log(`[ReminderBuilder] Filtered out ${disabledCount} disabled reminders`);
    }

    // Sort by due date+time (items with dates first, then null dates)
    allReminders.sort((a, b) => {
      // Items with due dates come first
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;

      // Both have due dates - sort by date, then time
      if (a.dueDate && b.dueDate) {
        const dateCmp = a.dueDate.localeCompare(b.dueDate);
        if (dateCmp !== 0) return dateCmp;
        // Same date — compare time (null time sorts after specific time)
        if (a.dueTime && !b.dueTime) return -1;
        if (!a.dueTime && b.dueTime) return 1;
        if (a.dueTime && b.dueTime) return a.dueTime.localeCompare(b.dueTime);
        return 0;
      }

      // Both null - maintain original order (stable sort)
      return 0;
    });

    const messageCount = allReminders.filter((r) => r.source === "message").length;
    const kbCount = allReminders.filter((r) => r.source === "kb").length;

    log(`[ReminderBuilder] Built reminder list with ${allReminders.length} total reminders (${messageCount} message + ${kbCount} KB, ${disabledCount} disabled)`);

    return {
      reminders: allReminders,
      counts: {
        total: allReminders.length,
        message: messageCount,
        kb: kbCount,
        disabled: disabledCount,
      },
      generatedAt: Date.now(),
    };
  } catch (e) {
    log(`[ReminderBuilder] Error building reminder list: ${e}`, "error");
    return {
      reminders: [],
      counts: { total: 0, message: 0, kb: 0, disabled: 0 },
      generatedAt: Date.now(),
    };
  }
}

/**
 * Get a subset of reminders based on filters
 * @param {Object} options - Filter options
 * @param {number} options.maxCount - Maximum number of reminders to return
 * @param {boolean} options.urgentOnly - Only return reminders with due dates
 * @param {string} options.source - Filter by source ("message", "kb", or null for all)
 * @returns {Promise<Array>} Filtered array of reminders
 */
export async function getFilteredReminders({ maxCount = null, urgentOnly = false, source = null } = {}) {
  try {
    const reminderData = await buildReminderList();
    let filtered = reminderData.reminders;

    // Filter by source if specified
    if (source) {
      filtered = filtered.filter((r) => r.source === source);
    }

    // Filter by urgency if specified
    if (urgentOnly) {
      filtered = filtered.filter((r) => r.dueDate !== null);
    }

    // Limit count if specified
    if (maxCount && maxCount > 0) {
      filtered = filtered.slice(0, maxCount);
    }

    log(`[ReminderBuilder] Filtered reminders: ${filtered.length} of ${reminderData.reminders.length} (maxCount=${maxCount}, urgentOnly=${urgentOnly}, source=${source})`);

    return filtered;
  } catch (e) {
    log(`[ReminderBuilder] Error getting filtered reminders: ${e}`, "error");
    return [];
  }
}

/**
 * Get random reminders for display (prioritizes urgent ones)
 * @param {number} count - Number of reminders to return
 * @returns {Promise<Object>} Object with selected reminders and counts
 */
export async function getRandomReminders(count = 2) {
  try {
    log(`[ReminderBuilder] Getting ${count} random reminders...`);

    const reminderData = await buildReminderList();
    const allReminders = reminderData.reminders;

    if (allReminders.length === 0) {
      log(`[ReminderBuilder] No reminders available`);
      return {
        reminders: [],
        urgentCount: 0,
        totalCount: 0,
      };
    }

    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Separate reminders into urgent (overdue/today/tomorrow) and others
    const urgentReminders = [];
    const otherReminders = [];

    for (const reminder of allReminders) {
      if (reminder.dueDate) {
        try {
          // Parse YYYY-MM-DD format explicitly to ensure year is included
          const dateParts = reminder.dueDate.split("-");
          if (dateParts.length !== 3) {
            log(`[ReminderBuilder] Invalid date format: ${reminder.dueDate}`, "warn");
            otherReminders.push(reminder);
            continue;
          }
          
          const dueYear = parseInt(dateParts[0], 10);
          const dueMonth = parseInt(dateParts[1], 10) - 1; // Month is 0-indexed
          const dueDay = parseInt(dateParts[2], 10);
          
          // Create date objects at midnight in local timezone for accurate comparison
          const dueDateMidnight = new Date(dueYear, dueMonth, dueDay);
          const todayTimestamp = today.getTime();
          const tomorrowTimestamp = tomorrow.getTime();
          const dueDateTimestamp = dueDateMidnight.getTime();
          
          // Verify the parsed date matches the input (sanity check)
          if (dueDateMidnight.getFullYear() !== dueYear || 
              dueDateMidnight.getMonth() !== dueMonth || 
              dueDateMidnight.getDate() !== dueDay) {
            log(`[ReminderBuilder] Date parsing mismatch for ${reminder.dueDate}`, "warn");
            otherReminders.push(reminder);
            continue;
          }
          
          // Check if overdue, due today, or due tomorrow
          if (dueDateTimestamp <= todayTimestamp || dueDateTimestamp === tomorrowTimestamp) {
            urgentReminders.push(reminder);
            const status = dueDateTimestamp < todayTimestamp ? "overdue" : 
                          dueDateTimestamp === todayTimestamp ? "today" : "tomorrow";
            log(`[ReminderBuilder] Urgent reminder found (${status}): "${reminder.content.slice(0, 60)}..." due ${reminder.dueDate}`);
            continue;
          }
        } catch (e) {
          log(
            `[ReminderBuilder] Failed to parse due date: ${reminder.dueDate}`,
            "warn"
          );
        }
      }
      otherReminders.push(reminder);
    }

    log(
      `[ReminderBuilder] Found ${urgentReminders.length} urgent (overdue/today/tomorrow), ${otherReminders.length} other reminders`
    );

    // Start with all urgent reminders
    const selectedReminders = [...urgentReminders];

    // If we haven't reached count, randomly add from others
    const remainingSlots = count - selectedReminders.length;
    if (remainingSlots > 0 && otherReminders.length > 0) {
      // Shuffle and pick random reminders
      const shuffled = [...otherReminders];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }

      const additionalCount = Math.min(remainingSlots, shuffled.length);
      selectedReminders.push(...shuffled.slice(0, additionalCount));
    }

    log(
      `[ReminderBuilder] Selected ${selectedReminders.length} reminders (${
        urgentReminders.length
      } urgent + ${
        selectedReminders.length - urgentReminders.length
      } random) from ${allReminders.length} total`
    );

    return {
      reminders: selectedReminders,
      urgentCount: urgentReminders.length,
      totalCount: allReminders.length,
    };
  } catch (e) {
    log(`[ReminderBuilder] Error getting random reminders: ${e}`, "error");
    return {
      reminders: [],
      urgentCount: 0,
      totalCount: 0,
    };
  }
}

/**
 * Format reminders for display in chat
 * Includes a "don't show again" button for each reminder
 * @param {Array} reminders - Array of reminder objects (must have matchKey for disable functionality)
 * @returns {string} Formatted reminder text for display
 */
export function formatRemindersForDisplay(reminders) {
  if (!reminders || reminders.length === 0) {
    return "";
  }

  // Sort reminders by due date (nulls last)
  const sortedReminders = [...reminders].sort((a, b) => {
    if (!a.dueDate && !b.dueDate) return 0;
    if (!a.dueDate) return 1; // a goes after b
    if (!b.dueDate) return -1; // b goes after a
    return a.dueDate.localeCompare(b.dueDate); // Earlier dates first
  });

  const now = new Date();
  const dateOptions = { weekday: "long", month: "long", day: "numeric" };
  const dateStr = now.toLocaleDateString("en-US", dateOptions);

  /**
   * Format a due date (and optional time) for display
   * @param {string|null} dueDateStr - Date string in YYYY-MM-DD format or null
   * @param {string|null} dueTimeStr - Time string in HH:MM format or null
   * @returns {string} Formatted date label (never null - returns empty string for missing dates)
   */
  const formatDueDate = (dueDateStr, dueTimeStr = null) => {
    if (!dueDateStr) return "";

    try {
      // Parse YYYY-MM-DD format explicitly to ensure year is included
      const dateParts = dueDateStr.split("-");
      if (dateParts.length !== 3) {
        log(`[ReminderBuilder] Invalid date format in formatDueDate: ${dueDateStr}`, "warn");
        return "";
      }
      
      const dueYear = parseInt(dateParts[0], 10);
      const dueMonth = parseInt(dateParts[1], 10) - 1; // Month is 0-indexed
      const dueDay = parseInt(dateParts[2], 10);
      
      // Create date objects at midnight in local timezone for accurate comparison
      const dueDateMidnight = new Date(dueYear, dueMonth, dueDay);
      const today = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate()
      );
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // Verify the parsed date matches the input (sanity check)
      if (dueDateMidnight.getFullYear() !== dueYear || 
          dueDateMidnight.getMonth() !== dueMonth || 
          dueDateMidnight.getDate() !== dueDay) {
        log(`[ReminderBuilder] Date parsing mismatch in formatDueDate for ${dueDateStr}`, "warn");
        return "";
      }

      // Compare dates by their midnight timestamps for accuracy
      const dueDateTimestamp = dueDateMidnight.getTime();
      const todayTimestamp = today.getTime();
      const tomorrowTimestamp = tomorrow.getTime();

      const timeSuffix = dueTimeStr ? ` at ${dueTimeStr}` : "";
      if (dueDateTimestamp === todayTimestamp) return `**Today${timeSuffix}**`;
      if (dueDateTimestamp === tomorrowTimestamp) return `**Tomorrow${timeSuffix}**`;
      
      // Calculate days overdue for past dates
      if (dueDateTimestamp < todayTimestamp) {
        const msPerDay = 24 * 60 * 60 * 1000;
        const daysOverdue = Math.floor((todayTimestamp - dueDateTimestamp) / msPerDay);
        if (daysOverdue === 1) {
          return "**Overdue (1 day)**";
        }
        return `**Overdue (${daysOverdue} days)**`;
      }

      // Format as "Due Mon, Nov 5" or "Due Mon, Nov 5 at 14:00"
      const options = {
        weekday: "short",
        month: "short",
        day: "numeric",
      };
      const formatted = dueDateMidnight.toLocaleDateString("en-US", options);
      return `Due ${formatted}${timeSuffix}`;
    } catch (e) {
      log(
        `[ReminderBuilder] Failed to format due date: ${dueDateStr}`,
        "warn"
      );
      return "";
    }
  };

  // Build the formatted output
  const lines = [];
  
  // Header
  lines.push(`📅 **${dateStr}** — Today's Reminders\n\n`);

  // Each reminder with [reminder] marker for special rendering
  // Format: [reminder] **Due Label**: Content
  // The markdown renderer detects this and creates a styled card with dismiss button
  // Hashes are stored separately and linked post-hoc by index
  sortedReminders.forEach((reminder) => {
    const dueDateLabel = formatDueDate(reminder.dueDate, reminder.dueTime);
    const prefix = dueDateLabel ? `${dueDateLabel}: ` : "";
    
    // [reminder] prefix tells the renderer to create a reminder card
    lines.push(`[reminder] ${prefix}${reminder.content}\n\n`);
  });

  // Store the hashes in order for post-hoc linking by the markdown renderer
  // This is accessed via getDisplayedReminderHashes()
  lastDisplayedReminderHashes = sortedReminders.map(r => r.hash || "");

  return lines.join("");
}

// Module-level storage for reminder hashes displayed in the last formatRemindersForDisplay call
let lastDisplayedReminderHashes = [];

/**
 * Get the hashes of reminders from the last formatRemindersForDisplay call
 * Used by the markdown renderer to link dismiss buttons to the correct reminder
 * @returns {string[]} Array of hashes in display order
 */
export function getDisplayedReminderHashes() {
  return [...lastDisplayedReminderHashes];
}

