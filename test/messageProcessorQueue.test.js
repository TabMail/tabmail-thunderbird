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
  it("restores durable work before an early wake event can persist a new item", async () => {
    let resolveRead;
    browser.storage.local.get.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve; }));
    mockGetUniqueMessageKey.mockResolvedValueOnce("acct1:/INBOX:new@x");

    const enqueue = enqueueOne();
    await vi.waitFor(() => expect(browser.storage.local.get).toHaveBeenCalledOnce());
    expect(browser.storage.local.set).not.toHaveBeenCalled();

    resolveRead({ agent_processmessage_pending: [{
      uniqueKey: "acct1:/INBOX:old@x", timestamp: 1, opts: {}, metadata: { accountId: "acct1", folderPath: "/INBOX" },
    }] });
    expect((await enqueue).ok).toBe(true);
    await SUT.initProcessMessageQueue();
    await vi.waitFor(() => expect(browser.storage.local.set).toHaveBeenCalled());

    const keys = browser.storage.local.set.mock.calls.at(-1)[0].agent_processmessage_pending.map(item => item.uniqueKey);
    expect(keys).toEqual(["acct1:/INBOX:old@x", "acct1:/INBOX:new@x"]);
    expect(browser.storage.local.get).toHaveBeenCalledOnce();
    expect(SUT.getProcessMessageQueueStatus().pending).toBe(2);
  });

  it("refuses an early enqueue when restore fails and retries the read later", async () => {
    browser.storage.local.get.mockRejectedValueOnce(new Error("synthetic read failure"));
    expect((await enqueueOne()).ok).toBe(false);
    expect(browser.storage.local.set).not.toHaveBeenCalled();

    browser.storage.local.get.mockResolvedValueOnce({ agent_processmessage_pending: [] });
    expect((await enqueueOne()).ok).toBe(true);
    await vi.waitFor(() => expect(browser.storage.local.set).toHaveBeenCalledOnce());
    expect(browser.storage.local.get).toHaveBeenCalledTimes(2);
  });

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

describe('automatic mutation token lifetime',()=>{
 it('reuses the item token across retries and merges without persisting it',async()=>{
  mockHeaderIDToWeID.mockResolvedValue(123);
  mockGet.mockResolvedValue({id:123,folder:{id:'folder-inbox',accountId:'acct1',path:'/INBOX'},headerMessageId:'msgid@x'});
  mockProcessMessage.mockResolvedValueOnce({ok:false}).mockResolvedValue({ok:true});
  await enqueueOne({forceRecompute:true});await SUT.drainProcessMessageQueue();
  const firstToken=mockProcessMessage.mock.calls[0][1].token;expect(firstToken).toMatchObject({key:'acct1:/INBOX:msgid@x',valid:true});
  await enqueueOne({isPriority:true});await SUT.drainProcessMessageQueue();
  expect(mockProcessMessage.mock.calls[1][1].token).toBe(firstToken);
  const snapshots=browser.storage.local.set.mock.calls.map(([value])=>value.agent_processmessage_pending).filter(Boolean).flat();
  expect(snapshots.some(item=>'token' in item||'token' in (item.opts||{}))).toBe(false);
 });
});


describe('explicit recompute replaces older work',()=>{
 it.each([true,false])('preserves a new request when an older attempt completes with ok=%s',async ok=>{
  mockHeaderIDToWeID.mockResolvedValue(123);
  mockGet.mockResolvedValue({id:123,folder:{id:'folder-inbox',accountId:'acct1',path:'/INBOX'},headerMessageId:'msgid@x'});
  let release;mockProcessMessage.mockImplementationOnce(()=>new Promise(r=>{release=r;})).mockResolvedValue({ok:true});
  await enqueueOne();const oldDrain=SUT.drainProcessMessageQueue();
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  const oldToken=mockProcessMessage.mock.calls[0][1].token;
  await enqueueOne({forceRecompute:true});expect(oldToken.valid).toBe(false);
  release({ok});await oldDrain;expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);
  await SUT.drainProcessMessageQueue();
  expect(mockProcessMessage).toHaveBeenCalledTimes(2);
  expect(mockProcessMessage.mock.calls[1][1].token).not.toBe(oldToken);
  expect(SUT.getProcessMessageQueueStatus().pending).toBe(0);
 });
 it('releases a retained retry token on queue cleanup',async()=>{
  mockHeaderIDToWeID.mockResolvedValue(123);
  mockGet.mockResolvedValue({id:123,folder:{id:'folder-inbox',accountId:'acct1',path:'/INBOX'},headerMessageId:'msgid@x'});
  mockProcessMessage.mockResolvedValue({ok:false});
  await enqueueOne();await SUT.drainProcessMessageQueue();
  const token=mockProcessMessage.mock.calls[0][1].token;expect(token.valid).toBe(true);
  await SUT.cleanupProcessMessageQueue();expect(token.valid).toBe(false);
 });
});

describe('replacement during identity resolution',()=>{
 it('persists and executes a newer recompute after an older resolve finishes',async()=>{
  mockGet.mockResolvedValue({id:123,folder:{id:'folder-inbox',accountId:'acct1',path:'/INBOX'},headerMessageId:'msgid@x'});
  let release;
  mockHeaderIDToWeID.mockImplementationOnce(()=>new Promise(r=>{release=r;})).mockResolvedValue(123);
  mockProcessMessage.mockResolvedValue({ok:true});
  await enqueueOne();const oldDrain=SUT.drainProcessMessageQueue();
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));
  await enqueueOne({forceRecompute:true});release(123);await oldDrain;
  expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);
  const snapshots=browser.storage.local.set.mock.calls.map(([value])=>value.agent_processmessage_pending).filter(Boolean);
  expect(snapshots.length).toBeGreaterThan(0);
  const persisted=snapshots.at(-1);expect(persisted).toHaveLength(1);
  expect(persisted[0].opts.forceRecompute).toBe(true);
  expect(mockProcessMessage).toHaveBeenCalledTimes(1);
  expect(mockProcessMessage.mock.calls[0][1].token.valid).toBe(false);
  await SUT.drainProcessMessageQueue();
  expect(mockProcessMessage).toHaveBeenCalledTimes(2);
  expect(mockProcessMessage.mock.calls[1][1].forceRecompute).toBe(true);
  expect(mockProcessMessage.mock.calls[1][1].token).not.toBe(mockProcessMessage.mock.calls[0][1].token);
  expect(SUT.getProcessMessageQueueStatus().pending).toBe(0);
 });
});

describe('terminal queue outcomes',()=>{
 it.each(['outside','gone'])('retires writer-produced queue work in %s terminal state and accepts fresh work',async mode=>{
  const disk={};
  browser.storage.local={get:vi.fn(async()=>structuredClone(disk)),set:vi.fn(async v=>Object.assign(disk,structuredClone(v))),remove:vi.fn(async keys=>{for(const k of [].concat(keys))delete disk[k];})};
  const live={id:123,headerMessageId:'msgid@x',folder:{id:'folder-inbox',accountId:'acct1',path:'/INBOX'}};
  mockGet.mockResolvedValue(live);
  if(mode==='outside'){
   mockHeaderIDToWeID.mockResolvedValue(null);
   mockIsInboxFolder.mockImplementation(f=>f.path==='/INBOX');
   mockQuery.mockResolvedValue({messages:[{...live,id:456,folder:{...live.folder,id:'folder-sent',path:'/Sent'}}]});
  }else{
   mockHeaderIDToWeID.mockResolvedValue(123);
   mockProcessMessage.mockResolvedValue({ok:false,reason:'message-not-found'});
  }
  await enqueueOne();expect(SUT.getProcessMessageQueueStatus().pending).toBe(1);expect(disk.agent_processmessage_pending).toHaveLength(1);
  for(let n=0;n<(mode==='outside'?3:1);n++)await SUT.drainProcessMessageQueue();
  expect(SUT.getProcessMessageQueueStatus().pending).toBe(0);
  expect(disk.agent_processmessage_pending).toBeUndefined();
  const calls=mockProcessMessage.mock.calls.length;
  expect(calls).toBe(mode==='outside'?0:1);
  await SUT.drainProcessMessageQueue();expect(mockProcessMessage).toHaveBeenCalledTimes(calls);
  mockHeaderIDToWeID.mockResolvedValue(123);mockIsInboxFolder.mockReturnValue(true);mockProcessMessage.mockResolvedValue({ok:true});
  await enqueueOne();await SUT.drainProcessMessageQueue();
  expect(mockProcessMessage).toHaveBeenCalledTimes(calls+1);expect(SUT.getProcessMessageQueueStatus().pending).toBe(0);
  await SUT.cleanupProcessMessageQueue();
 });
});
