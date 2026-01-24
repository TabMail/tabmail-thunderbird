/**
 * Thunderbird *native* theme switching (TB 145 / MV3).
 *
 * Key insight:
 * - The actual UI theme is controlled by the enabled "Theme" add-on.
 * - `extensions.activeThemeID` reflects the active theme.
 * - Setting `ui.systemUsesDarkTheme` only influences the "auto/system/default" theme,
 *   and will not override an explicitly enabled Light/Dark theme add-on.
 *
 * We therefore switch the active theme add-on via `browser.management.setEnabled`.
 */

function _safeString(x) {
    try { return String(x); } catch (_) { return ""; }
}

async function logInstalledThemes(contextLabel) {
    try {
        if (!browser.management?.getAll) {
            console.log(`[TabMail Theme] (${contextLabel}) browser.management.getAll not available`);
            return [];
        }
        const all = await browser.management.getAll();
        const themes = all.filter((a) => a && a.type === "theme");
        console.log(`[TabMail Theme] (${contextLabel}) Installed themes (${themes.length}):`);
        for (const t of themes) {
            console.log(
                `[TabMail Theme] (${contextLabel}) theme id="${t.id}" enabled=${!!t.enabled} name="${_safeString(t.name)}"`
            );
        }
        return themes;
    } catch (e) {
        console.log(`[TabMail Theme] (${contextLabel}) Failed to list installed themes: ${e}`);
        return [];
    }
}

async function setThemeEnabled(themeId, enabled, contextLabel) {
    try {
        if (!themeId) return { ok: false, error: "missing themeId" };
        if (!browser.management?.setEnabled) {
            return { ok: false, error: "browser.management.setEnabled not available" };
        }
        await browser.management.setEnabled(themeId, !!enabled);
        console.log(`[TabMail Theme] (${contextLabel}) setEnabled("${themeId}", ${!!enabled}) ok`);
        return { ok: true };
    } catch (e) {
        console.log(`[TabMail Theme] (${contextLabel}) setEnabled("${themeId}", ${!!enabled}) failed: ${e}`);
        return { ok: false, error: String(e) };
    }
}

/**
 * Validate configured built-in theme IDs exist (diagnostics only).
 * No fallbacks/heuristics: if IDs are wrong, we log installed theme IDs so we can update config.
 */
export async function validateThunderbirdThemeIds(SETTINGS) {
    const contextLabel = "nativeTheme:validate";
    console.log("[TabMail Theme] ═══ validateThunderbirdThemeIds() ═══");

    const ids = SETTINGS?.appearance?.thunderbirdThemes?.ids;
    if (!ids?.default || !ids?.light || !ids?.dark) {
        console.log(`[TabMail Theme] (${contextLabel}) Missing SETTINGS.appearance.thunderbirdThemes.ids`);
        await logInstalledThemes(contextLabel);
        return { ok: false, error: "missing thunderbirdThemes.ids" };
    }

    const themes = await logInstalledThemes(contextLabel);
    const installedIds = new Set(themes.map((t) => t?.id).filter(Boolean));
    const missing = [];
    for (const [k, v] of Object.entries(ids)) {
        if (!installedIds.has(v)) missing.push(`${k}="${v}"`);
    }

    if (missing.length > 0) {
        console.log(`[TabMail Theme] (${contextLabel}) ⚠️ Missing configured theme IDs: ${missing.join(", ")}`);
        return { ok: false, error: "configured theme IDs missing", missing };
    }

    console.log(`[TabMail Theme] (${contextLabel}) ✓ Configured theme IDs are present`);
    return { ok: true };
}

/**
 * Apply TabMail theme preference to *Thunderbird's native theme*.
 *
 * - "system": enable default theme; disable light/dark; clear ui.systemUsesDarkTheme override.
 * - "light": enable light theme; disable default/dark; clear ui.systemUsesDarkTheme override.
 * - "dark": enable dark theme; disable default/light; clear ui.systemUsesDarkTheme override.
 *
 * No fallbacks/heuristics: relies on stable built-in theme IDs in SETTINGS.
 */
export async function applyThunderbirdNativeThemePreference(theme, SETTINGS) {
    const contextLabel = `nativeTheme:${theme}`;
    console.log(`[TabMail Theme] ═══ applyThunderbirdNativeThemePreference("${theme}") ═══`);

    if (!browser.tmPrefs) {
        console.log(`[TabMail Theme] (${contextLabel}) tmPrefs not available`);
        return { ok: false, error: "tmPrefs not available" };
    }

    const ids = SETTINGS?.appearance?.thunderbirdThemes?.ids;
    const prefs = SETTINGS?.appearance?.thunderbirdThemes?.prefs;
    if (!ids?.default || !ids?.light || !ids?.dark || !prefs?.activeThemeId || !prefs?.systemUsesDarkTheme) {
        console.log(`[TabMail Theme] (${contextLabel}) Missing SETTINGS.appearance.thunderbirdThemes config`);
        return { ok: false, error: "missing thunderbirdThemes config" };
    }

    // Pre-state logs (diagnostic)
    try {
        const activeBefore = await browser.tmPrefs.getStringSafe(prefs.activeThemeId, "");
        const overrideBefore = await browser.tmPrefs.getInt(prefs.systemUsesDarkTheme);
        console.log(`[TabMail Theme] (${contextLabel}) BEFORE activeThemeID="${activeBefore}" ui.systemUsesDarkTheme=${overrideBefore}`);
    } catch (e) {
        console.log(`[TabMail Theme] (${contextLabel}) Failed to read theme prefs (before): ${e}`);
    }

    await logInstalledThemes(`${contextLabel}:before`);

    // Enforce: always use Thunderbird's Default/System theme add-on.
    // Then drive light/dark via ui.systemUsesDarkTheme (set/clear).
    await setThemeEnabled(ids.light, false, contextLabel);
    await setThemeEnabled(ids.dark, false, contextLabel);
    await setThemeEnabled(ids.default, true, contextLabel);

    if (theme === "system") {
        try {
            await browser.tmPrefs.clearUserPref(prefs.systemUsesDarkTheme);
            console.log(`[TabMail Theme] (${contextLabel}) Cleared ${prefs.systemUsesDarkTheme} override (follow system)`);
        } catch (e) {
            console.log(`[TabMail Theme] (${contextLabel}) clearUserPref(${prefs.systemUsesDarkTheme}) failed (may not exist): ${e}`);
        }
    } else if (theme === "light") {
        try {
            await browser.tmPrefs.setInt(prefs.systemUsesDarkTheme, 0);
            console.log(`[TabMail Theme] (${contextLabel}) Set ${prefs.systemUsesDarkTheme}=0 (force light)`);
        } catch (e) {
            console.log(`[TabMail Theme] (${contextLabel}) setInt(${prefs.systemUsesDarkTheme},0) failed: ${e}`);
            return { ok: false, error: "failed to set light override" };
        }
    } else if (theme === "dark") {
        try {
            await browser.tmPrefs.setInt(prefs.systemUsesDarkTheme, 1);
            console.log(`[TabMail Theme] (${contextLabel}) Set ${prefs.systemUsesDarkTheme}=1 (force dark)`);
        } catch (e) {
            console.log(`[TabMail Theme] (${contextLabel}) setInt(${prefs.systemUsesDarkTheme},1) failed: ${e}`);
            return { ok: false, error: "failed to set dark override" };
        }
    } else {
        console.log(`[TabMail Theme] (${contextLabel}) Unknown theme value: "${theme}"`);
        return { ok: false, error: "unknown theme value" };
    }

    // Post-state logs (diagnostic)
    await logInstalledThemes(`${contextLabel}:after`);
    try {
        const activeAfter = await browser.tmPrefs.getStringSafe(prefs.activeThemeId, "");
        const overrideAfter = await browser.tmPrefs.getInt(prefs.systemUsesDarkTheme);
        console.log(`[TabMail Theme] (${contextLabel}) AFTER activeThemeID="${activeAfter}" ui.systemUsesDarkTheme=${overrideAfter}`);
    } catch (e) {
        console.log(`[TabMail Theme] (${contextLabel}) Failed to read theme prefs (after): ${e}`);
    }

    return { ok: true };
}

