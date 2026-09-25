/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/config.js", () => ({ SETTINGS: { notifications: {} } }));
vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn() }));
vi.mock("../agent/modules/reminderStateStore.js", () => ({ hashReminder: vi.fn() }));
vi.mock("../chat/modules/chatWindowUtils.js", () => ({
  isChatWindowOpen: vi.fn(async () => false),
  openOrFocusChatWindow: vi.fn(async () => {}),
}));

let listeners;
let get;
let addListener;

beforeEach(() => {
  vi.resetModules();
  listeners = new Set();
  get = vi.fn(async (key) => {
    if (key && typeof key === "object" && !Array.isArray(key)) return key;
    return {};
  });
  addListener = vi.fn((listener) => listeners.add(listener));
  globalThis.browser = {
    storage: { local: { get, set: vi.fn(async () => {}), remove: vi.fn(async () => {}) } },
    alarms: {
      onAlarm: { addListener, removeListener: vi.fn((listener) => listeners.delete(listener)) },
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    },
  };
});

describe("proactive alarm wake registration", () => {
  it("handles a first alarm only after asynchronous state restoration and keeps one owner", async () => {
    let releaseEnabled;
    const enabled = new Promise((resolve) => { releaseEnabled = resolve; });
    get.mockImplementation(async (key) => {
      if (key && typeof key === "object" && "notifications.proactive_enabled" in key) return enabled;
      if (key && typeof key === "object" && "task.enabled" in key) return { "task.enabled": false };
      return {};
    });
    const { primeProactiveAlarmListener, initProactiveCheckin, cleanupProactiveCheckin } =
      await import("../agent/modules/proactiveCheckin.js");

    primeProactiveAlarmListener();
    primeProactiveAlarmListener();
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);

    const alarmListener = [...listeners][0];
    const alarmDone = alarmListener({ name: "tabmail-task-eval" });
    const concurrentInit = initProactiveCheckin();
    expect(get.mock.calls.some(([key]) => key && typeof key === "object" && "task.enabled" in key)).toBe(false);

    releaseEnabled({ "notifications.proactive_enabled": false });
    await concurrentInit;
    await alarmDone;
    expect(get.mock.calls.filter(([key]) => key && typeof key === "object" && "task.enabled" in key)).toHaveLength(1);
    expect(listeners.size).toBe(1);
    cleanupProactiveCheckin();
    expect(listeners.size).toBe(0);
  });

  it("retries an early add failure without retaining a phantom listener", async () => {
    addListener.mockImplementationOnce(() => { throw new Error("injected add failure"); });
    const { primeProactiveAlarmListener, initProactiveCheckin, cleanupProactiveCheckin } =
      await import("../agent/modules/proactiveCheckin.js");

    expect(() => primeProactiveAlarmListener()).toThrow("injected add failure");
    expect(listeners.size).toBe(0);
    await initProactiveCheckin();
    expect(addListener).toHaveBeenCalledTimes(2);
    expect(listeners.size).toBe(1);
    await initProactiveCheckin();
    expect(addListener).toHaveBeenCalledTimes(2);
    cleanupProactiveCheckin();
  });

  it("retains listener ownership when removal fails, so a retry cannot stack", async () => {
    const { primeProactiveAlarmListener, initProactiveCheckin, cleanupProactiveCheckin } =
      await import("../agent/modules/proactiveCheckin.js");
    primeProactiveAlarmListener();
    browser.alarms.onAlarm.removeListener.mockImplementationOnce(() => {
      throw new Error("injected remove failure");
    });
    cleanupProactiveCheckin();
    expect(listeners.size).toBe(1);
    await initProactiveCheckin();
    expect(addListener).toHaveBeenCalledTimes(1);
    expect(listeners.size).toBe(1);
    cleanupProactiveCheckin();
    expect(listeners.size).toBe(0);
  });
});
