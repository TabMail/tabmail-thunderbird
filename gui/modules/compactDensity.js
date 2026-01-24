const COMPACT_DENSITY_CONFIG = {
  id: "compact-density",
  title: "Set Compact density",
  description: "Sets Thunderbird UI density to Compact.",
  pref: "mail.uidensity",
  // 0 = compact, 1 = default, 2 = relaxed
  value: 0,
};

export function getCompactDensityConfig() {
  return COMPACT_DENSITY_CONFIG;
}

export async function applyCompactDensity({ source }) {
  console.log("[TMDBG Tweaks] applyCompactDensity() START", { source });

  if (typeof browser === "undefined") {
    console.error("[TMDBG Tweaks] applyCompactDensity: browser is undefined");
    return { ok: false, reason: "browser_undefined" };
  }
  if (!browser.tmPrefs) {
    console.warn("[TMDBG Tweaks] applyCompactDensity: tmPrefs not available");
    return { ok: false, reason: "tmPrefs_unavailable" };
  }

  try {
    await browser.tmPrefs.setInt(COMPACT_DENSITY_CONFIG.pref, COMPACT_DENSITY_CONFIG.value);
    console.log("[TMDBG Tweaks] applyCompactDensity ✓ setInt", {
      pref: COMPACT_DENSITY_CONFIG.pref,
      value: COMPACT_DENSITY_CONFIG.value,
    });
    return { ok: true };
  } catch (e) {
    console.error("[TMDBG Tweaks] applyCompactDensity threw:", e);
    return { ok: false, reason: "exception" };
  }
}

