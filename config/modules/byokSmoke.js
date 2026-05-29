import { sendChatCompletions } from "../../agent/modules/llm.js";
import { isModelAvailable } from "../../agent/modules/byokStorage.js";

/**
 * BYOK connectivity smoke — Thunderbird port of iOS `runBYOKSmoke`
 * (PLAN_BYOK_SUPPORT.md §6.1). Tests entirely through normal endpoints
 * (`POST /byok/list-models` + `/completions/chat`); the backend is unchanged.
 *
 * TB-specific adaptation: iOS forces the `system_prompt_compose/summary` prompts,
 * which are NOT registered for the Thunderbird platform. TB only registers
 * `system_prompt_agent` (tier heaviest → BYOK `interactive`) and
 * `system_prompt_fsm` (tier medium → BYOK `background`). So the end-to-end leg
 * uses `system_prompt_agent` with a tool-forcing prompt — the real agent path a
 * TB user exercises — and verifies routing + a deterministic fragment.
 *
 * Two checks, each contributing human-readable failure strings:
 *   1. `list-models` — validates the key reaches the provider, and confirms the
 *      tier's configured model is actually in the account ("not in your account").
 *   2. one real `/completions/chat` round-trip with the BYOK key attached →
 *      verifies `byok_routed === true` and the tool-derived day-name appears.
 */

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Deterministic fixture: a date far enough in the future that the model can't
 * recall the weekday — the only reliable way to produce the expected fragment is
 * the tool. Weekday computed in UTC to match the server `date_to_day` tool.
 * Mirrors iOS `BYOKSmokeFixture.make()` (no hardcoded dates).
 */
export function makeSmokeFixture(now = new Date()) {
  const base = new Date(Date.UTC(now.getUTCFullYear() + 5, now.getUTCMonth(), now.getUTCDate()));
  const yyyy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(base.getUTCDate()).padStart(2, "0");
  return {
    date: `${yyyy}-${mm}-${dd}`,
    dayName: DAY_NAMES[base.getUTCDay()],
  };
}

/** The forced-tool user message for the agent completion leg. */
export function smokeUserMessage(fixture) {
  return (
    `Connectivity self-test. You MUST call the date_to_day tool with date "${fixture.date}" ` +
    `— do NOT compute or guess the day yourself. After the tool result arrives, reply with ` +
    `exactly one short sentence stating the day of the week, using the exact day name from the ` +
    `tool result. Nothing else.`
  );
}

/**
 * Pure: turn a completion result into a failure string (or null on success).
 * Success = routed to BYOK + non-empty response + the expected fragment present.
 * Tool stages are intentionally NOT checked — production strips `tool_name` from
 * the SSE stream, so the fragment is the real verification (matches iOS §10.4b).
 *
 * @param {Object|null} result  the object returned by sendChatCompletions
 * @param {string} expectedFragment  case-insensitive substring that must appear
 * @param {string} providerLabel
 */
export function evaluateCompletion(result, expectedFragment, providerLabel) {
  if (!result || result.err) {
    return `${providerLabel} request failed: ${result?.err || "no response"}`;
  }
  if (result.error_code) {
    const detail = result.error_detail ? ` — ${result.error_detail}` : "";
    return `${providerLabel} provider error (${result.error_code})${detail}`;
  }
  if (result.byok_routed !== true) {
    const why = result.byok_skip_reason ? ` (skipped: ${result.byok_skip_reason})` : "";
    return `${providerLabel} did not route to your key${why} — request fell back to TabMail.`;
  }
  const text = typeof result.assistant === "string" ? result.assistant : "";
  if (!text) return `${providerLabel} returned an empty response.`;
  if (!text.toLowerCase().includes(expectedFragment.toLowerCase())) {
    return `${providerLabel} response didn't contain the expected result ("${expectedFragment}").`;
  }
  return null;
}

/**
 * Run the connectivity smoke for one provider + tier. Returns an array of
 * human-readable failure strings (empty array = all good).
 *
 * @param {Object} args
 * @param {string} args.provider   openai | anthropic | google
 * @param {string} args.apiKey
 * @param {{ui,wire,label}} args.tier
 * @param {string} args.model      the tier's configured model
 * @param {Function} args.listByokModels   (provider, apiKey) => {ok, models, error_code, ...}
 * @param {Function} args.getCatalog        () => catalog
 * @param {Function} args.catalogModelsFor  (catalog, provider, wireTier) => string[]
 * @param {Function} [args.log]
 * @param {Function} [args.sendFn]          injectable for tests (defaults to sendChatCompletions)
 * @returns {Promise<string[]>}
 */
export async function runProviderSmoke({
  provider,
  apiKey,
  tier,
  model,
  listByokModels,
  getCatalog,
  catalogModelsFor,
  log,
  sendFn = sendChatCompletions,
}) {
  const failures = [];
  const providerLabel = provider.charAt(0).toUpperCase() + provider.slice(1);

  // 1. Validate the key + model access via list-models (the real provider call).
  let accessible = null;
  try {
    const listed = await listByokModels(provider, apiKey);
    if (!listed || listed.ok !== true) {
      const code = listed?.error_code || "unknown_error";
      const detail = listed?.error_detail ? ` — ${listed.error_detail}` : "";
      failures.push(`Key rejected by ${providerLabel} (${code})${detail}`);
      return failures; // can't continue without a valid key
    }
    accessible = Array.isArray(listed.models) ? listed.models : [];
    if (model && !isModelAvailable(model, accessible)) {
      failures.push(`Model "${model}" is not in your ${providerLabel} account.`);
    }
  } catch (e) {
    failures.push(`Couldn't reach ${providerLabel} to list models: ${e.message || e}`);
    return failures;
  }

  // 2. One real end-to-end completion through system_prompt_agent (interactive
  //    BYOK tier). The model MUST be in byokModelCatalog[provider].interactive
  //    or the backend rejects with `tier_entry_invalid` — the catalog is the
  //    authoritative allow-list for what's accepted at the gateway. We do NOT
  //    filter by the `accessible` set here: `/byok/list-models` is noisy
  //    across providers (versioned aliases, prefixed names, etc.) and using it
  //    as a gate produced false negatives → falling back to the user's saved
  //    *Light/background* tier model → backend rejection. If the chosen model
  //    isn't actually in the user's account, we'll surface a real provider
  //    error from the chat call (clearer signal than tier_entry_invalid).
  const catalog = await getCatalog();
  const interactiveModels = catalogModelsFor(catalog, provider, "interactive");
  const completionModel =
    (model && interactiveModels.includes(model)) ? model : interactiveModels[0];

  if (!completionModel) {
    failures.push(`No ${providerLabel} model available for the interactive tier in the catalog.`);
    return failures;
  }

  const fixture = makeSmokeFixture();
  const payload = {
    messages: [
      { role: "system", content: "system_prompt_agent" },
      { role: "user", content: smokeUserMessage(fixture) },
    ],
    // Explicit BYOK override (bypasses storage); backend reads byok.interactive
    // for system_prompt_agent (tier heaviest → interactive).
    byok: { interactive: { provider, api_key: apiKey, model: completionModel } },
  };

  // Diagnostic line (no key leak — only length + first 4 chars). When the
  // backend returns `tier_entry_invalid`, this is the difference between "I
  // can't tell why" and "your key length is 40 chars, regex wants 39".
  const keyDiag = apiKey ? `len=${apiKey.length} first4="${apiKey.slice(0, 4)}"` : "(empty)";
  log?.(
    `[BYOK_SMOKE ${provider}/${completionModel}/${tier.label}] sending: ` +
    `key=${keyDiag} interactive_catalog=[${interactiveModels.join(",")}]`
  );

  try {
    const result = await sendFn(payload, null, null, true);
    const fail = evaluateCompletion(result, fixture.dayName, providerLabel);
    if (fail) {
      failures.push(fail);
      // tier_entry_invalid has 3 possible causes (byokAuth.ts: provider check,
      // api_key regex, model-in-catalog). The first is impossible here (we set
      // it ourselves), so spell out exactly what we sent so the user can
      // compare against the regex / catalog inline.
      if (result?.byok_skip_reason === "tier_entry_invalid") {
        // The backend no longer checks api_key FORMAT — so tier_entry_invalid
        // now means the model isn't in byokModelCatalog.<provider>.<resolvedTier>
        // (the only other gate is "api_key empty", which the UI guards above).
        failures.push(
          `↳ Sent: provider=${provider} model="${completionModel}" key=${keyDiag}. ` +
          `Interactive catalog: [${interactiveModels.join(", ")}]. ` +
          `Most likely the client catalog is out of sync with the deployed backend.`
        );
      }
    }
  } catch (e) {
    failures.push(`${providerLabel} end-to-end test threw: ${e.message || e}`);
  }

  return failures;
}
