/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { $ } from "./dom.js";
import { getBackendUrl } from "../../agent/modules/config.js";
import { getAccessToken } from "../../agent/modules/supabaseAuth.js";
import {
  TIERS,
  getTierProvider,
  setTierProvider,
  getTierModel,
  setTierModel,
  getProviderKey,
  setProviderKey,
  clearProviderKey,
  isModelAvailable,
} from "../../agent/modules/byokStorage.js";
import { runProviderSmoke } from "./byokSmoke.js";

/**
 * BYOK (Bring-Your-Own-Key) Settings Module — Thunderbird.
 *
 * Lets a user route their AI traffic to their own OpenAI / Anthropic / Google
 * (Gemini) key. Mirrors the iOS implementation 1:1 (see PLAN_BYOK_SUPPORT.md
 * §6.1, revised 2026-05-26):
 *
 *  - TWO configurable tiers only: "Light" (wire id `background`) and "Heavy"
 *    (wire id `interactive`). Autocomplete is FIXED to TabMail (latency-critical)
 *    and is never offered for BYOK — the payload never carries an autocomplete tier.
 *  - The key is stored per-provider (shared across tiers), the provider + model
 *    are stored per-tier. All in `browser.storage.local` (same trust tier as the
 *    OAuth refresh tokens already there). NEVER written to `storage.sync`.
 *  - `provider === 'tabmail'` is the off-state for a tier (no master toggle).
 *
 * The backend resolves which tier applies to a given request from the system
 * prompt (§5), so we just send every configured non-TabMail tier and let it pick.
 */

export const PROVIDERS = ["openai", "anthropic", "google"];

export const PROVIDER_LABELS = {
  tabmail: "TabMail",
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
};

// Verified key-provisioning consoles (PLAN §2 / iOS BYOKProviderInfo.keyURL).
export const PROVIDER_KEY_URLS = {
  openai: "https://platform.openai.com/api-keys",
  anthropic: "https://console.anthropic.com/settings/keys",
  google: "https://aistudio.google.com/app/apikey",
};

// ZDR disclaimers — copied verbatim from iOS BYOKProviderInfo.zdrDisclaimer.
export const PROVIDER_ZDR = {
  openai:
    "Your key and prompts go directly to OpenAI. By default OpenAI doesn't train on API data but keeps 30-day abuse-monitoring logs. True zero retention requires an enterprise agreement.",
  anthropic:
    "Your key and prompts go directly to Anthropic. API traffic is not used for training. Logs are retained ~30 days.",
  google:
    "Your key and prompts go directly to Google. Only the paid Gemini API tier guarantees no training — free-tier keys may be used to improve Google's models.",
};

// Shown whenever any tier uses a non-TabMail provider (matches iOS cost footer).
export const COST_WARNING =
  "Choosing a provider other than TabMail sends requests directly to that provider on your own API key and can incur significant API costs. We strongly recommend TabMail's built-in models unless you have a special pricing agreement with the provider.";

// ---------------------------------------------------------------------------
// Backend model endpoints (no backend changes — same routes iOS uses)
// ---------------------------------------------------------------------------

/** GET /byok/models — the 3-level catalog (provider → tier → [model]). */
export async function fetchByokCatalog() {
  const base = await getBackendUrl();
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${base}/byok/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`/byok/models HTTP ${res.status}`);
  return res.json();
}

/**
 * POST /byok/list-models — the model IDs the user's key can actually access.
 * Used by the connectivity test to surface "not in your account" precisely.
 * @returns {Promise<{ok: boolean, models?: string[], error_code?: string, error_detail?: string, retry_after_seconds?: number}>}
 */
export async function listByokModels(provider, apiKey) {
  const base = await getBackendUrl();
  const token = await getAccessToken();
  if (!token) throw new Error("Not authenticated");
  const res = await fetch(`${base}/byok/list-models`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ provider, api_key: apiKey }),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// In-memory catalog cache (browser also honours the 24h Cache-Control header)
// ---------------------------------------------------------------------------

let _catalogCache = null;

async function getCatalog(log) {
  if (_catalogCache) return _catalogCache;
  try {
    _catalogCache = await fetchByokCatalog();
  } catch (e) {
    log?.(`[Config] BYOK catalog fetch failed: ${e}`, "warn");
    _catalogCache = {};
  }
  return _catalogCache;
}

function catalogModelsFor(catalog, provider, wireTier) {
  return catalog?.[provider]?.[wireTier] ?? [];
}

// ---------------------------------------------------------------------------
// Live model list (per provider) — the backend now accepts ANY well-formed
// BYOK model id; the catalog above is just the "recommended" subset. This
// fetches the provider's actual /v1/models list (via the user's own key, the
// same `listByokModels()` the connectivity smoke uses) so newly-released
// models are selectable the day they ship, without waiting on a catalog
// update. Progressive enhancement, not a fallback: no key, or a failed fetch,
// just leaves the picker Recommended-only — the failure is always logged,
// never silently swallowed (ADR-003, no fallback routines).
// ---------------------------------------------------------------------------

// Debounces the live-list refetch triggered by the key <input> field, which
// fires on every keystroke (the field persists "as typed" — see
// handleByokInput). Without this, typing a 40+ char key manually would send a
// live provider request per character. Module-local "config" constant,
// mirrors the existing *_MS constant pattern used across the addon (e.g.
// fts/nativeEngine.js RECONNECT_COOLDOWN_MS).
const BYOK_LIVE_REFRESH_DEBOUNCE_MS = 600;

let _liveModelsCache = {};
// Per-provider epoch counter: invalidateLiveModels() bumps it, and an
// in-flight getLiveModels() only commits its result to the cache if the epoch
// it captured at entry is still current. Without this, a fetch started with an
// old key that resolves AFTER "Remove key"/"key replaced" would poison the
// cache with models from the removed key.
let _liveModelsEpoch = {};
const _liveRefreshTimers = {};

/**
 * Fetch (and cache) the model ids the saved key for `provider` can access.
 * Returns null when there's no key, or the fetch failed/was rejected — never
 * throws. A null result and an empty array are distinct: null means "couldn't
 * determine the live list" (picker stays Recommended-only); [] means "fetched
 * successfully, zero models" (also renders no live group, but isn't a failure).
 * The returned value may still be handed to the caller even when the epoch
 * moved on mid-flight (the caller's own generation guard handles display);
 * only the CACHE write is epoch-gated.
 */
async function getLiveModels(provider, log) {
  if (Object.prototype.hasOwnProperty.call(_liveModelsCache, provider)) {
    return _liveModelsCache[provider];
  }
  const epoch = _liveModelsEpoch[provider] || 0;
  const commit = (value) => {
    if ((_liveModelsEpoch[provider] || 0) === epoch) {
      _liveModelsCache[provider] = value;
    }
    return value;
  };
  const apiKey = await getProviderKey(provider);
  if (!apiKey) {
    return commit(null);
  }
  try {
    const result = await listByokModels(provider, apiKey);
    if (!result || result.ok !== true || !Array.isArray(result.models)) {
      log?.(
        `[Config] BYOK live model list unavailable for ${provider}: ${result?.error_code || "unknown_error"}`,
        "warn"
      );
      return commit(null);
    }
    return commit(result.models);
  } catch (e) {
    log?.(`[Config] BYOK live model list fetch failed for ${provider}: ${e}`, "warn");
    return commit(null);
  }
}

function invalidateLiveModels(provider) {
  _liveModelsEpoch[provider] = (_liveModelsEpoch[provider] || 0) + 1;
  delete _liveModelsCache[provider];
}

/**
 * Pure: the live ids not already represented by a Recommended (catalog) entry,
 * using byokStorage's isModelAvailable() dedupe semantics — a dated provider
 * id (`claude-haiku-4-5-20251001`) is excluded when its dateless catalog id
 * (`claude-haiku-4-5`) is already in `recommended`. Repeated ids WITHIN the
 * live list itself are also deduped (seen-Set, iOS parity — a provider that
 * ever returns a duplicate must not render it twice). Order is preserved from
 * `liveModels` (the backend already returns them sorted).
 */
function dedupeLiveModels(recommended, liveModels) {
  if (!Array.isArray(liveModels)) return [];
  const rec = Array.isArray(recommended) ? recommended : [];
  const seen = new Set();
  const out = [];
  for (const id of liveModels) {
    if (seen.has(id)) continue;
    seen.add(id);
    if (rec.some((c) => isModelAvailable(c, [id]))) continue;
    out.push(id);
  }
  return out;
}

/**
 * Pure: compute the two rendered groups + which value should end up selected,
 * given the Recommended (catalog) list, the raw live list (or null/undefined
 * when there's no key / the fetch hasn't resolved / it failed), and the
 * currently saved model id.
 *
 * Selection rule (iOS semantic): NEVER overwrite a non-empty stored model.
 * A set `current` is ALWAYS kept as the selection — even when it appears in
 * neither group (transient live-fetch failure, model retired from the catalog,
 * provider hiccup…). "Absent from one fetch" is not evidence the model is
 * gone, and clobbering a saved pick on a transient failure destroys user
 * intent. The renderer appends a bare <option> for an uncovered `current` so
 * the native select actually displays it (a value with no matching option
 * renders as selectedIndex -1).
 *
 * `changed: true` (persist the fill) ONLY when `current` is empty/falsy:
 *  - fill with the first Recommended entry when the catalog has entries
 *    (catalog presence is confirmed, safe to persist in phase 1);
 *  - if the catalog is empty, fill with the first live entry only after a
 *    SUCCESSFUL live fetch (Array.isArray) that returned entries;
 *  - otherwise leave it empty (changed: false).
 */
function computeModelGroups(recommended, liveModels, current) {
  const rec = Array.isArray(recommended) ? recommended : [];
  const live = dedupeLiveModels(rec, liveModels);
  if (current) {
    return { recommended: rec, live, selected: current, changed: false };
  }
  if (rec.length > 0) {
    return { recommended: rec, live, selected: rec[0], changed: true };
  }
  if (Array.isArray(liveModels) && live.length > 0) {
    return { recommended: rec, live, selected: live[0], changed: true };
  }
  return { recommended: rec, live, selected: "", changed: false };
}

function buildOptionEl(id) {
  const opt = document.createElement("option");
  opt.value = id;
  opt.textContent = id;
  return opt;
}

function buildOptGroup(label, ids) {
  const group = document.createElement("optgroup");
  group.label = label;
  for (const id of ids) group.appendChild(buildOptionEl(id));
  return group;
}

/**
 * (Re)render a model <select> from a computeModelGroups() result. Clears the
 * existing content, appends the Recommended optgroup, the live optgroup, and —
 * when the selected (saved) model is covered by neither group — a bare
 * <option> for it, so the native select displays the user's actual saved
 * choice instead of silently showing something else (a value with no matching
 * option yields selectedIndex -1). Disabled only when there is nothing at all
 * to show (both sources empty/unavailable AND no saved model).
 */
function renderModelOptions(sel, groups) {
  sel.textContent = "";
  if (groups.recommended.length > 0) {
    sel.appendChild(buildOptGroup("Recommended", groups.recommended));
  }
  if (groups.live.length > 0) {
    sel.appendChild(buildOptGroup("All models (from your API key)", groups.live));
  }
  const selectedCovered =
    groups.recommended.includes(groups.selected) || groups.live.includes(groups.selected);
  if (groups.selected && !selectedCovered) {
    sel.appendChild(buildOptionEl(groups.selected));
  }
  sel.disabled = groups.recommended.length === 0 && groups.live.length === 0 && !groups.selected;
  sel.value = groups.selected;
}

// ---------------------------------------------------------------------------
// UI rendering / persistence
//
// Layout mirrors iOS: the two tier blocks (Light/Heavy) carry only the provider
// + model pickers; a dedicated "API Keys" subsection below holds one key card
// per provider that's in use (the key is shared per provider across tiers).
// ---------------------------------------------------------------------------

// Per-tier monotonic counter guarding the async live-model append below
// against the user switching provider/tier while a request is in flight.
const _populateGeneration = {};

/**
 * Populate a tier's model <select> with two groups:
 *  - "Recommended" — the catalog models for this provider+tier (order
 *    preserved: first = default, cheapest-first for Light). Rendered
 *    immediately so the UI stays responsive.
 *  - "All models (from your API key)" — the provider's live model list,
 *    rendered once the fetch resolves (only when a key is saved). Dated
 *    variants of a Recommended id, and duplicates within the live list, are
 *    excluded so nothing shows twice.
 *
 * Selection: a non-empty saved model is NEVER overwritten — it stays selected
 * (with a bare <option> appended when it's covered by neither group). Only an
 * EMPTY saved model is filled: rec[0] in phase 1 (catalog presence confirmed),
 * or live[0] in phase 2 when the catalog is empty but a successful live fetch
 * returned entries. An empty catalog no longer hard-disables the picker — the
 * live fetch is still attempted; disabled only when both sources come up empty
 * and nothing is saved.
 *
 * Every await is followed by a generation re-check: a slow older call (stale
 * catalog fetch, slow storage read, in-flight live fetch) must never clear or
 * re-render a newer provider/tier's DOM.
 */
async function populateModelSelect(tier, provider, log) {
  const sel = $(`byok-${tier.ui}-model`);
  if (!sel) return;
  const generation = (_populateGeneration[tier.ui] = (_populateGeneration[tier.ui] || 0) + 1);

  const catalog = await getCatalog(log);
  if (_populateGeneration[tier.ui] !== generation) return;
  const models = catalogModelsFor(catalog, provider, tier.wire);
  const current = await getTierModel(tier.ui, provider);
  // Guard immediately before the DOM clear below — this is the phase-1 race:
  // getCatalog/getTierModel resolve BEFORE the clear, so without this check a
  // slow older call clobbers a newer render with the wrong provider's list.
  if (_populateGeneration[tier.ui] !== generation) return;

  // Phase 1 — render the Recommended group immediately (UI responsiveness);
  // the live list hasn't been consulted yet (null = "not fetched").
  const phase1 = computeModelGroups(models, null, current);
  renderModelOptions(sel, phase1);
  if (phase1.changed) {
    // Only reachable when the stored model was EMPTY and the catalog has
    // entries — fills with rec[0]. A non-empty stored model is never touched.
    await setTierModel(tier.ui, provider, phase1.selected);
    if (_populateGeneration[tier.ui] !== generation) return;
  }

  const liveModels = await getLiveModels(provider, log);

  // The user may have switched provider/tier (or the select may have been
  // torn down/repopulated) while the live fetch was in flight — don't let a
  // stale request clobber a newer render.
  if (_populateGeneration[tier.ui] !== generation) return;
  const selNow = $(`byok-${tier.ui}-model`);
  if (!selNow) return;

  const effectiveCurrent = current || phase1.selected;
  const result = computeModelGroups(models, liveModels, effectiveCurrent);
  renderModelOptions(selNow, result);
  if (result.changed) {
    // Only reachable when the stored model was EMPTY and the catalog had
    // nothing — fills with live[0] after a successful live fetch.
    await setTierModel(tier.ui, provider, result.selected);
  }
}

/** Invalidate + re-fetch the live group for every tier currently using `provider`. */
async function refreshProviderModels(provider, log) {
  invalidateLiveModels(provider);
  for (const tier of TIERS) {
    if ((await getTierProvider(tier.ui)) === provider) {
      await populateModelSelect(tier, provider, log);
    }
  }
}

/** Debounced trigger for refreshProviderModels (see BYOK_LIVE_REFRESH_DEBOUNCE_MS). */
function scheduleProviderModelsRefresh(provider, log) {
  if (_liveRefreshTimers[provider]) clearTimeout(_liveRefreshTimers[provider]);
  _liveRefreshTimers[provider] = setTimeout(() => {
    delete _liveRefreshTimers[provider];
    refreshProviderModels(provider, log).catch((e) => {
      log?.(`[Config] BYOK live model refresh failed: ${e}`, "warn");
    });
  }, BYOK_LIVE_REFRESH_DEBOUNCE_MS);
}

/**
 * Clear all pending debounced live-model refresh timers. Wired into the config
 * page's cleanupAllConfigListeners (beforeunload / re-init) — TB rule 5:
 * always clean up timers for hot-reload support.
 */
export function cleanupByokTimers() {
  for (const provider of Object.keys(_liveRefreshTimers)) {
    clearTimeout(_liveRefreshTimers[provider]);
    delete _liveRefreshTimers[provider];
  }
}

/** Show/hide a tier's model row + "add a key" hint based on its provider. */
async function renderTierRow(tier, provider, log) {
  const row = $(`byok-${tier.ui}-model-row`);
  if (row) row.style.display = provider === "tabmail" ? "none" : "";
  if (provider !== "tabmail") await populateModelSelect(tier, provider, log);
  await refreshTierKeyHint(tier, provider);
}

/** A per-tier "⚠ add your key below" nudge when the chosen provider has no key. */
async function refreshTierKeyHint(tier, provider) {
  const hint = $(`byok-${tier.ui}-keyhint`);
  if (!hint) return;
  if (provider === "tabmail") {
    hint.style.display = "none";
    return;
  }
  const hasKey = !!(await getProviderKey(provider));
  hint.style.display = hasKey ? "none" : "";
  hint.textContent = `⚠ Add your ${PROVIDER_LABELS[provider] || provider} key below`;
}

function updateCostWarningVisibility(providers) {
  const warn = $("byok-cost-warning");
  if (warn) warn.style.display = providers.some((p) => p !== "tabmail") ? "" : "none";
}

// --- API Keys subsection (one card per in-use provider) ---

function keyCardInnerHTML(provider) {
  const label = PROVIDER_LABELS[provider] || provider;
  return `
    <div class="byok-key-head">
      <strong>${label}</strong>
      <span id="byok-key-${provider}-status" class="byok-key-status"></span>
      <button type="button" id="byok-key-${provider}-getkey" class="byok-getkey-btn">Get a key →</button>
    </div>
    <div class="byok-key-row">
      <input type="password" id="byok-key-${provider}-input" placeholder="Paste your ${label} API key" autocomplete="off" spellcheck="false" />
      <button type="button" id="byok-key-${provider}-show" title="Show / hide key">Show</button>
      <button type="button" id="byok-key-${provider}-paste">Paste</button>
    </div>
    <div class="byok-key-actions">
      <button type="button" id="byok-key-${provider}-test" class="byok-test-btn">Test API Connectivity</button>
      <button type="button" id="byok-key-${provider}-remove" class="byok-remove-btn">Remove key</button>
    </div>
    <pre id="byok-key-${provider}-test-result" class="byok-test-result"></pre>
    <small id="byok-key-${provider}-zdr" class="byok-zdr"></small>
  `;
}

/** Update one provider key card's value/status/ZDR/get-key link. */
async function refreshKeyCard(provider) {
  const key = await getProviderKey(provider);
  const input = $(`byok-key-${provider}-input`);
  // Don't clobber what the user is actively typing.
  if (input && document.activeElement !== input) input.value = key;
  const status = $(`byok-key-${provider}-status`);
  if (status) {
    status.textContent = key ? "✓ Key saved" : "⚠ No key yet";
    status.dataset.state = key ? "ok" : "missing";
  }
  const getkey = $(`byok-key-${provider}-getkey`);
  if (getkey) getkey.dataset.url = PROVIDER_KEY_URLS[provider] || "";
  const zdr = $(`byok-key-${provider}-zdr`);
  if (zdr) zdr.textContent = PROVIDER_ZDR[provider] || "";
}

/**
 * Render the API Keys list. Always shows a card for EVERY provider (matches
 * iOS APIKeysView), regardless of whether a tier currently selects it — so a
 * user can paste keys up front, and saved keys are always visible (persistence
 * is obvious). Cards are created once and reused (idempotent).
 */
async function renderApiKeysSection() {
  const list = $("byok-keys-list");
  const wrap = $("byok-api-keys");
  if (!list || !wrap) return;

  wrap.style.display = ""; // always visible

  for (const provider of PROVIDERS) {
    let card = list.querySelector(`[data-provider="${provider}"]`);
    if (!card) {
      card = document.createElement("div");
      card.className = "byok-key-card";
      card.dataset.provider = provider;
      card.innerHTML = keyCardInnerHTML(provider);
      list.appendChild(card);
    }
    await refreshKeyCard(provider);
  }
}

/** Load BYOK settings into the UI (called once on config-page init). */
export async function loadByokSettings(log) {
  try {
    for (const tier of TIERS) {
      const provider = await getTierProvider(tier.ui);
      const sel = $(`byok-${tier.ui}-provider`);
      if (sel) sel.value = provider;
      await renderTierRow(tier, provider, log);
    }
    await renderApiKeysSection();
    const providers = await Promise.all(TIERS.map((t) => getTierProvider(t.ui)));
    updateCostWarningVisibility(providers);
    log?.("[Config] BYOK settings loaded");
  } catch (e) {
    log?.(`[Config] loadByokSettings failed: ${e}`, "error");
  }
}

function tierFromElementId(id) {
  const m = /^byok-(light|heavy)-/.exec(id || "");
  if (!m) return null;
  return TIERS.find((t) => t.ui === m[1]) || null;
}

function providerFromKeyId(id) {
  const m = /^byok-key-(openai|anthropic|google)-/.exec(id || "");
  return m ? m[1] : null;
}

/** Refresh every place a provider's key state is reflected (cards + tier hints). */
async function refreshProviderState(provider, log) {
  await refreshKeyCard(provider);
  for (const tier of TIERS) {
    if ((await getTierProvider(tier.ui)) === provider) {
      await refreshTierKeyHint(tier, provider);
    }
  }
}

/** Delegated `change` handler (tier provider select, tier model select). */
export async function handleByokChange(e, log) {
  const id = e.target?.id || "";
  const tier = tierFromElementId(id);
  if (!tier) return;

  if (id === `byok-${tier.ui}-provider`) {
    const provider = e.target.value;
    await setTierProvider(tier.ui, provider);
    await renderTierRow(tier, provider, log);
    await renderApiKeysSection();
    const providers = await Promise.all(TIERS.map((t) => getTierProvider(t.ui)));
    updateCostWarningVisibility(providers);
    const status = $("status");
    if (status) status.textContent = `${tier.label} provider: ${PROVIDER_LABELS[provider] || provider}`;
  } else if (id === `byok-${tier.ui}-model`) {
    const provider = await getTierProvider(tier.ui);
    await setTierModel(tier.ui, provider, e.target.value);
  }
}

/** Delegated `input` handler (a provider key field — persist as typed). */
export async function handleByokInput(e, log) {
  const id = e.target?.id || "";
  const provider = providerFromKeyId(id);
  if (!provider || id !== `byok-key-${provider}-input`) return;
  const key = (e.target.value || "").trim();
  if (key) await setProviderKey(provider, key);
  else await clearProviderKey(provider);
  await refreshProviderState(provider, log);
  // Debounced: this handler fires on every keystroke while the key is typed.
  scheduleProviderModelsRefresh(provider, log);
}

/** Delegated `click` handler (paste, show/hide, get-a-key, test, remove). */
export async function handleByokClick(e, log) {
  const target = e.target?.closest?.("[id^='byok-key-']") || e.target;
  const id = target?.id || "";
  const provider = providerFromKeyId(id);
  if (!provider) return false;

  if (id === `byok-key-${provider}-paste`) {
    try {
      const text = await navigator.clipboard.readText();
      const input = $(`byok-key-${provider}-input`);
      if (input && text) {
        input.value = text.trim();
        input.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch (err) {
      log?.(`[Config] BYOK paste failed: ${err}`, "warn");
    }
    return true;
  }

  if (id === `byok-key-${provider}-show`) {
    const input = $(`byok-key-${provider}-input`);
    if (input) {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      target.textContent = show ? "Hide" : "Show";
    }
    return true;
  }

  if (id === `byok-key-${provider}-getkey`) {
    const url = target.dataset?.url;
    // Open in the user's OS default browser (Firefox/Chrome/Safari), NOT a TB
    // content tab — the provider consoles are real web apps with logins, and
    // users expect their browser's session/cookies/extensions, not TB's.
    if (url) await browser.windows.openDefaultBrowser(url);
    return true;
  }

  if (id === `byok-key-${provider}-remove`) {
    await clearProviderKey(provider);
    const input = $(`byok-key-${provider}-input`);
    if (input) input.value = "";
    const resultEl = $(`byok-key-${provider}-test-result`);
    if (resultEl) { resultEl.textContent = ""; resultEl.dataset.state = ""; }
    await refreshProviderState(provider, log);
    // A deliberate click, not per-keystroke noise — refresh immediately
    // (drops the live group right away instead of waiting on the debounce).
    if (_liveRefreshTimers[provider]) {
      clearTimeout(_liveRefreshTimers[provider]);
      delete _liveRefreshTimers[provider];
    }
    await refreshProviderModels(provider, log);
    return true;
  }

  if (id === `byok-key-${provider}-test`) {
    await runConnectivityTest(provider, log);
    return true;
  }

  return false;
}

/** Pick a tier that uses this provider (prefer Heavy/interactive) for testing. */
async function tierUsingProvider(provider) {
  for (const tier of [...TIERS].reverse()) {
    if ((await getTierProvider(tier.ui)) === provider) return tier;
  }
  return TIERS[TIERS.length - 1];
}

/**
 * "Test API Connectivity" — iOS-style smoke through normal endpoints (per
 * provider). Validates the key + model access (list-models), then runs one real
 * /completions/chat round-trip. Shows only failures inline.
 */
async function runConnectivityTest(provider, log) {
  const resultEl = $(`byok-key-${provider}-test-result`);
  const apiKey = await getProviderKey(provider);
  if (resultEl) { resultEl.textContent = "Testing…"; resultEl.dataset.state = ""; }

  if (!apiKey) {
    if (resultEl) resultEl.textContent = "Enter and save an API key first.";
    return;
  }

  const tier = await tierUsingProvider(provider);
  const model = await getTierModel(tier.ui, provider);

  const failures = await runProviderSmoke({
    provider,
    apiKey,
    tier,
    model,
    listByokModels,
    getCatalog: () => getCatalog(log),
    catalogModelsFor,
    log,
  });

  if (!resultEl) return;
  if (failures.length === 0) {
    resultEl.textContent = `✓ ${PROVIDER_LABELS[provider]} works.`;
    resultEl.dataset.state = "ok";
  } else {
    resultEl.textContent = `✗ ${failures.length} issue(s):\n` + failures.join("\n");
    resultEl.dataset.state = "fail";
  }
}

// Test-only hooks to reset/prime the in-memory caches between tests, and to
// exercise otherwise-private logic (dedupe/selection are pure; populate is the
// DOM-integration entry point).
export const _testExports = {
  resetCatalogCache: () => {
    _catalogCache = null;
  },
  _setCatalogCache: (catalog) => {
    _catalogCache = catalog;
  },
  resetLiveModelsCache: () => {
    _liveModelsCache = {};
    _liveModelsEpoch = {};
  },
  _setLiveModelsCache: (provider, models) => {
    _liveModelsCache[provider] = models;
  },
  catalogModelsFor,
  dedupeLiveModels,
  computeModelGroups,
  getLiveModels,
  invalidateLiveModels,
  populateModelSelect,
  refreshProviderModels,
  BYOK_LIVE_REFRESH_DEBOUNCE_MS,
  _hasScheduledLiveModelsRefresh: (provider) => Boolean(_liveRefreshTimers[provider]),
};
