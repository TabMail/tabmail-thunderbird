/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it, vi } from "vitest";

vi.mock("../agent/modules/config.js", () => ({
  SETTINGS: { fts: { batchSize: 100, maxBatchBytes: 1_000_000 } },
}));
vi.mock("../agent/modules/utils.js", () => ({
  extractPlainText: vi.fn(),
  getRealSubject: vi.fn(async message => message.subject || ""),
  getUniqueMessageKey: vi.fn(async message => {
    const headerID = String(message.headerMessageId || "").replace(/[<>]/g, "");
    return `${message.folder.accountId}:${message.folder.path}:${headerID}`;
  }),
  log: vi.fn(),
  safeGetFull: vi.fn(),
}));
vi.mock("../agent/modules/eventLogger.js", () => ({ pushCorrectionDetail: vi.fn() }));
vi.mock("../fts/engine.js", () => ({ ftsSearch: {} }));

const { buildBatchHeader } = await import("../fts/indexer.js");

describe("FTS header row folder identity", () => {
  it("carries a durable app identity independent of the session MailFolder.id", async () => {
    const message = {
      id: 1,
      headerMessageId: "<message@example.com>",
      subject: "Subject",
      recipients: [],
      ccList: [],
      folder: {
        id: "session-folder-old",
        accountId: "account",
        path: "/Client:Acme",
      },
    };
    const first = await buildBatchHeader([message]);
    message.folder.id = "session-folder-new";
    const second = await buildBatchHeader([message]);

    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      msgId: "account:/Client:Acme:message@example.com",
      folderId: 'tm-folder:v1:["account","/Client:Acme"]',
    });
    expect(second[0].folderId).toBe(first[0].folderId);
  });
});
