// proactiveCheckin.js – Deterministic proactive reachout orchestrator (TB 145, MV3)
// Triggers notifications when reminders change or due dates approach.
// No headless LLM calls — all reachout decisions are programmatic.
//
// Two triggers:
//   1. New reminder formed → if within N-day window → notify
//   2. Due date/time approaching → alarm fires X minutes before → notify

import { SETTINGS } from "./config.js";
import { isChatWindowOpen, openOrFocusChatWindow } from "../../chat/modules/chatWindowUtils.js";
import { hashReminder } from "./reminderStateStore.js";
import { log } from "./utils.js";

// ─────────────────────────────────────────────────────────────
// Storage keys (all under "notifications." namespace)
// ─────────────────────────────────────────────────────────────

const STORAGE = {
  ENABLED: "notifications.proactive_enabled",
  WINDOW_DAYS: "notifications.new_reminder_window_days",
  ADVANCE_MINUTES: "notifications.due_reminder_advance_minutes",
  GRACE_MINUTES: "notifications.grace_minutes",
  REACHED_OUT_IDS: "notifications.reached_out_ids",
  REMINDER_HASH: "notifications.reminder_hash",
  LAST_REACHOUT: "notifications.last_reachout",
  PENDING_MSG: "proactiveCheckin_pendingMessage", // kept for compat with chat init
};

const ALARM_NAME = "tabmail-proactive-reachout";

// Legacy keys for one-time migration
const LEGACY_KEYS = {
  ENABLED: "proactiveCheckinEnabled",
  INTERVAL: "proactiveCheckinIntervalMinutes",
  HASH: "proactiveCheckin_reminderHash",
  LAST: "proactiveCheckin_lastCheckin",
};

// ─────────────────────────────────────────────────────────────
// Module state
// ─────────────────────────────────────────────────────────────

let _debounceTimer = null;
let _alarmListener = null;
let _isInitialized = false;
let _lastReachoutTime = 0;
let _openingChatWindow = false;

// ─────────────────────────────────────────────────────────────
// Config defaults (also in config.js under "notifications")
// ─────────────────────────────────────────────────────────────

function _cfg() {
  return SETTINGS?.notifications || {};
}

const DEFAULTS = {
  enabled: false,
  windowDays: 7,
  advanceMinutes: 30,
  graceMinutes: 5,
  debounceMs: 1000,
  minIntervalMs: 60_000, // minimum 1 minute between reachouts
};

// ─────────────────────────────────────────────────────────────
// Settings helpers (read from storage, fallback to config/defaults)
// ─────────────────────────────────────────────────────────────

async function _isEnabled() {
  try {
    const stored = await browser.storage.local.get({ [STORAGE.ENABLED]: null });
    const val = stored[STORAGE.ENABLED];
    if (val !== null && val !== undefined) return val === true;
    return !!(_cfg().proactiveEnabled ?? DEFAULTS.enabled);
  } catch (e) {
    log(`[ProActReach] _isEnabled storage read failed: ${e}`, "warn");
    return DEFAULTS.enabled;
  }
}

async function _windowDays() {
  try {
    const stored = await browser.storage.local.get({ [STORAGE.WINDOW_DAYS]: null });
    const val = stored[STORAGE.WINDOW_DAYS];
    if (val !== null && val !== undefined) {
      const n = Number(val);
      if (n >= 1 && n <= 30) return n;
    }
    return Number(_cfg().newReminderWindowDays) || DEFAULTS.windowDays;
  } catch {
    return DEFAULTS.windowDays;
  }
}

async function _advanceMinutes() {
  try {
    const stored = await browser.storage.local.get({ [STORAGE.ADVANCE_MINUTES]: null });
    const val = stored[STORAGE.ADVANCE_MINUTES];
    if (val !== null && val !== undefined) {
      const n = Number(val);
      if (n >= 5 && n <= 120) return n;
    }
    return Number(_cfg().dueReminderAdvanceMinutes) || DEFAULTS.advanceMinutes;
  } catch {
    return DEFAULTS.advanceMinutes;
  }
}

async function _graceMinutes() {
  try {
    const stored = await browser.storage.local.get({ [STORAGE.GRACE_MINUTES]: null });
    const val = stored[STORAGE.GRACE_MINUTES];
    if (val !== null && val !== undefined) {
      const n = Number(val);
      if (n >= 1 && n <= 30) return n;
    }
    return Number(_cfg().graceMinutes) || DEFAULTS.graceMinutes;
  } catch {
    return DEFAULTS.graceMinutes;
  }
}

function _debounceMs() {
  return Number(_cfg().debounceMs) || DEFAULTS.debounceMs;
}

// ─────────────────────────────────────────────────────────────
// Hashing (same scheme as reminderStateStore.js for consistency)
// ─────────────────────────────────────────────────────────────

/**
 * Hash the full reminder list for change detection.
 * Includes content + dueDate + dueTime for a stable fingerprint.
 */
function _hashReminderList(reminders) {
  if (!Array.isArray(reminders) || reminders.length === 0) return "empty";
  const items = reminders
    .map(r => `${r.content || ""}|${r.dueDate || ""}|${r.dueTime || ""}`)
    .sort()
    .join("||");
  let hash = 5381;
  for (let i = 0; i < items.length; i++) {
    hash = ((hash << 5) + hash + items.charCodeAt(i)) & 0xffffffff;
  }
  return String(hash);
}

// ─────────────────────────────────────────────────────────────
// reached_out deduplication store
// ─────────────────────────────────────────────────────────────

async function _getReachedOutIds() {
  try {
    const stored = await browser.storage.local.get({ [STORAGE.REACHED_OUT_IDS]: {} });
    return stored[STORAGE.REACHED_OUT_IDS] || {};
  } catch (e) {
    log(`[ProActReach] Failed to read reached_out_ids: ${e}`, "warn");
    return {};
  }
}

async function _markReachedOut(reminderHash, trigger) {
  try {
    const ids = await _getReachedOutIds();
    ids[reminderHash] = { reachedAt: new Date().toISOString(), trigger };
    await browser.storage.local.set({ [STORAGE.REACHED_OUT_IDS]: ids });
    log(`[ProActReach] Marked ${reminderHash} as reached_out (trigger=${trigger})`);
  } catch (e) {
    log(`[ProActReach] Failed to mark reached_out: ${e}`, "warn");
  }
}

/**
 * Prune reached_out entries whose hashes no longer exist in the active reminder set.
 */
async function _pruneReachedOutIds(activeReminders) {
  try {
    const ids = await _getReachedOutIds();
    const activeHashes = new Set(activeReminders.map(r => r.hash || hashReminder(r)));
    let pruned = 0;
    for (const h of Object.keys(ids)) {
      if (!activeHashes.has(h)) {
        delete ids[h];
        pruned++;
      }
    }
    if (pruned > 0) {
      await browser.storage.local.set({ [STORAGE.REACHED_OUT_IDS]: ids });
      log(`[ProActReach] Pruned ${pruned} orphaned reached_out entries`);
    }
  } catch (e) {
    log(`[ProActReach] Prune reached_out failed: ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// Chat window helpers (using shared utility from chatWindowUtils.js)
// ─────────────────────────────────────────────────────────────

async function _openChatWindow() {
  if (_openingChatWindow) {
    log(`[ProActReach] Already opening chat window, skipping duplicate`);
    return;
  }
  _openingChatWindow = true;
  try {
    await openOrFocusChatWindow();
    log("[ProActReach] Chat window opened/focused for proactive message");
  } catch (e) {
    log(`[ProActReach] Failed to open chat window: ${e}`, "error");
  } finally {
    _openingChatWindow = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Pending message storage (consumed by chat init)
// ─────────────────────────────────────────────────────────────

async function _storePendingMessage(message) {
  try {
    await browser.storage.local.set({
      [STORAGE.PENDING_MSG]: {
        message,
        timestamp: Date.now(),
        idMapEntries: [], // No LLM call = no isolated idMap needed
      },
    });
    log(`[ProActReach] Stored pending message (${message.length} chars)`);
  } catch (e) {
    log(`[ProActReach] Failed to store pending message: ${e}`, "error");
  }
}

async function _deliverMessage(message) {
  const chatOpen = await isChatWindowOpen();
  if (chatOpen) {
    try {
      await browser.runtime.sendMessage({
        command: "proactive-checkin-message",
        message,
        idMapEntries: [],
      });
      log(`[ProActReach] Injected message directly into open chat`);
      return;
    } catch (e) {
      log(`[ProActReach] Direct inject failed, falling back to pending: ${e}`, "warn");
    }
  }
  await _storePendingMessage(message);
  await _openChatWindow();
}

// ─────────────────────────────────────────────────────────────
// Message templates
// ─────────────────────────────────────────────────────────────

async function _getUserName() {
  try {
    const { getUserName } = await import("../../chat/modules/helpers.js");
    return await getUserName({ fullname: true }) || "there";
  } catch {
    return "there";
  }
}

/**
 * Format a due date label matching the welcome-back reminder card style.
 * Examples: "Today at 14:00", "Tomorrow", "Overdue (2 days)", "Due Mon, Nov 5 at 14:00"
 * @param {string} dueDate - Date in YYYY-MM-DD format
 * @param {string|null} dueTime - Optional time in HH:MM format
 * @param {string|null} timezone - Optional IANA timezone (e.g., "America/Vancouver")
 */
function _formatDueLabel(dueDate, dueTime, timezone) {
  const parts = dueDate.split("-");
  if (parts.length !== 3) return "";
  const year = parseInt(parts[0]);
  const month = parseInt(parts[1]) - 1;
  const day = parseInt(parts[2]);

  // Compute "today" and "tomorrow" in the reminder's timezone (or local if none)
  const { todayMidnight, tomorrowMidnight, dueMidnight } = _getDateMidnightsInTimezone(
    year, month, day, timezone
  );

  const timeSuffix = dueTime ? ` at ${dueTime}` : "";
  const dueTs = dueMidnight.getTime();
  const todayTs = todayMidnight.getTime();
  const tomorrowTs = tomorrowMidnight.getTime();

  if (dueTs === todayTs) return `Today${timeSuffix}`;
  if (dueTs === tomorrowTs) return `Tomorrow${timeSuffix}`;

  if (dueTs < todayTs) {
    const daysOverdue = Math.round((todayTs - dueTs) / 86400000);
    return `Overdue (${daysOverdue} day${daysOverdue > 1 ? "s" : ""})`;
  }

  const formatted = dueMidnight.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return `Due ${formatted}${timeSuffix}`;
}

/**
 * Get midnight timestamps for today, tomorrow, and a specific date in a given timezone.
 * This ensures "Today"/"Tomorrow" comparisons are correct when the reminder was
 * created in a different timezone than the current local timezone.
 */
function _getDateMidnightsInTimezone(dueYear, dueMonth, dueDay, timezone) {
  const now = new Date();

  if (!timezone) {
    // No timezone stored - use local time (legacy behavior)
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    const dueMidnight = new Date(dueYear, dueMonth, dueDay);
    return { todayMidnight, tomorrowMidnight, dueMidnight };
  }

  // Get today's date components in the reminder's timezone
  const tzFormatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  try {
    // Parse "YYYY-MM-DD" format from en-CA locale
    const todayInTz = tzFormatter.format(now);
    const [tYear, tMonth, tDay] = todayInTz.split("-").map(Number);

    // Create midnight timestamps (these are conceptual - we use them for comparison only)
    const todayMidnight = new Date(tYear, tMonth - 1, tDay);
    const tomorrowMidnight = new Date(tYear, tMonth - 1, tDay + 1);
    const dueMidnight = new Date(dueYear, dueMonth, dueDay);

    return { todayMidnight, tomorrowMidnight, dueMidnight };
  } catch (e) {
    // Invalid timezone - fall back to local time
    log(`[ProActReach] Invalid timezone "${timezone}", falling back to local`, "warn");
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowMidnight = new Date(todayMidnight);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    const dueMidnight = new Date(dueYear, dueMonth, dueDay);
    return { todayMidnight, tomorrowMidnight, dueMidnight };
  }
}

function _buildNewReminderMessage(userName, reminder) {
  const isKB = reminder.source === "kb";
  const detail = reminder.content || (isKB ? "Check this reminder" : "Check this email");
  const dueLabelText = reminder.dueDate ? _formatDueLabel(reminder.dueDate, reminder.dueTime, reminder.timezone) : "";
  const dueLabel = dueLabelText ? `**${dueLabelText}** — ` : "";
  const emailRef = reminder.uniqueId ? ` — [Email](${reminder.uniqueId})` : "";
  const noun = isKB ? "reminder" : "email";
  return `Hey ${userName}, you have a new ${noun} that may need your attention:\n\n${dueLabel}${detail}${emailRef}`;
}

function _buildNewRemindersMessage(userName, reminders) {
  const lines = reminders.map(r => {
    const dueLabelText = r.dueDate ? _formatDueLabel(r.dueDate, r.dueTime, r.timezone) : "";
    const dueLabel = dueLabelText ? `**${dueLabelText}** — ` : "";
    const emailRef = r.uniqueId ? ` — [Email](${r.uniqueId})` : "";
    return `- ${dueLabel}${r.content}${emailRef}`;
  });
  const allKB = reminders.every(r => r.source === "kb");
  const noun = allKB ? "reminders" : "emails";
  return `Hey ${userName}, you have ${reminders.length} new ${noun} that may need your attention:\n\n${lines.join("\n")}`;
}

function _buildDueApproachingMessage(userName, reminders) {
  if (reminders.length === 1) {
    const r = reminders[0];
    const dueLabel = _formatDueLabel(r.dueDate, r.dueTime, r.timezone);
    const emailRef = r.uniqueId ? ` — [Email](${r.uniqueId})` : "";
    return `Hey ${userName}, you have a reminder coming up soon:\n\n**${dueLabel}**: ${r.content}${emailRef}`;
  }

  const lines = reminders.map(r => {
    const dueLabel = _formatDueLabel(r.dueDate, r.dueTime, r.timezone);
    const emailRef = r.uniqueId ? ` — [Email](${r.uniqueId})` : "";
    return `- **${dueLabel}**: ${r.content}${emailRef}`;
  });
  return `Hey ${userName}, you have ${reminders.length} reminders coming up soon:\n\n${lines.join("\n")}`;
}

// ─────────────────────────────────────────────────────────────
// Trigger 1: New Reminder Formed
// ─────────────────────────────────────────────────────────────

async function _handleNewReminders(reminders) {
  log(`[ProActReach] Evaluating ${reminders.length} reminders for new-reminder reachout`);

  const windowDays = await _windowDays();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const windowEnd = new Date(today.getTime() + windowDays * 86400000);

  const reachedOutIds = await _getReachedOutIds();
  const qualifying = [];

  for (const r of reminders) {
    const rHash = r.hash || hashReminder(r);

    // Already reached out for this reminder (new_reminder trigger)?
    if (reachedOutIds[rHash]?.trigger === "new_reminder") {
      log(`[ProActReach] Skip ${rHash}: already reached out (new_reminder)`);
      continue;
    }

    // Window check: skip if due date is beyond the window
    if (r.dueDate) {
      try {
        const parts = r.dueDate.split("-");
        const dueDateObj = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        if (dueDateObj.getTime() > windowEnd.getTime()) {
          log(`[ProActReach] Skip ${rHash}: dueDate ${r.dueDate} beyond ${windowDays}-day window`);
          continue;
        }
      } catch {
        // Invalid date — include it (fail open)
      }
    }
    // No due date = always qualifies

    qualifying.push(r);
  }

  if (qualifying.length === 0) {
    log(`[ProActReach] No qualifying new reminders for reachout`);
    return;
  }

  log(`[ProActReach] ${qualifying.length} new reminders qualify for reachout`);

  // Rate limit
  if (_lastReachoutTime && (Date.now() - _lastReachoutTime) < DEFAULTS.minIntervalMs) {
    log(`[ProActReach] Rate limited, skipping reachout`);
    return;
  }

  const userName = await _getUserName();

  const message = qualifying.length === 1
    ? _buildNewReminderMessage(userName, qualifying[0])
    : _buildNewRemindersMessage(userName, qualifying);

  await _deliverMessage(message);
  _lastReachoutTime = Date.now();

  // Mark all as reached out
  for (const r of qualifying) {
    await _markReachedOut(r.hash || hashReminder(r), "new_reminder");
  }

  await _persistLastReachout();
}

// ─────────────────────────────────────────────────────────────
// Trigger 2: Due Date/Time Approaching (alarm-fired)
// ─────────────────────────────────────────────────────────────

async function _handleAlarmFired() {
  log(`[ProActReach] Alarm fired, checking for approaching due reminders`);

  if (!(await _isEnabled())) {
    log(`[ProActReach] Feature disabled, skipping alarm handler`);
    await _scheduleNextAlarm();
    return;
  }

  const advMins = await _advanceMinutes();
  const graceMins = await _graceMinutes();
  const now = Date.now();
  const windowEnd = now + (advMins + graceMins) * 60_000;

  const { buildReminderList } = await import("./reminderBuilder.js");
  const result = await buildReminderList();
  const reminders = result?.reminders || [];

  const reachedOutIds = await _getReachedOutIds();
  const qualifying = [];

  for (const r of reminders) {
    if (!r.dueDate) continue; // No due date = skip for alarm-based trigger

    // Only reply-tagged messages (and KB reminders) qualify
    if (r.source !== "kb" && r.action !== "reply") continue;

    const rHash = r.hash || hashReminder(r);

    // Already reached out for due_approaching trigger?
    if (reachedOutIds[rHash]?.trigger === "due_approaching") {
      continue;
    }

    // Compute due datetime
    const dueMs = _resolveDueDateTime(r.dueDate, r.dueTime, r.timezone);
    if (!dueMs) continue;

    // Is it within the window [now, now + advance + grace]?
    if (dueMs >= now && dueMs <= windowEnd) {
      qualifying.push(r);
    }
  }

  if (qualifying.length > 0) {
    log(`[ProActReach] ${qualifying.length} reminders due within window`);

    if (!_lastReachoutTime || (Date.now() - _lastReachoutTime) >= DEFAULTS.minIntervalMs) {
      const userName = await _getUserName();
      const message = _buildDueApproachingMessage(userName, qualifying);
      await _deliverMessage(message);
      _lastReachoutTime = Date.now();

      for (const r of qualifying) {
        await _markReachedOut(r.hash || hashReminder(r), "due_approaching");
      }
      await _persistLastReachout();
    } else {
      log(`[ProActReach] Rate limited, skipping due-approaching reachout`);
    }
  } else {
    log(`[ProActReach] No reminders due within window`);
  }

  // Always reschedule the next alarm
  await _scheduleNextAlarm();
}

/**
 * Resolve a reminder's due date + optional time to epoch ms.
 * If no time, defaults to start of day (00:00).
 * If timezone is provided (from KB storage), interprets the date/time
 * in that timezone for travel resilience.  Without a timezone, falls
 * back to the current local timezone (legacy behavior).
 */
function _resolveDueDateTime(dueDate, dueTime, timezone) {
  try {
    const parts = dueDate.split("-");
    if (parts.length !== 3) return null;
    const year = parseInt(parts[0]);
    const month = parseInt(parts[1]) - 1;
    const day = parseInt(parts[2]);

    let hours = 0, minutes = 0;
    if (dueTime) {
      const tp = dueTime.split(":");
      if (tp.length >= 2) {
        hours = parseInt(tp[0]);
        minutes = parseInt(tp[1]);
      }
    }

    if (!timezone) {
      // Legacy: interpret in current local timezone
      return new Date(year, month, day, hours, minutes).getTime();
    }

    // Timezone-aware: resolve the date/time in the stored timezone.
    // Create the date as UTC, then adjust by the timezone offset.
    const utcGuess = new Date(Date.UTC(year, month, day, hours, minutes));
    const offset = _getTimezoneOffsetMs(utcGuess, timezone);
    return utcGuess.getTime() - offset;
  } catch {
    return null;
  }
}

/**
 * Compute the offset (in ms) of a timezone at a given instant.
 * Returns positive for timezones ahead of UTC (e.g., +5h for Asia/Kolkata).
 */
function _getTimezoneOffsetMs(date, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric", month: "numeric", day: "numeric",
      hour: "numeric", minute: "numeric", second: "numeric",
      hour12: false,
    });
    const p = {};
    for (const { type, value } of formatter.formatToParts(date)) {
      p[type] = parseInt(value);
    }
    const tzAsUtc = Date.UTC(
      p.year, p.month - 1, p.day,
      p.hour === 24 ? 0 : p.hour, p.minute, p.second || 0,
    );
    return tzAsUtc - date.getTime();
  } catch {
    return 0; // Fall back to treating as UTC
  }
}

// ─────────────────────────────────────────────────────────────
// Alarm scheduling
// ─────────────────────────────────────────────────────────────

async function _scheduleNextAlarm() {
  try {
    const { buildReminderList } = await import("./reminderBuilder.js");
    const result = await buildReminderList();
    const reminders = result?.reminders || [];

    const advMins = await _advanceMinutes();
    const now = Date.now();
    let earliestWakeUp = Infinity;

    for (const r of reminders) {
      if (!r.dueDate) continue;
      const dueMs = _resolveDueDateTime(r.dueDate, r.dueTime, r.timezone);
      if (!dueMs) continue;

      const wakeUp = dueMs - advMins * 60_000;
      if (wakeUp > now && wakeUp < earliestWakeUp) {
        earliestWakeUp = wakeUp;
      }
    }

    // Clear any existing alarm
    await browser.alarms.clear(ALARM_NAME);

    if (earliestWakeUp < Infinity) {
      await browser.alarms.create(ALARM_NAME, { when: earliestWakeUp });
      const inMinutes = Math.round((earliestWakeUp - now) / 60_000);
      log(`[ProActReach] Scheduled alarm for ${new Date(earliestWakeUp).toISOString()} (in ${inMinutes} min)`);
    } else {
      log(`[ProActReach] No upcoming due dates, no alarm scheduled`);
    }
  } catch (e) {
    log(`[ProActReach] Failed to schedule alarm: ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// Persistence
// ─────────────────────────────────────────────────────────────

async function _persistLastReachout() {
  try {
    await browser.storage.local.set({
      [STORAGE.LAST_REACHOUT]: { time: _lastReachoutTime },
    });
  } catch (e) {
    log(`[ProActReach] Failed to persist last reachout: ${e}`, "warn");
  }
}

async function _restoreState() {
  try {
    const stored = await browser.storage.local.get(STORAGE.LAST_REACHOUT);
    const data = stored?.[STORAGE.LAST_REACHOUT];
    if (data) {
      _lastReachoutTime = Number(data.time) || 0;
      const ago = _lastReachoutTime ? Math.round((Date.now() - _lastReachoutTime) / 1000) : 0;
      log(`[ProActReach] Restored state: lastReachout=${ago}s ago`);
    }
  } catch (e) {
    log(`[ProActReach] Failed to restore state: ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// One-time migration from legacy storage keys
// ─────────────────────────────────────────────────────────────

async function _migrateLegacyKeys() {
  try {
    const stored = await browser.storage.local.get([LEGACY_KEYS.ENABLED, LEGACY_KEYS.HASH, LEGACY_KEYS.LAST]);
    let migrated = false;

    if (stored[LEGACY_KEYS.ENABLED] !== undefined) {
      await browser.storage.local.set({ [STORAGE.ENABLED]: stored[LEGACY_KEYS.ENABLED] === true });
      migrated = true;
    }

    if (stored[LEGACY_KEYS.HASH] !== undefined) {
      await browser.storage.local.set({ [STORAGE.REMINDER_HASH]: stored[LEGACY_KEYS.HASH] });
      migrated = true;
    }

    if (stored[LEGACY_KEYS.LAST] !== undefined) {
      const lastData = stored[LEGACY_KEYS.LAST];
      if (lastData?.time) {
        await browser.storage.local.set({ [STORAGE.LAST_REACHOUT]: { time: lastData.time } });
      }
      migrated = true;
    }

    if (migrated) {
      await browser.storage.local.remove([LEGACY_KEYS.ENABLED, LEGACY_KEYS.INTERVAL, LEGACY_KEYS.HASH, LEGACY_KEYS.LAST]);
      log(`[ProActReach] Migrated legacy storage keys`);
    }
  } catch (e) {
    log(`[ProActReach] Legacy migration failed (non-fatal): ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// Public API: called from messageProcessorQueue.js after drain
// ─────────────────────────────────────────────────────────────

/**
 * Called after PMQ processes messages (processed > 0).
 * Rebuilds reminder list, detects changes, and triggers deterministic reachout.
 */
export async function onInboxUpdated() {
  const enabled = await _isEnabled();
  log(`[ProActReach] onInboxUpdated called, enabled=${enabled}`);
  if (!enabled) return;

  try {
    const { buildReminderList } = await import("./reminderBuilder.js");
    const result = await buildReminderList();
    const reminders = result?.reminders || [];
    const newHash = _hashReminderList(reminders);

    // Load stored hash
    const stored = await browser.storage.local.get(STORAGE.REMINDER_HASH);
    const oldHash = stored?.[STORAGE.REMINDER_HASH] || "";

    log(`[ProActReach] onInboxUpdated: reminders=${reminders.length}, oldHash=${oldHash || "(none)"}, newHash=${newHash}`);

    if (newHash === oldHash) {
      log(`[ProActReach] Hash unchanged, no action needed`);
      return;
    }

    // Hash changed — persist new hash
    await browser.storage.local.set({ [STORAGE.REMINDER_HASH]: newHash });

    // Only reply-tagged message reminders (and all KB reminders) are candidates.
    // Messages classified as archive/delete/none should not trigger proactive reachout.
    const candidateReminders = reminders.filter(r => {
      if (r.enabled === false) return false;
      if (r.source === "kb") return true;
      return r.action === "reply";
    });

    // Prune orphaned reached_out entries
    await _pruneReachedOutIds(candidateReminders);

    // Debounce
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }

    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      _handleNewReminders(candidateReminders).catch(e => {
        log(`[ProActReach] Debounced new-reminder handler failed: ${e}`, "warn");
      });
    }, _debounceMs());

    // Reschedule alarm for due-date-approaching trigger
    await _scheduleNextAlarm();
  } catch (e) {
    log(`[ProActReach] onInboxUpdated failed: ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// Public API: called from chat/modules/init.js
// ─────────────────────────────────────────────────────────────

/**
 * Get and clear any pending proactive message.
 * Returns { message, timestamp } or null if none/stale.
 */
export async function consumePendingProactiveMessage() {
  try {
    const stored = await browser.storage.local.get(STORAGE.PENDING_MSG);
    const data = stored?.[STORAGE.PENDING_MSG];
    if (!data?.message) {
      log(`[ProActReach] consumePending: no pending message found`);
      return null;
    }

    const age = Date.now() - (data.timestamp || 0);
    log(`[ProActReach] consumePending: found message (${data.message.length} chars, age=${Math.round(age / 1000)}s)`);

    // Clear it immediately
    await browser.storage.local.remove(STORAGE.PENDING_MSG);

    // Stale threshold: 5 minutes
    const staleMs = 5 * 60_000;
    if (age > staleMs) {
      log(`[ProActReach] consumePending: DISCARDING stale message (age=${Math.round(age / 1000)}s)`);
      return null;
    }

    return data;
  } catch (e) {
    log(`[ProActReach] consumePending failed: ${e}`, "warn");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Lifecycle: init / cleanup
// ─────────────────────────────────────────────────────────────

export async function initProactiveCheckin() {
  if (_isInitialized) return;
  _isInitialized = true;

  const enabledAtInit = await _isEnabled();
  log(`[ProActReach] INIT enabled=${enabledAtInit}`);

  // One-time migration from legacy storage keys
  await _migrateLegacyKeys();

  // Restore persisted state
  await _restoreState();

  // Register alarm listener
  if (!_alarmListener) {
    _alarmListener = (alarm) => {
      if (alarm.name === ALARM_NAME) {
        log(`[ProActReach] Alarm fired: ${ALARM_NAME}`);
        _handleAlarmFired().catch(e => {
          log(`[ProActReach] Alarm handler failed: ${e}`, "warn");
        });
      }
    };
    browser.alarms.onAlarm.addListener(_alarmListener);
    log(`[ProActReach] Alarm listener registered`);
  }

  // Schedule initial alarm if enabled
  if (enabledAtInit) {
    await _scheduleNextAlarm();
  }
}

export function cleanupProactiveCheckin() {
  log(`[ProActReach] Cleaning up`);

  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }

  if (_alarmListener) {
    try {
      browser.alarms.onAlarm.removeListener(_alarmListener);
    } catch (e) {
      log(`[ProActReach] Failed to remove alarm listener: ${e}`, "warn");
    }
    _alarmListener = null;
  }

  _isInitialized = false;
}

// ─────────────────────────────────────────────────────────────
// Debug: Test nudge (uses exact same flow as real nudges)
// ─────────────────────────────────────────────────────────────

/**
 * Send a test proactive nudge using the exact same flow as real nudges.
 * Opens chat window, displays message, and relays to ChatLink if enabled.
 *
 * @returns {Promise<boolean>} True if delivered successfully
 */
export async function sendTestProactiveNudge() {
  const testMessage = `🧪 **Test Nudge**\n\nThis is a test proactive message from TabMail.\n\nIf you see this in your chat window (and WhatsApp if connected), the nudge system is working correctly!\n\n_Sent at ${new Date().toLocaleTimeString()}_`;

  log(`[ProActReach] Sending test nudge`);

  try {
    await _deliverMessage(testMessage);
    log(`[ProActReach] Test nudge delivered`);
    return true;
  } catch (e) {
    log(`[ProActReach] Test nudge failed: ${e}`, "error");
    return false;
  }
}
