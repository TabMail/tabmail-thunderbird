/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// setupChecks.test.js — shared setup-configuration checks (issue #12).
//
// These checks back BOTH the popup's in-popup warning and the background's
// proactive "setup" toolbar dot, so they must compute identically. All three
// inputs are local (TB prefs + storage.local) — no network.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn() }));

const {
  checkDefaultCalendar,
  checkDefaultAddressBook,
  checkSetupConfiguration,
} = await import("../agent/modules/setupChecks.js");

// Build a fresh browser mock per test.
function setupBrowser({ prefs = {}, accounts = [], storage = {}, tmPrefs = true } = {}) {
  globalThis.browser = {
    tmPrefs: tmPrefs
      ? {
          getBoolSafe: vi.fn(async (name, fallback) =>
            Object.prototype.hasOwnProperty.call(prefs, name) ? prefs[name] : fallback
          ),
        }
      : undefined,
    accounts: {
      list: vi.fn(async () => accounts),
    },
    storage: {
      local: {
        get: vi.fn(async (defaults) => {
          const out = { ...defaults };
          for (const k of Object.keys(defaults)) {
            if (Object.prototype.hasOwnProperty.call(storage, k)) out[k] = storage[k];
          }
          return out;
        }),
      },
    },
  };
}

describe("checkDefaultCalendar", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("configured when a non-empty defaultCalendarId is stored", async () => {
    setupBrowser({ storage: { defaultCalendarId: "cal-123" } });
    expect((await checkDefaultCalendar()).configured).toBe(true);
  });

  it("not configured when unset (null)", async () => {
    setupBrowser({ storage: {} });
    expect((await checkDefaultCalendar()).configured).toBe(false);
  });

  it("not configured when empty string", async () => {
    setupBrowser({ storage: { defaultCalendarId: "" } });
    expect((await checkDefaultCalendar()).configured).toBe(false);
  });
});

describe("checkDefaultAddressBook", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("configured when a non-empty defaultAddressBookId is stored", async () => {
    setupBrowser({ storage: { defaultAddressBookId: "ab-9" } });
    expect((await checkDefaultAddressBook()).configured).toBe(true);
  });

  it("not configured when unset", async () => {
    setupBrowser({ storage: {} });
    expect((await checkDefaultAddressBook()).configured).toBe(false);
  });
});

describe("checkSetupConfiguration (aggregate)", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("allConfigured=true only when both checks pass", async () => {
    setupBrowser({
      accounts: [{ identities: [{ id: "id1", email: "a@example.com" }] }],
      prefs: { "mail.identity.id1.compose_html": false },
      storage: { defaultCalendarId: "cal-1", defaultAddressBookId: "ab-1" },
    });
    const res = await checkSetupConfiguration();
    expect(res.allConfigured).toBe(true);
    expect(res.issues).toEqual([]);
  });

  it("collects one issue per failing check", async () => {
    setupBrowser({
      accounts: [{ identities: [{ id: "id1", name: "Work", email: "a@example.com" }] }],
      prefs: { "mail.identity.id1.compose_html": true },
      storage: {}, // no calendar, no address book
    });
    const res = await checkSetupConfiguration();
    expect(res.allConfigured).toBe(false);
    expect(res.issues).toHaveLength(2);
    expect(res.issues).toContain("Default calendar not set");
    expect(res.issues).toContain("Default address book not set");
  });

  it("supports HTML identities without changing their composition preference", async () => {
    setupBrowser({
      accounts: [{ identities: [{ id: "id1", name: "Work", email: "a@example.com" }] }],
      prefs: { "mail.identity.id1.compose_html": true },
      storage: { defaultCalendarId: "cal-1", defaultAddressBookId: "ab-1" },
    });
    const res = await checkSetupConfiguration();
    expect(res.allConfigured).toBe(true);
    expect(res.issues).toEqual([]);
    expect(browser.tmPrefs.getBoolSafe).not.toHaveBeenCalled();
  });
});
