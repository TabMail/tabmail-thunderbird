/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";

vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn() }));
vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 1_000 } },
}));

// In-memory stand-in for browser.storage.session: one per browser session.
function sessionStore() {
  const data = new Map();
  return {
    data,
    get: vi.fn(async key => (data.has(key) ? { [key]: structuredClone(data.get(key)) } : {})),
    set: vi.fn(async items => {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    }),
  };
}

function makeNativePort(
  folderMembershipV1,
  assignmentResult = null,
  {
    canSelfUpdate = false,
    hostVersion = "0.11.2",
    updateCheckResult = null,
    updateRequestResult = null,
    deferUpdateRequest = false,
    updateExitScheduler = callback => setTimeout(callback, 0),
    folderMembershipSummaryV1 = false,
    summaryResult = null,
  } = {},
) {
  const listeners = [];
  const disconnectListeners = [];
  const messages = [];
  let initialized = false;
  let disconnected = false;
  let deferredUpdateRequest = null;
  const respond = (message, result, error = undefined, markInitialized = false, sync = false) => {
    const send = () => {
      if (markInitialized && !error) initialized = true;
      for (const listener of listeners) listener({ id: message.id, result, error });
      if (message.method === "updateRequest" && result?.success === true && !error) {
        updateExitScheduler(() => port.disconnect());
      }
    };
    if (sync) send();
    else void Promise.resolve().then(send);
  };
  const port = {
    messages,
    onMessage: { addListener: listener => listeners.push(listener) },
    onDisconnect: { addListener: listener => disconnectListeners.push(listener) },
    disconnect: vi.fn(() => {
      if (disconnected) return;
      disconnected = true;
      for (const listener of disconnectListeners) listener();
    }),
    releaseUpdateRequest() {
      if (!deferredUpdateRequest) throw new Error("update_request_not_requested");
      const message = deferredUpdateRequest;
      deferredUpdateRequest = null;
      respond(message, updateRequestResult || {
        success: false,
        oldVersion: hostVersion,
        newVersion: message.params.targetVersion,
        requiresRestart: false,
        message: "test_update_not_applied",
      }, undefined, false, true);
    },
    postMessage(message) {
      if (disconnected) throw new Error("native_port_disconnected");
      messages.push(message);
      let result;
      let error;
      let markInitialized = false;

      const preInitMethod = ["hello", "updateCheck", "updateRequest", "init"]
        .includes(message.method);
      if (!initialized && !preInitMethod) {
        respond(message, undefined, "native_not_initialized");
        return;
      }
      if (initialized && message.method === "init") {
        respond(message, undefined, "native_already_initialized");
        return;
      }
      if (initialized && message.method === "hello") {
        respond(message, undefined, "native_hello_after_init");
        return;
      }

      switch (message.method) {
        case "hello":
          result = {
            hostVersion,
            canSelfUpdate,
            isUserInstall: true,
            isSystemInstall: false,
            installPath: "/test/fts-helper",
            capabilities: { folderMembershipV1, folderMembershipSummaryV1 },
          };
          break;
        case "updateCheck":
          result = updateCheckResult || {
            currentVersion: hostVersion,
            targetVersion: message.params.targetVersion,
            needsUpdate: message.params.targetVersion !== hostVersion,
            canUpdate: canSelfUpdate,
          };
          break;
        case "updateRequest":
          if (deferUpdateRequest) {
            deferredUpdateRequest = message;
            return;
          }
          result = updateRequestResult || {
            success: false,
            oldVersion: hostVersion,
            newVersion: message.params.targetVersion,
            requiresRestart: false,
            message: "test_update_not_applied",
          };
          break;
        case "init":
          result = { dbPath: "/test/fts.sqlite" };
          markInitialized = true;
          break;
        case "indexBatch":
          result = { ok: true, count: message.params.rows.length };
          break;
        case "listFolderMembership":
          result = { ok: true, msgIds: [], done: true };
          break;
        case "listFolderMembershipState":
          result = { ok: true, entries: [], done: true };
          break;
        case "folderMembershipSummary":
          result = summaryResult || { ok: true, ownerlessRows: 0, strayTrustedRows: 0, strayUntrustedRows: 0 };
          break;
        case "assignFolderMembershipBatch":
          result = assignmentResult || {
            ok: true,
            assigned: 0,
            alreadyAssigned: 0,
            missing: message.params.assignments.length,
          };
          break;
        default:
          error = `native_unknown_method:${message.method}`;
      }
      respond(message, result, error, markInitialized);
    },
  };
  return port;
}

function makeDeferredHelloPort(
  folderMembershipV1,
  { failInit = false, deferInit = false } = {},
) {
  const listeners = [];
  const disconnectListeners = [];
  const messages = [];
  let helloMessage = null;
  let initMessage = null;
  let initialized = false;
  let disconnected = false;
  const respond = (message, result, error = undefined, markInitialized = false) => Promise.resolve().then(() => {
    if (markInitialized && !error) initialized = true;
    for (const listener of listeners) listener({ id: message.id, result, error });
  });
  return {
    messages,
    onMessage: { addListener: listener => listeners.push(listener) },
    onDisconnect: { addListener: listener => disconnectListeners.push(listener) },
    disconnect: vi.fn(() => {
      if (disconnected) return;
      disconnected = true;
      for (const listener of disconnectListeners) listener();
    }),
    releaseHello() {
      if (!helloMessage) throw new Error("hello_not_requested");
      return respond(helloMessage, {
        hostVersion: "0.11.2",
        canSelfUpdate: false,
        isUserInstall: true,
        isSystemInstall: false,
        installPath: "/test/fts-helper",
        capabilities: { folderMembershipV1 },
      });
    },
    releaseInit() {
      if (!initMessage) throw new Error("init_not_requested");
      return respond(
        initMessage,
        failInit ? undefined : { dbPath: "/test/fts.sqlite" },
        failInit ? "native_init_failed" : undefined,
        true,
      );
    },
    postMessage(message) {
      if (disconnected) throw new Error("native_port_disconnected");
      messages.push(message);
      if (message.method === "hello") {
        if (initialized) {
          void respond(message, undefined, "native_hello_after_init");
          return;
        }
        helloMessage = message;
      } else if (message.method === "init") {
        if (initialized) {
          void respond(message, undefined, "native_already_initialized");
          return;
        }
        if (deferInit) initMessage = message;
        else {
          void respond(
            message,
            failInit ? undefined : { dbPath: "/test/fts.sqlite" },
            failInit ? "native_init_failed" : undefined,
            true,
          );
        }
      } else if (message.method === "indexBatch") {
        void respond(
          message,
          initialized ? { ok: true, count: message.params.rows.length } : undefined,
          initialized ? undefined : "native_not_initialized",
        );
      }
    },
  };
}

async function initialized(folderMembershipV1, assignmentResult = null, portOptions = {}) {
  vi.resetModules();
  const port = makeNativePort(folderMembershipV1, assignmentResult, portOptions);
  globalThis.browser = {
    tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
    runtime: {
      getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
      connectNative: vi.fn(() => port),
      getManifest: vi.fn(() => ({
        version: "1.7.3",
        browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
      })),
    },
  };
  const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
  await initNativeFts();
  return { nativeFtsSearch, port };
}

async function connectedRecoveryHarness() {
  const { nativeFtsSearch, port } = await initialized(true);
  const armed = new Map();
  let alarmListener;
  browser.alarms = {
    create: vi.fn((name, details) => { armed.set(name, details); }),
    clear: vi.fn(name => { armed.delete(name); }),
    onAlarm: { addListener: listener => { alarmListener = listener; } },
  };
  const source = readFileSync(new URL("../chat/background.js", import.meta.url), "utf8");
  const start = source.indexOf("const FTS_RECHECK_ALARM =");
  const end = source.indexOf("// Initialize FTS engine FIRST", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const context = {
    browser,
    log: vi.fn(),
    setWarning: vi.fn(async () => {}),
    getFtsHelperAvailable: () => nativeFtsSearch.getHostAvailability(),
    getFtsHelperStatus: () => nativeFtsSearch.getHostStatus(),
    recheckFtsHelperAvailable: () => nativeFtsSearch.recheckAvailability(),
    initFtsEngine: vi.fn(async () => {}),
    checkAndRunInitialFtsScan: vi.fn(async () => {}),
  };
  vm.createContext(context);
  vm.runInContext(`${source.slice(start, end)}\nthis.syncWarning = syncFtsWarning; this.probe = probeFtsAvailability;`, context);
  return {
    port, nativeFtsSearch, armed, context,
    fireAlarm: () => alarmListener({ name: "tabmail-fts-helper-recheck" }),
  };
}

afterEach(() => {
  delete globalThis.browser;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native folder-membership v1 contract", () => {
  it("retains one recovery alarm after late disconnect and clears it only after reconnect", async () => {
    const app = await connectedRecoveryHarness();
    await app.context.syncWarning();
    expect(app.armed.size).toBe(0);

    app.port.disconnect();
    app.port.disconnect();
    expect(app.nativeFtsSearch.getHostAvailability()).toBe(false);
    expect(app.armed.has("tabmail-fts-helper-recheck")).toBe(true);
    expect(app.armed.get("tabmail-fts-helper-recheck")).toEqual({ periodInMinutes: 1 });
    expect(browser.alarms.create).toHaveBeenCalledTimes(1);

    const replacement = makeNativePort(true);
    browser.runtime.connectNative.mockReturnValue(replacement);
    app.fireAlarm();
    await vi.waitFor(() => expect(app.context.checkAndRunInitialFtsScan).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(app.armed.size).toBe(0));
    expect(app.nativeFtsSearch.getHostAvailability()).toBe(true);

    replacement.disconnect();
    expect(app.nativeFtsSearch.getHostAvailability()).toBe(false);
    expect(app.armed.has("tabmail-fts-helper-recheck")).toBe(true);
    expect(browser.alarms.create).toHaveBeenCalledTimes(2);
  });

  it("keeps a newer disconnect alarm when an older warning update finishes", async () => {
    const app = await connectedRecoveryHarness();
    app.port.disconnect();
    await app.context.syncWarning();
    let finishWarning;
    app.context.setWarning.mockImplementationOnce(() => new Promise(resolve => {
      finishWarning = resolve;
    }));
    const replacement = makeNativePort(true);
    browser.runtime.connectNative.mockReturnValue(replacement);
    app.fireAlarm();
    await vi.waitFor(() => expect(typeof finishWarning).toBe("function"));
    replacement.disconnect();
    expect(app.armed.has("tabmail-fts-helper-recheck")).toBe(true);
    const recovery = app.context.probe();
    finishWarning();
    await recovery;
    expect(app.nativeFtsSearch.getHostAvailability()).toBe(false);
    expect(app.armed.has("tabmail-fts-helper-recheck")).toBe(true);
  });

  it.each(["throw", "reject"])("cleans up pending native work when alarm creation %ss", async mode => {
    const app = await connectedRecoveryHarness();
    browser.alarms.create.mockImplementation(() => {
      if (mode === "throw") throw new Error("alarm unavailable");
      return Promise.reject(new Error("alarm unavailable"));
    });
    const originalPost = app.port.postMessage;
    app.port.postMessage = message => {
      if (message.method === "indexBatch") {
        app.port.messages.push(message);
        return;
      }
      originalPost(message);
    };
    const pending = app.nativeFtsSearch.indexBatch([{
      msgId: "account:/Inbox:synthetic@example.invalid",
      folderId: "folder-1", body: "",
    }]);
    const failure = pending.catch(error => error);
    await vi.waitFor(() => expect(app.port.messages.some(message => message.method === "indexBatch")).toBe(true));
    expect(() => app.port.disconnect()).not.toThrow();
    expect((await failure).message).toBe("Native helper disconnected");
    expect(app.nativeFtsSearch.getHostAvailability()).toBe(false);

    const replacement = makeNativePort(true);
    browser.runtime.connectNative.mockReturnValue(replacement);
    expect(await app.nativeFtsSearch.recheckAvailability()).toBe(true);
  });

  it("injects opaque folderId on fresh writes only when hello advertises the capability", async () => {
    const supported = await initialized(true);
    const supportedWire = { withFolderIds: false };
    await supported.nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:Acme:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    }], supportedWire);
    expect(supportedWire.withFolderIds).toBe(true);
    expect(supported.nativeFtsSearch.supportsFolderMembership()).toBe(true);
    expect(supported.port.messages.find(message => message.method === "indexBatch")?.params.rows)
      .toEqual([expect.objectContaining({
        msgId: "account:/Client:Acme:message@example.com",
        folderId: "opaque-folder-17",
      })]);

    const unsupported = await initialized(false);
    const unsupportedWire = { withFolderIds: true };
    await unsupported.nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:Acme:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    }], unsupportedWire);
    expect(unsupportedWire.withFolderIds).toBe(false);
    expect(unsupported.nativeFtsSearch.supportsFolderMembership()).toBe(false);
    expect(unsupported.port.messages.find(message => message.method === "indexBatch")?.params.rows)
      .toEqual([{
        msgId: "account:/Client:Acme:message@example.com",
        body: "",
      }]);
  });

  it("fails a capable fresh write closed when its opaque folderId is absent", async () => {
    const { nativeFtsSearch, port } = await initialized(true);

    await expect(nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:message@example.com",
      body: "",
    }])).rejects.toThrow("missing opaque folderId");
    expect(port.messages.some(message => message.method === "indexBatch")).toBe(false);
  });

  it("includes string cursors in both folder-membership reader RPC shapes", async () => {
    const { nativeFtsSearch, port } = await initialized(true);

    await nativeFtsSearch.listFolderMembership("opaque-folder-17", "after-key", 25);
    await nativeFtsSearch.listFolderMembershipState("after-key", 25);

    expect(port.messages.find(message => message.method === "listFolderMembership")?.params)
      .toEqual({ folderId: "opaque-folder-17", afterMsgId: "after-key", limit: 25 });
    expect(port.messages.find(message => message.method === "listFolderMembershipState")?.params)
      .toEqual({ afterMsgId: "after-key", limit: 25 });
  });

  it.each([
    { cursor: null, label: "null" },
    { cursor: undefined, label: "undefined" },
  ])("omits a $label cursor from both folder-membership reader RPC shapes", async ({ cursor }) => {
    const { nativeFtsSearch, port } = await initialized(true);

    await nativeFtsSearch.listFolderMembership("opaque-folder-17", cursor, 25);
    await nativeFtsSearch.listFolderMembershipState(cursor, 25);

    expect(port.messages.find(message => message.method === "listFolderMembership")?.params)
      .toStrictEqual({ folderId: "opaque-folder-17", limit: 25 });
    expect(port.messages.find(message => message.method === "listFolderMembershipState")?.params)
      .toStrictEqual({ limit: 25 });
  });

  it("forwards non-null malformed cursors to native validation in both reader RPC shapes", async () => {
    const { nativeFtsSearch, port } = await initialized(true);

    await nativeFtsSearch.listFolderMembership("opaque-folder-17", 17, 25);
    await nativeFtsSearch.listFolderMembershipState(17, 25);

    expect(port.messages.find(message => message.method === "listFolderMembership")?.params)
      .toStrictEqual({ folderId: "opaque-folder-17", afterMsgId: 17, limit: 25 });
    expect(port.messages.find(message => message.method === "listFolderMembershipState")?.params)
      .toStrictEqual({ afterMsgId: 17, limit: 25 });
  });

  it.each([
    { folderMembershipSummaryV1: true, expected: true },
    { folderMembershipSummaryV1: false, expected: false },
    { folderMembershipSummaryV1: "true", expected: false },
  ])("reports the membership summary only when hello advertises it as $folderMembershipSummaryV1", async ({ folderMembershipSummaryV1, expected }) => {
    const { nativeFtsSearch } = await initialized(true, null, { folderMembershipSummaryV1 });
    expect(nativeFtsSearch.supportsFolderMembershipSummary()).toBe(expected);
  });

  it("asks for the membership summary with the inventory's folder ids and trusted accounts", async () => {
    const reply = { ok: true, ownerlessRows: 2, strayTrustedRows: 0, strayUntrustedRows: 5 };
    const { nativeFtsSearch, port } = await initialized(true, null, {
      folderMembershipSummaryV1: true,
      summaryResult: reply,
    });

    await expect(nativeFtsSearch.folderMembershipSummary(["opaque-folder-17", "opaque-folder-18"], ["account1"]))
      .resolves.toEqual(reply);
    expect(port.messages.find(message => message.method === "folderMembershipSummary")?.params)
      .toStrictEqual({ folderIds: ["opaque-folder-17", "opaque-folder-18"], trustedAccountIds: ["account1"] });
  });

  it.each([
    { label: "not ok", summaryResult: { ok: false, ownerlessRows: 0, strayTrustedRows: 0, strayUntrustedRows: 0 } },
    { label: "a missing count", summaryResult: { ok: true, ownerlessRows: 0, strayTrustedRows: 0 } },
    { label: "a negative count", summaryResult: { ok: true, ownerlessRows: -1, strayTrustedRows: 0, strayUntrustedRows: 0 } },
    { label: "a fractional count", summaryResult: { ok: true, ownerlessRows: 0, strayTrustedRows: 0.5, strayUntrustedRows: 0 } },
    { label: "a string count", summaryResult: { ok: true, ownerlessRows: 0, strayTrustedRows: 0, strayUntrustedRows: "0" } },
  ])("rejects a membership summary reply with $label", async ({ summaryResult }) => {
    const { nativeFtsSearch } = await initialized(true, null, { folderMembershipSummaryV1: true, summaryResult });
    await expect(nativeFtsSearch.folderMembershipSummary(["opaque-folder-17"], ["account1"]))
      .rejects.toThrow("invalid response");
  });

  it("uses the frozen exact-equality metadata backfill RPC shape", async () => {
    const { nativeFtsSearch, port } = await initialized(true);

    await nativeFtsSearch.assignFolderMembershipBatch([{
      msgId: "account:/Client:Acme:message@example.com",
      folderId: "opaque-folder-17",
    }]);

    expect(port.messages.some(message => message.method === "fingerprintFolderMembership"))
      .toBe(false);
    expect(port.messages.find(message => message.method === "assignFolderMembershipBatch"))
      .toMatchObject({ params: { assignments: [{
        msgId: "account:/Client:Acme:message@example.com",
        folderId: "opaque-folder-17",
      }] } });
  });

  it("accepts missing assignments as accounted no-ops", async () => {
    const { nativeFtsSearch } = await initialized(true);
    const result = await nativeFtsSearch.assignFolderMembershipBatch([{
      msgId: "account:/Gone:missing@example.com",
      folderId: "opaque-folder-17",
    }]);

    expect(result).toMatchObject({ assigned: 0, alreadyAssigned: 0, missing: 1 });
  });

  it("rejects assignment replies that do not account for every input row", async () => {
    const { nativeFtsSearch } = await initialized(true, {
      ok: true,
      assigned: 0,
      alreadyAssigned: 0,
      missing: 0,
    });

    await expect(nativeFtsSearch.assignFolderMembershipBatch([{
      msgId: "account:/Gone:missing@example.com",
      folderId: "opaque-folder-17",
    }])).rejects.toThrow("invalid response");
  });

  it("shapes index rows from the capability of the reconnected port", async () => {
    vi.resetModules();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const capable = makeNativePort(true);
    const legacy = makeNativePort(false);
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        connectNative: vi.fn()
          .mockReturnValueOnce(capable)
          .mockReturnValueOnce(legacy),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    await initNativeFts();
    capable.disconnect();
    now.mockReturnValue(62_000);

    // Shaped (and reported) for the port that receives it, not the one
    // current when the call began.
    const wire = { withFolderIds: true };
    await nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    }], wire);

    expect(wire.withFolderIds).toBe(false);
    expect(legacy.messages.find(message => message.method === "indexBatch")?.params.rows)
      .toEqual([{ msgId: "account:/Client:message@example.com", body: "" }]);
    expect(legacy.messages.map(message => message.method))
      .toEqual(["hello", "init", "indexBatch"]);
    now.mockRestore();
  });

  it.each([true, false])(
    "publishes hello capability but waits for receiving init before indexBatch (capable=%s)",
    async folderMembershipV1 => {
      vi.resetModules();
      const port = makeDeferredHelloPort(folderMembershipV1, { deferInit: true });
      globalThis.browser = {
        tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
        runtime: {
          getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
          connectNative: vi.fn(() => port),
          getManifest: vi.fn(() => ({
            version: "1.7.3",
            browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
          })),
        },
      };
      const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
      const initializing = initNativeFts();
      await Promise.resolve();
      const indexing = nativeFtsSearch.indexBatch([{
        msgId: "account:/Client:message@example.com",
        folderId: "tm-folder:v1:[\"account\",\"/Client\"]",
        body: "",
      }]);
      await Promise.resolve();

      expect(port.messages.some(message => message.method === "indexBatch")).toBe(false);
      await port.releaseHello();
      for (let turn = 0; turn < 20
        && !port.messages.some(message => message.method === "init"); turn++) {
        await Promise.resolve();
      }
      expect(nativeFtsSearch.supportsFolderMembership()).toBe(folderMembershipV1);
      expect(port.messages.map(message => message.method)).toEqual(["hello", "init"]);
      await port.releaseInit();
      await Promise.all([initializing, indexing]);

      expect(port.messages.map(message => message.method))
        .toEqual(["hello", "init", "indexBatch"]);
      const wireRow = port.messages.find(message => message.method === "indexBatch").params.rows[0];
      if (folderMembershipV1) {
        expect(wireRow.folderId).toBe('tm-folder:v1:["account","/Client"]');
      } else {
        expect(wireRow).not.toHaveProperty("folderId");
      }
    },
  );

  it("wakes connection listeners once per operational generation until unsubscribed", async () => {
    vi.resetModules();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const legacy = makeNativePort(false);
    const capable = makeNativePort(true);
    const later = makeNativePort(true);
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        connectNative: vi.fn()
          .mockReturnValueOnce(legacy)
          .mockReturnValueOnce(capable)
          .mockReturnValueOnce(later),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    const seen = [];
    nativeFtsSearch.addConnectionListener(() => { throw new Error("listener_failure"); });
    const unsubscribe = nativeFtsSearch.addConnectionListener(generation => seen.push(generation));

    await initNativeFts();
    expect(seen).toEqual([nativeFtsSearch.getConnectionGeneration()]);
    expect(nativeFtsSearch.supportsFolderMembership()).toBe(false);

    legacy.disconnect();
    now.mockReturnValue(62_000);
    await nativeFtsSearch.indexBatch([{ msgId: "account:/Client:message@example.com", folderId: "f", body: "" }]);
    expect(nativeFtsSearch.supportsFolderMembership()).toBe(true);
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBeGreaterThan(seen[0]);
    expect(seen[1]).toBe(nativeFtsSearch.getConnectionGeneration());

    unsubscribe();
    capable.disconnect();
    now.mockReturnValue(123_000);
    await nativeFtsSearch.indexBatch([{ msgId: "account:/Client:message@example.com", folderId: "f", body: "" }]);
    expect(later.messages.map(message => message.method)).toContain("init");
    expect(seen).toHaveLength(2);
    now.mockRestore();
  });

  it("does not wake connection listeners when native init fails", async () => {
    vi.resetModules();
    const port = makeDeferredHelloPort(true, { failInit: true });
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        connectNative: vi.fn(() => port),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    const listener = vi.fn();
    nativeFtsSearch.addConnectionListener(listener);
    const initializing = initNativeFts();
    await Promise.resolve();
    await port.releaseHello();
    await expect(initializing).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });

  it("coalesces concurrent initialization onto one native port generation", async () => {
    vi.resetModules();
    const first = makeDeferredHelloPort(true);
    const second = makeDeferredHelloPort(true);
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        connectNative: vi.fn()
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(second),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
      },
    };
    const { initNativeFts } = await import("../fts/nativeEngine.js");

    const initA = initNativeFts();
    const initB = initNativeFts();
    await Promise.resolve();
    if (first.messages.some(message => message.method === "hello")) await first.releaseHello();
    if (second.messages.some(message => message.method === "hello")) await second.releaseHello();
    await Promise.all([initA, initB]);

    expect(initA).toBe(initB);
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(1);
    expect(first.messages.map(message => message.method)).toEqual(["hello", "init"]);
    expect(second.messages).toEqual([]);
  });

  it("rejects concurrent external waiters when bootstrap init fails", async () => {
    vi.resetModules();
    const port = makeDeferredHelloPort(true, { failInit: true });
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        connectNative: vi.fn(() => port),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    const initPromise = initNativeFts();
    const row = {
      msgId: "account:/Client:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    };
    const waiterA = nativeFtsSearch.indexBatch([row]);
    const waiterB = nativeFtsSearch.indexBatch([row]);
    await Promise.resolve();

    await port.releaseHello();

    await expect(initPromise).rejects.toThrow("native_init_failed");
    await expect(waiterA).rejects.toThrow();
    await expect(waiterB).rejects.toThrow();
    expect(port.messages.map(message => message.method)).toEqual(["hello", "init"]);
  });

  it.each([
    { failure: "asynchronous rejection", firstOptions: { failInit: true } },
    { failure: "timeout", firstOptions: { deferInit: true } },
  ])("disconnects a current $failure generation once and retries cleanly", async ({
    failure,
    firstOptions,
  }) => {
    vi.resetModules();
    vi.useFakeTimers();
    const first = makeDeferredHelloPort(true, firstOptions);
    const second = makeNativePort(true);
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        connectNative: vi.fn()
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(second),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    const row = {
      msgId: "account:/Client:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    };
    const firstInit = initNativeFts();
    const firstOutcome = firstInit.then(
      () => ({ ok: true }),
      error => ({ ok: false, error }),
    );
    const staleWaiter = nativeFtsSearch.indexBatch([row]);
    const staleOutcome = staleWaiter.then(
      () => ({ ok: true }),
      error => ({ ok: false, error }),
    );

    await Promise.resolve();
    await first.releaseHello();
    for (let turn = 0; turn < 20
      && !first.messages.some(message => message.method === "init"); turn++) {
      await Promise.resolve();
    }
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(1_001);

    const [failedInit, failedWaiter] = await Promise.all([firstOutcome, staleOutcome]);
    expect(failedInit.ok).toBe(false);
    expect(failedWaiter.ok).toBe(false);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(first.messages.map(message => message.method)).toEqual(["hello", "init"]);
    expect(nativeFtsSearch.getHostStatus().status).toBe("missing");

    const retry = initNativeFts();
    const recoveredWork = nativeFtsSearch.indexBatch([row]);
    await Promise.all([retry, recoveredWork]);

    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(first.messages.some(message => message.method === "indexBatch")).toBe(false);
    expect(second.messages.map(message => message.method))
      .toEqual(["hello", "init", "indexBatch"]);
    expect(second.messages.filter(message => message.method === "indexBatch"))
      .toHaveLength(1);
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the native pre-init update gate before init", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        latest: {
          version: "0.11.3",
          downloadUrl: "https://cdn.test/native-fts.zip",
          sha256: "ab".repeat(32),
          signature: "test-signature",
        },
      }),
    })));
    const port = makeNativePort(true, null, {
      canSelfUpdate: true,
      updateRequestResult: {
        success: false,
        oldVersion: "0.11.2",
        newVersion: "0.11.3",
        requiresRestart: false,
        message: "test_update_not_applied",
      },
    });
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      storage: { session: sessionStore() },
      runtime: {
        connectNative: vi.fn(() => port),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await initNativeFts();

    expect(port.messages.map(message => message.method))
      .toEqual(["hello", "updateCheck", "updateRequest", "init"]);
    expect(port.messages.find(message => message.method === "updateCheck")?.params)
      .toEqual({ targetVersion: "0.11.3" });
    expect(port.messages.find(message => message.method === "updateRequest")?.params)
      .toMatchObject({
        targetVersion: "0.11.3",
        updateUrl: "https://cdn.test/native-fts.zip",
        platform: "macos-universal",
      });
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");

    expect(port.disconnect).not.toHaveBeenCalled();
  });

  it.each(["before", "during", "after"])(
    "commits a successful update when the old host exits %s the delayed banner",
    async exitTiming => {
      vi.resetModules();
      vi.useFakeTimers();
      let scheduledExit = null;
      const updateExitScheduler = callback => {
        scheduledExit = callback;
        if (exitTiming === "before") callback();
        if (exitTiming === "during") setTimeout(callback, 0);
      };
      let releaseBanner;
      const banner = new Promise(resolve => { releaseBanner = resolve; });
      const showUpdateBar = vi.fn(() => banner);
      const updateFetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          latest: {
            version: "0.11.3",
            downloadUrl: "https://cdn.test/native-fts.zip",
            sha256: "ab".repeat(32),
            signature: "test-signature",
          },
        }),
      }));
      vi.stubGlobal("fetch", updateFetch);
      const first = makeNativePort(true, null, {
        canSelfUpdate: true,
        updateRequestResult: {
          success: true,
          oldVersion: "0.11.2",
          newVersion: "0.11.3",
          requiresRestart: true,
          message: "updated",
        },
        updateExitScheduler,
      });
      const second = makeNativePort(true, null, {
        canSelfUpdate: true,
        hostVersion: "0.11.3",
      });
      globalThis.browser = {
        tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
        storage: { session: sessionStore() },
        runtime: {
          connectNative: vi.fn()
            .mockReturnValueOnce(first)
            .mockReturnValueOnce(second),
          getManifest: vi.fn(() => ({
            version: "1.7.3",
            browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
          })),
          getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        },
        tmUpdates: { showUpdateBar },
      };
      const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
      const updating = initNativeFts();
      const updateOutcome = updating.then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
      );
      for (let turn = 0; turn < 30 && showUpdateBar.mock.calls.length === 0; turn++) {
        await Promise.resolve();
      }

      expect(showUpdateBar).toHaveBeenCalledOnce();
      expect(first.messages.map(message => message.method))
        .toEqual(["hello", "updateCheck", "updateRequest"]);
      expect(first.messages.some(message => message.method === "init")).toBe(false);
      if (exitTiming === "during") await vi.advanceTimersByTimeAsync(0);
      expect(first.disconnect).toHaveBeenCalledTimes(exitTiming === "after" ? 0 : 1);
      expect(nativeFtsSearch.getHostStatus().status).not.toBe("available");

      releaseBanner();
      const committed = await updateOutcome;
      expect(committed).toEqual({ ok: true, value: true });
      expect(nativeFtsSearch.getHostStatus().status).not.toBe("available");
      if (exitTiming === "after") scheduledExit();
      expect(first.disconnect).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(1_000);
      for (let turn = 0; turn < 30
        && nativeFtsSearch.getHostStatus().status !== "available"; turn++) {
        await Promise.resolve();
      }

      expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
      expect(second.messages.map(message => message.method))
        .toEqual(["hello", "updateCheck", "init"]);
      expect(second.disconnect).not.toHaveBeenCalled();
      expect(nativeFtsSearch.getHostStatus().status).toBe("available");
      expect(updateFetch).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
    },
  );

  it("guards a replacement while a pre-init update request completion is queued", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({
        latest: {
          version: "0.11.3",
          downloadUrl: "https://cdn.test/native-fts.zip",
          sha256: "ab".repeat(32),
          signature: "test-signature",
        },
      }),
    })));
    const first = makeNativePort(true, null, {
      canSelfUpdate: true,
      deferUpdateRequest: true,
      updateRequestResult: {
        success: false,
        oldVersion: "0.11.2",
        newVersion: "0.11.3",
        requiresRestart: false,
        message: "test_update_not_applied",
      },
    });
    const second = makeNativePort(true);
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      storage: { session: sessionStore() },
      runtime: {
        connectNative: vi.fn()
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(second),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    const firstInit = initNativeFts();
    const firstOutcome = firstInit.then(
      () => ({ ok: true }),
      error => ({ ok: false, error }),
    );
    for (let turn = 0; turn < 20
      && !first.messages.some(message => message.method === "updateRequest"); turn++) {
      await Promise.resolve();
    }
    expect(first.messages.map(message => message.method))
      .toEqual(["hello", "updateCheck", "updateRequest"]);

    // Resolve A's update request, but replace it before the awaiting bootstrap
    // continuation can dispatch init. A stale rejection tail must not touch B.
    first.releaseUpdateRequest();
    first.disconnect();
    const secondInit = initNativeFts();
    const stale = await firstOutcome;
    expect(stale.ok).toBe(false);
    await secondInit;

    expect(first.messages.map(message => message.method))
      .toEqual(["hello", "updateCheck", "updateRequest"]);
    expect(second.messages.map(message => message.method)).toEqual(["hello", "init"]);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(second.disconnect).not.toHaveBeenCalled();
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");

    await nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    }]);
    expect(second.messages.map(message => message.method))
      .toEqual(["hello", "init", "indexBatch"]);
  });

  it("retries with a fresh generation after connectNative throws synchronously", async () => {
    vi.resetModules();
    const recovered = makeNativePort(true);
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        connectNative: vi.fn()
          .mockImplementationOnce(() => { throw new Error("native_connect_sync_failed"); })
          .mockReturnValueOnce(recovered),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    const row = {
      msgId: "account:/Client:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    };

    const firstInit = initNativeFts();
    const staleWaiter = nativeFtsSearch.indexBatch([row]);
    await expect(firstInit).rejects.toThrow("native_connect_sync_failed");
    await expect(staleWaiter).rejects.toThrow();

    await initNativeFts();
    await nativeFtsSearch.indexBatch([row]);

    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(recovered.messages.map(message => message.method))
      .toEqual(["hello", "init", "indexBatch"]);
    expect(recovered.messages.filter(message => message.method === "indexBatch"))
      .toHaveLength(1);
    expect(recovered.disconnect).not.toHaveBeenCalled();
  });

  it("does not let stale rejection cleanup clear an overlapping generation", async () => {
    vi.resetModules();
    const first = makeDeferredHelloPort(true);
    const second = makeDeferredHelloPort(true, { deferInit: true });
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
        connectNative: vi.fn()
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(second),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    const row = {
      msgId: "account:/Client:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    };

    const firstInit = initNativeFts();
    const firstOutcome = firstInit.then(
      () => ({ ok: true }),
      error => ({ ok: false, error }),
    );
    await Promise.resolve();
    expect(first.messages.map(message => message.method)).toEqual(["hello"]);

    // Disconnect synchronously clears A's active slot, allowing B to publish
    // before A's queued rejection-cleanup microtask runs.
    first.disconnect();
    const secondInit = initNativeFts();
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);

    const failed = await firstOutcome;
    expect(failed.ok).toBe(false);
    const sameSecondInit = initNativeFts();
    expect(sameSecondInit).toBe(secondInit);

    const indexing = nativeFtsSearch.indexBatch([row]);
    await second.releaseHello();
    for (let turn = 0; turn < 20
      && !second.messages.some(message => message.method === "init"); turn++) {
      await Promise.resolve();
    }
    await second.releaseInit();
    await Promise.all([secondInit, sameSecondInit, indexing]);

    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(second.messages.map(message => message.method))
      .toEqual(["hello", "init", "indexBatch"]);
  });

  it("does not let a stale update-check generation init or poison its replacement", async () => {
    vi.resetModules();
    let releaseUpdateFetch;
    const updateFetch = vi.fn(() => new Promise(resolve => {
      releaseUpdateFetch = () => resolve({
        ok: true,
        json: async () => ({ latest: { version: "0.11.2" } }),
      });
    }));
    vi.stubGlobal("fetch", updateFetch);
    const first = makeNativePort(true, null, { canSelfUpdate: true });
    const second = makeNativePort(true);
    globalThis.browser = {
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      storage: { session: sessionStore() },
      runtime: {
        connectNative: vi.fn()
          .mockReturnValueOnce(first)
          .mockReturnValueOnce(second),
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
      },
    };
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");
    const firstInit = initNativeFts();
    const firstOutcome = firstInit.then(
      () => ({ ok: true }),
      error => ({ ok: false, error }),
    );
    for (let turn = 0; turn < 10 && updateFetch.mock.calls.length === 0; turn++) {
      await Promise.resolve();
    }
    expect(updateFetch).toHaveBeenCalledOnce();

    first.disconnect();
    await initNativeFts();
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");
    expect(second.messages.map(message => message.method)).toEqual(["hello", "init"]);

    releaseUpdateFetch();
    const stale = await firstOutcome;
    expect(stale.ok).toBe(false);
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");
    expect(first.messages.map(message => message.method)).toEqual(["hello"]);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(second.disconnect).not.toHaveBeenCalled();

    await nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    }]);
    expect(second.messages.map(message => message.method))
      .toEqual(["hello", "init", "indexBatch"]);
  });
});

describe("native helper update reconnect", () => {
  const manifestFetch = (published = { version: "0.11.3" }) => vi.fn(async () => ({
    ok: true,
    json: async () => ({
      latest: {
        version: published.version,
        downloadUrl: "https://cdn.test/native-fts.zip",
        sha256: "ab".repeat(32),
        signature: "test-signature",
      },
    }),
  }));
  const installBrowser = (...ports) => {
    const connectNative = vi.fn();
    for (const port of ports) connectNative.mockReturnValueOnce(port);
    globalThis.browser = {
      storage: { session: sessionStore() },
      tmMsgNotify: { getFtsDataDir: async () => '/test/profile/browser-extension-data/thunderbird@tabmail.ai' },
      runtime: {
        connectNative,
        getManifest: vi.fn(() => ({
          version: "1.7.3",
          browser_specific_settings: { gecko: { id: "thunderbird@tabmail.ai" } },
        })),
        getPlatformInfo: vi.fn(async () => ({ os: "mac", arch: "aarch64" })),
      },
      tmUpdates: { showUpdateBar: vi.fn(async () => {}) },
    };
  };
  const methods = port => port.messages.map(message => message.method);
  // Every update request carries the whole published release: the helper checks
  // its signature over these fields, so a request missing any of them fails.
  const publishedRequest = {
    targetVersion: "0.11.3",
    updateUrl: "https://cdn.test/native-fts.zip",
    sha256: "ab".repeat(32),
    signature: "test-signature",
    platform: "macos-universal",
  };
  const updateRequests = port => port.messages
    .filter(message => message.method === "updateRequest")
    .map(message => message.params);
  const freshRow = {
    msgId: "account:/Client:message@example.com",
    folderId: "opaque-folder-17",
    body: "",
  };

  it("treats a helper that exits without answering its update as an ordinary disconnect", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", manifestFetch());
    const first = makeNativePort(true, null, { canSelfUpdate: true, deferUpdateRequest: true });
    const second = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(first, second);
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    const outcome = initNativeFts().then(() => ({ ok: true }), error => ({ ok: false, error }));
    for (let turn = 0; turn < 30 && !methods(first).includes("updateRequest"); turn++) {
      await Promise.resolve();
    }
    expect(methods(first)).toEqual(["hello", "updateCheck", "updateRequest"]);
    first.disconnect();
    expect((await outcome).ok).toBe(false);
    expect(nativeFtsSearch.getHostStatus().status).toBe("missing");

    // No reconnect inside the cooldown: the dropped update is not taken for a restart.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(browser.runtime.connectNative).toHaveBeenCalledOnce();

    // After the cooldown an ordinary request reconnects, and the same update is
    // not requested again this session.
    await vi.advanceTimersByTimeAsync(31_000);
    await nativeFtsSearch.indexBatch([freshRow]);
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(methods(second)).toEqual(["hello", "updateCheck", "init", "indexBatch"]);
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");
  });

  it("does not request an update that failed again on a later connection, but a manual check does", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", manifestFetch());
    const first = makeNativePort(true, null, { canSelfUpdate: true });
    const second = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(first, second);
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await initNativeFts();
    expect(methods(first)).toEqual(["hello", "updateCheck", "updateRequest", "init"]);
    expect(updateRequests(first)).toEqual([publishedRequest]);
    expect(first.disconnect).not.toHaveBeenCalled();
    first.disconnect();
    expect(nativeFtsSearch.getHostStatus().status).toBe("missing");
    expect(await nativeFtsSearch.recheckAvailability()).toBe(true);
    expect(methods(second)).toEqual(["hello", "updateCheck", "init"]);

    const manual = await nativeFtsSearch.manualCheckAndUpdateHost();
    expect(manual).toEqual({ ok: false, error: "test_update_not_applied" });
    expect(methods(second)).toEqual(["hello", "updateCheck", "init", "updateCheck", "updateRequest"]);
    expect(updateRequests(second)).toEqual([publishedRequest]);
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
  });

  it("reconnects once after a successful update and does not repeat it when the old helper is still installed", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubGlobal("fetch", manifestFetch());
    const updated = {
      success: true,
      oldVersion: "0.11.2",
      newVersion: "0.11.3",
      requiresRestart: true,
      message: "updated",
    };
    const first = makeNativePort(true, null, { canSelfUpdate: true, updateRequestResult: updated });
    // The swap did not happen (e.g. another profile's helper held the file):
    // the reconnect finds the same old version, which would answer success again.
    const second = makeNativePort(true, null, { canSelfUpdate: true, updateRequestResult: updated });
    installBrowser(first, second);
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    expect(await initNativeFts()).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(nativeFtsSearch.getHostStatus().status).not.toBe("missing");

    await vi.advanceTimersByTimeAsync(1_000);
    for (let turn = 0; turn < 30 && nativeFtsSearch.getHostStatus().status !== "available"; turn++) {
      await Promise.resolve();
    }
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(methods(second)).toEqual(["hello", "updateCheck", "init"]);
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");

    await vi.advanceTimersByTimeAsync(10_000);
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(second.disconnect).not.toHaveBeenCalled();

    // The update's reconnect was used up: a later disconnect is ordinary.
    second.disconnect();
    expect(nativeFtsSearch.getHostStatus().status).toBe("missing");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
  });

  it("does not repeat a failed update after the background is unloaded and woken in the same session", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", manifestFetch());
    const first = makeNativePort(true, null, { canSelfUpdate: true, deferUpdateRequest: true });
    const second = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(first, second);
    const sessionBrowser = globalThis.browser;
    const before = await import("../fts/nativeEngine.js");
    const outcome = before.initNativeFts().then(() => ({ ok: true }), error => ({ ok: false, error }));
    for (let turn = 0; turn < 30 && !methods(first).includes("updateRequest"); turn++) {
      await Promise.resolve();
    }
    first.disconnect();
    expect((await outcome).ok).toBe(false);

    // The idle event page is unloaded; a later event starts it again in the
    // same Thunderbird session, so the module and its variables are new.
    vi.resetModules();
    globalThis.browser = sessionBrowser;
    const after = await import("../fts/nativeEngine.js");
    expect(after.nativeFtsSearch).not.toBe(before.nativeFtsSearch);
    await after.initNativeFts();

    expect(methods(second)).toEqual(["hello", "updateCheck", "init"]);
    expect(after.nativeFtsSearch.getHostStatus().status).toBe("available");
    await after.nativeFtsSearch.indexBatch([freshRow]);
    expect(methods(second)).toEqual(["hello", "updateCheck", "init", "indexBatch"]);
  });

  it("tries the update again in a new Thunderbird session", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", manifestFetch());
    const first = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(first);
    await (await import("../fts/nativeEngine.js")).initNativeFts();
    expect(methods(first)).toEqual(["hello", "updateCheck", "updateRequest", "init"]);

    // A new session starts with an empty storage.session.
    vi.resetModules();
    const next = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(next);
    await (await import("../fts/nativeEngine.js")).initNativeFts();
    expect(methods(next)).toEqual(["hello", "updateCheck", "updateRequest", "init"]);
  });

  it("requests each newly published target once, also when an earlier one is published again", async () => {
    vi.resetModules();
    const published = { version: "0.11.3" };
    vi.stubGlobal("fetch", manifestFetch(published));
    const ports = [0, 1, 2].map(() => makeNativePort(true, null, { canSelfUpdate: true }));
    installBrowser(...ports);
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await initNativeFts();
    ports[0].disconnect();
    published.version = "0.11.4";
    expect(await nativeFtsSearch.recheckAvailability()).toBe(true);
    ports[1].disconnect();
    // Still an upgrade for the 0.11.2 helper, and already tried this session.
    published.version = "0.11.3";
    expect(await nativeFtsSearch.recheckAvailability()).toBe(true);
    await nativeFtsSearch.indexBatch([freshRow]);

    const requested = port => port.messages
      .filter(message => message.method === "updateRequest")
      .map(message => message.params.targetVersion);
    expect(requested(ports[0])).toEqual(["0.11.3"]);
    expect(requested(ports[1])).toEqual(["0.11.4"]);
    expect(requested(ports[2])).toEqual([]);
    expect(methods(ports[2])).toEqual(["hello", "updateCheck", "init", "indexBatch"]);
  });

  it("does not repeat automatically a target first requested by a manual check", async () => {
    vi.resetModules();
    const published = { version: "0.11.2" };
    vi.stubGlobal("fetch", manifestFetch(published));
    const first = makeNativePort(true, null, { canSelfUpdate: true });
    const second = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(first, second);
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await initNativeFts();
    expect(methods(first)).toEqual(["hello", "updateCheck", "init"]);
    published.version = "0.11.3";
    expect(await nativeFtsSearch.manualCheckAndUpdateHost())
      .toEqual({ ok: false, error: "test_update_not_applied" });
    expect(methods(first)).toEqual(["hello", "updateCheck", "init", "updateCheck", "updateRequest"]);

    first.disconnect();
    expect(await nativeFtsSearch.recheckAvailability()).toBe(true);
    await nativeFtsSearch.indexBatch([freshRow]);
    expect(methods(second)).toEqual(["hello", "updateCheck", "init", "indexBatch"]);
  });

  it("reconnects at once after a successful manual update and serves from the new helper", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    const published = { version: "0.11.2" };
    vi.stubGlobal("fetch", manifestFetch(published));
    const first = makeNativePort(true, null, {
      canSelfUpdate: true,
      updateRequestResult: {
        success: true,
        oldVersion: "0.11.2",
        newVersion: "0.11.3",
        requiresRestart: true,
        message: "updated",
      },
    });
    const second = makeNativePort(true, null, { canSelfUpdate: true, hostVersion: "0.11.3" });
    installBrowser(first, second);
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await initNativeFts();
    published.version = "0.11.3";
    expect(await nativeFtsSearch.manualCheckAndUpdateHost()).toMatchObject({ ok: true, updated: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(first.disconnect).toHaveBeenCalledOnce();
    expect(nativeFtsSearch.getHostStatus().status).not.toBe("missing");

    await vi.advanceTimersByTimeAsync(1_000);
    for (let turn = 0; turn < 30 && nativeFtsSearch.getHostStatus().status !== "available"; turn++) {
      await Promise.resolve();
    }
    expect(browser.runtime.connectNative).toHaveBeenCalledTimes(2);
    expect(nativeFtsSearch.getHostStatus()).toEqual({ status: "available", hostVersion: "0.11.3" });
    await nativeFtsSearch.indexBatch([freshRow]);
    expect(methods(second)).toEqual(["hello", "updateCheck", "init", "indexBatch"]);
  });

  it("does not let a generation replaced while it reads the attempts record suppress its replacement's update", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", manifestFetch());
    const stale = makeNativePort(true, null, { canSelfUpdate: true });
    const current = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(stale, current);
    const session = browser.storage.session;
    const realGet = session.get.getMockImplementation();
    let releaseGet;
    session.get.mockImplementationOnce(key => new Promise(resolve => {
      releaseGet = () => resolve(realGet(key));
    }));
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    const staleOutcome = initNativeFts().then(() => ({ ok: true }), error => ({ ok: false, error }));
    for (let turn = 0; turn < 30 && !releaseGet; turn++) await Promise.resolve();
    expect(methods(stale)).toEqual(["hello", "updateCheck"]);
    stale.disconnect();
    releaseGet();
    expect((await staleOutcome).ok).toBe(false);
    expect(session.data.size).toBe(0);

    await initNativeFts();
    expect(methods(stale)).toEqual(["hello", "updateCheck"]);
    expect(methods(current)).toEqual(["hello", "updateCheck", "updateRequest", "init"]);
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");
  });

  it("sends the update only after its attempt is recorded", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", manifestFetch());
    const port = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(port);
    const session = browser.storage.session;
    const realSet = session.set.getMockImplementation();
    let releaseSet;
    session.set.mockImplementationOnce(items => new Promise(resolve => {
      releaseSet = () => resolve(realSet(items));
    }));
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    const init = initNativeFts();
    for (let turn = 0; turn < 30 && !releaseSet; turn++) await Promise.resolve();
    for (let turn = 0; turn < 30; turn++) await Promise.resolve();
    expect(methods(port)).toEqual(["hello", "updateCheck"]);
    releaseSet();
    await init;

    expect(session.data.get("ftsNativeUpdateRequestedVersions")).toEqual(["0.11.3"]);
    expect(methods(port)).toEqual(["hello", "updateCheck", "updateRequest", "init"]);
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");
  });

  it("does not send the update when its attempt cannot be recorded, and search still starts", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", manifestFetch());
    const port = makeNativePort(true, null, { canSelfUpdate: true });
    installBrowser(port);
    browser.storage.session.set.mockImplementationOnce(async () => {
      throw new Error("session storage unavailable");
    });
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await initNativeFts();
    await nativeFtsSearch.indexBatch([freshRow]);

    expect(methods(port)).toEqual(["hello", "updateCheck", "init", "indexBatch"]);
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");
  });
});

