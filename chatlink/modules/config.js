/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
