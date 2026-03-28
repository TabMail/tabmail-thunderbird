// templateCreate.js – FSM states for template_create (TB 145, MV3)

import { log } from "../../agent/modules/utils.js";
import { addTemplate, getVisibleTemplates } from "../../agent/modules/templateManager.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { streamText } from "../modules/helpers.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";

function formatTemplateForDisplay(args) {
  const lines = [];
  if (args.name) lines.push(`**Name:** ${args.name}`);
  if (args.instructions && args.instructions.length > 0) {
    lines.push("**Instructions:**");
    for (let i = 0; i < args.instructions.length; i++) {
      lines.push(`${i + 1}. ${args.instructions[i]}`);
    }
  }
  if (args.exampleReply) {
    lines.push(`**Example Reply:**\n> ${args.exampleReply.split("\n").join("\n> ")}`);
  }
  return lines.join("\n");
}

export async function runStateCreateTemplateList() {
  const agentBubble = await createNewAgentBubble("Preparing template preview...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const createArgs = sess?.createTemplateArgs || null;

  if (!createArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "I cannot find the template details to create.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing template args in session."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  // Check for duplicate name
  let dupWarning = "";
  try {
    const existing = await getVisibleTemplates();
    const nameLower = (createArgs.name || "").toLowerCase();
    if (existing.some((t) => (t.name || "").toLowerCase() === nameLower)) {
      dupWarning = `\n\n⚠️ A template named "${createArgs.name}" already exists. This will create a second one.`;
    }
  } catch (_) {}

  agentBubble.classList.remove("loading");
  const formatted = formatTemplateForDisplay(createArgs);
  const assistantText = `I'll create this reply template:\n\n${formatted}${dupWarning}`;
  streamText(agentBubble, assistantText);

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText = "Should I go ahead and create this template?";
  streamText(confirmBubble, bubbleText);

  try {
    await relayFsmConfirmation(`${assistantText}\n\n${bubbleText}`, "yes");
  } catch (e) {
    log(`[TemplateCreate] ChatLink relay failed (non-fatal): ${e}`, "warn");
  }

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateCreateTemplateExec() {
  const agentBubble = await createNewAgentBubble("Creating template...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const createArgs = sess?.createTemplateArgs || null;

  if (!createArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Create failed because template details are missing.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing template args in exec."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  try {
    const newTemplate = await addTemplate({
      name: createArgs.name,
      instructions: createArgs.instructions,
      exampleReply: createArgs.exampleReply,
      enabled: true,
    });

    if (!newTemplate) {
      throw new Error("addTemplate returned null");
    }

    try {
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].createResult = {
          id: newTemplate.id,
          name: newTemplate.name,
        };
      }
    } catch (_) {}

    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Template "${newTemplate.name}" created successfully.`);
  } catch (e) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Failed to create template: ${e}`);
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
