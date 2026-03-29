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
const TASK_ALARM_NAME = "tabmail-task-eval";
const TASK_EVAL_INTERVAL_MINUTES = 5; // Evaluate tasks every 5 minutes

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
    if (val !== null && val !== undefined) return val === true || val === "true";
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
// Trigger 1: New Reminder Formed (MESSAGE reminders only)
// KB reminders are excluded — they only notify via due_approaching.
// ─────────────────────────────────────────────────────────────

async function _handleNewReminders(reminders) {
  // Note: This function receives only MESSAGE reminders (source !== "kb").
  // KB reminders are filtered out by onInboxUpdated and only notify via alarm.
  log(`[ProActReach] Evaluating ${reminders.length} message reminders for new-reminder reachout`);

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

// ─────────────────────────────────────────────────────────────
// Task evaluation (periodic, every 5 min)
// ─────────────────────────────────────────────────────────────

/**
 * Evaluate all task entries and fire any that are due.
 * Called by the periodic TASK_ALARM_NAME alarm.
 * Tasks fire serially (one at a time) for simplicity.
 */
async function _handleTaskEvaluation() {
  try {
    // Check task.enabled setting
    const taskEnabledStored = await browser.storage.local.get({ "task.enabled": true });
    const taskEnabledRaw = taskEnabledStored["task.enabled"];
    const taskEnabled = taskEnabledRaw === true || taskEnabledRaw === "true";
    if (!taskEnabled) {
      log(`[ProActReach] Task evaluation skipped (task.enabled=false)`);
      return;
    }

    // Parse tasks from KB
    const { getUserKBPrompt } = await import("./promptGenerator.js");
    const kbText = (await getUserKBPrompt()) || "";
    const { parseTasksFromKB, getTaskHash } = await import("./kbTaskParser.js");
    const tasks = parseTasksFromKB(kbText);

    if (tasks.length === 0) return;

    const { shouldFire, detectMiss, getExecutionState, markFired, markMissed, gcOrphanedStates } = await import("./taskScheduler.js");
    const { getDisabledHashes } = await import("./reminderStateStore.js");
    const { getCachedResult, setCachedResult, gcOrphanedEntries } = await import("./taskExecutionCache.js");

    const disabledHashes = await getDisabledHashes();
    const activeTaskHashes = tasks.map(t => getTaskHash(t));

    // Evaluate each task
    for (const task of tasks) {
      const hash = getTaskHash(task);
      const isEnabled = !disabledHashes.has(hash);
      const execState = await getExecutionState(hash);

      // Check for missed fires
      const missResult = detectMiss(task, hash, execState);
      if (missResult.missed) {
        await markMissed(hash, missResult.missedDate);
        log(`[ProActReach] Task missed: ${hash} on ${missResult.missedDate}`);
      }

      // Check if should fire
      const fireResult = await shouldFire(task, hash, isEnabled, execState);
      if (!fireResult.shouldFire) continue;

      log(`[ProActReach] Task firing: ${hash} (prefire=${fireResult.isPrefire})`);

      // Check cache first (another device may have already executed)
      // Use timezone-aware date for consistent cache key
      const { getNowInTimezone } = await import("./taskScheduler.js");
      const taskTz = task.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const today = getNowInTimezone(taskTz).dateStr;
      const cached = await getCachedResult(hash, today);
      if (cached) {
        log(`[ProActReach] Task ${hash} has cached result, delivering`);
        await _deliverTaskResult(task, hash, cached.content, cached.sessionId);
        await markFired(hash, true, task.timezone);
        continue;
      }

      // Execute the task (agent invocation)
      try {
        const result = await _executeTask(task, hash);
        if (result) {
          await setCachedResult(hash, today, result.content, result.sessionId);
          await _deliverTaskResult(task, hash, result.content, result.sessionId);
          await markFired(hash, true, task.timezone);

          // Broadcast cache via Device Sync
          try {
            const { broadcastState } = await import("./deviceSync.js");
            broadcastState(["taskCache"]);
          } catch (e) {
            log(`[ProActReach] Failed to broadcast task cache: ${e}`, "warn");
          }
        } else {
          await markFired(hash, false, task.timezone);
        }
      } catch (e) {
        log(`[ProActReach] Task execution failed for ${hash}: ${e}`, "error");
        // Don't mark as fired on quota errors (402) — try next time
        if (e?.status === 402 || String(e).includes("402")) {
          log(`[ProActReach] Quota exhausted, will retry at next scheduled time`);
        } else {
          await markFired(hash, false, task.timezone);
        }
      }
    }

    // GC orphaned execution states and cache entries
    const activeTaskHashSet = new Set(activeTaskHashes);
    gcOrphanedStates(activeTaskHashes).catch(e => {
      log(`[ProActReach] Task state GC failed: ${e}`, "warn");
    });
    gcOrphanedEntries(activeTaskHashSet).catch(e => {
      log(`[ProActReach] Task cache GC failed: ${e}`, "warn");
    });
  } catch (e) {
    log(`[ProActReach] Task evaluation failed: ${e}`, "error");
  }
}

/**
 * Execute a task by sending the instruction as a user message in an isolated agent session.
 * Returns { content, sessionId } on success, null on failure.
 */
async function _executeTask(task, taskHash) {
  const now = new Date();
  const timeStr = now.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: task.timezone || undefined,
  });
  const dateStr = now.toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: task.timezone || undefined,
  });

  const userMessage = `It is now ${timeStr}, ${dateStr}. I previously scheduled this task to run at this time: "${task.instruction}" Execute and respond.`;

  // Check for missed fires to include in the message
  const { getExecutionState, consumeMissed } = await import("./taskScheduler.js");
  const execState = await getExecutionState(taskHash);
  let messageWithMissed = userMessage;
  if (execState?.lastMissed) {
    const missed = execState.lastMissed;
    messageWithMissed += `\nNote: A previous run was missed on ${missed} (device was not available). Please include anything that would have been covered.`;
    await consumeMissed(taskHash);
  }

  const sessionId = `task:${taskHash}`;

  log(`[ProActReach] Executing task ${taskHash}: "${task.instruction.slice(0, 80)}..."`);

  try {
    const { sendChat } = await import("./llm.js");
    const { executeToolsHeadless } = await import("../../chat/tools/core.js");
    const { getUserKBPrompt } = await import("./promptGenerator.js");
    const { buildReminderList } = await import("./reminderBuilder.js");

    // Build the agent system prompt (same as normal chat init).
    // The backend expands "system_prompt_agent" into the full agent system prompt
    // with tools, KB context, reminders, and timezone.
    let userName = "";
    try {
      const stored = await browser.storage.local.get("userName");
      userName = stored?.userName || "";
    } catch { /* ignore */ }
    const userKBContent = (await getUserKBPrompt()) || "";
    let remindersJson = "[]";
    try {
      const result = await buildReminderList();
      const { formatRemindersForSystem } = await import("./reminderBuilder.js");
      if (typeof formatRemindersForSystem === "function") {
        remindersJson = formatRemindersForSystem(result?.reminders || []);
      } else {
        remindersJson = JSON.stringify((result?.reminders || []).map(r => ({
          content: r.content, dueDate: r.dueDate, source: r.source, type: r.type,
        })));
      }
    } catch (e) {
      log(`[ProActReach] Failed to build reminders for task system prompt: ${e}`, "warn");
    }

    const systemMessage = {
      role: "system",
      content: "system_prompt_agent",
      user_name: userName,
      user_kb_content: userKBContent,
      user_reminders_json: remindersJson,
      recent_chat_history: "",
    };

    // Multi-turn agent loop: send message, handle tool calls, repeat until done
    let messages = [systemMessage, { role: "user", content: messageWithMissed }];
    let finalResponse = null;
    const maxTurns = 10; // Safety limit

    for (let turn = 0; turn < maxTurns; turn++) {
      const response = await sendChat(messages, {
        disableTools: false,
        onToolExecution: null,
      });

      if (!response) {
        log(`[ProActReach] Task ${taskHash} sendChat returned null on turn ${turn}`, "warn");
        break;
      }

      // If there are tool calls, execute them headlessly and feed results back
      if (response.tool_calls && response.tool_calls.length > 0) {
        log(`[ProActReach] Task ${taskHash} turn ${turn}: ${response.tool_calls.length} tool call(s)`);
        messages.push({ role: "assistant", content: response.assistant || "", tool_calls: response.tool_calls });

        const toolResults = await executeToolsHeadless(response.tool_calls, response.token_usage);
        for (const tr of toolResults) {
          messages.push({ role: "tool", tool_call_id: tr.call_id, content: tr.output });
        }
        continue;
      }

      // No tool calls = final response
      finalResponse = response.assistant;
      break;
    }

    if (finalResponse) {
      log(`[ProActReach] Task ${taskHash} executed successfully (${finalResponse.length} chars)`);
      return { content: finalResponse, sessionId };
    }

    log(`[ProActReach] Task ${taskHash} returned no assistant response`, "warn");
    return null;
  } catch (e) {
    log(`[ProActReach] Task ${taskHash} execution error: ${e}`, "error");
    throw e; // Re-throw for quota handling in caller
  }
}

/**
 * Deliver a task result to the user.
 * If chat window is open and user is not mid-conversation, inject directly.
 * Otherwise, store as pending and/or show as system notification.
 */
/**
 * Deliver a task result by persisting as proper chat turns (NOT ephemeral nudges).
 * Task results must survive across window opens/closes and not be evicted by new nudges.
 * If chat window is open, also renders inline. Always persisted regardless.
 */
async function _deliverTaskResult(task, taskHash, content, sessionId) {
  let scheduleLabel;
  if (task.kind === "once" && task.scheduleDate) {
    scheduleLabel = `${task.scheduleDate} at ${task.scheduleTime}`;
  } else {
    scheduleLabel = `${task.scheduleDays} at ${task.scheduleTime}`;
  }
  const message = `**Scheduled Task** _(${scheduleLabel})_\n\n${content}`;

  log(`[ProActReach] Delivering task result for ${taskHash} (${content.length} chars)`);

  // Persist as proper chat turns (not ephemeral nudge) — survives window close
  try {
    const { appendTurn, loadTurns, loadMeta, generateTurnId } = await import("../../chat/modules/persistentChatStore.js");

    const turns = await loadTurns();
    const meta = await loadMeta();

    if (turns && meta) {
      // Insert a session break before the task result (skip if last turn is already one)
      const lastTurn = turns.length > 0 ? turns[turns.length - 1] : null;
      if (!lastTurn || lastTurn._type !== "session_break") {
        const breakTurn = {
          role: "assistant",
          content: "Scheduled task executed in the background",
          _id: generateTurnId(),
          _ts: Date.now(),
          _type: "session_break",
          _chars: 0,
        };
        await appendTurn(breakTurn, turns, meta);
      }

      // Persist the task result as a proper assistant turn
      const taskTurn = {
        role: "assistant",
        content: message,
        _id: generateTurnId(),
        _ts: Date.now() + 1,
        _type: "task_result",
        _chars: message.length,
        _taskHash: taskHash,
        _sessionId: sessionId,
      };

      try {
        const { renderMarkdown } = await import("../../chat/modules/markdown.js");
        taskTurn._rendered = await renderMarkdown(message);
      } catch (e) {
        log(`[ProActReach] Failed to render task result markdown: ${e}`, "warn");
      }

      await appendTurn(taskTurn, turns, meta);
      log(`[ProActReach] Persisted task result as chat turn (${message.length} chars)`);
    }
  } catch (e) {
    log(`[ProActReach] Failed to persist task result: ${e}`, "warn");
  }

  // Inject live into open chat via insertTaskResultBubble (permanent — NOT replaced
  // by welcome-back/nudges). If chat is closed, open it — the persisted turn
  // renders on init from persistedTurns. Do NOT use _storePendingMessage
  // (that feeds into the nudge system which replaces the message).
  try {
    const chatOpen = await isChatWindowOpen();
    if (chatOpen) {
      await browser.runtime.sendMessage({
        command: "proactive-checkin-message",
        message,
        idMapEntries: [],
        isTaskResult: true,
      });
      log(`[ProActReach] Injected task result bubble into open chat`);
    } else {
      await _openChatWindow();
      log(`[ProActReach] Opened chat window (task turn loads from persistence)`);
    }
  } catch (e) {
    log(`[ProActReach] Failed to deliver task result to chat: ${e}`, "warn");
  }

  // Show system notification (for visibility in taskbar/notification center)
  try {
    await browser.notifications.create(`task-${taskHash}-${Date.now()}`, {
      type: "basic",
      title: "Scheduled Task",
      message: content.replace(/\*\*/g, "").replace(/_([^_]+)_/g, "$1").slice(0, 200),
      iconUrl: "icons/icon-48.png",
    });
  } catch (e) {
    log(`[ProActReach] Failed to show task notification: ${e}`, "warn");
  }
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
      const legacyVal = stored[LEGACY_KEYS.ENABLED];
      await browser.storage.local.set({ [STORAGE.ENABLED]: legacyVal === true || legacyVal === "true" });
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

    // All reminders for alarm scheduling (both KB and message reminders)
    const allCandidates = reminders.filter(r => {
      if (r.enabled === false) return false;
      if (r.source === "kb") return true;
      return r.action === "reply";
    });

    // Only MESSAGE reminders trigger "new_reminder" nudges.
    // KB reminders (user-created) should ONLY notify via "due_approaching" (near time).
    const newReminderCandidates = allCandidates.filter(r => r.source !== "kb");

    // Prune orphaned reached_out entries (using full reminder list, not filtered candidates,
    // so that reached_out entries persist as long as the reminder exists regardless of action)
    await _pruneReachedOutIds(reminders);

    // Debounce - only process message reminders for "new_reminder" nudge
    if (newReminderCandidates.length > 0) {
      if (_debounceTimer) {
        clearTimeout(_debounceTimer);
        _debounceTimer = null;
      }

      _debounceTimer = setTimeout(() => {
        _debounceTimer = null;
        _handleNewReminders(newReminderCandidates).catch(e => {
          log(`[ProActReach] Debounced new-reminder handler failed: ${e}`, "warn");
        });
      }, _debounceMs());
    } else {
      log(`[ProActReach] No message reminders for new-reminder nudge (KB reminders only notify at due time)`);
    }

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
      log(`[ProActReach] consumePending: no pending message found`, 'debug');
      return null;
    }

    const age = Date.now() - (data.timestamp || 0);
    log(`[ProActReach] consumePending: found message (${data.message.length} chars, age=${Math.round(age / 1000)}s)`, 'debug');

    // Clear it immediately
    await browser.storage.local.remove(STORAGE.PENDING_MSG);

    // Stale threshold: 5 minutes
    const staleMs = 5 * 60_000;
    if (age > staleMs) {
      log(`[ProActReach] consumePending: DISCARDING stale message (age=${Math.round(age / 1000)}s)`, 'debug');
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
      } else if (alarm.name === TASK_ALARM_NAME) {
        log(`[ProActReach] Task eval alarm fired`);
        _handleTaskEvaluation().catch(e => {
          log(`[ProActReach] Task eval handler failed: ${e}`, "warn");
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

  // Schedule periodic task evaluation alarm (runs regardless of proactive enabled,
  // since tasks have their own task.enabled setting)
  try {
    await browser.alarms.create(TASK_ALARM_NAME, { periodInMinutes: TASK_EVAL_INTERVAL_MINUTES });
    log(`[ProActReach] Task eval alarm scheduled (every ${TASK_EVAL_INTERVAL_MINUTES} min)`);
  } catch (e) {
    log(`[ProActReach] Failed to schedule task eval alarm: ${e}`, "warn");
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

  // Clear task eval alarm
  try {
    browser.alarms.clear(TASK_ALARM_NAME);
  } catch (e) {
    log(`[ProActReach] Failed to clear task eval alarm: ${e}`, "warn");
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

// ─────────────────────────────────────────────────────────────
// Test-only exports (pure-logic helpers for unit testing)
// ─────────────────────────────────────────────────────────────

export const _testExports = {
  _hashReminderList,
  _formatDueLabel,
  _resolveDueDateTime,
  _getDateMidnightsInTimezone,
  _getTimezoneOffsetMs,
  _buildNewReminderMessage,
  _buildNewRemindersMessage,
  _buildDueApproachingMessage,
};
