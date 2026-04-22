import { processEditResponse, sendChat } from "../../agent/modules/llm.js";
import { getUserCompositionPrompt, getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { extractBodyFromParts, safeGetFull, saveChatLog, stripHtml } from "../../agent/modules/utils.js";
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
  cc = [],
  bcc = [],
  subject = "",
  body = "",
  request = "",
  selectedText = "",
  relatedEmailId = "",
  mode = "new",
  userCompositionPrompt = "",
} = {}) {
  const recipsJson = JSON.stringify(Array.isArray(recipients) ? recipients : []);

  // Format current To/Cc/Bcc as one-recipient-per-line blocks for the v1.5.16+
  // edit prompt. `recipients` in this function is the To list; `cc`/`bcc` are
  // the other two fields if known. Each entry is `{name, email}` or bare email string.
  const formatRecipientBlock = (list) => {
    if (!Array.isArray(list)) return "";
    return list
      .map((r) => {
        if (!r) return "";
        if (typeof r === "string") return r.trim() ? `<${r.trim()}>` : "";
        const name = String(r.name || "").trim();
        const email = String(r.email || "").trim();
        if (!email) return "";
        return name ? `${name} <${email}>` : `<${email}>`;
      })
      .filter(Boolean)
      .join("\n");
  };
  const originalTo = formatRecipientBlock(recipients);
  const originalCc = formatRecipientBlock(cc);
  const originalBcc = formatRecipientBlock(bcc);

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
        const full = await safeGetFull(header.id, header);
        let bodyHtml = await extractBodyFromParts(full, header.id);
        const plainBody = stripHtml(bodyHtml || "");
        const splitBody = globalThis.TabMailQuoteDetection.splitPlainTextForQuote(plainBody);
        relatedEmailInfo = {
          message: splitBody.main,
          quotes_section: splitBody.quote,
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
    content: "system_prompt_compose_interactive",
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
    original_to: originalTo,
    original_cc: originalCc,
    original_bcc: originalBcc,
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
 * Supports chat history for continuous inline editing across turns.
 * @param {Object} params
 * @param {Array<{name:string,email:string}>} [params.recipients]
 * @param {string} [params.subject]
 * @param {string} [params.body]
 * @param {string} [params.request]
 * @param {string} [params.selectedText]
 * @param {string} [params.relatedEmailId]
 * @param {string} [params.mode]
 * @param {boolean} [params.ignoreSemaphore=false]
 * @param {Array<{userRequest:string,bodyAtRequest:string,subjectAtRequest:string,assistantResponse:string}>} [params.chatHistory=[]] Previous edit turns with draft state
 * @returns {Promise<{subject?:string, body?:string, raw:string, messages:Array, chatHistory:Array}>}
 */
export async function runComposeEdit({
  recipients = [],
  cc = [],
  bcc = [],
  subject = "",
  body = "",
  request = "",
  selectedText = "",
  relatedEmailId = "",
  mode = "new",
  ignoreSemaphore = false,
  chatHistory = [],
} = {}) {
  const startTime = performance.now();
  try {
    // Get user composition prompt
    const userCompPrompt = await getUserCompositionPrompt();

    // Build single consolidated message that backend will process
    const systemMsg = await buildComposeEditChat({
      recipients,
      cc,
      bcc,
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
        `[Compose/edit] runComposeEdit STARTED: mode=${mode} recipients=${(recipients || []).length} subjectLen=${(subject||"").length} bodyLen=${(body||"").length} reqLen=${(request||"").length} selLen=${(selectedText||"").length} historyTurns=${chatHistory.length}`
      );
    } catch (_) {}

    // Each call is atomic — no real chat turns. Past edits are embedded as
    // formatted text context in the system message. Each history entry stores
    // the body/subject state at the time of the request so the LLM can see
    // the full evolution (including any manual user edits between turns).
    if (chatHistory.length > 0) {
      const lines = [];
      chatHistory.forEach((turn, idx) => {
        lines.push(`--- Edit Turn ${idx + 1} ---`);
        lines.push(`Draft at time of request:`);
        lines.push(`Subject: ${turn.subjectAtRequest}`);
        lines.push(`Body:\n${turn.bodyAtRequest}`);
        lines.push(``);
        lines.push(`User request: ${turn.userRequest}`);
        lines.push(``);
        lines.push(`Assistant response:\n${turn.assistantResponse}`);
        lines.push(``);
      });
      systemMsg.edit_conversation_history = lines.join("\n");
    } else {
      systemMsg.edit_conversation_history = "";
    }

    const allMessages = [systemMsg];

    // Use sendChat with headless tool executor for compose flow
    // Backend will filter tools based on system_prompt_compose_interactive config
    const response = await sendChat(allMessages, {
      disableTools: false,
      ignoreSemaphore,
      onToolExecution: executeToolsHeadless,
    });

    // Handle error response
    if (response?.err) {
      console.log(`[Compose/edit] LLM error: ${response.err}`, "error");
      return { subject: undefined, body: "", raw: "", messages: [systemMsg], chatHistory, error: response.err };
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
        `[Compose/edit] ⚠️ NOTE: Token usage (including thinking tokens) is logged above by sendChat`
      );
    } catch (_) {}

    // Save chat log for debugging (gated by debugMode)
    saveChatLog(
      "tabmail_inline_edit",
      `${mode}_${Date.now()}`,
      allMessages,
      assistantResp
    );

    // Build updated chat history with this turn appended.
    // Each entry stores the draft state at the time of the request.
    const updatedHistory = [
      ...chatHistory,
      {
        userRequest: request,
        bodyAtRequest: body,
        subjectAtRequest: subject,
        assistantResponse: assistantResp,
      },
    ];

    return {
      subject: parsed.subject,
      body: parsed.body || parsed.message || "",
      // Recipient deltas from the LLM response (v1.5.16+). `undefined` = field
      // was not touched → client keeps current recipients. Otherwise a
      // `{ adds: [{name,email}], removes: [email|"*"] }` object.
      toDelta: parsed.toDelta,
      ccDelta: parsed.ccDelta,
      bccDelta: parsed.bccDelta,
      raw: assistantResp,
      messages: [systemMsg],
      chatHistory: updatedHistory,
      wasThrottled, // Pass throttle status to caller
    };
  } catch (e) {
    const duration = performance.now() - startTime;
    console.log(`[Compose/edit] runComposeEdit error after ${duration.toFixed(1)}ms: ${e}`, "error");
    return { subject: undefined, body: "", raw: "", messages: [], chatHistory };
  }
}


