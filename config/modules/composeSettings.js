import { $ } from "./dom.js";

export async function loadComposeSettings() {
  try {
    const stored = await browser.storage.local.get({
      TRIGGER_THROTTLE_MS: null,
      DIFF_RESTORE_DELAY_MS: null,
    });
    $("trigger-delay").value =
      stored.TRIGGER_THROTTLE_MS ?? TabMail.config.TRIGGER_THROTTLE_MS;
    $("diff-restore-delay").value =
      stored.DIFF_RESTORE_DELAY_MS ?? TabMail.config.DIFF_RESTORE_DELAY_MS;
  } catch (e) {
    console.warn("[TMDBG Config] loadComposeSettings failed", e);
  }
}

export async function handleComposeSettingsChange(e) {
  if (e.target.id === "trigger-delay") {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) {
      await browser.storage.local.set({ TRIGGER_THROTTLE_MS: v });
      try {
        if (window.TabMail && TabMail.config) TabMail.config.TRIGGER_THROTTLE_MS = v;
      } catch {}
    }
  }
  if (e.target.id === "diff-restore-delay") {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v)) {
      await browser.storage.local.set({ DIFF_RESTORE_DELAY_MS: v });
      try {
        if (window.TabMail && TabMail.config) TabMail.config.DIFF_RESTORE_DELAY_MS = v;
      } catch {}
    }
  }
}

