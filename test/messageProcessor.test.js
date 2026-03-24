import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock browser APIs
globalThis.browser = {
  messages: {
    get: vi.fn().mockResolvedValue({}),
  },
  tmHdr: {
    getMsgKey: vi.fn().mockResolvedValue(1),
    getReplied: vi.fn().mockResolvedValue(false),
  },
};

// Mock all imported modules before importing processMessage
vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: {
    maxAgentWorkers: 32,
    inboxManagement: { maxRecentEmails: 100 },
  },
}));

vi.mock("../agent/modules/utils.js", () => ({
  log: vi.fn(),
  getUniqueMessageKey: vi.fn().mockResolvedValue("unique-key-1"),
}));

vi.mock("../agent/modules/senderFilter.js", () => ({
  isInternalSender: vi.fn().mockResolvedValue(false),
}));

vi.mock("../agent/modules/messagePrefilter.js", () => ({
  analyzeEmailForReplyFilter: vi.fn().mockResolvedValue({
    isNoReply: false,
    hasUnsubscribe: false,
    skipCachedReply: false,
  }),
}));

vi.mock("../agent/modules/summaryGenerator.js", () => ({
  getSummary: vi.fn().mockResolvedValue({
    id: "unique-key-1",
    blurb: "Test summary",
    todos: "",
  }),
  purgeExpiredSummaryEntries: vi.fn(),
}));

vi.mock("../agent/modules/actionGenerator.js", () => ({
  getAction: vi.fn().mockResolvedValue("archive"),
  purgeExpiredActionEntries: vi.fn(),
}));

vi.mock("../agent/modules/tagHelper.js", () => ({
  ACTION_TAG_IDS: {},
  applyActionTags: vi.fn().mockResolvedValue(undefined),
  applyPriorityTag: vi.fn().mockResolvedValue(undefined),
  importActionFromImapTag: vi.fn(),
}));

vi.mock("../agent/modules/replyGenerator.js", () => ({
  createReply: vi.fn().mockResolvedValue(undefined),
  purgeExpiredReplyEntries: vi.fn(),
}));

vi.mock("../agent/modules/folderUtils.js", () => ({
  isInboxFolder: vi.fn(),
}));

vi.mock("../agent/modules/idbStorage.js", () => ({
  purgeOlderThanByPrefixes: vi.fn(),
}));

const { processMessage } = await import(
  "../agent/modules/messageProcessor.js"
);
const { getSummary } = await import(
  "../agent/modules/summaryGenerator.js"
);
const { getAction } = await import(
  "../agent/modules/actionGenerator.js"
);
const { createReply } = await import(
  "../agent/modules/replyGenerator.js"
);
const { isInternalSender } = await import(
  "../agent/modules/senderFilter.js"
);
const { analyzeEmailForReplyFilter } = await import(
  "../agent/modules/messagePrefilter.js"
);
const { applyActionTags, applyPriorityTag } = await import(
  "../agent/modules/tagHelper.js"
);

const makeHeader = (id = 1) => ({
  id,
  subject: "Test Subject",
  author: "sender@example.com",
  headerMessageId: "<test@example.com>",
  folder: { id: "folder1", path: "/INBOX", name: "Inbox", type: "inbox" },
  tags: [],
});

describe("processMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply defaults after clearAllMocks
    isInternalSender.mockResolvedValue(false);
    analyzeEmailForReplyFilter.mockResolvedValue({
      isNoReply: false,
      hasUnsubscribe: false,
      skipCachedReply: false,
    });
    getSummary.mockResolvedValue({
      id: "unique-key-1",
      blurb: "Test summary",
      todos: "",
    });
    getAction.mockResolvedValue("archive");
    createReply.mockResolvedValue(undefined);
    browser.tmHdr.getReplied.mockResolvedValue(false);
  });

  it("returns early with reason for null messageHeader", async () => {
    const result = await processMessage(null);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-messageHeader");
  });

  // MARK: - SA ∥ R Parallelism

  it("runs SA and R in parallel (both called)", async () => {
    const header = makeHeader();
    const result = await processMessage(header);

    expect(result.ok).toBe(true);
    expect(result.summaryOk).toBe(true);
    expect(result.actionOk).toBe(true);
    expect(result.replyOk).toBe(true);
    // All three stages should have been called
    expect(getSummary).toHaveBeenCalledOnce();
    expect(getAction).toHaveBeenCalledOnce();
    expect(createReply).toHaveBeenCalledOnce();
  });

  it("SA and R actually run concurrently (timing)", async () => {
    // Make SA and R each take 50ms. If sequential, total >= 100ms.
    // If parallel, total ~50ms.
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));

    getSummary.mockImplementation(async () => {
      await delay(50);
      return { id: "k1", blurb: "summary", todos: "" };
    });
    getAction.mockImplementation(async () => {
      await delay(50);
      return "archive";
    });
    createReply.mockImplementation(async () => {
      await delay(50);
    });

    const start = Date.now();
    const result = await processMessage(makeHeader());
    const elapsed = Date.now() - start;

    expect(result.ok).toBe(true);
    // SA takes ~100ms (S=50ms + A=50ms sequential within SA).
    // R takes ~50ms (parallel with SA).
    // Total should be ~100ms if parallel, ~150ms if fully sequential.
    // Use generous margin for CI jitter.
    expect(elapsed).toBeLessThan(140);
  });

  it("R failure does not block SA success", async () => {
    createReply.mockRejectedValue(new Error("reply failed"));

    const result = await processMessage(makeHeader());

    expect(result.summaryOk).toBe(true);
    expect(result.actionOk).toBe(true);
    expect(result.replyOk).toBe(false);
    expect(result.ok).toBe(false); // overall not ok because reply failed
  });

  it("SA failure does not block R success", async () => {
    getSummary.mockResolvedValue(null); // summary fails
    getAction.mockResolvedValue(null); // action fails

    const result = await processMessage(makeHeader());

    expect(result.summaryOk).toBe(false);
    expect(result.actionOk).toBe(false);
    expect(result.replyOk).toBe(true); // reply still succeeds
  });

  // MARK: - Reply Skip

  it("skips reply when quickFilter.skipCachedReply is true", async () => {
    analyzeEmailForReplyFilter.mockResolvedValue({
      isNoReply: true,
      hasUnsubscribe: false,
      skipCachedReply: true,
    });

    const result = await processMessage(makeHeader());

    expect(createReply).not.toHaveBeenCalled();
    expect(result.replySkipped).toBe(true);
    expect(result.replyOk).toBe(true); // skipped counts as ok
  });

  // MARK: - Internal Messages

  it("internal messages get summary + tm_none, skip action and reply", async () => {
    isInternalSender.mockResolvedValue(true);

    const result = await processMessage(makeHeader());

    expect(result.ok).toBe(true);
    expect(result.isInternal).toBe(true);
    expect(result.action).toBe("none");
    expect(getSummary).toHaveBeenCalledOnce();
    expect(getAction).not.toHaveBeenCalled();
    expect(createReply).not.toHaveBeenCalled();
    expect(applyPriorityTag).toHaveBeenCalledWith(1, "none");
  });

  // MARK: - Action Tag Application

  it("applies action tags when both summary and action succeed", async () => {
    const result = await processMessage(makeHeader());

    expect(result.ok).toBe(true);
    expect(applyActionTags).toHaveBeenCalledOnce();
  });

  it("skips tag application when summary fails", async () => {
    getSummary.mockResolvedValue(null);

    await processMessage(makeHeader());

    expect(applyActionTags).not.toHaveBeenCalled();
  });

  // MARK: - Message Gone

  it("reports message-not-found when message deleted during processing", async () => {
    getSummary.mockResolvedValue(null); // cause !ok
    browser.messages.get.mockRejectedValue(new Error("not found"));

    const result = await processMessage(makeHeader());

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("message-not-found");
  });
});
