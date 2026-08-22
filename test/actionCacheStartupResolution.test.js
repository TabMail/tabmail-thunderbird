/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  keys: [],
  values: {},
}));

vi.mock("../agent/modules/idbStorage.js", () => ({
  getAllKeys: vi.fn(async () => state.keys),
  get: vi.fn(async () => state.values),
  set: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("../agent/modules/utils.js", () => ({
  getUniqueMessageKey: vi.fn(),
  getUniqueMessageKeyCandidates: (key, folders) => folders.flatMap(folder => {
    const prefix = `${folder.accountId}:${folder.path}:`;
    return key.startsWith(prefix) && key.length > prefix.length
      ? [{ weFolder: folder, headerID: key.slice(prefix.length) }]
      : [];
  }),
}));

const setActionsBulk = vi.fn(async entries => entries.length);
const listMessages = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  state.keys = ["action:acct:/F:suffix/\ud83d\udce8Cafe\u0301:[IPv6:2001:db8::1]"];
  state.values = {
    "action:acct:/F:suffix/\ud83d\udce8Cafe\u0301:[IPv6:2001:db8::1]": "archive",
  };
  globalThis.browser = {
    accounts: {
      list: vi.fn(async () => [{
        id: "acct",
        rootFolder: { id: "root", accountId: "acct", path: "/" },
      }]),
    },
    folders: { getSubFolders: vi.fn() },
    messages: {
      list: (...args) => listMessages(...args),
      continueList: vi.fn(),
    },
    tmHdr: { setActionsBulk },
  };
});

describe("action-cache startup structured key resolution", () => {
  it("preserves a colon folder and IPv6-literal Message-ID", async () => {
    browser.folders.getSubFolders.mockResolvedValue([
      { id: "folder-colon", accountId: "acct", path: "/F:suffix/\ud83d\udce8Cafe\u0301" },
    ]);
    listMessages.mockResolvedValue({
      messages: [{ id: 20, headerMessageId: "[IPv6:2001:db8::1]" }],
    });
    const { pushAllActionsToExperimentsOnStartup } = await import(
      "../agent/modules/actionCache.js"
    );

    await pushAllActionsToExperimentsOnStartup();

    expect(listMessages).toHaveBeenCalledWith("folder-colon");
    expect(setActionsBulk).toHaveBeenCalledWith([{ weMsgId: 20, action: "archive" }]);
  });

  it("accepts the one actual live interpretation among two structural candidates", async () => {
    browser.folders.getSubFolders.mockResolvedValue([
      { id: "folder-short", accountId: "acct", path: "/F" },
      { id: "folder-long", accountId: "acct", path: "/F:suffix/\ud83d\udce8Cafe\u0301" },
    ]);
    listMessages.mockImplementation(async folderId => ({
      messages: folderId === "folder-short"
        ? [{ id: 10, headerMessageId: "unrelated@example.com" }]
        : [{ id: 20, headerMessageId: "[IPv6:2001:db8::1]" }],
    }));
    const { pushAllActionsToExperimentsOnStartup } = await import(
      "../agent/modules/actionCache.js"
    );

    await pushAllActionsToExperimentsOnStartup();

    expect(setActionsBulk).toHaveBeenCalledWith([{ weMsgId: 20, action: "archive" }]);
  });

  it("applies one folder interpretation to every distinct same-folder message row", async () => {
    browser.folders.getSubFolders.mockResolvedValue([
      { id: "folder-long", accountId: "acct", path: "/F:suffix/\ud83d\udce8Cafe\u0301" },
    ]);
    listMessages.mockResolvedValue({
      messages: [
        { id: 20, headerMessageId: "[IPv6:2001:db8::1]" },
        { id: 21, headerMessageId: "[IPv6:2001:db8::1]" },
      ],
    });
    const { pushAllActionsToExperimentsOnStartup } = await import(
      "../agent/modules/actionCache.js"
    );

    await pushAllActionsToExperimentsOnStartup();

    expect(setActionsBulk).toHaveBeenCalledWith([
      { weMsgId: 20, action: "archive" },
      { weMsgId: 21, action: "archive" },
    ]);
  });

  it("drains pagination and deduplicates repeated same-folder rows", async () => {
    browser.folders.getSubFolders.mockResolvedValue([
      { id: "folder-long", accountId: "acct", path: "/F:suffix/\ud83d\udce8Cafe\u0301" },
    ]);
    listMessages.mockResolvedValue({
      messages: [{ id: 20, headerMessageId: "[IPv6:2001:db8::1]" }],
      id: "next-page",
    });
    browser.messages.continueList.mockResolvedValue({
      messages: [
        { id: 20, headerMessageId: "[IPv6:2001:db8::1]" },
        { id: 21, headerMessageId: "[IPv6:2001:db8::1]" },
      ],
    });
    const { pushAllActionsToExperimentsOnStartup } = await import(
      "../agent/modules/actionCache.js"
    );

    await pushAllActionsToExperimentsOnStartup();

    expect(browser.messages.continueList).toHaveBeenCalledWith("next-page");
    expect(setActionsBulk).toHaveBeenCalledWith([
      { weMsgId: 20, action: "archive" },
      { weMsgId: 21, action: "archive" },
    ]);
  });

  it("fails closed when two structural candidates both have an actual live message", async () => {
    browser.folders.getSubFolders.mockResolvedValue([
      { id: "folder-short", accountId: "acct", path: "/F" },
      { id: "folder-long", accountId: "acct", path: "/F:suffix/\ud83d\udce8Cafe\u0301" },
    ]);
    listMessages.mockImplementation(async folderId => ({
      messages: folderId === "folder-short"
        ? [{ id: 10, headerMessageId: "suffix/\ud83d\udce8Cafe\u0301:[IPv6:2001:db8::1]" }]
        : [{ id: 20, headerMessageId: "[IPv6:2001:db8::1]" }],
    }));
    const { pushAllActionsToExperimentsOnStartup } = await import(
      "../agent/modules/actionCache.js"
    );

    await pushAllActionsToExperimentsOnStartup();

    expect(setActionsBulk).not.toHaveBeenCalled();
  });
});
