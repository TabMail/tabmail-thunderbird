// taskExecutionCache.test.js — Tests for task execution cache
// Replicates pure logic since browser.storage.local is not available in tests.

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// Replicated eviction logic from taskExecutionCache.js
// ---------------------------------------------------------------------------

const MAX_ENTRIES_PER_TASK = 10;
const GC_AGE_DAYS = 90;

function cacheKey(taskHash, dateStr) {
	return `${taskHash}_${dateStr}`;
}

function evictExcessEntries(cache, taskHash) {
	const prefix = `${taskHash}_`;
	const matchingKeys = Object.keys(cache).filter((k) => k.startsWith(prefix));
	if (matchingKeys.length <= MAX_ENTRIES_PER_TASK) return 0;

	matchingKeys.sort((a, b) => {
		const tsA = cache[a].ts || "";
		const tsB = cache[b].ts || "";
		return tsA.localeCompare(tsB);
	});

	const toRemove = matchingKeys.length - MAX_ENTRIES_PER_TASK;
	for (let i = 0; i < toRemove; i++) {
		delete cache[matchingKeys[i]];
	}
	return toRemove;
}

function mergeIncomingCache(cache, incomingMap) {
	let merged = 0;
	for (const [key, inEntry] of Object.entries(incomingMap)) {
		if (!inEntry || typeof inEntry.ts !== "string") continue;
		const localEntry = cache[key];
		if (!localEntry || inEntry.ts > localEntry.ts) {
			cache[key] = inEntry;
			merged++;
		}
	}
	return merged;
}

function gcOrphanedEntries(cache, activeTaskHashes) {
	const now = Date.now();
	const maxAge = GC_AGE_DAYS * 86400 * 1000;
	let removed = 0;

	for (const [key, entry] of Object.entries(cache)) {
		const lastUnderscore = key.lastIndexOf("_");
		if (lastUnderscore === -1) { delete cache[key]; removed++; continue; }
		const taskHash = key.substring(0, lastUnderscore);
		if (activeTaskHashes.has(taskHash)) continue;
		const entryTime = new Date(entry.ts).getTime();
		if (now - entryTime > maxAge) { delete cache[key]; removed++; }
	}
	return removed;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("cacheKey", () => {
	it("builds composite key", () => {
		expect(cacheKey("t:abc", "2026-03-28")).toBe("t:abc_2026-03-28");
	});
});

describe("evictExcessEntries", () => {
	it("does nothing when under limit", () => {
		const cache = {
			"t:a_2026-03-01": { ts: "2026-03-01T00:00:00Z" },
			"t:a_2026-03-02": { ts: "2026-03-02T00:00:00Z" },
		};
		expect(evictExcessEntries(cache, "t:a")).toBe(0);
		expect(Object.keys(cache)).toHaveLength(2);
	});

	it("evicts oldest when over limit", () => {
		const cache = {};
		for (let i = 1; i <= 12; i++) {
			const day = String(i).padStart(2, "0");
			cache[`t:a_2026-03-${day}`] = { ts: `2026-03-${day}T00:00:00Z` };
		}
		expect(Object.keys(cache)).toHaveLength(12);
		const evicted = evictExcessEntries(cache, "t:a");
		expect(evicted).toBe(2);
		expect(Object.keys(cache)).toHaveLength(10);
		// Oldest (01, 02) should be gone
		expect(cache["t:a_2026-03-01"]).toBeUndefined();
		expect(cache["t:a_2026-03-02"]).toBeUndefined();
		// Newest should remain
		expect(cache["t:a_2026-03-12"]).toBeDefined();
	});

	it("only evicts entries for the specified taskHash", () => {
		const cache = {};
		for (let i = 1; i <= 12; i++) {
			const day = String(i).padStart(2, "0");
			cache[`t:a_2026-03-${day}`] = { ts: `2026-03-${day}T00:00:00Z` };
		}
		cache["t:b_2026-03-01"] = { ts: "2026-03-01T00:00:00Z" };
		evictExcessEntries(cache, "t:a");
		// t:b entry should be untouched
		expect(cache["t:b_2026-03-01"]).toBeDefined();
	});
});

describe("mergeIncomingCache", () => {
	it("accepts newer entries", () => {
		const cache = {
			"t:a_2026-03-01": { content: "old", ts: "2026-03-01T00:00:00Z" },
		};
		const incoming = {
			"t:a_2026-03-01": { content: "new", ts: "2026-03-01T12:00:00Z" },
		};
		const merged = mergeIncomingCache(cache, incoming);
		expect(merged).toBe(1);
		expect(cache["t:a_2026-03-01"].content).toBe("new");
	});

	it("rejects older entries", () => {
		const cache = {
			"t:a_2026-03-01": { content: "newer", ts: "2026-03-01T12:00:00Z" },
		};
		const incoming = {
			"t:a_2026-03-01": { content: "older", ts: "2026-03-01T00:00:00Z" },
		};
		const merged = mergeIncomingCache(cache, incoming);
		expect(merged).toBe(0);
		expect(cache["t:a_2026-03-01"].content).toBe("newer");
	});

	it("adds new keys", () => {
		const cache = {};
		const incoming = {
			"t:a_2026-03-01": { content: "new", ts: "2026-03-01T00:00:00Z" },
		};
		const merged = mergeIncomingCache(cache, incoming);
		expect(merged).toBe(1);
		expect(cache["t:a_2026-03-01"]).toBeDefined();
	});

	it("skips entries with invalid ts", () => {
		const cache = {};
		const incoming = {
			"t:a_2026-03-01": { content: "no ts" },
			"t:a_2026-03-02": null,
		};
		const merged = mergeIncomingCache(cache, incoming);
		expect(merged).toBe(0);
	});
});

describe("gcOrphanedEntries", () => {
	it("removes old entries for inactive tasks", () => {
		const oldTs = new Date(Date.now() - 100 * 86400 * 1000).toISOString(); // 100 days ago
		const cache = {
			"t:active_2026-01-01": { ts: oldTs },
			"t:orphan_2026-01-01": { ts: oldTs },
		};
		const removed = gcOrphanedEntries(cache, new Set(["t:active"]));
		expect(removed).toBe(1);
		expect(cache["t:active_2026-01-01"]).toBeDefined();
		expect(cache["t:orphan_2026-01-01"]).toBeUndefined();
	});

	it("keeps recent orphaned entries", () => {
		const recentTs = new Date().toISOString();
		const cache = {
			"t:orphan_2026-03-28": { ts: recentTs },
		};
		const removed = gcOrphanedEntries(cache, new Set());
		expect(removed).toBe(0);
	});

	it("removes malformed keys", () => {
		const cache = {
			"malformed": { ts: "2026-01-01T00:00:00Z" },
		};
		const removed = gcOrphanedEntries(cache, new Set());
		expect(removed).toBe(1);
	});
});
