/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn() }));
vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 1_000 } },
}));

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
            capabilities: { folderMembershipV1 },
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

async function initialized(folderMembershipV1, assignmentResult = null) {
  vi.resetModules();
  const port = makeNativePort(folderMembershipV1, assignmentResult);
  globalThis.browser = {
    runtime: {
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

afterEach(() => {
  delete globalThis.browser;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("native folder-membership v1 contract", () => {
  it("injects opaque folderId on fresh writes only when hello advertises the capability", async () => {
    const supported = await initialized(true);
    await supported.nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:Acme:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    }]);
    expect(supported.nativeFtsSearch.supportsFolderMembership()).toBe(true);
    expect(supported.port.messages.find(message => message.method === "indexBatch")?.params.rows)
      .toEqual([expect.objectContaining({
        msgId: "account:/Client:Acme:message@example.com",
        folderId: "opaque-folder-17",
      })]);

    const unsupported = await initialized(false);
    await unsupported.nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:Acme:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    }]);
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

  it("uses the frozen exact-equality reader and metadata backfill RPC shapes", async () => {
    const { nativeFtsSearch, port } = await initialized(true);

    await nativeFtsSearch.listFolderMembership("opaque-folder-17", "after-key", 25);
    await nativeFtsSearch.listFolderMembershipState("after-key", 25);
    await nativeFtsSearch.assignFolderMembershipBatch([{
      msgId: "account:/Client:Acme:message@example.com",
      folderId: "opaque-folder-17",
    }]);

    expect(port.messages.some(message => message.method === "fingerprintFolderMembership"))
      .toBe(false);
    expect(port.messages.find(message => message.method === "listFolderMembership"))
      .toMatchObject({ params: { folderId: "opaque-folder-17", afterMsgId: "after-key", limit: 25 } });
    expect(port.messages.find(message => message.method === "listFolderMembershipState"))
      .toMatchObject({ params: { afterMsgId: "after-key", limit: 25 } });
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
      runtime: {
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

    await nativeFtsSearch.indexBatch([{
      msgId: "account:/Client:message@example.com",
      folderId: "opaque-folder-17",
      body: "",
    }]);

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
        runtime: {
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
      for (let turn = 0; turn < 5
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

  it("coalesces concurrent initialization onto one native port generation", async () => {
    vi.resetModules();
    const first = makeDeferredHelloPort(true);
    const second = makeDeferredHelloPort(true);
    globalThis.browser = {
      runtime: {
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
      runtime: {
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
      runtime: {
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
    for (let turn = 0; turn < 5
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

  it("uses the native pre-init update gate before init and rejects repeated init", async () => {
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

    await expect(nativeFtsSearch.init()).rejects.toThrow("native_already_initialized");
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
      runtime: {
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
      runtime: {
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
    for (let turn = 0; turn < 5
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
