/**
 * Template Manager Module
 *
 * Manages email templates as JSON objects stored in browser.storage.local.
 * Provides CRUD operations and migration from legacy markdown format.
 *
 * Template Schema:
 * {
 *   id: string,           // Unique identifier (UUID)
 *   name: string,         // Display name
 *   enabled: boolean,     // Whether template is active
 *   instructions: string[], // Array of instruction strings
 *   exampleReply: string, // Example reply text
 *   createdAt: string,    // ISO timestamp
 *   updatedAt: string     // ISO timestamp
 * }
 *
 * NOTE: Author info is NOT stored locally - it's only tracked server-side
 * for marketplace payout calculations.
 */

import { log } from "./utils.js";

const PFX = "[TemplateManager] ";
const STORAGE_KEY = "user_templates";

/**
 * Generate a random UUID v4 for templates
 * @returns {string}
 */
function generateId() {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === "x" ? r : (r & 0x3) | 0x8;
        return v.toString(16);
    });
}

/**
 * Get current ISO timestamp
 * @returns {string}
 */
function getTimestamp() {
    return new Date().toISOString();
}

/**
 * Create a new template object with default values
 * @param {Partial<Template>} partial - Partial template data
 * @returns {Template}
 */
export function createTemplate(partial = {}) {
    const now = getTimestamp();
    const name = partial.name || "New Template";

    return {
        id: partial.id || generateId(),
        name,
        enabled: partial.enabled !== undefined ? partial.enabled : true,
        instructions: partial.instructions || [],
        exampleReply: partial.exampleReply || "",
        createdAt: partial.createdAt || now,
        updatedAt: partial.updatedAt || now,
    };
}

/**
 * Load all templates from storage
 * @returns {Promise<Template[]>}
 */
export async function loadTemplates() {
    try {
        const result = await browser.storage.local.get(STORAGE_KEY);
        const templates = result[STORAGE_KEY];

        if (Array.isArray(templates)) {
            log(`${PFX}Loaded ${templates.length} templates from storage`);
            return templates;
        }

        log(`${PFX}No templates found in storage, returning empty array`);
        return [];
    } catch (e) {
        log(`${PFX}Error loading templates: ${e}`, "error");
        return [];
    }
}

/**
 * Save all templates to storage
 * @param {Template[]} templates - Array of templates
 * @returns {Promise<boolean>}
 */
export async function saveTemplates(templates) {
    try {
        await browser.storage.local.set({ [STORAGE_KEY]: templates });
        log(`${PFX}Saved ${templates.length} templates to storage`);
        return true;
    } catch (e) {
        log(`${PFX}Error saving templates: ${e}`, "error");
        return false;
    }
}

/**
 * Get a single template by ID
 * @param {string} id - Template ID
 * @returns {Promise<Template|null>}
 */
export async function getTemplate(id) {
    const templates = await loadTemplates();
    return templates.find((t) => t.id === id) || null;
}

/**
 * Add a new template
 * @param {Partial<Template>} templateData - Template data
 * @returns {Promise<Template|null>}
 */
export async function addTemplate(templateData) {
    try {
        const templates = await loadTemplates();
        const newTemplate = createTemplate(templateData);
        templates.push(newTemplate);
        await saveTemplates(templates);
        log(`${PFX}Added template: ${newTemplate.name} (${newTemplate.id})`);
        return newTemplate;
    } catch (e) {
        log(`${PFX}Error adding template: ${e}`, "error");
        return null;
    }
}

/**
 * Update an existing template
 * @param {string} id - Template ID
 * @param {Partial<Template>} updates - Fields to update
 * @returns {Promise<Template|null>}
 */
export async function updateTemplate(id, updates) {
    try {
        const templates = await loadTemplates();
        const index = templates.findIndex((t) => t.id === id);

        if (index === -1) {
            log(`${PFX}Template not found: ${id}`, "warn");
            return null;
        }

        // Merge updates, preserving id and createdAt
        templates[index] = {
            ...templates[index],
            ...updates,
            id: templates[index].id,
            createdAt: templates[index].createdAt,
            updatedAt: getTimestamp(),
        };

        await saveTemplates(templates);
        log(`${PFX}Updated template: ${templates[index].name} (${id})`);
        return templates[index];
    } catch (e) {
        log(`${PFX}Error updating template: ${e}`, "error");
        return null;
    }
}

/**
 * Delete a template
 * @param {string} id - Template ID
 * @returns {Promise<boolean>}
 */
export async function deleteTemplate(id) {
    try {
        const templates = await loadTemplates();
        const index = templates.findIndex((t) => t.id === id);

        if (index === -1) {
            log(`${PFX}Template not found for deletion: ${id}`, "warn");
            return false;
        }

        const removed = templates.splice(index, 1)[0];
        await saveTemplates(templates);
        log(`${PFX}Deleted template: ${removed.name} (${id})`);
        return true;
    } catch (e) {
        log(`${PFX}Error deleting template: ${e}`, "error");
        return false;
    }
}

/**
 * Toggle template enabled state
 * @param {string} id - Template ID
 * @returns {Promise<boolean|null>} - New enabled state or null on error
 */
export async function toggleTemplate(id) {
    const template = await getTemplate(id);
    if (!template) {
        return null;
    }

    const updated = await updateTemplate(id, { enabled: !template.enabled });
    return updated ? updated.enabled : null;
}

/**
 * Get only enabled templates
 * @returns {Promise<Template[]>}
 */
export async function getEnabledTemplates() {
    const templates = await loadTemplates();
    return templates.filter((t) => t.enabled);
}

/**
 * Reorder templates
 * @param {string[]} orderedIds - Array of template IDs in desired order
 * @returns {Promise<boolean>}
 */
export async function reorderTemplates(orderedIds) {
    try {
        const templates = await loadTemplates();
        const templateMap = new Map(templates.map((t) => [t.id, t]));

        const reordered = [];
        for (const id of orderedIds) {
            const template = templateMap.get(id);
            if (template) {
                reordered.push(template);
                templateMap.delete(id);
            }
        }

        // Add any templates not in orderedIds at the end
        for (const template of templateMap.values()) {
            reordered.push(template);
        }

        await saveTemplates(reordered);
        log(`${PFX}Reordered ${reordered.length} templates`);
        return true;
    } catch (e) {
        log(`${PFX}Error reordering templates: ${e}`, "error");
        return false;
    }
}

/**
 * Export templates to JSON string
 * @param {string[]} [ids] - Optional array of IDs to export (exports all if not provided)
 * @returns {Promise<string>}
 */
export async function exportTemplates(ids) {
    const templates = await loadTemplates();
    const toExport = ids ? templates.filter((t) => ids.includes(t.id)) : templates;

    return JSON.stringify(toExport, null, 2);
}

/**
 * Import templates from JSON string
 * @param {string} json - JSON string containing template array
 * @param {boolean} [overwrite=false] - Whether to overwrite existing templates with same ID
 * @returns {Promise<{imported: number, skipped: number}>}
 */
export async function importTemplates(json, overwrite = false) {
    try {
        const imported = JSON.parse(json);

        if (!Array.isArray(imported)) {
            throw new Error("Invalid template data: expected array");
        }

        const templates = await loadTemplates();
        const existingIds = new Set(templates.map((t) => t.id));

        let importedCount = 0;
        let skippedCount = 0;

        for (const item of imported) {
            // Validate required fields
            if (!item.name || !item.id) {
                skippedCount++;
                continue;
            }

            // Clean up legacy fields
            delete item.source;
            delete item.author;

            if (existingIds.has(item.id)) {
                if (overwrite) {
                    const index = templates.findIndex((t) => t.id === item.id);
                    templates[index] = createTemplate({
                        ...item,
                        updatedAt: getTimestamp(),
                    });
                    importedCount++;
                } else {
                    // Generate new ID for duplicate
                    const newTemplate = createTemplate({
                        ...item,
                        id: generateId(),
                    });
                    templates.push(newTemplate);
                    importedCount++;
                }
            } else {
                templates.push(createTemplate(item));
                importedCount++;
            }
        }

        await saveTemplates(templates);
        log(`${PFX}Imported ${importedCount} templates, skipped ${skippedCount}`);

        return { imported: importedCount, skipped: skippedCount };
    } catch (e) {
        log(`${PFX}Error importing templates: ${e}`, "error");
        throw e;
    }
}

/**
 * Convert enabled templates to primed prompt format (for use in LLM prompts)
 * This reconstructs the markdown format expected by the existing system
 * @returns {Promise<string>}
 */
export async function getTemplatesAsPrimedPrompt() {
    const templates = await getEnabledTemplates();

    if (templates.length === 0) {
        return "";
    }

    const lines = [];
    lines.push("# Email template for standard replies (DO NOT EDIT/DELETE THIS SECTION HEADER)");

    for (const template of templates) {
        lines.push("");
        lines.push(`## ${template.name}`);

        for (const instruction of template.instructions) {
            lines.push(`- ${instruction}`);
        }

        if (template.exampleReply && template.exampleReply.trim()) {
            lines.push("- Example reply:");
            lines.push("```");
            lines.push(template.exampleReply);
            lines.push("```");
        }
    }

    return lines.join("\n");
}

/**
 * Check if templates have been migrated from legacy format
 * @returns {Promise<boolean>}
 */
export async function hasMigratedTemplates() {
    try {
        const result = await browser.storage.local.get("templates_migrated");
        return result.templates_migrated === true;
    } catch (e) {
        return false;
    }
}

/**
 * Mark templates as migrated
 * @returns {Promise<void>}
 */
export async function markTemplatesMigrated() {
    await browser.storage.local.set({ templates_migrated: true });
}

/**
 * Get available categories
 * @returns {string[]}
 */
export function getCategories() {
    return ["standard-replies", "writing-style", "signatures", "custom"];
}

/**
 * Load default templates from bundled JSON file
 * @returns {Promise<Template[]>}
 */
async function loadDefaultTemplates() {
    try {
        const url = browser.runtime.getURL("templates/default_templates.json");
        const resp = await fetch(url);
        if (!resp.ok) {
            log(`${PFX}Failed to load default templates: ${resp.status}`, "warn");
            return [];
        }
        const templates = await resp.json();
        log(`${PFX}Loaded ${templates.length} default templates from bundled JSON`);
        return templates;
    } catch (e) {
        log(`${PFX}Error loading default templates: ${e}`, "error");
        return [];
    }
}

/**
 * Initialize templates with defaults if not already done.
 * This loads templates from the bundled default_templates.json file.
 *
 * @returns {Promise<{initialized: number}>}
 */
export async function initializeDefaultTemplates() {
    // Check if already migrated/initialized
    if (await hasMigratedTemplates()) {
        log(`${PFX}Templates already initialized, skipping`);
        return { initialized: 0 };
    }

    try {
        // Load default templates from bundled JSON
        const defaultTemplates = await loadDefaultTemplates();

        if (defaultTemplates.length === 0) {
            log(`${PFX}No default templates found`);
            await markTemplatesMigrated();
            return { initialized: 0 };
        }

        // Save default templates
        await saveTemplates(defaultTemplates);
        await markTemplatesMigrated();

        log(`${PFX}Initialization complete: ${defaultTemplates.length} templates loaded`);
        return { initialized: defaultTemplates.length };
    } catch (e) {
        log(`${PFX}Template initialization failed: ${e}`, "error");
        throw e;
    }
}

/**
 * Ensure default templates are loaded for new users (called on startup)
 * @returns {Promise<void>}
 */
export async function ensureMigration() {
    const initialized = await hasMigratedTemplates();
    log(`${PFX}ensureMigration: templates_initialized=${initialized}`);

    if (!initialized) {
        log(`${PFX}First-time setup: loading default templates...`);
        await initializeDefaultTemplates();
    }
}

/**
 * Reset templates to defaults by clearing storage and reloading from bundled JSON
 * @returns {Promise<number>} - Number of default templates loaded
 */
export async function resetToDefaultTemplates() {
    try {
        // Clear the migration flag so defaults will be reloaded
        await browser.storage.local.remove(["templates_migrated", STORAGE_KEY]);
        log(`${PFX}Cleared templates storage`);

        // Reload defaults
        const defaultTemplates = await loadDefaultTemplates();

        if (defaultTemplates.length === 0) {
            log(`${PFX}No default templates found`);
            await markTemplatesMigrated();
            return 0;
        }

        // Save default templates
        await saveTemplates(defaultTemplates);
        await markTemplatesMigrated();

        log(`${PFX}Reset to ${defaultTemplates.length} default templates`);
        return defaultTemplates.length;
    } catch (e) {
        log(`${PFX}Reset to defaults failed: ${e}`, "error");
        throw e;
    }
}
