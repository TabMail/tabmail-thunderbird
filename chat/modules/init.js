// init.js – greet user and prime chat
// Thunderbird 140 MV3

import { SETTINGS } from "../../agent/modules/config.js";
import {
  getUserKBPrompt
} from "../../agent/modules/promptGenerator.js";
import {
  formatRemindersForDisplay,
  getRandomReminders,
} from "../../agent/modules/reminderBuilder.js";
import { ctx } from "./context.js";
import { getUserName, streamText } from "./helpers.js";

import { buildInboxContext } from "../../agent/modules/inboxContext.js";
import { log } from "../../agent/modules/utils.js";

import { createNewAgentBubble } from "../chat.js";
import { awaitUserInput } from "./converse.js";
import { updateEmailCacheForMentions } from "./mentionAutocomplete.js";

export async function initAndGreetUser() {
  // Reset ID translation cache for new chat session
  try {
    const { resetIdTranslationCache } = await import("./idTranslator.js");
    resetIdTranslationCache();
    log(`[TMDBG Init] Reset ID translation cache for new chat session`);
  } catch (e) {
    log(`[TMDBG Init] Failed to reset ID translation cache: ${e}`, "warn");
  }

  const [inboxContextJson, userName] = await Promise.all([
    buildInboxContext(),
    getUserName(),
  ]);

  let total = 0,
    countArchive = 0,
    countDelete = 0,
    countReply = 0;
  try {
    const inboxItems = JSON.parse(inboxContextJson);
    if (Array.isArray(inboxItems)) {
      total = inboxItems.length;
      inboxItems.forEach((itm) => {
        switch ((itm.action || "").toLowerCase()) {
          case "archive":
            countArchive += 1;
            break;
          case "delete":
            countDelete += 1;
            break;
          case "reply":
            countReply += 1;
            break;
          default:
            break;
        }
      });
      
      // Update email cache for @ mention autocomplete
      try {
        await updateEmailCacheForMentions(inboxItems);
        log(`[TMDBG Init] Updated email cache for mentions: ${inboxItems.length} emails`);
      } catch (e) {
        log(`[TMDBG Init] Failed to update email cache for mentions: ${e}`, "warn");
      }
    }
  } catch (e) {
    log(`[TMDBG Init] Failed to parse inboxContextJson: ${e}`, "error");
  }

  let displayText = "";
  if (!ctx.greetedUser) {
    const greetingParts = [
      `Hello ${userName},\n\n`,
      `You currently have a total of ${total} emails, with ${countArchive} marked for archiving, `,
      `${countDelete} marked for deletion, and ${countReply} marked for replying.\n\n`,
    ];

    // Add reminders if available and enabled
    if (SETTINGS.reminderGeneration?.showInChat) {
      try {
        const stored = await browser.storage.local.get({
          maxRemindersToShow:
            SETTINGS.reminderGeneration?.maxRemindersToShow || 2,
        });
        const maxReminders = stored.maxRemindersToShow || 2;

        const reminderData = await getRandomReminders(maxReminders);
        if (
          reminderData &&
          reminderData.reminders &&
          reminderData.reminders.length > 0
        ) {
          // Format reminders for display (uses [reminder:hash] syntax)
          const formattedReminders = formatRemindersForDisplay(
            reminderData.reminders
          );
          greetingParts.push(formattedReminders);

          log(
            `[TMDBG Init] ✅ Showing ${reminderData.reminders.length} reminders (${reminderData.urgentCount} urgent, ${reminderData.totalCount} total available)`
          );
        } else {
          log(
            `[TMDBG Init] ⚠️ No reminders available (no message or KB reminders found)`
          );
        }
      } catch (e) {
        log(`[TMDBG Init] ❌ Failed to get reminders: ${e}`, "warn");
      }
    } else {
      log(`[TMDBG Init] ℹ️ Reminder feature disabled in config`);
    }

    greetingParts.push("What would you like to do next?");
    displayText = greetingParts.join("");
    ctx.greetedUser = true;
  } else {
    displayText = "What would you like to do next?";
  }

  const agentBubble = await createNewAgentBubble("");
  agentBubble.classList.remove("loading");
  streamText(agentBubble, displayText);

  // Initialise persistent agent converse message list once
  try {
    if (
      !Array.isArray(ctx.agentConverseMessages) ||
      ctx.agentConverseMessages.length === 0
    ) {
      let userKBContent = "";
      try {
        userKBContent = (await getUserKBPrompt()) || "";
        log(
          `[TabMail KB] Loaded user KB content (${userKBContent.length} chars) for conversation.`
        );
      } catch (e) {
        log(`[TabMail KB] Failed to load user KB content: ${e}`, "warn");
        userKBContent = "";
      }

      // let userCompositionPrompt = "";
      // try {
      //   userCompositionPrompt = (await getUserCompositionPrompt()) || "";
      //   log(
      //     `[TabMail Composition] Loaded user composition prompt (${userCompositionPrompt.length} chars) for conversation.`
      //   );
      // } catch (e) {
      //   log(
      //     `[TabMail Composition] Failed to load user composition prompt: ${e}`,
      //     "warn"
      //   );
      //   userCompositionPrompt = "";
      // }

      let remindersJson = "";
      try {
        const { reminders } = await import("../../agent/modules/reminderBuilder.js").then(m => m.buildReminderList());
        if (reminders && reminders.length > 0) {
          // Apply ID translation to convert TB IDs to numeric IDs for LLM
          let translatedReminders = reminders;
          try {
            const { processToolResultTBtoLLM } = await import("./idTranslator.js");
            translatedReminders = processToolResultTBtoLLM(reminders);
            log(`[TabMail Reminders] Applied ID translation to ${reminders.length} reminders`);
          } catch (e) {
            log(`[TabMail Reminders] ID translation failed, using original reminders: ${e}`, "warn");
          }
          
          // Send compact JSON to backend (formatting happens in expander)
          remindersJson = JSON.stringify(translatedReminders);
          log(
            `[TabMail Reminders] Loaded ${reminders.length} reminders for agent context.`
          );
        }
      } catch (e) {
        log(`[TabMail Reminders] Failed to load reminders: ${e}`, "warn");
        remindersJson = "";
      }

      ctx.agentConverseMessages = [
        {
          role: "system",
          content: "system_prompt_agent",
          user_name: userName,
          user_kb_content: userKBContent,
          // user_composition_prompt: userCompositionPrompt,
          user_reminders_json: remindersJson,
        },
      ];
      log(`[TMDBG Init] Initialised agentConverseMessages.`);
      
      // Add the displayed welcome message (including reminders if any) to chat history
      // so the agent is aware of what the user has already seen
      if (displayText && ctx.greetedUser) {
        ctx.agentConverseMessages.push({
          role: "assistant",
          content: displayText,
        });
        log(`[TMDBG Init] Added welcome message to chat history (${displayText.length} chars)`);
      }
    }
  } catch (e) {
    log(
      `[TMDBG Init] Failed to initialise agentConverseMessages: ${e}`,
      "warn"
    );
  }

  // Decide pending suggestion for initial await
  try {
    // if (countArchive > 0 || countDelete > 0) {
    //   ctx.pendingSuggestion = "tidy up inbox";
    //   console.log(`[TMDBG Init] Set pendingSuggestion='${ctx.pendingSuggestion}' (archive/delete present)`);
    // } else if (countReply > 0) {
    //   ctx.pendingSuggestion = "reply to emails";
    //   console.log(`[TMDBG Init] Set pendingSuggestion='${ctx.pendingSuggestion}' (reply present)`);
    // } else {
    //   ctx.pendingSuggestion = "";
    //   console.log(`[TMDBG Init] Cleared pendingSuggestion (no actionable emails)`);
    // }
    ctx.pendingSuggestion = "anything urgent?";
    if (window.tmShowSuggestion) window.tmShowSuggestion();
  } catch (_) {}

  awaitUserInput();
}
