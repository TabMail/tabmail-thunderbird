/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// memory_search.js – FTS search for user's memory (past conversations)
// TB 145, MV3

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";
import { ftsRequest } from "../../fts/ftsRequest.js";

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

export { normalizeArgs as _testNormalizeArgs, sessionKey as _testSessionKey, resolvePageSize as _testResolvePageSize };

/**
 * A date the model gave, in ms (the helper includes both bounds); null when it
 * isn't one. A day alone is the user's local day, as `time_delta` gives it:
 * from its start or, as the end of a range, through its last millisecond (the
 * next day's start less 1 ms, which holds where daylight saving skips midnight).
 */
function dateBoundMs(text, end) {
  if (!text) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (day) {
    const [year, month, date] = [Number(day[1]), Number(day[2]) - 1, Number(day[3])];
    const start = new Date(year, month, date);
    // A day that doesn't exist (month 13, February 30) is no date, not the next one.
    if (start.getFullYear() !== year || start.getMonth() !== month || start.getDate() !== date) return null;
    return end ? new Date(year, month, date + 1).getTime() - 1 : start.getTime();
  }
  const ms = new Date(text).getTime();
  return Number.isNaN(ms) ? null : ms;
}

/** The most turns one search gives, a listing too (memorySearchMaxResults). */
function searchMax() {
  return Math.max(1, Number(CHAT_SETTINGS.memorySearchMaxResults) || 1);
}

/** Characters shown of each turn, and asked of the helper (memoryPreviewChars). */
function previewChars() {
  return Math.max(1, Number(CHAT_SETTINGS.memoryPreviewChars) || 1);
}

/**
 * One memorySearch request to the helper. Retries while no listener answers
 * (FTS engine not yet initialized / hot-reload race); a real result, an empty
 * array or an `{error}` object ends the wait. Returns `{ hits }` or `{ error }`.
 */
async function requestMemory({ q, from, to, limit }) {
  const ignoreDate = from === null && to === null;
  log(
    `[TMDBG Tools] memory_search: QUERY raw='${String(q || "").slice(0, 80)}' from=${from ?? "-"} to=${to ?? "-"} ignoreDate=${ignoreDate} limit=${limit}`
  );
  const t0 = Date.now();
  let hits;
  try {
    const readyTimeoutMs = Math.max(
      0,
      Number(CHAT_SETTINGS.ftsReadinessTimeoutMs) || 0
    );
    const readyRetryDelayMs = Math.max(
      1,
      Number(CHAT_SETTINGS.ftsReadinessRetryDelayMs) || 250
    );
    const readyDeadline = Date.now() + readyTimeoutMs;
    let readyAttempts = 0;
    // Actively kick a helper reconnect probe (cooldown-guarded in the
    // background) so the engine self-heals while we poll below.
    // Fire-and-forget; always the FIRST fts message this call sends.
    try {
      browser.runtime.sendMessage({ type: "fts", cmd: "getFtsAvailability" }).catch(() => {});
    } catch (_) {}
    // Headless runs call this in the background, which owns the helper; a
    // message it sends would never reach its own FTS handler. There a failed
    // search answers { error }, as the handler answers a page, instead of
    // throwing into the not-ready retry below.
    const fields = { q, from: from ?? "", to: to ?? "", limit, ignoreDate, previewChars: previewChars() };
    const search = async ({ memorySearch }) => {
      try {
        return await memorySearch.search(fields.q, fields);
      } catch (e) {
        return { error: String(e?.message || e) };
      }
    };
    while (true) {
      readyAttempts += 1;
      try {
        hits = await ftsRequest("memorySearch", fields, search);
      } catch (sendErr) {
        // Thrown sendMessage (no receiving end yet) == not ready: retry
        // until the deadline instead of failing the tool call instantly.
        log(`[TMDBG Tools] memory_search: FTS message send failed (attempt ${readyAttempts}): ${sendErr}`);
        hits = undefined;
      }
      if (typeof hits !== "undefined") break;
      if (Date.now() >= readyDeadline) {
        log(
          `[TMDBG Tools] memory_search: FTS backend not ready after ${readyAttempts} attempts (${readyTimeoutMs}ms budget) — giving up`,
          "error"
        );
        break;
      }
      log(
        `[TMDBG Tools] memory_search: FTS backend not ready (attempt ${readyAttempts}) — retrying in ${readyRetryDelayMs}ms`
      );
      await new Promise((r) => setTimeout(r, readyRetryDelayMs));
    }
  } catch (fe) {
    log(`[TMDBG Tools] memory_search: backend failed: ${fe}`, "error");
    return { error: "memory search failed" };
  }

  // Check if backend returned an error object instead of array
  if (hits && typeof hits === "object" && hits.error) {
    log(`[TMDBG Tools] memory_search: backend returned error: ${hits.error}`, "error");
    return { error: `memory search failed: ${hits.error}` };
  }
  if (!Array.isArray(hits)) {
    log(`[TMDBG Tools] memory_search: backend returned non-array result: ${typeof hits}`, "error");
    return { error: "memory search failed: invalid response format" };
  }
  log(`[TMDBG Tools] memory_search: QUERY returned ${hits.length} items in ${Date.now() - t0}ms limit=${limit}`);
  return { hits };
}

/**
 * Fetches a listing's next few turns (`memoryListFetchRows`): the newest older
 * than (or as old as) the last one listed, skipping those already listed at that
 * same millisecond, and one more to tell whether any follow. A few turns per
 * request keep a reply far below the 1 MiB that Thunderbird allows one native
 * message (an over-cap reply disconnects the helper). A listing ends at
 * `searchMax()` turns, as a search does, so a far page asked for never lists the
 * whole memory. Returns an error message, or null.
 */
async function fetchListingRows(session) {
  const { hits, from, to } = session;
  const rows = Math.max(1, Number(CHAT_SETTINGS.memoryListFetchRows) || 1);
  const last = hits[hits.length - 1];
  const cursor = last ? last.dateMs : null;
  const listedAtCursor = new Set(
    hits.filter((h) => h.dateMs === cursor).map((h) => h.memId)
  );
  const limit = rows + listedAtCursor.size + 1;
  const result = await requestMemory({
    q: "",
    from,
    to: cursor === null ? to : cursor,
    limit,
  });
  if (result.error) return result.error;
  const fresh = result.hits.filter((h) => !listedAtCursor.has(h.memId));
  const max = searchMax();
  hits.push(...fresh.slice(0, Math.min(rows, max - hits.length)));
  if (fresh.length <= rows || hits.length >= max) session.done = true;
  return null;
}

export async function run(args = {}, options = {}) {
  try {
    const norm = normalizeArgs(args);
    // An empty query lists the most recent conversations, newest first (the
    // helper's memorySearch does that for an empty q): "what have we discussed".
    const rawQuery = norm.query;
    const pageSize = resolvePageSize();
    const fromMs = dateBoundMs(norm.from_date, false);
    const toMs = dateBoundMs(norm.to_date, true);

    const sKey = sessionKey({
      query: norm.query,
      from_date: norm.from_date,
      to_date: norm.to_date,
    });

    if (!searchSessions[sKey]) {
      log(`[TMDBG Tools] memory_search: using memory FTS backend (new session)`);
      if (rawQuery) {
        const fetchLimit = searchMax();
        const result = await requestMemory({ q: rawQuery, from: fromMs, to: toMs, limit: fetchLimit });
        if (result.error) return { error: result.error };
        // Memory results come ranked by the native host, best first
        let hits = result.hits;
        if (hits.length > fetchLimit) {
          log(
            `[TMDBG Tools] memory_search: truncating collected hits ${hits.length} -> ${fetchLimit} due to fetchLimit`
          );
          hits = hits.slice(0, fetchLimit);
        }
        searchSessions[sKey] = { key: sKey, hits, pageSize, done: true };
      } else {
        // A listing has no relevance cut, so it is fetched a few turns at a time.
        searchSessions[sKey] = {
          key: sKey,
          hits: [],
          pageSize,
          from: fromMs,
          to: toMs,
          done: false,
          fetching: Promise.resolve(null),
        };
      }
      log(`[TMDBG Tools] memory_search: session created pageSize=${pageSize}`);
    }

    const session = searchSessions[sKey];
    const pSize = session.pageSize;
    const pageIndexArg = Number.isFinite(args?.page_index)
      ? Number(args.page_index)
      : 1;
    const pageIndex = Math.max(0, pageIndexArg - 1); // 0-based index

    if (!session.done) {
      // Fetch until the asked page is listed. Calls in the same session take
      // turns, so none lists a page twice.
      session.fetching = session.fetching.catch(() => null).then(async () => {
        while (!session.done && session.hits.length < (pageIndex + 1) * pSize) {
          const error = await fetchListingRows(session);
          if (error) return error;
        }
        return null;
      });
      const error = await session.fetching;
      if (error) return { error };
    }

    const { hits, done } = session;
    const knownPages = Math.max(1, Math.ceil(hits.length / pSize));
    const safeIndex = Math.min(pageIndex, knownPages - 1);
    const start = safeIndex * pSize;
    const slice = hits.slice(start, start + pSize);
    const hasMore = hits.length > start + pSize || !done;

    let result = null;
    if (hits.length === 0) {
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
          const text = item.snippet || (item.content || "").slice(0, previewChars());
          // Return timestamp as the key for memory_read
          return `${globalIdx}. [timestamp: ${timestamp}] ${date}\n${text}`;
        })
        .join("\n\n");

      result = {
        results: formatted,
        page: safeIndex + 1,
        hint: "Use memory_read with a timestamp value to get the full conversation.",
      };
      // A listing knows its size only once it has fetched its last page.
      if (done) {
        result.totalPages = knownPages;
        result.totalItems = hits.length;
      }
    }

    if (hasMore) {
      result.comment = `There are more pages of results. To get the next page, call this tool again with page_index: ${
        safeIndex + 2
      }`;
    }

    log(
      `[TMDBG Tools] memory_search: returning page ${safeIndex + 1} (pageCount=${slice.length} listed=${hits.length} done=${done})`
    );
    return result;
  } catch (e) {
    log(`[TMDBG Tools] memory_search failed: ${e}`, "error");
    return { error: String(e || "unknown error in memory_search") };
  }
}
