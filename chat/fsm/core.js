// core.js – central FSM controller & planner
// Thunderbird 140, MV3 compatible.

import { ctx } from "../modules/context.js";

import { runStateCreateCalendarEventExec, runStateCreateCalendarEventList } from "./calendarCreate.js";
import { runStateDeleteCalendarEventExec, runStateDeleteCalendarEventList } from "./calendarDelete.js";
import { runStateEditCalendarEventExec, runStateEditCalendarEventList } from "./calendarEdit.js";
import { runStateDeleteContactsExecute, runStateDeleteContactsList } from "./contactsDelete.js";
import { runStateArchiveExecute, runStateArchiveListEmails } from "./emailArchive.js";
import { runStateSendEmail, runStateSendEmailPreview, runStateSendEmailHeadless } from "./emailCompose.js";
import { runStateDeleteExecute, runStateDeleteListEmails } from "./emailDelete.js";
import { runStateExecFail, runStateExecSuccess } from "./fsmExec.js";

import { processJSONResponse, sendChat } from "../../agent/modules/llm.js";
import { log, saveChatLog } from "../../agent/modules/utils.js";

import { createNewAgentBubble } from "../chat.js";

// -------------------------------------------------------------
// executeAgentAction – public dispatcher
// -------------------------------------------------------------
export async function executeAgentAction() {
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? ctx.fsmSessions[pid] : null;
    console.log(`[TMDBG Core] - Previous state: ${sess?.fsmPrevState}`);
    console.log(`[TMDBG Core] - State: ${ctx.state}`);
  } catch (_) {
    console.log(`[TMDBG Core] - State: ${ctx.state}`);
  }

  // Update the previous state, except for plan_next_action,
  // which is not a real state but a pseudo-state required to handle the user
  // input and plan the next action.
  if (!["plan_next_action"].includes(ctx.state)) {
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].fsmPrevState = ctx.state;
      }
    } catch (_) {
    }
  }

  switch (ctx.state) {
    // -------- Plan next action (not an actionable LLM state) --------
    case "plan_next_action":
      await runStatePlanNextAction();
      break;
    // -------- Delete workflow states --------
    case "email_delete_list":
      await runStateDeleteListEmails();
      break;
    case "email_delete_execute":
      await runStateDeleteExecute();
      break;
    // -------- Calendar create workflow states --------
    case "calendar_event_create_list":
      await runStateCreateCalendarEventList();
      break;
    case "calendar_event_create_exec":
      await runStateCreateCalendarEventExec();
      break;
    // -------- Calendar delete workflow states --------
    case "calendar_event_delete_list":
      await runStateDeleteCalendarEventList();
      break;
    case "calendar_event_delete_exec":
      await runStateDeleteCalendarEventExec();
      break;
    // -------- Calendar edit workflow states --------
    case "calendar_event_edit_list":
      await runStateEditCalendarEventList();
      break;
    case "calendar_event_edit_exec":
      await runStateEditCalendarEventExec();
      break;
    // -------- Contacts delete workflow states --------
    case "contacts_delete_list":
      await runStateDeleteContactsList();
      break;
    case "contacts_delete_execute":
      await runStateDeleteContactsExecute();
      break;
    // -------- Archive workflow states --------
    case "email_archive_list":
      await runStateArchiveListEmails();
      break;
    case "email_archive_execute":
      await runStateArchiveExecute();
      break;
    // -------- Compose workflow states --------
    case "send_email":
      await runStateSendEmail();
      break;
    case "send_email_preview":
      await runStateSendEmailPreview();
      break;
    case "send_email_headless":
      await runStateSendEmailHeadless();
      break;
    // -------- FSM terminal states --------
    case "exec_success":
      await runStateExecSuccess();
      break;
    case "exec_fail":
      await runStateExecFail();
      break;

    default:
      log(`[TMDBG Core] Unknown state: ${ctx.state} – assuming exec_fail.`, "error");
      ctx.state = "exec_fail";
      await runStateExecFail();
      break;
  }
}

// -------------------------------------------------------------
// plan_next_action handler (previously plan.js)
// -------------------------------------------------------------
export async function runStatePlanNextAction() {
  const agentBubble = await createNewAgentBubble("Planning next moves...");

  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? ctx.fsmSessions[pid] : null;
    console.log(`[TMDBG Core] - Previous state: ${sess?.fsmPrevState}`);
  } catch (_) {
  }

  // Determine pid for planning – planner is ONLY used for FSM tools now
  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid && ctx.fsmSessions ? ctx.fsmSessions[pid] : null;
  if (!pid || !sess) {
    log(`[TMDBG Core] plan_next_action without active FSM session – forcing exec_fail`, "error");
    ctx.state = "exec_fail";
    try { if (pid) ctx.fsmSessions[pid].failReason = "FSM planner invoked without active session"; } catch (_) {}
    agentBubble.classList.remove("loading");
    agentBubble.remove();
    return executeAgentAction();
  }

  // Build single consolidated message that backend will process
  const systemMsg = {
    role: "system",
    content: "system_prompt_fsm",
    prev_state: sess.fsmPrevState || null,
    user_input: sess.fsmUserInput || null,
  };

  let assistantResp = "";
  let parsedResp = null;
  try {
    // We are now FSM-only, so we use sendChat without tools and also no session_id
    assistantResp = (await sendChat([systemMsg])) || "(No response)";
    saveChatLog(
      "tabmail_chatwindow_plannextaction",
      Date.now(),
      [systemMsg],
      assistantResp
    );
    parsedResp = processJSONResponse(assistantResp);
  } catch (e) {
    log(`[TMDBG Core] sendChat failed: ${e}`, "error");
  }

  agentBubble.classList.remove("loading");
  agentBubble.remove();

  // Branching is FSM-only now; honour exec_fail justification, otherwise follow action
  if (parsedResp && parsedResp.action === "exec_fail") {
    ctx.state = "exec_fail";
    try { ctx.fsmSessions[pid].failReason = parsedResp.justification || parsedResp.reason || "FSM planner moved to exec_fail"; } catch (_) {}
  } else if (parsedResp && typeof parsedResp.action === "string" && parsedResp.action) {
    ctx.state = parsedResp.action;
  } else {
    ctx.state = "exec_fail";
    try { ctx.fsmSessions[pid].failReason = "FSM planner returned no actionable state"; } catch (_) {}
  }
  ctx.fsmSessions[pid].fsmPrevState = ctx.state;

  executeAgentAction();
}

// -------------------------------------------------------------
// Re-export entry points for UI
// -------------------------------------------------------------
export { processUserInput } from "../modules/converse.js";

