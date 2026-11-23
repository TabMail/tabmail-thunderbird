/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The "turn off all AI" setting applies to every request as it leaves, not just
// the first one of an operation. The setting is read again right before each
// send, after every wait before it: the token lookup, a rate-limit (429) wait,
// signing in again after a refused sign-in (401/403). If AI was turned off in
// the meantime, nothing more is sent and the operation ends with the setting's
// own refusal, which is never retried.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../agent/modules/config.js", async (importOriginal) => ({
  ...(await importOriginal()),
  getBackendUrl: async () => "https://backend.example.com",
}));
vi.mock("../agent/modules/utils.js", () => ({ log: vi.fn(), normalizeUnicode: (t) => t, saveChatLog: vi.fn() }));
vi.mock("../agent/modules/thinkBuffer.js", () => ({ setThink: vi.fn() }));
vi.mock("../config/modules/webSearch.js", () => ({ getWebSearchEnabled: async () => false }));
vi.mock("../agent/modules/byokStorage.js", () => ({ buildByokPayload: async () => null }));
// The "Taking a little longer" waiting message shown while rate limited.
const waitingMessage = vi.hoisted(() => ({ classList: { add() {} }, remove: () => {} }));
vi.mock("../chat/chat.js", () => ({ createNewAgentBubble: async () => waitingMessage }));
vi.mock("../chat/modules/helpers.js", () => ({ setBubbleText: vi.fn() }));
vi.mock("../agent/modules/supabaseAuth.js", () => ({
  getAccessToken: vi.fn(async () => "access-token"),
  isAuthError: (response) => response.status === 401 || response.status === 403,
  handleAuthError: vi.fn(async () => true),
}));
// The real AI-setting check, recording every check made and every refusal it
// threw, so a test sees which sends were checked and which error left.
const gate = vi.hoisted(() => ({ contexts: [], refusals: [] }));
vi.mock("../chat/modules/privacySettings.js", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    assertAiBackendAllowed: async (context) => {
      gate.contexts.push(context);
      try {
        return await real.assertAiBackendAllowed(context);
      } catch (e) {
        gate.refusals.push(e);
        throw e;
      }
    },
  };
});

// The real setting module reads this store, so the test flips the setting
// exactly the way the settings page does.
const store = {};
globalThis.window = globalThis.window || {};
globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (defaults) => ({ ...(defaults || {}), ...store })),
      set: vi.fn(async (values) => { Object.assign(store, values); }),
    },
    onChanged: { addListener: vi.fn() },
  },
  runtime: { getManifest: () => ({ version: "1.0.0" }) },
};

const { setPrivacyOptOutAllAiEnabled, PRIVACY_OPT_OUT_ERROR_MESSAGE } = await import("../chat/modules/privacySettings.js");
const { getAccessToken, handleAuthError } = await import("../agent/modules/supabaseAuth.js");
const { sendChatCompletions, _testExports } = await import("../agent/modules/llm.js");

const request = () => ({ messages: [{ role: "user", content: "hello" }] });

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// Which sends the setting was checked for, in order: "entry" (the start of the
// request), "send" (the first send), "throttle retry", "re-auth retry".
function checkedSends() {
  return gate.contexts.map(
    (c) => c.replace(/^llm\.sendChatCompletions ?/, "").replace(/ ?endpoint=.*$/, "") || "entry",
  );
}

// Settles the request's pending steps (module loads, storage reads, mocked
// responses) without moving the fake clock.
async function settle() {
  for (let i = 0; i < 50; i++) await new Promise((resolve) => setImmediate(resolve));
}

function outcomeOf(promise) {
  return promise.then(() => null, (e) => e);
}

let throttleSignals;

beforeEach(async () => {
  _testExports.resetForbiddenBackoff();
  _testExports._resetServerHealthSignal();
  await setPrivacyOptOutAllAiEnabled(false);
  browser.storage.local.set.mockClear();
  gate.contexts.length = 0;
  gate.refusals.length = 0;
  getAccessToken.mockReset();
  getAccessToken.mockImplementation(async () => "access-token");
  handleAuthError.mockReset();
  handleAuthError.mockImplementation(async () => true);
  waitingMessage.remove = vi.fn();
  throttleSignals = [];
  window._tabmailThrottleCallback = (signal) => throttleSignals.push(signal);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete window._tabmailThrottleCallback;
});

// The operation ended with the setting's own refusal: the very error the check
// threw, thrown once, with its message, and not taken for the server being
// unreachable.
function expectSettingRefusal(error) {
  expect(gate.refusals).toHaveLength(1);
  expect(error).toBe(gate.refusals[0]);
  expect(error?.name).toBe("PrivacyOptOutError");
  expect(error?.message).toBe(PRIVACY_OPT_OUT_ERROR_MESSAGE);
  expect(browser.storage.local.set).not.toHaveBeenCalledWith({ tabmailServerHealthy: false });
}

describe("AI setting applies to every request", () => {
  it("sends nothing while AI is off from the start", async () => {
    await setPrivacyOptOutAllAiEnabled(true);
    const fetchMock = vi.fn(async () => json(200, { assistant: "should not be sent" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await outcomeOf(sendChatCompletions(request()));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(checkedSends()).toEqual(["entry"]);
    expectSettingRefusal(error);
  });

  it("sends nothing once AI is turned off during the first send's token lookup", async () => {
    getAccessToken.mockImplementationOnce(async () => {
      await setPrivacyOptOutAllAiEnabled(true);
      return "access-token";
    });
    const fetchMock = vi.fn(async () => json(200, { assistant: "should not be sent" }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await outcomeOf(sendChatCompletions(request()));

    expect(fetchMock).not.toHaveBeenCalled();
    expect(checkedSends()).toEqual(["entry", "send"]);
    expectSettingRefusal(error);
  });

  it("sends nothing more once AI is turned off during a rate-limit wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1
        ? json(429, { retry_after_seconds: 1 })
        : json(200, { assistant: "should not be sent" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = outcomeOf(sendChatCompletions(request()));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(throttleSignals).toEqual(["start"]);

    // Half way through the one-second wait, AI is turned off.
    await vi.advanceTimersByTimeAsync(500);
    await setPrivacyOptOutAllAiEnabled(true);
    await vi.advanceTimersByTimeAsync(500);
    await settle();
    const error = await outcome;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checkedSends()).toEqual(["entry", "send", "throttle retry"]);
    expectSettingRefusal(error);
    // The waiting message is cleared and the throttle end signalled once.
    expect(throttleSignals).toEqual(["start", "end"]);
    expect(waitingMessage.remove).toHaveBeenCalledTimes(1);
  });

  it("sends nothing more once AI is turned off during the token lookup for a rate-limited resend", async () => {
    getAccessToken
      .mockImplementationOnce(async () => "access-token")
      .mockImplementationOnce(async () => {
        await setPrivacyOptOutAllAiEnabled(true);
        return "access-token";
      });
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1
        ? json(429, { retry_after_seconds: 0.001 })
        : json(200, { assistant: "should not be sent" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await outcomeOf(sendChatCompletions(request()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(checkedSends()).toEqual(["entry", "send", "throttle retry"]);
    expectSettingRefusal(error);
    expect(throttleSignals).toEqual(["start", "end"]);
    expect(waitingMessage.remove).toHaveBeenCalledTimes(1);
  });

  it("sends nothing more once AI is turned off while signing in again", async () => {
    handleAuthError.mockImplementationOnce(async () => {
      await setPrivacyOptOutAllAiEnabled(true);
      return true;
    });
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1
        ? json(401, { error: "expired" })
        : json(200, { assistant: "should not be sent" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await outcomeOf(sendChatCompletions(request()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(checkedSends()).toEqual(["entry", "send", "re-auth retry"]);
    expectSettingRefusal(error);
  });

  it("sends nothing more once AI is turned off during the token lookup after signing in again", async () => {
    getAccessToken
      .mockImplementationOnce(async () => "access-token")
      .mockImplementationOnce(async () => {
        await setPrivacyOptOutAllAiEnabled(true);
        return "access-token";
      });
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length === 1
        ? json(401, { error: "expired" })
        : json(200, { assistant: "should not be sent" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await outcomeOf(sendChatCompletions(request()));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getAccessToken).toHaveBeenCalledTimes(2);
    expect(checkedSends()).toEqual(["entry", "send", "re-auth retry"]);
    expectSettingRefusal(error);
  });

  it("sends again after a refused sign-in while AI stays on", async () => {
    const responses = [json(401, { error: "expired" }), json(200, { assistant: "hi" })];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal("fetch", fetchMock);

    await sendChatCompletions(request());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(checkedSends()).toEqual(["entry", "send", "re-auth retry"]);
    expect(gate.refusals).toEqual([]);
  });

  it("keeps sending after a rate-limited send while AI stays on", async () => {
    const responses = [json(429, { retry_after_seconds: 0.001 }), json(200, { assistant: "hi" })];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal("fetch", fetchMock);

    await sendChatCompletions(request());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(checkedSends()).toEqual(["entry", "send", "throttle retry"]);
    expect(gate.refusals).toEqual([]);
    expect(throttleSignals).toEqual(["start", "end"]);
    expect(waitingMessage.remove).toHaveBeenCalledTimes(1);
  });
});

describe("rate-limit wait always ends", () => {
  it("waits 1.5 times longer on each consecutive rate limit, at most five seconds, and ends the wait after the last", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const rateLimited = 5;
    const fetchMock = vi.fn(async () =>
      fetchMock.mock.calls.length <= rateLimited
        ? json(429, { retry_after_seconds: 2 })
        : json(200, { assistant: "hi" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = outcomeOf(sendChatCompletions(request()));
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // 2 s, then 1.5 times longer each time, capped at 5 s.
    const waits = [2000, 3000, 4500, 5000, 5000];
    for (const [i, wait] of waits.entries()) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(i + 1);
      // Still waiting: the waiting message stays and the end is not signalled.
      expect(throttleSignals).toEqual(["start"]);
      expect(waitingMessage.remove).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(fetchMock).toHaveBeenCalledTimes(i + 2);
    }

    expect(await outcome).toBeNull();
    expect(checkedSends()).toEqual(["entry", "send", ...waits.map(() => "throttle retry")]);
    expect(throttleSignals).toEqual(["start", "end"]);
    expect(waitingMessage.remove).toHaveBeenCalledTimes(1);
  });

  it("clears the waiting message and signals the end once when the wait ends in an error", async () => {
    const responses = [
      json(429, { retry_after_seconds: 0.001 }),
      new Response("not json", { status: 429 }), // unreadable rate-limit answer
    ];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendChatCompletions(request())).rejects.toThrow("Rate limit active");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(throttleSignals).toEqual(["start", "end"]);
    expect(waitingMessage.remove).toHaveBeenCalledTimes(1);
  });

  it("clears the waiting message and signals the end once when a resend fails to connect", async () => {
    const fetchMock = vi.fn(async () => {
      if (fetchMock.mock.calls.length === 1) return json(429, { retry_after_seconds: 0.001 });
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    // Ends with the rate limit's own error, which is not tried again.
    const error = await outcomeOf(sendChatCompletions(request()));

    expect(error?.message).toBe("Rate limit active but unable to determine retry parameters. Please try again later.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(throttleSignals).toEqual(["start", "end"]);
    expect(waitingMessage.remove).toHaveBeenCalledTimes(1);
  });

  it("signals no end when the first rate-limit answer cannot be read, as no start was signalled", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendChatCompletions(request())).rejects.toThrow("Rate limit active");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(throttleSignals).toEqual([]);
    expect(waitingMessage.remove).not.toHaveBeenCalled();
  });

  it("signals the end to the callback that was signalled the start", async () => {
    // Another request installs its own callback while this one waits.
    const otherSignals = [];
    window._tabmailThrottleCallback = (signal) => {
      throttleSignals.push(signal);
      if (signal === "start") window._tabmailThrottleCallback = (s) => otherSignals.push(s);
    };
    const responses = [json(429, { retry_after_seconds: 0.001 }), json(200, { assistant: "hi" })];
    const fetchMock = vi.fn(async () => responses.shift());
    vi.stubGlobal("fetch", fetchMock);

    await sendChatCompletions(request());

    expect(throttleSignals).toEqual(["start", "end"]);
    expect(otherSignals).toEqual([]);
  });

  it("signals the end to the callback that was signalled the start once the request that installed it removed it", async () => {
    const responses = [json(429, { retry_after_seconds: 0.001 }), json(200, { assistant: "hi" })];
    const fetchMock = vi.fn(async () => {
      // The request that installed the callback ends meanwhile and removes it.
      if (fetchMock.mock.calls.length === 2) delete window._tabmailThrottleCallback;
      return responses.shift();
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendChatCompletions(request());

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(throttleSignals).toEqual(["start", "end"]);
  });

  it("signals nothing when the first send is not rate limited", async () => {
    const fetchMock = vi.fn(async () => json(200, { assistant: "hi" }));
    vi.stubGlobal("fetch", fetchMock);

    await sendChatCompletions(request());

    expect(throttleSignals).toEqual([]);
    expect(waitingMessage.remove).not.toHaveBeenCalled();
  });
});
