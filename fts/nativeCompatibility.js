/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// v0.11.1 is the bridge release that trusts both the previous and current
// manifest-signing public keys. The signer was promoted after the bridge and
// reinstall UI were verified on 2026-08-13. v0.11.2 removes the previous key;
// v0.11.1 remains supported because it trusts the current signer and can update.
export const NATIVE_FTS_BRIDGE_VERSION = "0.11.1";
export const NATIVE_FTS_PREVIOUS_SIGNER_RETIREMENT_AT = "2026-08-13T16:00:00.000Z";

// On Windows a helper started by Thunderbird could not replace itself until the
// native-fts release that starts its apply-update copy outside Thunderbird's job
// (native-fts #65): an older Windows helper fails or loops on every self-update.
// Set to that release's version by the release that carries the fix; until then
// (null) no Windows rule applies. A Windows helper older than this is unsupported
// and takes the existing reinstall path.
export const NATIVE_FTS_WINDOWS_MIN_SELF_UPDATING_VERSION = null;

export function versionLessThan(a, b) {
  const pa = String(a || "").split(".").map(Number);
  const pb = String(b || "").split(".").map(Number);
  const len = Math.max(pa.length, pb.length);

  for (let i = 0; i < len; i++) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va < vb) return true;
    if (va > vb) return false;
  }
  return false;
}

/**
 * Return the local compatibility policy for an installed native helper.
 * Before the overlap window closes, legacy helpers can still self-update from
 * manifests signed by the previous active key. At/after the cutoff, only the
 * bridge release (which can update under the current signer) or newer is safe.
 * On Windows (`os === "win"`, from runtime.getPlatformInfo) a configured
 * `windowsMinimumVersion` is also required.
 */
export function getNativeFtsCompatibility(
  hostVersion,
  nowMs = Date.now(),
  { os = null, windowsMinimumVersion = null } = {},
) {
  const retirementAtMs = Date.parse(NATIVE_FTS_PREVIOUS_SIGNER_RETIREMENT_AT);
  const bridgeInstalled = !versionLessThan(hostVersion, NATIVE_FTS_BRIDGE_VERSION);
  const overlapComplete = nowMs >= retirementAtMs;
  const windowsRule = os === "win" && Boolean(windowsMinimumVersion);
  const windowsSupported = !windowsRule || !versionLessThan(hostVersion, windowsMinimumVersion);
  const minimumSupportedVersion = windowsRule
    && versionLessThan(NATIVE_FTS_BRIDGE_VERSION, windowsMinimumVersion)
    ? windowsMinimumVersion
    : NATIVE_FTS_BRIDGE_VERSION;

  return {
    supported: (bridgeInstalled || !overlapComplete) && windowsSupported,
    bridgeInstalled,
    overlapComplete,
    minimumSupportedVersion,
    retirementAt: NATIVE_FTS_PREVIOUS_SIGNER_RETIREMENT_AT,
  };
}
