/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { runComposeEdit } = vi.hoisted(() => ({ runComposeEdit: vi.fn() }));

vi.mock("../agent/modules/idbStorage.js", () => ({ get: vi.fn() }));
vi.mock("../agent/modules/utils.js", () => ({ getUniqueMessageKey: vi.fn() }));
vi.mock("../compose/modules/autocompleteGenerator.js", () => ({
  generateCorrection: vi.fn(),
}));
vi.mock("../compose/modules/edit.js", () => ({ runComposeEdit }));

vi.useFakeTimers();

const getComposeDetails = vi.fn();
const setComposeDetails = vi.fn(async () => {});
const parseMailboxString = vi.fn(async (value) => {
  const match = String(value).match(/<([^<>]+)>/) || [null, String(value)];
  return [{ email: match[1] }];
});
const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
const extensionApi = {
  compose: {
    getComposeDetails,
    setComposeDetails,
    onBeforeSend: event(),
  },
  messengerUtilities: { parseMailboxString },
  runtime: {
    getURL: vi.fn((path) => path),
    onMessage: event(),
    onSuspend: event(),
  },
  scripting: {
    compose: {
      unregisterScripts: vi.fn(async () => {}),
      registerScripts: vi.fn(async () => {}),
    },
  },
  tabs: { sendMessage: vi.fn(async () => {}) },
};

globalThis.browser = extensionApi;
globalThis.messenger = extensionApi;
globalThis.window = {};

const { handleRuntimeMessage } = await import("../compose/background.js");

afterAll(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  vi.clearAllMocks();
  runComposeEdit.mockReset();
  getComposeDetails.mockReset();
  setComposeDetails.mockReset().mockResolvedValue(undefined);
});

describe("inline compose recipient application", () => {
  it("uses recipients refreshed after the AI wait", async () => {
    let finishEdit;
    runComposeEdit.mockImplementation(
      () => new Promise((resolve) => { finishEdit = resolve; })
    );
    getComposeDetails
      .mockResolvedValueOnce({
        to: ["first@example.com"],
        cc: ["Primary <primary@example.com>", "existing@example.com"],
        bcc: [],
        subject: "Subject",
        type: "new",
      })
      .mockResolvedValueOnce({
        to: ["first@example.com"],
        cc: [
          "Primary <primary@example.com>",
          "existing@example.com",
          "user-added@example.com",
        ],
        bcc: [],
      });

    const pending = handleRuntimeMessage(
      { type: "runInlineComposeEdit", body: "Body", request: "Add Primary" },
      { tab: { id: 42 } }
    );
    await vi.waitFor(() => expect(runComposeEdit).toHaveBeenCalledOnce());

    finishEdit({
      toDelta: {
        adds: [{ name: "Primary", email: "PRIMARY@example.com" }],
        removes: [],
      },
    });
    await pending;

    expect(getComposeDetails).toHaveBeenCalledTimes(2);
    expect(setComposeDetails).toHaveBeenCalledWith(42, {
      to: ["first@example.com", "Primary <PRIMARY@example.com>"],
      cc: ["existing@example.com", "user-added@example.com"],
    });
  });

  it("does not write recipient fields for a body-only AI result", async () => {
    const current = {
      to: ["person@example.com"],
      cc: ["other@example.com"],
      bcc: ["private@example.com"],
      subject: "Subject",
      type: "new",
    };
    getComposeDetails.mockResolvedValue(current);
    runComposeEdit.mockResolvedValue({
      body: "Updated body",
      subject: "Subject",
    });

    const result = await handleRuntimeMessage(
      { type: "runInlineComposeEdit", body: "Body", request: "Improve this" },
      { tab: { id: 42 } }
    );

    expect(result).toEqual({ body: "Updated body", subject: "Subject" });
    expect(getComposeDetails).toHaveBeenCalledTimes(2);
    expect(setComposeDetails).not.toHaveBeenCalled();
  });
});
