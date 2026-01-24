import { ensureMigration, getTemplatesAsPrimedPrompt } from "./templateManager.js";
import { log, normalizeUnicode } from "./utils.js";

const PROMPTS_DIR = "prompts";
const PFX = "[PromptGen] ";

/**
 * Resolves an extension relative URL for a given prompt file name and returns
 * its textual contents.
 *
 * All prompt templates live under `prompts` and are bundled with the
 * extension at build time.  We intentionally keep the markdown files separate
 * from the JS bundle to satisfy the repository guideline of avoiding large
 * inline strings in code.
 *
 * @param {string} filename – File name *with* extension (e.g. "system_autocomplete.md").
 * @returns {Promise<string|null>} – File contents or null if missing.
 */
async function _loadTemplateFile(filename) {
    try {
        const url = browser.runtime.getURL(`${PROMPTS_DIR}/${filename}`);
        const resp = await fetch(url);
        if (!resp.ok) {
            log(`${PFX}Prompt file not found: ${filename} (status=${resp.status})`, "warn");
            return null;
        }
        const text = await resp.text();
        return normalizeUnicode(text.trim());
    } catch (e) {
        log(`${PFX}Error loading prompt file ${filename}: ${e}`, "error");
        return null;
    }
}

/**
 * Get the base composition prompt (without templates section).
 * This returns only the writing style, language, and useful links sections.
 * @returns {Promise<string>}
 */
async function _getBaseCompositionPrompt() {
    const name = "user_composition.md";
    const key = `user_prompts:${name}`;
    try {
        let content = "";
        const obj = await browser.storage.local.get(key);
        if (obj && typeof obj[key] === "string" && obj[key].trim()) {
            content = normalizeUnicode(obj[key].trim());
        } else {
            log(`${PFX}${name} not present in storage.local – initializing from bundled template.`);
            const bundled = (await _loadTemplateFile(name)) || "";
            try {
                await browser.storage.local.set({ [key]: bundled });
                log(`${PFX}Initialized ${name} in storage.local (${bundled.length} chars).`);
            } catch (e) {
                log(`${PFX}Failed to persist ${name} in storage.local: ${e}`, "error");
            }
            content = bundled;
        }

        // Remove the templates section from the base content
        // Keep everything up to and excluding the "Email template for standard replies" section
        const lines = content.split("\n");
        const filteredLines = [];
        let skipTemplateSection = false;

        for (const line of lines) {
            // Check for template section header
            if (
                line.includes("Email template for standard replies") &&
                line.includes("DO NOT EDIT/DELETE THIS SECTION HEADER")
            ) {
                skipTemplateSection = true;
                continue;
            }

            // Check for end markers or next section (stop skipping)
            if (skipTemplateSection) {
                if (line.trim() === "====END USER INSTRUCTIONS====") {
                    // Keep the end marker and everything after
                    skipTemplateSection = false;
                    filteredLines.push(line);
                    continue;
                }
                // Check for other section headers (would mean templates section ended)
                if (line.match(/^#\s+.+\(DO NOT EDIT\/DELETE THIS SECTION HEADER\)/)) {
                    skipTemplateSection = false;
                    filteredLines.push(line);
                    continue;
                }
                // Skip template content
                continue;
            }

            filteredLines.push(line);
        }

        return filteredLines.join("\n");
    } catch (e) {
        log(`${PFX}Error accessing storage.local for ${name}: ${e}`, "error");
        return "";
    }
}

/**
 * Get the full composition prompt including JSON templates.
 * This combines the base prompt (writing style, language, links)
 * with templates from the new JSON storage.
 * @returns {Promise<string>}
 */
export async function getUserCompositionPrompt() {
    try {
        // Ensure templates are migrated from legacy format
        await ensureMigration();

        // Get base prompt (without templates section)
        const basePrompt = await _getBaseCompositionPrompt();

        // Get templates as primed prompt
        const templatesPrompt = await getTemplatesAsPrimedPrompt();

        // If no templates, just return base prompt
        if (!templatesPrompt) {
            return basePrompt;
        }

        // Insert templates before the end marker
        const endMarker = "====END USER INSTRUCTIONS====";
        const endIndex = basePrompt.indexOf(endMarker);

        if (endIndex !== -1) {
            // Insert templates before the end marker
            const beforeEnd = basePrompt.substring(0, endIndex).trimEnd();
            const afterEnd = basePrompt.substring(endIndex);
            return `${beforeEnd}\n\n${templatesPrompt}\n\n${afterEnd}`;
        } else {
            // No end marker, just append
            return `${basePrompt}\n\n${templatesPrompt}`;
        }
    } catch (e) {
        log(`${PFX}Error building composition prompt: ${e}`, "error");
        // Fall back to legacy behavior
        const name = "user_composition.md";
        const key = `user_prompts:${name}`;
        try {
            const obj = await browser.storage.local.get(key);
            if (obj && typeof obj[key] === "string" && obj[key].trim()) {
                return normalizeUnicode(obj[key].trim());
            }
        } catch (e2) {
            log(`${PFX}Fallback also failed: ${e2}`, "error");
        }
        return "";
    }
}

export async function getUserActionPrompt() {
    const name = "user_action.md";
    const key = `user_prompts:${name}`;
    try {
        const obj = await browser.storage.local.get(key);
        if (obj && typeof obj[key] === "string" && obj[key].trim()) {
            return normalizeUnicode(obj[key].trim());
        }
        log(`${PFX}${name} not present in storage.local – initializing from bundled template.`);
        const bundled = (await _loadTemplateFile(name)) || "";
        try {
            await browser.storage.local.set({ [key]: bundled });
            log(`${PFX}Initialized ${name} in storage.local (${bundled.length} chars).`);
        } catch (e) {
            log(`${PFX}Failed to persist ${name} in storage.local: ${e}`, "error");
        }
        return bundled;
    } catch (e) {
        log(`${PFX}Error accessing storage.local for ${name}: ${e}`, "error");
        return "";
    }
}

export async function getUserKBPrompt() {
    const name = "user_kb.md";
    const key = `user_prompts:${name}`;
    try {
        const obj = await browser.storage.local.get(key);
        if (obj && typeof obj[key] === "string" && obj[key].trim()) {
            return normalizeUnicode(obj[key].trim());
        }
        log(`${PFX}${name} not present in storage.local – initializing from bundled template.`);
        const bundled = (await _loadTemplateFile(name)) || "";
        try {
            await browser.storage.local.set({ [key]: bundled });
            log(`${PFX}Initialized ${name} in storage.local (${bundled.length} chars).`);
        } catch (e) {
            log(`${PFX}Failed to persist ${name} in storage.local: ${e}`, "error");
        }
        return bundled;
    } catch (e) {
        log(`${PFX}Error accessing storage.local for ${name}: ${e}`, "error");
        return "";
    }
}

