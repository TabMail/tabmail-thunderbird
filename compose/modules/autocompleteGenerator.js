import * as idb from "../../agent/modules/idbStorage.js";
import { sendChat } from "../../agent/modules/llm.js";
import { getUserCompositionPrompt } from "../../agent/modules/promptGenerator.js";
import { log } from "../../agent/modules/utils.js";
import { formatTimestampForAgent } from "../../chat/modules/helpers.js";

const PFX = "[AutoGen] ";

export async function generateCorrection(context) {
  const {
    userMessage = "",
    quoteAndSignature = "",
    cursorPosition = 0,
    isLocal = false, // true = local/chunked mode, false = global/full email mode
    subject = "",
    from = "",
    to = "",
    cc = "",
    // Precomputed summary context for the quoted thread (required)
    summaryBlurb,
    summaryDetailed,
    /* starterHistory deprecated – always ignored */
    sessionId = null,
  } = context;

  const draftText = userMessage;

  // Get user composition prompt (will be passed to backend for expansion)
  const userCompositionPrompt = await getUserCompositionPrompt();

  // Choose the appropriate system prompt based on mode
  const systemPrompt = isLocal === true 
    ? "system_prompt_autocomplete_local" 
    : "system_prompt_autocomplete";
  
  log(`${PFX}Mode: ${isLocal === true ? 'LOCAL (chunked)' : 'GLOBAL (full email)'}, prompt: ${systemPrompt}`);

  // Build a single system message that the backend will process
  const systemMsg = {
    role: "system",
    content: systemPrompt,
    sender_info: from || "Not Available",
    user_composition_prompt: userCompositionPrompt || "",
    text_to_correct: draftText || "",
    blurb: summaryBlurb,
    detailed_summary: summaryDetailed,
    subject: subject || "",
    to_info: Array.isArray(to) ? to.join(", ") : to,
    cc_info: Array.isArray(cc) ? cc.join(", ") : cc,
    current_time: formatTimestampForAgent(),
    cursor_position: typeof cursorPosition === "number" ? cursorPosition : 0,
  };

  const resp = await sendChat([systemMsg], { ignoreSemaphore: true });
  const assistantText = resp?.assistant;
  if (!assistantText) {
    log(`${PFX}Empty assistant response`, "error");
    return null;
  }

  // Persist system message for debugging (without the final assistant suggestion).
  try {
    if (sessionId !== null) {
      await idb.set({ ["activeHistory:" + sessionId]: [systemMsg] });
    }
  } catch (_) {/* ignore */}

  // saveChatLog("tabmail_autocomplete", sessionId !== null ? sessionId : Date.now(), chatHistory.concat(correctionMsg), assistantText);

  return assistantText.trim();
} 