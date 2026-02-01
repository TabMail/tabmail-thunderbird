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

// KB Config defaults
const KB_CONFIG_DEFAULTS = {
    max_chat_exchanges: 100,
    reminder_retention_days: 14,
    max_bullets: 200,
};

/**
 * Load KB config from storage and sync UI sliders
 */
export async function loadKbConfig() {
    try {
        const key = "user_prompts:kb_config";
        const obj = await browser.storage.local.get(key);
        const config = obj[key] || {};

        const maxExchanges = config.max_chat_exchanges ?? KB_CONFIG_DEFAULTS.max_chat_exchanges;
        const retention = config.reminder_retention_days || KB_CONFIG_DEFAULTS.reminder_retention_days;
        const maxBullets = config.max_bullets || KB_CONFIG_DEFAULTS.max_bullets;

        // Update slider values + displayed numbers
        const setSlider = (sliderId, valId, value) => {
            const slider = document.getElementById(sliderId);
            const display = document.getElementById(valId);
            if (slider) slider.value = value;
            if (display) display.textContent = String(value);
        };
        setSlider("kb-max-exchanges", "kb-max-exchanges-val", maxExchanges);
        setSlider("kb-reminder-retention", "kb-reminder-retention-val", retention);
        setSlider("kb-max-bullets", "kb-max-bullets-val", maxBullets);

        log(`[Prompts] KB config loaded: maxExchanges=${maxExchanges}, retention=${retention}d, max_bullets=${maxBullets}`);
    } catch (e) {
        log(`[Prompts] Failed to load KB config: ${e}`, "error");
    }
}

/**
 * Save KB config to storage from current slider values
 */
export async function saveKbConfig() {
    try {
        const maxExchangesSlider = document.getElementById("kb-max-exchanges");
        const reminderSlider = document.getElementById("kb-reminder-retention");
        const maxBulletsSlider = document.getElementById("kb-max-bullets");

        const config = {
            max_chat_exchanges: parseInt(maxExchangesSlider?.value, 10) || KB_CONFIG_DEFAULTS.max_chat_exchanges,
            reminder_retention_days: parseInt(reminderSlider?.value, 10) || KB_CONFIG_DEFAULTS.reminder_retention_days,
            max_bullets: parseInt(maxBulletsSlider?.value, 10) || KB_CONFIG_DEFAULTS.max_bullets,
        };

        const key = "user_prompts:kb_config";
        await browser.storage.local.set({ [key]: config });

        log(`[Prompts] KB config saved: maxExchanges=${config.max_chat_exchanges}, retention=${config.reminder_retention_days}d, max_bullets=${config.max_bullets}`);
    } catch (e) {
        log(`[Prompts] Failed to save KB config: ${e}`, "error");
        throw e;
    }
}
