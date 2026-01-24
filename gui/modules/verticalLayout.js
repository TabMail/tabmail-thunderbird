const VERTICAL_LAYOUT_CONFIG = {
  id: "vertical-layout",
  title: "Set Vertical layout",
  description: "Sets Thunderbird to Vertical layout (message pane below the message list).",
  pref: "mail.pane_config.dynamic",
  // 2 = vertical
  value: 2,
  liveMethod: "setPaneLayoutLive",
};

export function getVerticalLayoutConfig() {
  return VERTICAL_LAYOUT_CONFIG;
}

export async function applyVerticalLayout({ source }) {
  console.log("[TMDBG Tweaks] applyVerticalLayout() START", { source });

  if (typeof browser === "undefined") {
    console.error("[TMDBG Tweaks] applyVerticalLayout: browser is undefined");
    return { ok: false, reason: "browser_undefined" };
  }
  if (!browser.tmPrefs) {
    console.warn("[TMDBG Tweaks] applyVerticalLayout: tmPrefs not available");
    return { ok: false, reason: "tmPrefs_unavailable" };
  }

  try {
    await browser.tmPrefs.setInt(VERTICAL_LAYOUT_CONFIG.pref, VERTICAL_LAYOUT_CONFIG.value);
    console.log("[TMDBG Tweaks] applyVerticalLayout ✓ setInt", {
      pref: VERTICAL_LAYOUT_CONFIG.pref,
      value: VERTICAL_LAYOUT_CONFIG.value,
    });
  } catch (e) {
    console.error("[TMDBG Tweaks] applyVerticalLayout setInt threw:", e);
    return { ok: false, reason: "setInt_exception" };
  }

  // Apply live (TB 145 experiment method); do not fallback silently if missing.
  try {
    const fn = browser.tmPrefs[VERTICAL_LAYOUT_CONFIG.liveMethod];
    if (typeof fn !== "function") {
      console.warn("[TMDBG Tweaks] applyVerticalLayout: setPaneLayoutLive not available");
      return { ok: false, reason: "setPaneLayoutLive_unavailable" };
    }
    await fn(VERTICAL_LAYOUT_CONFIG.value);
    console.log("[TMDBG Tweaks] applyVerticalLayout ✓ setPaneLayoutLive", VERTICAL_LAYOUT_CONFIG.value);
  } catch (e) {
    console.error("[TMDBG Tweaks] applyVerticalLayout setPaneLayoutLive threw:", e);
    return { ok: false, reason: "setPaneLayoutLive_exception" };
  }

  return { ok: true };
}

