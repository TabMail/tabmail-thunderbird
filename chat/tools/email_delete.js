// email_delete.js – FSM tool to list + delete emails, with optional override IDs

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";

async function normalizeArgs(args = {}) {
  const a = args || {};
  const out = {};

  // Optional list of unique_ids to override tag-based listing
  if (Array.isArray(a.unique_ids)) {
    try {
      const { parseUniqueId, headerIDToWeID } = await import(
        "../../agent/modules/utils.js"
      );
      const resolvedIds = [];

      for (const uniqueId of a.unique_ids) {
        if (uniqueId && typeof uniqueId === "string") {
          log(
            `[TMDBG Tools] email_delete: Processing unique_id: '${uniqueId}'`
          );
          const parsed = parseUniqueId(uniqueId);
          const { weFolder, headerID } = parsed;
          log(
            `[TMDBG Tools] email_delete: Parsed to weFolder='${weFolder}' headerID='${headerID}'`
          );

          // Resolve headerID to internal weID
          const internalId = await headerIDToWeID(headerID, weFolder);
          log(
            `[TMDBG Tools] email_delete: headerIDToWeID returned: ${JSON.stringify(
              internalId
            )}`
          );
          if (internalId) {
            resolvedIds.push(internalId);
            log(
              `[TMDBG Tools] email_delete: Resolved unique_id '${uniqueId}' to ${internalId} internal ID`
            );
          } else {
            log(
              `[TMDBG Tools] email_delete: Failed to resolve unique_id '${uniqueId}'`,
              "warn"
            );
          }
        } else {
          log(
            `[TMDBG Tools] email_delete: Invalid unique_id: ${JSON.stringify(
              uniqueId
            )}`,
            "warn"
          );
        }
      }

      if (resolvedIds.length > 0) {
        out.internal_ids = resolvedIds;
        log(
          `[TMDBG Tools] email_delete: Resolved ${a.unique_ids.length} unique_ids to ${resolvedIds.length} total internal IDs`
        );
      }
    } catch (e) {
      log(
        `[TMDBG Tools] email_delete: Error resolving unique_ids: ${e}`,
        "error"
      );
    }
  }

  // Optional confirm flag (default false)
  if (typeof a.confirm === "boolean") {
    out.confirm = a.confirm;
  } else {
    out.confirm = false;
  }

  return out;
}

export async function run(args = {}, options = {}) {
  try {
    log(
      `[TMDBG Tools] email_delete: Tool called with args: ${JSON.stringify(
        args
      )}`
    );

    // Immediately schedule the actual routine to the next frame to let WS set up the waiter
    try {
      requestAnimationFrame(() => {
        _runDeleteEmails(args, options).catch((e) => {
          try {
            log(
              `[TMDBG Tools] email_delete scheduled run failed: ${e}`,
              "error"
            );
          } catch (_) {}
        });
      });
      log(
        `[TMDBG Tools] email_delete: scheduled _runDeleteEmails for next frame`
      );
    } catch (e) {
      log(
        `[TMDBG Tools] email_delete: failed to schedule _runDeleteEmails: ${e}`,
        "error"
      );
    }

    // Inform WS layer this is an FSM tool
    const pid =
      options && typeof options.callId === "string"
        ? options.callId
        : options.callId || null;
    return { fsm: true, tool: "email_delete", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] email_delete failed: ${e}`, "error");
    // For FSM tools, handle errors by setting fail state, not returning error objects
    const errorMsg = String(e || "unknown error in email_delete");
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) {
        ctx.fsmSessions[pid] = ctx.fsmSessions[pid] || {};
        ctx.fsmSessions[pid].failReason = errorMsg;
      }
    } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
  }
}

async function _runDeleteEmails(args = {}, options = {}) {
  const norm = await normalizeArgs(args);

  // Mark FSM context and enter initial state (FSM state name stays email_delete_list)
  try {
    ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null;
  } catch (_) {}
  ctx.toolExecutionMode = "email_delete";
  ctx.state = "email_delete_list";

  // Initialize FSM session and attach override if provided
  try {
    const pid = ctx.activeToolCallId || 0;
    if (pid) {
      // Initialize FSM session with system prompt
      initFsmSession(pid, "email_delete");

      // Attach override internal IDs if provided
      if (Array.isArray(norm.internal_ids) && norm.internal_ids.length > 0) {
        ctx.fsmSessions[pid].overrideInternalIds = norm.internal_ids.slice();
        log(
          `[TMDBG Tools] email_delete: Using override internal_ids count=${norm.internal_ids.length}`
        );
      } else {
        log(
          `[TMDBG Tools] email_delete: No override internal_ids provided; will use tag-based listing.`
        );
      }
      log(
        `[TMDBG Tools] email_delete: Initialized FSM session with system prompt for pid=${pid}`
      );
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
    }
  } catch (_) {}

  // Record that we entered the initial FSM state for this tool in session history
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    if (pid) {
      ctx.fsmSessions[pid].fsmPrevState = "email_delete_list";
    }
  } catch (_) {}

  // Use the agent bubble from wsTools
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(
      `[TMDBG Tools] email_delete: No agent bubble provided, creating fallback`,
      "warn"
    );
    agentBubble = await createNewAgentBubble("Preparing delete list...");
  }

  // Kick off FSM immediately now that waiter should be registered
  const core = await import("../fsm/core.js");
  await core.executeAgentAction();
}

// FSM tool completion handler – optional, report simple outcome
export async function completeExecution(currentState, prevState) {
  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const failReason =
    (pid &&
      ctx.fsmSessions &&
      ctx.fsmSessions[pid] &&
      ctx.fsmSessions[pid].failReason) ||
    "";
  if (failReason) {
    log(`[TMDBG Tools] email_delete.completeExecution: failed – ${failReason}`);
    return `Failed: ${failReason}`;
  }
  // If previous state was email_delete_execute, consider success
  if (prevState === "email_delete_execute") {
    log(`[TMDBG Tools] email_delete.completeExecution: deleted via FSM`);
    return "Selected emails deleted.";
  }
  log(`[TMDBG Tools] email_delete.completeExecution: completed`);
  return "Delete workflow completed.";
}

export function resetPaginationSessions() {}
