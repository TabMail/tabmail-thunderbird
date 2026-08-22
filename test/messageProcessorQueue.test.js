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
const mockResolveUniqueMessageKey = vi.fn(async () => {
  const weID = await mockHeaderIDToWeID();
  return weID ? {
    weFolder: { id: "folder-inbox", accountId: "acct1", path: "/INBOX" },
    headerID: "msgid@x",
    weID,
  } : null;
});
const mockGetUniqueMessageKeyCandidates = vi.fn(() => [{
  weFolder: { id: "folder-inbox", accountId: "acct1", path: "/INBOX" },
  headerID: "msgid@x",
}]);

vi.mock("../agent/modules/utils.js", () => ({
  log: vi.fn(),
  getUniqueMessageKey: (...a) => mockGetUniqueMessageKey(...a),
  headerIDToWeID: (...a) => mockHeaderIDToWeID(...a),
  parseUniqueId: (...a) => mockParseUniqueId(...a),
  resolveUniqueMessageKey: (...a) => mockResolveUniqueMessageKey(...a),
  getUniqueMessageKeyCandidates: (...a) => mockGetUniqueMessageKeyCandidates(...a),
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
const mockLeaveInboxCleanup = vi.fn(async () => ({ ok: true }));
vi.mock("../agent/modules/onMoved.js", () => ({
  performLeaveInboxTagCleanup: (...a) => mockLeaveInboxCleanup(...a),
}));

// ---------------------------------------------------------------------------
// Browser API mock
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();
const mockContinueList = vi.fn();
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
    continueList: (...a) => mockContinueList(...a),
  },
  folders: {
    query: vi.fn(async () => [{
      id: "folder-inbox", accountId: "acct1", path: "/INBOX",
    }]),
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
  mockResolveUniqueMessageKey.mockImplementation(async () => {
    const weID = await mockHeaderIDToWeID();
    return weID ? {
      weFolder: { id: "folder-inbox", accountId: "acct1", path: "/INBOX" },
      headerID: "msgid@x",
      weID,
    } : null;
  });
  mockParseUniqueId.mockReturnValue({
    weFolder: { accountId: "acct1", path: "/INBOX" },
    headerID: "msgid@x",
  });
  mockIsInboxFolder.mockReturnValue(true);
  mockGetUniqueMessageKeyCandidates.mockReturnValue([{
    weFolder: { id: "folder-inbox", accountId: "acct1", path: "/INBOX" },
    headerID: "msgid@x",
  }]);
  browser.folders.query.mockResolvedValue([{
    id: "folder-inbox", accountId: "acct1", path: "/INBOX",
  }]);
  vi.resetModules();
  SUT = await import("../agent/modules/messageProcessorQueue.js");
});

function enqueueOne(opts = {}) {
  return SUT.enqueueProcessMessage(
    {
      id: 123,
      subject: "hi",
      folder: { id: "folder-inbox", accountId: "acct1", name: "Inbox", path: "/INBOX" },
    },
    opts
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("processMessage resolve-failure verify-then-drop", () => {
  it("persists exact account/path recovery evidence without a session MailFolder.id", async () => {
    await enqueueOne();
    await vi.waitFor(() => expect(browser.storage.local.set).toHaveBeenCalled());

    const persisted = browser.storage.local.set.mock.calls.at(-1)[0]
      .agent_processmessage_pending[0];
    expect(persisted.metadata).toMatchObject({
      accountId: "acct1",
      folderPath: "/INBOX",
    });
    expect(persisted.metadata).not.toHaveProperty("folderId");
  });

  it("strips a legacy persisted session MailFolder.id during restore", async () => {
    browser.storage.local.get.mockResolvedValueOnce({
      agent_processmessage_pending: [{
        uniqueKey: "acct1:/INBOX:msgid@x",
        timestamp: Date.now(),
        opts: {},
        metadata: {
          accountId: "acct1",
          folderPath: "/INBOX",
          folderId: "stale-session-folder",
        },
      }],
    });
    vi.resetModules();
    SUT = await import("../agent/modules/messageProcessorQueue.js");

    await SUT.initProcessMessageQueue();

    const persisted = browser.storage.local.set.mock.calls.at(-1)[0]
      .agent_processmessage_pending[0];
    expect(persisted.metadata).toMatchObject({
      accountId: "acct1",
      folderPath: "/INBOX",
    });
    expect(persisted.metadata).not.toHaveProperty("folderId");
  });

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
    const found = {
      id: 555,
      folder: { accountId: "acct1", name: "Inbox", path: "/INBOX" },
    };
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

  it("uses persisted enqueue identity when the original folder no longer exists", async () => {
    const found = {
      id: 556,
      folder: { id: "renamed", accountId: "acct1", name: "Inbox", path: "/Renamed" },
    };
    mockHeaderIDToWeID.mockResolvedValue(null);
    browser.folders.query.mockResolvedValue([]);
    mockGetUniqueMessageKeyCandidates.mockReturnValue([]);
    mockQuery.mockResolvedValue({ messages: [found] });

    await enqueueOne();
    await SUT.drainProcessMessageQueue();
    await SUT.drainProcessMessageQueue();
    await SUT.drainProcessMessageQueue();

    expect(mockQuery).toHaveBeenCalledWith({ headerMessageId: "msgid@x" });
    expect(mockProcessMessage).toHaveBeenCalledWith(found, expect.anything());
  });

  it("fails closed for restored legacy work with no authoritative folder evidence", async () => {
    await SUT.cleanupProcessMessageQueue();
    browser.storage.local.get.mockResolvedValueOnce({
      agent_processmessage_pending: [{
        uniqueKey: "acct1:/Gone:msgid@x",
        timestamp: Date.now(),
        opts: {},
        metadata: {},
        attempts: 2,
      }],
    });
    browser.folders.query.mockResolvedValue([]);
    mockGetUniqueMessageKeyCandidates.mockReturnValue([]);
    mockHeaderIDToWeID.mockResolvedValue(null);
    vi.resetModules();
    SUT = await import("../agent/modules/messageProcessorQueue.js");
    await SUT.initProcessMessageQueue();

    await SUT.drainProcessMessageQueue();

    expect(mockQuery).not.toHaveBeenCalled();
    expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);
  });

  it("drains all result pages and ignores another account's same Message-ID", async () => {
    const other = {
      id: 900,
      folder: { id: "other", accountId: "acct2", name: "Inbox", path: "/INBOX" },
    };
    const target = {
      id: 901,
      folder: { id: "target", accountId: "acct1", name: "Inbox", path: "/INBOX" },
    };
    mockHeaderIDToWeID.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ messages: [other], id: "next-page" });
    mockContinueList.mockResolvedValue({ messages: [target] });

    await enqueueOne();
    await SUT.drainProcessMessageQueue();
    await SUT.drainProcessMessageQueue();
    await SUT.drainProcessMessageQueue();

    expect(mockContinueList).toHaveBeenCalledWith("next-page");
    expect(mockProcessMessage).toHaveBeenCalledWith(target, expect.anything());
    expect(mockProcessMessage).not.toHaveBeenCalledWith(other, expect.anything());
  });

  it("does not authorize deletion when a continuation page fails", async () => {
    const other = {
      id: 902,
      folder: { id: "other", accountId: "acct2", name: "Inbox", path: "/INBOX" },
    };
    mockHeaderIDToWeID.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ messages: [other], id: "next-page" });
    mockContinueList.mockRejectedValue(new Error("offline"));

    await enqueueOne();
    for (let i = 0; i < 3; i++) await SUT.drainProcessMessageQueue();

    expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);
    expect(mockProcessMessage).not.toHaveBeenCalled();
  });

  it("tag cleanup also drains pages and acts only on the target account", async () => {
    const other = {
      id: 903,
      folder: { id: "other", accountId: "acct2", name: "Archive", path: "/Archive" },
    };
    const target = {
      id: 904,
      folder: { id: "target", accountId: "acct1", name: "Archive", path: "/Archive" },
    };
    mockHeaderIDToWeID.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ messages: [other], id: "cleanup-next" });
    mockContinueList.mockResolvedValue({ messages: [target] });
    mockIsInboxFolder.mockReturnValue(false);

    await enqueueOne({ operationType: "tagCleanupOnLeaveInbox" });
    for (let i = 0; i < 3; i++) await SUT.drainProcessMessageQueue();

    expect(mockContinueList).toHaveBeenCalledWith("cleanup-next");
    expect(mockLeaveInboxCleanup).toHaveBeenCalledWith(target);
    expect(mockLeaveInboxCleanup).not.toHaveBeenCalledWith(other);
  });

  it("tag cleanup keeps retrying when target-account absence proof is incomplete", async () => {
    const other = {
      id: 905,
      folder: { id: "other", accountId: "acct2", name: "Archive", path: "/Archive" },
    };
    mockHeaderIDToWeID.mockResolvedValue(null);
    mockQuery.mockResolvedValue({ messages: [other], id: "cleanup-next" });
    mockContinueList.mockRejectedValue(new Error("offline"));

    await enqueueOne({ operationType: "tagCleanupOnLeaveInbox" });
    for (let i = 0; i < 3; i++) await SUT.drainProcessMessageQueue();

    expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);
    expect(mockLeaveInboxCleanup).not.toHaveBeenCalled();
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
