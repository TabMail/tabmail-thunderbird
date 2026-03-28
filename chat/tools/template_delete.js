// template_delete.js – deletes a reply template (FSM tool)

// FSM tool — requires user confirmation before executing.
// Used by core.js to detect and block consecutive FSM calls (see BLOCK_CONSECUTIVE_FSM_CALLS).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { getTemplate } from "../../agent/modules/templateManager.js";

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] template_delete: Tool called with args: ${JSON.stringify(args)}`);

    try {
      requestAnimationFrame(() => {
        _runDeleteTemplate(args, options).catch((e) => {
          try { log(`[TMDBG Tools] template_delete scheduled run failed: ${e}`, "error"); } catch (_) {}
        });
      });
    } catch (e) {
      log(`[TMDBG Tools] template_delete: failed to schedule: ${e}`, "error");
    }

    const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
    return { fsm: true, tool: "template_delete", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] template_delete failed: ${e}`, "error");
    return { error: String(e || "unknown error in template_delete") };
  }
}

async function _runDeleteTemplate(args = {}, options = {}) {
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "template_delete";

  const pid = ctx.activeToolCallId || 0;

  // Initialize FSM session once at the top
  try {
    initFsmSession(pid, "template_delete");
    ctx.activePid = pid;
    ctx.awaitingPid = pid;
  } catch (_) {}

  const templateId = typeof args?.template_id === "string" ? args.template_id
    : typeof args?.template_id === "number" ? String(args.template_id) : "";

  if (!templateId) {
    try { ctx.fsmSessions[pid].failReason = "Template ID is required."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  const template = await getTemplate(templateId);
  if (!template || template.deleted) {
    try { ctx.fsmSessions[pid].failReason = `Template not found with ID: ${templateId}`; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  try {
    ctx.fsmSessions[pid].deleteTemplateArgs = { templateId, template };
  } catch (_) {}

  ctx.state = "template_delete_list";

  // Record initial FSM state for prev-state tracking
  try {
    if (pid) ctx.fsmSessions[pid].fsmPrevState = "template_delete_list";
  } catch (_) {}

  const originalRequest = ctx.rawUserTexts[ctx.rawUserTexts.length - 1] || "";
  ctx.rawUserTexts.push(`Now help me delete a reply template according to my earlier request: ${originalRequest}`);

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] template_delete: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing delete preview...");
  }

  const core = await import("../fsm/core.js");
  await core.executeAgentAction();
}

export function resetPaginationSessions() {}

export async function completeExecution(currentState, prevState) {
  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid && ctx.fsmSessions && ctx.fsmSessions[pid] ? ctx.fsmSessions[pid] : null;
  const failReason = sess?.failReason || "";

  if (failReason) {
    log(`[TMDBG Tools] template_delete.completeExecution: failed – ${failReason}`);
    return { error: failReason };
  }

  if (prevState === "template_delete_exec" && sess?.deleteResult) {
    log(`[TMDBG Tools] template_delete.completeExecution: deleted template successfully`);
    return {
      result: "Template deleted successfully.",
      template_name: sess.deleteResult.name,
    };
  }

  log(`[TMDBG Tools] template_delete.completeExecution: completed`);
  return { result: "Delete template workflow completed." };
}
