// template_share.js – shares a reply template to the public marketplace (FSM tool)

// FSM tool — requires user confirmation before executing.
// Used by core.js to detect and block consecutive FSM calls (see BLOCK_CONSECUTIVE_FSM_CALLS).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { getTemplate } from "../../agent/modules/templateManager.js";

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] template_share: Tool called with args: ${JSON.stringify(args)}`);

    try {
      requestAnimationFrame(() => {
        _runShareTemplate(args, options).catch((e) => {
          try { log(`[TMDBG Tools] template_share scheduled run failed: ${e}`, "error"); } catch (_) {}
        });
      });
    } catch (e) {
      log(`[TMDBG Tools] template_share: failed to schedule: ${e}`, "error");
    }

    const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
    return { fsm: true, tool: "template_share", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] template_share failed: ${e}`, "error");
    return { error: String(e || "unknown error in template_share") };
  }
}

async function _runShareTemplate(args = {}, options = {}) {
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "template_share";

  const pid = ctx.activeToolCallId || 0;

  // Initialize FSM session once at the top
  try {
    initFsmSession(pid, "template_share");
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

  // Validate that template has example_reply (required by marketplace)
  if (!template.exampleReply || !template.exampleReply.trim()) {
    try { ctx.fsmSessions[pid].failReason = "Template must have an example reply before sharing to the marketplace."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  const description = typeof args?.description === "string" ? args.description.trim() : "";
  const category = typeof args?.category === "string" ? args.category.trim() : "";
  const tags = Array.isArray(args?.tags)
    ? args.tags.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean)
    : [];

  try {
    ctx.fsmSessions[pid].shareTemplateArgs = {
      templateId,
      template,
      description,
      category,
      tags,
    };
  } catch (_) {}

  ctx.state = "template_share_list";

  // Record initial FSM state for prev-state tracking
  try {
    if (pid) ctx.fsmSessions[pid].fsmPrevState = "template_share_list";
  } catch (_) {}

  const originalRequest = ctx.rawUserTexts[ctx.rawUserTexts.length - 1] || "";
  ctx.rawUserTexts.push(`Now help me share a reply template to the marketplace according to my earlier request: ${originalRequest}`);

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] template_share: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing share preview...");
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
    log(`[TMDBG Tools] template_share.completeExecution: failed – ${failReason}`);
    return { error: failReason };
  }

  if (prevState === "template_share_exec" && sess?.shareResult) {
    log(`[TMDBG Tools] template_share.completeExecution: shared template successfully`);
    return {
      result: sess.shareResult.message || "Template submitted for review.",
      template_id: sess.shareResult.template_id,
      status: sess.shareResult.status,
    };
  }

  log(`[TMDBG Tools] template_share.completeExecution: completed`);
  return { result: "Share template workflow completed." };
}
