/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storage and file operations for prompts
 */

import { readActionConfig, ACTION_CONFIG_KEY } from "../../agent/modules/actionCompactConfig.js";
import { SETTINGS } from "../../agent/modules/config.js";
import { defaultTexts, holdsSectionMarker, SECTION_MARKER_REFUSAL, withPromptStore } from "../../agent/modules/promptStore.js";
import { addItems, replaceItems } from "./markdown.js";
import { log } from "../../agent/modules/utils.js";

/**
 * One action on what the page shows of `field` (DS-DISPLAYED): `change(content)` applied to `view.content`,
 * the text shown, and the result saved against `view.captured`, the labels shown with it, in one hold of
 * the prompt semaphore. The text is never read again: only shown labels whose text the action removed are
 * deleted, and a bullet that arrived since is kept. `change` returns null when what the user acted on is
 * not in the text. Resolves "saved", "unchanged" (nothing left to change: what it removes was already
 * removed) or "gone"; rejects when it could not be saved.
 */
export function editShown(field, view, change) {
    if (view.captured === null) return Promise.reject(new Error(`${field} could not be saved`));
    const next = change(view.content);
    if (next === null) return Promise.resolve("gone");
    if (next === view.content) return Promise.resolve("unchanged");
    return saveShown(field, view, async () => next, "prompts page edit");
}

/** `editShown`'s save, in one hold: `next()` gives the text to save, or null ("gone") or the shown text
 * ("unchanged") to save nothing. */
function saveShown(field, view, next, label) {
    const result = withPromptStore(async (store) => {
        const text = await next();
        if (text === null) return "gone";
        if (text === view.content) return "unchanged";
        return (await store.write(field, view.captured, text)).outcome;
    }, { label });
    result.catch((e) => log(`[Prompts] Edit of ${field} failed: ${e}`, "error"));
    return result;
}

/**
 * The user's line `text` added as the last item of the section `where` ({ key, copy }) of `view`, what the
 * page shows of `field`. For the writing style and the action rules, a line holding a section marker is
 * refused (R23): written into the field, it would be read back as a header or the footer. Resolves as
 * `editShown` does.
 */
export function addLine(field, view, where, text) {
    if (holdsSectionMarker(field, [text])) return Promise.reject(new Error(SECTION_MARKER_REFUSAL));
    return editShown(field, view, (content) => addItems(field, content, where, [text]));
}

/**
 * Section Reset: the items of the copy `where` of the section shown in `view` replaced by that section's
 * defaults, in one edit against the labels shown. The defaults are read inside the hold, so the Reset takes
 * its place in line when the user clicks, before any later action (DS-SEMAPHORE request order). Resolves as
 * `editShown` does.
 */
export function resetSection(field, view, where) {
    if (view.captured === null) return Promise.reject(new Error(`${field} could not be saved`));
    return saveShown(field, view, async () => replaceItems(field, view.content, where, await defaultTexts(field, where.key)), "prompts page section reset");
}

/** Reset Entire Prompt and the knowledge base's Reset: DS-RESET of `field`. */
export function resetWholeField(field) {
    return withPromptStore((store) => store.reset([field]), { label: "prompts page reset" });
}

/**
 * Load action config from storage and sync UI sliders
 */
export async function loadActionConfig() {
    try {
        const { compact_threshold: threshold, compact_threshold_chars: thresholdChars } = await readActionConfig();
        const c = SETTINGS.actionCompaction;

        // Update slider range, value + displayed number (range before value so it isn't clamped to the HTML range)
        const slider = document.getElementById("action-compact-threshold");
        const display = document.getElementById("action-compact-threshold-val");
        if (slider) Object.assign(slider, { min: c.minRules, max: c.maxRules, step: c.stepRules, value: threshold });
        if (display) display.textContent = String(threshold);

        const sliderChars = document.getElementById("action-compact-threshold-chars");
        const displayChars = document.getElementById("action-compact-threshold-chars-val");
        if (sliderChars) Object.assign(sliderChars, { min: c.minChars, max: c.maxChars, step: c.stepChars, value: thresholdChars });
        if (displayChars) displayChars.textContent = String(thresholdChars);

        log(`[Prompts] Action config loaded: compact_threshold=${threshold}, compact_threshold_chars=${thresholdChars}`);
    } catch (e) {
        log(`[Prompts] Failed to load action config: ${e}`, "error");
    }
}

/**
 * Save action config to storage from current slider values
 */
export async function saveActionConfig() {
    try {
        const thresholdSlider = document.getElementById("action-compact-threshold");
        const thresholdCharsSlider = document.getElementById("action-compact-threshold-chars");

        const config = {
            compact_threshold: parseInt(thresholdSlider?.value, 10) || SETTINGS.actionCompaction.defaultRules,
            compact_threshold_chars: parseInt(thresholdCharsSlider?.value, 10) || SETTINGS.actionCompaction.defaultChars,
        };

        await browser.storage.local.set({ [ACTION_CONFIG_KEY]: config });

        log(`[Prompts] Action config saved: compact_threshold=${config.compact_threshold}, compact_threshold_chars=${config.compact_threshold_chars}`);
    } catch (e) {
        log(`[Prompts] Failed to save action config: ${e}`, "error");
        throw e;
    }
}

// KB Config defaults
const KB_CONFIG_DEFAULTS = {
    reminder_retention_days: 14,
    max_bullets: 100,
};

/**
 * Load KB config from storage and sync UI sliders
 */
export async function loadKbConfig() {
    try {
        const key = "user_prompts:kb_config";
        const obj = await browser.storage.local.get(key);
        const config = obj[key] || {};

        const retention = config.reminder_retention_days || KB_CONFIG_DEFAULTS.reminder_retention_days;
        const maxBullets = config.max_bullets || KB_CONFIG_DEFAULTS.max_bullets;

        // Update slider values + displayed numbers
        const setSlider = (sliderId, valId, value) => {
            const slider = document.getElementById(sliderId);
            const display = document.getElementById(valId);
            if (slider) slider.value = value;
            if (display) display.textContent = String(value);
        };
        setSlider("kb-reminder-retention", "kb-reminder-retention-val", retention);
        setSlider("kb-max-bullets", "kb-max-bullets-val", maxBullets);

        log(`[Prompts] KB config loaded: retention=${retention}d, max_bullets=${maxBullets}`);
    } catch (e) {
        log(`[Prompts] Failed to load KB config: ${e}`, "error");
    }
}

/**
 * Save KB config to storage from current slider values
 */
export async function saveKbConfig() {
    try {
        const reminderSlider = document.getElementById("kb-reminder-retention");
        const maxBulletsSlider = document.getElementById("kb-max-bullets");

        const config = {
            reminder_retention_days: parseInt(reminderSlider?.value, 10) || KB_CONFIG_DEFAULTS.reminder_retention_days,
            max_bullets: parseInt(maxBulletsSlider?.value, 10) || KB_CONFIG_DEFAULTS.max_bullets,
        };

        const key = "user_prompts:kb_config";
        await browser.storage.local.set({ [key]: config });

        log(`[Prompts] KB config saved: retention=${config.reminder_retention_days}d, max_bullets=${config.max_bullets}`);
    } catch (e) {
        log(`[Prompts] Failed to save KB config: ${e}`, "error");
        throw e;
    }
}
