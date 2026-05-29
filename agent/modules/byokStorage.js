/**
 * BYOK storage + wire-payload (low-level, leaf module).
 *
 * Lives in agent/modules so `llm.js` can read the saved BYOK config without
 * importing the config-page layer (which would create an import cycle:
 * llm.js → byokSettings → byokSmoke → llm.js). Depends ONLY on
 * `browser.storage.local`. See PLAN_BYOK_SUPPORT.md §6.1.
 *
 * Two configurable tiers — "Light" (wire `background`) and "Heavy" (wire
 * `interactive`); autocomplete is fixed to TabMail and never carried.
 */

// UI tier id → backend wire tier id. Autocomplete is intentionally absent.
export const TIERS = [
  { ui: "light", wire: "background", label: "Light", desc: "Background work — summaries, classification, reminders" },
  { ui: "heavy", wire: "interactive", label: "Heavy", desc: "Interactive — compose + agent chat" },
];

const providerKeyName = (tier) => `byok.${tier}.provider`;
const modelKeyName = (tier, provider) => `byok.${tier}.${provider}.model`;
const apiKeyName = (provider) => `byok.key.${provider}`;

export async function getTierProvider(tier) {
  const k = providerKeyName(tier);
  const stored = await browser.storage.local.get({ [k]: "tabmail" });
  const v = stored[k];
  return typeof v === "string" && v ? v : "tabmail";
}

export async function setTierProvider(tier, provider) {
  await browser.storage.local.set({ [providerKeyName(tier)]: provider });
}

export async function getTierModel(tier, provider) {
  const k = modelKeyName(tier, provider);
  const stored = await browser.storage.local.get({ [k]: "" });
  return typeof stored[k] === "string" ? stored[k] : "";
}

export async function setTierModel(tier, provider, model) {
  await browser.storage.local.set({ [modelKeyName(tier, provider)]: model });
}

export async function getProviderKey(provider) {
  const k = apiKeyName(provider);
  const stored = await browser.storage.local.get({ [k]: "" });
  return typeof stored[k] === "string" ? stored[k] : "";
}

export async function setProviderKey(provider, key) {
  await browser.storage.local.set({ [apiKeyName(provider)]: key });
}

export async function clearProviderKey(provider) {
  await browser.storage.local.remove(apiKeyName(provider));
}

/**
 * Pure: turn a resolved per-tier config into the backend wire object.
 * Shape: `{ background?: {provider, api_key, model}, interactive?: {...} }`.
 * Only emits a tier whose provider ≠ 'tabmail' AND has both a key and a model.
 * Autocomplete is never present. snake_case `api_key` (matches iOS + backend).
 */
export function assembleByokPayload(cfg) {
  const byok = {};
  for (const { ui, wire } of TIERS) {
    const t = cfg?.[ui];
    if (!t || !t.provider || t.provider === "tabmail") continue;
    if (!t.apiKey || !t.model) continue;
    byok[wire] = { provider: t.provider, api_key: t.apiKey, model: t.model };
  }
  return byok;
}

/**
 * Catalog models a key can access, tolerant of provider naming quirks:
 *  - exact match, OR
 *  - Anthropic dated alias (`claude-haiku-4-5` ⊂ `claude-haiku-4-5-20251001`).
 * Google's `models/` prefix is already stripped server-side (§1.4.3 G2). Pure.
 */
export function isModelAvailable(catalogModel, available) {
  if (!Array.isArray(available)) return false;
  if (available.includes(catalogModel)) return true;
  const datedPrefix = catalogModel + "-";
  return available.some(
    (id) => id.startsWith(datedPrefix) && /^[0-9]+$/.test(id.slice(datedPrefix.length))
  );
}

/**
 * Read the saved config from storage.local and build the wire payload. Called
 * by llm.js on each /completions/chat request (when no explicit `payload.byok`
 * was supplied by the smoke).
 * @returns {Promise<Object>} byok payload ({} when nothing configured)
 */
export async function buildByokPayload() {
  const cfg = {};
  for (const { ui } of TIERS) {
    const provider = await getTierProvider(ui);
    if (provider === "tabmail") continue;
    cfg[ui] = {
      provider,
      apiKey: await getProviderKey(provider),
      model: await getTierModel(ui, provider),
    };
  }
  return assembleByokPayload(cfg);
}
