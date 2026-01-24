import {
  applyAllUiTweaks,
  applyCardViewThreeRows,
  applyCompactDensity,
  applyHideSpacesToolbar,
  applyPlainTextFixedWidthOff,
  applySystemFonts,
  applyUiFontSize,
  applyVerticalLayout,
} from "../../gui/tweaks.js";
import { $ } from "./dom.js";

const UI_TWEAKS_CONFIG = {
  logPrefix: "[TMDBG ConfigUI]",
  ids: {
    applyAllButton: "ui-tweaks-apply-all",
    applyHideSpacesToolbar: "ui-tweak-apply-hide-spaces-toolbar",
    applyCompactDensity: "ui-tweak-apply-compact-density",
    applySystemFonts: "ui-tweak-apply-system-fonts",
    applyPlainTextFixedWidthOff: "ui-tweak-apply-plaintext-fixedwidth-off",
    applyAdjustFontSizes: "ui-tweak-apply-adjust-font-sizes",
    applyVerticalLayout: "ui-tweak-apply-vertical-layout",
    applyCardViewThreeRows: "ui-tweak-apply-card-view-three-rows",
    statusText: "ui-tweaks-status-text",
  },
};

function uiLog(...args) {
  console.log(UI_TWEAKS_CONFIG.logPrefix, ...args);
}

function uiWarn(...args) {
  console.warn(UI_TWEAKS_CONFIG.logPrefix, ...args);
}

function setStatus(text, isError = false) {
  const el = $(UI_TWEAKS_CONFIG.ids.statusText);
  if (!el) return;
  el.textContent = text || "";
  if (isError) {
    el.style.color = "var(--tag-tm-delete)";
  } else {
    el.style.color = "var(--tag-tm-reply)";
  }
}

export async function loadUiTweaksSettings() {
  // Intentionally no "applied" state in the UI (apply-only actions).
}

export async function handleUiTweaksClick(e) {
  const btn = e?.target?.closest?.("button") || null;
  const id = btn?.id;
  if (!id) return;

  // Apply: Hide Spaces toolbar (apply-only; never disables)
  if (id === UI_TWEAKS_CONFIG.ids.applyHideSpacesToolbar) {
    uiLog("Apply UI tweak clicked: hideSpacesToolbar");
    setStatus("Applying…");
    try {
      const r = await applyHideSpacesToolbar({ source: "config:hide-spaces-toolbar" });
      if (r && r.ok) setStatus("✓ Done");
      else setStatus(`Error (${r?.reason || "unknown"})`, true);
    } catch (err) {
      uiWarn("applyHideSpacesToolbar threw", err);
      setStatus("Error (exception)", true);
    }
    return;
  }

  // Apply: System fonts (apply-only; never disables)
  if (id === UI_TWEAKS_CONFIG.ids.applySystemFonts) {
    uiLog("Apply UI tweak clicked: systemFonts");
    setStatus("Applying…");
    try {
      const r = await applySystemFonts({ source: "config:system-fonts" });
      if (r && r.ok) setStatus("✓ Done");
      else setStatus(`Error (${r?.reason || "unknown"})`, true);
    } catch (err) {
      uiWarn("applySystemFonts threw", err);
      setStatus("Error (exception)", true);
    }
    return;
  }

  // Apply: Compact density (apply-only; never disables)
  if (id === UI_TWEAKS_CONFIG.ids.applyCompactDensity) {
    uiLog("Apply UI tweak clicked: compactDensity");
    setStatus("Applying…");
    try {
      const r = await applyCompactDensity({ source: "config:compact-density" });
      if (r && r.ok) setStatus("✓ Done");
      else setStatus(`Error (${r?.reason || "unknown"})`, true);
    } catch (err) {
      uiWarn("applyCompactDensity threw", err);
      setStatus("Error (exception)", true);
    }
    return;
  }

  // Apply: UI font size (apply-only; never disables)
  if (id === UI_TWEAKS_CONFIG.ids.applyAdjustFontSizes) {
    uiLog("Apply UI tweak clicked: adjustFontSizes");
    setStatus("Applying…");
    try {
      const r = await applyUiFontSize({ source: "config:adjust-font-sizes" });
      if (r && r.ok) setStatus("✓ Done");
      else setStatus(`Error (${r?.reason || "unknown"})`, true);
    } catch (err) {
      uiWarn("applyUiFontSize threw", err);
      setStatus("Error (exception)", true);
    }
    return;
  }

  // Apply: Plaintext fixed-width OFF (apply-only)
  if (id === UI_TWEAKS_CONFIG.ids.applyPlainTextFixedWidthOff) {
    uiLog("Apply UI tweak clicked: plaintextFixedWidthOff");
    setStatus("Applying…");
    try {
      const r = await applyPlainTextFixedWidthOff({ source: "config:plaintext-fixedwidth-off" });
      if (r && r.ok) setStatus("✓ Done");
      else setStatus(`Error (${r?.reason || "unknown"})`, true);
    } catch (err) {
      uiWarn("applyPlainTextFixedWidthOff threw", err);
      setStatus("Error (exception)", true);
    }
    return;
  }

  // Apply: Vertical layout (apply-only; never disables)
  if (id === UI_TWEAKS_CONFIG.ids.applyVerticalLayout) {
    uiLog("Apply UI tweak clicked: verticalLayout");
    setStatus("Applying…");
    try {
      const r = await applyVerticalLayout({ source: "config:vertical-layout" });
      if (r && r.ok) setStatus("✓ Done");
      else setStatus(`Error (${r?.reason || "unknown"})`, true);
    } catch (err) {
      uiWarn("applyVerticalLayout threw", err);
      setStatus("Error (exception)", true);
    }
    return;
  }

  // Apply: 3-Row Card View (apply-only; enables snippets)
  if (id === UI_TWEAKS_CONFIG.ids.applyCardViewThreeRows) {
    uiLog("Apply UI tweak clicked: cardViewThreeRows");
    setStatus("Applying…");
    try {
      const r = await applyCardViewThreeRows({ source: "config:card-view-three-rows" });
      if (r && r.ok) setStatus("✓ Done (snippets enabled)");
      else setStatus(`Error (${r?.reason || "unknown"})`, true);
    } catch (err) {
      uiWarn("applyCardViewThreeRows threw", err);
      setStatus("Error (exception)", true);
    }
    return;
  }

  if (id !== UI_TWEAKS_CONFIG.ids.applyAllButton) return;

  uiLog("Apply all UI tweaks clicked");
  setStatus("Applying all…");

  try {
    const result = await applyAllUiTweaks({ source: "config:apply-all" });
    uiLog("applyAllUiTweaks result:", result);
    if (result && result.ok) setStatus("✓ Done");
    else setStatus(`Error (${result?.reason || "unknown"})`, true);
  } catch (err) {
    uiWarn("applyAllUiTweaks threw", err);
    setStatus("Error (exception)", true);
  }
}

