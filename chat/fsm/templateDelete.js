// templateDelete.js – FSM states for template_delete (TB 145, MV3)

import { log } from "../../agent/modules/utils.js";
import { deleteTemplate } from "../../agent/modules/templateManager.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { streamText } from "../modules/helpers.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";

export async function runStateDeleteTemplateList() {
  const agentBubble = await createNewAgentBubble("Preparing delete preview...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const deleteArgs = sess?.deleteTemplateArgs || null;

  if (!deleteArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "I cannot find the template to delete.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing delete args in session."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  const t = deleteArgs.template;
  agentBubble.classList.remove("loading");
  const lines = [`**Name:** ${t.name}`];
  if (t.instructions && t.instructions.length > 0) {
    lines.push(`**Instructions:** ${t.instructions.length} rules`);
  }
  if (t.exampleReply) {
    const preview = t.exampleReply.length > 80
      ? t.exampleReply.slice(0, 80) + "…"
      : t.exampleReply;
    lines.push(`**Example:** "${preview}"`);
  }

  const assistantText = `I found this template to delete:\n\n${lines.join("\n")}`;
  streamText(agentBubble, assistantText);

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText = "Should I go ahead and delete this template? This cannot be undone locally.";
  streamText(confirmBubble, bubbleText);

  try {
    await relayFsmConfirmation(`${assistantText}\n\n${bubbleText}`, "yes");
  } catch (e) {
    log(`[TemplateDelete] ChatLink relay failed (non-fatal): ${e}`, "warn");
  }

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateDeleteTemplateExec() {
  const agentBubble = await createNewAgentBubble("Deleting template...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const deleteArgs = sess?.deleteTemplateArgs || null;

  if (!deleteArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Delete failed because template details are missing.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing delete args in exec."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  try {
    const ok = await deleteTemplate(deleteArgs.templateId);
    if (!ok) {
      throw new Error("deleteTemplate returned false");
    }

    try {
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].deleteResult = {
          name: deleteArgs.template.name,
        };
      }
    } catch (_) {}

    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Template "${deleteArgs.template.name}" deleted.`);
  } catch (e) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Failed to delete template: ${e}`);
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
