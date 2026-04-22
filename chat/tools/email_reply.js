// email_reply.js – tool to start reply workflow for a specific email

// FSM tool — requires user confirmation before executing.
// Used by core.js to detect and block consecutive FSM calls (see BLOCK_CONSECUTIVE_FSM_CALLS).
export const fsm = true;
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
    // Publish FSM marker so converse.js registers a waiter on ctx.fsmWaiters[pid].
    // runStateSendEmail (emailCompose.js) tracks the compose window via onRemoved +
    // composeTracker.consumeSendInitiated, sets exec_success/exec_fail, and calls
    // notifyFsmCompleteInternal → completeExecution → waiter.resolve, delivering
    // "Email sent successfully." / "Failed: ..." back to the LLM. Without this
    // return shape the whole FSM backend runs but its output is dropped on the floor.
    const pid = options?.callId || ctx.activeToolCallId || 0;
    return { fsm: true, tool: "email_reply", pid, startedAt: Date.now() };
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

  // Delta-shaped per-field overrides. Absent key = no delta (empty arrays).
  // Non-array value for a provided key = malformed call → exec_fail.
  // See email_reply-v1.5.16.json tool description.
  function coerceDeltaArray(v, paramName) {
    if (typeof v === "undefined") return { ok: true, value: [] };
    if (!Array.isArray(v)) {
      return { ok: false, message: `${paramName} parameter must be an array, got: ${typeof v}` };
    }
    return { ok: true, value: v };
  }
  const deltaParams = [
    ["add_recipients", args?.add_recipients],
    ["remove_recipients", args?.remove_recipients],
    ["add_cc", args?.add_cc],
    ["remove_cc", args?.remove_cc],
    ["add_bcc", args?.add_bcc],
    ["remove_bcc", args?.remove_bcc],
  ];
  const deltas = {};
  for (const [name, raw] of deltaParams) {
    const c = coerceDeltaArray(raw, name);
    if (!c.ok) {
      log(`[TMDBG Tools] email_reply: ${c.message}`, "error");
      ctx.state = "exec_fail";
      const core = await import("../fsm/core.js");
      await core.executeAgentAction();
      return;
    }
    deltas[name] = c.value;
  }
  // Shape validation: every item in add_*/remove_* must be an object with a non-empty `email`.
  for (const [name, list] of Object.entries(deltas)) {
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || typeof r !== "object" || !r.email) {
        const errorMsg = `ERROR: ${name}[${i}] is missing required 'email' field`;
        log(`[TMDBG Tools] email_reply: ${errorMsg}`, "error");
        ctx.state = "exec_fail";
        const core = await import("../fsm/core.js");
        await core.executeAgentAction();
        return;
      }
    }
  }
  const anyDelta =
    deltas.add_recipients.length > 0 ||
    deltas.remove_recipients.length > 0 ||
    deltas.add_cc.length > 0 ||
    deltas.remove_cc.length > 0 ||
    deltas.add_bcc.length > 0 ||
    deltas.remove_bcc.length > 0;

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
  let repliedHeader = null;
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
    repliedHeader = header;
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

  // Compute reply-all defaults from the replied message. Sender → To; other
  // recipients (original To + Cc) → Cc. Filter out the user's own identities so
  // we never reply to ourselves. These defaults apply unless the LLM overrode
  // the matching field (per-field override — see tool description).
  const { getUserEmailSetCached, extractEmailFromAuthor } = await import(
    "../../agent/modules/senderFilter.js"
  );
  const userEmails = await getUserEmailSetCached();
  const seen = new Set(Array.from(userEmails || []));
  const toRecipient = (rawAddr) => {
    const email = extractEmailFromAuthor(rawAddr);
    if (!email || seen.has(email)) return null;
    seen.add(email);
    const m = String(rawAddr || "").match(/^\s*(.*?)\s*<[^<>]+>\s*$/);
    let name = m ? m[1].trim() : "";
    if (name.startsWith("\"") && name.endsWith("\"") && name.length >= 2) {
      name = name.slice(1, -1);
    }
    return { name, email };
  };

  const defaultTo = [];
  if (repliedHeader) {
    const sender = toRecipient(repliedHeader.author || "");
    if (sender) defaultTo.push(sender);
  }
  const defaultCc = [];
  for (const addr of repliedHeader?.recipients || []) {
    const r = toRecipient(addr);
    if (r) defaultCc.push(r);
  }
  for (const addr of repliedHeader?.ccList || []) {
    const r = toRecipient(addr);
    if (r) defaultCc.push(r);
  }
  log(
    `[TMDBG Tools] email_reply: reply-all defaults → to=${defaultTo.length} cc=${defaultCc.length}`
  );

  // Apply the LLM's add/remove deltas on top of the reply-all defaults.
  // `*` as an email in a remove list = clear the entire field.
  function applyDelta(base, adds, removes) {
    const clearAll = (removes || []).some((r) => String(r?.email || "").trim() === "*");
    const removeSet = new Set(
      (removes || [])
        .map((r) => String(r?.email || "").trim().toLowerCase())
        .filter((e) => e && e !== "*")
    );
    let result = clearAll
      ? []
      : (base || []).filter((r) => !removeSet.has(String(r?.email || "").toLowerCase()));
    const seen = new Set(result.map((r) => String(r?.email || "").toLowerCase()));
    for (const add of adds || []) {
      const email = String(add?.email || "").trim();
      if (!email || email === "*") continue;
      const key = email.toLowerCase();
      if (!seen.has(key)) {
        result.push({ name: String(add?.name || "").trim(), email });
        seen.add(key);
      }
    }
    return result;
  }

  ctx.composeDraft.recipients = applyDelta(defaultTo, deltas.add_recipients, deltas.remove_recipients);
  ctx.composeDraft.cc = applyDelta(defaultCc, deltas.add_cc, deltas.remove_cc);
  ctx.composeDraft.bcc = applyDelta([], deltas.add_bcc, deltas.remove_bcc);

  const fmt = (arr) =>
    (arr || [])
      .map((r) => {
        const name = (r.name || "").trim();
        const email = (r.email || "").trim();
        return name ? `${name} <${email}>` : `<${email}>`;
      })
      .join(", ");
  log(
    `[TMDBG Tools] email_reply: final recipients → to=${fmt(ctx.composeDraft.recipients)} | cc=${fmt(ctx.composeDraft.cc)} | bcc=${fmt(ctx.composeDraft.bcc)} (deltas applied: ${anyDelta})`
  );

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
    const suffix = anyDelta ? " (with recipient edits)" : "";
    streamText(agentBubble, `Composing reply for: "${emailSubject}"${suffix}`);
  } catch (e) {
    const suffix = anyDelta ? " (with recipient edits)" : "";
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
