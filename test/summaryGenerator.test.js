// summaryGenerator.test.js — Tests for agent/modules/summaryGenerator.js
//
// Tests the summary generation pipeline:
// - purgeExpiredSummaryEntries: TTL-based cache eviction
// - getSummaryWithHeaderId: fast cache-only lookup
// - getSummary: cache-first with LLM fallback, semaphore dedup
// - generateSummary: full LLM generation flow, device sync, caching

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── In-memory IDB store ────────────────────────────────────────────────────
// Simulates the key-value store used by idbStorage.js
let idbStore = {};

vi.mock("../agent/modules/idbStorage.js", () => ({
  get: vi.fn(async (keyOrKeys) => {
    if (typeof keyOrKeys === "string") {
      return { [keyOrKeys]: idbStore[keyOrKeys] ?? undefined };
    }
    // Array of keys
    const result = {};
    for (const k of keyOrKeys) {
      if (idbStore[k] !== undefined) result[k] = idbStore[k];
    }
    return result;
  }),
  set: vi.fn(async (obj) => {
    for (const [k, v] of Object.entries(obj)) {
      idbStore[k] = v;
    }
  }),
  remove: vi.fn(async (keys) => {
    for (const k of keys) {
      delete idbStore[k];
    }
  }),
  getAllKeys: vi.fn(async () => Object.keys(idbStore)),
}));

// ─── Mock config.js ─────────────────────────────────────────────────────────
vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: {
    summaryTTLSeconds: 604800, // 1 week
    maxAgentWorkers: 32,
  },
}));

// ─── Mock utils.js ──────────────────────────────────────────────────────────
vi.mock("../agent/modules/utils.js", () => ({
  log: vi.fn(),
  getUniqueMessageKey: vi.fn(async (header) => header?.headerMessageId ?? null),
  extractBodyFromParts: vi.fn(async () => "<p>Hello world</p>"),
  stripHtml: vi.fn((html) => html?.replace(/<[^>]*>/g, "") ?? ""),
  safeGetFull: vi.fn(async () => ({ parts: [] })),
  indexHeader: vi.fn(),
  saveChatLog: vi.fn(),
  getRealSubject: (...args) => mockGetRealSubject(...args),
}));

const mockGetRealSubject = vi.fn(async (header) => header?.subject || "");

// ─── Mock llm.js ────────────────────────────────────────────────────────────
vi.mock("../agent/modules/llm.js", () => ({
  processSummaryResponse: vi.fn((text) => ({
    blurb: "Test summary blurb",
    detailed: "Detailed summary",
    todos: "• Do something",
    reminder: null,
  })),
  sendChat: vi.fn(async () => ({
    assistant: "Todos:\n- Do something\n\nTwo-line summary:\nTest summary blurb\n\nReminder due date: none\nReminder content: none",
  })),
}));

// ─── Mock chat helpers ──────────────────────────────────────────────────────
vi.mock("../chat/modules/helpers.js", () => ({
  formatTimestampForAgent: vi.fn(() => "2026-04-07 10:00"),
  getUserName: vi.fn(async () => "Test User"),
}));

// ─── Mock messagePrefilter.js ───────────────────────────────────────────────
vi.mock("../agent/modules/messagePrefilter.js", () => ({
  analyzeEmailForReplyFilter: vi.fn(async () => ({
    isNoReply: false,
    hasUnsubscribe: false,
  })),
}));

// ─── Mock promptGenerator.js (dynamic import) ──────────────────────────────
vi.mock("../agent/modules/promptGenerator.js", () => ({
  getUserKBPrompt: vi.fn(async () => "User KB content here"),
}));

// ─── Mock deviceSync.js (dynamic import) ────────────────────────────────────
vi.mock("../agent/modules/deviceSync.js", () => ({
  probeAICache: vi.fn(async () => null),
}));

// ─── Browser mock ───────────────────────────────────────────────────────────
globalThis.browser = {
  tmHdr: {
    getFlags: vi.fn().mockResolvedValue({ exists: false }),
  },
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
    },
  },
  runtime: {
    getManifest: vi.fn(() => ({ version: "1.0.0" })),
  },
};

// ─── Import tested functions ────────────────────────────────────────────────
const {
  purgeExpiredSummaryEntries,
  getSummaryWithHeaderId,
  getSummary,
  generateSummary,
} = await import("../agent/modules/summaryGenerator.js");

// ─── Re-import mocked modules for assertions ───────────────────────────────
const idb = await import("../agent/modules/idbStorage.js");
const { sendChat, processSummaryResponse } = await import(
  "../agent/modules/llm.js"
);
const { getUniqueMessageKey, safeGetFull, extractBodyFromParts, indexHeader, saveChatLog } =
  await import("../agent/modules/utils.js");
const { probeAICache } = await import("../agent/modules/deviceSync.js");

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeHeader(overrides = {}) {
  return {
    id: 1,
    headerMessageId: "msg-abc-123",
    subject: "Test Subject",
    author: "Alice <alice@example.com>",
    date: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  idbStore = {};
  mockGetRealSubject.mockImplementation(async (header) => header?.subject || "");
});

// ═══════════════════════════════════════════════════════════════════════════
// purgeExpiredSummaryEntries
// ═══════════════════════════════════════════════════════════════════════════
describe("purgeExpiredSummaryEntries", () => {
  it("removes entries older than summaryTTLSeconds", async () => {
    const oldTs = Date.now() - 604800 * 1000 - 1000; // TTL + 1s ago
    idbStore["summary:ts:msg-old"] = { ts: oldTs };
    idbStore["summary:msg-old"] = { blurb: "Old summary" };

    await purgeExpiredSummaryEntries();

    expect(idb.remove).toHaveBeenCalled();
    const removedKeys = idb.remove.mock.calls[0][0];
    expect(removedKeys).toContain("summary:msg-old");
    expect(removedKeys).toContain("summary:ts:msg-old");
  });

  it("keeps entries within TTL", async () => {
    const recentTs = Date.now() - 1000; // 1 second ago
    idbStore["summary:ts:msg-recent"] = { ts: recentTs };
    idbStore["summary:msg-recent"] = { blurb: "Recent summary" };

    await purgeExpiredSummaryEntries();

    // remove should not have been called since nothing expired
    expect(idb.remove).not.toHaveBeenCalled();
  });

  it("removes orphaned payload entries without timestamp metadata", async () => {
    // Payload exists but no corresponding timestamp key
    idbStore["summary:msg-orphan"] = { blurb: "Orphaned summary" };

    await purgeExpiredSummaryEntries();

    expect(idb.remove).toHaveBeenCalled();
    const removedKeys = idb.remove.mock.calls[0][0];
    expect(removedKeys).toContain("summary:msg-orphan");
  });

  it("does nothing when store is empty", async () => {
    await purgeExpiredSummaryEntries();
    expect(idb.remove).not.toHaveBeenCalled();
  });

  it("handles mix of expired, valid, and orphaned entries", async () => {
    const oldTs = Date.now() - 604800 * 1000 - 5000;
    const recentTs = Date.now() - 100;

    idbStore["summary:ts:msg-expired"] = { ts: oldTs };
    idbStore["summary:msg-expired"] = { blurb: "Expired" };
    idbStore["summary:ts:msg-valid"] = { ts: recentTs };
    idbStore["summary:msg-valid"] = { blurb: "Valid" };
    idbStore["summary:msg-orphan"] = { blurb: "Orphan" };

    await purgeExpiredSummaryEntries();

    expect(idb.remove).toHaveBeenCalled();
    const removedKeys = idb.remove.mock.calls[0][0];
    expect(removedKeys).toContain("summary:msg-expired");
    expect(removedKeys).toContain("summary:ts:msg-expired");
    expect(removedKeys).toContain("summary:msg-orphan");
    expect(removedKeys).not.toContain("summary:msg-valid");
    expect(removedKeys).not.toContain("summary:ts:msg-valid");
  });

  it("treats missing ts field as expired", async () => {
    // Timestamp entry exists but ts value is missing/invalid
    idbStore["summary:ts:msg-bad"] = { notTs: "garbage" };
    idbStore["summary:msg-bad"] = { blurb: "Bad timestamp" };

    await purgeExpiredSummaryEntries();

    expect(idb.remove).toHaveBeenCalled();
    const removedKeys = idb.remove.mock.calls[0][0];
    expect(removedKeys).toContain("summary:msg-bad");
    expect(removedKeys).toContain("summary:ts:msg-bad");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getSummaryWithHeaderId
// ═══════════════════════════════════════════════════════════════════════════
describe("getSummaryWithHeaderId", () => {
  it("returns cached summary when present", async () => {
    idbStore["summary:msg-abc-123"] = {
      blurb: "Cached blurb",
      detailed: "Cached detail",
      todos: "• Task",
    };

    const result = await getSummaryWithHeaderId("msg-abc-123");
    expect(result).toEqual({
      blurb: "Cached blurb",
      detailed: "Cached detail",
      todos: "• Task",
    });
  });

  it("returns null when not cached", async () => {
    const result = await getSummaryWithHeaderId("msg-not-found");
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// getSummary
// ═══════════════════════════════════════════════════════════════════════════
describe("getSummary", () => {
  it("returns cached summary on cache hit (fast path)", async () => {
    idbStore["summary:msg-abc-123"] = {
      blurb: "Cached blurb",
      detailed: "Cached detail",
      todos: "• Do stuff",
      reminder: null,
    };

    const header = makeHeader();
    const result = await getSummary(header);

    expect(result).not.toBeNull();
    expect(result.blurb).toBe("Cached blurb");
    expect(result.detailed).toBe("Cached detail");
    expect(result.todos).toBe("• Do stuff");
    expect(result.subject).toBe("Test Subject");
    expect(result.fromSender).toBe("Alice <alice@example.com>");
    // Should call indexHeader on cache hit
    expect(indexHeader).toHaveBeenCalledWith(header);
    // Should NOT call sendChat for cache hit
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("returns null when getUniqueMessageKey returns null", async () => {
    getUniqueMessageKey.mockResolvedValueOnce(null);
    const result = await getSummary(makeHeader());
    expect(result).toBeNull();
  });

  it("returns empty-field result when cacheOnly=true and not cached", async () => {
    const header = makeHeader();
    const result = await getSummary(header, false, true);

    expect(result).not.toBeNull();
    expect(result.blurb).toBe("");
    expect(result.detailed).toBe("");
    expect(result.todos).toBe("");
    expect(result.reminder).toBeNull();
    expect(result.subject).toBe("Test Subject");
    // Should NOT call sendChat when cacheOnly
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("generates summary via LLM on cache miss", async () => {
    const header = makeHeader();
    const result = await getSummary(header);

    expect(result).not.toBeNull();
    expect(result.blurb).toBe("Test summary blurb");
    expect(sendChat).toHaveBeenCalled();
    expect(indexHeader).toHaveBeenCalledWith(header);
  });

  it("returns null when LLM returns empty response", async () => {
    sendChat.mockResolvedValueOnce(null);
    const header = makeHeader();
    const result = await getSummary(header);
    expect(result).toBeNull();
  });

  it("returns null when LLM returns response without assistant", async () => {
    sendChat.mockResolvedValueOnce({ assistant: null });
    const header = makeHeader();
    const result = await getSummary(header);
    expect(result).toBeNull();
  });

  it("touches cache timestamp on cache hit (non-blocking)", async () => {
    idbStore["summary:msg-abc-123"] = { blurb: "Cached", todos: "" };

    const header = makeHeader();
    await getSummary(header);

    // The timestamp touch is fire-and-forget but we can check idb.set was called
    // Give microtask a chance to settle
    await new Promise((r) => setTimeout(r, 10));
    expect(idb.set).toHaveBeenCalled();
  });

  it("returns cached summary with default empty strings for missing fields", async () => {
    // Cache entry missing detailed, todos, reminder fields
    idbStore["summary:msg-abc-123"] = { blurb: "Minimal cache" };

    const header = makeHeader();
    const result = await getSummary(header);

    expect(result.blurb).toBe("Minimal cache");
    expect(result.detailed).toBe("");
    expect(result.todos).toBe("");
    expect(result.reminder).toBeNull();
    expect(result.body).toBe("");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// generateSummary
// ═══════════════════════════════════════════════════════════════════════════
describe("generateSummary", () => {
  it("generates summary via LLM and caches result", async () => {
    const header = makeHeader();
    const result = await generateSummary(header);

    expect(result).not.toBeNull();
    expect(result.blurb).toBe("Test summary blurb");
    expect(result.id).toBe("msg-abc-123");
    expect(result.subject).toBe("Test Subject");
    expect(result.fromSender).toBe("Alice <alice@example.com>");

    // Verify LLM was called
    expect(sendChat).toHaveBeenCalled();
    expect(processSummaryResponse).toHaveBeenCalled();

    // Verify result was cached
    expect(idb.set).toHaveBeenCalled();
    expect(idbStore["summary:msg-abc-123"]).toBeDefined();
    expect(idbStore["summary:ts:msg-abc-123"]).toBeDefined();
  });

  it("returns cached result if populated between semaphore acquire and generation", async () => {
    // Pre-populate cache to simulate another caller completing first
    idbStore["summary:msg-abc-123"] = {
      blurb: "Already generated",
      detailed: "Detail",
      todos: "• Task",
    };

    const header = makeHeader();
    const result = await generateSummary(header);

    expect(result.blurb).toBe("Already generated");
    // sendChat should NOT be called since cache was hit
    expect(sendChat).not.toHaveBeenCalled();
  });

  it("returns null when LLM returns empty response", async () => {
    sendChat.mockResolvedValueOnce(null);
    const header = makeHeader();
    const result = await generateSummary(header);
    expect(result).toBeNull();
  });

  it("returns null when LLM assistant content is empty", async () => {
    sendChat.mockResolvedValueOnce({ assistant: "" });
    const header = makeHeader();
    const result = await generateSummary(header);
    expect(result).toBeNull();
  });

  it("calls safeGetFull with message id and header", async () => {
    const header = makeHeader({ id: 42 });
    await generateSummary(header);

    expect(safeGetFull).toHaveBeenCalledWith(42, header);
  });

  it("calls extractBodyFromParts with full message result", async () => {
    const fullResult = { parts: [{ body: "test" }] };
    safeGetFull.mockResolvedValueOnce(fullResult);

    const header = makeHeader({ id: 99 });
    await generateSummary(header);

    expect(extractBodyFromParts).toHaveBeenCalledWith(fullResult, 99);
  });

  it("passes highPriority flag to sendChat as ignoreSemaphore", async () => {
    const header = makeHeader();
    await generateSummary(header, true);

    const chatCall = sendChat.mock.calls[0];
    expect(chatCall[1]).toEqual(
      expect.objectContaining({ ignoreSemaphore: true })
    );
  });

  it("passes highPriority=false by default", async () => {
    const header = makeHeader();
    await generateSummary(header);

    const chatCall = sendChat.mock.calls[0];
    expect(chatCall[1]).toEqual(
      expect.objectContaining({ ignoreSemaphore: false })
    );
  });

  it("saves chat log after successful generation", async () => {
    const header = makeHeader();
    await generateSummary(header);

    expect(saveChatLog).toHaveBeenCalledWith(
      "tabmail_summary",
      "msg-abc-123",
      expect.any(Array),
      expect.any(String)
    );
  });

  it("builds system message with correct fields", async () => {
    const header = makeHeader({
      subject: "Important Meeting",
      author: "Bob <bob@example.com>",
    });
    await generateSummary(header);

    const chatCall = sendChat.mock.calls[0];
    const messages = chatCall[0];
    expect(messages).toHaveLength(1);

    const sysMsg = messages[0];
    expect(sysMsg.role).toBe("system");
    expect(sysMsg.content).toBe("system_prompt_summary");
    expect(sysMsg.subject).toBe("Important Meeting");
    expect(sysMsg.from_sender).toBe("Bob <bob@example.com>");
    expect(sysMsg.user_name).toBe("Test User");
    expect(typeof sysMsg.body).toBe("string");
    expect(typeof sysMsg.is_noreply_address).toBe("boolean");
    expect(typeof sysMsg.has_unsubscribe_link).toBe("boolean");
  });

  it("uses getRealSubject to restore Re: prefix in LLM system message", async () => {
    mockGetRealSubject.mockResolvedValue("Re: Important Meeting");
    const header = makeHeader({
      subject: "Important Meeting",
      author: "Bob <bob@example.com>",
    });
    await generateSummary(header);

    const sysMsg = sendChat.mock.calls[0][0][0];
    expect(sysMsg.subject).toBe("Re: Important Meeting");
  });

  it("uses device sync peer summary when available (skips LLM)", async () => {
    probeAICache.mockResolvedValueOnce({
      blurb: "Peer blurb",
      detailed: "Peer detail",
      todos: "Peer todos",
      reminderDate: null,
      reminderContent: null,
    });

    const header = makeHeader();
    const result = await generateSummary(header);

    expect(result.blurb).toBe("Peer blurb");
    expect(result.detailed).toBe("Peer detail");
    // sendChat should NOT have been called — peer result used instead
    expect(sendChat).not.toHaveBeenCalled();
    // But result should be cached
    expect(idbStore["summary:msg-abc-123"]).toBeDefined();
  });

  it("builds reminder object from device sync peer when reminder fields present", async () => {
    probeAICache.mockResolvedValueOnce({
      blurb: "Peer blurb",
      detailed: "",
      todos: "",
      reminderDate: "2026-05-01",
      reminderTime: "14:00",
      reminderContent: "Follow up with client",
    });

    const header = makeHeader();
    const result = await generateSummary(header);

    expect(result.reminder).toEqual({
      date: "2026-05-01",
      time: "14:00",
      content: "Follow up with client",
    });
  });

  it("sets reminder to null from device sync peer when no reminder fields", async () => {
    probeAICache.mockResolvedValueOnce({
      blurb: "Peer blurb",
      detailed: "",
      todos: "",
    });

    const header = makeHeader();
    const result = await generateSummary(header);

    expect(result.reminder).toBeNull();
  });

  it("falls back to LLM when device sync probe fails", async () => {
    probeAICache.mockRejectedValueOnce(new Error("WebSocket timeout"));

    const header = makeHeader();
    const result = await generateSummary(header);

    // Should still generate via LLM
    expect(result).not.toBeNull();
    expect(sendChat).toHaveBeenCalled();
  });

  it("falls back to LLM when device sync probe times out (returns null)", async () => {
    // probeAICache returns null (default mock behavior) — no peer available
    const header = makeHeader();
    const result = await generateSummary(header);

    expect(result).not.toBeNull();
    expect(sendChat).toHaveBeenCalled();
  });

  it("ensures reminder field is null when LLM result has no reminder", async () => {
    processSummaryResponse.mockReturnValueOnce({
      blurb: "No reminder blurb",
      detailed: "",
      todos: "",
      // no reminder field
    });

    const header = makeHeader();
    const result = await generateSummary(header);

    expect(result.reminder).toBeNull();
  });

  it("handles missing subject and author gracefully", async () => {
    const header = makeHeader({ subject: undefined, author: undefined });
    await generateSummary(header);

    const chatCall = sendChat.mock.calls[0];
    const sysMsg = chatCall[0][0];
    expect(sysMsg.subject).toBe("Not Available");
    expect(sysMsg.from_sender).toBe("Unknown");
  });
});
