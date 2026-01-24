// delete.js – list + delete emails workflow
// Thunderbird 140 MV3

import { ctx } from "../modules/context.js";
import { renderEmailSelectionList, streamText } from "../modules/helpers.js";

import { buildInboxContext } from "../../agent/modules/inboxContext.js";
import { getTrashFolderForHeader, log } from "../../agent/modules/utils.js";

import { createNewAgentBubble } from "../chat.js";
import { awaitUserInput } from "../modules/converse.js";

export async function runStateDeleteListEmails() {
  const agentBubble = await createNewAgentBubble("Finding emails to delete...");

  let deleteContextArray = [];
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    const overrideIds = Array.isArray(sess.overrideInternalIds)
      ? sess.overrideInternalIds
      : [];
    if (overrideIds.length > 0) {
      log(
        `[TMDBG DeleteList] Using override internal_ids (count=${overrideIds.length}) to build delete list.`
      );
      const tmp = [];
      for (const id of overrideIds) {
        try {
          const header = await browser.messages.get(id);
          if (!header) {
            log(`[TMDBG DeleteList] No header for override id=${id}`, "warn");
            continue;
          }
          
          // Generate uniqueId for the header
          const { getUniqueMessageKey } = await import("../../agent/modules/utils.js");
          const uniqueId = await getUniqueMessageKey(header);
          
          // Fetch summary if available (cache-only, don't generate)
          let blurb = "";
          let todos = "";
          try {
            const { getSummary } = await import("../../agent/modules/summaryGenerator.js");
            const summaryObj = await getSummary(header, false, true); // cache only
            blurb = summaryObj?.blurb || "";
            todos = summaryObj?.todos || "";
            log(`[TMDBG DeleteList] Override id=${id} summary: blurb=${!!blurb} todos=${!!todos}`);
          } catch (e) {
            log(`[TMDBG DeleteList] Failed to fetch summary for override id=${id}: ${e}`, "warn");
          }
          
          const dateStr = (() => {
            try {
              return new Date(header.date).toLocaleString();
            } catch (_) {
              return "";
            }
          })();
          
          tmp.push({
            uniqueId: uniqueId,
            internalId: id,
            subject: header?.subject || "(No subject)",
            from: header?.author || "",
            date: dateStr,
            blurb: blurb,
            todos: todos,
            action: "delete",
          });
        } catch (e) {
          log(
            `[TMDBG DeleteList] Failed to fetch header for override id=${id}: ${e}`,
            "warn"
          );
        }
      }
      deleteContextArray = tmp;
    } else {
      const fullContextArray = JSON.parse(await buildInboxContext());
      deleteContextArray = fullContextArray.filter(
        (e) => e.action === "delete"
      );
      log(
        `[TMDBG DeleteList] Found ${deleteContextArray.length} message(s) tagged for deletion.`
      );
    }
  } catch (e) {
    log(
      `[TMDBG DeleteList] Failed to build filtered inbox context: ${e}`,
      "error"
    );
  }

  let assistantText = "";
  if (deleteContextArray.length > 1) {
    assistantText = `${deleteContextArray.length} messages to delete.\n`;
  } else if (deleteContextArray.length === 1) {
    assistantText = "1 message to delete.\n";
  } else {
    assistantText = "No email selected for deletion.\n";
  }

  if (deleteContextArray.length > 0) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, assistantText);

    try {
      const uiArray = deleteContextArray.map((itm) => ({
        uniqueId: itm.uniqueId,
        messageId: itm.internalId,
        subject: itm.subject,
        from: itm.from,
        date: itm.date || "",
        blurb: itm.blurb || "",
        todos: itm.todos || "",
      }));

      ctx.selectedEmailList = uiArray.map((e) => ({
        uniqueId: e.uniqueId,
        messageId: e.messageId, // Keep for backward compatibility
      }));
      window.selectedEmailList = ctx.selectedEmailList;

      const container = document.getElementById("chat-container");
      await renderEmailSelectionList(container, uiArray, { delay: 45 });
    } catch (uiErr) {
      log(`[TMDBG DeleteList] Failed to render UI: ${uiErr}`, "error");
    }

    assistantText += "[Interactive list of emails to delete]\n\n";

    const confirmBubble = await createNewAgentBubble("Thinking...");
    confirmBubble.classList.remove("loading");
    const bubbleText = "Should I go ahead and delete these emails?";
    streamText(confirmBubble, bubbleText);
    assistantText += bubbleText;

    // Default confirmation suggestion
    try {
      ctx.pendingSuggestion = "yes";
      console.log(
        `[TMDBG DeleteList] Set pendingSuggestion='${ctx.pendingSuggestion}'`
      );
      if (window.tmShowSuggestion) window.tmShowSuggestion();
    } catch (_) {}

    awaitUserInput();
  } else {
    // No emails to delete, move back to the initial state.
    agentBubble.classList.remove("loading");
    streamText(agentBubble, assistantText);

    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) {
        const sess = (ctx.fsmSessions[pid] ||= {});
        const reason = "The list of emails to delete is empty.";
        sess.failReason = reason;
      }
    } catch (_) {}
    try {
      ctx.state = "exec_fail";
    } catch (_) {}
    try {
      const core = await import("./core.js");
      await core.executeAgentAction();
    } catch (_) {}
  }
}

export async function runStateDeleteExecute() {
  const agentBubble = await createNewAgentBubble("Deleting emails...");
  log(
    `[DeleteExecute] Starting deletion of ${ctx.selectedEmailList.length} email(s).`
  );

  let deletedCount = 0;
  const trashCache = new Map();

  for (const email of ctx.selectedEmailList) {
    try {
      // Resolve uniqueId to internal weID if needed
      let msgId = email.messageId; // Backward compatibility
      if (!msgId && email.uniqueId) {
        const { parseUniqueId, headerIDToWeID } = await import("../../agent/modules/utils.js");
        const parsed = parseUniqueId(email.uniqueId);
        if (parsed) {
          msgId = await headerIDToWeID(parsed.headerID, parsed.weFolder);
          if (!msgId) {
            log(
              `[DeleteExecute] Failed to resolve uniqueId '${email.uniqueId}' to internal ID`,
              "warn"
            );
            continue;
          }
        } else {
          log(
            `[DeleteExecute] Failed to parse uniqueId '${email.uniqueId}'`,
            "warn"
          );
          continue;
        }
      }

      const header = await browser.messages.get(msgId);
      if (!header) {
        log(`[DeleteExecute] No header for msgId ${msgId}`, "warn");
        continue;
      }

      const acctId = header.folder?.accountId;
      let trashFolder = trashCache.get(acctId);
      if (trashFolder === undefined) {
        trashFolder = await getTrashFolderForHeader(header);
        trashCache.set(acctId, trashFolder || null);
      }

      if (trashFolder) {
        await browser.messages.move([msgId], trashFolder.id, {
          isUserAction: true,
        });
        log(
          `[DeleteExecute] Moved message ${msgId} to Trash ${trashFolder.path}.`
        );
        deletedCount++;
      } else {
        log(
          `[DeleteExecute] Trash folder not found for account ${acctId}; skipping ${msgId}.`,
          "warn"
        );
      }
    } catch (err) {
      log(
        `[DeleteExecute] Error processing email (uniqueId: ${
          email.uniqueId || "unknown"
        }, msgId: ${email.messageId || "unknown"}): ${err}`,
        "error"
      );
    }
  }

  agentBubble.classList.remove("loading");
  const resultText =
    deletedCount === 0
      ? "No emails were deleted."
      : deletedCount === 1
      ? "Deleted 1 email."
      : `Deleted ${deletedCount} emails.`;
  streamText(agentBubble, resultText);

  ctx.state = "exec_success";
  const core = await import("./core.js");
  await core.executeAgentAction();
}
