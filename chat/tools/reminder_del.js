/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// reminder_del.js – delete a KB reminder or snooze an email-reminder by text match (TB 145, MV3)

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { editText, removeShownItem } from "../../agent/modules/promptStore.js";
import { hashReminder } from "../../agent/modules/reminderStateStore.js";
import { log, normalizeUnicode } from "../../agent/modules/utils.js";

/** What the KB edit returns when no KB reminder matches: the email reminders are searched next. */
const NO_KB_MATCH = Symbol("no KB match");

/** Snoozes the one email reminder matching `text`, or says why none was. */
async function deleteEmailReminder(text) {
  const textLower = text.toLowerCase();
  // No KB match — search email-reminders (message-based) and snooze if found
  log(`[TMDBG Tools] reminder_del: no KB match, searching email-reminders...`);
  try {
    const { buildReminderList } = await import("../../agent/modules/reminderBuilder.js");
    const { reminders } = await buildReminderList({ includeDisabled: false });

    const messageMatches = reminders.filter(
      r => r.source === "message" && (r.content || "").toLowerCase().includes(textLower)
    );

    if (messageMatches.length === 1) {
      return await snoozeEmailReminder(messageMatches[0]);
    }
    if (messageMatches.length > 1) {
      log(`[TMDBG Tools] reminder_del: ${messageMatches.length} matching email-reminders found`);
      return {
        error: `Multiple email reminders match '${text}'. Please be more specific.`,
        matches: messageMatches.map(m => m.content),
      };
    }
  } catch (e) {
    log(`[TMDBG Tools] reminder_del: error searching email-reminders: ${e}`, "warn");
  }

  log(`[TMDBG Tools] reminder_del: no matching reminder found for '${text}'`, "warn");
  return { error: `No reminder found matching '${text}'.` };
}

export async function run(args = {}, options = {}) {
  try {
    const rawText = typeof args?.text === "string" ? args.text : "";
    const text = normalizeUnicode(rawText || "").trim();
    if (!text) {
      log(`[TMDBG Tools] reminder_del: missing or empty 'text'`, "error");
      return { error: "missing text" };
    }

    log(`[TMDBG Tools] reminder_del: searching for reminder matching '${text.slice(0, 140)}'`);

    // `statement` is the reminder it deletes. From the Reminders tab, `options.labels` are the labels it
    // showed for it: exactly those are deleted (DS-DISPLAYED), never re-found by text. Otherwise the KB is
    // read, changed and saved in one hold of the prompt store.
    let statement;
    const shownLabels = Array.isArray(options?.labels);
    if (shownLabels) statement = normalizeUnicode(options.labels[0]?.[1] ?? text);
    const refused = shownLabels ? await removeShownItem("kb", "reminder_del", options.labels) : await editText("kb", "reminder_del", (current) => {
      if (!current) {
        log(`[TMDBG Tools] reminder_del: knowledge base is empty, will check email-reminders`, "debug");
      }

      // Find lines matching reminders that contain the search text
      // Supports both old format "- Reminder:" and new format "- [Reminder]"
      const lines = current.split("\n");
      const textLower = text.toLowerCase();
      const matches = [];

      for (const line of lines) {
        const trimmed = line.trim();
        // Match lines that start with "- Reminder:" or "- [Reminder]" (KB list format)
        if (/^-\s*(?:Reminder:|\[Reminder\])/i.test(trimmed)) {
          // Check if the reminder content contains the search text (case-insensitive)
          if (normalizeUnicode(trimmed).toLowerCase().includes(textLower)) {
            // Extract the raw statement (without leading "- ")
            const statement = trimmed.replace(/^-\s*/, "");
            matches.push(statement);
          }
        }
      }

      // No KB match: the email reminders are searched after this hold (they read the KB themselves).
      if (matches.length === 0) return NO_KB_MATCH;

      if (matches.length > 1) {
        log(`[TMDBG Tools] reminder_del: ${matches.length} matching reminders found, returning list for clarification`);
        return {
          error: `Multiple reminders match '${text}'. Please be more specific.`,
          matches: matches.map(m => m.replace(/^(?:Reminder:\s*|\[Reminder\]\s*)/, "")),
        };
      }

      // Exactly one match — delete it
      statement = matches[0];
      log(`[TMDBG Tools] reminder_del: found match, deleting: '${statement.slice(0, 140)}'`);

      const patchText = `DEL\n${statement}`;
      const updated = applyKBPatch(current, patchText);
      if (updated == null || updated === current) {
        log(`[TMDBG Tools] reminder_del: applyKBPatch failed or no change`, "error");
        return { error: "failed to delete reminder from knowledge base" };
      }
      return { save: updated };
    });
    if (refused === NO_KB_MATCH) return await deleteEmailReminder(text);
    if (refused) return refused;

    // Notify listeners
    try {
      const evt = SETTINGS?.events?.userKBPromptUpdated || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "reminder_del_tool" });
    } catch (e) {
      log(`[TMDBG Tools] reminder_del: failed to notify listeners: ${e}`, "warn");
    }

    // Trigger KB reminder update
    try {
      const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
      generateKBReminders(false).catch(e => {
        log(`[TMDBG Tools] reminder_del: failed to trigger KB reminder update: ${e}`, "warn");
      });
    } catch (e) {
      log(`[TMDBG Tools] reminder_del: failed to import/trigger KB reminder update: ${e}`, "warn");
    }

    // Clear reached_out flag for this specific reminder only.
    // Parse the statement the same way kbReminderGenerator does to extract
    // the plain content (without [Reminder]/Due prefix), then hash that.
    try {
      const withDateRegex = /^(?:\[Reminder\]|Reminder:)\s*Due\s+\d{4}\/\d{2}\/\d{2}(?:\s+\d{2}:\d{2})?(?:\s+\[[^\]]+\])?,\s*(.+)$/i;
      const noDueRegex = /^(?:\[Reminder\]|Reminder:)\s*(?!Due\s)(.+)$/i;
      const dateMatch = statement.match(withDateRegex);
      const noDueMatch = statement.match(noDueRegex);
      const reminderContent = (dateMatch?.[1] || noDueMatch?.[1] || "").trim();

      if (reminderContent) {
        const deletedHash = hashReminder({ source: "kb", content: reminderContent });
        const stored = await browser.storage.local.get({ "notifications.reached_out_ids": {} });
        const reachedOutIds = stored["notifications.reached_out_ids"] || {};
        if (reachedOutIds[deletedHash]) {
          delete reachedOutIds[deletedHash];
          await browser.storage.local.set({ "notifications.reached_out_ids": reachedOutIds });
          log(`[TMDBG Tools] reminder_del: cleared reached_out flag for ${deletedHash}`);
        }
      }
    } catch (e) {
      log(`[TMDBG Tools] reminder_del: failed to clear reached_out flags: ${e}`, "warn");
    }

    log(`[TMDBG Tools] reminder_del: success`);
    return { ok: true, removed: statement };
  } catch (e) {
    log(`[TMDBG Tools] reminder_del failed: ${e}`, "error");
    return { error: String(e || "unknown error in reminder_del") };
  }
}

/**
 * Snooze (disable) an email-reminder via the reminder state store.
 * Same mechanism as the GUI "don't show again" button.
 */
async function snoozeEmailReminder(reminder) {
  log(`[TMDBG Tools] reminder_del: found email-reminder, snoozing: '${reminder.content.slice(0, 140)}'`);

  try {
    const { setEnabled } = await import("../../agent/modules/reminderStateStore.js");
    await setEnabled(reminder.hash, false);
  } catch (e) {
    log(`[TMDBG Tools] reminder_del: failed to disable email-reminder: ${e}`, "error");
    return { error: "failed to disable email reminder" };
  }

  log(`[TMDBG Tools] reminder_del: success (email-reminder snoozed)`);
  return { ok: true, snoozed: reminder.content, source: "email" };
}
