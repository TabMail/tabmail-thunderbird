// memory_search.js – FTS search for user's memory (past conversations)
// TB 145, MV3

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";

// Maintain per-argument search sessions during a single user turn (mirrors email_search)
let searchSessions = {};

export function resetPaginationSessions() {
  try {
    searchSessions = {};
    log(`[TMDBG Tools] memory_search: pagination sessions reset`);
  } catch (_) {}
}

function normalizeArgs(args = {}) {
  const norm = {
    query: (args?.query || "").trim(),
    from_date: args?.from_date || "",
    to_date: args?.to_date || "",
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

export async function run(args = {}, options = {}) {
  try {
    const norm = normalizeArgs(args);
    const rawQuery = norm.query;

    if (!rawQuery) {
      log(`[TMDBG Tools] memory_search: missing or empty query`, "error");
      return { error: "missing query" };
    }

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

    // Date range handling (same as email_search)
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
    });

    if (!searchSessions[sKey]) {
      log(`[TMDBG Tools] memory_search: using memory FTS backend (new session)`);

      let hits = [];
      try {
        const ignoreDate = !fromDate && !toDate;
        const fromIso = ignoreDate ? "" : fromDate ? fromDate.toISOString() : "";
        const toIso = ignoreDate ? "" : toDate ? toDate.toISOString() : "";
        const t0 = Date.now();

        log(
          `[TMDBG Tools] memory_search: QUERY raw='${String(rawQuery || "").slice(0, 80)}'`
        );
        log(
          `[TMDBG Tools] memory_search: dates from='${fromIso || "-"}' to='${toIso || "-"}' ignoreDate=${ignoreDate} limit=${fetchLimit}`
        );

        // Use memory search via runtime messaging
        hits = await browser.runtime.sendMessage({
          type: "fts",
          cmd: "memorySearch",
          q: rawQuery,
          from: fromIso,
          to: toIso,
          limit: fetchLimit,
          ignoreDate,
        });

        // Check if backend returned an error object instead of array
        if (hits && typeof hits === "object" && hits.error) {
          log(
            `[TMDBG Tools] memory_search: backend returned error: ${hits.error}`,
            "error"
          );
          return { error: `memory search failed: ${hits.error}` };
        }

        // Ensure hits is an array
        if (!Array.isArray(hits)) {
          log(
            `[TMDBG Tools] memory_search: backend returned non-array result: ${typeof hits}`,
            "error"
          );
          return { error: "memory search failed: invalid response format" };
        }

        const dt = Date.now() - t0;
        log(
          `[TMDBG Tools] memory_search: QUERY returned ${hits.length} items in ${dt}ms limit=${fetchLimit}`
        );
      } catch (fe) {
        log(`[TMDBG Tools] memory_search: backend failed: ${fe}`, "error");
        return { error: "memory search failed" };
      }

      // Memory results are already sorted by date DESC, rank ASC from native host

      if (hits.length > fetchLimit) {
        log(
          `[TMDBG Tools] memory_search: truncating collected hits ${hits.length} -> ${fetchLimit} due to fetchLimit`
        );
        hits = hits.slice(0, fetchLimit);
      }

      log(`[TMDBG Tools] memory_search: processed ${hits.length} FTS hits`);

      searchSessions[sKey] = {
        key: sKey,
        hits: hits,
        pageSize,
        total: hits.length,
      };
      log(
        `[TMDBG Tools] memory_search: session created pageSize=${pageSize} totalItems=${hits.length}`
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
        results: "No relevant memories found for this query.",
        page: 1,
        totalPages: 1,
        pageCount: 0,
        totalItems: 0,
      };
    } else {
      // Format results for LLM consumption
      // Each result shows: timestamp (key for memory_read), date, and snippet
      const formatted = slice
        .map((item, idx) => {
          const globalIdx = start + idx + 1;
          const timestamp = item.dateMs || 0;
          const date = timestamp
            ? new Date(timestamp).toLocaleDateString("en-US", {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })
            : "";
          // Use snippet if available (highlighted matches), otherwise truncate content
          const text = item.snippet || (item.content || "").slice(0, 400);
          // Return timestamp as the key for memory_read
          return `${globalIdx}. [timestamp: ${timestamp}] ${date}\n${text}`;
        })
        .join("\n\n");

      result = {
        results: formatted,
        page: safeIndex + 1,
        totalPages: totalPages,
        totalItems: total,
        hint: "Use memory_read with a timestamp value to get the full conversation.",
      };
    }

    if (safeIndex + 1 < totalPages) {
      result.comment = `There are more pages of results. To get the next page, call this tool again with page_index: ${
        safeIndex + 2
      }`;
    }

    log(
      `[TMDBG Tools] memory_search: returning page ${
        safeIndex + 1
      } of ${totalPages} (pageCount=${slice.length} totalItems=${total})`
    );
    return result;
  } catch (e) {
    log(`[TMDBG Tools] memory_search failed: ${e}`, "error");
    return { error: String(e || "unknown error in memory_search") };
  }
}
