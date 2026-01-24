// sseTools.js – SSE-based tool orchestration client for chat window (TB 141+, MV3)
// Replaces WebSocket with GET+SSE "turns" approach

import { getBackendUrl, SETTINGS } from "../../agent/modules/config.js";
import { log, saveToolCallLog } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { executeToolByName, getToolActivityLabel, isServerSideTool, resetFsmChainTracking } from "../tools/core.js";
import { assertAiBackendAllowed } from "./privacySettings.js";

let _currentRequestId = null;
let _activeToolListener = null; // AbortController for current tool_listen connection
let _toolListenRetries = 0;
const MAX_TOOL_LISTEN_RETRIES = 3;
const TOOL_LISTEN_RETRY_DELAY_MS = 1000;
let _lastServerSideToolBubble = null; // Track last server-side tool bubble for loading indicator cleanup

/**
 * Clean up loading indicator from last server-side tool bubble (called when agent response arrives).
 * @returns {void}
 */
export function cleanupServerSideToolLoading() {
  if (_lastServerSideToolBubble) {
    try {
      _lastServerSideToolBubble.classList.remove("loading");
      log(`[SSETools] Cleaned up loading indicator from server-side tool bubble`);
    } catch (_) {}
    _lastServerSideToolBubble = null;
  }
}

/**
 * Start listening for tool requests for a specific request_id.
 * Opens an SSE connection to /agent/sse/tool_listen?request_id=...
 * 
 * @param {string} requestId - Unique request ID for this LLM call
 * @returns {Promise<void>}
 */
export async function startToolListener(requestId) {
  console.log(`[SSETOOLS_DEBUG] startToolListener called with requestId=${requestId}`);
  try {
    await assertAiBackendAllowed("SSETools.startToolListener");

    if (!requestId || typeof requestId !== "string") {
      console.log(`[SSETOOLS_DEBUG] ERROR: Invalid requestId`);
      log(`[SSETools] startToolListener requires a string requestId`, "error");
      return;
    }

    // Cancel any existing listener
    if (_activeToolListener) {
      console.log(`[SSETOOLS_DEBUG] Aborting existing listener`);
      try {
        _activeToolListener.abort();
      } catch (_) {}
      _activeToolListener = null;
    }

    // Reset FSM chain tracking when starting a new request (new user turn)
    // This allows FSM tools to be called again in the new turn
    try {
      resetFsmChainTracking();
      log(`[SSETools] Reset FSM chain tracking for new request_id=${requestId}`);
    } catch (e) {
      log(`[SSETools] Failed to reset FSM chain tracking: ${e}`, "warn");
    }

    _currentRequestId = requestId;
    _toolListenRetries = 0;

    console.log(`[SSETOOLS_DEBUG] Calling _connectToolListener (will resume after initial keepalive)`);
    log(`[SSETools] Starting tool listener for request_id=${requestId}`);

    // Start in background - don't block
    _connectToolListener(requestId).catch(e => {
      console.log(`[SSETOOLS_DEBUG] Tool listener error: ${e}`);
      log(`[SSETools] Tool listener error: ${e}`, "error");
    });
    
    console.log(`[SSETOOLS_DEBUG] Returning from startToolListener (listener running in background)`);
  } catch (e) {
    console.log(`[SSETOOLS_DEBUG] Exception in startToolListener: ${e}`);
    log(`[SSETools] Failed to start tool listener: ${e}`, "error");
  }
}

/**
 * Internal function to establish SSE connection to tool_listen endpoint.
 * 
 * @param {string} requestId - Request ID
 * @returns {Promise<void>}
 */
async function _connectToolListener(requestId) {
  console.log(`[SSETOOLS_DEBUG] _connectToolListener started for requestId=${requestId}`);
  try {
    // Tool listener is always on the agent endpoint
    const backendUrl = await getBackendUrl("agent");
    console.log(`[SSETOOLS_DEBUG] Got backend URL: ${backendUrl}`);
    
    const url = new URL(`${backendUrl}/agent/sse/tool_listen`);
    url.searchParams.set("request_id", requestId);

    console.log(`[SSETOOLS_DEBUG] Connecting to ${url.toString()}`);
    log(`[SSETools] Connecting to ${url.toString()}`);

    const abortController = new AbortController();
    _activeToolListener = abortController;

    console.log(`[SSETOOLS_DEBUG] About to fetch...`);
    
    // Get Supabase access token
    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();
    if (!accessToken) {
      throw new Error("Not authenticated. Please sign in.");
    }

    let response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Accept": "text/event-stream",
        "Cache-Control": "no-cache",
        "Authorization": `Bearer ${accessToken}`
      },
      signal: abortController.signal,
    });

    console.log(`[SSETOOLS_DEBUG] Fetch completed, status=${response.status}`);

    if (!response.ok) {
      // Check if this is an auth error and handle re-authentication
      const { isAuthError, handleAuthError } = await import("../../agent/modules/supabaseAuth.js");
      if (isAuthError(response)) {
        log(`[SSETools] Auth error detected on tool_listen (${response.status}), checking auth state`);
        const authResult = await handleAuthError(response);
        if (authResult === "consent_required") {
          // Consent gate required; user must complete consent before any tools/features.
          // Don't spam the user with tool listener errors; just stop trying.
          log(`[SSETools] Consent required; skipping tool_listen connection`);
          try {
            await browser.storage.local.set({ tabmailConsentRequired: true });
          } catch (_) {}
          return;
        } else if (authResult === null) {
          // Feature is disabled (logged in but endpoint requires different tier)
          // Silently ignore - do not retry, do not throw error
          log(`[SSETools] Feature disabled (logged in but endpoint requires different tier), silently ignoring tool_listen connection`);
          return; // Silently return without connecting
        } else if (authResult === true) {
          // Retry the connection after successful re-auth
          log(`[SSETools] Re-authentication successful, retrying tool_listen connection`);
          // Get new token after re-auth
          const newAccessToken = await getAccessToken();
          if (!newAccessToken) {
            throw new Error("Failed to get access token after re-auth");
          }
          // Note: Using same abortController so retry can be cancelled
          response = await fetch(url.toString(), {
            method: "GET",
            headers: {
              "Accept": "text/event-stream",
              "Cache-Control": "no-cache",
              "Authorization": `Bearer ${newAccessToken}`
            },
            signal: abortController.signal, // Reuse same controller for cancellation
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText} (after re-auth)`);
          }
        } else {
          throw new Error(`Authentication required for tool_listen`);
        }
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    }

    console.log(`[SSETOOLS_DEBUG] Connected successfully, reading stream...`);
    log(`[SSETools] Connected to tool_listen endpoint`);

    // Read SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        log(`[SSETools] tool_listen stream ended`);
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // Process complete SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer

      let currentEvent = null;
      let currentData = null;

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.substring(6).trim();
        } else if (line.startsWith("data:")) {
          currentData = line.substring(5).trim();
        } else if (line === "" && currentEvent && currentData) {
          // Complete event received
          await _handleToolEvent(currentEvent, currentData, requestId);
          currentEvent = null;
          currentData = null;
        }
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      log(`[SSETools] tool_listen connection aborted`, "info");
      return;
    }

    log(`[SSETools] tool_listen connection error: ${e}`, "error");

    // Retry logic
    if (_toolListenRetries < MAX_TOOL_LISTEN_RETRIES && _currentRequestId === requestId) {
      _toolListenRetries++;
      log(`[SSETools] Retrying tool_listen (attempt ${_toolListenRetries}/${MAX_TOOL_LISTEN_RETRIES})`, "warn");
      await new Promise(resolve => setTimeout(resolve, TOOL_LISTEN_RETRY_DELAY_MS));
      await _connectToolListener(requestId);
    } else {
      log(`[SSETools] Max retries reached or request changed, giving up`, "error");
    }
  }
}

/**
 * Handle an SSE event from the tool_listen endpoint.
 * 
 * @param {string} event - Event type (keepalive, tool_request, timeout, error)
 * @param {string} data - Event data (JSON string)
 * @param {string} requestId - Current request ID
 * @returns {Promise<void>}
 */
async function _handleToolEvent(event, data, requestId) {
  try {
    switch (event) {
      case "keepalive":
        // No-op, just keeping connection alive
        break;

      case "tool_request":
        log(`[SSETools] Received tool_request event`);
        const toolReq = JSON.parse(data);
        await _handleToolRequest(toolReq, requestId);
        
        // After handling tool request, connection will close
        // Re-open immediately for the next turn (no delay needed)
        log(`[SSETools] Re-opening tool_listen for next turn`);
        _toolListenRetries = 0;
        if (_currentRequestId === requestId) {
          _connectToolListener(requestId);
        }
        break;

      case "timeout":
        log(`[SSETools] Tool listen timeout: ${data}`, "warn");
        break;

      case "error":
        log(`[SSETools] Tool listen error: ${data}`, "error");
        break;

      default:
        log(`[SSETools] Unknown event type: ${event}`, "warn");
    }
  } catch (e) {
    log(`[SSETools] Failed to handle tool event: ${e}`, "error");
  }
}

/**
 * Handle a tool_request from the backend.
 * Executes the tool and sends the result back via POST /agent/sse/tool_result.
 * 
 * @param {object} toolReq - Tool request object {type, request_id, call_id, name, arguments}
 * @param {string} requestId - Current request ID
 * @returns {Promise<void>}
 */
async function _handleToolRequest(toolReq, requestId) {
  try {
    const { call_id, name, arguments: argsJson, token_usage } = toolReq;

    if (!call_id || !name) {
      log(`[SSETools] Invalid tool_request: missing call_id or name`, "error");
      return;
    }

    // Update token usage if provided
    if (token_usage) {
      try {
        const ev = new CustomEvent("tokenUsageUpdated", { detail: token_usage });
        window.dispatchEvent(ev);
        const used = token_usage.total_tokens;
        const limit = token_usage.context_limit;
        const pct = token_usage.usage_percentage;
        log(
          `[SSETools] Token usage updated: ${used}/${limit} tokens (${pct}%)`
        );
      } catch (e) {
        log(`[SSETools] Failed to dispatch tokenUsageUpdated: ${e}`, "warn");
      }
    }

    let args = {};
    try {
      args = typeof argsJson === "string" ? JSON.parse(argsJson) : argsJson || {};
    } catch (_) {
      args = argsJson || {};
    }

    log(`[SSETools] Tool requested: ${name} call_id=${call_id}`);

    // Record active tool call id BEFORE creating the activity bubble so the
    // bubble can be auto-grouped/indented as a tool bubble with pid.
    try {
      const { ctx } = await import("../modules/context.js");
      ctx.activeToolCallId = call_id || null;
      log(`[SSETools] Set activeToolCallId=${ctx.activeToolCallId} prior to bubble creation`);
    } catch (_) {}

    // Remove loading indicator from previous server-side tool bubble (if any)
    if (_lastServerSideToolBubble) {
      try {
        _lastServerSideToolBubble.classList.remove("loading");
        log(`[SSETools] Removed loading indicator from previous server-side tool bubble`);
      } catch (_) {}
      _lastServerSideToolBubble = null;
    }

    // Show activity bubble for this tool (auto-tagged by createNewAgentBubble)
    const activity = await getToolActivityLabel(name, args);
    const agentBubble = await createNewAgentBubble(activity);

    // Server-side tools: just display the activity bubble, don't execute or send result
    if (isServerSideTool(name)) {
      const displayLabel = args._display_label || "Processing";
      log(`[SSETools] Server-side tool detected: showing '${displayLabel}' activity only, no execution`);
      // Store bubble reference to remove loading indicator when next event arrives
      _lastServerSideToolBubble = agentBubble;
      
      // Save tool call log for server-side tools (matches wsTools/sseTools format)
      try {
        await saveToolCallLog(
          "tabmail_agent_toolcall_server_side",
          `${Date.now()}_server_side_tool`,
          { name: "server_side_tool", display_label: displayLabel, server_side: true, call_id }
        );
        log(`[SSETools] Saved server-side tool call log: ${displayLabel}`);
      } catch (logErr) {
        log(`[SSETools] Failed to save server-side tool log: ${logErr}`, "warn");
      }
      
      // Keep loading indicator active - it will be removed when next tool call or agent response arrives
      // Do NOT send result back to server - server executes these tools locally
      return;
    }

    let resultObj = null;
    let ok = true;
    const startedAt = Date.now();

    try {
      // ID Translation: Convert numeric IDs to real IDs before tool execution
      let processedArgs = args;
      try {
        const { processToolCallLLMtoTB } = await import("./idTranslator.js");
        processedArgs = processToolCallLLMtoTB(name, args);
        log(`[Translate] Tool call: ${name} - converted numeric IDs to real IDs`);
      } catch (e) {
        log(
          `[SSETools] ID translation for tool call failed, using original args: ${e}`,
          "warn"
        );
      }

      // activeToolCallId already set above before bubble creation

      resultObj = await executeToolByName(name, processedArgs, {
        agentBubble,
        callId: call_id,
      });

      // FSM tools: wait for exec_success/exec_fail or timeout, then respond
      console.log(`[SSETools_FSM_DEBUG] resultObj type=${typeof resultObj}, has fsm=${!!(resultObj && typeof resultObj === "object" && resultObj.fsm)}`);
      if (resultObj && typeof resultObj === "object") {
        console.log(`[SSETools_FSM_DEBUG] resultObj keys: ${Object.keys(resultObj).join(', ')}`);
        console.log(`[SSETools_FSM_DEBUG] resultObj.fsm=${resultObj.fsm}, resultObj.pid=${resultObj.pid}`);
      }
      
      console.log(`[SSETools_FSM_DEBUG] Checking FSM condition: resultObj=${!!resultObj}, isObject=${typeof resultObj === "object"}, hasFsm=${resultObj && resultObj.fsm}`);
      if (resultObj && typeof resultObj === "object" && resultObj.fsm) {
        console.log(`[SSETools_FSM_DEBUG] *** ENTERING FSM BLOCK ***`);
        const pid = resultObj.pid || call_id;
        const configuredTimeout =
          SETTINGS && typeof SETTINGS.fsmToolTimeoutMs !== "undefined"
            ? SETTINGS.fsmToolTimeoutMs
            : -1;
        const timeoutMs = configuredTimeout;
        console.log(`[SSETools_FSM_DEBUG] FSM tool detected! pid=${pid}, timeout=${timeoutMs}`);
        if (configuredTimeout === -1) {
          log(
            `[SSETools] FSM tool '${name}' started pid=${pid}; waiting indefinitely for completion (no timeout)`
          );
        } else {
          log(
            `[SSETools] FSM tool '${name}' started pid=${pid}; waiting up to ${timeoutMs}ms for completion`
          );
        }

        // Set up waiter in shared context
        let fsmResult = null;
        try {
          const { ctx } = await import("../modules/context.js");
          console.log(`[SSETools_FSM_DEBUG] Setting up waiter for pid=${pid} in ctx.fsmWaiters`);
          const waiterPromise = new Promise((resolve) => {
            try {
              ctx.fsmWaiters[pid] = { resolve };
              console.log(`[SSETools_FSM_DEBUG] Waiter registered for pid=${pid}, total waiters=${Object.keys(ctx.fsmWaiters).length}`);
            } catch (_) {
              console.log(`[SSETools_FSM_DEBUG] Failed to register waiter for pid=${pid}`);
              resolve({
                ok: false,
                output: "Internal waiter setup failed",
              });
            }
          });
          
          // Create abort waiter that resolves when abort is triggered
          const abortWaiter = new Promise((resolve) => {
            try {
              if (window.currentChatAbortController && window.currentChatAbortController.signal) {
                if (window.currentChatAbortController.signal.aborted) {
                  // Already aborted
                  resolve({ ok: false, output: "User stopped execution", aborted: true });
                  return;
                }
                window.currentChatAbortController.signal.addEventListener('abort', () => {
                  log(`[SSETools] FSM wait aborted for pid=${pid}`, "info");
                  resolve({ ok: false, output: "User stopped execution", aborted: true });
                }, { once: true });
              }
            } catch (e) {
              log(`[SSETools] Failed to set up abort waiter: ${e}`, "warn");
            }
          });
          
          console.log(`[SSETools_FSM_DEBUG] About to await waiterPromise for pid=${pid}`);
          if (configuredTimeout === -1) {
            // Wait indefinitely until FSM resolves or abort signal
            console.log(`[SSETools_FSM_DEBUG] Waiting for pid=${pid} or abort`);
            fsmResult = await Promise.race([waiterPromise, abortWaiter]);
            console.log(`[SSETools_FSM_DEBUG] WaiterPromise resolved for pid=${pid}, result=${JSON.stringify(fsmResult)}`);
          } else {
            const timeoutPromise = new Promise((resolve) => {
              try {
                setTimeout(() => {
                  console.log(`[SSETools_FSM_DEBUG] Timeout fired for pid=${pid} after ${timeoutMs}ms`);
                  resolve({ timeout: true });
                }, timeoutMs);
              } catch (_) {
                resolve({ timeout: true });
              }
            });
            // wait for either the waiter, timeout, or abort
            console.log(`[SSETools_FSM_DEBUG] Racing waiter vs timeout vs abort for pid=${pid}`);
            fsmResult = await Promise.race([waiterPromise, timeoutPromise, abortWaiter]);
            console.log(`[SSETools_FSM_DEBUG] Race resolved for pid=${pid}, result=${JSON.stringify(fsmResult)}`);
          }
          
          // If aborted, throw abort error to stop execution
          if (fsmResult && fsmResult.aborted) {
            console.log(`[SSETools_FSM_DEBUG] FSM wait was aborted for pid=${pid}, throwing abort error`);
            throw new DOMException("User stopped execution", "AbortError");
          }
          
          if (fsmResult && fsmResult.timeout) {
            ok = false;
            const reason = `Timed out after ${timeoutMs}ms waiting for user input.`;
            console.log(`[SSETools_FSM_DEBUG] FSM timeout for pid=${pid}`);
            log(
              `[SSETools] FSM tool '${name}' pid=${pid} timeout: ${reason}`,
              "warn"
            );
            // Best-effort cancel the FSM session
            try {
              const m = await import("../fsm/fsmExec.js");
              await m.cancelFsmSession(pid, reason);
            } catch (e) {
              log(`[SSETools] cancelFsmSession failed: ${e}`, "warn");
            }
            resultObj = { error: `ERROR: FSM tool timed out. ${reason}` };
          } else {
            ok = !!(fsmResult && fsmResult.ok);
            console.log(`[SSETools_FSM_DEBUG] FSM completed for pid=${pid}, ok=${ok}, fsmResult=${JSON.stringify(fsmResult)}`);
            log(
              `[SSETools] FSM tool '${name}' pid=${pid} completed: ${
                ok ? "success" : "failure"
              }`
            );
            const output =
              fsmResult && typeof fsmResult.output !== "undefined"
                ? fsmResult.output
                : ok
                ? "FSM tool completed"
                : "FSM tool failed";
            resultObj = output;
            console.log(`[SSETools_FSM_DEBUG] Setting resultObj to: ${JSON.stringify(resultObj)}`);
          }
          // Cleanup waiter entry if still present
          try {
            const { ctx } = await import("../modules/context.js");
            if (pid && ctx.fsmWaiters[pid]) {
              delete ctx.fsmWaiters[pid];
              console.log(`[SSETools_FSM_DEBUG] Cleaned up waiter for pid=${pid}`);
            }
          } catch (_) {}
        } catch (e) {
          // If abort error, propagate it up
          if (e.name === "AbortError") {
            console.log(`[SSETools_FSM_DEBUG] Propagating abort error for pid=${pid}`);
            throw e;
          }
          
          ok = false;
          resultObj = { error: `ERROR: FSM wait failed: ${String(e)}` };
          console.log(`[SSETools_FSM_DEBUG] FSM wait exception for pid=${pid}: ${e}`);
        }
      }

      // Check if tool returned an explicit ok field (non-FSM case)
      if (resultObj && typeof resultObj === "object" && !resultObj.fsm) {
        if (typeof resultObj.ok === "boolean") {
          ok = resultObj.ok;
          if (!ok && resultObj.error) {
            log(
              `[SSETools] Tool ${name} returned error: ${resultObj.error}`,
              "error"
            );
          }
        } else if (resultObj.error) {
          // Fallback: treat error objects as failures
          ok = false;
          log(
            `[SSETools] Tool ${name} returned error (legacy format): ${resultObj.error}`,
            "error"
          );
        }
        // If neither ok field nor error field, leave ok as-is (success by default)
      }

      log(`[SSETools] Tool ${name} completed ${ok ? "successfully" : "with errors"}`);
    } catch (error) {
      // If this is an abort error, don't process it as a normal error
      if (error.name === "AbortError") {
        console.log(`[SSETools_FSM_DEBUG] Tool execution aborted for call_id=${call_id}`);
        log(`[SSETools] Tool ${name} execution aborted by user`, "info");
        // Remove the tool bubble
        try {
          agentBubble.remove();
        } catch (_) {}
        // Don't send result back - execution was stopped by user
        return;
      }
      
      ok = false;
      console.log(`[SSETools_FSM_DEBUG] *** CAUGHT EXCEPTION ***: ${error}`);
      console.log(`[SSETools_FSM_DEBUG] Exception stack: ${error.stack || 'no stack'}`);
      resultObj = { error: String(error || "tool execution error") };
      log(`[SSETools] Tool ${name} failed: ${error}`, "error");
    }

    // Remove loading class to show tool icon
    try {
      agentBubble.classList.remove("loading");
    } catch (_) {}

    // Mark failed tool bubbles with error state
    if (!ok) {
      try {
        agentBubble.classList.add("error");
        log(
          `[SSETools] Marked tool bubble with error state for call_id=${call_id}`
        );
      } catch (_) {}
    }

    const elapsedMs = Date.now() - startedAt;

    // Save tool call log (matches wsTools format)
    try {
      await saveToolCallLog(
        "tabmail_agent_toolcall_result_sse",
        `${startedAt}_${name}`,
        { name, arguments: args, result: resultObj, success: ok }
      );
    } catch (logErr) {
      log(`[SSETools] Failed to save tool call log: ${logErr}`, "warn");
    }

    // Send result back to backend via POST
    console.log(`[SSETools_FSM_DEBUG] About to send tool result: call_id=${call_id}, ok=${ok}, resultObj type=${typeof resultObj}`);
    if (typeof resultObj === 'object' && resultObj !== null) {
      console.log(`[SSETools_FSM_DEBUG] resultObj keys: ${Object.keys(resultObj).join(', ')}`);
    }
    await _sendToolResult(requestId, call_id, resultObj, ok);
    console.log(`[SSETools_FSM_DEBUG] Tool result sent successfully for call_id=${call_id}`);

    // Clear active tool call id
    try {
      const { ctx } = await import("../modules/context.js");
      ctx.activeToolCallId = null;
    } catch (_) {}
  } catch (e) {
    // If outer handler catches abort error, just return (don't send error result)
    if (e.name === "AbortError") {
      log(`[SSETools] Tool request handling aborted by user`, "info");
      return;
    }
    
    log(`[SSETools] Failed to handle tool_request: ${e}`, "error");

    // Send error result back
    try {
      await _sendToolResult(
        requestId,
        toolReq.call_id,
        `Tool handler error: ${e.message || String(e)}`,
        false // ok = false
      );
    } catch (_) {}
  }
}

/**
 * Send tool execution result back to backend via POST /agent/sse/tool_result.
 * 
 * @param {string} requestId - Request ID
 * @param {string} callId - Tool call ID
 * @param {*} result - Tool result (can be string, object, or any type)
 * @param {boolean} ok - Whether tool execution succeeded
 * @returns {Promise<void>}
 */
async function _sendToolResult(requestId, callId, result, ok) {
  try {
    // Tool results are always sent to the agent endpoint
    const backendUrl = await getBackendUrl("agent");
    const url = `${backendUrl}/agent/sse/tool_result`;

    log(`[SSETools] Sending tool_result for call_id=${callId} ok=${ok}`);

    // ID Translation: Convert real IDs to numeric IDs before sending to server/LLM
    let processedResult = result;
    try {
      const { processToolResultTBtoLLM } = await import("./idTranslator.js");
      processedResult = processToolResultTBtoLLM(result);
      log(
        `[SSETools] ID translation: converted real IDs to numeric IDs for server`
      );
    } catch (e) {
      log(
        `[SSETools] ID translation for tool result failed, using original result: ${e}`,
        "warn"
      );
    }

    // Normalize result to string format for LLM (matches wsTools format)
    let cleanOutput;
    if (typeof processedResult === "string") {
      cleanOutput = processedResult;
    } else if (processedResult && typeof processedResult === "object") {
      // Strip redundant 'ok' field from output since we send it separately
      const { ok: _, ...cleanResult } = processedResult;
      cleanOutput = JSON.stringify(cleanResult);
    } else {
      cleanOutput = JSON.stringify(processedResult);
    }

    const payload = {
      request_id: requestId,
      call_id: callId,
      ok: ok,
      output: cleanOutput,
    };

    // Get Supabase access token
    const { getAccessToken } = await import("../../agent/modules/supabaseAuth.js");
    const accessToken = await getAccessToken();
    if (!accessToken) {
      throw new Error("Not authenticated. Please sign in.");
    }

    let response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Check if this is an auth error and handle re-authentication
      const { isAuthError, handleAuthError } = await import("../../agent/modules/supabaseAuth.js");
      if (isAuthError(response)) {
        log(`[SSETools] Auth error detected sending tool_result (${response.status}), checking auth state`);
        const authResult = await handleAuthError(response);
        if (authResult === "consent_required") {
          log(`[SSETools] Consent required; skipping tool_result send`);
          try {
            await browser.storage.local.set({ tabmailConsentRequired: true });
          } catch (_) {}
          return; // Silently return without sending
        } else if (authResult === null) {
          // Feature is disabled (logged in but endpoint requires different tier)
          // Silently ignore - do not retry, do not throw error
          log(`[SSETools] Feature disabled (logged in but endpoint requires different tier), silently ignoring tool_result`);
          return; // Silently return without sending
        } else if (authResult === true) {
          // Retry the request after successful re-auth
          log(`[SSETools] Re-authentication successful, retrying tool_result`);
          // Get new token after re-auth
          const newAccessToken = await getAccessToken();
          if (!newAccessToken) {
            throw new Error("Failed to get access token after re-auth");
          }
          // Note: No abort signal for tool_result POST (it's fire-and-forget)
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${newAccessToken}`
            },
            body: JSON.stringify(payload),
          });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText} (after re-auth)`);
          }
        } else {
          throw new Error(`Authentication required for tool_result`);
        }
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    }

    const responseData = await response.json();
    log(`[SSETools] tool_result sent successfully: ${JSON.stringify(responseData)}`);
  } catch (e) {
    log(`[SSETools] Failed to send tool_result: ${e}`, "error");
    throw e;
  }
}

/**
 * Stop the tool listener for the current request.
 */
export function stopToolListener() {
  try {
    if (_activeToolListener) {
      log(`[SSETools] Stopping tool listener for request_id=${_currentRequestId}`);
      _activeToolListener.abort();
      _activeToolListener = null;
    }
    _currentRequestId = null;
    _toolListenRetries = 0;
  } catch (e) {
    log(`[SSETools] Error stopping tool listener: ${e}`, "error");
  }
}

/**
 * Check if a tool listener is currently active.
 * 
 * @returns {boolean}
 */
export function isToolListenerActive() {
  return _activeToolListener !== null && _currentRequestId !== null;
}

/**
 * Get the current request ID.
 * 
 * @returns {string|null}
 */
export function getCurrentRequestId() {
  return _currentRequestId;
}

