// template_create.js – creates a new reply template (FSM tool)

// FSM tool — requires user confirmation before executing.
// Used by core.js to detect and block consecutive FSM calls (see BLOCK_CONSECUTIVE_FSM_CALLS).
export const fsm = true;

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] template_create: Tool called with args: ${JSON.stringify(args)}`);

    // Schedule actual routine to next frame to let WS set up the waiter
    try {
      requestAnimationFrame(() => {
        _runCreateTemplate(args, options).catch((e) => {
          try { log(`[TMDBG Tools] template_create scheduled run failed: ${e}`, "error"); } catch (_) {}
        });
      });
      log(`[TMDBG Tools] template_create: scheduled _runCreateTemplate for next frame`);
    } catch (e) {
      log(`[TMDBG Tools] template_create: failed to schedule: ${e}`, "error");
    }

    const pid = options && typeof options.callId === "string" ? options.callId : options.callId || null;
    return { fsm: true, tool: "template_create", pid, startedAt: Date.now() };
  } catch (e) {
    log(`[TMDBG Tools] template_create failed: ${e}`, "error");
    return { error: String(e || "unknown error in template_create") };
  }
}

async function _runCreateTemplate(args = {}, options = {}) {
  try { ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null; } catch (_) {}
  ctx.toolExecutionMode = "template_create";

  const pid = ctx.activeToolCallId || 0;

  // Initialize FSM session once at the top
  try {
    initFsmSession(pid, "template_create");
    ctx.activePid = pid;
    ctx.awaitingPid = pid;
  } catch (_) {}

  const name = typeof args?.name === "string" ? args.name.trim() : "";
  if (!name) {
    log("[TMDBG Tools] template_create: name is required", "error");
    try { ctx.fsmSessions[pid].failReason = "Template name is required."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }

  const instructions = Array.isArray(args?.instructions)
    ? args.instructions.filter((s) => typeof s === "string")
    : [];
  const exampleReply = typeof args?.example_reply === "string" ? args.example_reply : "";

  const createArgs = { name, instructions, exampleReply };

  try {
    ctx.fsmSessions[pid].createTemplateArgs = createArgs;
  } catch (_) {}

  ctx.state = "template_create_list";

  // Record initial FSM state for prev-state tracking
  try {
    if (pid) ctx.fsmSessions[pid].fsmPrevState = "template_create_list";
  } catch (_) {}

  // Establish FSM marker in chat history
  const originalRequest = ctx.rawUserTexts[ctx.rawUserTexts.length - 1] || "";
  const fakeUserText = `Now help me create a reply template according to my earlier request: ${originalRequest}`;
  ctx.rawUserTexts.push(fakeUserText);

  // Use the agent bubble from tool orchestration
  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(`[TMDBG Tools] template_create: No agent bubble provided, creating fallback`, "warn");
    agentBubble = await createNewAgentBubble("Preparing template details...");
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
    log(`[TMDBG Tools] template_create.completeExecution: failed – ${failReason}`);
    return { error: failReason };
  }

  if (prevState === "template_create_exec" && sess?.createResult) {
    log(`[TMDBG Tools] template_create.completeExecution: created template successfully`);
    return {
      result: "Template created successfully.",
      template_id: sess.createResult.id,
      template_name: sess.createResult.name,
    };
  }

  log(`[TMDBG Tools] template_create.completeExecution: completed`);
  return { result: "Create template workflow completed." };
}
