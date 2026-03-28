// templateDownload.js – FSM states for template_download (TB 145, MV3)

import { log } from "../../agent/modules/utils.js";
import { getTemplateWorkerUrl } from "../../agent/modules/config.js";
import { getAccessToken } from "../../agent/modules/supabaseAuth.js";
import { addTemplate } from "../../agent/modules/templateManager.js";
import { createNewAgentBubble } from "../chat.js";
import { ctx } from "../modules/context.js";
import { awaitUserInput } from "../modules/converse.js";
import { streamText } from "../modules/helpers.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";

export async function runStateDownloadTemplateList() {
  const agentBubble = await createNewAgentBubble("Fetching template from marketplace...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const downloadArgs = sess?.downloadTemplateArgs || null;

  if (!downloadArgs) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "I cannot find the template to download.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing download args in session."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  // Fetch template details from marketplace
  let token = "";
  try { token = await getAccessToken() || ""; } catch (_) {}

  let baseUrl = "";
  try { baseUrl = await getTemplateWorkerUrl(); } catch (_) {}

  if (!token || !baseUrl) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Authentication or marketplace configuration not available.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "No auth or marketplace URL"; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  let templateData = null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);
    let response;
    try {
      response = await fetch(`${baseUrl}/download/${downloadArgs.templateId}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw new Error(`Marketplace returned ${response.status}`);
    }

    const data = await response.json();
    templateData = data?.template;
  } catch (e) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Failed to fetch template from marketplace: ${e}`);
    try { if (pid) ctx.fsmSessions[pid].failReason = String(e); } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  if (!templateData || !templateData.name) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Template not found in marketplace.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Template not found in marketplace"; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  // Store fetched data for exec state
  try { ctx.fsmSessions[pid].downloadTemplateData = templateData; } catch (_) {}

  // Show confirmation
  agentBubble.classList.remove("loading");
  const lines = [`**Name:** ${templateData.name}`];
  if (Array.isArray(templateData.instructions)) {
    lines.push(`**Instructions:** ${templateData.instructions.length} rules`);
  }
  if (templateData.exampleReply || templateData.example_reply) {
    const ex = templateData.exampleReply || templateData.example_reply;
    const preview = ex.length > 80 ? ex.slice(0, 80) + "…" : ex;
    lines.push(`**Example:** "${preview}"`);
  }

  const assistantText = `I found this template in the marketplace:\n\n${lines.join("\n")}`;
  streamText(agentBubble, assistantText);

  const confirmBubble = await createNewAgentBubble("Thinking...");
  confirmBubble.classList.remove("loading");
  const bubbleText = "Should I download and install this template locally?";
  streamText(confirmBubble, bubbleText);

  try {
    await relayFsmConfirmation(`${assistantText}\n\n${bubbleText}`, "yes");
  } catch (e) {
    log(`[TemplateDownload] ChatLink relay failed (non-fatal): ${e}`, "warn");
  }

  try {
    ctx.pendingSuggestion = "yes";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}
  awaitUserInput();
}

export async function runStateDownloadTemplateExec() {
  const agentBubble = await createNewAgentBubble("Installing template...");

  const pid = ctx.activePid || ctx.activeToolCallId || 0;
  const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
  const templateData = sess?.downloadTemplateData || null;

  if (!templateData) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Install failed because template data is missing.");
    try { if (pid) ctx.fsmSessions[pid].failReason = "Missing template data in exec."; } catch (_) {}
    ctx.state = "exec_fail";
    const core = await import("./core.js");
    await core.executeAgentAction();
    return;
  }

  try {
    const newTemplate = await addTemplate({
      id: templateData.id,
      name: templateData.name,
      instructions: templateData.instructions || [],
      exampleReply: templateData.exampleReply || templateData.example_reply || "",
      enabled: templateData.enabled !== undefined ? templateData.enabled : true,
    });

    if (!newTemplate) {
      throw new Error("addTemplate returned null");
    }

    try {
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].downloadResult = {
          id: newTemplate.id,
          name: newTemplate.name,
        };
      }
    } catch (_) {}

    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Template "${newTemplate.name}" downloaded and installed.`);
  } catch (e) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Failed to install template: ${e}`);
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
