// email_forward.js – tool to start forward workflow for a specific email
// Thunderbird 140 MV3

import { log } from "../../agent/modules/utils.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx, initFsmSession } from "../modules/context.js";
import { initialiseEmailCompose } from "../modules/helpers.js";

export async function run(args = {}, options = {}) {
  try {
    log(
      `[TMDBG Tools] email_forward: Tool called with args: ${JSON.stringify(args)}`
    );
    try {
      requestAnimationFrame(() => {
        _runEmailForward(args, options).catch((e) => {
          try {
            log(`[TMDBG Tools] email_forward scheduled run failed: ${e}`, "error");
          } catch (_) {}
        });
      });
      log(`[TMDBG Tools] email_forward: scheduled _runEmailForward for next frame`);
    } catch (e) {
      log(
        `[TMDBG Tools] email_forward: failed to schedule _runEmailForward: ${e}`,
        "error"
      );
    }
    return "";
  } catch (e) {
    log(`[TMDBG Tools] email_forward failed: ${e}`, "error");
    // For FSM tools, handle errors by setting fail state, not returning error objects
    const errorMsg = String(e || "unknown error in email_forward tool");
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

async function _runEmailForward(args = {}, options = {}) {
  try {
    // Mark FSM context using MCP tool call id when available and enter FSM state
    try {
      ctx.activeToolCallId = options?.callId || ctx.activeToolCallId || null;
    } catch (_) {}
    ctx.toolExecutionMode = "email_forward";
    ctx.state = "email_forward_start";
    // Initialize FSM session
    try {
      const pid = ctx.activeToolCallId || 0;
      if (pid) {
        initFsmSession(pid, "email_forward");
        log(`[TMDBG Tools] email_forward: Initialized FSM session for pid=${pid}`);
        ctx.activePid = pid;
        ctx.awaitingPid = pid;
      }
    } catch (_) {}

    // Now do parameter validation within FSM context
    const uniqueId = args?.unique_id;
    
    if (!uniqueId || typeof uniqueId !== 'string') {
      const errorMsg = `ERROR: invalid or missing unique_id: ${uniqueId}`;
      log(`[TMDBG Tools] email_forward: ${errorMsg}`, "error");
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
    const { parseUniqueId, headerIDToWeID } = await import("../../agent/modules/utils.js");
    const parsed = parseUniqueId(uniqueId);
    const { weFolder, headerID } = parsed;
    
    // Resolve headerID to internal weID
    const internalId = await headerIDToWeID(headerID, weFolder);
    if (!internalId) {
      const errorMsg = `ERROR: Failed to resolve unique_id '${uniqueId}' to internal ID`;
      log(`[TMDBG Tools] email_forward: ${errorMsg}`, "error");

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

    log(`[TMDBG Tools] email_forward: Resolved unique_id '${uniqueId}' to internal ID ${internalId}`);

    const recipientsRaw = args?.recipients ?? [];
    let recipients = Array.isArray(recipientsRaw) ? recipientsRaw : [];
    if (recipients.length === 0) {
      const errorMsg = `ERROR: recipients parameter is required and must contain at least one recipient`;
      log(`[TMDBG Tools] email_forward: ${errorMsg}`, "error");

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
      const errorMsg = `ERROR: request parameter is required and must contain the content request for the forward`;
      log(`[TMDBG Tools] email_forward: ${errorMsg}`, "error");

      try {
        const pid = ctx.activePid || ctx.activeToolCallId || 0;
        if (pid) {
          ctx.fsmSessions[pid] = ctx.fsmSessions[pid] || {};
          ctx.fsmSessions[pid].failReason = errorMsg;
        }
      } catch (_) {}
      ctx.state = "agent_converse";
      const core = await import("../fsm/core.js");
      await core.executeAgentAction();
      return;
    }

    // Use shared validator/normalizer for recipients, cc, bcc
    const { validateAndNormalizeRecipientSets } = await import(
      "../fsm/emailCompose.js"
    );
    const vr = await validateAndNormalizeRecipientSets(
      { recipients, cc: args?.cc, bcc: args?.bcc },
      { requireRecipients: true, prefix: "[TMDBG Tools] email_forward:" }
    );
    if (!vr || vr.ok === false) {
      const field = vr?.field || "recipients";
      const idx = typeof vr?.index === "number" ? ` at index ${vr.index}` : "";
      const errorMsg = `ERROR: ${vr?.message || `Invalid ${field}${idx}`}`;
      log(`[TMDBG Tools] email_forward: ${errorMsg}`, "error");

      // Return to agent_converse so completeExecution can handle this properly
      ctx.state = "agent_converse";
      const core = await import("../fsm/core.js");
      await core.executeAgentAction();
      return errorMsg;
    }
    recipients = vr.recipients || [];
    const cc = vr.cc || [];
    const bcc = vr.bcc || [];

    log(
      `[TMDBG Tools] email_forward: Validation passed - Starting forward workflow for email with ${
        recipients.length
      } recipient(s) and request: "${request.substring(0, 100)}..."`
    );

    // Verify the email exists and get basic info
    let emailSubject = "(No subject)";
    try {
      const header = await browser.messages.get(internalId);
      if (!header) {
        const errorMsg = `ERROR: Email with ID ${internalId} not found`;
        log(`[TMDBG Tools] email_forward: ${errorMsg}`, "error");

        // Record validation failure in FSM conversation
        try {
          const pid = ctx.activePid || ctx.activeToolCallId || 0;
          if (pid) {
            ctx.fsmSessions[pid] = ctx.fsmSessions[pid] || {};
            ctx.fsmSessions[pid].failReason = errorMsg;
          }
        } catch (_) {}

        // Move to exec_fail state
        //
        // TODO: setup things properly for the exec_fail state to report what exactly went wrong. Also the return object here should just be ignored probably? unsure.
        ctx.state = "exec_fail";
        const core = await import("../fsm/core.js");
        await core.executeAgentAction();
        return errorMsg;
      }

      emailSubject = header.subject || "(No subject)";
      log(`[TMDBG Tools] email_forward: Successfully fetched email directly by ID`);
    } catch (e) {
      const errorMsg = `ERROR: Failed to access email with ID ${internalId}: ${e}`;
      log(`[TMDBG Tools] email_forward: ${errorMsg}`, "error");

      try {
        const pid = ctx.activePid || ctx.activeToolCallId || 0;
        if (pid) {
          ctx.fsmSessions[pid] = ctx.fsmSessions[pid] || {};
          ctx.fsmSessions[pid].failReason = errorMsg;
        }
      } catch (_) {}

      // Move to exec_fail state
      //
      // TODO: setup things properly for the exec_fail state to report what exactly went wrong. Also the return object here should just be ignored probably? unsure.
      ctx.state = "exec_fail";
      const core = await import("../fsm/core.js");
      await core.executeAgentAction();
      return errorMsg;
    }

    log(
      `[TMDBG Tools] email_forward: Found target email - Subject: "${emailSubject}"`
    );

    // Format recipients for logging and display
    const recipientsFormatted = recipients
      .map((r) => {
        const name = (r.name || "").trim();
        const email = (r.email || "").trim();
        return name ? `${name} <${email}>` : `<${email}>`;
      })
      .join(", ");

    // Use the agent bubble from converse.js instead of creating a new one
    let agentBubble = options.agentBubble;
    if (!agentBubble) {
      log(
        `[TMDBG Tools] email_forward: No agent bubble provided, creating fallback`,
        "warn"
      );
      agentBubble = await createNewAgentBubble("Setting up forward...");
    }

    // CC/BCC provided flags and values from shared validation
    const ccProvided = Array.isArray(args?.cc);
    const bccProvided = Array.isArray(args?.bcc);

    // Initialise compose for the upcoming workflow first
    initialiseEmailCompose();

    // Set the email for forwarding
    ctx.composeDraft.forwardOfId = internalId;

    // Set the recipients
    ctx.composeDraft.recipients = recipients;
    // Set CC if provided
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
        `[TMDBG Tools] email_forward: CC provided with ${cc.length} recipient(s): ${ccFormatted}`
      );
    } else {
      try {
        log(`[TMDBG Tools] email_forward: No CC provided`);
      } catch (_) {}
    }
    // Set BCC if provided
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
        `[TMDBG Tools] email_forward: BCC provided with ${bcc.length} recipient(s): ${bccFormatted}`
      );
    } else {
      try {
        log(`[TMDBG Tools] email_forward: No BCC provided`);
      } catch (_) {}
    }

    // Store the request
    const forwardRequest = `Forward email with subject "${emailSubject}" to recipients: ${recipientsFormatted}. Content request: ${request.trim()}`;
    try {
      ctx.composeDraft.request = forwardRequest;
      log(
        `[TMDBG Tools] email_forward: Stored composeDraft.request: ${ctx.composeDraft.request}`
      );
    } catch (e) {
      log(
        `[TMDBG Tools] email_forward: Failed to store composeDraft.request: ${e}`,
        "warn"
      );
    }

    // Update bubble to show we're now composing the forward
    try {
      const { streamText } = await import("../modules/helpers.js");
      streamText(agentBubble, `Composing forward for: "${emailSubject}"`);
    } catch (e) {
      agentBubble.textContent = `Composing forward for: "${emailSubject}"`;
    }

    const { runComposeEdit } = await import("../../compose/modules/edit.js");
    const { saveChatLog } = await import("../../agent/modules/utils.js");
    const { subject, body, raw, messages } = await runComposeEdit({
      recipients: ctx.composeDraft.recipients || [],
      subject: ctx.composeDraft.subject,
      body: ctx.composeDraft.body,
      request: ctx.composeDraft.request,
      relatedEmailId: internalId,
      mode: "forward",
    });
    saveChatLog(
      "tabmail_chatwindow_compose_email_edit",
      Date.now(),
      messages,
      raw
    );
    ctx.composeDraft.subject = subject;
    ctx.composeDraft.body = body;

    // Remove loading state now that compose edit is complete
    agentBubble.classList.remove("loading");

    // Switch to send_email state since we've done all first steps of the FSM workflow
    ctx.state = "send_email";

    log(
      `[TMDBG Tools] email_forward: Switching to FSM forward workflow (send_email state)`
    );

    // Execute the FSM workflow
    const core = await import("../fsm/core.js");
    await core.executeAgentAction();

    // Return immediately - the result will be set by the FSM workflow
    // when it returns to agent_converse
    return "Forward written and opening compose window...";
  } catch (e) {
    log(`[TMDBG Tools] email_forward failed: ${e}`, "error");
    // For FSM tools, handle errors by setting fail state, not returning error objects
    const errorMsg = String(e || "unknown error in email_forward tool");

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
    log(`[TMDBG Tools] email_forward.completeExecution: failed – ${failReason}`);
    return `Failed: ${failReason}`;
  }
  log(`[TMDBG Tools] email_forward.completeExecution: sent`);
  return "Email sent successfully.";
}
