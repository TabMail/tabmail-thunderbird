/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn() }));
vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 1_000 } },
}));

function makeNativePort(hostVersion, { canSelfUpdate = true, helloError = null } = {}) {
  const messageListeners = [];
  const disconnectListeners = [];
  const methods = [];
  const respond = (message, result, error) => Promise.resolve().then(() => {
    for (const listener of messageListeners) listener(error ? { id: message.id, error } : { id: message.id, result });
  });

  return {
    methods,
    disconnected: false,
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    postMessage(message) {
      methods.push(message.method);
      if (message.method === "hello" && helloError) respond(message, null, helloError);
      else if (message.method === "hello") {
        respond(message, {
          hostVersion,
          canSelfUpdate,
          isUserInstall: true,
          isSystemInstall: false,
          installPath: "/test/fts_helper",
        });
      }
      if (message.method === "init") respond(message, { dbPath: "/test/fts.sqlite" });
    },
    disconnect() {
      this.disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("../fts/nativeCompatibility.js");
  delete globalThis.browser;
});

// The Windows tests use the shipped cutoff, so a change to it fails them; this
// override exists only for the no-cutoff case.
async function withWindowsCutoff(version) {
  vi.resetModules();
  vi.doMock("../fts/nativeCompatibility.js", async importOriginal => ({
    ...(await importOriginal()),
    NATIVE_FTS_WINDOWS_MIN_SELF_UPDATING_VERSION: version,
  }));
}

function installBrowser(connectNative, getPlatformInfo) {
  globalThis.browser = {
    tmMsgNotify: { getFtsDataDir: async () => "/test/profile/browser-extension-data/thunderbird@tabmail.ai" },
    runtime: {
      connectNative,
      getManifest: vi.fn(() => ({ version: "1.7.2" })),
      getPlatformInfo,
    },
  };
}

describe("native FTS unsupported helper state propagation", () => {
  it("disconnects a pre-bridge helper and exposes reinstall metadata after cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T16:00:00.000Z"));
    vi.resetModules();

    const port = makeNativePort("0.10.1");
    installBrowser(vi.fn(() => port), vi.fn(async () => ({ os: "mac", arch: "aarch64" })));

    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await expect(initNativeFts()).rejects.toMatchObject({
      code: "NATIVE_FTS_UNSUPPORTED",
    });

    expect(port.disconnected).toBe(true);
    expect(port.methods).toEqual(["hello"]);
    expect(nativeFtsSearch.getHostAvailability()).toBe(false);
    expect(nativeFtsSearch.getHostStatus()).toEqual({
      status: "unsupported",
      hostVersion: "0.10.1",
      minimumSupportedVersion: "0.11.1",
      retirementAt: "2026-08-13T16:00:00.000Z",
    });
  });

  it("disconnects a Windows helper older than the shipped cutoff through the same path", async () => {
    vi.resetModules();
    const port = makeNativePort("0.12.2");
    installBrowser(vi.fn(() => port), vi.fn(async () => ({ os: "win", arch: "x86-64" })));
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await expect(initNativeFts()).rejects.toMatchObject({ code: "NATIVE_FTS_UNSUPPORTED" });

    expect(port.disconnected).toBe(true);
    expect(port.methods).toEqual(["hello"]);
    expect(nativeFtsSearch.getHostAvailability()).toBe(false);
    expect(nativeFtsSearch.getHostStatus()).toMatchObject({
      status: "unsupported",
      hostVersion: "0.12.2",
      minimumSupportedVersion: "0.12.3",
    });
  });

  it.each([
    ["win", "0.12.3"],
    ["mac", "0.12.2"],
    ["linux", "0.12.2"],
  ])("keeps a %s helper v%s in use under the Windows cutoff", async (os, hostVersion) => {
    vi.resetModules();
    const port = makeNativePort(hostVersion, { canSelfUpdate: false });
    installBrowser(vi.fn(() => port), vi.fn(async () => ({ os, arch: "x86-64" })));
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await initNativeFts();

    expect(port.disconnected).toBe(false);
    expect(port.methods).toEqual(["hello", "init"]);
    expect(nativeFtsSearch.getHostStatus()).toEqual({ status: "available", hostVersion });
  });

  // A helper is used only once it is known to be supported: where its version or
  // the platform cannot be read, its support is unknown and it is not used.
  it.each([
    ["rejects", () => Promise.reject(new Error("platform unavailable"))],
    ["throws", () => { throw new TypeError("getPlatformInfo is not a function"); }],
  ])("does not use a helper when the platform lookup %s under the Windows cutoff", async (_, lookup) => {
    vi.resetModules();
    const port = makeNativePort("0.12.2", { canSelfUpdate: false });
    installBrowser(vi.fn(() => port), vi.fn(lookup));
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await expect(initNativeFts()).rejects.toThrow();

    expect(port.methods).toEqual(["hello"]);
    expect(port.disconnected).toBe(true);
    expect(nativeFtsSearch.getHostAvailability()).toBe(false);
    expect(nativeFtsSearch.getHostStatus()).toEqual({ status: "missing" });
  });

  it("does not use a helper whose hello fails", async () => {
    vi.resetModules();
    const port = makeNativePort("0.12.3", { canSelfUpdate: false, helloError: "hello failed" });
    installBrowser(vi.fn(() => port), vi.fn(async () => ({ os: "win", arch: "x86-64" })));
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await expect(initNativeFts()).rejects.toThrow("hello failed");

    expect(port.methods).toEqual(["hello"]);
    expect(port.disconnected).toBe(true);
    expect(nativeFtsSearch.getHostAvailability()).toBe(false);
    expect(nativeFtsSearch.getHostStatus()).toEqual({ status: "missing" });
  });

  it("does not ask for the platform while no Windows cutoff is configured", async () => {
    await withWindowsCutoff(null);
    const port = makeNativePort("0.12.2", { canSelfUpdate: false });
    const getPlatformInfo = vi.fn(async () => ({ os: "win", arch: "x86-64" }));
    installBrowser(vi.fn(() => port), getPlatformInfo);
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    await initNativeFts();

    expect(getPlatformInfo).not.toHaveBeenCalled();
    expect(nativeFtsSearch.getHostStatus().status).toBe("available");
  });

  it("does not let a generation replaced during the platform lookup close its replacement", async () => {
    vi.resetModules();
    const stale = makeNativePort("0.12.2");
    const current = makeNativePort("0.12.3", { canSelfUpdate: false });
    let releaseStalePlatform;
    const getPlatformInfo = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => {
        releaseStalePlatform = () => resolve({ os: "win", arch: "x86-64" });
      }))
      .mockImplementation(async () => ({ os: "win", arch: "x86-64" }));
    installBrowser(vi.fn().mockReturnValueOnce(stale).mockReturnValueOnce(current), getPlatformInfo);
    const { initNativeFts, nativeFtsSearch } = await import("../fts/nativeEngine.js");

    const staleOutcome = initNativeFts().then(() => ({ ok: true }), error => ({ ok: false, error }));
    for (let turn = 0; turn < 20 && getPlatformInfo.mock.calls.length === 0; turn++) {
      await Promise.resolve();
    }
    expect(getPlatformInfo).toHaveBeenCalledOnce();
    stale.disconnect();
    await initNativeFts();
    releaseStalePlatform();
    const outcome = await staleOutcome;

    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).not.toBe("NATIVE_FTS_UNSUPPORTED");
    expect(stale.methods).toEqual(["hello"]);
    expect(current.methods).toEqual(["hello", "init"]);
    expect(current.disconnected).toBe(false);
    expect(nativeFtsSearch.getHostStatus()).toEqual({ status: "available", hostVersion: "0.12.3" });
  });
});
