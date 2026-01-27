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
    recent_chats_as_context: 10,
    reminder_retention_days: 14,
    max_bullets: 200,
};

/**
 * Load KB config from storage
 */
export async function loadKbConfig() {
    try {
        const key = "user_prompts:kb_config";
        const obj = await browser.storage.local.get(key);
        const config = obj[key] || KB_CONFIG_DEFAULTS;
        
        // Update UI
        const recentChatsInput = document.getElementById("kb-recent-chats");
        const reminderInput = document.getElementById("kb-reminder-retention");
        const maxBulletsInput = document.getElementById("kb-max-bullets");
        
        if (recentChatsInput) {
            recentChatsInput.value = config.recent_chats_as_context ?? KB_CONFIG_DEFAULTS.recent_chats_as_context;
        }
        if (reminderInput) {
            reminderInput.value = config.reminder_retention_days || KB_CONFIG_DEFAULTS.reminder_retention_days;
        }
        if (maxBulletsInput) {
            maxBulletsInput.value = config.max_bullets || KB_CONFIG_DEFAULTS.max_bullets;
        }
        
        log(`[Prompts] KB config loaded: recentChats=${config.recent_chats_as_context}, retention=${config.reminder_retention_days}d, max_bullets=${config.max_bullets}`);
    } catch (e) {
        log(`[Prompts] Failed to load KB config: ${e}`, "error");
    }
}

/**
 * Save KB config to storage
 */
export async function saveKbConfig() {
    try {
        const recentChatsInput = document.getElementById("kb-recent-chats");
        const reminderInput = document.getElementById("kb-reminder-retention");
        const maxBulletsInput = document.getElementById("kb-max-bullets");
        
        const config = {
            recent_chats_as_context: parseInt(recentChatsInput?.value, 10) ?? KB_CONFIG_DEFAULTS.recent_chats_as_context,
            reminder_retention_days: parseInt(reminderInput?.value, 10) || KB_CONFIG_DEFAULTS.reminder_retention_days,
            max_bullets: parseInt(maxBulletsInput?.value, 10) || KB_CONFIG_DEFAULTS.max_bullets,
        };
        
        const key = "user_prompts:kb_config";
        await browser.storage.local.set({ [key]: config });
        
        log(`[Prompts] KB config saved: recentChats=${config.recent_chats_as_context}, retention=${config.reminder_retention_days}d, max_bullets=${config.max_bullets}`);
    } catch (e) {
        log(`[Prompts] Failed to save KB config: ${e}`, "error");
        throw e;
    }
}
