/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/config.js", () => ({ SETTINGS: { notifications: {} } }));
vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn() }));
vi.mock("../agent/modules/reminderStateStore.js", () => ({ hashReminder: vi.fn() }));
vi.mock("../agent/modules/reminderBuilder.js", () => ({ buildReminderList: vi.fn(async () => ({ reminders: [] })) }));
vi.mock("../chat/modules/helpers.js", () => ({ getUserName: vi.fn(async () => "Reader") }));
vi.mock("../chat/modules/chatWindowUtils.js", () => ({
  isChatWindowOpen: vi.fn(async () => false),
  openOrFocusChatWindow: vi.fn(async () => {}),
}));

let listeners;
let get;
let addListener;
let storageData;

beforeEach(() => {
  vi.resetModules();
  listeners = new Set();
  storageData = {};
  get = vi.fn(async (key) => {
    if (typeof key === "string") return key in storageData ? { [key]: storageData[key] } : {};
    if (Array.isArray(key)) return Object.fromEntries(key.filter(k => k in storageData).map(k => [k, storageData[k]]));
    return { ...key, ...Object.fromEntries(Object.keys(key).filter(k => k in storageData).map(k => [k, storageData[k]])) };
  });
  addListener = vi.fn((listener) => listeners.add(listener));
  globalThis.browser = {
    storage: { local: {
      get,
      set: vi.fn(async (values) => { Object.assign(storageData, values); }),
      remove: vi.fn(async (keys) => { for (const key of [].concat(keys)) delete storageData[key]; }),
    } },
    alarms: {
      onAlarm: { addListener, removeListener: vi.fn((listener) => listeners.delete(listener)) },
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => {}),
    },
  };
});

describe("proactive alarm wake registration", () => {
  const dueReminder = (minutes, hash) => {
    const due = new Date(Date.now() + minutes * 60_000);
    const pad = n => String(n).padStart(2, "0");
    return {
      source: "kb", hash, content: `Synthetic reminder ${hash}`,
      dueDate: `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}`,
      dueTime: `${pad(due.getHours())}:${pad(due.getMinutes())}`,
    };
  };

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

  it.each(["wake-first", "init-first"])("waits for the restored cooldown before due delivery (%s)", async order => {
    const recent = Date.now();
    storageData["notifications.proactive_enabled"] = true;
    storageData["notifications.last_reachout"] = { time: recent };
    const { buildReminderList } = await import("../agent/modules/reminderBuilder.js");
    buildReminderList.mockResolvedValue({ reminders: [dueReminder(10, "due")] });
    const originalGet = get.getMockImplementation();
    let releaseRestore;
    let enteredRestore;
    const heldRestore = new Promise(resolve => { releaseRestore = resolve; });
    const restoreEntered = new Promise(resolve => { enteredRestore = resolve; });
    get.mockImplementation(async key => {
      if (key === "notifications.last_reachout") {
        enteredRestore();
        await heldRestore;
      }
      return originalGet(key);
    });
    const { primeProactiveAlarmListener, initProactiveCheckin } =
      await import("../agent/modules/proactiveCheckin.js");
    primeProactiveAlarmListener();
    let init;
    let alarm;
    if (order === "init-first") init = initProactiveCheckin();
    else alarm = [...listeners][0]({ name: "tabmail-proactive-reachout" });
    await restoreEntered;
    if (order === "init-first") alarm = [...listeners][0]({ name: "tabmail-proactive-reachout" });
    else init = initProactiveCheckin();
    expect(storageData.proactiveCheckin_pendingMessage).toBeUndefined();

    releaseRestore();
    await Promise.all([init, alarm]);
    expect(storageData.proactiveCheckin_pendingMessage).toBeUndefined();
    expect(storageData["notifications.last_reachout"].time).toBe(recent);
    expect(get.mock.calls.filter(([key]) => key === "notifications.last_reachout")).toHaveLength(1);
    expect(browser.alarms.create).toHaveBeenCalledWith("tabmail-task-eval", { periodInMinutes: 5 });
  });

  it("delivers one due reminder, persists deduplication, and ignores a foreign alarm", async () => {
    storageData["notifications.proactive_enabled"] = true;
    storageData["notifications.last_reachout"] = { time: Date.now() - 120_000 };
    const { buildReminderList } = await import("../agent/modules/reminderBuilder.js");
    buildReminderList.mockResolvedValue({
      reminders: [dueReminder(10, "due"), dueReminder(90, "future")],
    });
    const { openOrFocusChatWindow } = await import("../chat/modules/chatWindowUtils.js");
    const { primeProactiveAlarmListener } = await import("../agent/modules/proactiveCheckin.js");
    primeProactiveAlarmListener();
    const alarmListener = [...listeners][0];
    await alarmListener({ name: "tabmail-proactive-reachout" });

    expect(storageData.proactiveCheckin_pendingMessage.message).toContain("Synthetic reminder due");
    expect(storageData["notifications.reached_out_ids"].due.trigger).toBe("due_approaching");
    expect(storageData["notifications.last_reachout"].time).toBeGreaterThan(Date.now() - 10_000);
    expect(openOrFocusChatWindow).toHaveBeenCalledTimes(1);
    expect(browser.alarms.create).toHaveBeenCalledWith("tabmail-task-eval", { periodInMinutes: 5 });
    expect(browser.alarms.create.mock.calls.some(([name, spec]) =>
      name === "tabmail-proactive-reachout" && spec.when > Date.now())).toBe(true);

    await alarmListener({ name: "tabmail-proactive-reachout" });
    expect(openOrFocusChatWindow).toHaveBeenCalledTimes(1);
    get.mockClear();
    browser.alarms.create.mockClear();
    await alarmListener({ name: "unrelated-alarm" });
    expect(get).not.toHaveBeenCalled();
    expect(browser.alarms.create).not.toHaveBeenCalled();
  });
});
