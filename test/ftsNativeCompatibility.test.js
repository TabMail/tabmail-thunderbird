/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, expect, it } from "vitest";
import {
  NATIVE_FTS_BRIDGE_VERSION,
  NATIVE_FTS_PREVIOUS_SIGNER_RETIREMENT_AT,
  getNativeFtsCompatibility,
} from "../fts/nativeCompatibility.js";
import { getFtsHelperPrompt } from "../fts/helperPrompt.js";

const RETIREMENT_MS = Date.parse(NATIVE_FTS_PREVIOUS_SIGNER_RETIREMENT_AT);

describe("native FTS signing-key overlap compatibility", () => {
  it("allows an old helper to self-update before the overlap ends", () => {
    const result = getNativeFtsCompatibility("0.10.1", RETIREMENT_MS - 1);
    expect(result.supported).toBe(true);
    expect(result.bridgeInstalled).toBe(false);
  });

  it("requires reinstall for an old helper at the exact retirement boundary", () => {
    const result = getNativeFtsCompatibility("0.10.1", RETIREMENT_MS);
    expect(result.supported).toBe(false);
    expect(result.minimumSupportedVersion).toBe(NATIVE_FTS_BRIDGE_VERSION);
  });

  it("continues supporting the dual-key bridge after retirement", () => {
    expect(getNativeFtsCompatibility("0.11.1", RETIREMENT_MS).supported).toBe(true);
    expect(getNativeFtsCompatibility("0.12.0", RETIREMENT_MS + 1).supported).toBe(true);
  });
});

describe("native FTS helper action copy", () => {
  it("distinguishes unsupported from missing and promises index preservation", () => {
    const prompt = getFtsHelperPrompt({
      available: false,
      status: "unsupported",
      hostVersion: "0.10.1",
    });

    expect(prompt.title).toContain("update required");
    expect(prompt.message).toContain("no longer supported");
    expect(prompt.message).toContain("existing search index will be preserved");
    expect(prompt.buttonLabel).toContain("Re-download");
    expect(prompt.versionLabel).toBe("Unsupported (v0.10.1)");
  });

  it("keeps the install prompt for a genuinely missing helper", () => {
    const prompt = getFtsHelperPrompt({ available: false, status: "missing" });
    expect(prompt.title).toContain("not installed");
    expect(prompt.buttonLabel).toContain("Install");
  });

  it("does not prompt while available or unknown", () => {
    expect(getFtsHelperPrompt({ available: true, status: "available" })).toBeNull();
    expect(getFtsHelperPrompt({ available: null, status: "unknown" })).toBeNull();
  });
});
