/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storage and file operations for prompts
 */

import { log } from "../../agent/modules/utils.js";

/**
 * Load prompt file from storage
 */
export async function loadPromptFile(filename) {
    try {
        const response = await browser.runtime.sendMessage({
            command: "read-prompt-file",
            filename,
        });
        
        if (!response || response.error || !response.ok) {
            throw new Error(response?.error || "Failed to load prompt file");
        }
        
        return response.content;
    } catch (e) {
        log(`[Prompts] Failed to load ${filename}: ${e}`, "error");
        throw e;
    }
}

/**
 * Save prompt file to storage
 */
export async function savePromptFile(filename, content) {
    try {
        const response = await browser.runtime.sendMessage({
            command: "write-prompt-file",
            filename,
            content,
        });
        
        if (!response || response.error || !response.ok) {
            throw new Error(response?.error || "Failed to save prompt file");
        }
        
        return true;
    } catch (e) {
        log(`[Prompts] Failed to save ${filename}: ${e}`, "error");
        throw e;
    }
}

/**
 * Reset prompt file to default
 */
export async function resetPromptFile(filename) {
    try {
        const response = await browser.runtime.sendMessage({
            command: "reset-prompt-file",
            filename,
        });
        
        if (!response || response.error || !response.ok) {
            throw new Error(response?.error || "Failed to reset prompt file");
        }
        
        return true;
    } catch (e) {
        log(`[Prompts] Failed to reset ${filename}: ${e}`, "error");
        throw e;
    }
}

// Action Config defaults
const ACTION_CONFIG_DEFAULTS = {
    compact_threshold: 100,
    compact_threshold_chars: 16000,
};

/**
 * Load action config from storage and sync UI sliders
 */
export async function loadActionConfig() {
    try {
        const key = "user_prompts:action_config";
        const obj = await browser.storage.local.get(key);
        const config = obj[key] || {};

        const threshold = config.compact_threshold || ACTION_CONFIG_DEFAULTS.compact_threshold;
        const thresholdChars = config.compact_threshold_chars || ACTION_CONFIG_DEFAULTS.compact_threshold_chars;

        // Update slider values + displayed numbers
        const slider = document.getElementById("action-compact-threshold");
        const display = document.getElementById("action-compact-threshold-val");
        if (slider) slider.value = threshold;
        if (display) display.textContent = String(threshold);

        const sliderChars = document.getElementById("action-compact-threshold-chars");
        const displayChars = document.getElementById("action-compact-threshold-chars-val");
        if (sliderChars) sliderChars.value = thresholdChars;
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
            compact_threshold: parseInt(thresholdSlider?.value, 10) || ACTION_CONFIG_DEFAULTS.compact_threshold,
            compact_threshold_chars: parseInt(thresholdCharsSlider?.value, 10) || ACTION_CONFIG_DEFAULTS.compact_threshold_chars,
        };

        const key = "user_prompts:action_config";
        await browser.storage.local.set({ [key]: config });

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
