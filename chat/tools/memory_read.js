/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// memory_read.js – Read full conversation around a timestamp
// TB 145, MV3

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";

// Default tolerance: 10 minutes (600,000 ms)
const DEFAULT_TOLERANCE_MS = 600000;

/**
 * Lists the entries within the window, oldest first, without their content:
 * Thunderbird refuses a native message over 1 MiB, and memory entries are
 * stored whole, so a reply of whole entries can pass it. The helper lists
 * newest first, a page at a time (`memoryReadListRows`, with the shortest
 * preview); each page starts at the last date listed and skips the entries
 * already listed at it. Listing stops once `maxTurns` entries at or before the
 * timestamp are in: every entry after it is listed by then, and no centered
 * slice of `maxTurns` reaches an entry farther from it. (Entries sharing the
 * timestamp's own millisecond can take more of the slice than older ones.)
 */
async function listWindow(timestamp, toleranceMs, maxTurns) {
  const listed = [];
  let to = timestamp + toleranceMs;
  let listedAtCursor = new Set();
  while (true) {
    const limit = CHAT_SETTINGS.memoryReadListRows + listedAtCursor.size;
    const page = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "memorySearch",
      q: "",
      from: timestamp - toleranceMs,
      to,
      limit,
      ignoreDate: false,
      previewChars: CHAT_SETTINGS.memoryReadListPreviewChars,
    });
    if (!Array.isArray(page)) {
      throw new Error(page?.error || "invalid response format");
    }
    listed.push(...page.filter((entry) => !listedAtCursor.has(entry.memId)));
    // Fewer than asked: the window is listed.
    if (page.length < limit) break;
    if (listed.filter((entry) => entry.dateMs <= timestamp).length >= maxTurns) break;
    const cursor = page[page.length - 1].dateMs;
    if (cursor !== to) listedAtCursor = new Set();
    for (const entry of page) {
      if (entry.dateMs === cursor) listedAtCursor.add(entry.memId);
    }
    to = cursor;
  }
  return listed.reverse();
}

/**
 * Reads the entries whole, each at its own millisecond (picked by its id), so
 * a reply holds one entry or the few written at that millisecond. One removed
 * since the listing is left out.
 */
async function readWhole(entries) {
  const byDate = new Map();
  for (const entry of entries) {
    if (!byDate.has(entry.dateMs)) byDate.set(entry.dateMs, null);
  }
  await Promise.all([...byDate.keys()].map(async (dateMs) => {
    const rows = await browser.runtime.sendMessage({
      type: "fts",
      cmd: "memoryRead",
      timestampMs: dateMs,
      toleranceMs: 0,
    });
    if (!Array.isArray(rows)) {
      throw new Error(rows?.error || "invalid response format");
    }
    byDate.set(dateMs, rows);
  }));
  return entries
    .map((entry) => byDate.get(entry.dateMs).find((row) => row.memId === entry.memId))
    .filter(Boolean);
}

export async function run(args = {}, options = {}) {
  try {
    const timestamp = args?.timestamp;
    const toleranceMinutes = Number(args?.tolerance_minutes);
    const toleranceMs = toleranceMinutes > 0
      ? toleranceMinutes * 60 * 1000
      : DEFAULT_TOLERANCE_MS;
    // A max_turns that is not a number gets the default, as iOS and Voice do.
    const maxTurns = Math.min(
      (args?.max_turns ? Math.max(1, Math.floor(Number(args.max_turns))) : 20) || 20,
      CHAT_SETTINGS.memoryReadMaxTurns
    );

    log(
      `[TMDBG Tools] memory_read: timestamp=${timestamp} tolerance=${toleranceMs}ms maxTurns=${maxTurns}`
    );

    if (!timestamp || typeof timestamp !== "number") {
      log(
        `[TMDBG Tools] memory_read: invalid or missing timestamp: ${timestamp}`,
        "error"
      );
      return { error: "Invalid or missing timestamp. Use a timestamp value from memory_search results." };
    }

    let results;
    try {
      results = await listWindow(timestamp, toleranceMs, maxTurns);
    } catch (e) {
      log(`[TMDBG Tools] memory_read: backend call failed: ${e}`, "error");
      return { error: `memory read failed: ${e?.message || e}` };
    }

    if (results.length === 0) {
      log(`[TMDBG Tools] memory_read: no entries found for timestamp ${timestamp}`);
      return "No conversation found around this timestamp.";
    }

    // Trim to max_turns, centered around the entry closest to the query timestamp
    if (results.length > maxTurns) {
      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < results.length; i++) {
        const dist = Math.abs((results[i].dateMs || 0) - timestamp);
        if (dist < closestDist) {
          closestDist = dist;
          closestIdx = i;
        }
      }
      let start = Math.max(0, closestIdx - Math.floor(maxTurns / 2));
      let end = start + maxTurns;
      if (end > results.length) {
        end = results.length;
        start = Math.max(0, end - maxTurns);
      }
      log(`[TMDBG Tools] memory_read: trimming ${results.length} entries to ${maxTurns} (centered at idx ${closestIdx})`);
      results = results.slice(start, end);
    }

    try {
      results = await readWhole(results);
    } catch (e) {
      log(`[TMDBG Tools] memory_read: backend call failed: ${e}`, "error");
      return { error: `memory read failed: ${e?.message || e}` };
    }
    if (results.length === 0) {
      log(`[TMDBG Tools] memory_read: the entries listed for timestamp ${timestamp} are gone`);
      return "No conversation found around this timestamp.";
    }

    // Format results for LLM consumption
    // Each entry is a session with combined user/assistant content
    const formatted = results
      .map((item) => {
        const date = item.dateMs
          ? new Date(item.dateMs).toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              year: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";

        // Content already contains the full conversation
        return `--- Conversation from ${date} ---\n${item.content || "(empty)"}`;
      })
      .join("\n\n");

    log(
      `[TMDBG Tools] memory_read: returning ${results.length} entries for timestamp ${timestamp}`
    );
    return formatted;
  } catch (e) {
    log(`[TMDBG Tools] memory_read failed: ${e}`, "error");
    return { error: String(e || "unknown error in memory_read") };
  }
}
