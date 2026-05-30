/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
import * as taskAddTool from "./task_add.js";
import * as taskDelTool from "./task_del.js";
import * as taskEditTool from "./task_edit.js";
import * as changeSettingTool from "./change_setting.js";
import * as templateReadTool from "./template_read.js";
import * as templateCreateTool from "./template_create.js";
import * as templateEditTool from "./template_edit.js";
import * as templateDeleteTool from "./template_delete.js";
import * as templateShareTool from "./template_share.js";
import * as templateSearchTool from "./template_search.js";
import * as templateDownloadTool from "./template_download.js";
import * as templateToggleTool from "./template_toggle.js";

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
  task_add: taskAddTool,
  task_del: taskDelTool,
  task_edit: taskEditTool,
  change_setting: changeSettingTool,
  template_read: templateReadTool,
  template_create: templateCreateTool,
  template_edit: templateEditTool,
  template_delete: templateDeleteTool,
  template_share: templateShareTool,
  template_search: templateSearchTool,
  template_download: templateDownloadTool,
  template_toggle: templateToggleTool,
};

// Generic marker for server-side tools (backend sends this name)
const SERVER_SIDE_TOOL_NAME = "server_side_tool";

export function isFsmTool(toolName) {
  try {
    const impl = TOOL_IMPL[toolName];
    return !!(impl && impl.fsm === true);
  } catch (_) {
    return false;
  }
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
    case "task_add":
      return "Scheduling task…";
    case "task_del":
      return "Removing scheduled task…";
    case "task_edit":
      return "Updating scheduled task…";
    case "change_setting":
      return "Updating setting…";
    case "template_read":
      return "Reading template…";
    case "template_create":
      return "Creating template…";
    case "template_edit":
      return "Editing template…";
    case "template_delete":
      return "Deleting template…";
    case "template_share":
      return "Sharing template…";
    case "template_download":
      return "Downloading template…";
    case "template_toggle":
      return "Toggling template…";
    case "template_search": {
      const query = args?.query || "";
      if (query) {
        return `Searching templates: ${query}`;
      }
      return "Searching templates…";
    }
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
    // The LLM now receives the full reasoning + prior tool-call results in its
    // context, so the previous "block consecutive FSM" guard is redundant —
    // it caused more harm than good (failed FSM calls were treated as
    // "executed" and blocked legitimate retries). Run the tool unconditionally
    // and let the LLM use the returned result to decide what to do next.
    let result;
    try {
      result = await impl.run(args, options);
    } catch (e) {
      return { error: String(e || "tool error") };
    }
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

/**
 * Execute tool calls without UI (headless mode).
 * For use in non-conversational flows like compose, precache, batch processing.
 * Returns results in the format expected by sendChat's onToolExecution callback.
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
