/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
  },
}));
vi.mock("../agent/modules/thinkBuffer.js", () => ({ getAndClearThink: vi.fn(() => null) }));
vi.mock("../agent/modules/quoteAndSignature.js", () => ({}));

const folders = [
  { id: "folder-parent", accountId: "account", path: "/Client" },
  { id: "folder-child", accountId: "account", path: "/Client:Acme" },
];

globalThis.browser = {
  folders: { query: vi.fn() },
  messages: { query: vi.fn(), get: vi.fn() },
};

const { resolveUniqueMessageKey } = await import("../agent/modules/utils.js");

beforeEach(() => {
  vi.clearAllMocks();
  browser.folders.query.mockImplementation(async ({ accountId, path }) => {
    if (path) return folders.filter(folder => folder.accountId === accountId && folder.path === path);
    return folders.filter(folder => folder.accountId === accountId);
  });
});

describe("live unique-message-key resolution", () => {
  it("resolves a colon-bearing folder from live folder evidence", async () => {
    browser.messages.query.mockImplementation(async ({ folderId, headerMessageId }) => ({
      messages: folderId === "folder-child" && headerMessageId === "message@example.com"
        ? [{ id: 41, headerMessageId, folder: folders[1] }]
        : [],
    }));

    await expect(resolveUniqueMessageKey(
      "account:/Client:Acme:message@example.com",
    )).resolves.toEqual({
      weFolder: folders[1],
      headerID: "message@example.com",
      weID: 41,
    });
  });

  it("preserves a standards-valid IPv6-literal Message-ID tail", async () => {
    const headerID = "sender@[IPv6:2001:db8::1]";
    browser.messages.query.mockImplementation(async ({ folderId, headerMessageId }) => ({
      messages: folderId === "folder-parent" && headerMessageId === headerID
        ? [{ id: 52, headerMessageId, folder: folders[0] }]
        : [],
    }));

    await expect(resolveUniqueMessageKey(`account:/Client:${headerID}`)).resolves.toEqual({
      weFolder: folders[0],
      headerID,
      weID: 52,
    });
  });

  it("fails closed when two live folder interpretations resolve", async () => {
    browser.messages.query.mockImplementation(async ({ folderId, headerMessageId }) => ({
      messages: folderId === "folder-parent" && headerMessageId === "Acme:message@example.com"
        ? [{ id: 61, headerMessageId, folder: folders[0] }]
        : folderId === "folder-child" && headerMessageId === "message@example.com"
          ? [{ id: 62, headerMessageId, folder: folders[1] }]
          : [],
    }));

    await expect(resolveUniqueMessageKey(
      "account:/Client:Acme:message@example.com",
    )).resolves.toBeNull();
  });

  it("treats duplicate headers in one folder as one structured interpretation", async () => {
    browser.messages.query.mockImplementation(async ({ folderId, headerMessageId }) => ({
      messages: folderId === "folder-child" && headerMessageId === "message@example.com"
        ? [{ id: 71 }, { id: 72 }]
        : [],
    }));

    await expect(resolveUniqueMessageKey(
      "account:/Client:Acme:message@example.com",
    )).resolves.toEqual({
      weFolder: folders[1],
      headerID: "message@example.com",
      weID: 71,
    });
  });

  it.each([
    ["/Caf\u00e9", "nfc@example.com", 81],
    ["/Cafe\u0301", "nfd@example.com", 82],
    ["/\ud83d\udce8", "sender@[IPv6:2001:db8::1]", 83],
  ])("resolves byte-exact Unicode folder %s without normalizing the Message-ID", async (
    path,
    headerID,
    weID,
  ) => {
    const folder = { id: `folder-${weID}`, accountId: "account", path };
    browser.folders.query.mockResolvedValue([folder]);
    browser.messages.query.mockImplementation(async ({ folderId, headerMessageId }) => ({
      messages: folderId === folder.id && headerMessageId === headerID
        ? [{ id: weID, headerMessageId, folder }]
        : [],
    }));

    await expect(resolveUniqueMessageKey(`account:${path}:${headerID}`)).resolves.toEqual({
      weFolder: folder,
      headerID,
      weID,
    });
  });
});
