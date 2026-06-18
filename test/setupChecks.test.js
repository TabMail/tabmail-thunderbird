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
  checkPlaintextComposition,
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

describe("checkPlaintextComposition", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("reports configured when every identity composes plaintext (compose_html=false)", async () => {
    setupBrowser({
      accounts: [{ identities: [{ id: "id1", email: "a@example.com" }] }],
      prefs: { "mail.identity.id1.compose_html": false },
    });
    const res = await checkPlaintextComposition();
    expect(res.configured).toBe(true);
    expect(res.problematicIdentities).toEqual([]);
  });

  it("flags identities that compose HTML (compose_html=true)", async () => {
    setupBrowser({
      accounts: [{ identities: [{ id: "id1", name: "Work", email: "a@example.com" }] }],
      prefs: { "mail.identity.id1.compose_html": true },
    });
    const res = await checkPlaintextComposition();
    expect(res.configured).toBe(false);
    expect(res.problematicIdentities).toEqual(["Work"]);
  });

  it("defaults to HTML (problematic) when the pref is absent", async () => {
    setupBrowser({
      accounts: [{ identities: [{ id: "id1", email: "a@example.com" }] }],
      prefs: {}, // getBoolSafe returns the fallback (true = HTML) when absent
    });
    const res = await checkPlaintextComposition();
    expect(res.configured).toBe(false);
    expect(res.problematicIdentities).toEqual(["a@example.com"]);
  });

  it("returns not-configured with reason when tmPrefs API is unavailable", async () => {
    setupBrowser({ tmPrefs: false });
    const res = await checkPlaintextComposition();
    expect(res.configured).toBe(false);
    expect(res.reason).toMatch(/tmPrefs/);
  });

  it("ignores accounts with no identities", async () => {
    setupBrowser({
      accounts: [{ identities: [] }, { identities: [{ id: "id2", email: "b@example.com" }] }],
      prefs: { "mail.identity.id2.compose_html": false },
    });
    const res = await checkPlaintextComposition();
    expect(res.configured).toBe(true);
  });
});

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

  it("allConfigured=true only when all three checks pass", async () => {
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
      prefs: { "mail.identity.id1.compose_html": true }, // HTML → problematic
      storage: {}, // no calendar, no address book
    });
    const res = await checkSetupConfiguration();
    expect(res.allConfigured).toBe(false);
    expect(res.issues).toHaveLength(3);
    expect(res.issues.some((i) => i.includes("Plaintext"))).toBe(true);
    expect(res.issues).toContain("Default calendar not set");
    expect(res.issues).toContain("Default address book not set");
  });

  it("names the problematic identities in the plaintext issue", async () => {
    setupBrowser({
      accounts: [{ identities: [{ id: "id1", name: "Work", email: "a@example.com" }] }],
      prefs: { "mail.identity.id1.compose_html": true },
      storage: { defaultCalendarId: "cal-1", defaultAddressBookId: "ab-1" },
    });
    const res = await checkSetupConfiguration();
    expect(res.allConfigured).toBe(false);
    expect(res.issues).toEqual(["Plaintext composition not set for: Work"]);
  });
});
