// core.js – router for chat tools (TB 142, MV3)

import { log } from "../../agent/modules/utils.js";
import { resolveEmailSubject, resolveEventDetails } from "../modules/entityResolver.js";
import * as calendarEventCreateTool from "./calendar_event_create.js";
import * as calendarEventDeleteTool from "./calendar_event_delete.js";
import * as calendarEventEditTool from "./calendar_event_edit.js";
import * as calendarEventReadTool from "./calendar_event_read.js";
import * as calendarReadTool from "./calendar_read.js";
import * as calendarSearchTool from "./calendar_search.js";
import * as contactsAddTool from "./contacts_add.js";
import * as contactsDeleteTool from "./contacts_delete.js";
import * as contactsEditTool from "./contacts_edit.js";
import * as contactsSearchTool from "./contacts_search.js";
import * as emailArchiveTool from "./email_archive.js";
import * as emailComposeTool from "./email_compose.js";
import * as emailDeleteTool from "./email_delete.js";
import * as emailForwardTool from "./email_forward.js";
import * as emailMoveToInboxTool from "./email_move_to_inbox.js";
import * as emailReadTool from "./email_read.js";
import * as emailReplyTool from "./email_reply.js";
import * as emailSearchTool from "./email_search.js";
import * as inboxReadTool from "./inbox_read.js";
import * as kbAddTool from "./kb_add.js";
import * as kbDelTool from "./kb_del.js";
import * as memoryReadTool from "./memory_read.js";
import * as memorySearchTool from "./memory_search.js";
import * as webReadTool from "./web_read.js";
import * as reminderAddTool from "./reminder_add.js";
import * as reminderDelTool from "./reminder_del.js";
import * as changeSettingTool from "./change_setting.js";

// --- FSM Chain Tracking ---
// Track the last FSM tool executed in the current tool-call-chain to detect
// consecutive FSM tool requests (which are often errors).
// Reset happens ONLY at the start of a new user turn (in agentConverse).
let _lastFsmToolInChain = null;
let _lastFsmToolArgs = null;

const TOOL_IMPL = {
  inbox_read: inboxReadTool,
  email_read: emailReadTool,
  email_search: emailSearchTool,
  calendar_search: calendarSearchTool,
  calendar_read: calendarReadTool,
  calendar_event_read: calendarEventReadTool,
  contacts_search: contactsSearchTool,
  contacts_add: contactsAddTool,
  contacts_edit: contactsEditTool,
  contacts_delete: contactsDeleteTool,
  calendar_event_create: calendarEventCreateTool,
  calendar_event_edit: calendarEventEditTool,
  calendar_event_delete: calendarEventDeleteTool,
  email_compose: emailComposeTool,
  email_forward: emailForwardTool,
  email_reply: emailReplyTool,
  email_delete: emailDeleteTool,
  email_archive: emailArchiveTool,
  email_move_to_inbox: emailMoveToInboxTool,
  kb_add: kbAddTool,
  kb_del: kbDelTool,
  memory_read: memoryReadTool,
  memory_search: memorySearchTool,
  web_read: webReadTool,
  reminder_add: reminderAddTool,
  reminder_del: reminderDelTool,
  change_setting: changeSettingTool,
};

// Generic marker for server-side tools (backend sends this name)
const SERVER_SIDE_TOOL_NAME = "server_side_tool";

// FSM tools that require special handling (context switching)
const FSM_TOOLS = new Set(["email_compose", "email_forward", "email_reply", "calendar_event_delete", "contacts_delete", "email_delete", "email_archive"]);

export function isFsmTool(toolName) {
  return FSM_TOOLS.has(toolName);
}

export function isServerSideTool(toolName) {
  return toolName === SERVER_SIDE_TOOL_NAME;
}

export async function getToolActivityLabel(name, args = {}) {
  // Server-side tools: use display label from backend
  if (name === SERVER_SIDE_TOOL_NAME && args._display_label) {
    return args._display_label;
  }
  
  // Note: pagination info is handled by the conversation logic after tool execution
  switch (name) {
    case "inbox_read":
      return "Reading inbox…";
    case "email_read": {
      const uniqueId = args?.unique_id || "";
      if (uniqueId) {
        try {
          const emailInfo = await resolveEmailSubject(uniqueId);
          if (emailInfo?.subject) {
            return `Reading email: ${emailInfo.subject}`;
          }
        } catch (e) {
          log(`[TMDBG Tools] Failed to resolve email subject: ${e}`, "warn");
        }
      }
      return "Reading email…";
    }
    case "email_search": {
      const query = args?.query || "";
      if (query) {
        return `Searching mail: ${query}`;
      }
      return "Searching mail…";
    }
    case "calendar_read":
      return "Reading calendar…";
    case "calendar_search": {
      const query = args?.query || "";
      if (query) {
        return `Searching calendar: ${query}`;
      }
      return "Searching calendar…";
    }
    case "calendar_event_read": {
      // Try to resolve actual event title using event_id (like markdown does)
      const eventId = args?.event_id || "";
      if (eventId) {
        try {
          const eventDetails = await resolveEventDetails(eventId);
          if (eventDetails && eventDetails.ok && eventDetails.title && eventDetails.title !== "(No title)") {
            log(`[TMDBG Tools] calendar_event_read activity: resolved title="${eventDetails.title}" for event_id=${eventId}`);
            return `Reading event: ${eventDetails.title}`;
          }
        } catch (e) {
          log(`[TMDBG Tools] calendar_event_read activity: failed to resolve title for event_id=${eventId}: ${e}`, "warn");
        }
      }
      // Fallback to args.title if provided (user-supplied filter)
      const title = args?.title || "";
      if (title) {
        return `Reading event: ${title}`;
      }
      // Don't show start_iso - just show generic message if we can't get the title
      return "Reading calendar entry…";
    }
    case "contacts_search": {
      const query = args?.query || "";
      if (query) {
        return `Searching contacts: ${query}`;
      }
      return "Searching contacts…";
    }
    case "contacts_add":
      return "Adding contact…";
    case "contacts_edit":
      return "Editing contact…";
    case "contacts_delete":
      return "Deleting contact…";
    case "calendar_event_create":
      return "Creating calendar event…";
    case "calendar_event_edit":
      return "Updating calendar event…";
    case "calendar_event_delete":
      return "Deleting calendar event…";
    case "email_delete":
      return "Deleting selected emails…";
    case "email_archive":
      return "Archiving selected emails…";
    case "email_move_to_inbox":
      return "Moving emails to inbox…";
    case "email_compose":
      return "Starting compose workflow…";
    case "email_forward":
      return "Starting forward workflow…";
    case "email_reply":
      return "Starting reply workflow…";
    case "kb_add":
      return "Updating knowledge base…";
    case "kb_del":
      return "Removing from knowledge base…";
    case "memory_search": {
      const query = args?.query || "";
      if (query) {
        return `Searching memory: ${query}`;
      }
      return "Searching memory…";
    }
    case "memory_read":
      return "Reading memory conversation…";
    case "web_read": {
      const url = args?.url || "";
      if (url) {
        return `Reading web: ${url}`;
      }
      return "Reading web content…";
    }
    case "reminder_add":
      return "Adding reminder…";
    case "reminder_del":
      return "Removing reminder…";
    case "change_setting":
      return "Updating setting…";
    default:
      log(`[TMDBG Tools] Missing activity label for tool '${name}'`);
      return "Thinking…";
  }
}

export async function executeToolByName(name, args = {}, options = {}) {
  const impl = TOOL_IMPL[name];
  if (!impl || typeof impl.run !== "function") {
    log(`[TMDBG Tools] Unknown tool requested: ${name}`);
    return { error: `unknown tool: ${name}` };
  }

  try {
    // FSM tools: fire-and-forget execution. Return metadata so caller can wait.
    if (isFsmTool(name)) {
      // --- Consecutive FSM Tool Detection ---
      // Check if we're trying to run an FSM tool when the previous tool in this chain
      // was also an FSM tool. This is often an error pattern and requires user confirmation.
      // Reset happens ONLY at the start of a new user turn (via resetFsmChainTracking).
      
      if (_lastFsmToolInChain !== null) {
        const prevTool = _lastFsmToolInChain;
        const prevArgs = _lastFsmToolArgs;
        log(`[TMDBG Tools] Consecutive FSM tool detected: previous='${prevTool}', current='${name}'`, "warn");
        
        // Format args for inclusion in error message
        let prevArgsStr = "";
        let currentArgsStr = "";
        try {
          prevArgsStr = JSON.stringify(prevArgs, null, 2);
        } catch (e) {
          prevArgsStr = String(prevArgs);
        }
        try {
          currentArgsStr = JSON.stringify(args, null, 2);
        } catch (e) {
          currentArgsStr = String(args);
        }
        
        // Build descriptive error message for the LLM
        const errorMessage = `ERROR: Consecutive FSM tool calls are not allowed.\n\n` +
          `PREVIOUS FSM tool '${prevTool}' was just executed with arguments:\n${prevArgsStr}\n\n` +
          `CURRENT FSM tool '${name}' was requested with arguments:\n${currentArgsStr}\n\n` +
          `This is often an error pattern. ` +
          `Verify first that this new FSM tool call is correct and necessary. ` +
          `If correct, you MUST first confirm with the user before proceeding. ` +
          `Ask the user for clarifications or confirmation before calling ${name} again. ` +
          `For example, something like, "Okay, I sent the first email successfully, should I move on to the next email?" ` +
          `You MUST pay attention to the first execution outcome -- if it was successful, you MUST respond to the user ` +
          `with a message that confirms the success, so that in the subsequent conversation you will NOT be confused ` +
          `and move onto the next tool call.`;
        
        return { 
          error: errorMessage,
          ok: false,
          consecutiveFsmBlocked: true,
          previousFsmTool: prevTool,
          previousFsmArgs: prevArgs,
          blockedFsmTool: name,
          blockedArgs: args
        };
      }
      
      // Update chain tracking BEFORE running the FSM tool
      // This ensures that even if the FSM fails (user closes window, says no, etc.),
      // we still block subsequent FSM tool calls in the same chain.
      // Only synchronous validation/malformed errors should allow retry.
      const previousFsmTool = _lastFsmToolInChain;
      const previousFsmArgs = _lastFsmToolArgs;
      _lastFsmToolInChain = name;
      _lastFsmToolArgs = args;
      log(`[TMDBG Tools] FSM chain tracking updated BEFORE execution: lastFsmTool='${name}'`);
      
      const startedAt = Date.now();
      try {
        await impl.run(args, options);
      } catch (e) {
        // Synchronous failure (validation, malformed args, etc.)
        // REVERT chain tracking to allow retry for genuine errors
        log(`[TMDBG Tools] FSM tool '${name}' synchronous failure: ${e}`, "error");
        log(`[TMDBG Tools] Reverting FSM chain tracking due to synchronous error`);
        _lastFsmToolInChain = previousFsmTool;
        _lastFsmToolArgs = previousFsmArgs;
        return { error: String(e || "fsm tool error") };
      }
      
      // FSM tool started successfully (compose window opened, waiting for user, etc.)
      // Chain tracking already set above - leave it in place
      
      const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
      return { fsm: true, tool: name, pid, startedAt };
    }

    // Non-FSM tools run synchronously and return their result
    const result = await impl.run(args, options);
    return result;
  } catch (e) {
    log(`[TMDBG Tools] Tool '${name}' threw: ${e}`, "error");
    return { error: String(e || "tool error") };
  }
}

// Allow conversation code to reset pagination state across all tools at the start
// of a new user turn, so that repeated calls with identical args within a turn
// advance pages, but a new turn starts fresh.
export function resetToolPaginationSessions() {
  try {
    for (const [name, impl] of Object.entries(TOOL_IMPL)) {
      if (impl && typeof impl.resetPaginationSessions === "function") {
        impl.resetPaginationSessions();
      }
    }
    log("[TMDBG Tools] Pagination sessions reset across tools");
  } catch (e) {
    log(`[TMDBG Tools] resetToolPaginationSessions failed: ${e}`, "warn");
  }
}

// Reset FSM chain tracking at the start of a new user turn.
// This allows FSM tools to be called again after user confirmation.
export function resetFsmChainTracking() {
  try {
    const prevTool = _lastFsmToolInChain;
    _lastFsmToolInChain = null;
    _lastFsmToolArgs = null;
    if (prevTool) {
      log(`[TMDBG Tools] FSM chain tracking reset (was: '${prevTool}')`);
    } else {
      log("[TMDBG Tools] FSM chain tracking reset (was empty)");
    }
  } catch (e) {
    log(`[TMDBG Tools] resetFsmChainTracking failed: ${e}`, "warn");
  }
}

/**
 * Execute tool calls without UI (headless mode).
 * For use in non-conversational flows like compose, precache, batch processing.
 * Returns results in the format expected by sendChatWithTools callback.
 * 
 * Note: FSM tools are blocked in headless mode as they require UI interaction.
 * 
 * @param {Array} toolCalls - Array of {id, function: {name, arguments}} from backend
 * @param {Object} tokenUsage - Token usage info (logged but not displayed)
 * @returns {Promise<Array>} - Array of {call_id, output} results
 */
export async function executeToolsHeadless(toolCalls, tokenUsage, idContext) {
  log(`[Tools Headless] Executing ${toolCalls.length} tool(s)${idContext ? ' (scoped ctx)' : ''}`);
  
  if (tokenUsage) {
    const used = tokenUsage.total_tokens || 0;
    const limit = tokenUsage.context_limit || 0;
    const pct = tokenUsage.usage_percentage || 0;
    log(`[Tools Headless] Token usage: ${used}/${limit} (${pct}%)`);
  }
  
  const results = [];
  
  for (const tc of toolCalls) {
    // Extract call ID (tc.id is the standard format from backend)
    const callId = tc.id;
    
    // Extract function details (standard OpenAI tool call format)
    const func = tc.function || {};
    const name = func.name;
    const argsJson = func.arguments || "{}";
    
    log(`[Tools Headless] Tool call: name=${name}, callId=${callId}, argsJson=${argsJson}`);
    
    // Parse arguments from JSON string
    let args = {};
    try {
      args = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson;
    } catch (e) {
      log(`[Tools Headless] Failed to parse args for ${name}: ${e}`, "warn");
      args = {};
    }
    
    // Block FSM tools in headless mode - they require UI interaction
    if (isFsmTool(name)) {
      log(`[Tools Headless] Skipping FSM tool '${name}' - requires UI interaction`, "warn");
      results.push({
        call_id: callId,
        output: JSON.stringify({ 
          error: `Tool '${name}' requires user interaction and cannot run in headless mode`,
          ok: false 
        }),
      });
      continue;
    }
    
    // ID Translation: Convert numeric IDs to real IDs before tool execution
    let processedArgs = args;
    try {
      const { processToolCallLLMtoTB } = await import("../modules/idTranslator.js");
      processedArgs = processToolCallLLMtoTB(name, args, idContext);
      log(`[Tools Headless] ID translation applied for ${name}`);
    } catch (e) {
      log(`[Tools Headless] ID translation failed, using original args: ${e}`, "warn");
    }
    
    log(`[Tools Headless] Executing: ${name} with args: ${JSON.stringify(processedArgs)}`);
    const startTime = Date.now();
    
    try {
      const result = await executeToolByName(name, processedArgs);
      const elapsed = Date.now() - startTime;
      log(`[Tools Headless] Completed: ${name} (${elapsed}ms)`);

      // ID Translation: Convert real TB IDs in results to numeric IDs for LLM
      let processedResult = result;
      try {
        const { processToolResultTBtoLLM } = await import("../modules/idTranslator.js");
        processedResult = processToolResultTBtoLLM(result, idContext);
        log(`[Tools Headless] Result ID translation applied for ${name}`);
      } catch (e) {
        log(`[Tools Headless] Result ID translation failed, using original: ${e}`, "warn");
      }

      results.push({
        call_id: callId,
        output: JSON.stringify(processedResult),
      });
    } catch (e) {
      log(`[Tools Headless] Failed: ${name} - ${e}`, "error");
      results.push({
        call_id: callId,
        output: JSON.stringify({ error: String(e || "tool execution error"), ok: false }),
      });
    }
  }
  
  log(`[Tools Headless] Execution complete: ${results.length} result(s)`);
  return results;
}
