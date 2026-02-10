/**
 * ChatLink FSM Timeout Manager
 *
 * Manages timeouts for FSM tools awaiting user confirmation via WhatsApp.
 * Auto-cancels sessions that exceed the configured timeout.
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { log } from "../../agent/modules/utils.js";
import { ctx } from "../../chat/modules/context.js";
import { CHAT_SETTINGS } from "../../chat/modules/chatConfig.js";
import { isChatLinkMessage, relayResponse } from "./core.js";

// Track active timeouts by FSM pid
const activeTimeouts = new Map();

/**
 * Start a timeout for an FSM session awaiting user confirmation.
 * Only applies to ChatLink messages.
 *
 * @param {string|number} pid - The FSM process ID
 */
export function startFsmTimeout(pid) {
  if (!isChatLinkMessage()) {
    return; // Only timeout ChatLink sessions
  }

  const timeoutMs = CHAT_SETTINGS?.chatLinkFsmTimeoutMs || 300000;
  if (timeoutMs <= 0) {
    log(`[ChatLink Timeout] FSM timeout disabled (timeout=0)`);
    return;
  }

  // Clear any existing timeout for this pid
  clearFsmTimeout(pid);

  log(`[ChatLink Timeout] Starting ${timeoutMs}ms timeout for FSM pid=${pid}`);

  const timeoutId = setTimeout(async () => {
    await handleFsmTimeout(pid);
  }, timeoutMs);

  activeTimeouts.set(String(pid), timeoutId);
}

/**
 * Clear an active FSM timeout.
 * Call this when user responds or FSM session ends.
 *
 * @param {string|number} pid - The FSM process ID
 */
export function clearFsmTimeout(pid) {
  const key = String(pid);
  const timeoutId = activeTimeouts.get(key);

  if (timeoutId) {
    clearTimeout(timeoutId);
    activeTimeouts.delete(key);
    log(`[ChatLink Timeout] Cleared timeout for FSM pid=${pid}`);
  }
}

/**
 * Clear all active FSM timeouts.
 * Call on chat window close or disconnect.
 */
export function clearAllFsmTimeouts() {
  for (const [pid, timeoutId] of activeTimeouts) {
    clearTimeout(timeoutId);
    log(`[ChatLink Timeout] Cleared timeout for FSM pid=${pid}`);
  }
  activeTimeouts.clear();
}

/**
 * Handle FSM timeout - auto-cancel the session.
 *
 * @param {string|number} pid - The FSM process ID
 */
async function handleFsmTimeout(pid) {
  const key = String(pid);
  activeTimeouts.delete(key);

  log(`[ChatLink Timeout] FSM session timed out, pid=${pid}`);

  try {
    // Send timeout message to WhatsApp
    const timeoutMsg = "⏱️ Session timed out - no response received. Please start a new request if needed.";
    await relayResponse(timeoutMsg, { isIntermediate: false });

    // Mark the FSM session as failed with timeout reason
    if (ctx.fsmSessions && ctx.fsmSessions[pid]) {
      ctx.fsmSessions[pid].failReason = "Session timed out waiting for user confirmation (WhatsApp). User did not respond within the allowed time.";
    }

    // Clear any pending suggestion
    try {
      ctx.pendingSuggestion = null;
      if (window.tmHideSuggestion) {
        window.tmHideSuggestion();
      }
    } catch (_) {}

    // Set active pid and transition to exec_fail
    try {
      ctx.activePid = pid;
      ctx.state = "exec_fail";

      // Execute the fail state
      const { executeAgentAction } = await import("../../chat/fsm/core.js");
      await executeAgentAction();
    } catch (e) {
      log(`[ChatLink Timeout] Failed to execute exec_fail: ${e}`, "error");
    }
  } catch (e) {
    log(`[ChatLink Timeout] Timeout handler failed: ${e}`, "error");
  }
}
