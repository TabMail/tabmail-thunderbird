// email_reply.js – tool to start reply workflow for a specific email
// Thunderbird 140 MV3

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { initialiseEmailCompose } from "../modules/helpers.js";

export async function run(args = {}, options = {}) {
  try {
    log(
      `[TMDBG Tools] email_reply: Tool called with args: ${JSON.stringify(
        args
      )}`
    );
    try {
      requestAnimationFrame(() => {
        _runEmailReply(args, options).catch((e) => {
          try {
            log(
              `[TMDBG Tools] email_reply scheduled run failed: ${e}`,
              "error"
            );
          } catch (_) {}
        });
      });
      log(`[TMDBG Tools] email_reply: scheduled _runEmailReply for next frame`);
    } catch (e) {
      log(
        `[TMDBG Tools] email_reply: failed to schedule _runEmailReply: ${e}`,
        "error"
      );
    }
    return "";
  } catch (e) {
    log(`[TMDBG Tools] email_reply failed: ${e}`, "error");
    // For FSM tools, handle errors by setting fail state, not returning error objects
    const errorMsg = String(e || "unknown error in email_reply tool");

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

async function _runEmailReply(args = {}, options = {}) {
  // Mark FSM context using MCP tool call id when available and enter FSM state
  try {
    ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null;
  } catch (_) {}
  ctx.toolExecutionMode = "email_reply";
  ctx.state = "email_reply_start";
  // Initialize FSM session
  try {
    const pid = ctx.activeToolCallId || 0;
    if (pid) {
      initFsmSession(pid, "email_reply");
      log(`[TMDBG Tools] email_reply: Initialized FSM session for pid=${pid}`);
      ctx.activePid = pid;
      ctx.awaitingPid = pid;
    }
  } catch (_) {}

  // Now do parameter validation within FSM context
  const uniqueId = args?.unique_id;

  if (!uniqueId || typeof uniqueId !== "string") {
    log(
      `[TMDBG Tools] email_reply: invalid or missing unique_id: ${uniqueId}`,
      "error"
    );
    const errorMsg = "Invalid or missing unique_id parameter";

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

  // Parse unique_id to extract weFolder and headerID
  const { parseUniqueId } = await import("../../agent/modules/utils.js");
  const parsed = parseUniqueId(uniqueId);
  const { weFolder, headerID } = parsed;

  if (!headerID) {
    log(
      `[TMDBG Tools] email_reply: empty headerID in unique_id: ${uniqueId}`,
      "error"
    );
    const errorMsg = "Empty headerID in unique_id";

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

  // Resolve headerID to internal weID
  const { headerIDToWeID } = await import("../../agent/modules/utils.js");
  const internalId = await headerIDToWeID(headerID, weFolder);
  if (!internalId) {
    log(
      `[TMDBG Tools] email_reply: Failed to resolve headerID '${headerID}' to internal ID`,
      "error"
    );
    const errorMsg = `Could not find email with unique ID: ${uniqueId}`;

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

  log(
    `[TMDBG Tools] email_reply: Resolved uniqueId '${uniqueId}' to internal ID ${internalId}`
  );

  const request = args?.request ?? "";
  const requestProvided = typeof request === "string" && request.trim() !== "";
  log(
    `[TMDBG Tools] email_reply: Request parameter provided: ${requestProvided}, content length: ${request.length}`
  );

  const recipientsRaw = args?.recipients;
  let recipientsProvided = typeof recipientsRaw !== "undefined";
  let recipients = [];
  if (recipientsProvided) {
    if (!Array.isArray(recipientsRaw) || recipientsRaw.length === 0) {
      const errorMsg = `ERROR: recipients parameter was provided but is invalid or empty array ${recipientsRaw}`;
      log(`[TMDBG Tools] email_reply: ${errorMsg}`, "error");

      ctx.state = "exec_fail";
      const core = await import("../fsm/core.js");
      await core.executeAgentAction();
      return;
    }
    for (let i = 0; i < recipientsRaw.length; i++) {
      const recipient = recipientsRaw[i];
      if (!recipient || typeof recipient !== "object" || !recipient.email) {
        const errorMsg = `ERROR: recipient at index ${i} is missing required email field`;
        log(`[TMDBG Tools] email_reply: ${errorMsg}`, "error");

        ctx.state = "exec_fail";
        const core = await import("../fsm/core.js");
        await core.executeAgentAction();
        return;
      }
    }
    recipients = recipientsRaw;
  }

  if (!Number.isFinite(internalId)) {
    const errorMsg = `ERROR: invalid or missing internal_id: ${internalIdRaw}`;
    log(`[TMDBG Tools] email_reply: ${errorMsg}`, "error");

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

  log(
    `[TMDBG Tools] email_reply: Validation passed - Starting reply workflow for email ID ${internalId}`
  );

  let emailSubject = "(No subject)";
  try {
    const header = await browser.messages.get(internalId);
    if (!header) {
      const errorMsg = `ERROR: Email with ID ${internalId} not found`;
      log(`[TMDBG Tools] email_reply: ${errorMsg}`, "error");

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

    emailSubject = header.subject || "(No subject)";
    log(`[TMDBG Tools] email_reply: Successfully fetched email directly by ID`);
  } catch (e) {
    const errorMsg = `ERROR: Failed to access email with ID ${internalId}: ${e}`;
    log(`[TMDBG Tools] email_reply: ${errorMsg}`, "error");

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

  log(
    `[TMDBG Tools] email_reply: Found target email - Subject: "${emailSubject}"`
  );

  let agentBubble = options.agentBubble;
  if (!agentBubble) {
    log(
      `[TMDBG Tools] email_reply: No agent bubble provided, creating fallback`,
      "warn"
    );
    agentBubble = await createNewAgentBubble("Setting up reply...");
  }

  initialiseEmailCompose();
  ctx.composeDraft.replyToId = internalId;

  if (
    recipientsProvided ||
    typeof args?.cc !== "undefined" ||
    typeof args?.bcc !== "undefined"
  ) {
    const { validateAndNormalizeRecipientSets } = await import(
      "../fsm/emailCompose.js"
    );
    const vr = await validateAndNormalizeRecipientSets(
      { recipients, cc: args?.cc, bcc: args?.bcc },
      { requireRecipients: false, prefix: "[TMDBG Tools] email_reply:" }
    );
    if (!vr || vr.ok === false) {
      const field = vr?.field || "recipients";
      const idx = typeof vr?.index === "number" ? ` at index ${vr.index}` : "";
      const errorMsg = `ERROR: ${vr?.message || `Invalid ${field}${idx}`}`;
      log(`[TMDBG Tools] email_reply: ${errorMsg}`, "error");

      ctx.state = "exec_fail";
      const core = await import("../fsm/core.js");
      await core.executeAgentAction();
      return;
    }
    recipients = vr.recipients || [];
    const cc = vr.cc || [];
    const bcc = vr.bcc || [];

    if (recipientsProvided) {
      ctx.composeDraft.recipients = recipients;
      const recipientsFormatted = recipients
        .map((r) => {
          const name = (r.name || "").trim();
          const email = (r.email || "").trim();
          return name ? `${name} <${email}>` : `<${email}>`;
        })
        .join(", ");
      log(
        `[TMDBG Tools] email_reply: Recipients override provided for reply: ${recipientsFormatted}`
      );
    }
    if (Array.isArray(args?.cc)) {
      ctx.composeDraft.cc = cc;
      const ccFormatted = cc
        .map((r) => {
          const name = (r.name || "").trim();
          const email = (r.email || "").trim();
          return name ? `${name} <${email}>` : `<${email}>`;
        })
        .join(", ");
      log(`[TMDBG Tools] email_reply: CC provided for reply: ${ccFormatted}`);
    }
    if (Array.isArray(args?.bcc)) {
      ctx.composeDraft.bcc = bcc;
      const bccFormatted = bcc
        .map((r) => {
          const name = (r.name || "").trim();
          const email = (r.email || "").trim();
          return name ? `${name} <${email}>` : `<${email}>`;
        })
        .join(", ");
      log(`[TMDBG Tools] email_reply: BCC provided for reply: ${bccFormatted}`);
    }
  }

  if (requestProvided) {
    try {
      const replyRequest = `Reply to email with subject "${emailSubject}" with request: ${request.trim()}`;
      ctx.composeDraft.request = replyRequest;
      log(
        `[TMDBG Tools] email_reply: Stored composeDraft.request: ${ctx.composeDraft.request}`
      );
    } catch (e) {
      log(
        `[TMDBG Tools] email_reply: Failed to store composeDraft.request: ${e}`,
        "warn"
      );
    }
  }
  try {
    const { streamText } = await import("../modules/helpers.js");
    const suffix = recipientsProvided ? " (with recipient edits)" : "";
    streamText(agentBubble, `Composing reply for: "${emailSubject}"${suffix}`);
  } catch (e) {
    const suffix = recipientsProvided ? " (with recipient edits)" : "";
    agentBubble.textContent = `Composing reply for: "${emailSubject}"${suffix}`;
  }
  const { runComposeEdit } = await import("../../compose/modules/edit.js");
  const { saveChatLog } = await import("../../agent/modules/utils.js");
  const { subject, body, raw, messages } = await runComposeEdit({
    recipients: ctx.composeDraft.recipients || [],
    subject: ctx.composeDraft.subject,
    body: ctx.composeDraft.body,
    request: ctx.composeDraft.request,
    relatedEmailId: internalId,
    mode: "reply",
  });
  saveChatLog(
    "tabmail_chatwindow_compose_email_edit",
    Date.now(),
    messages,
    raw
  );
  ctx.composeDraft.subject = subject;
  ctx.composeDraft.body = body;

  agentBubble.classList.remove("loading");
  ctx.state = "send_email";

  log(
    `[TMDBG Tools] email_reply: Switching to FSM reply workflow (send_email state)`
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
    log(`[TMDBG Tools] email_reply.completeExecution: failed – ${failReason}`);
    return `Failed: ${failReason}`;
  }
  log(`[TMDBG Tools] email_reply.completeExecution: sent`);
  return "Email sent successfully.";
}
