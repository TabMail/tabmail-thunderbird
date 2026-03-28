// template_download.js – downloads a marketplace template and installs it locally (FSM tool)

// FSM tool — requires user confirmation before executing.
// Used by core.js to detect and block consecutive FSM calls (see BLOCK_CONSECUTIVE_FSM_CALLS).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] template_download: Tool called with args: ${JSON.stringify(args)}`);

    try {
      requestAnimationFrame(() => {
        _runDownloadTemplate(args, options).catch((e) => {
          try { log(`[TMDBG Tools] template_download scheduled run failed: ${e}`, "error"); } catch (_) {}
        });
      });
    } catch (e) {
      log(`[TMDBG Tools] template_download: failed to schedule: ${e}`, "error");
    }

    const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
    return { fsm: true, tool: "template_download", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] template_download failed: ${e}`, "error");
    return { error: String(e || "unknown error in template_download") };
  }
}

async function _runDownloadTemplate(args = {}, options = {}) {
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "template_download";

  const pid = ctx.activeToolCallId || 0;

  // Initialize FSM session once at the top
  try {
    initFsmSession(pid, "template_download");
    ctx.activePid = pid;
    ctx.awaitingPid = pid;
  } catch (_) {}

  // template_id is already resolved by idTranslator from numeric to real UUID
  const templateId = typeof args?.template_id === "string" ? args.template_id
    : typeof args?.template_id === "number" ? String(args.template_id) : "";

  if (!templateId) {
    try { ctx.fsmSessions[pid].failReason = "Template ID is required."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  try {
    ctx.fsmSessions[pid].downloadTemplateArgs = { templateId };
  } catch (_) {}

  ctx.state = "template_download_list";

  // Record initial FSM state for prev-state tracking
  try {
    if (pid) ctx.fsmSessions[pid].fsmPrevState = "template_download_list";
  } catch (_) {}

  const originalRequest = ctx.rawUserTexts[ctx.rawUserTexts.length - 1] || "";
  ctx.rawUserTexts.push(`Now help me download a template from the marketplace according to my earlier request: ${originalRequest}`);

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] template_download: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing download...");
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
    log(`[TMDBG Tools] template_download.completeExecution: failed – ${failReason}`);
    return { error: failReason };
  }

  if (prevState === "template_download_exec" && sess?.downloadResult) {
    log(`[TMDBG Tools] template_download.completeExecution: downloaded template successfully`);
    return {
      result: "Template downloaded and installed locally.",
      template_id: sess.downloadResult.id,
      template_name: sess.downloadResult.name,
    };
  }

  log(`[TMDBG Tools] template_download.completeExecution: completed`);
  return { result: "Download template workflow completed." };
}
