// converse.js – handle user interaction that are related to user input
// Thunderbird 142 MV3

import { sendChatWithTools } from "../../agent/modules/llm.js";
import { log, saveChatLog, saveToolCallLog } from "../../agent/modules/utils.js";
import { appendSystemBubble, createNewAgentBubble } from "../chat.js";
import { executeToolByName, getToolActivityLabel, isServerSideTool, resetFsmChainTracking, resetToolPaginationSessions } from "../tools/core.js";
import { CHAT_SETTINGS } from "./chatConfig.js";
import { ctx } from "./context.js";
import {
    formatTimestampForAgent,
    streamText
} from "./helpers.js";
import {
  appendTurn,
  generateTurnId,
  indexTurnToFTS,
  saveTurns,
  saveMeta,
} from "./persistentChatStore.js";
import { cleanupEvictedIds, collectTurnRefs, registerTurnRefs, unregisterTurnRefs } from "./idTranslator.js";
import { consumePendingNudge } from "./init.js";
import { getPrivacyOptOutAllAiEnabled, PRIVACY_OPT_OUT_ERROR_MESSAGE } from "./privacySettings.js";
import { finalizeToolGroup, isToolCollapseEnabled } from "./toolCollapse.js";

/**
 * Update context usage display for conversation-specific token tracking
 * @param {object} tokenUsage - Token usage information from LLM response
 */
function updateConversationTokenUsage(tokenUsage) {
  try {
    // Dispatch custom event for UI components to listen to
    const event = new CustomEvent("tokenUsageUpdated", {
      detail: tokenUsage,
    });
    window.dispatchEvent(event);

    log(
      `[Converse Token Usage] Updated: ${tokenUsage.total_tokens}/${tokenUsage.context_limit} tokens (${tokenUsage.usage_percentage}%)`
    );
  } catch (e) {
    log(
      `[Converse Token Usage] Failed to dispatch tokenUsageUpdated event: ${e}`,
      "warn"
    );
  }
}

export async function awaitUserInput() {
  // Enable the send button so that the user can send a message

  if (window.setChatMode) {
    window.setChatMode("send");
  }
  try {
    if (window.tmFocusInput) window.tmFocusInput();
    if (window.tmShowSuggestion) window.tmShowSuggestion();
    // Update retry button visibility based on canRetry state
    if (window.tmUpdateRetryVisibility) window.tmUpdateRetryVisibility();
  } catch (_) {}
}

/**
 * Retry the last user message after an error.
 * Removes the error bubble and resends the last message.
 */
export async function retryLastMessage() {
  try {
    const lastMessage = ctx.lastUserMessage;
    if (!lastMessage) {
      log(`[TMDBG Converse] No last message to retry`, "warn");
      return;
    }

    log(`[TMDBG Converse] Retrying last message: "${lastMessage}"`);

    // Remove the last system error bubble (the one with retry link)
    const container = document.getElementById("chat-container");
    if (container) {
      const systemBubbles = container.querySelectorAll(".system-message");
      if (systemBubbles.length > 0) {
        // Remove the last system bubble - when canRetry is true, this is always the error bubble
        const lastSystemBubble = systemBubbles[systemBubbles.length - 1];
        lastSystemBubble.remove();
        log(`[TMDBG Converse] Removed last system error bubble for retry`);
      }
    }

    // Remove the last user and system messages from agentConverseMessages
    const messages = ctx.agentConverseMessages;
    if (Array.isArray(messages) && messages.length > 0) {
      // Pop from the end: first any system message, then the user message
      while (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last.role === "system" || last.role === "user") {
          messages.pop();
          log(`[TMDBG Converse] Removed ${last.role} message from history for retry`);
          if (last.role === "user") break; // Stop after removing user message
        } else {
          break; // Don't remove assistant messages
        }
      }
    }

    // Remove last persisted user turn (system error turns are not persisted)
    try {
      if (ctx.persistedTurns?.length > 0) {
        const lastTurn = ctx.persistedTurns[ctx.persistedTurns.length - 1];
        if (lastTurn.role === "user") {
          unregisterTurnRefs(lastTurn);
          ctx.persistedTurns.pop();
          if (ctx.chatMeta) {
            ctx.chatMeta.totalChars -= lastTurn._chars || 0;
          }
          saveTurns(ctx.persistedTurns);
          saveMeta(ctx.chatMeta);
          log(`[TMDBG Converse] Removed last persisted user turn for retry`);
        }
      }
    } catch (e) {
      log(`[TMDBG Converse] Failed to cleanup persisted turns for retry: ${e}`, "warn");
    }

    // Clear retry state before re-sending
    ctx.canRetry = false;
    if (window.tmUpdateRetryVisibility) window.tmUpdateRetryVisibility();

    // Re-send the message
    await agentConverse(lastMessage);
  } catch (e) {
    log(`[TMDBG Converse] retryLastMessage failed: ${e}`, "error");
  }
}

// Expose retry function globally for UI access
window.tmRetryLastMessage = retryLastMessage;

export async function processUserInput(userText) {
  // Determine pid early; pid>0 means this belongs to an FSM session
  const pid = ctx.awaitingPid || 0;

  // If pid is 0, this is a top-level conversation, simply head to
  // agentConverse with the txt message
  if (pid === 0) {
    await agentConverse(userText);
    return;
  }

  if (pid && ctx.fsmSessions && ctx.fsmSessions[pid]) {
    // Route exclusively to the pid-specific FSM session
    try {
      const sess = ctx.fsmSessions[pid];
      try {
        sess.fsmUserInput = userText;
      } catch (_) {}
      try {
        log(
          `[TMDBG Converse] Routed user input to FSM session pid=${pid} tool=${
            sess?.toolName || "tool"
          }`
        );
      } catch (_) {}
    } catch (e) {
      try {
        log(
          `[TMDBG Converse] Failed writing to FSM session pid=${pid}: ${e}`,
          "warn"
        );
      } catch (_) {}
    }
  } else {
    // Top-level conversation: keep using global histories
    ctx.rawUserTexts.push(userText);
    try {
      log(`[TMDBG Converse] Routed user input to top-level conversation`);
    } catch (_) {}
  }

  try {
    const listEl = document.querySelector(".email-selection-list");
    if (listEl) {
      listEl.querySelectorAll("input[type=checkbox]").forEach((cb) => {
        cb.disabled = true;
        cb.style.pointerEvents = "none";
      });
    }
  } catch {}

  if (window.setChatMode) window.setChatMode("stop");

  console.log(`[TMDBG Converse] Finished user input waiting (pid=${pid})`);

  if (pid && ctx.fsmSessions[pid]) {
    // Route to FSM planner for this pid if pid is non-zero (ie, not top-level conversation)
    ctx.state = "plan_next_action";
    // Attach pid for planner to use
    try {
      ctx.activePid = pid;
    } catch (_) {}
    try {
      const m = await import("../fsm/core.js");
      await m.executeAgentAction();
      try {
        log(
          `[TMDBG Converse] Awaited initial executeAgentAction for pid=${pid}`
        );
      } catch (_) {}
    } catch (e) {
      try {
        log(
          `[TMDBG Converse] executeAgentAction initial await failed for pid=${pid}: ${e}`,
          "error"
        );
      } catch (_) {}
    }
  }
}

// -------------------------------------------------------------
// agent_converse – free-form conversation loop using tools
// -------------------------------------------------------------
export async function agentConverse(userText) {
  try {
    // No context switching; converse uses persistent history
    const messages = ctx.agentConverseMessages;
    if (!Array.isArray(messages)) {
      log(
        `[TMDBG Converse] Missing agentConverseMessages; init must create it.`,
        "error"
      );
      return;
    }

    // Track last user message for retry functionality
    ctx.lastUserMessage = userText;
    ctx.canRetry = false; // Reset retry state at start of new message
    log(`[TMDBG Converse] Tracked last user message for retry: "${userText.substring(0, 50)}..."`);

    // Reset tool pagination sessions at the start of each converse turn
    try {
      resetToolPaginationSessions();
      log(`[TMDBG Converse] Reset tool pagination sessions for new user turn.`);
    } catch (e) {
      log(`[TMDBG Converse] Failed to reset pagination sessions: ${e}`, "warn");
    }
    
    // Reset FSM chain tracking at the start of each converse turn
    // This allows FSM tools to be called again after user interacts
    try {
      resetFsmChainTracking();
      log(`[TMDBG Converse] Reset FSM chain tracking for new user turn.`);
    } catch (e) {
      log(`[TMDBG Converse] Failed to reset FSM chain tracking: ${e}`, "warn");
    }

    const latestUser = userText;

    // DISABLED: selectedMessageIds prompt injection
    // We now use @ mention UI where user explicitly references emails as [Email](id)
    // The email mentions are part of the user message text itself

    log(
      `[TMDBG MessageSelection] Using @ mention system - no selectedMessageIds sent to backend`
    );

    const timeStamp = formatTimestampForAgent();
    messages.push({
      role: "user",
      content: "chat_converse",
      time_stamp: timeStamp,
      user_message: latestUser,
    });

    log(
      `[TMDBG Converse] Appended latest user message to message list (using @ mention system)`
    );

    // Persist pending nudge first (if any). Nudges are only persisted once the user
    // sends a message after them — at that point they're no longer trailing.
    try {
      const pendingNudge = consumePendingNudge();
      if (pendingNudge && ctx.persistedTurns && ctx.chatMeta) {
        pendingNudge._refs = collectTurnRefs(pendingNudge);
        registerTurnRefs(pendingNudge);
        await appendTurn(pendingNudge, ctx.persistedTurns, ctx.chatMeta);
        log(`[CONVERSE] Persisted pending ${pendingNudge._type} nudge before user message`);
        // Index nudge to FTS so it appears in chat history (fire-and-forget)
        indexTurnToFTS(null, pendingNudge).catch(e =>
          log(`[CONVERSE] FTS indexing of nudge failed (non-fatal): ${e}`, "warn")
        );
      }
    } catch (e) {
      log(`[CONVERSE] Failed to persist pending nudge: ${e}`, "warn");
    }

    // Persist user turn to storage
    // Generate _rendered for user messages that may contain [Email](N) @ mention refs
    let userRenderedHtml = "";
    try {
      const { renderMarkdown } = await import("./markdown.js");
      userRenderedHtml = await renderMarkdown(latestUser);
    } catch (e) {
      log(`[CONVERSE] Failed to generate user rendered snapshot: ${e}`, "warn");
    }
    const userTurn = {
      role: "user",
      content: "chat_converse",
      user_message: latestUser,
      time_stamp: timeStamp,
      _rendered: userRenderedHtml,
      _id: generateTurnId(),
      _ts: Date.now(),
      _type: "normal",
      _chars: latestUser.length,
    };
    userTurn._refs = collectTurnRefs(userTurn);
    registerTurnRefs(userTurn);
    ctx._lastPersistedUserTurn = userTurn;
    try {
      if (ctx.persistedTurns && ctx.chatMeta) {
        const { evictedTurns } = await appendTurn(userTurn, ctx.persistedTurns, ctx.chatMeta);
        if (evictedTurns?.length) {
          cleanupEvictedIds(evictedTurns);
          log(`[CONVERSE] Evicted ${evictedTurns.length} turns after user message`);
        }
        ctx.chatMeta.lastActivityTs = Date.now();
        saveMeta(ctx.chatMeta);
      }
    } catch (e) {
      log(`[CONVERSE] Failed to persist user turn: ${e}`, "warn");
    }

    // Get agent response
    await getAgentResponse(messages);
  } catch (e) {
    log(`[TMDBG Converse] agentConverse failed: ${e}`, "error");
  }

  // After agent turn, wait for user input
  try {
    log(`[TMDBG Converse] Completed agent turn; waiting for user input`);
  } catch (_) {}
  try {
    ctx.awaitingPid = 0;
  } catch (_) {}
  awaitUserInput();
}

// (initializeConversation removed; init.js initialises persistent messages)

// (Removed tool return initializer)

// Main conversation loop - turn-based approach
async function getAgentResponse(messages, retryCount = 0, existingBubble = null) {
  const maxRetries = CHAT_SETTINGS?.llmEmptyResponseMaxRetries ?? 5;
  
  // Reuse existing bubble on retries, create new one only on first attempt
  const agentBubble = existingBubble || await createNewAgentBubble("Thinking...");
  
  if (!existingBubble) {
    try {
      agentBubble.classList.add("loading");
    } catch (_) {}
  }

  log(`[CONVERSE] Starting turn-based conversation${retryCount > 0 ? ` (silent retry ${retryCount}/${maxRetries})` : ""}`);

  // Create AbortController for this chat operation and expose it globally
  const chatAbortController = new AbortController();
  window.currentChatAbortController = chatAbortController;
  
  // Track server-side tool bubbles for status updates
  const serverToolBubbles = new Map();  // execution_id -> bubble element
  
  // Set up handlers for server-side tool execution status
  window.onServerToolExecutionsStarted = async (executions) => {
    log(`[CONVERSE] Server-side tools started: ${executions.length} tool(s)`);
    
    for (const exec of executions) {
      try {
        // Create a bubble for each server-side tool (like normal tools)
        // Set active tool call id for UI grouping before creating bubble
        try {
          ctx.activeToolCallId = exec.call_id;
        } catch (_) {}
        
        const bubble = await createNewAgentBubble(exec.display_label);
        bubble.classList.add("loading");
        bubble.classList.add("tool");  // Mark as tool bubble for styling
        serverToolBubbles.set(exec.execution_id, bubble);
        
        // Clear active tool call id after this bubble
        try {
          ctx.activeToolCallId = null;
        } catch (_) {}
        
        log(`[CONVERSE] Created server-side tool bubble for ${exec.display_label} (execution_id=${exec.execution_id})`);
        
        // Don't log here - comprehensive log saved in SSE stream reader when tool completes
      } catch (err) {
        log(`[CONVERSE] Failed to create server tool bubble: ${err}`, "warn");
      }
    }
  };
  
  window.onServerToolExecutionStatus = (status) => {
    const toolDesc = status.tool_name || status.execution_id;
    log(`[CONVERSE] Server-side tool status update: ${toolDesc} - ${status.state} (${status.elapsed_ms}ms)`);
    
    // Update bubble if we have one
    const bubble = serverToolBubbles.get(status.execution_id);
    if (bubble) {
      // Update based on state
      if (status.state === "running") {
        // Keep loading indicator
      } else if (status.state === "completed") {
        bubble.classList.remove("loading");
        
        // Logging is done in SSE stream reader with full details (arguments + result)
      } else if (status.state === "failed") {
        bubble.classList.remove("loading");
        bubble.classList.add("error");
        
        // Logging is done in SSE stream reader with full details (arguments + error)
      }
    }
  };
  
  window.onServerToolExecutionsCompleted = () => {
    log(`[CONVERSE] All server-side tools completed`);
    
    // Keep server-side tool bubbles visible (just like client-side tools)
    // They will be cleaned up later with other tool bubbles
    log(`[CONVERSE] Keeping ${serverToolBubbles.size} server-side tool bubble(s) visible`);
  };

  // Tool execution callback - called when backend returns tool calls
  // Backend loads tool definitions from /tools/*.json, we just execute them
  const onToolExecution = async (toolCalls, tokenUsage) => {
    log(`[CONVERSE] Executing ${toolCalls.length} tool calls`);
    
    // Check if aborted at the start
    if (chatAbortController.signal.aborted) {
      log(`[CONVERSE] Tool execution aborted before start`, "info");
      throw new DOMException("User stopped execution", "AbortError");
    }
    
    // Update token usage if provided
    if (tokenUsage) {
      try {
        updateConversationTokenUsage(tokenUsage);
      } catch (e) {
        log(`[CONVERSE] Failed to update token usage: ${e}`, "warn");
      }
    }
    
    const results = [];
    
    for (const tc of toolCalls) {
      // Check abort before each tool execution
      if (chatAbortController.signal.aborted) {
        log(`[CONVERSE] Tool execution aborted during loop`, "info");
        throw new DOMException("User stopped execution", "AbortError");
      }
      
      const callId = tc.id;
      const func = tc.function || {};
      const name = func.name;
      const argsJson = func.arguments || "{}";
      
      log(`[CONVERSE] Executing tool: ${name} (call_id=${callId})`);
      
      // Parse arguments
      let args = {};
      try {
        args = JSON.parse(argsJson);
      } catch (e) {
        log(`[CONVERSE] Failed to parse tool arguments: ${e}`, "error");
        args = {};
      }
      
      // Set active tool call id for UI grouping
      try {
        ctx.activeToolCallId = callId;
      } catch (_) {}
      
      // Show activity bubble for this tool
      const activity = await getToolActivityLabel(name, args);
      const toolBubble = await createNewAgentBubble(activity);
      
      // Check if this is a server-side tool (shouldn't happen, but handle it)
      if (isServerSideTool(name)) {
        log(`[CONVERSE] Server-side tool ${name} in client-side execution (should not happen)`, "warn");
        // Server-side tools are handled by backend, skip
        continue;
      }
      
      // ID Translation: Convert numeric IDs to real IDs before tool execution
      let processedArgs = args;
      try {
        const { processToolCallLLMtoTB } = await import("./idTranslator.js");
        processedArgs = processToolCallLLMtoTB(name, args);
        log(`[CONVERSE] Tool call: ${name} - converted numeric IDs to real IDs`);
      } catch (e) {
        log(`[CONVERSE] ID translation for tool call failed, using original args: ${e}`, "warn");
      }
      
      // Execute tool
      let resultObj = null;
      let ok = true;
      const startedAt = Date.now();
      
      try {
        resultObj = await executeToolByName(name, processedArgs, {
          agentBubble: toolBubble,
          callId: callId,
        });
        
        // Check if tool returned FSM marker
        if (resultObj && typeof resultObj === "object" && resultObj.fsm) {
          const pid = resultObj.pid || callId;
          log(`[CONVERSE] FSM tool '${name}' started pid=${pid}; waiting for completion`);
          
          // Set up waiter for FSM completion
          const waiterPromise = new Promise((resolve) => {
            try {
              ctx.fsmWaiters[pid] = { resolve };
              log(`[CONVERSE] Waiter registered for FSM pid=${pid}`);
            } catch (_) {
              resolve({
                ok: false,
                output: "Internal waiter setup failed",
              });
            }
          });
          
          // Also create abort waiter that resolves when abort signal is triggered
          const abortWaiter = new Promise((resolve) => {
            if (chatAbortController.signal.aborted) {
              // Already aborted
              resolve({ ok: false, output: "User stopped execution", aborted: true });
              return;
            }
            chatAbortController.signal.addEventListener('abort', () => {
              log(`[CONVERSE] FSM wait aborted for pid=${pid}`, "info");
              resolve({ ok: false, output: "User stopped execution", aborted: true });
            }, { once: true });
          });
          
          // Wait indefinitely for FSM to complete OR abort signal
          log(`[CONVERSE] Waiting for FSM pid=${pid} or abort signal`);
          const fsmResult = await Promise.race([waiterPromise, abortWaiter]);
          
          // If aborted, throw error to stop tool execution loop
          if (fsmResult && fsmResult.aborted) {
            log(`[CONVERSE] FSM wait aborted for pid=${pid}, stopping tool execution`, "info");
            throw new DOMException("User stopped execution", "AbortError");
          }
          
          ok = !!(fsmResult && fsmResult.ok);
          log(`[CONVERSE] FSM tool '${name}' pid=${pid} completed: ${ok ? "success" : "failure"}`);
          
          const output = fsmResult && typeof fsmResult.output !== "undefined"
            ? fsmResult.output
            : ok
            ? "FSM tool completed"
            : "FSM tool failed";
          resultObj = output;
          
          // Cleanup waiter
          try {
            if (pid && ctx.fsmWaiters[pid]) {
              delete ctx.fsmWaiters[pid];
            }
          } catch (_) {}
        }
        
        // Check if tool returned explicit ok field
        if (resultObj && typeof resultObj === "object" && !resultObj.fsm) {
          if (typeof resultObj.ok === "boolean") {
            ok = resultObj.ok;
            if (!ok && resultObj.error) {
              log(`[CONVERSE] Tool ${name} returned error: ${resultObj.error}`, "error");
            }
          } else if (resultObj.error) {
            ok = false;
            log(`[CONVERSE] Tool ${name} returned error (legacy format): ${resultObj.error}`, "error");
          }
        }
        
        log(`[CONVERSE] Tool ${name} completed ${ok ? "successfully" : "with errors"}`);
      } catch (error) {
        // If this is an abort error, propagate it up
        if (error.name === "AbortError") {
          throw error;
        }
        
        ok = false;
        resultObj = { error: String(error || "tool execution error") };
        log(`[CONVERSE] Tool ${name} failed: ${error}`, "error");
      }
      
      // Remove loading class
      try {
        toolBubble.classList.remove("loading");
      } catch (_) {}
      
      // Mark failed tools with error state
      if (!ok) {
        try {
          toolBubble.classList.add("error");
        } catch (_) {}
      }
      
      const elapsedMs = Date.now() - startedAt;
      
      // Save tool call log
      try {
        await saveToolCallLog(
          "tabmail_agent_toolcall_result",
          `${startedAt}_${name}`,
          { name, arguments: args, result: resultObj, success: ok }
        );
      } catch (logErr) {
        log(`[CONVERSE] Failed to save tool call log: ${logErr}`, "warn");
      }
      
      // ID Translation: Convert real IDs to numeric IDs before sending to server
      let processedResult = resultObj;
      try {
        const { processToolResultTBtoLLM } = await import("./idTranslator.js");
        processedResult = processToolResultTBtoLLM(resultObj);
        log(`[CONVERSE] ID translation: converted real IDs to numeric IDs for server`);
      } catch (e) {
        log(`[CONVERSE] ID translation for tool result failed, using original result: ${e}`, "warn");
      }
      
      // Normalize result to string for LLM
      let cleanOutput;
      if (typeof processedResult === "string") {
        cleanOutput = processedResult;
      } else if (processedResult && typeof processedResult === "object") {
        const { ok: _, ...cleanResult } = processedResult;
        cleanOutput = JSON.stringify(cleanResult);
      } else {
        cleanOutput = JSON.stringify(processedResult);
      }
      
      // Ensure non-empty output
      if (!cleanOutput || cleanOutput.trim() === "") {
        cleanOutput = "{}";
      }
      
      results.push({
        call_id: callId,
        output: cleanOutput,
        ok: ok,
      });
      
      // Clear active tool call id
      try {
        ctx.activeToolCallId = null;
      } catch (_) {}
    }
    
    return results;
  };

  let resp = null;
  const relayStart = Date.now();
  try {
    log(`[CONVERSE] Calling sendChatWithTools with turn-based approach`);

    const privacyOptOutEnabled = await getPrivacyOptOutAllAiEnabled();
    if (privacyOptOutEnabled) {
      log(`[CONVERSE] Privacy opt-out enabled; blocking sendChatWithTools`, "warn");
      resp = { err: PRIVACY_OPT_OUT_ERROR_MESSAGE };
    } else {
      resp = await sendChatWithTools(messages, {
        abortController: chatAbortController,
        onToolExecution: onToolExecution,
      });
    }
    
    log(`[CONVERSE] sendChatWithTools returned`);
  } finally {
    const relayMs = Date.now() - relayStart;
    log(`[CONVERSE] sendChatWithTools completed in ${relayMs}ms`);
    
    // Clear the global references and handlers
    window.currentChatAbortController = null;
    window.onServerToolExecutionsStarted = null;
    window.onServerToolExecutionStatus = null;
    window.onServerToolExecutionsCompleted = null;
    
    // Clean up any remaining server-side tool bubbles
    for (const bubble of serverToolBubbles.values()) {
      try {
        bubble.remove();
      } catch (_) {}
    }
    serverToolBubbles.clear();
  }

  // CRITICAL: Clear activeToolCallId
  try {
    ctx.activeToolCallId = null;
  } catch (e) {
    log(`[CONVERSE] Failed to clear activeToolCallId: ${e}`, "warn");
  }
  
  // Remove "tool" class from the main agent response bubble
  try {
    if (agentBubble && agentBubble.classList && agentBubble.classList.contains("tool")) {
      agentBubble.classList.remove("tool");
    }
  } catch (e) {
    log(`[CONVERSE] Failed to remove tool class from agent bubble: ${e}`, "warn");
  }

  // Before publishing the assistant response, handle tool bubbles
  try {
    const container = document.getElementById("chat-container");
    
    // If tool collapsing is enabled, finalize and remove the tool group
    if (isToolCollapseEnabled()) {
      await finalizeToolGroup(container);
      log(`[CONVERSE] Finalized and removed tool group`);
    }
    
    // Also clean up any remaining tool bubbles not in groups (FSM elements, etc)
    const toolBubbles = Array.from(
      container?.querySelectorAll?.(
        ".agent-message.tool, .user-message.tool"
      ) || []
    );
    if (toolBubbles.length) {
      const fadeMs = Number(CHAT_SETTINGS?.toolBubbleFadeMs) || 250;
      log(
        `[CONVERSE] Pre-cleanup: fading ${toolBubbles.length} remaining tool bubble(s) for ${fadeMs}ms`
      );
      toolBubbles.forEach((b) => {
        try {
          b.classList.add("tm-fade-out");
        } catch (_) {}
      });
      await new Promise((res) => setTimeout(res, fadeMs));
      toolBubbles.forEach((b) => {
        try {
          b.remove();
        } catch (_) {}
      });
    }
  } catch (e) {
    log(`[CONVERSE] Pre-publish tool bubble cleanup failed: ${e}`, "warn");
  }

  // Check if this was aborted by user
  const wasAborted = resp?.err && (
    resp.err.includes("User cancelled") || 
    resp.err.includes("User stopped") ||
    resp.err.includes("AbortError")
  );
  
  if (wasAborted) {
    log(`[CONVERSE] Response was aborted by user, cleaning up thinking bubble`);
    try {
      agentBubble.remove();
    } catch (_) {}
    // Note: stopExecution() already added "User stopped execution" system message
    return;
  }
  
  const assistantText = resp?.assistant || "";
  if (resp?.token_usage) {
    updateConversationTokenUsage(resp.token_usage);
  }

  try {
    agentBubble.classList.remove("loading");
  } catch (_) {}

  if (assistantText) {
    try {
      log(`[CONVERSE] Streaming final assistant markdown (len=${assistantText.length})`);
      await streamText(agentBubble, assistantText);
    } catch (e) {
      agentBubble.textContent = assistantText;
      log(`[CONVERSE] streamText failed: ${e}`, "warn");
    }
  } else {
    // Empty response with no error typically indicates an LLM error
    // Retry silently up to maxRetries times before giving up
    if (!resp?.err && retryCount < maxRetries) {
      const nextRetry = retryCount + 1;
      log(`[CONVERSE] Empty response without error; silent retry (${nextRetry}/${maxRetries})`);
      
      // Save chat log for this failed attempt (with retry count in key)
      const timestamp = Date.now();
      saveChatLog(
        "tabmail_agent_converse_response",
        `${timestamp}_retry${retryCount}`,
        messages,
        `[EMPTY_RESPONSE_RETRY_${retryCount}]`
      );
      
      // Immediately retry, passing the existing bubble to reuse
      return getAgentResponse(messages, nextRetry, agentBubble);
    }
    
    // Remove bubble only when we're done (exhausted retries or there's an error)
    try {
      agentBubble.remove();
    } catch (_) {}
    
    log(`[CONVERSE] Empty response; removed bubble.${retryCount >= maxRetries ? ` (exhausted ${maxRetries} retries)` : ""}`);
    
    // If we exhausted retries, show an error message to the user
    if (retryCount >= maxRetries && !resp?.err) {
      // Save final failed attempt log
      const timestamp = Date.now();
      saveChatLog(
        "tabmail_agent_converse_response",
        `${timestamp}_retry${retryCount}_exhausted`,
        messages,
        `[EMPTY_RESPONSE_RETRIES_EXHAUSTED]`
      );
      try {
        const systemBubble = appendSystemBubble();
        const errorMsg = `Failed to get response after ${maxRetries} retries.`;
        
        // Create error text with retry link
        const errorSpan = document.createElement("span");
        errorSpan.textContent = errorMsg + " ";
        
        const retryLink = document.createElement("a");
        retryLink.textContent = "Retry";
        retryLink.href = "#";
        retryLink.className = "retry-link";
        retryLink.addEventListener("click", (e) => {
          e.preventDefault();
          if (window.tmRetryLastMessage) {
            window.tmRetryLastMessage();
          }
        });
        
        // Get the bubble content element
        const bubbleContent = systemBubble.querySelector(".bubble-content") || systemBubble;
        bubbleContent.appendChild(errorSpan);
        bubbleContent.appendChild(retryLink);
        
        log(`[CONVERSE] Created system error bubble with retry link for exhausted retries`);
        
        // Enable retry
        ctx.canRetry = true;
        if (window.tmUpdateRetryVisibility) window.tmUpdateRetryVisibility();
        
        messages.push({ role: "system", content: errorMsg });
      } catch (e) {
        log(`[CONVERSE] Failed to create system error bubble for exhausted retries: ${e}`, "warn");
      }
      return; // Don't continue to save empty assistant response
    }
  }

  // Handle error responses
  if (resp?.err) {
    try {
      const systemBubble = appendSystemBubble();
      
      // Create error text with retry link
      const errorSpan = document.createElement("span");
      errorSpan.textContent = resp.err + " ";
      
      const retryLink = document.createElement("a");
      retryLink.textContent = "Retry";
      retryLink.href = "#";
      retryLink.className = "retry-link";
      retryLink.addEventListener("click", (e) => {
        e.preventDefault();
        if (window.tmRetryLastMessage) {
          window.tmRetryLastMessage();
        }
      });
      
      // Get the bubble content element
      const bubbleContent = systemBubble.querySelector(".bubble-content") || systemBubble;
      bubbleContent.appendChild(errorSpan);
      bubbleContent.appendChild(retryLink);

      // Special-case: consent required (add button to open consent page in default browser)
      const isConsentRequired =
        typeof resp.err === "string" &&
        (resp.err.includes("Consent required") || resp.err.includes("consent.html"));

      if (isConsentRequired) {
        try {
          const consentBtn = document.createElement("a");
          consentBtn.textContent = "Open consent page";
          consentBtn.href = "#";
          consentBtn.className = "retry-link";
          consentBtn.style.marginLeft = "10px";
          consentBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            const consentUrl = "https://tabmail.ai/consent.html?client=thunderbird";
            log(`[CONVERSE] Consent required; opening consent in default browser: ${consentUrl}`);
            try {
              // TB 145: open in the user's default system browser
              await browser.windows.openDefaultBrowser(consentUrl);
            } catch (err) {
              log(`[CONVERSE] Failed to open consent page in default browser: ${err}`, "warn");
            }
          });

          bubbleContent.appendChild(consentBtn);
        } catch (e) {
          log(`[CONVERSE] Failed to attach consent button: ${e}`, "warn");
        }
      }
      
      log(`[CONVERSE] Created system error bubble with retry link: ${resp.err}`);
      
      // Enable retry
      ctx.canRetry = true;
      if (window.tmUpdateRetryVisibility) window.tmUpdateRetryVisibility();
      
      messages.push({ role: "system", content: resp.err });
    } catch (e) {
      log(`[CONVERSE] Failed to create system error bubble: ${e}`, "warn");
    }
  } else if (assistantText) {
    // Clear retry state on successful response
    ctx.canRetry = false;
    if (window.tmUpdateRetryVisibility) window.tmUpdateRetryVisibility();
    
    // Save chat log
    const timestamp = Date.now();
    saveChatLog(
      "tabmail_agent_converse_response",
      timestamp,
      messages,
      assistantText
    );

    // Save tool traces if present
    if (resp?.tool_traces && Array.isArray(resp.tool_traces) && resp.tool_traces.length > 0) {
      try {
        saveToolCallLog(
          "tabmail_agent_converse_tool_traces",
          timestamp,
          { tool_traces: resp.tool_traces }
        );
        log(`[CONVERSE] Saved ${resp.tool_traces.length} tool trace(s)`);
      } catch (e) {
        log(`[CONVERSE] Failed to save tool traces: ${e}`, "warn");
      }
    }

    // Append assistant to history only when there's no error
    messages.push({ role: "assistant", content: assistantText });

    // Persist assistant turn to storage (with rendered HTML snapshot for instant replay)
    // NOTE: Cannot use agentBubble.innerHTML — streamText() uses setInterval internally
    // and returns before any streaming steps execute, so the DOM is empty at this point.
    // Generate _rendered directly via renderMarkdown() instead.
    let renderedHtml = "";
    try {
      const { renderMarkdown } = await import("./markdown.js");
      renderedHtml = await renderMarkdown(assistantText);
    } catch (e) {
      log(`[CONVERSE] Failed to generate rendered snapshot: ${e}`, "warn");
    }
    const assistantTurn = {
      role: "assistant",
      content: assistantText,
      _rendered: renderedHtml,
      _id: generateTurnId(),
      _ts: Date.now(),
      _type: "normal",
      _chars: assistantText.length,
    };
    assistantTurn._refs = collectTurnRefs(assistantTurn);
    registerTurnRefs(assistantTurn);
    try {
      if (ctx.persistedTurns && ctx.chatMeta) {
        const { evictedTurns } = await appendTurn(assistantTurn, ctx.persistedTurns, ctx.chatMeta);
        if (evictedTurns?.length) {
          cleanupEvictedIds(evictedTurns);
          // Show truncation indicator in DOM
          const indicator = document.getElementById("history-truncated-indicator");
          if (indicator) indicator.style.display = "";
          log(`[CONVERSE] Evicted ${evictedTurns.length} turns after assistant response`);
        }
      }
    } catch (e) {
      log(`[CONVERSE] Failed to persist assistant turn: ${e}`, "warn");
    }

    // Index user+assistant exchange to FTS immediately so it appears in Chat History
    if (ctx._lastPersistedUserTurn) {
      indexTurnToFTS(ctx._lastPersistedUserTurn, assistantTurn).catch(e =>
        log(`[CONVERSE] FTS indexing failed (non-fatal): ${e}`, "warn")
      );
    }

    // Trigger periodic KB refinement (fire-and-forget, guards internally)
    try {
      import("../../agent/modules/knowledgebase.js").then(({ periodicKbUpdate }) => {
        periodicKbUpdate().catch(e => {
          log(`[CONVERSE] Periodic KB update failed (non-fatal): ${e}`, "warn");
        });
      }).catch(() => {});
    } catch (_) {}
  }
}
