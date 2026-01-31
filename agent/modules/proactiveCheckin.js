// proactiveCheckin.js – Proactive check-in orchestrator (TB 145, MV3)
// Triggers headless LLM calls when reminders change or alarms fire.
// If the LLM decides to reach out, stores a pending message and opens the chat window.

import { SETTINGS } from "./config.js";
import { log } from "./utils.js";

const ALARM_NAME = "tabmail-proactive-checkin";
const REMINDER_HASH_KEY = "proactiveCheckin_reminderHash";
const PENDING_MSG_KEY = "proactiveCheckin_pendingMessage";
const LAST_CHECKIN_KEY = "proactiveCheckin_lastCheckin";

let _debounceTimer = null;
let _alarmListener = null;
let _isCheckinInFlight = false;
let _lastCheckinTime = 0;
let _lastCheckinResult = null;
let _isInitialized = false;

// ─────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────

function _cfg() {
  return SETTINGS?.proactiveCheckin || {};
}

function _isEnabled() {
  return !!_cfg().enabled;
}

function _debounceMs() {
  return Number(_cfg().debounceMs) || 1000;
}

function _cooldownMinutes() {
  return Number(_cfg().cooldownMinutes) || 5;
}

function _cooldownMs() {
  return _cooldownMinutes() * 60 * 1000;
}

// ─────────────────────────────────────────────────────────────
// Hashing
// ─────────────────────────────────────────────────────────────

/**
 * Simple hash of reminder list content for change detection.
 * Uses content + dueDate to detect meaningful changes.
 */
function _hashReminderList(reminders) {
  if (!Array.isArray(reminders) || reminders.length === 0) return "empty";
  // Sort by content for stable hash regardless of order
  const items = reminders
    .map(r => `${r.content || ""}|${r.dueDate || ""}`)
    .sort()
    .join("||");
  // Simple djb2 hash
  let hash = 5381;
  for (let i = 0; i < items.length; i++) {
    hash = ((hash << 5) + hash + items.charCodeAt(i)) & 0xffffffff;
  }
  return String(hash);
}

// ─────────────────────────────────────────────────────────────
// Chat window helpers
// ─────────────────────────────────────────────────────────────

async function _isChatWindowOpen() {
  try {
    const wins = await browser.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w && Array.isArray(w.tabs)) {
        if (w.tabs.some(t => t && typeof t.url === "string" && t.url.endsWith("/chat/chat.html"))) {
          return true;
        }
      }
    }
  } catch (e) {
    log(`[ProactiveCheckin] _isChatWindowOpen failed: ${e}`, "warn");
  }
  return false;
}

async function _openChatWindow() {
  try {
    const url = browser.runtime.getURL("chat/chat.html");
    // Check for existing window first
    const wins = await browser.windows.getAll({ populate: true });
    for (const w of wins) {
      if (w && Array.isArray(w.tabs)) {
        if (w.tabs.some(t => t && typeof t.url === "string" && t.url.endsWith("/chat/chat.html"))) {
          await browser.windows.update(w.id, { focused: true });
          log(`[ProactiveCheckin] Focused existing chat window id=${w.id}`);
          return;
        }
      }
    }
    await browser.windows.create({ url, type: "popup", width: 600, height: 800 });
    log("[ProactiveCheckin] Opened new chat window for proactive message");
  } catch (e) {
    log(`[ProactiveCheckin] Failed to open chat window: ${e}`, "error");
  }
}

// ─────────────────────────────────────────────────────────────
// State persistence
// ─────────────────────────────────────────────────────────────

async function _restoreState() {
  try {
    const stored = await browser.storage.local.get(LAST_CHECKIN_KEY);
    const data = stored?.[LAST_CHECKIN_KEY];
    if (data) {
      _lastCheckinTime = Number(data.time) || 0;
      _lastCheckinResult = data.result || null;
      log(`[ProactiveCheckin] Restored state: lastCheckin=${new Date(_lastCheckinTime).toISOString()}, result=${_lastCheckinResult}`);
    }
  } catch (e) {
    log(`[ProactiveCheckin] Failed to restore state: ${e}`, "warn");
  }
}

async function _persistState() {
  try {
    await browser.storage.local.set({
      [LAST_CHECKIN_KEY]: {
        time: _lastCheckinTime,
        result: _lastCheckinResult,
      },
    });
  } catch (e) {
    log(`[ProactiveCheckin] Failed to persist state: ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// Core check-in logic
// ─────────────────────────────────────────────────────────────

async function _triggerCheckin(triggerReason) {
  // Guard: feature disabled
  if (!_isEnabled()) {
    log(`[ProactiveCheckin] Disabled, skipping trigger (${triggerReason})`);
    return;
  }

  // Guard: already in flight
  if (_isCheckinInFlight) {
    log(`[ProactiveCheckin] Check-in already in flight, skipping (${triggerReason})`);
    return;
  }

  // Guard: chat window currently open — don't interrupt active conversation
  if (await _isChatWindowOpen()) {
    log(`[ProactiveCheckin] Chat window open, skipping (${triggerReason})`);
    return;
  }

  // Guard: cooldown
  const cd = _cooldownMs();
  if (_lastCheckinTime && (Date.now() - _lastCheckinTime) < cd) {
    const remaining = Math.ceil((cd - (Date.now() - _lastCheckinTime)) / 1000);
    log(`[ProactiveCheckin] Cooldown active (${remaining}s remaining), skipping (${triggerReason})`);
    return;
  }

  // Guard: user must be signed in
  try {
    const { isLoggedIn } = await import("./supabaseAuth.js");
    if (!(await isLoggedIn())) {
      log(`[ProactiveCheckin] User not signed in, skipping (${triggerReason})`);
      return;
    }
  } catch (e) {
    log(`[ProactiveCheckin] Auth check failed, skipping: ${e}`, "warn");
    return;
  }

  _isCheckinInFlight = true;
  _lastCheckinTime = Date.now();

  try {
    log(`[ProactiveCheckin] Starting check-in: trigger=${triggerReason}`);

    // Create an isolated ID translation context for this session.
    // Each headless session gets its own idMap so concurrent sessions
    // (proactiveCheckin, replyGenerator) don't contaminate each other.
    let idContext;
    try {
      const { createIsolatedContext } = await import("../../chat/modules/idTranslator.js");
      idContext = createIsolatedContext();
    } catch (e) {
      log(`[ProactiveCheckin] Failed to create isolated idContext: ${e}`, "warn");
    }

    // Build messages for the LLM (pass idContext so reminder IDs use isolated map)
    const messages = await _buildMessages(triggerReason, idContext);
    if (!messages || messages.length === 0) {
      log(`[ProactiveCheckin] Failed to build messages, aborting`, "warn");
      return;
    }

    // Call LLM with tools (headless — no UI callback)
    const { sendChatWithTools, processJSONResponse } = await import("./llm.js");
    const { executeToolsHeadless } = await import("../../chat/tools/core.js");

    // Wrap executeToolsHeadless with the isolated idContext so all tool
    // call translations during this session use the same scoped map.
    const scopedExecutor = (toolCalls, tokenUsage) => executeToolsHeadless(toolCalls, tokenUsage, idContext);

    const response = await sendChatWithTools(messages, {
      ignoreSemaphore: true,
      onToolExecution: scopedExecutor,
    });

    if (response?.err) {
      log(`[ProactiveCheckin] LLM error: ${response.err}`, "error");
      _lastCheckinResult = "error";
      return;
    }

    const assistantText = response?.assistant || "";
    if (!assistantText) {
      log(`[ProactiveCheckin] LLM returned empty response`, "warn");
      _lastCheckinResult = "empty";
      return;
    }

    // Parse JSON response
    const parsed = processJSONResponse(assistantText);
    const reachOut = parsed?.reach_out === true;
    const message = typeof parsed?.message === "string" ? parsed.message.trim() : "";

    log(`[ProactiveCheckin] LLM decision: reach_out=${reachOut}, message_len=${message.length}`);

    if (reachOut && message) {
      // Persist the idMap alongside the message so the chat window can restore it.
      // The idMap (numericId → realId) was populated during this headless session
      // from reminder translation + tool calls, but the chat window is a separate
      // context that needs the mapping to resolve [Email](id) references.
      let idMapEntries = [];
      if (idContext?.idMap?.size > 0) {
        idMapEntries = Array.from(idContext.idMap.entries());
        log(`[ProactiveCheckin] Captured idMap with ${idMapEntries.length} entries for pending message`);
      }

      await _storePendingMessage(message, idMapEntries);
      _lastCheckinResult = "reached_out";
      await _openChatWindow();
    } else {
      _lastCheckinResult = "no_action";
      log(`[ProactiveCheckin] No proactive outreach needed`);
    }
  } catch (e) {
    log(`[ProactiveCheckin] Check-in failed: ${e}`, "error");
    _lastCheckinResult = "error";
  } finally {
    _isCheckinInFlight = false;
    await _persistState();
  }
}

async function _buildMessages(triggerReason, idContext) {
  try {
    const { getUserKBPrompt } = await import("./promptGenerator.js");
    const { buildReminderList } = await import("./reminderBuilder.js");
    const { getRecentChatHistoryForPrompt, pruneOldSessions } = await import("./chatHistoryQueue.js");
    const { getUserName, formatTimestampForAgent } = await import("../../chat/modules/helpers.js");

    // Load context in parallel
    const [userName, userKBContent, reminderResult, recentChatHistory] = await Promise.all([
      getUserName({ fullname: true }),
      getUserKBPrompt().then(v => v || "").catch(() => ""),
      buildReminderList().catch(() => ({ reminders: [] })),
      pruneOldSessions().then(() => getRecentChatHistoryForPrompt()).catch(() => ""),
    ]);

    // Build reminders JSON
    let remindersJson = "";
    if (reminderResult?.reminders?.length > 0) {
      // Apply ID translation
      let translatedReminders = reminderResult.reminders;
      try {
        const { processToolResultTBtoLLM } = await import("../../chat/modules/idTranslator.js");
        translatedReminders = processToolResultTBtoLLM(reminderResult.reminders, idContext);
      } catch (e) {
        log(`[ProactiveCheckin] ID translation failed, using original: ${e}`, "warn");
      }
      remindersJson = JSON.stringify(translatedReminders);
    }

    // Single system message — backend expander builds full multi-message sequence
    // (system prompt + KB + reminders + history + agent_proactive_checkin user prompt)
    const systemMsg = {
      role: "system",
      content: "system_prompt_proactive_checkin",
      user_name: userName,
      user_kb_content: userKBContent,
      user_reminders_json: remindersJson,
      recent_chat_history: recentChatHistory || "",
      current_time: formatTimestampForAgent(),
      trigger_reason: triggerReason,
    };

    return [systemMsg];
  } catch (e) {
    log(`[ProactiveCheckin] _buildMessages failed: ${e}`, "error");
    return null;
  }
}

async function _storePendingMessage(message, idMapEntries = []) {
  try {
    await browser.storage.local.set({
      [PENDING_MSG_KEY]: {
        message,
        timestamp: Date.now(),
        idMapEntries,
      },
    });
    log(`[ProactiveCheckin] Stored pending message (${message.length} chars)`);
  } catch (e) {
    log(`[ProactiveCheckin] Failed to store pending message: ${e}`, "error");
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
    const stored = await browser.storage.local.get(PENDING_MSG_KEY);
    const data = stored?.[PENDING_MSG_KEY];
    if (!data?.message) return null;

    // Clear it immediately
    await browser.storage.local.remove(PENDING_MSG_KEY);

    // Check staleness (reuse cooldown as the stale threshold)
    const age = Date.now() - (data.timestamp || 0);
    if (age > _cooldownMs()) {
      log(`[ProactiveCheckin] Discarding stale proactive message (age=${Math.round(age / 1000)}s)`);
      return null;
    }

    log(`[ProactiveCheckin] Consumed pending proactive message (age=${Math.round(age / 1000)}s)`);
    return data;
  } catch (e) {
    log(`[ProactiveCheckin] consumePendingProactiveMessage failed: ${e}`, "warn");
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// Public API: called from messageProcessorQueue.js after drain
// ─────────────────────────────────────────────────────────────

/**
 * Called after PMQ processes messages (processed > 0).
 * Rebuilds reminder list, hashes it, and triggers check-in only if changed.
 */
export async function onInboxUpdated() {
  if (!_isEnabled()) return;

  try {
    const { buildReminderList } = await import("./reminderBuilder.js");
    const result = await buildReminderList();
    const newHash = _hashReminderList(result?.reminders || []);

    // Load stored hash
    const stored = await browser.storage.local.get(REMINDER_HASH_KEY);
    const oldHash = stored?.[REMINDER_HASH_KEY] || "";

    if (newHash === oldHash) {
      log(`[ProactiveCheckin] Reminder hash unchanged (${newHash}), no check-in needed`);
      return;
    }

    // Hash changed — persist new hash and trigger check-in (debounced)
    await browser.storage.local.set({ [REMINDER_HASH_KEY]: newHash });
    log(`[ProactiveCheckin] Reminder hash changed: ${oldHash} -> ${newHash}, scheduling check-in`);

    // Debounce: cancel any pending trigger
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
    }

    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      _triggerCheckin("reminder_change").catch(e => {
        log(`[ProactiveCheckin] Debounced trigger failed: ${e}`, "warn");
      });
    }, _debounceMs());
  } catch (e) {
    log(`[ProactiveCheckin] onInboxUpdated failed: ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// Lifecycle: init / cleanup
// ─────────────────────────────────────────────────────────────

export async function initProactiveCheckin() {
  if (_isInitialized) return;
  _isInitialized = true;

  log(`[ProactiveCheckin] Initializing (enabled=${_isEnabled()})`);

  // Restore persisted state
  await _restoreState();

  // Register alarm listener
  if (!_alarmListener) {
    _alarmListener = (alarm) => {
      if (alarm.name === ALARM_NAME) {
        log(`[ProactiveCheckin] Alarm fired: ${ALARM_NAME}`);
        _triggerCheckin("scheduled_alarm").catch(e => {
          log(`[ProactiveCheckin] Alarm-triggered check-in failed: ${e}`, "warn");
        });
      }
    };
    browser.alarms.onAlarm.addListener(_alarmListener);
    log(`[ProactiveCheckin] Alarm listener registered`);
  }
}

export function cleanupProactiveCheckin() {
  log(`[ProactiveCheckin] Cleaning up`);

  // Clear debounce timer
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }

  // Remove alarm listener
  if (_alarmListener) {
    try {
      browser.alarms.onAlarm.removeListener(_alarmListener);
    } catch (e) {
      log(`[ProactiveCheckin] Failed to remove alarm listener: ${e}`, "warn");
    }
    _alarmListener = null;
  }

  // Persist state synchronously-ish (best effort)
  _persistState().catch(() => {});

  _isInitialized = false;
}
