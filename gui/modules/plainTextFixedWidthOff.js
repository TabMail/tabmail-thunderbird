const PLAINTEXT_FIXED_WIDTH_OFF_CONFIG = {
  id: "plaintext-fixedwidth-off",
  title: "Use monospace fonts in plaintext: Off",
  description: "Ensures plaintext messages do not render with fixed-width fonts.",
  pref: "mail.fixed_width_messages",
  value: false,
};

export function getPlainTextFixedWidthOffConfig() {
  return PLAINTEXT_FIXED_WIDTH_OFF_CONFIG;
}

export async function applyPlainTextFixedWidthOff({ source }) {
  console.log("[TMDBG Tweaks] applyPlainTextFixedWidthOff() START", { source });

  if (typeof browser === "undefined") {
    console.error("[TMDBG Tweaks] applyPlainTextFixedWidthOff: browser is undefined");
    return { ok: false, reason: "browser_undefined" };
  }

  if (!browser.tmPrefs) {
    console.warn("[TMDBG Tweaks] applyPlainTextFixedWidthOff: tmPrefs not available");
    return { ok: false, reason: "tmPrefs_unavailable" };
  }

  try {
    await browser.tmPrefs.setBool(
      PLAINTEXT_FIXED_WIDTH_OFF_CONFIG.pref,
      PLAINTEXT_FIXED_WIDTH_OFF_CONFIG.value === true,
    );
    console.log("[TMDBG Tweaks] applyPlainTextFixedWidthOff ✓ setBool", {
      pref: PLAINTEXT_FIXED_WIDTH_OFF_CONFIG.pref,
      value: PLAINTEXT_FIXED_WIDTH_OFF_CONFIG.value,
    });
    return { ok: true };
  } catch (e) {
    console.error("[TMDBG Tweaks] applyPlainTextFixedWidthOff threw:", e);
    return { ok: false, reason: "exception" };
  }
}

