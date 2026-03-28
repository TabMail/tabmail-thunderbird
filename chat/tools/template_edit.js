// template_edit.js – edits an existing reply template (FSM tool)

// FSM tool — requires user confirmation before executing.
// Used by core.js to detect and block consecutive FSM calls (see BLOCK_CONSECUTIVE_FSM_CALLS).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { getTemplate } from "../../agent/modules/templateManager.js";

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] template_edit: Tool called with args: ${JSON.stringify(args)}`);

    try {
      requestAnimationFrame(() => {
        _runEditTemplate(args, options).catch((e) => {
          try { log(`[TMDBG Tools] template_edit scheduled run failed: ${e}`, "error"); } catch (_) {}
        });
      });
    } catch (e) {
      log(`[TMDBG Tools] template_edit: failed to schedule: ${e}`, "error");
    }

    const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
    return { fsm: true, tool: "template_edit", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] template_edit failed: ${e}`, "error");
    return { error: String(e || "unknown error in template_edit") };
  }
}

async function _runEditTemplate(args = {}, options = {}) {
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "template_edit";

  const pid = ctx.activeToolCallId || 0;

  // Initialize FSM session once at the top
  try {
    initFsmSession(pid, "template_edit");
    ctx.activePid = pid;
    ctx.awaitingPid = pid;
  } catch (_) {}

  // template_id comes as numeric ID from LLM — already resolved by idTranslator to real UUID
  const templateId = typeof args?.template_id === "string" ? args.template_id
    : typeof args?.template_id === "number" ? String(args.template_id) : "";

  if (!templateId) {
    try { ctx.fsmSessions[pid].failReason = "Template ID is required."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  // Look up template
  const template = await getTemplate(templateId);
  if (!template || template.deleted) {
    try { ctx.fsmSessions[pid].failReason = `Template not found with ID: ${templateId}`; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  // Build updates object — only include fields that were actually provided
  const updates = {};
  if (typeof args?.name === "string" && args.name.trim()) updates.name = args.name.trim();
  if (Array.isArray(args?.instructions)) {
    updates.instructions = args.instructions.filter((s) => typeof s === "string");
  }
  if (typeof args?.example_reply === "string") updates.exampleReply = args.example_reply;

  if (Object.keys(updates).length === 0) {
    try { ctx.fsmSessions[pid].failReason = "No changes provided. Specify at least one field to update (name, instructions, or example_reply)."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  try {
    ctx.fsmSessions[pid].editTemplateArgs = { templateId, updates, originalTemplate: template };
  } catch (_) {}

  ctx.state = "template_edit_list";

  // Record initial FSM state for prev-state tracking
  try {
    if (pid) ctx.fsmSessions[pid].fsmPrevState = "template_edit_list";
  } catch (_) {}

  const originalRequest = ctx.rawUserTexts[ctx.rawUserTexts.length - 1] || "";
  ctx.rawUserTexts.push(`Now help me edit a reply template according to my earlier request: ${originalRequest}`);

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] template_edit: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing edit preview...");
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
    log(`[TMDBG Tools] template_edit.completeExecution: failed – ${failReason}`);
    return { error: failReason };
  }

  if (prevState === "template_edit_exec" && sess?.editResult) {
    log(`[TMDBG Tools] template_edit.completeExecution: edited template successfully`);
    return {
      result: "Template updated successfully.",
      template_id: sess.editResult.id,
      template_name: sess.editResult.name,
    };
  }

  log(`[TMDBG Tools] template_edit.completeExecution: completed`);
  return { result: "Edit template workflow completed." };
}
