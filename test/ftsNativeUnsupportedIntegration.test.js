/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn() }));
vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: { memoryManagement: { nativeRpcTimeoutMs: 1_000 } },
}));

function makeNativePort(hostVersion) {
  const messageListeners = [];
  const disconnectListeners = [];
  const methods = [];

  return {
    methods,
    disconnected: false,
    onMessage: { addListener: (listener) => messageListeners.push(listener) },
    onDisconnect: { addListener: (listener) => disconnectListeners.push(listener) },
    postMessage(message) {
      methods.push(message.method);
      if (message.method === "hello") {
        Promise.resolve().then(() => {
          for (const listener of messageListeners) {
            listener({
              id: message.id,
              result: {
                hostVersion,
                canSelfUpdate: true,
                isUserInstall: true,
                isSystemInstall: false,
                installPath: "/test/fts_helper",
              },
            });
          }
        });
      }
    },
    disconnect() {
      this.disconnected = true;
      for (const listener of disconnectListeners) listener();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  delete globalThis.browser;
});

describe("native FTS unsupported helper state propagation", () => {
  it("disconnects a pre-bridge helper and exposes reinstall metadata after cutoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-13T16:00:00.000Z"));
    vi.resetModules();

    const port = makeNativePort("0.10.1");
    globalThis.browser = {
      runtime: {
        connectNative: vi.fn(() => port),
        getManifest: vi.fn(() => ({ version: "1.7.2" })),
      },
    };

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
});
