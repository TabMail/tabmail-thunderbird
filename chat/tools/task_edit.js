// task_edit.js – edit an existing [Task] entry in user_kb.md (TB 145, MV3)
// Finds the task by substring match, then replaces with updated values.
// Only provided fields are changed; omitted fields keep their current values.

import { SETTINGS } from "../../agent/modules/config.js";
import { applyKBPatch } from "../../agent/modules/patchApplier.js";
import { getUserKBPrompt } from "../../agent/modules/promptGenerator.js";
import { log, normalizeUnicode } from "../../agent/modules/utils.js";

const TASK_SCHEDULE_REGEX = /^\[Task\]\s*Schedule\s+([\w,]+)\s+(\d{2}:\d{2})(?:\s+\[([^\]]+)\])?,\s*(.+)$/i;
const TASK_ONCE_REGEX = /^\[Task\]\s*Once\s+(\d{4}\/\d{2}\/\d{2})\s+(\d{2}:\d{2})(?:\s+\[([^\]]+)\])?,\s*(.+)$/i;

export async function run(args = {}, options = {}) {
  try {
    const findText = normalizeUnicode(typeof args?.find_text === "string" ? args.find_text : "").trim();
    if (!findText) {
      return { error: "missing find_text" };
    }

    // Load current KB and find matching task
    const current = (await getUserKBPrompt()) || "";
    const lines = current.split("\n");
    const findLower = findText.toLowerCase();
    const matches = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^(?:-\s*)?\[Task\]/i.test(trimmed) && trimmed.toLowerCase().includes(findLower)) {
        matches.push(trimmed);
      }
    }

    if (matches.length === 0) {
      return { error: `No scheduled task found matching '${findText}'.` };
    }
    if (matches.length > 1) {
      return {
        error: `Multiple tasks match '${findText}'. Please be more specific.`,
        matches: matches.map(m => m.replace(/^-\s*/, "").replace(/^\[Task\]\s*/, "")),
      };
    }

    const oldLine = matches[0];
    const oldStatement = oldLine.replace(/^-\s*/, "");

    // Parse the existing task to extract current values
    let currentDays = null, currentDate = null, currentTime = null, currentTz = null, currentInstruction = null;
    let isOneOff = false;

    const schedMatch = oldStatement.match(TASK_SCHEDULE_REGEX);
    const onceMatch = oldStatement.match(TASK_ONCE_REGEX);

    if (schedMatch) {
      currentDays = schedMatch[1];
      currentTime = schedMatch[2];
      currentTz = schedMatch[3] || null;
      currentInstruction = schedMatch[4].trim();
    } else if (onceMatch) {
      isOneOff = true;
      currentDate = onceMatch[1];
      currentTime = onceMatch[2];
      currentTz = onceMatch[3] || null;
      currentInstruction = onceMatch[4].trim();
    } else {
      return { error: "Could not parse the existing task format." };
    }

    // Apply updates — only change provided fields
    const newInstruction = args.text ? normalizeUnicode(args.text).trim() : currentInstruction;
    const newTime = args.schedule_time || currentTime;
    const newTz = currentTz || Intl.DateTimeFormat().resolvedOptions().timeZone;

    let newEntry;
    if (args.schedule_date) {
      // Switching to one-off
      newEntry = `[Task] Once ${args.schedule_date} ${newTime} [${newTz}], ${newInstruction}`;
    } else if (args.schedule_days) {
      // Switching to or keeping recurring
      newEntry = `[Task] Schedule ${args.schedule_days} ${newTime} [${newTz}], ${newInstruction}`;
    } else if (isOneOff) {
      // Keeping one-off
      newEntry = `[Task] Once ${currentDate} ${newTime} [${newTz}], ${newInstruction}`;
    } else {
      // Keeping recurring
      newEntry = `[Task] Schedule ${currentDays} ${newTime} [${newTz}], ${newInstruction}`;
    }

    // Apply as DEL + ADD
    const delPatch = `DEL\n${oldStatement}`;
    const afterDel = applyKBPatch(current, delPatch);
    if (afterDel == null || afterDel === current) {
      return { error: "Failed to remove old task entry." };
    }
    const addPatch = `ADD\n${newEntry}`;
    const updated = applyKBPatch(afterDel, addPatch);
    if (updated == null) {
      return { error: "Failed to add updated task entry." };
    }

    // Persist
    try {
      await browser.storage.local.set({ "user_prompts:user_kb.md": updated });
    } catch (e) {
      return { error: "Failed to persist knowledge base." };
    }

    // Notify listeners
    try {
      const evt = SETTINGS?.events?.userKBPromptUpdated || "user-kb-prompt-updated";
      await browser.runtime.sendMessage({ command: evt, key: "user_prompts:user_kb.md", source: "task_edit_tool" });
    } catch (e) {
      log(`[TMDBG Tools] task_edit: notify failed: ${e}`, "warn");
    }

    // Trigger KB re-parse
    try {
      const { generateKBReminders } = await import("../../agent/modules/kbReminderGenerator.js");
      generateKBReminders(false).catch(() => {});
    } catch {}
    // Clear execution state — the edited task should fire fresh at its new time
    try {
      const { getTaskHash } = await import("../../agent/modules/kbTaskParser.js");
      const { clearExecutionState } = await import("../../agent/modules/taskScheduler.js");
      // Clear for both old and new hash (instruction may have changed)
      const oldHash = getTaskHash({ instruction: currentInstruction, rawLine: oldStatement });
      const newHash = getTaskHash({ instruction: newInstruction, rawLine: newEntry });
      await clearExecutionState(oldHash);
      if (newHash !== oldHash) await clearExecutionState(newHash);
    } catch (e) {
      log(`[TMDBG Tools] task_edit: clear exec state failed: ${e}`, "warn");
    }

    log(`[TMDBG Tools] task_edit: success — '${oldStatement.slice(0, 60)}' → '${newEntry.slice(0, 60)}'`);
    return { ok: true, previous: oldStatement, updated: newEntry };
  } catch (e) {
    log(`[TMDBG Tools] task_edit failed: ${e}`, "error");
    return { error: String(e || "unknown error in task_edit") };
  }
}
