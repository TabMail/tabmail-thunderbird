// inbox_read.js – returns formatted inbox context (blurbs only)

import { buildInboxContext } from "../../agent/modules/inboxContext.js";
import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";
import { formatMailList } from "../modules/helpers.js";

// In-memory pagination session for the current user-turn
let inboxSession = null;

function resetSession() {
  inboxSession = null;
}

function getPageSize() {
  const defSize = Number(CHAT_SETTINGS.inboxPageSizeDefault) || 10;
  const maxSize = Number(CHAT_SETTINGS.inboxPageSizeMax) || 50;
  let pageSize = defSize;
  if (!Number.isFinite(pageSize) || pageSize <= 0) pageSize = 10;
  if (pageSize > maxSize) pageSize = maxSize;
  return pageSize;
}

export function resetPaginationSessions() {
  try {
    resetSession();
    log(`[TMDBG Tools] inbox_read: pagination session reset`);
  } catch (_) {}
}

export async function run(args = {}, options = {}) {
  try {
    // Initialize session on first call in a user turn
    if (!inboxSession) {
      const inboxContextJson = await buildInboxContext();
      let items = [];
      try {
        items = JSON.parse(inboxContextJson);
        if (!Array.isArray(items)) items = [];
      } catch (e) {
        log(`[TMDBG Tools] inbox_read: JSON parse failed: ${e}`, "error");
        items = [];
      }
      inboxSession = {
        allItems: items,
        pageSize: getPageSize(),
      };
      log(
        `[TMDBG Tools] inbox_read: session created items=${
          items.length
        } pageSize=${inboxSession.pageSize}`
      );
    }

    const { allItems, pageSize } = inboxSession;
    const totalPages = Math.ceil((allItems.length || 0) / pageSize) || 1;

    const pageIndexArg = Number.isFinite(args?.page_index)
      ? Number(args.page_index)
      : 1;
    const pageIndex = Math.max(0, pageIndexArg - 1); // 0-based index
    const safeIndex = Math.min(pageIndex, totalPages - 1);

    const start = safeIndex * pageSize;
    const end = start + pageSize;
    const pageItems = allItems.slice(start, end);

    const formatted = formatMailList(
      pageItems.map((itm) => ({
        uniqueId: itm?.uniqueId || "",
        subject: itm?.subject || "(No subject)",
        from: itm?.from || "",
        date: itm?.date || "",
        blurb: itm?.blurb || "",
        todos: itm?.todos || "",
        action: itm?.action || "",
        hasAttachments: itm?.hasAttachments || false,
        replied: itm?.replied || false,
      }))
    );
    const footer = `\n----- Page ${safeIndex + 1} of ${totalPages} -----`;
    const result = {
      results: formatted + footer,
      page: safeIndex + 1,
      totalPages: totalPages,
      // pageCount: pageItems.length,
      totalItems: allItems.length,
    };

    log(
      `[TMDBG Tools] inbox_read: returning page ${safeIndex + 1} of ${totalPages} (pageCount=${pageItems.length} totalItems=${allItems.length})`
    );
    return result;
  } catch (e) {
    log(`[TMDBG Tools] inbox_read failed: ${e}`, "error");
    return { error: String(e || "unknown error in inbox_read") };
  }
}


