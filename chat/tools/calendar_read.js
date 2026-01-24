// calendar_read.js – wrapper that delegates to calendar_search without a query

import { log } from "../../agent/modules/utils.js";
import * as searchCalendar from "./calendar_search.js";

export function resetPaginationSessions() {
  try {
    searchCalendar.resetPaginationSessions();
    log(`[TMDBG Tools] calendar_read: pagination sessions reset`);
  } catch (_) {}
}

export async function run(args = {}, options = {}) {
  try {
    const forwarded = { ...args };
    if (typeof forwarded.query !== "undefined") {
      delete forwarded.query;
    }
    log(`[TMDBG Tools] calendar_read: delegating to calendar_search with query suppressed`);
    const innerOptions = { ...(options || {}), __bypassQueryRequirement: true };
    return await searchCalendar.run(forwarded, innerOptions);
  } catch (e) {
    log(`[TMDBG Tools] calendar_read failed: ${e}`, "error");
    return { error: String(e || "unknown error in calendar_read") };
  }
}



