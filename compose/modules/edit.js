import { processEditResponse, sendChatWithTools } from "../../agent/modules/llm.js";
import { getUserCompositionPrompt, getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { extractBodyFromParts, safeGetFull, stripHtml } from "../../agent/modules/utils.js";
import { getUserName } from "../../chat/modules/helpers.js";
import { executeToolsHeadless } from "../../chat/tools/core.js";


/**
 * Build the consolidated system message for compose edit flow (email_edit).
 * The backend will expand this into the full prompt sequence.
 * @param {Object} params
 * @param {Array<{name:string,email:string}>} [params.recipients]
 * @param {string} [params.subject]
 * @param {string} [params.body]
 * @param {string} [params.request]
 * @param {string} [params.selectedText]
 * @param {string} [params.relatedEmailId]
 * @param {string} [params.mode]
 * @param {string} [params.userCompositionPrompt]
 * @returns {Object} Single consolidated message
 */
export async function buildComposeEditChat({
  recipients = [],
  subject = "",
  body = "",
  request = "",
  selectedText = "",
  relatedEmailId = "",
  mode = "new",
  userCompositionPrompt = "",
} = {}) {
  const recipsJson = JSON.stringify(Array.isArray(recipients) ? recipients : []);

  // Load user knowledge base content
  let userKBContent = "";
  try {
    userKBContent = (await getUserKBPrompt()) || "";
    console.log(`[Compose/edit] Loaded user KB content (${userKBContent.length} chars) for new conversation.`);
  } catch (e) {
    console.log(`[Compose/edit] Failed to load user KB content: ${e}`, "warn");
    userKBContent = ""; // fallback to empty if loading fails
  }

  // Get user name
  const userName = await getUserName({ fullname: true });

  // Get current time for new email mode
  let currentTime = null;
  if (mode === "new") {
    try {
      const { formatTimestampForAgent } = await import("../../chat/modules/helpers.js");
      currentTime = formatTimestampForAgent();
    } catch (e) {
      console.log(`[Compose/edit] Failed to get current time: ${e}`, "warn");
    }
  }

  // Get related email info for reply/forward modes
  let relatedEmailInfo = {};
  if (relatedEmailId && (mode === "reply" || mode === "forward")) {
    try {
      const { formatTimestampForAgent } = await import("../../chat/modules/helpers.js");
      const header = await browser.messages.get(Number(relatedEmailId));
      if (header) {
        // Get plaintext body
        const full = await safeGetFull(header.id);
        let bodyHtml = await extractBodyFromParts(full, header.id);
        const plainBody = stripHtml(bodyHtml || "");
        relatedEmailInfo = {
          body: plainBody,
          current_time: formatTimestampForAgent(),
          related_subject: header.subject || "",
          related_from: header.author || "",
          related_to: header.recipients || "",
          related_cc: header.ccList || "",
          related_date: header.date ? formatTimestampForAgent(new Date(header.date)) : "",
        };
      }
    } catch (e) {
      console.log(`[Compose/edit] Failed to get related email info: ${e}`, "warn");
    }
  }

  // Build single consolidated message that backend will process
  const useSelection = !!(selectedText && selectedText.trim());
  
  const message = {
    role: "system",
    content: "system_prompt_compose",
    mode: `edit_${mode}`,
    use_selection: useSelection,
    user_name: userName,
    user_composition_prompt: userCompositionPrompt || "",
    recipients_json: recipsJson,
    current_subject: subject,
    current_body: body,
    user_request: request,
    user_kb_content: userKBContent,
    selected_text: selectedText || "",
    ...relatedEmailInfo,
  };

  // Add current_time for new email mode
  if (currentTime) {
    message.current_time = currentTime;
  }

  return message;
}

/**
 * Run the compose edit flow and parse the result.
 * Returns parsed subject/body and raw assistant text, plus the messages used.
 * @param {Object} params
 * @param {Array<{name:string,email:string}>} [params.recipients]
 * @param {string} [params.subject]
 * @param {string} [params.body]
 * @param {string} [params.request]
 * @param {string} [params.selectedText]
 * @param {string} [params.relatedEmailId]
 * @param {string} [params.mode]
 * @param {boolean} [params.ignoreSemaphore=false]
 * @returns {Promise<{subject?:string, body?:string, raw:string, messages:Array}>}
 */
export async function runComposeEdit({
  recipients = [],
  subject = "",
  body = "",
  request = "",
  selectedText = "",
  relatedEmailId = "",
  mode = "new",
  ignoreSemaphore = false,
} = {}) {
  const startTime = performance.now();
  try {
    // Get user composition prompt
    const userCompPrompt = await getUserCompositionPrompt();
    
    // Build single consolidated message that backend will process
    const systemMsg = await buildComposeEditChat({ 
      recipients, 
      subject, 
      body, 
      request, 
      selectedText, 
      relatedEmailId, 
      mode,
      userCompositionPrompt: userCompPrompt || ""
    });

    try {
      console.log(
        `[Compose/edit] runComposeEdit STARTED: mode=${mode} recipients=${(recipients || []).length} subjectLen=${(subject||"").length} bodyLen=${(body||"").length} reqLen=${(request||"").length} selLen=${(selectedText||"").length}`
      );
    } catch (_) {}

    // Use sendChatWithTools with headless tool executor for compose flow
    // Backend will filter tools based on system_prompt_compose config
    const response = await sendChatWithTools([systemMsg], { 
      ignoreSemaphore,
      onToolExecution: executeToolsHeadless,
    });
    
    // Handle error response
    if (response?.err) {
      console.log(`[Compose/edit] LLM error: ${response.err}`, "error");
      return { subject: undefined, body: "", raw: "", messages: [systemMsg], error: response.err };
    }
    
    const assistantResp = response?.assistant || "";
    const wasThrottled = response?.wasThrottled || false;
    const parsed = processEditResponse(assistantResp);
    
    const duration = performance.now() - startTime;
    try {
      console.log(
        `[Compose/edit] runComposeEdit COMPLETED in ${duration.toFixed(1)}ms: mode=${mode} responseLen=${(assistantResp||"").length} throttled=${wasThrottled}`
      );
      console.log(
        `[Compose/edit] ⚠️ NOTE: Token usage (including thinking tokens) is logged above by sendChatWithTools`
      );
    } catch (_) {}
    
    return {
      subject: parsed.subject,
      body: parsed.body || parsed.message || "",
      raw: assistantResp,
      messages: [systemMsg],
      wasThrottled, // Pass throttle status to caller
    };
  } catch (e) {
    const duration = performance.now() - startTime;
    console.log(`[Compose/edit] runComposeEdit error after ${duration.toFixed(1)}ms: ${e}`, "error");
    return { subject: undefined, body: "", raw: "", messages: [] };
  }
}


