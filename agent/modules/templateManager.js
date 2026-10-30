/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
        deleted: partial.deleted || false,
        deletedAt: partial.deletedAt || null,
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
 * The one way to change the stored templates (DS-SEMAPHORE): in one hold of the device's prompt semaphore,
 * the stored list (tombstones included) is read, `change(templates)` run on a copy, and what it returns as
 * `save` written as the whole list, checked at the write. From a page the hold is the background's, reached
 * by runtime message. Throws when the hold ended before the save (`changed`) or the semaphore stayed held
 * (`busy`), with nothing saved.
 * @param {string} label - What writes, for the logs
 * @param {(templates: Template[]) => { save: Template[]|null, result: any }} change - `save` null saves nothing
 * @returns {Promise<any>} - the `result` of `change`
 */
async function editTemplates(label, change) {
    const { withPromptStore } = await import("./promptStore.js");
    return withPromptStore(async (store) => {
        const { templates } = await store.templates();
        const { save, result } = change(templates);
        if (save) {
            await store.saveTemplates(save);
            log(`${PFX}Saved ${save.length} templates (${label})`);
        }
        return result;
    }, { label });
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
        const newTemplate = createTemplate(templateData);
        await editTemplates("template add", (templates) => ({ save: [...templates, newTemplate], result: null }));
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
        const updated = await editTemplates("template update", (templates) => {
            const index = templates.findIndex((t) => t.id === id);
            if (index === -1) return { save: null, result: null };
            // Merge updates, preserving id and createdAt
            const next = [...templates];
            next[index] = {
                ...templates[index],
                ...updates,
                id: templates[index].id,
                createdAt: templates[index].createdAt,
                updatedAt: getTimestamp(),
            };
            return { save: next, result: next[index] };
        });
        if (!updated) {
            log(`${PFX}Template not found: ${id}`, "warn");
            return null;
        }
        log(`${PFX}Updated template: ${updated.name} (${id})`);
        return updated;
    } catch (e) {
        log(`${PFX}Error updating template: ${e}`, "error");
        return null;
    }
}

/**
 * Delete a template (soft-delete: sets deleted=true for device sync propagation).
 * @param {string} id - Template ID
 * @returns {Promise<boolean>}
 */
export async function deleteTemplate(id) {
    try {
        const deleted = await editTemplates("template delete", (templates) => {
            const index = templates.findIndex((t) => t.id === id);
            if (index === -1) return { save: null, result: null };
            const now = getTimestamp();
            const next = [...templates];
            next[index] = { ...templates[index], deleted: true, deletedAt: now, updatedAt: now };
            return { save: next, result: next[index] };
        });
        if (!deleted) {
            log(`${PFX}Template not found for deletion: ${id}`, "warn");
            return false;
        }
        log(`${PFX}Soft-deleted template: ${deleted.name} (${id})`);
        return true;
    } catch (e) {
        log(`${PFX}Error deleting template: ${e}`, "error");
        return false;
    }
}

/**
 * Get only enabled (and non-deleted) templates
 * @returns {Promise<Template[]>}
 */
export async function getEnabledTemplates() {
    const templates = await loadTemplates();
    return templates.filter((t) => t.enabled && !t.deleted);
}

/**
 * Get visible (non-deleted) templates for UI display.
 * @returns {Promise<Template[]>}
 */
export async function getVisibleTemplates() {
    const templates = await loadTemplates();
    return templates.filter((t) => !t.deleted);
}

/**
 * Per-template CRDT merge: index by id, newer updatedAt wins. Run by Device Sync inside its hold of the
 * prompt semaphore, `store`. Throws a `changed` error, with nothing saved, when that hold ended first.
 * @param {Template[]} incoming - Incoming templates from device sync
 * @param {PromptStoreHold} store - The hold it runs in
 * @returns {Promise<void>}
 */
export async function mergeTemplates(incoming, store) {
    if (!Array.isArray(incoming) || incoming.length === 0) return;

    const { templates: local } = await store.templates();
    const merged = new Map();

    // Index local templates by id
    for (const t of local) {
        if (t.id) merged.set(t.id, t);
    }

    // Merge incoming: newer updatedAt wins per id
    let adopted = 0;
    for (const inc of incoming) {
        if (!inc.id) continue;
        // Ensure defaults for any missing fields (e.g., deleted, createdAt from old peers)
        const normalized = createTemplate(inc);
        const existing = merged.get(inc.id);
        if (!existing) {
            // New from peer
            merged.set(inc.id, normalized);
            adopted++;
        } else {
            const incTs = normalized.updatedAt || "";
            const localTs = existing.updatedAt || "";
            if (incTs > localTs) {
                merged.set(inc.id, normalized);
                adopted++;
            }
        }
    }

    if (adopted > 0) {
        await store.saveTemplates(Array.from(merged.values()));
        log(`${PFX}CRDT merge: ${adopted} templates adopted from ${incoming.length} incoming (local total: ${merged.size})`);
    } else {
        log(`${PFX}CRDT merge: 0 templates adopted from ${incoming.length} incoming`);
    }
}

/**
 * GC deleted template tombstones older than 90 days. Run by Device Sync inside its hold of the prompt
 * semaphore, `store`. Throws a `changed` error, with nothing saved, when that hold ended first.
 * @param {PromptStoreHold} store - The hold it runs in
 */
export async function gcDeletedTemplates(store) {
    const { templates } = await store.templates();
    const now = Date.now();
    const maxAge = 90 * 86400 * 1000;
    let removed = 0;

    const filtered = templates.filter((t) => {
        if (t.deleted && t.deletedAt) {
            const deletedTime = new Date(t.deletedAt).getTime();
            if (now - deletedTime > maxAge) {
                removed++;
                return false;
            }
        }
        return true;
    });

    if (removed > 0) {
        await store.saveTemplates(filtered);
        log(`${PFX}GC removed ${removed} deleted template tombstones older than 90 days`);
    }
}

/**
 * Reorder templates
 * @param {string[]} orderedIds - Array of template IDs in desired order
 * @returns {Promise<boolean>}
 */
export async function reorderTemplates(orderedIds) {
    try {
        const count = await editTemplates("template reorder", (templates) => {
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
            return { save: reordered, result: reordered.length };
        });
        log(`${PFX}Reordered ${count} templates`);
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

        const counts = await editTemplates("template import", (stored) => {
            const templates = [...stored];
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

            return { save: templates, result: { imported: importedCount, skipped: skippedCount } };
        });
        log(`${PFX}Imported ${counts.imported} templates, skipped ${counts.skipped}`);

        return counts;
    } catch (e) {
        log(`${PFX}Error importing templates: ${e}`, "error");
        throw e;
    }
}

/**
 * Removes visible templates whose id repeats an earlier visible one (the first kept), from the stored list
 * as it is in the hold, tombstones kept after them. Saves only when one was removed.
 * @returns {Promise<{templates: Template[], removed: number}>} - the visible templates after, and how many were removed
 */
export async function dedupeTemplates() {
    const result = await editTemplates("template duplicate clean-up", (templates) => {
        const seen = new Set();
        const visible = [];
        let removed = 0;
        for (const template of templates.filter((t) => !t.deleted)) {
            if (seen.has(template.id)) {
                log(`${PFX}Found duplicate template: ${template.name} (${template.id})`);
                removed++;
            } else {
                seen.add(template.id);
                visible.push(template);
            }
        }
        const save = removed > 0 ? [...visible, ...templates.filter((t) => t.deleted)] : null;
        return { save, result: { templates: visible, removed } };
    });
    if (result.removed > 0) log(`${PFX}Removed ${result.removed} duplicate templates`);
    return result;
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
 * This loads templates from the bundled default_templates.json file. In one hold of the prompt semaphore
 * the defaults the stored list lacks (by id) are added after it, saved with the flag: a template saved
 * before this ran is kept, and a second run adds nothing.
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
        // Load default templates from bundled JSON (before the hold: the hold never waits on a fetch)
        const defaultTemplates = await loadDefaultTemplates();

        const { withPromptStore } = await import("./promptStore.js");
        const initialized = await withPromptStore(async (store) => {
            const { templates } = await store.templates();
            const ids = new Set(templates.map((t) => t.id));
            const added = defaultTemplates.filter((t) => !ids.has(t.id));
            await store.saveTemplates([...templates, ...added], { migrated: true });
            return added.length;
        }, { label: "template first-run defaults" });

        log(`${PFX}Initialization complete: ${initialized} templates loaded`);
        return { initialized };
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
        // Reload defaults. The migration flag stays set: a reset refused (the prompt store stayed busy) must
        // not leave a startup to replace the user's templates with the defaults.
        const defaultTemplates = await loadDefaultTemplates();

        // Use epoch-zero timestamp so defaults never overwrite customized
        // templates on other devices via device sync
        const { resetFieldToDefault } = await import("./deviceSync.js");
        await resetFieldToDefault("templates", defaultTemplates.length > 0 ? defaultTemplates : []);
        await markTemplatesMigrated();

        log(`${PFX}Reset to ${defaultTemplates.length} default templates (epoch-zero timestamp)`);
        return defaultTemplates.length;
    } catch (e) {
        log(`${PFX}Reset to defaults failed: ${e}`, "error");
        throw e;
    }
}
