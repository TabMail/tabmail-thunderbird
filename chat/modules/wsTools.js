// wsTools.js – MCP tool websocket client for chat window (TB 141+, MV3)

import { SETTINGS, getBackendUrl } from "../../agent/modules/config.js";
import { log, saveToolCallLog } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { executeToolByName, getToolActivityLabel, resetFsmChainTracking } from "../tools/core.js";
import { assertAiBackendAllowed } from "./privacySettings.js";

let _ws = null;
let _sessionId = null;
let _connected = false;
let _lastPingTs = 0;
let _isRegistered = false;
let _registeredResolve = null;
let _connectStartTs = 0;
let _lastMessageTs = 0;

function _resetRegistrationPromise() {
  _isRegistered = false;
  _registeredResolve = null;
}

async function buildWsUrl() {
  try {
    // WebSocket tools are always on the agent endpoint
    const backendUrl = await getBackendUrl("agent");
    console.log(`[WSTools] Building WebSocket URL from backend: ${backendUrl}`);
    const base = new URL(backendUrl);
    // Always prefer secure WS behind Cloudflare
    return `wss://${base.host}/ws/tools`;
  } catch (e) {
    // Fallback: naive replace http(s) with ws(s)
    console.error(`[WSTools] Failed to build WS URL: ${e}`);
    const raw = String(await getBackendUrl("agent"));
    return raw.replace(/^http/, "ws") + "/ws/tools";
  }
}

export async function initToolWebSocket(sessionId) {
  try {
    await assertAiBackendAllowed("WSTools.initToolWebSocket");

    if (!sessionId || typeof sessionId !== "string") {
      log(`[WSTools] initToolWebSocket requires a string sessionId`, "error");
      return;
    }
    if (_ws) {
      try {
        _ws.close();
      } catch (_) {}
      _ws = null;
      _connected = false;
    }
    _sessionId = sessionId;
    _resetRegistrationPromise();
    
    // Reset FSM chain tracking when starting a new session (new user turn)
    try {
      resetFsmChainTracking();
      log(`[WSTools] Reset FSM chain tracking for new session_id=${sessionId}`);
    } catch (e) {
      log(`[WSTools] Failed to reset FSM chain tracking: ${e}`, "warn");
    }
    const wsUrl = await buildWsUrl();
    log(`[WSTools] Connecting to ${wsUrl} with session_id=${sessionId}`);
    _connectStartTs = Date.now();
    const ws = new WebSocket(wsUrl);
    _ws = ws;
    try {
      log(`[WSTools] WS readyState after ctor=${ws.readyState}`);
    } catch (_) {}

    ws.onopen = () => {
      _connected = true;
      const openMs = Date.now() - _connectStartTs;
      log(`[WSTools] WebSocket open – registering session (openMs=${openMs})`);
      try {
        ws.send(JSON.stringify({ type: "register", session_id: _sessionId }));
      } catch (e) {
        log(`[WSTools] Failed to send register: ${e}`, "error");
      }
    };

    ws.onmessage = async (ev) => {
      _lastMessageTs = Date.now();
      const size = typeof ev.data === "string" ? ev.data.length : 0;
      try {
        log(`[WSTools] onmessage size=${size}`);
      } catch (_) {}
      let msg = null;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        log(`[WSTools] Invalid JSON from server: ${e}`, "error");
        return;
      }

      const type = msg?.type || "";
      if (type === "ping") {
        _lastPingTs = Date.now();
        try {
          ws.send(JSON.stringify({ type: "pong", ts: _lastPingTs }));
          log(`[WSTools] pong sent ts=${_lastPingTs}`);
        } catch (_) {}
        return;
      }

      if (type === "registered") {
        _isRegistered = true;
        if (typeof _registeredResolve === "function") {
          try {
            _registeredResolve(true);
          } catch (_) {}
          _registeredResolve = null;
        }
        log(`[WSTools] Registered with session_id=${_sessionId}`);
        return;
      }

      if (type === "usage_update") {
        const stage = msg.stage || "";
        const roundIdx = typeof msg.round === "number" ? msg.round : -1;
        const usage = msg.token_usage || null;
        try {
          if (usage) {
            const used = usage.total_tokens;
            const limit = usage.context_limit;
            const pct = usage.usage_percentage;
            log(
              `[WSTools] usage_update stage=${stage} round=${roundIdx} usage=${used}/${limit} (${pct}%)`
            );
          } else {
            log(
              `[WSTools] usage_update stage=${stage} round=${roundIdx} (no payload)`,
              "warn"
            );
          }
        } catch (_) {}
        try {
          if (usage) {
            const ev = new CustomEvent("tokenUsageUpdated", { detail: usage });
            window.dispatchEvent(ev);
          }
        } catch (e) {
          log(`[WSTools] Failed to dispatch tokenUsageUpdated: ${e}`, "warn");
        }
        return;
      }

      if (type === "retry_notification") {
        const roundIdx = typeof msg.round === "number" ? msg.round : -1;
        const reason = msg.reason || "unknown";
        const thinking = msg.thinking || "";
        const malformedData = msg.malformed_data || null;
        
        log(
          `[WSTools] retry_notification round=${roundIdx} reason=${reason} thinking_len=${thinking.length} has_malformed_data=${!!malformedData}`
        );
        
        // Save malformed data if debug flag is on
        if (malformedData) {
          try {
            const { saveToolCallLog } = await import("../../agent/modules/utils.js");
            const timestamp = malformedData.timestamp || Date.now();
            await saveToolCallLog(
              "tabmail_malformed_response",
              `${timestamp}_round_${roundIdx}`,
              malformedData
            );
            log(`[WSTools] Saved malformed response data for round ${roundIdx}`);
          } catch (e) {
            log(`[WSTools] Failed to save malformed response data: ${e}`, "warn");
          }
        }
        
        // Display retry as a temporary error-styled bubble
        try {
          const { createNewAgentBubble } = await import("../chat.js");
          const retryBubble = await createNewAgentBubble(`Retry attempt (${reason})`);
          
          // Style as a tool error bubble
          retryBubble.classList.add("tool");
          retryBubble.classList.add("retry");
          retryBubble.classList.add("error");
          retryBubble.setAttribute("data-retry-round", String(roundIdx));
          
          log(`[WSTools] Created retry bubble for round ${roundIdx}`);
        } catch (e) {
          log(`[WSTools] Failed to create retry bubble: ${e}`, "warn");
        }
        return;
      }

      if (type === "tool_request") {
        const callId = msg.call_id;
        const name = msg.name;
        let args = {};
        try {
          args =
            typeof msg.arguments === "string"
              ? JSON.parse(msg.arguments)
              : msg.arguments || {};
        } catch (_) {
          args = msg.arguments || {};
        }

        log(`[WSTools] Tool requested: ${name} call_id=${callId}`);

        // Record active tool call id BEFORE creating the activity bubble so the
        // bubble can be auto-grouped/indented as a tool bubble with pid.
        try {
          const { ctx } = await import("../modules/context.js");
          ctx.activeToolCallId = callId || null;
          log(
            `[WSTools] Set activeToolCallId=${ctx.activeToolCallId} prior to bubble creation`
          );
        } catch (_) {}

        // Show activity bubble for this tool (auto-tagged by createNewAgentBubble)
        const activity = await getToolActivityLabel(name, args);
        const agentBubble = await createNewAgentBubble(activity);

        let resultObj = null;
        let ok = true;
        const startedAt = Date.now();
        try {
          // ID Translation: Convert numeric IDs to real IDs before tool execution
          let processedArgs = args;
          try {
            const { processToolCallLLMtoTB } = await import(
              "./idTranslator.js"
            );
            processedArgs = processToolCallLLMtoTB(name, args);
            log(
              `[Translate] Tool call: ${name} - converted numeric IDs to real IDs`
            );
          } catch (e) {
            log(
              `[WSTools] ID translation for tool call failed, using original args: ${e}`,
              "warn"
            );
          }

          // activeToolCallId already set above before bubble creation

          resultObj = await executeToolByName(name, processedArgs, {
            agentBubble,
            callId,
          });

          // FSM tools: wait for exec_success/exec_fail or timeout, then respond
          if (resultObj && typeof resultObj === "object" && resultObj.fsm) {
            const pid = resultObj.pid || callId;
            const configuredTimeout =
              SETTINGS && typeof SETTINGS.fsmToolTimeoutMs !== "undefined"
                ? SETTINGS.fsmToolTimeoutMs
                : -1;
            const timeoutMs = configuredTimeout;
            if (configuredTimeout === -1) {
              log(
                `[WSTools] FSM tool '${name}' started pid=${pid}; waiting indefinitely for completion (no timeout)`
              );
            } else {
              log(
                `[WSTools] FSM tool '${name}' started pid=${pid}; waiting up to ${timeoutMs}ms for completion`
              );
            }

            // Set up waiter in shared context
            let fsmResult = null;
            try {
              const { ctx } = await import("../modules/context.js");
              const waiterPromise = new Promise((resolve) => {
                try {
                  ctx.fsmWaiters[pid] = { resolve };
                } catch (_) {
                  resolve({
                    ok: false,
                    output: "Internal waiter setup failed",
                  });
                }
              });
              if (configuredTimeout === -1) {
                // Wait indefinitely until FSM resolves
                fsmResult = await waiterPromise;
              } else {
                const timeoutPromise = new Promise((resolve) => {
                  try {
                    setTimeout(() => resolve({ timeout: true }), timeoutMs);
                  } catch (_) {
                    resolve({ timeout: true });
                  }
                });
                // wait for either the waiter or the timeout
                fsmResult = await Promise.race([waiterPromise, timeoutPromise]);
              }
              if (fsmResult && fsmResult.timeout) {
                ok = false;
                const reason = `Timed out after ${timeoutMs}ms waiting for user input.`;
                log(
                  `[WSTools] FSM tool '${name}' pid=${pid} timeout: ${reason}`,
                  "warn"
                );
                // Best-effort cancel the FSM session
                try {
                  const m = await import("../fsm/fsmExec.js");
                  await m.cancelFsmSession(pid, reason);
                } catch (e) {
                  log(`[WSTools] cancelFsmSession failed: ${e}`, "warn");
                }
                resultObj = { error: `ERROR: FSM tool timed out. ${reason}` };
              } else {
                ok = !!(fsmResult && fsmResult.ok);
                log(
                  `[WSTools] FSM tool '${name}' pid=${pid} completed: ${
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
              }
              // Cleanup waiter entry if still present
              try {
                const { ctx } = await import("../modules/context.js");
                if (pid && ctx.fsmWaiters[pid]) delete ctx.fsmWaiters[pid];
              } catch (_) {}
            } catch (e) {
              ok = false;
              resultObj = { error: `ERROR: FSM wait failed: ${String(e)}` };
            }
          }

          // Check if the tool returned an explicit ok field (non-FSM case)
          if (resultObj && typeof resultObj === "object" && !resultObj.fsm) {
            if (typeof resultObj.ok === "boolean") {
              // Use explicit ok field (preferred format)
              ok = resultObj.ok;
              if (!ok && resultObj.error) {
                log(
                  `[WSTools] Tool ${name} returned error: ${resultObj.error}`,
                  "error"
                );
              }
            } else if (resultObj.error) {
              // Fallback: treat error objects as failures for backwards compatibility
              ok = false;
              log(
                `[WSTools] Tool ${name} returned error (legacy format): ${resultObj.error}`,
                "error"
              );
            }
            // If neither ok field nor error field, leave ok as-is (success by default)
          }
        } catch (e) {
          ok = false;
          resultObj = { error: String(e || "tool execution error") };
          log(`[WSTools] Tool ${name} failed: ${e}`, "error");
        }

        try {
          agentBubble.classList.remove("loading");
        } catch (_) {}

        // Mark failed tool bubbles with error state instead of just removing loading
        if (!ok) {
          try {
            agentBubble.classList.add("error");
            log(
              `[WSTools] Marked tool bubble with error state for call_id=${callId}`
            );
          } catch (_) {}
        }

        // Persist logs similar to converse flow
        try {
          saveToolCallLog(
            "tabmail_agent_toolcall_result_ws",
            `${startedAt}_${name}`,
            { name, arguments: args, result: resultObj, success: ok }
          );
        } catch (_) {}

        // Send result back to server (handles both FSM and non-FSM cases)
        try {
          // ID Translation: Convert real IDs to numeric IDs before sending to server/LLM
          let processedResult = resultObj;
          try {
            const { processToolResultTBtoLLM } = await import(
              "./idTranslator.js"
            );
            processedResult = processToolResultTBtoLLM(resultObj);
            log(
              `[Translate] Tool result: ${name} - converted real IDs to numeric IDs for server`
            );
          } catch (e) {
            log(
              `[WSTools] ID translation for tool result failed, using original result: ${e}`,
              "warn"
            );
          }

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

          ws.send(
            JSON.stringify({
              type: "tool_result",
              session_id: _sessionId,
              call_id: callId,
              ok,
              output: cleanOutput,
            })
          );
          const roundMs = Date.now() - startedAt;
          log(
            `[WSTools] Sent tool_result for call_id=${callId} (roundMs=${roundMs}, ok=${ok})`
          );
        } catch (e) {
          log(`[WSTools] Failed to send tool_result: ${e}`, "error");
        }
        // Clear active tool call id after sending result
        try {
          const { ctx } = await import("../modules/context.js");
          ctx.activeToolCallId = null;
        } catch (_) {}
        return;
      }

      log(`[WSTools] Unknown frame type: ${type}`, "warn");
    };

    ws.onclose = async (ev) => {
      _connected = false;
      _isRegistered = false;
      const sinceLastMsg = _lastMessageTs ? Date.now() - _lastMessageTs : -1;
      try {
        log(
          `[WSTools] WebSocket closed code=${ev?.code} reason='${
            ev?.reason || ""
          }' wasClean=${ev?.wasClean} sinceLastMsgMs=${sinceLastMsg}`
        );
      } catch (_) {
        log(`[WSTools] WebSocket closed`);
      }

      // If handshake likely blocked by Access (no cookie / expired), user needs to sign in via popup
      const authLikely =
        !_isRegistered || ev?.code === 1008 /* policy violation */ || ev?.code === 1011;
      if (authLikely) {
        log("[WSTools] WebSocket connection failed - likely authentication issue. Please sign in via TabMail popup.", "warn");
      }

      // If someone is waiting for registration, fail it now
      if (typeof _registeredResolve === "function") {
        try {
          _registeredResolve(false);
        } catch (_) {}
        _registeredResolve = null;
      }
    };

    ws.onerror = (e) => {
      const msg = e && e.message ? e.message : String(e);
      log(
        `[WSTools] WebSocket error: ${msg} readyState=${ws.readyState}`,
        "error"
      );
      // If someone is waiting for registration, fail it now
      if (typeof _registeredResolve === "function") {
        try {
          _registeredResolve(false);
        } catch (_) {}
        _registeredResolve = null;
      }
    };
  } catch (e) {
    log(`[WSTools] initToolWebSocket failed: ${e}`, "error");
  }
}

export function shutdownToolWebSocket() {
  try {
    if (_ws) {
      log(`[WSTools] Closing WebSocket (readyState=${_ws.readyState})`);
      try {
        _ws.close();
      } catch (_) {}
    }
  } catch (e) {
    log(`[WSTools] shutdownToolWebSocket failed: ${e}`, "error");
  } finally {
    _ws = null;
    _connected = false;
    _sessionId = null;
    _isRegistered = false;
    _registeredResolve = null;
  }
}

export function waitForWsRegistered(timeoutMs = 4000) {
  if (_isRegistered) return Promise.resolve(true);
  return new Promise((resolve) => {
    _registeredResolve = resolve;
    try {
      setTimeout(() => {
        if (!_isRegistered) {
          log(
            `[WSTools] waitForWsRegistered timeout after ${timeoutMs}ms`,
            "warn"
          );
          resolve(false);
          _registeredResolve = null;
        }
      }, timeoutMs);
    } catch (_) {}
  });
}

// No-timeout variant: resolves true on registration, false on error/close before registered
export function waitForWsReady() {
  if (_isRegistered) return Promise.resolve(true);
  return new Promise((resolve) => {
    _registeredResolve = (ok) => {
      try {
        resolve(!!ok);
      } catch (_) {
        resolve(false);
      }
      _registeredResolve = null;
    };
  });
}

// Expose lightweight status checkers for callers that need to gate requests
export function isWsConnected() {
  return !!_connected;
}

export function isWsRegistered() {
  return !!_isRegistered;
}
