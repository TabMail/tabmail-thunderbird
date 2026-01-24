// gui/modules/cardViewThreeRows.js
// UI tweak: Force Card View to use 3-row layout (enables snippet space)

const CARD_VIEW_THREE_ROWS_CONFIG = {
  id: "card-view-three-rows",
  title: "3-Row Card View (enables snippets)",
  description: "Sets Card View to 3-row layout, which shows email body snippets below the subject line.",
  pref: "mail.threadpane.cardsview.rowcount",
  value: 3,
};

export function getCardViewThreeRowsConfig() {
  return CARD_VIEW_THREE_ROWS_CONFIG;
}

export async function applyCardViewThreeRows({ source }) {
  console.log("[TMDBG Tweaks] applyCardViewThreeRows() START", { source });

  if (typeof browser === "undefined") {
    console.error("[TMDBG Tweaks] applyCardViewThreeRows: browser is undefined");
    return { ok: false, reason: "browser_undefined" };
  }
  if (!browser.tmPrefs) {
    console.warn("[TMDBG Tweaks] applyCardViewThreeRows: tmPrefs not available");
    return { ok: false, reason: "tmPrefs_unavailable" };
  }

  try {
    await browser.tmPrefs.setInt(CARD_VIEW_THREE_ROWS_CONFIG.pref, CARD_VIEW_THREE_ROWS_CONFIG.value);
    console.log("[TMDBG Tweaks] applyCardViewThreeRows ✓ setInt", {
      pref: CARD_VIEW_THREE_ROWS_CONFIG.pref,
      value: CARD_VIEW_THREE_ROWS_CONFIG.value,
    });
    return { ok: true };
  } catch (e) {
    console.error("[TMDBG Tweaks] applyCardViewThreeRows threw:", e);
    return { ok: false, reason: "exception" };
  }
}

export async function getCardViewRowCount() {
  try {
    if (typeof browser !== "undefined" && browser.tmPrefs) {
      return await browser.tmPrefs.getInt(CARD_VIEW_THREE_ROWS_CONFIG.pref);
    }
    return null;
  } catch (_) {
    return null;
  }
}
