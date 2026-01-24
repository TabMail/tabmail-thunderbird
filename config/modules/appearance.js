import { $ } from "./dom.js";

// ============================================================================
// SHARED THEME UTILITIES (used by both config page and welcome wizard)
// ============================================================================

/**
 * Apply theme preference to Thunderbird
 * @param {string} theme - "light", "dark", or "system"
 * @returns {Promise<boolean>} - true if successful
 */
export async function applyTheme(theme) {
  console.log(`[TMDBG Config] ═══ applyTheme() START ═══`);
  console.log(`[TMDBG Config] applyTheme() called with theme: "${theme}"`);
  
  try {
    if (typeof browser === "undefined") {
      console.error("[TMDBG Config] applyTheme: browser object is undefined!");
      return false;
    }
    console.log(`[TMDBG Config] applyTheme: browser object exists, type: ${typeof browser}`);
    
    console.log(
      "[TMDBG Config] applyTheme: browser.theme available? %s | browser.management available? %s",
      !!browser.theme,
      !!browser.management,
    );
    
    // Notify theme system to refresh
    console.log("[TMDBG Config] applyTheme: Sending theme-preference-changed message to runtime...");
    try {
      const response = await browser.runtime.sendMessage({
        command: "theme-preference-changed",
        theme: theme
      });
      console.log("[TMDBG Config] applyTheme: ✓ Sent message, response:", response);
      if (response && response.ok === false) {
        console.log("[TMDBG Config] applyTheme: Background reported failure:", response);
        return false;
      }
    } catch (e) {
      console.log("[TMDBG Config] applyTheme: Message send error (may have no listeners):", e.message || e);
    }
    
    console.log("[TMDBG Config] ═══ applyTheme() DONE (success) ═══");
    return true;
  } catch (e) {
    console.error("[TMDBG Config] ═══ applyTheme() FAILED ═══", e);
    return false;
  }
}

/**
 * Get current theme from TB prefs
 * @returns {Promise<string>} "light", "dark", or "system"
 */
export async function getCurrentTheme() {
  try {
    if (!browser.tmPrefs) {
      console.log("[TMDBG Config] getCurrentTheme: tmPrefs not available, returning 'system'");
      return "system";
    }

    // We enforce Default/System theme add-on, and drive theme via ui.systemUsesDarkTheme override.
    // To distinguish "system" from explicit "light", we must check prefHasUserValue.
    const hasOverride = await browser.tmPrefs.hasUserValue("ui.systemUsesDarkTheme");
    console.log(`[TMDBG Config] getCurrentTheme: hasUserValue(ui.systemUsesDarkTheme)=${hasOverride}`);
    if (!hasOverride) return "system";

    const prefValue = await browser.tmPrefs.getInt("ui.systemUsesDarkTheme");
    console.log(`[TMDBG Config] getCurrentTheme: ui.systemUsesDarkTheme=${prefValue}`);
    if (prefValue === 1) return "dark";
    return "light";
  } catch (e) {
    return "system";
  }
}

/**
 * Update images that have data-light-src and data-dark-src attributes
 * based on the current theme
 */
export async function updateThemeSensitiveImages() {
  const theme = await getCurrentTheme();
  
  // If system, check OS preference
  let effectiveTheme = theme;
  if (theme === "system") {
    const isDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    effectiveTheme = isDark ? "dark" : "light";
  }
  
  // Find all images with data-light-src and data-dark-src
  const images = document.querySelectorAll("img[data-light-src][data-dark-src]");
  for (const img of images) {
    const src = effectiveTheme === "dark" ? img.dataset.darkSrc : img.dataset.lightSrc;
    if (src && img.src !== src) {
      img.src = src;
      console.log(`[TMDBG Appearance] Updated image to ${effectiveTheme} version: ${src}`);
    }
  }
}

// ============================================================================
// Appearance settings functions
export async function loadAppearanceSettings(SETTINGS) {
  try {
    if (!browser.tmPrefs) {
      console.warn("[TMDBG Config] tmPrefs not available for appearance settings");
      return;
    }

    const prefs = SETTINGS.appearance.prefs;
    const tagCfg = SETTINGS.actionTagging || {};

    // Load theme preference using shared getCurrentTheme()
    const themeValue = await getCurrentTheme();
    const themeRadio = $(`theme-${themeValue}`);
    if (themeRadio) {
      themeRadio.checked = true;
    }
    console.log(`[TMDBG Config] Theme loaded: ${themeValue}`);

    // Load "Tag by thread" setting (effective tag by thread) with one-time migration.
    try {
      const stored = await browser.storage.local.get([
        "tagByThreadEnabled",
        "messageGroupingEnabled", // legacy key (migration)
      ]);

      let tagByThreadEnabled = stored.tagByThreadEnabled;
      const legacy = stored.messageGroupingEnabled;
      const hasNew = Object.prototype.hasOwnProperty.call(
        stored,
        "tagByThreadEnabled",
      );
      const hasLegacy = Object.prototype.hasOwnProperty.call(
        stored,
        "messageGroupingEnabled",
      );

      // Apply defaults if unset
      if (tagByThreadEnabled === undefined) {
        tagByThreadEnabled = tagCfg.tagByThreadDefault === true;
      }

      // One-time migration: messageGroupingEnabled -> tagByThreadEnabled
      if (!hasNew && hasLegacy && legacy !== undefined) {
        tagByThreadEnabled = legacy === true;
        await browser.storage.local.set({ tagByThreadEnabled });
        await browser.storage.local.remove(["messageGroupingEnabled"]);
        console.log(
          `[TMDBG Config] Migrated messageGroupingEnabled -> tagByThreadEnabled (${tagByThreadEnabled})`,
        );
      }

      const tagByThreadCheckbox = $("tag-by-thread-enabled");
      if (tagByThreadCheckbox) {
        tagByThreadCheckbox.checked = tagByThreadEnabled === true;
      }
    } catch (e) {
      console.warn(
        "[TMDBG Config] Failed to load tagByThreadEnabled/hideOlderThreadMessagesEnabled",
        e,
      );
    }

    // Load compose hints banner setting (default: enabled)
    const stored = await browser.storage.local.get({
      composeHintsBannerEnabled: true,
      prioritizeTabMailTags: false,
      appearanceCardSnippetsEnabled: false,
    });
    const hintsCheckbox = $("compose-hints-banner");
    if (hintsCheckbox) {
      hintsCheckbox.checked = stored.composeHintsBannerEnabled !== false;
    }

    // Load font size settings from TB prefs
    try {
      if (browser.tmPrefs) {
        // UI font size
        const uiFontSize = await browser.tmPrefs.getInt("mail.uifontsize");
        const uiInput = $("font-size-ui");
        if (uiInput && uiFontSize > 0) {
          uiInput.value = uiFontSize;
        } else if (uiInput) {
          uiInput.value = 13; // default
        }

        // Message (variable) font size - use x-western as primary
        const messageFontSize = await browser.tmPrefs.getInt("font.size.variable.x-western");
        const messageInput = $("font-size-message");
        if (messageInput && messageFontSize > 0) {
          messageInput.value = messageFontSize;
        } else if (messageInput) {
          messageInput.value = 17; // default
        }

        // Monospace font size - use x-western as primary
        const monoFontSize = await browser.tmPrefs.getInt("font.size.monospace.x-western");
        const monoInput = $("font-size-monospace");
        if (monoInput && monoFontSize > 0) {
          monoInput.value = monoFontSize;
        } else if (monoInput) {
          monoInput.value = 16; // default
        }

        console.log(
          `[TMDBG Config] Font sizes loaded from prefs: ui=${uiFontSize}, message=${messageFontSize}, mono=${monoFontSize}`,
        );
      }
    } catch (e) {
      console.warn("[TMDBG Config] Failed to load font size prefs:", e);
    }

    // Load prioritize TabMail tags setting (default: disabled)
    const prioritizeTagsCheckbox = $("prioritize-tabmail-tags");
    if (prioritizeTagsCheckbox) {
      prioritizeTagsCheckbox.checked = stored.prioritizeTabMailTags === true;
    }

    // Load inbox sorting setting from TB prefs (1 = tags, 0 = date)
    // Uses TB pref so the experiment can access it directly
    // NOTE: view mode / inbox sorting / sort order are now controlled by header buttons
    // in the Thunderbird message list header (TB 145 / MV3). Config page is theme-only.
    console.log(
      `[TMDBG Config] Appearance loaded (theme-only UI). composeHints=${stored.composeHintsBannerEnabled}`,
    );
    
    // Update images based on current theme
    await updateThemeSensitiveImages();
  } catch (e) {
    console.warn("[TMDBG Config] loadAppearanceSettings failed", e);
  }
}

export async function saveAppearanceSettings(viewMode, SETTINGS) {
  try {
    if (!browser.tmPrefs) {
      console.warn("[TMDBG Config] tmPrefs not available for saving appearance");
      return;
    }

    const prefs = SETTINGS.appearance.prefs;
    const defaults = SETTINGS.appearance.defaults;

    // Determine settings based on view mode (0 = card, 1 = table)
    const listViewValue = viewMode === "card" ? 0 : 1;

    // Set the view preference
    await browser.tmPrefs.setInt(prefs.listView, listViewValue);
    console.log(`[TMDBG Config] Set listView to ${listViewValue}`);

    // If card view, ensure two-row card mode is set
    if (viewMode === "card") {
      await browser.tmPrefs.setInt(prefs.cardRowCount, defaults.cardRowCount);
      console.log(
        `[TMDBG Config] Set cardRowCount to ${defaults.cardRowCount}`,
      );
    }

    // Always set compact density for both views (0 = compact)
    await browser.tmPrefs.setInt(prefs.density, defaults.density);
    console.log(`[TMDBG Config] Set density to ${defaults.density} (compact)`);

    // Show success status
    const statusEl = $("appearance-status-text");
    if (statusEl) {
      const viewName = viewMode === "card" ? "Relaxed" : "Compact";
      statusEl.textContent = `✓ Applied: ${viewName} view`;

      // Clear status after 3 seconds
      setTimeout(() => {
        statusEl.textContent = "";
      }, 3000);
    }

    console.log(
      `[TMDBG Config] Appearance saved: viewMode=${viewMode}, listView=${listViewValue}`,
    );
  } catch (e) {
    console.warn("[TMDBG Config] saveAppearanceSettings failed", e);
    const statusEl = $("appearance-status-text");
    if (statusEl) {
      statusEl.textContent = "Error applying settings";
      statusEl.style.color = "var(--tag-tm-delete)";
    }
  }
}

export async function saveSortOrderSettings(sortOrderValue, SETTINGS) {
  try {
    if (!browser.tmPrefs) {
      console.warn("[TMDBG Config] tmPrefs not available for saving sort order");
      return;
    }

    const prefs = SETTINGS.appearance.prefs;

    // Set the sort order preference (2 = new message on top, 1 = new message bottom)
    const sortOrderInt = sortOrderValue === "ascending" ? 1 : 2;
    await browser.tmPrefs.setInt(prefs.sortOrder, sortOrderInt);
    console.log(
      `[TMDBG Config] Set sortOrder to ${sortOrderInt} (${sortOrderValue})`,
    );

    // Trigger immediate sort refresh
    if (browser.tagSort && browser.tagSort.refreshImmediate) {
      browser.tagSort.refreshImmediate();
      console.log("[TMDBG Config] Triggered immediate tagSort refresh");
    }

    // Show success status
    const statusEl = $("appearance-status-text");
    if (statusEl) {
      const orderName =
        sortOrderValue === "ascending" ? "Oldest First" : "Newest First";
      statusEl.textContent = `✓ Applied: ${orderName}`;

      // Clear status after 3 seconds
      setTimeout(() => {
        statusEl.textContent = "";
      }, 3000);
    }

    console.log(`[TMDBG Config] Sort order saved: ${sortOrderValue}`);
  } catch (e) {
    console.warn("[TMDBG Config] saveSortOrderSettings failed", e);
    const statusEl = $("appearance-status-text");
    if (statusEl) {
      statusEl.textContent = "Error applying sort order";
      statusEl.style.color = "var(--tag-tm-delete)";
    }
  }
}

export async function handleAppearanceChange(e, SETTINGS) {
  // Debug: log all change events
  console.log(`[TMDBG Config] handleAppearanceChange: target.name="${e.target.name}", target.id="${e.target.id}", target.value="${e.target.value}"`);
  
  // Theme radio buttons
  if (
    e.target.name === "theme" ||
    e.target.id === "theme-light" ||
    e.target.id === "theme-dark" ||
    e.target.id === "theme-system"
  ) {
    const theme = e.target.value;
    console.log(`[TMDBG Config] ═══════════════════════════════════════`);
    console.log(`[TMDBG Config] THEME CHANGE DETECTED!`);
    console.log(`[TMDBG Config] Radio ID: ${e.target.id}, Value: ${theme}`);
    console.log(`[TMDBG Config] ═══════════════════════════════════════`);
    
    console.log(`[TMDBG Config] About to call applyTheme("${theme}")...`);
    let success = false;
    try {
      success = await applyTheme(theme);
      console.log(`[TMDBG Config] applyTheme returned: ${success}`);
    } catch (err) {
      console.error(`[TMDBG Config] applyTheme THREW ERROR:`, err);
    }
    
    // Update images to match the new theme
    console.log(`[TMDBG Config] Updating theme-sensitive images...`);
    try {
      await updateThemeSensitiveImages();
      console.log(`[TMDBG Config] Theme-sensitive images updated`);
    } catch (err) {
      console.error(`[TMDBG Config] updateThemeSensitiveImages THREW ERROR:`, err);
    }
    
    // UI feedback
    const statusEl = $("appearance-status-text");
    if (statusEl) {
      if (success) {
        const themeName = theme.charAt(0).toUpperCase() + theme.slice(1);
        statusEl.textContent = `✓ Applied: ${themeName} theme`;
      } else {
        statusEl.textContent = "Error applying theme";
        statusEl.style.color = "var(--tag-tm-delete)";
      }
      setTimeout(() => {
        statusEl.textContent = "";
      }, 3000);
    }
  }

  // Compose hints banner checkbox
  if (e.target.id === "compose-hints-banner") {
    const enabled = e.target.checked;
    await browser.storage.local.set({ composeHintsBannerEnabled: enabled });
    console.log(
      `[TMDBG Config] Compose hints banner ${enabled ? "enabled" : "disabled"}`,
    );

    // Show feedback
    const statusEl = $("appearance-status-text");
    if (statusEl) {
      statusEl.textContent = `✓ Keyboard hints ${enabled ? "enabled" : "disabled"}`;
      setTimeout(() => {
        statusEl.textContent = "";
      }, 3000);
    }
  }

  // Tag by thread checkbox (effective tag by thread)
  if (e.target.id === "tag-by-thread-enabled") {
    const enabled = e.target.checked === true;
    await browser.storage.local.set({ tagByThreadEnabled: enabled });
    console.log(
      `[TMDBG Config] Tag by thread ${enabled ? "enabled" : "disabled"} (tagByThreadEnabled=${enabled})`,
    );

    // UI feedback
    const statusEl = $("appearance-status-text");
    if (statusEl) {
      statusEl.textContent = `✓ Tag by thread ${enabled ? "enabled" : "disabled"}`;
      setTimeout(() => {
        statusEl.textContent = "";
      }, 3000);
    }
  }

  // Prioritize TabMail tags checkbox
  if (e.target.id === "prioritize-tabmail-tags") {
    const enabled = e.target.checked === true;
    await browser.storage.local.set({ prioritizeTabMailTags: enabled });
    console.log(
      `[TMDBG Config] Prioritize TabMail tags ${enabled ? "enabled" : "disabled"}`,
    );

    // Notify theme system to refresh with new flag
    try {
      await browser.runtime.sendMessage({
        command: "prioritize-tabmail-tags-changed",
        enabled: enabled,
      });
    } catch (err) {
      console.log("[TMDBG Config] Failed to notify theme system:", err);
    }

    // UI feedback
    const statusEl = $("appearance-status-text");
    if (statusEl) {
      statusEl.textContent = `✓ TabMail tag priority ${enabled ? "enabled" : "disabled"}`;
      setTimeout(() => {
        statusEl.textContent = "";
      }, 3000);
    }
  }

  // Font size: GUI (mail.uifontsize)
  if (e.target.id === "font-size-ui") {
    const fontSize = parseInt(e.target.value, 10);
    if (browser.tmPrefs && fontSize >= 9 && fontSize <= 24) {
      try {
        await browser.tmPrefs.setInt("mail.uifontsize", fontSize);
        console.log(`[TMDBG Config] GUI font size set to: ${fontSize}`);

        // UI feedback
        const statusEl = $("appearance-status-text");
        if (statusEl) {
          statusEl.textContent = `✓ GUI font size: ${fontSize}px`;
          setTimeout(() => {
            statusEl.textContent = "";
          }, 3000);
        }
      } catch (err) {
        console.error("[TMDBG Config] Failed to set GUI font size:", err);
      }
    }
  }

  // Font size: Message (font.size.variable.x-western and x-unicode)
  if (e.target.id === "font-size-message") {
    const fontSize = parseInt(e.target.value, 10);
    if (browser.tmPrefs && fontSize >= 10 && fontSize <= 28) {
      try {
        await browser.tmPrefs.setInt("font.size.variable.x-western", fontSize);
        await browser.tmPrefs.setInt("font.size.variable.x-unicode", fontSize);
        console.log(`[TMDBG Config] Message font size set to: ${fontSize}`);

        // UI feedback
        const statusEl = $("appearance-status-text");
        if (statusEl) {
          statusEl.textContent = `✓ Message font size: ${fontSize}px`;
          setTimeout(() => {
            statusEl.textContent = "";
          }, 3000);
        }
      } catch (err) {
        console.error("[TMDBG Config] Failed to set message font size:", err);
      }
    }
  }

  // Font size: Monospace (font.size.monospace.x-western and x-unicode)
  if (e.target.id === "font-size-monospace") {
    const fontSize = parseInt(e.target.value, 10);
    if (browser.tmPrefs && fontSize >= 10 && fontSize <= 28) {
      try {
        await browser.tmPrefs.setInt("font.size.monospace.x-western", fontSize);
        await browser.tmPrefs.setInt("font.size.monospace.x-unicode", fontSize);
        console.log(`[TMDBG Config] Monospace font size set to: ${fontSize}`);

        // UI feedback
        const statusEl = $("appearance-status-text");
        if (statusEl) {
          statusEl.textContent = `✓ Monospace font size: ${fontSize}px`;
          setTimeout(() => {
            statusEl.textContent = "";
          }, 3000);
        }
      } catch (err) {
        console.error("[TMDBG Config] Failed to set monospace font size:", err);
      }
    }
  }

}

