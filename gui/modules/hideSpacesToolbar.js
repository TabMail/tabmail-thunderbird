const HIDE_SPACES_TOOLBAR_CONFIG = {
  id: "hide-spaces-toolbar",
  title: "Hide Spaces toolbar",
  description: "Hides the left Spaces toolbar (Mail/Calendar/Tasks/Chat).",
  // Apply-only tweak: always apply the TabMail recommendation.
  hidden: true,
};

export function getHideSpacesToolbarConfig() {
  return HIDE_SPACES_TOOLBAR_CONFIG;
}

export async function applyHideSpacesToolbar({ source }) {
  console.log("[TMDBG Tweaks] applyHideSpacesToolbar() START", { source });

  if (typeof browser === "undefined") {
    console.error("[TMDBG Tweaks] applyHideSpacesToolbar: browser is undefined");
    return { ok: false, reason: "browser_undefined" };
  }

  if (!browser.tmTweaks) {
    console.warn("[TMDBG Tweaks] applyHideSpacesToolbar: tmTweaks not available");
    return { ok: false, reason: "tmTweaks_unavailable" };
  }

  try {
    const result = await browser.tmTweaks.setSpacesToolbarHidden(
      HIDE_SPACES_TOOLBAR_CONFIG.hidden === true,
    );
    console.log("[TMDBG Tweaks] applyHideSpacesToolbar result:", result);
    if (result && result.ok) return { ok: true };
    return { ok: false, reason: result?.reason || "unknown", details: result };
  } catch (e) {
    console.error("[TMDBG Tweaks] applyHideSpacesToolbar threw:", e);
    return { ok: false, reason: "exception" };
  }
}

