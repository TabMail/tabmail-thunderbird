// archive.js – list + archive emails workflow
// Thunderbird 140 MV3

import { ctx } from "../modules/context.js";
import { renderEmailSelectionList, streamText } from "../modules/helpers.js";

import { buildInboxContext } from "../../agent/modules/inboxContext.js";
import { getArchiveFolderForHeader, log } from "../../agent/modules/utils.js";

import { createNewAgentBubble } from "../chat.js";
import { awaitUserInput } from "../modules/converse.js";
import { relayFsmConfirmation, buildEmailListSummary } from "../../chatlink/modules/fsm.js";

export async function runStateArchiveListEmails() {
  const agentBubble = await createNewAgentBubble(
    "Finding emails to archive..."
  );

  let archiveContextArray = [];
  try {
    const pid = ctx.activePid || ctx.activeToolCallId || 0;
    const sess = pid ? (ctx.fsmSessions[pid] ||= {}) : {};
    const overrideIds = Array.isArray(sess.overrideInternalIds)
      ? sess.overrideInternalIds
      : [];
    log(`[TMDBG ArchiveList] Pre-build diagnostic: overrideIds.length=${overrideIds.length}`);
    if (overrideIds.length > 0) {
      log(
        `[TMDBG ArchiveList] Using override internal_ids (count=${overrideIds.length}) to build archive list.`
      );
      const tmp = [];
      for (const id of overrideIds) {
        try {
          const header = await browser.messages.get(id);
          if (!header) {
            log(`[TMDBG ArchiveList] No header for override id=${id}`, "warn");
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
            log(`[TMDBG ArchiveList] Override id=${id} summary: blurb=${!!blurb} todos=${!!todos}`);
          } catch (e) {
            log(`[TMDBG ArchiveList] Failed to fetch summary for override id=${id}: ${e}`, "warn");
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
            action: "archive",
          });
        } catch (e) {
          log(
            `[TMDBG ArchiveList] Failed to fetch header for override id=${id}: ${e}`,
            "warn"
          );
        }
      }
      archiveContextArray = tmp;
    } else {
      const fullContextArray = JSON.parse(await buildInboxContext());
      log(`[TMDBG ArchiveList] buildInboxContext returned ${fullContextArray.length} total items`);
      if (fullContextArray.length > 0) {
        log(`[TMDBG ArchiveList] First item from buildInboxContext:`, "info");
        log(JSON.stringify({
          uniqueId: fullContextArray[0].uniqueId,
          subject: fullContextArray[0].subject,
          action: fullContextArray[0].action,
          hasBlurb: !!fullContextArray[0].blurb,
          hasTodos: !!fullContextArray[0].todos,
          blurbPreview: fullContextArray[0].blurb?.substring(0, 50),
          todosPreview: fullContextArray[0].todos?.substring(0, 50)
        }, null, 2), "info");
      }
      archiveContextArray = fullContextArray.filter(
        (e) => e.action === "archive"
      );
      log(
        `[TMDBG ArchiveList] Found ${archiveContextArray.length} message(s) tagged for archiving.`
      );
      if (archiveContextArray.length > 0) {
        log(`[TMDBG ArchiveList] First ARCHIVED item:`, "info");
        log(JSON.stringify({
          uniqueId: archiveContextArray[0].uniqueId,
          subject: archiveContextArray[0].subject,
          hasBlurb: !!archiveContextArray[0].blurb,
          hasTodos: !!archiveContextArray[0].todos
        }, null, 2), "info");
      }
    }
  } catch (e) {
    log(
      `[TMDBG ArchiveList] Failed to build filtered inbox context: ${e}`,
      "error"
    );
  }

  let assistantText = "";
  if (archiveContextArray.length > 1) {
    assistantText = `${archiveContextArray.length} messages to archive.\n`;
  } else if (archiveContextArray.length === 1) {
    assistantText = "1 message to archive.\n";
  } else {
    assistantText = "No email to archive.\n";
  }

  if (archiveContextArray.length > 0) {
    agentBubble.classList.remove("loading");
    streamText(agentBubble, assistantText);

    try {
      const uiArray = archiveContextArray.map((itm) => ({
        uniqueId: itm.uniqueId,
        messageId: itm.internalId,
        subject: itm.subject,
        from: itm.from,
        date: itm.date || "",
        blurb: itm.blurb || "",
        todos: itm.todos || "",
      }));
      
      // Diagnostic: Log first item to verify data integrity
      if (uiArray.length > 0) {
        log(`[TMDBG ArchiveList] First UI item for tooltip diagnostic:`, "info");
        log(JSON.stringify({
          subject: uiArray[0].subject,
          uniqueId: uiArray[0].uniqueId,
          hasBlurb: !!uiArray[0].blurb,
          blurbLength: uiArray[0].blurb?.length || 0,
          hasTodos: !!uiArray[0].todos,
          todosLength: uiArray[0].todos?.length || 0,
          blurbPreview: uiArray[0].blurb?.substring(0, 50),
          todosPreview: uiArray[0].todos?.substring(0, 50)
        }, null, 2), "info");
      }
      
      ctx.selectedEmailList = uiArray.map((e) => ({
        uniqueId: e.uniqueId,
        messageId: e.messageId, // Keep for backward compatibility
      }));
      window.selectedEmailList = ctx.selectedEmailList;

      const container = document.getElementById("chat-container");
      await renderEmailSelectionList(container, uiArray, { delay: 45 });
    } catch (uiErr) {
      log(`[TMDBG ArchiveList] Failed to render UI: ${uiErr}`, "error");
    }

    assistantText += "[Interactive list of emails to archive]\n\n";
    const confirmBubble = await createNewAgentBubble("Thinking...");
    confirmBubble.classList.remove("loading");
    const bubbleText = "Should I go ahead and archive these emails?";
    streamText(confirmBubble, bubbleText);
    assistantText += bubbleText;

    // Relay confirmation to ChatLink (WhatsApp) if applicable
    try {
      const emailSummary = buildEmailListSummary(archiveContextArray.map(e => ({
        subject: e.subject,
        from: e.from,
      })));
      await relayFsmConfirmation(`${emailSummary}\n\n${bubbleText}`, "yes");
    } catch (e) {
      log(`[ArchiveList] ChatLink relay failed (non-fatal): ${e}`, "warn");
    }

    // Default confirmation suggestion
    try {
      ctx.pendingSuggestion = "yes";
      console.log(
        `[TMDBG ArchiveList] Set pendingSuggestion='${ctx.pendingSuggestion}'`
      );
      if (window.tmShowSuggestion) window.tmShowSuggestion();
    } catch (_) {}

    // Now wait for user input after logging in the action history
    awaitUserInput();
  } else {
    // No emails to archive, move back to the initial state.
    agentBubble.classList.remove("loading");
    streamText(agentBubble, assistantText);

    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid) {
        const sess = (ctx.fsmSessions[pid] ||= {});
        const reason = "The list of emails to archive is empty.";
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

export async function runStateArchiveExecute() {
  const agentBubble = await createNewAgentBubble("Archiving emails...");
  log(
    `[ArchiveExecute] Starting archiving of ${ctx.selectedEmailList.length} email(s).`
  );

  let archivedCount = 0;
  const archiveCache = new Map();

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
              `[ArchiveExecute] Failed to resolve uniqueId '${email.uniqueId}' to internal ID`,
              "warn"
            );
            continue;
          }
        } else {
          log(
            `[ArchiveExecute] Failed to parse uniqueId '${email.uniqueId}'`,
            "warn"
          );
          continue;
        }
      }

      const header = await browser.messages.get(msgId);
      if (!header) {
        log(`[ArchiveExecute] No header for msgId ${msgId}`, "warn");
        continue;
      }

      const acctId = header.folder?.accountId;
      let archiveFolder = archiveCache.get(acctId);
      if (archiveFolder === undefined) {
        archiveFolder = await getArchiveFolderForHeader(header);
        archiveCache.set(acctId, archiveFolder || null);
      }

      if (archiveFolder) {
        await browser.messages.move([msgId], archiveFolder.id, {
          isUserAction: true,
        });
        log(
          `[ArchiveExecute] Moved message ${msgId} to Archive ${archiveFolder.path}.`
        );
        archivedCount++;
      } else {
        log(
          `[ArchiveExecute] Archive folder not found for account ${acctId}; skipping ${msgId}.`,
          "warn"
        );
      }
    } catch (err) {
      log(
        `[ArchiveExecute] Error processing email (uniqueId: ${
          email.uniqueId || "unknown"
        }, msgId: ${email.messageId || "unknown"}): ${err}`,
        "error"
      );
    }
  }

  agentBubble.classList.remove("loading");
  const resultText =
    archivedCount === 0
      ? "No emails were archived."
      : archivedCount === 1
      ? "Archived 1 email."
      : `Archived ${archivedCount} emails.`;
  streamText(agentBubble, resultText);

  ctx.state = "exec_success";
  const core = await import("./core.js");
  await core.executeAgentAction();
}
