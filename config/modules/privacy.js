import { $ } from "./dom.js";
import { isAutoEnabled, setAutoEnabled } from "../../agent/modules/p2pSync.js";

export function updatePrivacyOptOutUI(enabled) {
  const warning = $("privacy-opt-out-warning");
  if (warning) {
    warning.style.display = enabled ? "block" : "none";
  }
}

function updateDeviceSyncUI(enabled) {
  const warning = $("privacy-device-sync-warning");
  if (warning) {
    warning.style.display = enabled ? "none" : "block";
  }
}

export async function loadPrivacySettings(getPrivacyOptOutAllAiEnabled, log) {
  try {
    const enabled = await getPrivacyOptOutAllAiEnabled();
    const cb = $("privacy-opt-out-all-ai");
    if (cb) cb.checked = enabled;
    updatePrivacyOptOutUI(enabled);

    const syncEnabled = await isAutoEnabled();
    const syncCb = $("privacy-device-sync");
    if (syncCb) syncCb.checked = syncEnabled;
    updateDeviceSyncUI(syncEnabled);

    log(`[TMDBG Config] Privacy settings loaded: optOutAllAi=${enabled}, deviceSync=${syncEnabled}`);
  } catch (e) {
    log(`[TMDBG Config] loadPrivacySettings failed: ${e}`, "error");
  }
}

export async function handlePrivacyChange(e, setPrivacyOptOutAllAiEnabled) {
  if (e.target.id === "privacy-opt-out-all-ai") {
    const enabled = e.target.checked === true;
    updatePrivacyOptOutUI(enabled);
    const ok = await setPrivacyOptOutAllAiEnabled(enabled);
    if (ok) {
      console.log(
        `[TMDBG Config] Privacy opt-out ${enabled ? "enabled" : "disabled"}`,
      );
      $("status").textContent = enabled
        ? "Privacy opt-out enabled: ALL AI features are disabled."
        : "";
    } else {
      $("status").textContent = "Error saving privacy setting";
    }
  }

  if (e.target.id === "privacy-device-sync") {
    const enabled = e.target.checked === true;
    updateDeviceSyncUI(enabled);
    await setAutoEnabled(enabled);
    console.log(`[TMDBG Config] Device sync ${enabled ? "enabled" : "disabled"}`);
    $("status").textContent = enabled
      ? "Device sync enabled."
      : "Device sync disabled: AI results will not sync between devices.";
  }
}
