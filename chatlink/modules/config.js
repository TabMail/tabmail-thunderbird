/**
 * ChatLink Configuration
 *
 * Centralized config for ChatLink worker URL and settings.
 * URL switches between dev/prod based on debugMode setting.
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { SETTINGS } from "../../agent/modules/config.js";

/**
 * Get the ChatLink worker URL based on debugMode setting.
 *   - Production: https://chatlink.tabmail.ai
 *   - Dev: https://chatlink-dev.tabmail.ai
 *
 * @returns {Promise<string>} The ChatLink worker URL
 */
export async function getChatLinkUrl() {
  try {
    const stored = await browser.storage.local.get({ debugMode: false });
    SETTINGS.debugMode = stored.debugMode; // Keep local state in sync

    const domain = SETTINGS.backendDomain;
    const subdomain = stored.debugMode ? "chatlink-dev" : "chatlink";
    const chatLinkUrl = `https://${subdomain}.${domain}`;

    console.log(`[ChatLink Config] getChatLinkUrl: url=${chatLinkUrl}`);
    return chatLinkUrl;
  } catch (e) {
    console.warn("[ChatLink Config] Failed to load debugMode from storage, using default:", e);
    const domain = SETTINGS.backendDomain;
    return `https://chatlink.${domain}`;
  }
}
