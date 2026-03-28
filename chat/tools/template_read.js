// template_read.js – read full details of a local or marketplace template (non-FSM, read-only)

import { log } from "../../agent/modules/utils.js";
import { getTemplate } from "../../agent/modules/templateManager.js";
import { getTemplateWorkerUrl } from "../../agent/modules/config.js";
import { getAccessToken } from "../../agent/modules/supabaseAuth.js";

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] template_read: Tool called with args: ${JSON.stringify(args)}`);

    // template_id is already resolved by idTranslator from numeric to real UUID
    const templateId = typeof args?.template_id === "string" ? args.template_id
      : typeof args?.template_id === "number" ? String(args.template_id) : "";

    if (!templateId) {
      return { error: "Template ID is required." };
    }

    // Try local first
    const template = await getTemplate(templateId);
    if (template && !template.deleted) {
      return {
        ok: true,
        source: "local",
        template_id: template.id,
        name: template.name,
        enabled: template.enabled,
        instructions: template.instructions,
        example_reply: template.exampleReply,
        created_at: template.createdAt,
        updated_at: template.updatedAt,
      };
    }

    // Not found locally — try marketplace
    let token = "";
    try { token = await getAccessToken() || ""; } catch (_) {}

    let baseUrl = "";
    try { baseUrl = await getTemplateWorkerUrl(); } catch (_) {}

    if (token && baseUrl) {
      try {
        const controller = new AbortController();
        const readTimeout = setTimeout(() => controller.abort(), 15000);
        let response;
        try {
          response = await fetch(`${baseUrl}/template/${templateId}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(readTimeout);
        }

        if (response.ok) {
          const data = await response.json();
          const t = data?.template;
          if (t) {
            return {
              ok: true,
              source: "marketplace",
              template_id: t.id,
              name: t.name,
              instructions: t.instructions || [],
              example_reply: t.example_reply || "",
              download_count: t.download_count || 0,
              category: t.category || "",
              tags: t.tags || [],
              is_featured: t.is_featured || false,
              is_official: t.is_official || false,
              created_at: t.created_at || "",
              updated_at: t.updated_at || "",
            };
          }
        }
      } catch (e) {
        log(`[TMDBG Tools] template_read: marketplace fetch failed: ${e}`, "warn");
      }
    }

    return { error: `Template not found with ID: ${templateId}` };
  } catch (e) {
    log(`[TMDBG Tools] template_read failed: ${e}`, "error");
    return { error: String(e || "unknown error in template_read") };
  }
}

export function resetPaginationSessions() {}
