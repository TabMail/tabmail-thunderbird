// templateShare.js – FSM states for template_share (TB 145, MV3)

import { log } from "../../agent/modules/utils.js";
import { getTemplateWorkerUrl } from "../../agent/modules/config.js";
import { getAccessToken } from "../../agent/modules/supabaseAuth.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { streamText } from "../modules/helpers.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";

export async function runStateShareTemplateList() {
  const agentBubble = await createNewAgentBubble("Preparing share preview...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const shareArgs = sess?.shareTemplateArgs || null;

  if (!shareArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "I cannot find the template to share.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing share args in session."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  const t = shareArgs.template;
  agentBubble.classList.remove("loading");
  const lines = [`**Name:** ${t.name}`];
  if (shareArgs.description) lines.push(`**Description:** ${shareArgs.description}`);
  if (shareArgs.category) lines.push(`**Category:** ${shareArgs.category}`);
  if (shareArgs.tags && shareArgs.tags.length > 0) lines.push(`**Tags:** ${shareArgs.tags.join(", ")}`);
  lines.push(`**Instructions:** ${t.instructions.length} rules`);
  if (t.exampleReply) {
    const preview = t.exampleReply.length > 80
      ? t.exampleReply.slice(0, 80) + "…"
      : t.exampleReply;
    lines.push(`**Example:** "${preview}"`);
  }

  const assistantText = `I'll share this template to the public marketplace:\n\n${lines.join("\n")}`;
  streamText(agentBubble, assistantText);

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText = "Should I go ahead and share this template? Other users will be able to find and use it after review.\n\nBy sharing, you agree to our Community Guidelines. Templates must be professional, respectful, and your own work. We reserve the right to reject or remove any template at any time.";
  streamText(confirmBubble, bubbleText);

  try {
    await relayFsmConfirmation(`${assistantText}\n\n${bubbleText}`, "yes");
  } catch (e) {
    log(`[TemplateShare] ChatLink relay failed (non-fatal): ${e}`, "warn");
  }

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateShareTemplateExec() {
  const agentBubble = await createNewAgentBubble("Sharing template to marketplace...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const shareArgs = sess?.shareTemplateArgs || null;

  if (!shareArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Share failed because template details are missing.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing share args in exec."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  // Get auth token (handles refresh if expired)
  let token = "";
  try {
    token = await getAccessToken() || "";
  } catch (e) {
    log(`[TemplateShare] failed to get auth token: ${e}`, "error");
  }

  if (!token) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Authentication not available. Please sign in first.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "No auth token"; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  let baseUrl = "";
  try {
    baseUrl = await getTemplateWorkerUrl();
  } catch (e) {
    log(`[TemplateShare] failed to get template worker URL: ${e}`, "error");
  }
  if (!baseUrl) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Template marketplace is not configured.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "templateWorkerUrl not configured"; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  const t = shareArgs.template;
  const body = {
    id: shareArgs.templateId,
    name: t.name,
    instructions: t.instructions,
    example_reply: t.exampleReply,
  };
  if (shareArgs.description) body.description = shareArgs.description;
  if (shareArgs.category) body.category = shareArgs.category;
  if (shareArgs.tags && shareArgs.tags.length > 0) body.tags = shareArgs.tags;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(`${baseUrl}/upload`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      let errorMsg = `Marketplace returned ${response.status}`;
      try {
        const errData = await response.json();
        if (errData.message) errorMsg = errData.message;
        else if (errData.error) errorMsg = errData.error;
      } catch (_) {}
      throw new Error(errorMsg);
    }

    const data = await response.json();

    try {
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].shareResult = {
          template_id: data.template_id || shareArgs.templateId,
          status: data.status || "pending_review",
          message: data.message || "Template submitted for review.",
        };
      }
    } catch (_) {}

    agentBubble.classList.remove("loading");
    const msg = data.message || "Template submitted for review. It will be visible in the marketplace once approved.";
    streamText(agentBubble, msg);
  } catch (e) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Failed to share template: ${e}`);
    try { if (pid) ctx.fsmSessions[pid].failReason = String(e); } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  ctx.state = "exec_success";
  const core = await import("./core.js");
  await core.executeAgentAction();
}
