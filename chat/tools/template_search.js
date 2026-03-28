// template_search.js – search local templates AND the public marketplace (non-FSM, read-only)

import { log } from "../../agent/modules/utils.js";
import { getTemplateWorkerUrl } from "../../agent/modules/config.js";
import { getAccessToken } from "../../agent/modules/supabaseAuth.js";
import { getVisibleTemplates } from "../../agent/modules/templateManager.js";

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] template_search: Tool called with args: ${JSON.stringify(args)}`);

    const query = typeof args?.query === "string" ? args.query.trim() : "";
    const category = typeof args?.category === "string" ? args.category.trim() : "";
    const sort = typeof args?.sort === "string" ? args.sort.trim() : "";

    const results = [];

    // --- 1. Search local templates (word-based OR matching) ---
    try {
      const localTemplates = await getVisibleTemplates();
      const queryWords = query.toLowerCase().split(/\s+/).filter(Boolean);

      const scored = [];
      for (const t of localTemplates) {
        if (queryWords.length === 0) {
          // No query — include all local templates
          scored.push({ t, score: 0 });
          continue;
        }

        // Score: count how many query words match any field (name, instructions, exampleReply)
        // Name hits are weighted 2x for ranking
        const nameLower = (t.name || "").toLowerCase();
        const instrText = (t.instructions || []).join(" ").toLowerCase();
        const exampleLower = (t.exampleReply || "").toLowerCase();

        let hits = 0;
        for (const word of queryWords) {
          if (nameLower.includes(word)) hits += 2;       // name weighted higher
          if (instrText.includes(word)) hits += 1;
          if (exampleLower.includes(word)) hits += 1;
        }

        if (hits > 0) {
          scored.push({ t, score: hits });
        }
      }

      // Sort by score descending (best matches first)
      scored.sort((a, b) => b.score - a.score);

      for (const { t } of scored) {
        results.push({
          template_id: t.id,
          name: t.name || "(Untitled)",
          source: "local",
          enabled: t.enabled,
          instructions_count: Array.isArray(t.instructions) ? t.instructions.length : 0,
        });
      }
      log(`[TMDBG Tools] template_search: ${results.length} local matches`);
    } catch (e) {
      log(`[TMDBG Tools] template_search: local search failed: ${e}`, "warn");
    }

    // --- 2. Search marketplace ---
    let marketplaceResults = [];
    let marketplaceTotal = 0;
    let marketplaceHasMore = false;

    try {
      let token = "";
      try {
        token = await getAccessToken() || "";
      } catch (e) {
        log(`[TMDBG Tools] template_search: failed to get auth token: ${e}`, "error");
      }

      let baseUrl = "";
      try {
        baseUrl = await getTemplateWorkerUrl();
      } catch (e) {
        log(`[TMDBG Tools] template_search: failed to get template worker URL: ${e}`, "error");
      }

      if (token && baseUrl) {
        const params = new URLSearchParams();
        if (query) params.set("search", query);
        if (category) params.set("category", category);
        if (sort) params.set("sort", sort);
        params.set("limit", "10");

        const url = `${baseUrl}/list?${params.toString()}`;
        log(`[TMDBG Tools] template_search: fetching ${url}`);

        const controller = new AbortController();
        const searchTimeout = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
          response = await fetch(url, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(searchTimeout);
        }

        if (response.ok) {
          const data = await response.json();
          const templates = data?.templates || [];

          for (const t of templates) {
            marketplaceResults.push({
              template_id: t.id,
              name: t.name || "(Untitled)",
              source: "marketplace",
              description: t.description || "",
              instructions_count: Array.isArray(t.instructions) ? t.instructions.length : 0,
              download_count: t.download_count || 0,
              category: t.category || "",
              is_featured: t.is_featured || false,
              is_official: t.is_official || false,
            });
          }

          marketplaceTotal = data?.pagination?.total || templates.length;
          marketplaceHasMore = data?.pagination?.has_more || false;
          log(`[TMDBG Tools] template_search: ${marketplaceResults.length} marketplace matches (total: ${marketplaceTotal})`);
        } else {
          log(`[TMDBG Tools] template_search: marketplace API returned ${response.status}`, "warn");
        }
      } else {
        log(`[TMDBG Tools] template_search: skipping marketplace (no auth or URL)`, "warn");
      }
    } catch (e) {
      log(`[TMDBG Tools] template_search: marketplace search failed: ${e}`, "warn");
    }

    // --- 3. Combine results (dedup: skip marketplace entries already present locally) ---
    const localIds = new Set(results.map((r) => r.template_id));
    const dedupedMarketplace = marketplaceResults.filter((r) => !localIds.has(r.template_id));
    const combined = [...results, ...dedupedMarketplace];

    if (combined.length === 0) {
      return { ok: true, result: "No templates found matching your search." };
    }

    return {
      ok: true,
      templates: combined,
      local_count: results.length,
      marketplace_count: dedupedMarketplace.length,
      marketplace_total: marketplaceTotal,
      marketplace_has_more: marketplaceHasMore,
    };
  } catch (e) {
    log(`[TMDBG Tools] template_search failed: ${e}`, "error");
    return { error: String(e || "unknown error in template_search") };
  }
}

export function resetPaginationSessions() {}
