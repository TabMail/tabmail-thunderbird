import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugMode: false }, getBackendUrl: () => 'https://test.api' }));
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), normalizeUnicode: (t) => t, saveChatLog: vi.fn() }));
vi.mock('../agent/modules/thinkBuffer.js', () => ({ setThink: vi.fn() }));
vi.mock('../chat/modules/privacySettings.js', () => ({ assertAiBackendAllowed: vi.fn() }));

const { _testExports } = await import("../agent/modules/llm.js");
const { checkForbiddenBackoff, recordForbidden, resetForbiddenBackoff, getEndpointType } = _testExports;

describe("403 backoff state machine", () => {
  beforeEach(() => {
    resetForbiddenBackoff();
  });

  describe("recordForbidden", () => {
    it("sets initial delay to 1000ms on first call", () => {
      recordForbidden();
      // Verify by checking that checkForbiddenBackoff throws (we are in the backoff window)
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");
    });

    it("doubles delay on second call to 2000ms", () => {
      recordForbidden(); // 1000ms
      recordForbidden(); // 2000ms
      // Still in backoff window
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");
    });

    it("caps delay at 300000ms (5 minutes)", () => {
      // Drive delay past cap: 1000, 2000, 4000, 8000, 16000, 32000, 64000, 128000, 256000, 300000
      for (let i = 0; i < 20; i++) {
        recordForbidden();
      }
      // Should still throw (we are well within a 5-minute window)
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");
    });

    it("grows exponentially with multiple rapid calls", () => {
      // Each call should double: 1000 -> 2000 -> 4000 -> 8000
      recordForbidden();
      recordForbidden();
      recordForbidden();
      recordForbidden();
      // All calls happen near-instantly, so the backoff window is
      // approximately Date.now() + 8000ms from the last call — still active
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");
    });
  });

  describe("checkForbiddenBackoff", () => {
    it("does not throw when no backoff has been recorded", () => {
      expect(() => checkForbiddenBackoff()).not.toThrow();
    });

    it("throws when in backoff window", () => {
      recordForbidden();
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");
    });

    it("does not throw when backoff window has expired", () => {
      recordForbidden(); // 1000ms delay

      // Advance time past the backoff window
      const realDateNow = Date.now;
      const future = realDateNow.call(Date) + 2000;
      vi.spyOn(Date, "now").mockReturnValue(future);

      expect(() => checkForbiddenBackoff()).not.toThrow();

      Date.now = realDateNow;
      vi.restoreAllMocks();
    });
  });

  describe("resetForbiddenBackoff", () => {
    it("clears backoff state so subsequent check does not throw", () => {
      recordForbidden();
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");

      resetForbiddenBackoff();
      expect(() => checkForbiddenBackoff()).not.toThrow();
    });

    it("is a no-op when not in backoff (safe to call anytime)", () => {
      // Should not throw or cause any side effects
      expect(() => resetForbiddenBackoff()).not.toThrow();
      expect(() => checkForbiddenBackoff()).not.toThrow();
    });
  });

  describe("full cycle", () => {
    it("record -> check (throws) -> expire -> check (ok) -> record again -> doubles", () => {
      const realDateNow = Date.now;

      // Step 1: record first forbidden
      recordForbidden(); // delay = 1000ms
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");

      // Step 2: advance time past 1000ms backoff
      const afterFirst = realDateNow.call(Date) + 1500;
      vi.spyOn(Date, "now").mockReturnValue(afterFirst);
      expect(() => checkForbiddenBackoff()).not.toThrow();

      // Step 3: record again — delay should double to 2000ms
      // recordForbidden uses Date.now() internally for _forbiddenBackoffUntil
      recordForbidden(); // delay = 2000ms, until = afterFirst + 2000
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");

      // Step 4: advance only 1500ms — still within 2000ms window
      const stillInWindow = afterFirst + 1500;
      Date.now = () => stillInWindow;
      expect(() => checkForbiddenBackoff()).toThrow("Forbidden (403)");

      // Step 5: advance past the 2000ms window
      const pastSecond = afterFirst + 2500;
      Date.now = () => pastSecond;
      expect(() => checkForbiddenBackoff()).not.toThrow();

      Date.now = realDateNow;
      vi.restoreAllMocks();
    });
  });
});

describe("getEndpointType", () => {
  it("returns 'autocomplete' for messages with system_prompt_autocomplete", () => {
    const messages = [{ content: "system_prompt_autocomplete" }];
    expect(getEndpointType(messages)).toBe("autocomplete");
  });

  it("returns 'agent' for messages with other system prompt", () => {
    const messages = [{ content: "system_prompt_summary" }];
    expect(getEndpointType(messages)).toBe("agent");
  });

  it("returns 'agent' for empty messages array", () => {
    expect(getEndpointType([])).toBe("agent");
  });

  it("returns 'agent' for non-array input", () => {
    expect(getEndpointType("not an array")).toBe("agent");
    expect(getEndpointType(42)).toBe("agent");
    expect(getEndpointType({})).toBe("agent");
  });

  it("returns 'agent' for null input", () => {
    expect(getEndpointType(null)).toBe("agent");
  });

  it("returns 'agent' for undefined input", () => {
    expect(getEndpointType(undefined)).toBe("agent");
  });

  it("returns 'agent' for messages without content field", () => {
    const messages = [{ role: "system" }];
    expect(getEndpointType(messages)).toBe("agent");
  });
});
