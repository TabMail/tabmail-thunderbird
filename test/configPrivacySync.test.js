/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handlePrivacyChange, loadPrivacySettings } from "../config/modules/privacy.js";

const nodes = new Map();
beforeEach(() => {
  nodes.clear();
  for (const id of ["status", "privacy-device-sync", "privacy-opt-out-all-ai", "privacy-device-sync-warning", "privacy-opt-out-warning"])
    nodes.set(id, { checked: false, textContent: "", style: {} });
  globalThis.document = { getElementById: id => nodes.get(id) };
  globalThis.browser = {
    storage: { local: { get: vi.fn(async defaults => defaults) } },
    runtime: { sendMessage: vi.fn(async () => ({ ok: true })) },
  };
});
describe("Settings Device Sync ownership", () => {
  it.each([true, false])("routes toggle %s to the background owner", async enabled => {
    await handlePrivacyChange({ target: { id: "privacy-device-sync", checked: enabled } });
    expect(browser.runtime.sendMessage).toHaveBeenCalledExactlyOnceWith({ command: enabled ? "device-sync-enable" : "device-sync-disable" });
    expect(nodes.get("status").textContent).toBe(enabled ? "Device sync enabled." : "Device sync disabled: AI results will not sync between devices.");
  });
  it("does not report success after a background refusal", async () => {
    browser.runtime.sendMessage.mockResolvedValue({ ok: false, error: "synthetic failure" });
    await expect(handlePrivacyChange({ target: { id: "privacy-device-sync", checked: true } })).rejects.toThrow("synthetic failure");
    expect(nodes.get("status").textContent).toBe("");
  });
  it("defaults sync to enabled when no preference has been stored", async () => {
    await loadPrivacySettings(async () => false, vi.fn());
    expect(browser.storage.local.get).toHaveBeenCalledWith({ device_sync_auto_enabled: true });
    expect(nodes.get("privacy-device-sync").checked).toBe(true);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });
  it("reads the preference without starting a connection", async () => {
    browser.storage.local.get.mockResolvedValue({ device_sync_auto_enabled: false });
    await loadPrivacySettings(async () => false, vi.fn());
    expect(browser.storage.local.get).toHaveBeenCalledWith({ device_sync_auto_enabled: true });
    expect(nodes.get("privacy-device-sync").checked).toBe(false);
    expect(browser.runtime.sendMessage).not.toHaveBeenCalled();
  });
});
