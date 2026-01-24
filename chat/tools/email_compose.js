// email_compose.js – tool to start compose workflow for creating a new email
// Thunderbird 140 MV3

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { initialiseEmailCompose } from "../modules/helpers.js";

export async function run(args = {}, options = {}) {
  try {
    log(
      `[TMDBG Tools] email_compose: Tool called with args: ${JSON.stringify(
        args
      )}`
    );
    try {
      requestAnimationFrame(() => {
        _runEmailCompose(args, options).catch((e) => {
          try {
            log(
              `[TMDBG Tools] email_compose scheduled run failed: ${e}`,
              "error"
            );
          } catch (_) {}
        });
      });
      log(
        `[TMDBG Tools] email_compose: scheduled _runEmailCompose for next frame`
      );
    } catch (e) {
      log(
        `[TMDBG Tools] email_compose: failed to schedule _runEmailCompose: ${e}`,
        "error"
      );
    }
    return "";
  } catch (e) {
    log(`[TMDBG Tools] email_compose failed: ${e}`, "error");
    // For FSM tools, handle errors by setting fail state, not returning error objects
    const errorMsg = String(e || "unknown error in email_compose tool");
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

async function _runEmailCompose(args = {}, options = {}) {
  // Mark FSM context using MCP tool call id when available and enter FSM state
  try {
    ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null;
  } catch (_) {}
  ctx.toolExecutionMode = "email_compose";
  ctx.state = "email_compose_start";
  // Initialize FSM session
  try {
    const pid = ctx.activeToolCallId || 0;
    if (pid) {
      initFsmSession(pid, "email_compose");
      log(
        `[TMDBG Tools] email_compose: Initialized FSM session for pid=${pid}`
      );
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
    }
  } catch (_) {}

  // Now do parameter validation within FSM context
  const recipientsRaw = args?.recipients ?? [];
  let recipients = Array.isArray(recipientsRaw) ? recipientsRaw : [];
  if (recipients.length === 0) {
    const errorMsg = `ERROR: recipients parameter is required and must contain at least one recipient`;
    log(`[TMDBG Tools] email_compose: ${errorMsg}`, "error");
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
    return;
  }

  const request = args?.request ?? "";
  if (!request || typeof request !== "string" || request.trim() === "") {
    const errorMsg = `ERROR: request parameter is required and must contain the content request for the email`;
    log(`[TMDBG Tools] email_compose: ${errorMsg}`, "error");
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
    return;
  }

  const { validateAndNormalizeRecipientSets } = await import(
    "../fsm/emailCompose.js"
  );
  const vr = await validateAndNormalizeRecipientSets(
    { recipients, cc: args?.cc, bcc: args?.bcc },
    { requireRecipients: true, prefix: "[TMDBG Tools] email_compose:" }
  );
  if (!vr || vr.ok === false) {
    const field = vr?.field || "recipients";
    const idx = typeof vr?.index === "number" ? ` at index ${vr.index}` : "";
    const errorMsg = `ERROR: ${vr?.message || `Invalid ${field}${idx}`}`;
    log(`[TMDBG Tools] email_compose: ${errorMsg}`, "error");
    ctx.state = "exec_fail";
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();
    return;
  }
  recipients = vr.recipients || [];
  const cc = vr.cc || [];
  const bcc = vr.bcc || [];

  log(
    `[TMDBG Tools] email_compose: Validation passed - Starting compose workflow with ${
      recipients.length
    } recipient(s) and request: "${request.substring(0, 100)}..."`
  );

  const ccProvided = Array.isArray(args?.cc);
  const bccProvided = Array.isArray(args?.bcc);
  const recipientsFormatted = recipients
    .map((r) => {
      const name = (r.name || "").trim();
      const email = (r.email || "").trim();
      return name ? `${name} <${email}>` : `<${email}>`;
    })
    .join(", ");

  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(
      `[TMDBG Tools] email_compose: No agent bubble provided, creating fallback`,
      "warn"
    );
    agentBubble = await createNewAgentBubble("Setting up compose...");
  }

  initialiseEmailCompose();
  ctx.composeDraft.recipients = recipients;
  if (ccProvided) {
    ctx.composeDraft.cc = cc;
    const ccFormatted = cc
      .map((r) => {
        const name = (r.name || "").trim();
        const email = (r.email || "").trim();
        return name ? `${name} <${email}>` : `<${email}>`;
      })
      .join(", ");
    log(
      `[TMDBG Tools] email_compose: CC provided with ${cc.length} recipient(s): ${ccFormatted}`
    );
  } else {
    try {
      log(`[TMDBG Tools] email_compose: No CC provided`);
    } catch (_) {}
  }
  if (bccProvided) {
    ctx.composeDraft.bcc = bcc;
    const bccFormatted = bcc
      .map((r) => {
        const name = (r.name || "").trim();
        const email = (r.email || "").trim();
        return name ? `${name} <${email}>` : `<${email}>`;
      })
      .join(", ");
    log(
      `[TMDBG Tools] email_compose: BCC provided with ${bcc.length} recipient(s): ${bccFormatted}`
    );
  } else {
    try {
      log(`[TMDBG Tools] email_compose: No BCC provided`);
    } catch (_) {}
  }

  // const composeRequest = `Compose new email to recipients: ${recipientsFormatted}. Content request: ${request.trim()}`;
  try {
    ctx.composeDraft.request = request.trim();
    log(
      `[TMDBG Tools] email_compose: Stored composeDraft.request: ${ctx.composeDraft.request}`
    );
  } catch (e) {
    log(
      `[TMDBG Tools] email_compose: Failed to store composeDraft.request: ${e}`,
      "warn"
    );
  }

  try {
    const { streamText } = await import("../modules/helpers.js");
    streamText(agentBubble, `Composing email to: ${recipientsFormatted}`);
  } catch (e) {
    agentBubble.textContent = `Composing email to: ${recipientsFormatted}`;
  }

  const { runComposeEdit } = await import("../../compose/modules/edit.js");
  const { saveChatLog } = await import("../../agent/modules/utils.js");
  const { subject, body, raw, messages } = await runComposeEdit({
    recipients: ctx.composeDraft.recipients || [],
    subject: ctx.composeDraft.subject,
    body: ctx.composeDraft.body,
    request: ctx.composeDraft.request,
    mode: "new",
  });
  saveChatLog(
    "tabmail_chatwindow_email_compose_email_edit",
    Date.now(),
    messages,
    raw
  );
  ctx.composeDraft.subject = subject;
  ctx.composeDraft.body = body;

  agentBubble.classList.remove("loading");
  ctx.state = "send_email";
  log(
    `[TMDBG Tools] email_compose: Switching to FSM compose workflow (send_email state)`
  );
  const core = await import("../fsm/core.js");
  await core.executeAgentAction();
}

// FSM tool completion handler - determines final result based on conversation history
export async function completeExecution(currentState, prevState) {
  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const failReason =
    (pid &&
      ctx.fsmSessions &&
      ctx.fsmSessions[pid] &&
      ctx.fsmSessions[pid].failReason) ||
    "";
  if (failReason) {
    log(
      `[TMDBG Tools] email_compose.completeExecution: failed – ${failReason}`
    );
    return `Failed: ${failReason}`;
  }
  log(`[TMDBG Tools] email_compose.completeExecution: sent`);
  return "Email sent successfully.";
}
