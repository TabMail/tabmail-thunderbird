const UI_FONT_SIZE_CONFIG = {
  id: "ui-font-size",
  title: "Adjust font sizes",
  description: "Sets UI to 13, regular message text to 17, monospace to 16.",
  ui: {
    pref: "mail.uifontsize",
    value: 13,
  },
  message: {
    // Message display/composition font sizes (keep scoped for debuggability).
    // We apply to both lang groups (x-western and x-unicode) to avoid glitches.
    // Variable (regular) and monospace sizes are set separately for readability.
    variableValue: 17,
    monospaceValue: 16,
    variablePrefs: ["font.size.variable.x-western", "font.size.variable.x-unicode"],
    monospacePrefs: ["font.size.monospace.x-western", "font.size.monospace.x-unicode"],
  },
  // UI surfaces (popup + chat) use CSS variables derived from these design-time sizes.
  // The runtime values are scaled based on Thunderbird prefs for debuggability.
  popup: {
    // These sizes correspond to the current popup CSS design at UI=13.
    designUiBasePx: 13,
    // Extra multiplier for popup typography. This is intentionally configurable because
    // popup windows can render smaller than expected depending on platform/DPI.
    uiScaleMultiplier: 1.15,
    uiSizesPx: {
      body: 13,
      link: 13,
      hotkey: 11,
      serverStatusText: 11,
      serverStatusLink: 11,
      usageLabel: 11,
      usageReset: 11,
      authStatusText: 12,
      authActionBtn: 12,
      authPreference: 11,
      status: 12,
      debugIndicator: 10,
      ftsBanner: 10,
      ftsProgress: 9,
    },
  },
  chat: {
    // Chat uses two scales:
    // - UI controls (header/buttons) scale with mail.uifontsize (design base = 13)
    // - Message area (bubbles/input) scale with message font prefs (design base = 14)
    designUiBasePx: 13,
    designMessageBasePx: 14,
    // Chat message area runs a bit large with message font prefs; tune down.
    messageScaleMultiplier: 0.9,
    uiSizesPx: {
      contextUsageLabel: 12,
      toolGroupHeader: 12,
      toolGroupToggle: 10,
      inputHint: 12,
      selectionIndicator: 11,
      reloadBtn: 18,
      sendBtn: 20,
    },
    messageSizesPx: {
      chatContainer: 14,
      userInput: 14,
      emailMentionChip: 13,
      emailMentionChipDelete: 16,
      mentionOverlay: 14,
      mentionItemLabel: 13,
      mentionItemDescription: 11,
      mentionChipDeleteBtn: 18,
    },
  },
};

export function getUiFontSizeConfig() {
  return UI_FONT_SIZE_CONFIG;
}

export async function applyUiFontSize({ source }) {
  console.log("[TMDBG Tweaks] applyUiFontSize() START", { source });

  if (typeof browser === "undefined") {
    console.error("[TMDBG Tweaks] applyUiFontSize: browser is undefined");
    return { ok: false, reason: "browser_undefined" };
  }

  if (!browser.tmPrefs) {
    console.warn("[TMDBG Tweaks] applyUiFontSize: tmPrefs not available");
    return { ok: false, reason: "tmPrefs_unavailable" };
  }

  try {
    await browser.tmPrefs.setInt(UI_FONT_SIZE_CONFIG.ui.pref, UI_FONT_SIZE_CONFIG.ui.value);
    console.log("[TMDBG Tweaks] applyUiFontSize ✓ setInt (ui)", {
      pref: UI_FONT_SIZE_CONFIG.ui.pref,
      value: UI_FONT_SIZE_CONFIG.ui.value,
    });

    for (const pref of UI_FONT_SIZE_CONFIG.message.variablePrefs) {
      await browser.tmPrefs.setInt(pref, UI_FONT_SIZE_CONFIG.message.variableValue);
      console.log("[TMDBG Tweaks] applyUiFontSize ✓ setInt (message variable)", {
        pref,
        value: UI_FONT_SIZE_CONFIG.message.variableValue,
      });
    }

    for (const pref of UI_FONT_SIZE_CONFIG.message.monospacePrefs) {
      await browser.tmPrefs.setInt(pref, UI_FONT_SIZE_CONFIG.message.monospaceValue);
      console.log("[TMDBG Tweaks] applyUiFontSize ✓ setInt (message monospace)", {
        pref,
        value: UI_FONT_SIZE_CONFIG.message.monospaceValue,
      });
    }

    return { ok: true };
  } catch (e) {
    console.error("[TMDBG Tweaks] applyUiFontSize threw:", e);
    return { ok: false, reason: "exception" };
  }
}

