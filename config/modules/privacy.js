import { $ } from "./dom.js";

export function updatePrivacyOptOutUI(enabled) {
  const warning = $("privacy-opt-out-warning");
  if (warning) {
    warning.style.display = enabled ? "block" : "none";
  }
}

export async function loadPrivacySettings(getPrivacyOptOutAllAiEnabled, log) {
  try {
    const enabled = await getPrivacyOptOutAllAiEnabled();
    const cb = $("privacy-opt-out-all-ai");
    if (cb) cb.checked = enabled;
    updatePrivacyOptOutUI(enabled);
    log(`[TMDBG Config] Privacy settings loaded: optOutAllAi=${enabled}`);
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
}

