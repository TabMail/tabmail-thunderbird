// memory_read.js – Read full conversation around a timestamp
// TB 145, MV3

import { log } from "../../agent/modules/utils.js";

// Default tolerance: 10 minutes (600,000 ms)
const DEFAULT_TOLERANCE_MS = 600000;

export async function run(args = {}, options = {}) {
  try {
    const timestamp = args?.timestamp;
    const toleranceMs = args?.tolerance_minutes
      ? Number(args.tolerance_minutes) * 60 * 1000
      : DEFAULT_TOLERANCE_MS;

    log(
      `[TMDBG Tools] memory_read: timestamp=${timestamp} tolerance=${toleranceMs}ms`
    );

    if (!timestamp || typeof timestamp !== "number") {
      log(
        `[TMDBG Tools] memory_read: invalid or missing timestamp: ${timestamp}`,
        "error"
      );
      return { error: "Invalid or missing timestamp. Use a timestamp value from memory_search results." };
    }

    // Call the FTS backend to read memory entries around this timestamp
    let results;
    try {
      results = await browser.runtime.sendMessage({
        type: "fts",
        cmd: "memoryRead",
        timestampMs: timestamp,
        toleranceMs: toleranceMs,
      });
    } catch (e) {
      log(`[TMDBG Tools] memory_read: backend call failed: ${e}`, "error");
      return { error: "Failed to read memory: " + String(e) };
    }

    // Check for errors
    if (results && typeof results === "object" && results.error) {
      log(
        `[TMDBG Tools] memory_read: backend returned error: ${results.error}`,
        "error"
      );
      return { error: `memory read failed: ${results.error}` };
    }

    // Ensure results is an array
    if (!Array.isArray(results)) {
      log(
        `[TMDBG Tools] memory_read: invalid response format: ${typeof results}`,
        "error"
      );
      return { error: "memory read failed: invalid response format" };
    }

    if (results.length === 0) {
      log(`[TMDBG Tools] memory_read: no entries found for timestamp ${timestamp}`);
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
