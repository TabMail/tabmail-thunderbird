/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/actionCache.js", () => ({ setAction: vi.fn() }));
vi.mock("../agent/modules/config.js", () => ({ SETTINGS: {} }));
vi.mock("../agent/modules/folderUtils.js", () => ({
  getAllFoldersForAccount: vi.fn(),
  isInboxFolder: folder => folder?.type === "inbox",
}));
vi.mock("../agent/modules/utils.js", () => ({
  getUniqueMessageKey: vi.fn(),
  indexHeader: vi.fn(),
}));
vi.mock("../agent/modules/tagDefs.js", () => ({
  ACTION_TAG_IDS: {},
  ensureActionTags: vi.fn(),
  triggerSortRefresh: vi.fn(),
  isDebugTagRaceEnabled: vi.fn(),
  actionFromLiveTagIds: vi.fn(),
}));
vi.mock("../agent/modules/threadTagGroup.js", () => ({
  getTagByThreadEnabled: vi.fn(),
  computeAndStoreThreadTagList: vi.fn(),
  updateThreadEffectiveTagsIfNeeded: vi.fn(),
  attachTagByThreadListener: vi.fn(),
  cleanupTagByThreadListener: vi.fn(),
  attachThreadTagWatchers: vi.fn(),
  cleanupThreadTagWatchers: vi.fn(),
  retagAllInboxesForTagByThreadToggle: vi.fn(),
  recomputeThreadForInboxMessage: vi.fn(),
}));

const query = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  globalThis.browser = {
    accounts: {
      list: vi.fn(async () => [{
        id: "acct",
        rootFolder: { id: "root", accountId: "acct", path: "/" },
      }]),
    },
    folders: {
      getSubFolders: vi.fn(async () => [{
        id: "inbox-colon",
        accountId: "acct",
        path: "/In:box",
        type: "inbox",
      }]),
    },
    messages: {
      query: (...args) => query(...args),
      continueList: vi.fn(),
    },
  };
});

describe("tag helper structured inbox identity", () => {
  it("preserves a colon folder and IPv6-literal Message-ID tail", async () => {
    query.mockResolvedValue({ messages: [{ id: 1 }] });
    const { isMessageInInboxByUniqueKey } = await import("../agent/modules/tagHelper.js");

    await expect(isMessageInInboxByUniqueKey(
      "acct:/In:box:[IPv6:2001:db8::1]",
    )).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith({
      folderId: ["inbox-colon"],
      headerMessageId: "[IPv6:2001:db8::1]",
    });
  });
});
