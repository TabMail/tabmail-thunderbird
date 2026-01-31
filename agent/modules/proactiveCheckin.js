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
let _postCooldownTimer = null;
let _alarmListener = null;
let _isCheckinInFlight = false;
let _lastCheckinTime = 0;
let _lastCheckinResult = null;
let _isInitialized = false;

const INTERVAL_STORAGE_KEY = "proactiveCheckinIntervalMinutes";
const INTERVAL_DEFAULT = 5;

// ─────────────────────────────────────────────────────────────
// Config helpers
// ─────────────────────────────────────────────────────────────

function _cfg() {
  return SETTINGS?.proactiveCheckin || {};
}

async function _isEnabled() {
  try {
    const stored = await browser.storage.local.get({ proactiveCheckinEnabled: false });
    return stored.proactiveCheckinEnabled === true;
  } catch (e) {
    log(`[ProActCheck] _isEnabled storage read failed: ${e}`, "warn");
    return !!_cfg().enabled; // fallback to in-memory config
  }
}

function _debounceMs() {
  return Number(_cfg().debounceMs) || 1000;
}

async function _intervalMinutes() {
  try {
    const stored = await browser.storage.local.get({ [INTERVAL_STORAGE_KEY]: INTERVAL_DEFAULT });
    const val = Number(stored[INTERVAL_STORAGE_KEY]);
    return (val >= 1 && val <= 60) ? val : INTERVAL_DEFAULT;
  } catch (e) {
    log(`[ProActCheck] _intervalMinutes storage read failed: ${e}`, "warn");
    return INTERVAL_DEFAULT;
  }
}

async function _intervalMs() {
  return (await _intervalMinutes()) * 60 * 1000;
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
    log(`[ProActCheck] _isChatWindowOpen failed: ${e}`, "warn");
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
          log(`[ProActCheck] Focused existing chat window id=${w.id}`);
          return;
        }
      }
    }
    await browser.windows.create({ url, type: "popup", width: 600, height: 800 });
    log("[ProActCheck] Opened new chat window for proactive message");
  } catch (e) {
    log(`[ProActCheck] Failed to open chat window: ${e}`, "error");
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
      const ago = _lastCheckinTime ? Math.round((Date.now() - _lastCheckinTime) / 1000) : 0;
      log(`[ProActCheck] Restored state: lastCheckin=${new Date(_lastCheckinTime).toISOString()} (${ago}s ago), result="${_lastCheckinResult}"`);
    } else {
      log(`[ProActCheck] No persisted state found (first run)`);
    }
  } catch (e) {
    log(`[ProActCheck] Failed to restore state: ${e}`, "warn");
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
    log(`[ProActCheck] Failed to persist state: ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// Core check-in logic
// ─────────────────────────────────────────────────────────────

function _schedulePostIntervalCheck() {
  // Cancel any existing post-interval timer
  if (_postCooldownTimer) {
    clearTimeout(_postCooldownTimer);
    _postCooldownTimer = null;
  }

  // Read interval from storage (async) and schedule the timer
  _intervalMs().then(intervalMs => {
    // Timer fires after the full interval from _lastCheckinTime
    const remaining = Math.max(0, intervalMs - (Date.now() - _lastCheckinTime));
    log(`[ProActCheck] Scheduling post-interval auto-check in ${Math.round(remaining / 1000)}s`);

    _postCooldownTimer = setTimeout(() => {
      _postCooldownTimer = null;
      log(`[ProActCheck] Post-interval timer fired, triggering auto-check`);
      _triggerCheckin("post_interval").catch(e => {
        log(`[ProActCheck] Post-interval auto-check failed: ${e}`, "warn");
      });
    }, remaining);
  }).catch(e => {
    log(`[ProActCheck] Failed to schedule post-interval check: ${e}`, "warn");
  });
}

async function _triggerCheckin(triggerReason) {
  log(`[ProActCheck] ── _triggerCheckin called: reason="${triggerReason}"`);

  // Guard: feature disabled
  if (!(await _isEnabled())) {
    log(`[ProActCheck] SKIP: feature disabled (reason=${triggerReason})`);
    return;
  }

  // Guard: already in flight
  if (_isCheckinInFlight) {
    log(`[ProActCheck] SKIP: already in flight (reason=${triggerReason})`);
    return;
  }

  // Guard: minimum interval — block all triggers during the interval window.
  // When the interval expires, a post-cooldown auto-check fires to catch missed changes.
  const intervalMs = await _intervalMs();
  const elapsed = _lastCheckinTime ? Date.now() - _lastCheckinTime : Infinity;
  if (_lastCheckinTime && elapsed < intervalMs) {
    const remaining = Math.ceil((intervalMs - elapsed) / 1000);
    log(`[ProActCheck] SKIP: interval active, ${remaining}s remaining, elapsed=${Math.round(elapsed / 1000)}s, interval=${Math.round(intervalMs / 1000)}s (reason=${triggerReason})`);
    return;
  }
  log(`[ProActCheck] Guard passed: interval OK (elapsed=${_lastCheckinTime ? Math.round(elapsed / 1000) + "s" : "never"}, interval=${Math.round(intervalMs / 1000)}s)`);

  // Guard: user must be signed in
  try {
    const { isLoggedIn } = await import("./supabaseAuth.js");
    const signedIn = await isLoggedIn();
    if (!signedIn) {
      log(`[ProActCheck] SKIP: user not signed in (reason=${triggerReason})`);
      return;
    }
    log(`[ProActCheck] Guard passed: user signed in`);
  } catch (e) {
    log(`[ProActCheck] SKIP: auth check failed: ${e} (reason=${triggerReason})`, "warn");
    return;
  }

  _isCheckinInFlight = true;
  _lastCheckinTime = Date.now();
  const startTime = Date.now();

  try {
    log(`[ProActCheck] ══ STARTING CHECK-IN ══ trigger="${triggerReason}" at ${new Date().toISOString()}`);

    // Create an isolated ID translation context for this session.
    // Each headless session gets its own idMap so concurrent sessions
    // (proactiveCheckin, replyGenerator) don't contaminate each other.
    let idContext;
    try {
      const { createIsolatedContext } = await import("../../chat/modules/idTranslator.js");
      idContext = createIsolatedContext();
    } catch (e) {
      log(`[ProActCheck] Failed to create isolated idContext: ${e}`, "warn");
    }

    // Build messages for the LLM (pass idContext so reminder IDs use isolated map)
    const messages = await _buildMessages(triggerReason, idContext);
    if (!messages || messages.length === 0) {
      log(`[ProActCheck] Failed to build messages, aborting`, "warn");
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

    log(`[ProActCheck] sendChatWithTools returned, response keys: ${response ? Object.keys(response).join(",") : "null"}`);

    if (response?.err) {
      log(`[ProActCheck] LLM error: ${response.err}`, "error");
      _lastCheckinResult = "error";
      return;
    }

    const assistantText = response?.assistant || "";
    log(`[ProActCheck] Raw assistant text (${assistantText.length} chars): ${assistantText.substring(0, 500)}${assistantText.length > 500 ? "..." : ""}`);

    if (!assistantText) {
      log(`[ProActCheck] LLM returned empty assistant text`, "warn");
      _lastCheckinResult = "empty";
      return;
    }

    // Parse JSON response
    const parsed = processJSONResponse(assistantText);
    log(`[ProActCheck] Parsed JSON: ${JSON.stringify(parsed)}`);

    const reachOut = parsed?.reach_out === true;
    const message = typeof parsed?.message === "string" ? parsed.message.trim() : "";

    log(`[ProActCheck] Decision: reach_out=${reachOut}, message_len=${message.length}${message ? `, message="${message.substring(0, 200)}"` : ""}`);

    if (reachOut && message) {
      // Persist the idMap alongside the message so the chat window can restore/merge it.
      let idMapEntries = [];
      if (idContext?.idMap?.size > 0) {
        idMapEntries = Array.from(idContext.idMap.entries());
        log(`[ProActCheck] Captured idMap with ${idMapEntries.length} entries for pending message`);
      }

      const chatOpen = await _isChatWindowOpen();
      if (chatOpen) {
        // Chat is already open — inject directly via runtime message
        log(`[ProActCheck] Chat window open, sending runtime message for direct injection`);
        try {
          await browser.runtime.sendMessage({
            command: "proactive-checkin-message",
            message,
            idMapEntries,
          });
          log(`[ProActCheck] Runtime message sent for direct injection`);
        } catch (e) {
          log(`[ProActCheck] Failed to send runtime message, falling back to pending: ${e}`, "warn");
          await _storePendingMessage(message, idMapEntries);
          await _openChatWindow();
        }
      } else {
        // Chat is closed — store pending message and open window
        await _storePendingMessage(message, idMapEntries);
        await _openChatWindow();
      }
      _lastCheckinResult = "reached_out";
    } else {
      _lastCheckinResult = "no_action";
      log(`[ProActCheck] No proactive outreach needed`);
    }
  } catch (e) {
    log(`[ProActCheck] Check-in failed: ${e}`, "error");
    _lastCheckinResult = "error";
  } finally {
    _isCheckinInFlight = false;
    const elapsedMs = Date.now() - startTime;
    log(`[ProActCheck] ══ CHECK-IN DONE ══ result="${_lastCheckinResult}" elapsed=${elapsedMs}ms trigger="${triggerReason}"`);
    await _persistState();

    // Schedule a post-interval auto-check: when the interval expires, run one more
    // check-in to catch any changes that arrived while we were in the interval window.
    _schedulePostIntervalCheck();
  }
}

async function _buildMessages(triggerReason, idContext) {
  try {
    log(`[ProActCheck] _buildMessages: loading context for trigger="${triggerReason}"`);

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

    const reminderCount = reminderResult?.reminders?.length || 0;
    log(`[ProActCheck] _buildMessages: userName="${userName}", kbLen=${userKBContent.length}, reminders=${reminderCount}, historyLen=${(recentChatHistory || "").length}`);

    // Build reminders JSON
    let remindersJson = "";
    if (reminderCount > 0) {
      // Apply ID translation
      let translatedReminders = reminderResult.reminders;
      try {
        const { processToolResultTBtoLLM } = await import("../../chat/modules/idTranslator.js");
        translatedReminders = processToolResultTBtoLLM(reminderResult.reminders, idContext);
      } catch (e) {
        log(`[ProActCheck] _buildMessages: ID translation failed, using original: ${e}`, "warn");
      }
      remindersJson = JSON.stringify(translatedReminders);
      log(`[ProActCheck] _buildMessages: remindersJson (${remindersJson.length} chars): ${remindersJson.substring(0, 300)}${remindersJson.length > 300 ? "..." : ""}`);
    } else {
      log(`[ProActCheck] _buildMessages: no reminders found`);
    }

    const currentTime = formatTimestampForAgent();

    // Single system message — backend expander builds full multi-message sequence
    // (system prompt + KB + reminders + history + agent_proactive_checkin user prompt)
    const systemMsg = {
      role: "system",
      content: "system_prompt_proactive_checkin",
      user_name: userName,
      user_kb_content: userKBContent,
      user_reminders_json: remindersJson,
      recent_chat_history: recentChatHistory || "",
      current_time: currentTime,
      trigger_reason: triggerReason,
    };

    log(`[ProActCheck] _buildMessages: built systemMsg, currentTime="${currentTime}", trigger="${triggerReason}"`);
    return [systemMsg];
  } catch (e) {
    log(`[ProActCheck] _buildMessages failed: ${e}`, "error");
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
    log(`[ProActCheck] Stored pending message (${message.length} chars)`);
  } catch (e) {
    log(`[ProActCheck] Failed to store pending message: ${e}`, "error");
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
    if (!data?.message) {
      log(`[ProActCheck] consumePending: no pending message found`);
      return null;
    }

    const age = Date.now() - (data.timestamp || 0);
    const msgPreview = data.message.substring(0, 100);
    const idMapCount = Array.isArray(data.idMapEntries) ? data.idMapEntries.length : 0;
    log(`[ProActCheck] consumePending: found message (${data.message.length} chars, age=${Math.round(age / 1000)}s, idMap=${idMapCount} entries): "${msgPreview}..."`);

    // Clear it immediately
    await browser.storage.local.remove(PENDING_MSG_KEY);

    // Check staleness (reuse interval as the stale threshold)
    const staleMs = await _intervalMs();
    if (age > staleMs) {
      log(`[ProActCheck] consumePending: DISCARDING stale message (age=${Math.round(age / 1000)}s > interval=${Math.round(staleMs / 1000)}s)`);
      return null;
    }

    log(`[ProActCheck] consumePending: returning message to chat (age=${Math.round(age / 1000)}s)`);
    return data;
  } catch (e) {
    log(`[ProActCheck] consumePending failed: ${e}`, "warn");
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
  const enabled = await _isEnabled();
  log(`[ProActCheck] onInboxUpdated called, enabled=${enabled}`);
  if (!enabled) {
    log(`[ProActCheck] onInboxUpdated: feature disabled, returning`);
    return;
  }

  try {
    const { buildReminderList } = await import("./reminderBuilder.js");
    const result = await buildReminderList();
    const reminderCount = result?.reminders?.length || 0;
    const newHash = _hashReminderList(result?.reminders || []);

    // Load stored hash
    const stored = await browser.storage.local.get(REMINDER_HASH_KEY);
    const oldHash = stored?.[REMINDER_HASH_KEY] || "";

    log(`[ProActCheck] onInboxUpdated: reminders=${reminderCount}, oldHash=${oldHash || "(none)"}, newHash=${newHash}`);

    if (newHash === oldHash) {
      log(`[ProActCheck] onInboxUpdated: hash unchanged, no check-in needed`);
      return;
    }

    // Hash changed — persist new hash and trigger check-in (debounced)
    await browser.storage.local.set({ [REMINDER_HASH_KEY]: newHash });
    log(`[ProActCheck] onInboxUpdated: hash CHANGED ${oldHash || "(none)"} -> ${newHash}, scheduling debounced check-in (${_debounceMs()}ms)`);

    // Debounce: cancel any pending trigger
    if (_debounceTimer) {
      clearTimeout(_debounceTimer);
      _debounceTimer = null;
      log(`[ProActCheck] onInboxUpdated: cancelled previous debounce timer`);
    }

    _debounceTimer = setTimeout(() => {
      _debounceTimer = null;
      log(`[ProActCheck] onInboxUpdated: debounce timer fired, triggering check-in`);
      _triggerCheckin("reminder_change").catch(e => {
        log(`[ProActCheck] Debounced trigger failed: ${e}`, "warn");
      });
    }, _debounceMs());
  } catch (e) {
    log(`[ProActCheck] onInboxUpdated failed: ${e}`, "warn");
  }
}

// ─────────────────────────────────────────────────────────────
// Lifecycle: init / cleanup
// ─────────────────────────────────────────────────────────────

export async function initProactiveCheckin() {
  if (_isInitialized) return;
  _isInitialized = true;

  const cfg = _cfg();
  const enabledAtInit = await _isEnabled();
  const intervalMin = await _intervalMinutes();
  log(`[ProActCheck] ══ INIT ══ enabled=${enabledAtInit}, debounceMs=${_debounceMs()}, intervalMin=${intervalMin}, config=${JSON.stringify(cfg)}`);

  // Restore persisted state
  await _restoreState();

  // Register alarm listener
  if (!_alarmListener) {
    _alarmListener = (alarm) => {
      if (alarm.name === ALARM_NAME) {
        log(`[ProActCheck] ⏰ Alarm fired: ${ALARM_NAME}`);
        _triggerCheckin("scheduled_alarm").catch(e => {
          log(`[ProActCheck] Alarm-triggered check-in failed: ${e}`, "warn");
        });
      }
    };
    browser.alarms.onAlarm.addListener(_alarmListener);
    log(`[ProActCheck] Alarm listener registered for "${ALARM_NAME}"`);
  }

  // Log any existing alarms for this name
  try {
    const existing = await browser.alarms.get(ALARM_NAME);
    if (existing) {
      const firesIn = Math.round((existing.scheduledTime - Date.now()) / 1000);
      log(`[ProActCheck] Existing alarm found: fires in ${firesIn}s (at ${new Date(existing.scheduledTime).toISOString()})`);
    } else {
      log(`[ProActCheck] No existing alarm found`);
    }
  } catch (e) {
    log(`[ProActCheck] Failed to check existing alarms: ${e}`, "warn");
  }
}

export function cleanupProactiveCheckin() {
  log(`[ProActCheck] Cleaning up`);

  // Clear timers
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  if (_postCooldownTimer) {
    clearTimeout(_postCooldownTimer);
    _postCooldownTimer = null;
  }

  // Remove alarm listener
  if (_alarmListener) {
    try {
      browser.alarms.onAlarm.removeListener(_alarmListener);
    } catch (e) {
      log(`[ProActCheck] Failed to remove alarm listener: ${e}`, "warn");
    }
    _alarmListener = null;
  }

  // Persist state synchronously-ish (best effort)
  _persistState().catch(() => {});

  _isInitialized = false;
}
