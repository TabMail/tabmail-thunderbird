/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// memorySizeLimit.js – The chat memory size limit setting (Chat History tab).
// The native helper removes the oldest memory entries to stay within it.

import { SETTINGS } from "../agent/modules/config.js";

export const MEMORY_SIZE_LIMIT_KEY = "memorySizeLimitBytes";

function choices() {
  return SETTINGS.memoryManagement.memorySizeLimitChoicesBytes;
}

/** The stored limit in bytes, or the default when unset or not an offered choice. */
export async function getMemorySizeLimitBytes() {
  const fallback = SETTINGS.memoryManagement.memorySizeLimitDefaultBytes;
  const stored = await browser.storage.local.get({ [MEMORY_SIZE_LIMIT_KEY]: fallback });
  const value = stored[MEMORY_SIZE_LIMIT_KEY];
  return choices().includes(value) ? value : fallback;
}

/** Stores one of the offered limits; throws for any other value. */
export async function setMemorySizeLimitBytes(bytes) {
  if (!choices().includes(bytes)) {
    throw new Error(`Unsupported memory size limit: ${bytes}`);
  }
  await browser.storage.local.set({ [MEMORY_SIZE_LIMIT_KEY]: bytes });
}

/** "512 KB", "12.3 MB", "1 GB" (1024-based, as the limit choices are). */
export function formatBytes(bytes) {
  const units = ["KB", "MB", "GB"];
  let value = Math.max(0, Number(bytes) || 0) / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  const rounded = value >= 100 || Number.isInteger(value) ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unit]}`;
}
