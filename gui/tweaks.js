import { applyCardViewThreeRows, getCardViewThreeRowsConfig } from "./modules/cardViewThreeRows.js";
import { applyCompactDensity, getCompactDensityConfig } from "./modules/compactDensity.js";
import { applyHideSpacesToolbar, getHideSpacesToolbarConfig } from "./modules/hideSpacesToolbar.js";
import { applyPlainTextFixedWidthOff, getPlainTextFixedWidthOffConfig } from "./modules/plainTextFixedWidthOff.js";
import { applySystemFonts, getSystemFontsConfig } from "./modules/systemFonts.js";
import { applyUiFontSize, getUiFontSizeConfig } from "./modules/uiFontSize.js";
import { applyVerticalLayout, getVerticalLayoutConfig } from "./modules/verticalLayout.js";

const GUI_TWEAKS_CONFIG = {
  logPrefix: "[TMDBG Tweaks]",
};

function tlog(...args) {
  console.log(GUI_TWEAKS_CONFIG.logPrefix, ...args);
}

export function getAllTweaks() {
  // Ordered list: keep stable for debugging.
  return [
    getHideSpacesToolbarConfig(),
    getCompactDensityConfig(),
    getSystemFontsConfig(),
    getPlainTextFixedWidthOffConfig(),
    getUiFontSizeConfig(),
    getVerticalLayoutConfig(),
    getCardViewThreeRowsConfig(),
  ];
}

export async function applyAllUiTweaks({ source }) {
  tlog("applyAllUiTweaks() START", { source });

  // Run sequentially for deterministic logs and easier debugging.
  const results = [];

  const steps = [
    { id: "hide-spaces-toolbar", fn: applyHideSpacesToolbar },
    { id: "compact-density", fn: applyCompactDensity },
    { id: "system-fonts", fn: applySystemFonts },
    { id: "plaintext-fixedwidth-off", fn: applyPlainTextFixedWidthOff },
    { id: "ui-font-size", fn: applyUiFontSize },
    { id: "vertical-layout", fn: applyVerticalLayout },
    { id: "card-view-three-rows", fn: applyCardViewThreeRows },
  ];

  for (const step of steps) {
    tlog("applyAllUiTweaks() applying", { step: step.id });
    const r = await step.fn({ source: `${source}:${step.id}` });
    results.push({ id: step.id, result: r });
    if (!r || r.ok !== true) {
      tlog("applyAllUiTweaks() FAILED", { step: step.id, result: r });
      return { ok: false, reason: `${step.id}_failed`, results };
    }
  }

  tlog("applyAllUiTweaks() DONE (ok)", { results });
  return { ok: true, results };
}

export {
  applyCardViewThreeRows, applyCompactDensity, applyHideSpacesToolbar, applyPlainTextFixedWidthOff, applySystemFonts, applyUiFontSize,
  applyVerticalLayout
};

