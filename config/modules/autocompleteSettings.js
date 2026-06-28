/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// autocompleteSettings.js — Settings → Autocomplete section.
// Controls the master on/off (`autocompleteEnabled`) and the suggestion idle
// delay (`AUTOCOMPLETE_IDLE_MS`). Both live in browser.storage.local; the
// compose content script reads them and live-updates via storage.onChanged.

import { $ } from "./dom.js";

// Mirrors compose/modules/config.js → autocompleteDelay.INITIAL_IDLE_MS. Kept
// as a named constant (not a magic number) so the page can show a sensible
// default before the user has customized it. Min/Max mirror the <input> range
// in config.html (#autocomplete-delay).
const DEFAULT_AUTOCOMPLETE_IDLE_MS = 250;
const MIN_AUTOCOMPLETE_IDLE_MS = 0;
const MAX_AUTOCOMPLETE_IDLE_MS = 3000;

function flashStatus(msg) {
  const statusEl = $("autocomplete-status-text");
  if (!statusEl) return;
  statusEl.textContent = msg;
  setTimeout(() => {
    statusEl.textContent = "";
  }, 3000);
}

export async function loadAutocompleteSettings() {
  try {
    const stored = await browser.storage.local.get({
      autocompleteEnabled: true,
      AUTOCOMPLETE_IDLE_MS: null,
    });

    const enabledCheckbox = $("autocomplete-enabled");
    if (enabledCheckbox) {
      enabledCheckbox.checked = stored.autocompleteEnabled !== false;
    }

    const delayInput = $("autocomplete-delay");
    if (delayInput) {
      const v = parseInt(stored.AUTOCOMPLETE_IDLE_MS, 10);
      delayInput.value = isNaN(v) ? DEFAULT_AUTOCOMPLETE_IDLE_MS : v;
    }
  } catch (e) {
    console.warn("[TMDBG Config] loadAutocompleteSettings failed", e);
  }
}

export async function handleAutocompleteSettingsChange(e) {
  if (e.target.id === "autocomplete-enabled") {
    const enabled = e.target.checked === true;
    await browser.storage.local.set({ autocompleteEnabled: enabled });
    console.log(
      `[TMDBG Config] Autocomplete ${enabled ? "enabled" : "disabled"}`,
    );
    flashStatus(`✓ Autocomplete ${enabled ? "enabled" : "disabled"}`);
  }

  if (e.target.id === "autocomplete-delay") {
    let v = parseInt(e.target.value, 10);
    if (isNaN(v)) return;
    // Clamp to the documented range, then reflect the clamped value back.
    v = Math.max(MIN_AUTOCOMPLETE_IDLE_MS, Math.min(MAX_AUTOCOMPLETE_IDLE_MS, v));
    e.target.value = v;
    await browser.storage.local.set({ AUTOCOMPLETE_IDLE_MS: v });
    console.log(`[TMDBG Config] Autocomplete suggestion delay -> ${v}ms`);
    flashStatus(`✓ Suggestion delay set to ${v} ms`);
  }
}
