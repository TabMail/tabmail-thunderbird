/**
 * ChatLink FSM Integration
 *
 * Helper functions for relaying FSM (Finite State Machine) prompts to WhatsApp.
 * FSM tools (archive, delete, compose, etc.) show confirmation prompts that need
 * to be relayed to WhatsApp users with interactive buttons.
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { log } from "../../agent/modules/utils.js";
import { ctx } from "../../chat/modules/context.js";
import { relayFsmPrompt, isChatLinkMessage } from "./core.js";

/**
 * Relay an FSM confirmation prompt to WhatsApp with Yes/Cancel buttons.
 * Call this from FSM state handlers after setting up the confirmation UI.
 *
 * @param {string} promptText - The confirmation prompt (e.g., "Should I archive these emails?")
 * @param {string} suggestion - The suggested action (default: "yes")
 * @returns {Promise<void>}
 *
 * @example
 * // In emailArchive.js after showing confirmation
 * await relayFsmConfirmation("Should I go ahead and archive these emails?", "yes");
 */
export async function relayFsmConfirmation(promptText, suggestion = "yes") {
  if (!isChatLinkMessage()) {
    return; // Not a ChatLink message, no relay needed
  }

  try {
    const pid = ctx.activePid || ctx.awaitingPid || 0;

    // Build buttons - WhatsApp supports up to 3 buttons
    const buttons = [
      { label: capitalizeFirst(suggestion), data: suggestion },
      { label: "Cancel", data: "no" },
    ];

    log(`[ChatLink FSM] Relaying confirmation: "${promptText.substring(0, 50)}..." with buttons: ${buttons.map(b => b.label).join(", ")}`);

    await relayFsmPrompt(promptText, buttons, String(pid));
  } catch (e) {
    log(`[ChatLink FSM] Failed to relay confirmation: ${e}`, "error");
  }
}

/**
 * Relay an FSM selection prompt to WhatsApp with custom buttons.
 * Use this for prompts that need multiple choice options.
 *
 * @param {string} promptText - The prompt text
 * @param {Array<{label: string, data: string}>} options - Button options (max 3)
 * @returns {Promise<void>}
 *
 * @example
 * await relayFsmSelection("What would you like to do?", [
 *   { label: "Archive", data: "archive" },
 *   { label: "Delete", data: "delete" },
 *   { label: "Skip", data: "skip" },
 * ]);
 */
export async function relayFsmSelection(promptText, options) {
  if (!isChatLinkMessage()) {
    return;
  }

  try {
    const pid = ctx.activePid || ctx.awaitingPid || 0;

    // Limit to 3 buttons (WhatsApp constraint)
    const buttons = options.slice(0, 3);

    log(`[ChatLink FSM] Relaying selection: "${promptText.substring(0, 50)}..." with ${buttons.length} options`);

    await relayFsmPrompt(promptText, buttons, String(pid));
  } catch (e) {
    log(`[ChatLink FSM] Failed to relay selection: ${e}`, "error");
  }
}

/**
 * Relay an FSM list summary to WhatsApp.
 * Use this to send a text summary of items (emails, events, etc.) before confirmation.
 *
 * @param {string} summaryText - The formatted list summary
 * @param {string} promptText - The follow-up prompt
 * @param {string} suggestion - The suggested action
 * @returns {Promise<void>}
 *
 * @example
 * const summary = emails.map((e, i) => `${i+1}. ${e.subject} (${e.from})`).join("\n");
 * await relayFsmListWithConfirmation(summary, "Should I archive these?", "yes");
 */
export async function relayFsmListWithConfirmation(summaryText, promptText, suggestion = "yes") {
  if (!isChatLinkMessage()) {
    return;
  }

  try {
    const pid = ctx.activePid || ctx.awaitingPid || 0;

    // Combine summary and prompt
    const fullText = `${summaryText}\n\n${promptText}`;

    const buttons = [
      { label: capitalizeFirst(suggestion), data: suggestion },
      { label: "Cancel", data: "no" },
    ];

    log(`[ChatLink FSM] Relaying list with confirmation (${summaryText.split("\n").length} items)`);

    await relayFsmPrompt(fullText, buttons, String(pid));
  } catch (e) {
    log(`[ChatLink FSM] Failed to relay list: ${e}`, "error");
  }
}

/**
 * Build a plain text summary of emails for WhatsApp relay.
 * Converts the rich email list UI to plain text format.
 *
 * @param {Array<{subject: string, from: string, date?: string}>} emails - Email items
 * @param {number} maxItems - Maximum items to include (default: 10)
 * @returns {string} - Formatted plain text summary
 */
export function buildEmailListSummary(emails, maxItems = 10) {
  if (!emails || emails.length === 0) {
    return "No emails selected.";
  }

  const items = emails.slice(0, maxItems);
  const lines = items.map((e, i) => {
    const subject = e.subject || "(no subject)";
    const from = e.from || "Unknown";
    const truncSubject = subject.length > 40 ? subject.substring(0, 37) + "..." : subject;
    return `${i + 1}. ${truncSubject}\n   From: ${from}`;
  });

  let summary = lines.join("\n\n");

  if (emails.length > maxItems) {
    summary += `\n\n... and ${emails.length - maxItems} more`;
  }

  return summary;
}

/**
 * Capitalize first letter of a string
 */
function capitalizeFirst(str) {
  if (!str) return str;
  return str.charAt(0).toUpperCase() + str.slice(1);
}
