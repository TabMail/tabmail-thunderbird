// template_toggle.js – enable or disable a reply template (non-FSM, no confirmation)

import { log } from "../../agent/modules/utils.js";
import { getTemplate, updateTemplate } from "../../agent/modules/templateManager.js";

export async function run(args = {}, options = {}) {
  try {
    log(`[TMDBG Tools] template_toggle: Tool called with args: ${JSON.stringify(args)}`);

    const templateId = typeof args?.template_id === "string" ? args.template_id
      : typeof args?.template_id === "number" ? String(args.template_id) : "";

    if (!templateId) {
      return { error: "Template ID is required." };
    }

    const enabled = typeof args?.enabled === "boolean" ? args.enabled : null;
    if (enabled === null) {
      return { error: "The 'enabled' parameter (true or false) is required." };
    }

    const template = await getTemplate(templateId);
    if (!template || template.deleted) {
      return { error: `Template not found with ID: ${templateId}` };
    }

    if (template.enabled === enabled) {
      return {
        ok: true,
        result: `Template "${template.name}" is already ${enabled ? "enabled" : "disabled"}.`,
        template_id: template.id,
        template_name: template.name,
        enabled,
      };
    }

    const updated = await updateTemplate(templateId, { enabled });
    if (!updated) {
      return { error: "Failed to update template." };
    }

    log(`[TMDBG Tools] template_toggle: ${updated.name} → enabled=${enabled}`);
    return {
      ok: true,
      result: `Template "${updated.name}" ${enabled ? "enabled" : "disabled"}.`,
      template_id: updated.id,
      template_name: updated.name,
      enabled,
    };
  } catch (e) {
    log(`[TMDBG Tools] template_toggle failed: ${e}`, "error");
    return { error: String(e || "unknown error in template_toggle") };
  }
}

export function resetPaginationSessions() {}
