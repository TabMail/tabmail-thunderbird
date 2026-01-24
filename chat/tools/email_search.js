// email_search.js – FTS search with optional date range and limit

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";
import { formatMailList } from "../modules/helpers.js";

// Maintain per-argument search sessions during a single user turn
let searchSessions = {};

export function resetPaginationSessions() {
  try {
    searchSessions = {};
    log(`[TMDBG Tools] email_search: pagination sessions reset`);
  } catch (_) {}
}

function normalizeArgs(args = {}) {
  const norm = {
    query: (args?.query || "").trim(),
    from_date: args?.from_date || "",
    to_date: args?.to_date || "",
    sort: args?.sort === "date_asc" ? "date_asc" : 
          args?.sort === "date_desc" ? "date_desc" : 
          args?.sort === "relevance" ? "relevance" : "date_desc",
  };
  return norm;
}

function sessionKey(args) {
  const norm = normalizeArgs(args);
  return JSON.stringify(norm);
}

function resolvePageSize() {
  const defSize = Number(CHAT_SETTINGS.searchPageSizeDefault) || 5;
  const maxSize = Number(CHAT_SETTINGS.searchPageSizeMax) || 50;
  let size = defSize;
  if (!Number.isFinite(size) || size <= 0) size = 5;
  if (size > maxSize) size = maxSize;
  return size;
}

// Email search using FTS (Full Text Search) backend only

export async function run(args = {}, options = {}) {
  try {
    const norm = normalizeArgs(args);
    const rawQuery = norm.query;
    const sort = norm.sort;
    const pageSize = resolvePageSize();
    const prefetchPages = Math.max(
      1,
      Number(CHAT_SETTINGS.searchPrefetchPagesDefault) || 4
    );
    const prefetchMax = Math.max(
      1,
      Number(CHAT_SETTINGS.searchPrefetchMaxResults) || 200
    );
    const fetchLimit = Math.min(pageSize * prefetchPages, prefetchMax);

    // Date range handling
    const toDateStr = norm.to_date || "";
    const fromDateStr = norm.from_date || "";
    let toDate = null;
    let fromDate = null;
    if (toDateStr) {
      const t = new Date(toDateStr);
      if (!Number.isNaN(t.getTime())) toDate = t;
    }
    if (fromDateStr) {
      const f = new Date(fromDateStr);
      if (!Number.isNaN(f.getTime())) fromDate = f;
    }

    const sKey = sessionKey({
      query: norm.query,
      from_date: norm.from_date,
      to_date: norm.to_date,
      sort: norm.sort,
    });
    if (!searchSessions[sKey]) {
      log(`[TMDBG Tools] email_search: using FTS search backend (new session)`);
      
      let hits = [];
      try {
        const ignoreDate = (!fromDate && !toDate); // Ignore date filtering when no dates provided
        const fromIso = ignoreDate ? "" : fromDate ? fromDate.toISOString() : "";
        const toIso = ignoreDate ? "" : toDate ? toDate.toISOString() : "";
        const t0 = Date.now();
        
        log(
          `[TMDBG Tools] email_search: FTS QUERY raw='${String(rawQuery||"").slice(0,80)}'`
        );
        log(
          `[TMDBG Tools] email_search: effective dates from_date='${norm.from_date}' to_date='${norm.to_date}' → fromIso='${fromIso || "-"}' toIso='${toIso || "-"}' ignoreDate=${ignoreDate} limit=${fetchLimit}`
        );
        
        // Use FTS search via runtime messaging
        hits = await browser.runtime.sendMessage({
          type: "fts",
          cmd: "search",
          q: rawQuery,
          from: fromIso,
          to: toIso,
          limit: fetchLimit,
          ignoreDate
        });
        
        // Check if FTS backend returned an error object instead of array
        if (hits && typeof hits === 'object' && hits.error) {
          log(`[TMDBG Tools] email_search: FTS backend returned error: ${hits.error}`, "error");
          return { error: `fts search failed: ${hits.error}` };
        }
        
        // Ensure hits is an array
        if (!Array.isArray(hits)) {
          log(`[TMDBG Tools] email_search: FTS backend returned non-array result: ${typeof hits}`, "error");
          return { error: "fts search failed: invalid response format" };
        }
        
        const dt = Date.now() - t0;
        log(
          `[TMDBG Tools] email_search: FTS QUERY returned ${hits.length} items in ${dt}ms (from='${fromIso || "-"}' to='${
            toIso || "-"
          }') limit=${fetchLimit}`
        );
        
      } catch (fe) {
        log(`[TMDBG Tools] email_search: FTS backend failed: ${fe}`, "error");
        return { error: "fts search failed" };
      }

      // Sort collected hits based on sort option
      if (sort === "relevance") {
        // Keep FTS relevance ordering (already sorted by rank ASC, then date DESC)
        log(`[TMDBG Tools] email_search: preserving FTS relevance ordering`);
      } else {
        // Sort by date only
        hits.sort((a, b) => {
          const da = a.dateMs || 0;
          const db = b.dateMs || 0;
          return sort === "date_asc" ? da - db : db - da;
        });
        log(`[TMDBG Tools] email_search: sorted by date (${sort})`);
      }

      if (hits.length > fetchLimit) {
        log(
          `[TMDBG Tools] email_search: truncating collected hits ${hits.length} -> ${fetchLimit} due to fetchLimit`
        );
        hits = hits.slice(0, fetchLimit);
      }

      log(
        `[TMDBG Tools] email_search: processed ${hits.length} FTS hits`
      );

      searchSessions[sKey] = {
        key: sKey,
        hits: hits,
        pageSize,
        total: hits.length,
      };
      log(
        `[TMDBG Tools] email_search: session created pageSize=${pageSize} totalItems=${hits.length}`
      );
    }

    const session = searchSessions[sKey];
    const { hits, pageSize: pSize, total } = session;
    const totalPages = Math.max(1, Math.ceil((total || 0) / pSize));

    const pageIndexArg = Number.isFinite(args?.page_index)
      ? Number(args.page_index)
      : 1;
    const pageIndex = Math.max(0, pageIndexArg - 1); // 0-based index
    const safeIndex = Math.min(pageIndex, totalPages - 1);

    const start = safeIndex * pSize;
    const end = start + pSize;
    const slice = hits.slice(start, end);

    // Check if there are no results at all
    let result = null;
    if (total === 0) {
      result = {
        results: "No emails found with the query. Use a different query.",
        page: 1,
        totalPages: 1,
        pageCount: 0,
        totalItems: 0,
      };
    } else {
      // Map FTS hits directly to formatMailList format - use uniqueId directly from FTS
      const formatted = formatMailList(
        slice.map((hit) => ({
          uniqueId: hit.uniqueId || "", // Use uniqueId directly from FTS (msgId = folderUri:headerID)
          date: hit.dateMs ? new Date(hit.dateMs).toISOString() : "",
          from: hit.author || "",
          subject: hit.subject || "(No subject)",
          hasAttachments: Boolean(hit.hasAttachments),
          snippet: hit.snippet || "",
          // Search results always return empty for these fields
          action: "",
          todos: "",
          blurb: ""
        }))
      );
      result = {
        results: formatted,
        page: safeIndex + 1,
        totalPages: totalPages,
        // pageCount: slice.length,
        totalItems: total,
      };
    }

    if (safeIndex + 1 < totalPages) {
      result.comment = `There are more pages of results. To get the next page, call this tool again with page_index: ${
        safeIndex + 2
      }`;
    }

    log(
      `[TMDBG Tools] email_search: returning page ${
        safeIndex + 1
      } of ${totalPages} (pageCount=${slice.length} totalItems=${total})`
    );
    return result;
  } catch (e) {
    log(`[TMDBG Tools] email_search failed: ${e}`, "error");
    return { error: String(e || "unknown error in email_search") };
  }
}
