import { getUiFontSizeConfig } from "./uiFontSize.js";
import { SETTINGS } from "../../agent/modules/config.js";

function isPositiveNumber(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

async function readUiFontSizePx() {
  const cfg = getUiFontSizeConfig();
  const pref = cfg?.ui?.pref;
  if (!pref) return null;

  try {
    if (!browser?.tmPrefs?.getIntSafe) {
      if (SETTINGS.debugLogging) console.warn("[TMDBG Font] tmPrefs.getIntSafe not available (ui)");
      return null;
    }
    const v = await browser.tmPrefs.getIntSafe(pref, 0);
    return isPositiveNumber(v) ? v : null;
  } catch (e) {
    if (SETTINGS.debugLogging) console.warn(`[TMDBG Font] readUiFontSizePx failed for ${pref}:`, e);
    return null;
  }
}

async function readMessageFontSizePx() {
  // Prefer x-unicode; then x-western. No computed fallback to keep debugging clear.
  try {
    if (!browser?.tmPrefs?.getInt) {
      if (SETTINGS.debugLogging) console.warn("[TMDBG Font] tmPrefs.getInt not available (message)");
      return null;
    }

    const unicodePref = await browser.tmPrefs.getInt("font.size.variable.x-unicode");
    if (isPositiveNumber(unicodePref)) return unicodePref;

    const westernPref = await browser.tmPrefs.getInt("font.size.variable.x-western");
    if (isPositiveNumber(westernPref)) return westernPref;

    if (SETTINGS.debugLogging) console.warn("[TMDBG Font] Message font prefs returned non-positive values", {
      unicodePref,
      westernPref,
    });
    return null;
  } catch (e) {
    if (SETTINGS.debugLogging) console.warn("[TMDBG Font] readMessageFontSizePx failed:", e);
    return null;
  }
}

function setCssVarPx(doc, name, px) {
  try {
    doc?.documentElement?.style?.setProperty(name, `${px}px`);
  } catch (e) {
    if (SETTINGS.debugLogging) console.warn(`[TMDBG Font] Failed to set CSS var ${name}=${px}px:`, e);
  }
}

function applyScaledVars(doc, prefix, sizes, scale) {
  if (!sizes || typeof sizes !== "object") return;
  for (const [k, basePx] of Object.entries(sizes)) {
    if (!isPositiveNumber(basePx)) continue;
    const outPx = basePx * scale;
    setCssVarPx(doc, `${prefix}${k}`, outPx);
  }
}

/**
 * Read Thunderbird font prefs and apply them to an HTML document via CSS vars.
 *
 * - UI font: mail.uifontsize
 * - Message font: font.size.variable.x-unicode (preferred) or x-western
 *
 * No JS-level fallback font sizes are applied: if prefs can't be read, we log and do nothing.
 */
export async function applyUiFontVarsToDocument({ document, source }) {
  const cfg = getUiFontSizeConfig();
  if (SETTINGS.debugLogging) console.log("[TMDBG Font] applyUiFontVarsToDocument START", { source });

  if (typeof browser === "undefined") {
    if (SETTINGS.debugLogging) console.error("[TMDBG Font] browser is undefined");
    return { ok: false, reason: "browser_undefined" };
  }
  if (!browser.tmPrefs) {
    if (SETTINGS.debugLogging) console.warn("[TMDBG Font] tmPrefs not available");
    return { ok: false, reason: "tmPrefs_unavailable" };
  }

  const uiPx = await readUiFontSizePx();
  const msgPx = await readMessageFontSizePx();

  if (!isPositiveNumber(uiPx) || !isPositiveNumber(msgPx)) {
    if (SETTINGS.debugLogging) console.warn("[TMDBG Font] Pref read failed; not applying document font vars", {
      source,
      uiPx,
      msgPx,
    });
    return { ok: false, reason: "pref_read_failed", uiPx, msgPx };
  }

  // Base vars (useful for debugging / ad-hoc styling)
  setCssVarPx(document, "--tm-ui-font-size-px", uiPx);
  setCssVarPx(document, "--tm-message-font-size-px", msgPx);

  // Per-surface derived vars (keeps CSS free of hardcoded px sizes)
  const popupBase = cfg?.popup?.designUiBasePx;
  const chatUiBase = cfg?.chat?.designUiBasePx;
  const chatMsgBase = cfg?.chat?.designMessageBasePx;

  const popupUiMul = cfg?.popup?.uiScaleMultiplier;
  const chatMsgMul = cfg?.chat?.messageScaleMultiplier;

  const uiScalePopupBase = isPositiveNumber(popupBase) ? uiPx / popupBase : null;
  const uiScaleChat = isPositiveNumber(chatUiBase) ? uiPx / chatUiBase : null;
  const msgScaleChatBase = isPositiveNumber(chatMsgBase) ? msgPx / chatMsgBase : null;

  const uiScalePopup =
    isPositiveNumber(uiScalePopupBase) && isPositiveNumber(popupUiMul)
      ? uiScalePopupBase * popupUiMul
      : null;

  const msgScaleChat =
    isPositiveNumber(msgScaleChatBase) && isPositiveNumber(chatMsgMul)
      ? msgScaleChatBase * chatMsgMul
      : null;

  if (!isPositiveNumber(uiScalePopup) || !isPositiveNumber(uiScaleChat) || !isPositiveNumber(msgScaleChat)) {
    if (SETTINGS.debugLogging) console.warn("[TMDBG Font] Missing design bases; not applying scaled vars", {
      source,
      popupBase,
      chatUiBase,
      chatMsgBase,
      popupUiMul,
      chatMsgMul,
      uiScalePopupBase,
      msgScaleChatBase,
      uiScalePopup,
      uiScaleChat,
      msgScaleChat,
    });
    return { ok: false, reason: "missing_design_bases" };
  }

  applyScaledVars(document, "--tm-popup-font-", cfg?.popup?.uiSizesPx || {}, uiScalePopup);

  applyScaledVars(document, "--tm-chat-font-ui-", cfg?.chat?.uiSizesPx || {}, uiScaleChat);
  applyScaledVars(document, "--tm-chat-font-msg-", cfg?.chat?.messageSizesPx || {}, msgScaleChat);

  if (SETTINGS.debugLogging) console.log("[TMDBG Font] applyUiFontVarsToDocument OK", {
    source,
    uiPx,
    msgPx,
    uiScalePopup,
    uiScaleChat,
    msgScaleChat,
  });
  return { ok: true, uiPx, msgPx };
}

