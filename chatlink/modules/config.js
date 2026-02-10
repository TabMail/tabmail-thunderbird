/**
 * ChatLink Configuration
 *
 * Centralized config for ChatLink worker URL and settings.
 * Always uses production URL since WhatsApp webhook can only point to one endpoint.
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { SETTINGS } from "../../agent/modules/config.js";

/**
 * Get the ChatLink worker URL.
 * Always returns production URL since Meta's WhatsApp webhook
 * can only be configured to point to a single endpoint.
 *
 * @returns {Promise<string>} The ChatLink worker URL (always prod)
 */
export async function getChatLinkUrl() {
  const domain = SETTINGS.backendDomain;
  return `https://chatlink.${domain}`;
}
