const SYSTEM_FONTS_CONFIG = {
  id: "system-fonts",
  title: "Use reading fonts",
  description: "Uses optimized reading fonts for message display/composition (Helvetica Neue on macOS, Segoe UI on Windows, Noto Sans on Linux).",
  // Apply-only tweak: always apply the TabMail recommendation.
  enabled: true,
};

export function getSystemFontsConfig() {
  return SYSTEM_FONTS_CONFIG;
}

export async function applySystemFonts({ source }) {
  console.log("[TMDBG Tweaks] applySystemFonts() START", { source });

  if (typeof browser === "undefined") {
    console.error("[TMDBG Tweaks] applySystemFonts: browser is undefined");
    return { ok: false, reason: "browser_undefined" };
  }

  if (!browser.tmTweaks) {
    console.warn("[TMDBG Tweaks] applySystemFonts: tmTweaks not available");
    return { ok: false, reason: "tmTweaks_unavailable" };
  }

  try {
    const result = await browser.tmTweaks.setSystemFontsEnabled(
      SYSTEM_FONTS_CONFIG.enabled === true,
    );
    console.log("[TMDBG Tweaks] applySystemFonts result:", result);
    if (result && result.ok) return { ok: true };
    return { ok: false, reason: result?.reason || "unknown", details: result };
  } catch (e) {
    console.error("[TMDBG Tweaks] applySystemFonts threw:", e);
    return { ok: false, reason: "exception" };
  }
}

