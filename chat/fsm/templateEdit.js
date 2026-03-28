// templateEdit.js – FSM states for template_edit (TB 145, MV3)

import { log } from "../../agent/modules/utils.js";
import { updateTemplate } from "../../agent/modules/templateManager.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { streamText } from "../modules/helpers.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";

function formatEditDiff(original, updates) {
  const lines = [];
  if (updates.name && updates.name !== original.name) {
    lines.push(`**Name:** ${original.name} → ${updates.name}`);
  }
  if (updates.instructions) {
    lines.push(`**Instructions:** ${original.instructions.length} rules → ${updates.instructions.length} rules`);
    for (let i = 0; i < updates.instructions.length; i++) {
      lines.push(`  ${i + 1}. ${updates.instructions[i]}`);
    }
  }
  if (typeof updates.exampleReply === "string" && updates.exampleReply !== original.exampleReply) {
    const preview = updates.exampleReply.length > 100
      ? updates.exampleReply.slice(0, 100) + "…"
      : updates.exampleReply;
    lines.push(`**Example Reply:** updated → "${preview}"`);
  }
  return lines.length > 0 ? lines.join("\n") : "(No visible changes)";
}

export async function runStateEditTemplateList() {
  const agentBubble = await createNewAgentBubble("Preparing edit preview...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const editArgs = sess?.editTemplateArgs || null;

  if (!editArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "I cannot find the template details to edit.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing edit args in session."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  agentBubble.classList.remove("loading");
  const diff = formatEditDiff(editArgs.originalTemplate, editArgs.updates);
  const assistantText = `I'll update template "${editArgs.originalTemplate.name}":\n\n${diff}`;
  streamText(agentBubble, assistantText);

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText = "Should I go ahead and apply these changes?";
  streamText(confirmBubble, bubbleText);

  try {
    await relayFsmConfirmation(`${assistantText}\n\n${bubbleText}`, "yes");
  } catch (e) {
    log(`[TemplateEdit] ChatLink relay failed (non-fatal): ${e}`, "warn");
  }

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateEditTemplateExec() {
  const agentBubble = await createNewAgentBubble("Updating template...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const editArgs = sess?.editTemplateArgs || null;

  if (!editArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Edit failed because template details are missing.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing edit args in exec."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  try {
    const updated = await updateTemplate(editArgs.templateId, editArgs.updates);
    if (!updated) {
      throw new Error("updateTemplate returned null");
    }

    try {
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].editResult = {
          id: updated.id,
          name: updated.name,
        };
      }
    } catch (_) {}

    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Template "${updated.name}" updated successfully.`);
  } catch (e) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Failed to update template: ${e}`);
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
