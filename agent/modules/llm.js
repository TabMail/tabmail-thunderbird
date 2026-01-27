// llm.js - Main LLM client for TabMail
// Uses completions endpoint with request/response pattern for LLM interactions
// Supports tool orchestration, retry logic, and response processing
// Thunderbird 142 MV3

import { assertAiBackendAllowed } from "../../chat/modules/privacySettings.js";
import { SETTINGS, getBackendUrl } from "./config.js";
import { setThink } from "./thinkBuffer.js";
import { log, normalizeUnicode } from "./utils.js";

/**
 * Determines the appropriate endpoint type based on the system prompt.
 * 
 * @param {Array} messages - Message array with system prompt as first message
 * @returns {string} - Endpoint type ("autocomplete" or "agent")
 */
function getEndpointType(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return "agent";
  }
  
  const firstMessage = messages[0];
  const systemPrompt = firstMessage?.content || "";
  
  // Autocomplete endpoint: ONLY for autocomplete prompt (typing suggestions)
  // Compose prompts (reply generation, inline edits) go to agent endpoint
  const autocompletePrompts = [
    "system_prompt_autocomplete",
  ];
  
  if (autocompletePrompts.includes(systemPrompt)) {
    log(`[ENDPOINT] Routing to autocomplete endpoint for ${systemPrompt}`);
    return "autocomplete";
  }
  
  log(`[ENDPOINT] Routing to agent endpoint for ${systemPrompt}`);
  return "agent";
}

/**
 * Read SSE stream from the response and handle events.
 * 
 * @param {Response} response - Fetch response with SSE stream
 * @param {AbortSignal|null} abortSignal - Optional abort signal
 * @param {Function|null} onToolExecution - Optional callback when tools need execution
 * @returns {Promise<Object>} - Final response data
 */
async function readSSEStream(response, abortSignal = null, onToolExecution = null) {
  log(`[SSE] Starting to read SSE stream`);
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finalResponse = null;
  const serverToolStatuses = new Map(); // Track server tool execution statuses
  
  // SSE parser state (needs to persist across chunks for incomplete events)
  let currentEvent = null;
  let currentData = [];
  
  // Timeout for stream reads to detect stalled connections
  const STREAM_TIMEOUT_MS = 60000; // 60 seconds without data = timeout
  
  try {
  while (true) {
      // Check if aborted
    if (abortSignal && abortSignal.aborted) {
        log(`[SSE] Abort signal detected, stopping stream read`, "info");
        reader.cancel();
      throw new DOMException("User stopped execution", "AbortError");
    }
    
      // Read with timeout using Promise.race
      const readPromise = reader.read();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Stream timeout: no data received for ${STREAM_TIMEOUT_MS / 1000}s`));
        }, STREAM_TIMEOUT_MS);
      });
      
      const { done, value } = await Promise.race([readPromise, timeoutPromise]);
      
      if (done) {
        log(`[SSE] Stream ended (done=true from reader)`);
        log(`[SSE] Remaining buffer content: "${buffer}"`);
        log(`[SSE] Buffer length: ${buffer.length}`);
        
        // CRITICAL: Process any remaining buffered data before breaking
        // If we have an incomplete event (event + data but no final newline),
        // we need to force-process it as the stream has ended
        if (currentEvent && currentData.length > 0) {
          log(`[SSE] [PARSER] Stream ended with incomplete event: ${currentEvent}, forcing completion`);
          const dataStr = currentData.join("\n");
          
          try {
            const eventData = JSON.parse(dataStr);
            log(`[SSE] Received event (from buffer on close): ${currentEvent}`, "info");
            
            // Process the event (same logic as normal event processing)
            if (currentEvent === "final") {
              log(`[SSE] Received final response (recovered from buffer)`);
              finalResponse = eventData;
              
              if (serverToolStatuses.size > 0) {
                try {
                  if (window.onServerToolExecutionsCompleted) {
                    window.onServerToolExecutionsCompleted();
                  }
                } catch (e) {
                  log(`[SSE] Failed to notify UI about completion: ${e}`, "warn");
                }
              }
            } else if (currentEvent === "error") {
              log(`[SSE] Received error event (from buffer): ${eventData.error}`, "error");
              finalResponse = { err: eventData.error };
            } else {
              log(`[SSE] Ignoring non-final event in buffer: ${currentEvent}`, "warn");
            }
          } catch (e) {
            log(`[SSE] Failed to parse buffered event data: ${e}`, "error");
          }
        }
        
        break;
      }
      
      const chunk = decoder.decode(value, { stream: true });
      log(`[SSE] Received chunk: ${chunk.length} bytes`);
      try {
        log(`[SSE] Chunk content (first 500 chars): ${chunk.substring(0, 500)}`);
      } catch (e) {
        log(`[SSE] Failed to log chunk content: ${e}`, "error");
      }
      
      buffer += chunk;
      
      // Process complete SSE events
      const lines = buffer.split("\n");
      buffer = lines.pop() || ""; // Keep incomplete line in buffer
      
      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent = line.substring(6).trim();
          log(`[SSE] [PARSER] Found event line: "${currentEvent}"`);
        } else if (line.startsWith("data:")) {
          const dataLine = line.substring(5).trim();
          currentData.push(dataLine);
          log(`[SSE] [PARSER] Found data line (${dataLine.length} chars)`);
        } else if (line === "" && currentEvent && currentData.length > 0) {
          // Complete event received
          log(`[SSE] [PARSER] Complete event detected: ${currentEvent} with ${currentData.length} data line(s)`);
          const dataStr = currentData.join("\n");
          
          try {
            const eventData = JSON.parse(dataStr);
            
            log(`[SSE] Received event: ${currentEvent}`, "info");
            
            // Handle different event types
            if (currentEvent === "keepalive") {
              log(`[SSE] Keepalive received`);
            } else if (currentEvent === "tool_started") {
              log(`[SSE] Tool started: ${eventData.display_label}`);
              
              // Track status
              serverToolStatuses.set(eventData.execution_id, {
                execution_id: eventData.execution_id,
                call_id: eventData.call_id,
                display_label: eventData.display_label,
                state: "running", // lowercase to match UI expectations
                tool_name: eventData.tool_name, // Available in dev mode
                arguments: eventData.arguments, // Available in dev mode
                started_at: Date.now(),
              });
              
              // Notify UI
              try {
                if (window.onServerToolExecutionsStarted) {
                  window.onServerToolExecutionsStarted([serverToolStatuses.get(eventData.execution_id)]);
                }
              } catch (e) {
                log(`[SSE] Failed to notify UI about tool start: ${e}`, "warn");
              }
            } else if (currentEvent === "tool_completed") {
              log(`[SSE] Tool completed: ${eventData.display_label} (${eventData.elapsed_ms}ms)`);
              
              // Update status
              const status = serverToolStatuses.get(eventData.execution_id);
              if (status) {
                status.state = "completed"; // lowercase to match UI expectations
                status.elapsed_ms = eventData.elapsed_ms;
                status.result = eventData.result; // Available in dev mode
                
                // Save comprehensive tool call log (matches client-side tool format)
                // Only saves in dev mode (when tool_name is available)
                if (status.tool_name && status.arguments) {
                  try {
                    const { saveToolCallLog } = await import("./utils.js");
                    await saveToolCallLog(
                      "tabmail_agent_toolcall_server_sse",
                      `${status.started_at}_${status.tool_name}`,
                      { 
                        name: status.tool_name, 
                        arguments: status.arguments, 
                        result: eventData.result || {}, 
                        success: eventData.success,
                        execution_id: status.execution_id,
                        call_id: status.call_id,
                        started_at: status.started_at,
                        elapsed_ms: eventData.elapsed_ms,
                        server_side: true
                      }
                    );
                    log(`[SSE] Saved comprehensive tool call log for ${status.tool_name}`);
                  } catch (logErr) {
                    log(`[SSE] Failed to save tool call log: ${logErr}`, "warn");
                  }
                }
                
                // Notify UI
                try {
                  if (window.onServerToolExecutionStatus) {
                    log(`[SSE] Notifying UI: tool ${status.tool_name || status.execution_id} completed`);
                    window.onServerToolExecutionStatus(status);
                  }
                } catch (e) {
                  log(`[SSE] Failed to notify UI about tool completion: ${e}`, "warn");
                }
              }
            } else if (currentEvent === "tool_failed") {
              log(`[SSE] Tool failed: ${eventData.display_label} - ${eventData.error}`, "error");
              
              // Update status
              const status = serverToolStatuses.get(eventData.execution_id);
              if (status) {
                status.state = "failed"; // lowercase to match UI expectations
                status.error = eventData.error;
                const elapsed_ms = Date.now() - status.started_at;
                
                // Save comprehensive tool call log for failed tools
                // Only saves in dev mode (when tool_name is available)
                if (status.tool_name && status.arguments) {
                  try {
                    const { saveToolCallLog } = await import("./utils.js");
                    await saveToolCallLog(
                      "tabmail_agent_toolcall_server_sse",
                      `${status.started_at}_${status.tool_name}`,
                      { 
                        name: status.tool_name, 
                        arguments: status.arguments, 
                        result: { error: eventData.error }, 
                        success: false,
                        execution_id: status.execution_id,
                        call_id: status.call_id,
                        started_at: status.started_at,
                        elapsed_ms: elapsed_ms,
                        server_side: true
                      }
                    );
                    log(`[SSE] Saved comprehensive failed tool call log for ${status.tool_name}`);
                  } catch (logErr) {
                    log(`[SSE] Failed to save tool call log: ${logErr}`, "warn");
                  }
                }
                
                // Notify UI
                try {
                  if (window.onServerToolExecutionStatus) {
                    log(`[SSE] Notifying UI: tool ${status.tool_name || status.execution_id} failed`);
                    window.onServerToolExecutionStatus(status);
                  }
                } catch (e) {
                  log(`[SSE] Failed to notify UI about tool failure: ${e}`, "warn");
                }
              }
            } else if (currentEvent === "final") {
              log(`[SSE] Received final response`);
              finalResponse = eventData;
              
              // Notify UI that server tools are done
              if (serverToolStatuses.size > 0) {
        try {
          if (window.onServerToolExecutionsCompleted) {
            window.onServerToolExecutionsCompleted();
          }
        } catch (e) {
                  log(`[SSE] Failed to notify UI about completion: ${e}`, "warn");
                }
              }
            } else if (currentEvent === "error") {
              log(`[SSE] Received error event: ${eventData.error}`, "error");
              finalResponse = { err: eventData.error };
            } else {
              log(`[SSE] Unknown event type: ${currentEvent}`, "warn");
            }
          } catch (e) {
            log(`[SSE] Failed to parse event data: ${e}`, "error");
          }
          
          // Reset for next event
          currentEvent = null;
          currentData = [];
        }
      }
    }
    } catch (e) {
      if (e.name === "AbortError") {
      log(`[SSE] Stream read aborted by user`, "info");
      throw e;
    }
    log(`[SSE] Error reading stream: ${e}`, "error");
    throw e;
  } finally {
    try {
      reader.releaseLock();
    } catch (e) {
      // Ignore lock release errors
    }
    
    // Notify UI that server tools are done (even if stream ended prematurely)
    if (serverToolStatuses.size > 0 && !finalResponse) {
      try {
        if (window.onServerToolExecutionsCompleted) {
          window.onServerToolExecutionsCompleted();
        }
      } catch (e) {
        log(`[SSE] Failed to notify UI about completion: ${e}`, "warn");
      }
    }
  }
  
  if (!finalResponse) {
    // Provide better error messaging based on what we received
    const allServerToolsCompleted = Array.from(serverToolStatuses.values()).every(
      status => status.state === "completed" || status.state === "failed"
    );
    
    if (serverToolStatuses.size > 0 && allServerToolsCompleted) {
      log(`[SSE] Stream ended after all server tools completed, but final response was lost`, "error");
      throw new Error("Connection lost after completing tools. Please try again.");
    }
    
    throw new Error("Connection lost before receiving response. Please try again.");
  }
  
  return finalResponse;
}

/**
 * Retry helper with exponential backoff for network errors.
 * 
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries (default: 3)
 * @param {number} baseDelay - Base delay in ms (default: 1000)
 * @param {AbortSignal|null} abortSignal - Optional abort signal
 * @returns {Promise<any>} - Result from function
 */
async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000, abortSignal = null) {
  let lastError = null;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Check if aborted
    if (abortSignal && abortSignal.aborted) {
      throw new DOMException("User stopped execution", "AbortError");
    }
    
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      
      // Don't retry on user abort
      if (e.name === "AbortError") {
        throw e;
      }
      
      // Don't retry on 4xx client errors (except 408 Request Timeout, 429 Too Many Requests)
      const is4xxError = e.message && /Request failed: (4\d{2})/.test(e.message);
      const statusMatch = e.message && e.message.match(/Request failed: (\d{3})/);
      const statusCode = statusMatch ? parseInt(statusMatch[1]) : null;
      
      if (is4xxError && statusCode !== 408 && statusCode !== 429) {
        log(`[RETRY] Not retrying 4xx client error: ${e.message}`, "warn");
        throw e;
      }
      
      // Don't retry on 5xx server errors (backend should handle retries internally)
      const is5xxError = e.message && /Request failed: (5\d{2})/.test(e.message);
      if (is5xxError) {
        log(`[RETRY] Not retrying 5xx server error: ${e.message}`, "warn");
        throw e;
      }
      
      // Only retry network errors (fetch failures, timeouts, connection drops)
      const isNetworkError = (
        e.name === "TypeError" || // Network errors are typically TypeErrors
        e.message.includes("network") ||
        e.message.includes("Connection lost") ||
        e.message.includes("Failed to fetch") ||
        statusCode === 408 ||
        statusCode === 429
      );
      
      if (!isNetworkError || attempt === maxRetries) {
        log(`[RETRY] Max retries reached or non-retriable error: ${e.message}`, "error");
        throw lastError;
      }
      
      // Calculate delay with exponential backoff + jitter
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;
      log(`[RETRY] Attempt ${attempt + 1}/${maxRetries} failed: ${e.message}. Retrying in ${Math.round(delay)}ms...`, "warn");
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

/**
 * Send a turn-based chat request.
 * Handles tool execution loop automatically.
 * 
 * @param {Object} payload - Request payload
 * @param {Array} payload.messages - Chat messages
 * @param {Array} [payload.tools] - Optional client-side tools
 * @param {boolean} [payload.disable_tools] - Optional: disable all tools
 * @param {Object} [payload.conversation_state] - Optional: state from previous turn
 * @param {AbortSignal|null} abortSignal - Optional abort signal
 * @param {Function|null} onToolExecution - Optional callback when tools need execution
 * @param {boolean} [_internal_no_retry] - Internal flag to disable retry (for recursive calls)
 * @returns {Promise<Object>} - Final response with assistant, token_usage, etc.
 */
async function sendChatCompletions(payload, abortSignal = null, onToolExecution = null, _internal_no_retry = false) {
  // Wrap in retry logic for network errors (unless this is a recursive call from tool execution)
  if (!_internal_no_retry) {
    return retryWithBackoff(
      () => sendChatCompletions(payload, abortSignal, onToolExecution, true),
      3, // max retries
      1000, // base delay ms
      abortSignal
    );
  }
  
  const endpointType = getEndpointType(payload.messages);

  // Privacy: allow users to opt out from sending any email data to TabMail backend.
  // This hard-blocks ALL AI calls (chat, tools, autocomplete, summaries, etc).
  await assertAiBackendAllowed(`llm.sendChatCompletions endpoint=${endpointType}`);
  const base = await getBackendUrl(endpointType);
  const url = `${base}/${endpointType}/completions/chat`;
  
  log(`[COMPLETIONS] Sending request to ${url}`);
  log(`[COMPLETIONS] Payload keys: ${Object.keys(payload).join(', ')}`);
  
  // Get access token
  const { getAccessToken } = await import("./supabaseAuth.js");
  const accessToken = await getAccessToken();
  if (!accessToken) {
    throw new Error("Not authenticated. Please sign in.");
  }
  
  // Make request
  let response;
  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${accessToken}`
    };
    
    const fetchOptions = {
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload),
    };
    
    if (abortSignal) {
      fetchOptions.signal = abortSignal;
    }
    
    response = await fetch(url, fetchOptions);
    
    // Handle throttling (429) - retry indefinitely with exponential backoff (capped at 5s)
    let throttleRetryCount = 0;
    let throttleBubble = null;
    let wasThrottled = false; // Track if we encountered throttling
    
    while (response.status === 429) {
      wasThrottled = true; // Mark that we were throttled
      try {
        const errorData = await response.json();
        const retryAfter = errorData.retry_after_seconds || 0.5;
        const currentRate = errorData.current_rate || 0;
        const limit = errorData.limit || 0;
        
        throttleRetryCount++;
        log(`[COMPLETIONS] [THROTTLE] Rate limited (${currentRate}/${limit} tokens/min) - retry #${throttleRetryCount} after ${retryAfter}s`, "info");
        
        // Notify throttle callback if provided
        if (throttleRetryCount === 1 && window._tabmailThrottleCallback) {
          try {
            window._tabmailThrottleCallback('start');
          } catch (_) {}
        }
        
        // Create or update throttle waiting indicator (styled as tool reply with indent)
        try {
          if (!throttleBubble) {
            const { createNewAgentBubble } = await import("../../chat/chat.js");
            throttleBubble = await createNewAgentBubble("");
            // Force tool styling (indent, opacity, icon) even outside active tool session
            throttleBubble.classList.add("tool");
          }
          const { setBubbleText } = await import("../../chat/modules/helpers.js");
          setBubbleText(throttleBubble, "Taking a little longer ... [upgrade to Pro](https://tabmail.ai/pricing.html) for faster responses.");
        } catch (e) {
          log(`[COMPLETIONS] Failed to update throttle UI: ${e}`, "warn");
        }
        
        // Wait before retry with exponential backoff capped at 5s
        const backoffMultiplier = Math.pow(1.5, throttleRetryCount - 1);
        const uncappedWait = retryAfter * backoffMultiplier * 1000;
        const waitTime = Math.min(uncappedWait, 5000); // Cap at 5 seconds
        log(`[COMPLETIONS] [THROTTLE] Waiting ${(waitTime/1000).toFixed(1)}s before retry (uncapped: ${(uncappedWait/1000).toFixed(1)}s)`, "info");
        await new Promise(resolve => setTimeout(resolve, waitTime));
        
        // Retry request
        log(`[COMPLETIONS] [THROTTLE] Retrying after throttle wait...`, "info");
        const retryAccessToken = await getAccessToken();
        if (!retryAccessToken) {
          throw new Error("Lost authentication during throttle retry");
        }
        
        response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${retryAccessToken}`
          },
          body: JSON.stringify(payload),
          signal: abortSignal,
        });
      } catch (jsonError) {
        log(`[COMPLETIONS] [THROTTLE] Failed to parse 429 response (${jsonError}) - may indicate server issue`, "warn");
        // If we can't parse the 429 response, break to avoid infinite loop
        throw new Error("Rate limit active but unable to determine retry parameters. Please try again later.");
      }
    }
    
    // Remove throttle waiting indicator once we succeed
    if (throttleBubble) {
      try {
        throttleBubble.remove();
      } catch (e) {
        log(`[COMPLETIONS] Failed to remove throttle bubble: ${e}`, "warn");
      }
    }
    
    // Notify throttle callback that it ended
    if (wasThrottled && window._tabmailThrottleCallback) {
      try {
        window._tabmailThrottleCallback('end');
      } catch (_) {}
    }
    
    // Handle auth errors
    if (!response.ok) {
      const { isAuthError, handleAuthError } = await import("./supabaseAuth.js");
      if (isAuthError(response)) {
        log(`[COMPLETIONS] Auth error detected (${response.status}), checking auth state`);
        const authResult = await handleAuthError(response);
        if (authResult === "consent_required") {
          log(`[COMPLETIONS] Consent required`);
          throw new Error(
            `Consent required before you can use TabMail features.\n\n` +
            `Please complete consent here: https://tabmail.ai/consent.html?client=thunderbird`
          );
        } else if (authResult === null) {
          log(`[COMPLETIONS] Feature disabled`);
          throw new Error(`Feature disabled. This endpoint requires a different authentication tier.`);
        } else if (authResult === true) {
          // Retry after re-auth
          log(`[COMPLETIONS] Re-authentication successful, retrying`);
          const newAccessToken = await getAccessToken();
          if (!newAccessToken) {
            throw new Error("Failed to get access token after re-auth");
          }
          
          response = await fetch(url, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${newAccessToken}`
            },
            body: JSON.stringify(payload),
            signal: abortSignal,
          });
          
          if (!response.ok) {
            const txt = await response.text();
            throw new Error(`Request failed after re-auth: ${response.status} ${txt}`);
          }
        } else {
          throw new Error(`Authentication required. Please sign in and try again.`);
        }
      } else {
        const txt = await response.text();
        throw new Error(`Request failed: ${response.status} ${txt}`);
      }
    }
  } catch (e) {
    // Check if this is a throttling-related error (normal behavior, not an error)
    const isThrottleError = e && e.message && (
      e.message.includes("Rate limit active") ||
      e.message.includes("retry parameters")
    );
    
    if (isThrottleError) {
      log(`[COMPLETIONS] [THROTTLE] ${e.message}`, "warn");
    } else {
      log(`[COMPLETIONS] Request failed: ${e}`, "error");
    }
    throw e;
  }
  
  // Check if response is SSE stream (text/event-stream) or JSON
  const contentType = response.headers.get("Content-Type") || "";
  
  if (contentType.includes("text/event-stream")) {
    // SSE stream response - read events
    log(`[COMPLETIONS] Received SSE stream response`);
    
    try {
      const data = await readSSEStream(response, abortSignal, onToolExecution);
      
      log(`[COMPLETIONS] SSE stream completed, processing final response`);
  
  // Check for errors
      if (data.error || data.err) {
        log(`[COMPLETIONS] Server returned error: ${data.error || data.err}`, "error");
        return { err: `Server error: ${data.error || data.err}` };
      }
      
      // Check if this is a final response or needs tool execution
      if (data.tool_calls && Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
        log(`[COMPLETIONS] Received ${data.tool_calls.length} tool calls from SSE stream, need to execute`);
        
        // Execute tools if callback provided
        if (onToolExecution && typeof onToolExecution === 'function') {
          try {
            // Execute all tools and collect results
            const toolResults = await onToolExecution(data.tool_calls, data.token_usage);
            
            log(`[COMPLETIONS] Tool execution completed, ${toolResults.length} results`);
            
            // Build conversation state from response
            const conversationState = data.conversation_state || {};
            const harmonyMessages = conversationState.harmony_messages || [];
            
            // Append tool results to conversation
            for (const result of toolResults) {
              const toolMsg = {
                role: "tool",
                content: result.output || "{}",
                tool_call_id: result.call_id,
              };
              harmonyMessages.push(toolMsg);
            }
            
            // Update conversation state
            conversationState.harmony_messages = harmonyMessages;
            
            // Continue to next turn with tool results
      return sendChatCompletions({
        ...payload,
              conversation_state: conversationState,
      }, abortSignal, onToolExecution, true); // Pass true to disable retry for recursive calls
          } catch (e) {
            log(`[COMPLETIONS] Tool execution failed: ${e}`, "error");
            return { err: `Tool execution failed: ${e.message || String(e)}` };
          }
        } else {
          // No callback provided, return tool calls for manual execution
          log(`[COMPLETIONS] No tool execution callback, returning tool calls`);
          return {
            tool_calls: data.tool_calls,
            token_usage: data.token_usage,
            conversation_state: data.conversation_state,
          };
        }
      }
      
      // Final response from SSE stream
      log(`[COMPLETIONS] Received final response from SSE stream`);
      
      // Handle thinking
      if (data.thinking) {
        setThink(data.thinking);
        log(`[COMPLETIONS] Captured thinking (len=${data.thinking.length})`);
      }
      
      // Log token usage including reasoning tokens
      if (data.token_usage) {
        const usage = data.token_usage;
        const reasoningTokens = usage.reasoning_tokens || 0;
        const outputTokens = usage.output_tokens || 0;
        const inputTokens = usage.input_tokens || 0;
        const totalTokens = usage.total_tokens || 0;
        const contextLimit = usage.context_limit || 0;
        const usagePercentage = usage.usage_percentage || 0;
        
        log(
          `[Token Usage] Total: ${totalTokens}/${contextLimit} (${usagePercentage}%) | Input: ${inputTokens} | Output: ${outputTokens} (Reasoning: ${reasoningTokens}, Content: ${outputTokens - reasoningTokens})`
        );
      }
      
      return data;
      
    } catch (e) {
      if (e.name === "AbortError") {
        log(`[COMPLETIONS] SSE stream aborted by user`, "info");
        throw e;
      }
      log(`[COMPLETIONS] SSE stream failed: ${e}`, "error");
      return { err: `SSE stream failed: ${e.message || String(e)}` };
    }
  }
  
  // JSON response (non-streaming mode)
  log(`[COMPLETIONS] Received JSON response`);
  
  let data;
  try {
    data = await response.json();
  } catch (e) {
    log(`[COMPLETIONS] Failed to parse response: ${e}`, "error");
    throw new Error(`Failed to parse server response: ${e.message || String(e)}`);
  }
  
  log(`[COMPLETIONS] Response keys: ${Object.keys(data).join(', ')}`);
  
  // Check for errors
  if (data.error) {
    log(`[COMPLETIONS] Server returned error: ${data.error}`, "error");
    return { err: `Server error: ${data.error}` };
  }
  
  // Check if this is a final response or needs tool execution
  if (data.tool_calls && Array.isArray(data.tool_calls) && data.tool_calls.length > 0) {
    log(`[COMPLETIONS] Received ${data.tool_calls.length} tool calls, need to execute`);
    
    // Execute tools if callback provided
    if (onToolExecution && typeof onToolExecution === 'function') {
      try {
        // Execute all tools and collect results
        const toolResults = await onToolExecution(data.tool_calls, data.token_usage);
        
        log(`[COMPLETIONS] Tool execution completed, ${toolResults.length} results`);
        
        // Build conversation state from response
        const conversationState = data.conversation_state || {};
        const harmonyMessages = conversationState.harmony_messages || [];
        
        // Append tool results to conversation
        for (const result of toolResults) {
          const toolMsg = {
            role: "tool",
            content: result.output || "{}",
            tool_call_id: result.call_id,
          };
          harmonyMessages.push(toolMsg);
        }
        
        // Update conversation state
        conversationState.harmony_messages = harmonyMessages;
        
        // Continue to next turn with tool results
        return sendChatCompletions({
          ...payload,
          conversation_state: conversationState,
        }, abortSignal, onToolExecution, true); // Pass true to disable retry for recursive calls
      } catch (e) {
        log(`[COMPLETIONS] Tool execution failed: ${e}`, "error");
        return { err: `Tool execution failed: ${e.message || String(e)}` };
      }
    } else {
      // No callback provided, return tool calls for manual execution
      log(`[COMPLETIONS] No tool execution callback, returning tool calls`);
      return {
        tool_calls: data.tool_calls,
        token_usage: data.token_usage,
        conversation_state: data.conversation_state,
      };
    }
  }
  
  // Final response
  log(`[COMPLETIONS] Received final response`);
  
  // Handle thinking
  if (data.thinking) {
    setThink(data.thinking);
    log(`[COMPLETIONS] Captured thinking (len=${data.thinking.length})`);
  }
  
  // Log token usage including reasoning tokens
  if (data.token_usage) {
    const usage = data.token_usage;
    const reasoningTokens = usage.reasoning_tokens || 0;
    const outputTokens = usage.output_tokens || 0;
    const inputTokens = usage.input_tokens || 0;
    const totalTokens = usage.total_tokens || 0;
    const contextLimit = usage.context_limit || 0;
    const usagePercentage = usage.usage_percentage || 0;
    
    log(
      `[Token Usage] Total: ${totalTokens}/${contextLimit} (${usagePercentage}%) | Input: ${inputTokens} | Output: ${outputTokens} (Reasoning: ${reasoningTokens}, Content: ${outputTokens - reasoningTokens})`
    );
  }
  
  return data;
}

/**
 * Process JSON response from LLM - strips markdown code fences and parses JSON.
 * 
 * @param {string} rawText - Raw response text
 * @returns {Object} - Parsed JSON object or {message: rawText} on failure
 */
export function processJSONResponse(rawText) {
  // Attempt to extract a clean JSON payload first.
  let txt = (rawText || "").trim();

  // Strip optional Markdown-style code fences (```json ... ```)
  if (txt.startsWith("```")) {
    // Remove the opening fence (``` or ```json) including the first optional newline.
    txt = txt.replace(/^```(?:json)?\n?/i, "");

    // Locate the corresponding closing fence. Anything after it will be ignored.
    const closingIdx = txt.indexOf("```");
    if (closingIdx !== -1) {
      const afterFence = txt.slice(closingIdx + 3);
      if (afterFence.trim()) {
        log(
          `processJSONResponse encountered extra content after closing code fence – ignoring it.`,
          "warn"
        );
      }
      txt = txt.slice(0, closingIdx);
    }
  }

  try {
    const obj = JSON.parse(txt);
    return obj;
  } catch (e) {
    // Not JSON – fall through to raw text.
    log(`processJSONResponse failed to parse JSON: ${e}`);
  }

  return { message: rawText };
}

/**
 * Helper – parse assistant response for email_edit workflow
 * 
 * @param {string} rawText - Raw response text
 * @returns {Object} - Parsed edit response with subject/body
 */
export function processEditResponse(rawText) {
  let txt = (rawText || "").trim();

  // Parse plain text lines for "Subject:" and "Body:"
  const subjectMatch = txt.match(/^Subject:\s*(.*)$/im);
  const bodyMatch = txt.match(/^Body:\s*([\s\S]*)$/im);

  if (subjectMatch || bodyMatch) {
    return {
      subject: subjectMatch ? subjectMatch[1].trim() : undefined,
      body: bodyMatch ? bodyMatch[1].trim() : undefined,
    };
  }

  return { message: rawText };
}

/**
 * Parse summary response into structured format.
 * Extracts todos, blurb, and reminder from LLM response.
 * 
 * @param {string} text - Raw summary response
 * @returns {Object} - {todos: string, blurb: string, reminder: {dueDate: string|null, content: string}|null}
 */
export function processSummaryResponse(text) {
  // 1. Pre-clean: strip markdown heading markers like "##" or "###" that the LLM might insert.
  //    We remove only the leading hash symbols so the actual section headers ("Todos:") remain.
  const preCleaned = text.replace(/^#+\s*/gm, "");

  let todosSection = "";
  let twoLineSection = "";
  let reminderDueDateSection = "";
  let reminderContentSection = "";

  const regexTodos = /Todos:\s*([\s\S]*?)(?:Two-line summary:|$)/i;
  const regexTwoLine = /Two-line summary:\s*([\s\S]*?)(?:Reminder due date:|$)/i;
  const regexReminderDueDate = /Reminder due date:\s*([\s\S]*?)(?:Reminder content:|$)/i;
  const regexReminderContent = /Reminder content:\s*([\s\S]*?)$/i;

  const todosMatch = preCleaned.match(regexTodos);
  if (todosMatch) {
    todosSection = todosMatch[1].trim();
  }

  const twoLineMatch = preCleaned.match(regexTwoLine);
  if (twoLineMatch) {
    twoLineSection = twoLineMatch[1].trim();
  }

  const reminderDueDateMatch = preCleaned.match(regexReminderDueDate);
  if (reminderDueDateMatch) {
    reminderDueDateSection = reminderDueDateMatch[1].trim();
  }

  const reminderContentMatch = preCleaned.match(regexReminderContent);
  if (reminderContentMatch) {
    reminderContentSection = reminderContentMatch[1].trim();
  }

  // 2. Normalise the Todos list into the bullet-delimited format expected by the banner UI.
  let todosClean = "";
  if (todosSection) {
    // Split on newlines, discard empties, strip common list prefixes ("1.", "-", etc.).
    const rawItems = todosSection
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const cleanedItems = rawItems.map((line) =>
      line.replace(/^(\d+[\.)]|[-*•])\s*/, "").trim()
    );
    if (cleanedItems.length) {
      todosClean = cleanedItems
        .map((it) => `• ${it}`)
        .join(" ")
        .trim();
    }
  }

  // Fallback if we didn't manage to parse any list items.
  if (!todosClean) {
    todosClean = todosSection.replace(/\n/g, " ").trim();
  }

  const blurbClean = twoLineSection.replace(/\n/g, " ").trim();
  
  // 3. Parse reminder due date and content
  let reminderObj = null;
  
  const dueDateClean = reminderDueDateSection.replace(/\n/g, " ").trim();
  const contentClean = reminderContentSection.replace(/\n/g, " ").trim();
  
  log(`[LLM] Parsing reminder - dueDate: "${dueDateClean}", content: "${contentClean.slice(0, 60)}..."`);
  
  // Check if we have valid reminder content
  if (contentClean && contentClean.toLowerCase() !== "none" && contentClean !== "") {
    // Parse due date - backend post-processor converts relative dates to YYYY-MM-DD
    // We accept YYYY-MM-DD format here; if format is invalid, set to null
    let dueDate = null;
    
    if (dueDateClean && dueDateClean.toLowerCase() !== "none" && dueDateClean !== "") {
      // Check for full YYYY-MM-DD format (backend should have converted relative dates)
      if (/^\d{4}-\d{2}-\d{2}$/.test(dueDateClean)) {
        dueDate = dueDateClean;
        log(`[LLM] ✓ Valid reminder parsed: dueDate=${dueDate}, content="${contentClean.slice(0, 40)}..."`);
      } else {
        // Backend should have converted this - log warning if it didn't
        log(`[LLM] ⚠️ Unexpected date format from backend: "${dueDateClean}", expected YYYY-MM-DD`, "warn");
        // Still store it - might be a relative date that wasn't converted
        dueDate = dueDateClean;
      }
    }
    
    reminderObj = {
      dueDate: dueDate,
      content: contentClean
    };
  } else {
    log(`[LLM] No valid reminder content found (contentClean="${contentClean}")`);
  }

  return { todos: todosClean, blurb: blurbClean, reminder: reminderObj };
}

/**
 * Lightweight semaphore to throttle concurrent heavy LLM calls.
 */
const _llmSemaphore = {
  current: 0,
  queue: [],
};

async function _acquire() {
  if (_llmSemaphore.current < SETTINGS.maxAgentWorkers) {
    _llmSemaphore.current += 1;
    return;
  }
  return new Promise((resolve) => _llmSemaphore.queue.push(resolve));
}

function _release() {
  _llmSemaphore.current = Math.max(0, _llmSemaphore.current - 1);
  const next = _llmSemaphore.queue.shift();
  if (next) {
    _llmSemaphore.current += 1;
    next();
  }
}

/**
 * Send a chat request without tools.
 * 
 * @param {Array} messages - Chat messages
 * @param {Object} options - Options
 * @param {boolean} options.ignoreSemaphore - Bypass concurrency guard
 * @returns {Promise<string|null>} - Assistant text or null
 */
export async function sendChat(
  messages,
  { ignoreSemaphore = false } = {}
) {
  if (!Array.isArray(messages) || messages.length === 0) {
    log("sendChat called with empty messages", "error");
    return null;
  }
  
  const payload = {
    messages,
    client_timestamp_ms: Date.now(),
    disable_tools: true,
  };
  
  let acquired = false;
  try {
    if (!ignoreSemaphore) {
      await _acquire();
      acquired = true;
    }
    
    const json = await sendChatCompletions(payload, null);
    
    if (json.err) {
      log(`sendChat error: ${json.err}`, "error");
      return null;
    }
    
    // Log token usage including reasoning tokens
    if (json.token_usage) {
      const usage = json.token_usage;
      const reasoningTokens = usage.reasoning_tokens || 0;
      const outputTokens = usage.output_tokens || 0;
      const inputTokens = usage.input_tokens || 0;
      const totalTokens = usage.total_tokens || 0;
      const contextLimit = usage.context_limit || 0;
      const usagePercentage = usage.usage_percentage || 0;
      
      log(
        `[sendChat Token Usage] Total: ${totalTokens}/${contextLimit} (${usagePercentage}%) | Input: ${inputTokens} | Output: ${outputTokens} (Reasoning: ${reasoningTokens}, Content: ${outputTokens - reasoningTokens})`
      );
      
      // Store thinking/reasoning if present
      if (json.thinking) {
        log(`[sendChat Thinking] Captured ${json.thinking.length} chars of reasoning`);
      }
    }
    
    const assistantText = json?.assistant || "";
    const wasThrottled = json?.wasThrottled || false;
    
    // If throttled, return full object for caller to handle
    // Otherwise return just the string for backward compatibility
    if (wasThrottled) {
      return {
        assistant: normalizeUnicode(assistantText.trim()),
        wasThrottled: true,
        token_usage: json.token_usage,
      };
    }
    
    return normalizeUnicode(assistantText.trim());
  } catch (e) {
    log(`sendChat network error: ${e}`, "error");
    return null;
  } finally {
    if (acquired) _release();
  }
}

/**
 * Send a chat request and return the full response object.
 * Use this when you need access to all response fields (e.g., refined_kb, token_usage).
 * Tools are disabled by default.
 * 
 * @param {Array} messages - Chat messages
 * @param {Object} options - Options
 * @param {boolean} options.ignoreSemaphore - Bypass concurrency guard
 * @returns {Promise<Object>} - Full response object { assistant, token_usage, refined_kb, etc. }
 */
export async function sendChatRaw(
  messages,
  { ignoreSemaphore = false } = {}
) {
  if (!Array.isArray(messages) || messages.length === 0) {
    log("sendChatRaw called with empty messages", "error");
    return { err: "Invalid request: empty messages" };
  }
  
  const payload = {
    messages,
    client_timestamp_ms: Date.now(),
    disable_tools: true,
  };
  
  let acquired = false;
  try {
    if (!ignoreSemaphore) {
      await _acquire();
      acquired = true;
    }
    
    const json = await sendChatCompletions(payload, null);
    
    if (json.err) {
      log(`sendChatRaw error: ${json.err}`, "error");
      return json;
    }
    
    // Normalize assistant text if present
    if (json && typeof json.assistant === "string") {
      json.assistant = normalizeUnicode(json.assistant.trim());
    }
    
    return json || { err: "Empty response from server" };
  } catch (e) {
    log(`sendChatRaw network error: ${e}`, "error");
    return { err: e instanceof Error ? e.message : String(e) };
  } finally {
    if (acquired) _release();
  }
}

/**
 * Send a chat request with tool support.
 * Executes tools automatically via callback.
 * Backend loads tool definitions from its own /tools/*.json files.
 * 
 * @param {Array} messages - Chat messages
 * @param {Object} options - Options
 * @param {boolean} options.ignoreSemaphore - Bypass concurrency guard
 * @param {AbortController} options.abortController - Abort controller
 * @param {Function} options.onToolExecution - Callback for tool execution
 * @returns {Promise<Object>} - Response with assistant, token_usage, etc.
 */
export async function sendChatWithTools(
  messages,
  {
    ignoreSemaphore = false,
    abortController = null,
    onToolExecution = null,
  } = {}
) {
  if (!Array.isArray(messages) || messages.length === 0) {
    log("sendChatWithTools called with empty messages", "error");
    return { err: "Invalid request: empty messages" };
  }
  
  const payload = {
    messages,
    client_timestamp_ms: Date.now(),
    disable_tools: false,
  };
  
  let acquired = false;
  try {
    if (!ignoreSemaphore) {
      await _acquire();
      acquired = true;
    }
    
    const json = await sendChatCompletions(
      payload,
      abortController?.signal || null,
      onToolExecution
    );
    
    if (json.err) {
      return json;
    }
    
    // Normalize assistant text
    if (json && typeof json.assistant === "string") {
      json.assistant = normalizeUnicode(json.assistant);
    }
    
    return json || { err: "Empty response from server" };
  } catch (e) {
    if (e.name === "AbortError") {
      log("[COMPLETIONS] sendChatWithTools cancelled via AbortController", "info");
      return { err: "User cancelled response." };
    }
    log(`sendChatWithTools network error: ${e}`, "error");
    const errorMsg = e instanceof Error ? e.message : String(e);
    return { err: errorMsg };
  } finally {
    if (acquired) _release();
  }
}

/**
 * Send chat without mutating history.
 * 
 * @param {Array} chatHistory - Chat history
 * @param {string} userContent - User message
 * @param {Object} options - Options
 * @returns {Promise<string|null>} - Assistant reply or null
 */
export async function sendChatWithoutHistoryMutation(
  chatHistory,
  userContent,
  options = {}
) {
  if (!userContent) return null;
  const messages = chatHistory.concat({ role: "user", content: userContent });
  return sendChat(messages, options);
}

