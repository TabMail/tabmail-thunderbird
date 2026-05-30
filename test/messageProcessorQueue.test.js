/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// messageProcessorQueue.test.js — Tests for agent/modules/messageProcessorQueue.js
//
// Focus: the processMessage (AI pipeline) resolve-failure path. A message DELETED
// from the inbox never resolves to a header, so the in-inbox eviction check can never
// observe it leaving. Without a verify-then-drop, such an item retries forever (the
// wild-caught "HeaderResolver ALL STAGES FAILED → will retry" loop). After
// maxResolveAttempts consecutive resolve failures the queue does a broad
// headerMessageId query and drops ONLY when it succeeds-and-empty (confirmed deleted).

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (read fresh on every _cfg() call, so mutating pmCfg between tests works)
// ---------------------------------------------------------------------------

const pmCfg = {
  watchIntervalMs: 0, // disable the watchdog interval in tests
  kickDelayMs: -1, // disable auto-kick on enqueue
  persistDebounceMs: 0, // persist synchronously
  batchSize: 100,
  retryDelayMs: 10000,
  itemTimeoutMs: 120000,
  maxResolveAttempts: 3, // small threshold for fast tests
  cleanupVerifyAfterAttempts: 3,
};

vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    agentQueues: { processMessage: pmCfg },
  },
}));

const mockHeaderIDToWeID = vi.fn();
const mockGetUniqueMessageKey = vi.fn(async () => "acct1:/INBOX:msgid@x");
const mockParseUniqueId = vi.fn(() => ({
  weFolder: { accountId: "acct1", path: "/INBOX" },
  headerID: "msgid@x",
}));

vi.mock("../agent/modules/utils.js", () => ({
  log: vi.fn(),
  getUniqueMessageKey: (...a) => mockGetUniqueMessageKey(...a),
  headerIDToWeID: (...a) => mockHeaderIDToWeID(...a),
  parseUniqueId: (...a) => mockParseUniqueId(...a),
}));

const mockIsInboxFolder = vi.fn(() => true);
vi.mock("../agent/modules/folderUtils.js", () => ({
  isInboxFolder: (...a) => mockIsInboxFolder(...a),
}));

const mockProcessMessage = vi.fn(async () => ({ ok: true }));
vi.mock("../agent/modules/messageProcessor.js", () => ({
  processMessage: (...a) => mockProcessMessage(...a),
}));

// drainProcessMessageQueue dynamically imports this when AI items complete.
vi.mock("../agent/modules/proactiveCheckin.js", () => ({
  onInboxUpdated: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Browser API mock
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
const mockGet = vi.fn();

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async () => ({})),
      set: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
  },
  messages: {
    get: (...a) => mockGet(...a),
    query: (...a) => mockQuery(...a),
  },
};

// ---------------------------------------------------------------------------
// SUT — re-imported fresh per test so the module-level _pending Map resets.
// ---------------------------------------------------------------------------

let SUT;

beforeEach(async () => {
  vi.clearAllMocks();
  pmCfg.maxResolveAttempts = 3;
  mockGetUniqueMessageKey.mockResolvedValue("acct1:/INBOX:msgid@x");
  mockParseUniqueId.mockReturnValue({
    weFolder: { accountId: "acct1", path: "/INBOX" },
    headerID: "msgid@x",
  });
  mockIsInboxFolder.mockReturnValue(true);
  vi.resetModules();
  SUT = await import("../agent/modules/messageProcessorQueue.js");
});

function enqueueOne() {
  return SUT.enqueueProcessMessage(
    { id: 123, subject: "hi", folder: { name: "Inbox", path: "/INBOX" } },
    {}
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processMessage resolve-failure verify-then-drop", () => {
  it("does NOT query or drop before maxResolveAttempts is reached", async () => {
    mockHeaderIDToWeID.mockResolvedValue(null); // never resolves

    await enqueueOne();
    expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);

    await SUT.drainProcessMessageQueue(); // attempt 1
    await SUT.drainProcessMessageQueue(); // attempt 2

    expect(mockQuery).not.toHaveBeenCalled();
    expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);
  });

  it("drops the item once the broad query confirms deletion (empty result)", async () => {
    mockHeaderIDToWeID.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ messages: [] }); // confirmed gone from whole account

    await enqueueOne();
    await SUT.drainProcessMessageQueue(); // attempt 1
    await SUT.drainProcessMessageQueue(); // attempt 2
    await SUT.drainProcessMessageQueue(); // attempt 3 → verify → empty → drop

    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery).toHaveBeenCalledWith({ headerMessageId: "msgid@x" });
    expect(mockProcessMessage).not.toHaveBeenCalled();
    expect(SUT.getProcessMessageQueueStatus().pending).toBe(0);
  });

  it("keeps retrying (never drops) when the broad verify query throws", async () => {
    mockHeaderIDToWeID.mockResolvedValue(null);
    mockQuery.mockRejectedValue(new Error("offline")); // transient — must not drop

    await enqueueOne();
    for (let i = 0; i < 5; i++) await SUT.drainProcessMessageQueue();

    expect(mockQuery).toHaveBeenCalled();
    expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);
  });

  it("recovers and processes when the broad query finds the message", async () => {
    const found = { id: 555, folder: { name: "Inbox", path: "/INBOX" } };
    mockHeaderIDToWeID.mockResolvedValue(null); // primary resolve fails…
    mockQuery.mockResolvedValue({ messages: [found] }); // …but a resolve glitch, it exists
    mockProcessMessage.mockResolvedValue({ ok: true });

    await enqueueOne();
    await SUT.drainProcessMessageQueue(); // attempt 1
    await SUT.drainProcessMessageQueue(); // attempt 2
    await SUT.drainProcessMessageQueue(); // attempt 3 → found → process

    expect(mockProcessMessage).toHaveBeenCalledTimes(1);
    expect(mockProcessMessage.mock.calls[0][0]).toBe(found);
    expect(SUT.getProcessMessageQueueStatus().pending).toBe(0);
  });

  it("processes normally on a clean resolve without ever hitting the verify path", async () => {
    const hdr = { id: 777, folder: { name: "Inbox", path: "/INBOX" } };
    mockHeaderIDToWeID.mockResolvedValue(777);
    mockGet.mockResolvedValue(hdr);
    mockProcessMessage.mockResolvedValue({ ok: true });

    await enqueueOne();
    await SUT.drainProcessMessageQueue();

    expect(mockProcessMessage).toHaveBeenCalledTimes(1);
    expect(mockQuery).not.toHaveBeenCalled();
    expect(SUT.getProcessMessageQueueStatus().pending).toBe(0);
  });
});
