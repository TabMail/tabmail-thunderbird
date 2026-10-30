/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ensureMigration, getTemplatesAsPrimedPrompt } from "./templateManager.js";
import { log, normalizeUnicode } from "./utils.js";

const PFX = "[PromptGen] ";

/**
 * `field`'s text through the prompt store: never read from storage directly. While the prompt store
 * stays busy, nothing is returned ("") and the stored text is never used.
 * @param {"composition" | "action" | "kb"} field
 * @returns {Promise<string|null>} the text, or null when the read was refused
 */
async function _readField(field) {
    try {
        const { readText } = await import("./promptStore.js");
        return normalizeUnicode((await readText(field)).trim());
    } catch (e) {
        log(`${PFX}${field} not read: ${e}`, "warn");
        return null;
    }
}

/**
 * Get the base composition prompt (without templates section).
 * This returns only the writing style, language, and useful links sections.
 * @returns {Promise<string|null>} null when the read was refused
 */
async function _getBaseCompositionPrompt() {
    const content = await _readField("composition");
    if (content === null) return null;

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
}

/**
 * Get the full composition prompt including JSON templates.
 * This combines the base prompt (writing style, language, links)
 * with templates from the new JSON storage. Empty when the read was refused (the store stayed busy).
 * @returns {Promise<string>}
 */
export async function getUserCompositionPrompt() {
    // Get base prompt (without templates section)
    const basePrompt = await _getBaseCompositionPrompt();
    if (basePrompt === null) return "";
    try {
        // Ensure templates are migrated from legacy format
        await ensureMigration();

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
        log(`${PFX}Error adding the templates to the composition prompt: ${e}`, "error");
        return basePrompt;
    }
}

/** The action rules, through the prompt store; "" when the read was refused. */
export async function getUserActionPrompt() {
    return (await _readField("action")) ?? "";
}

/** The knowledge base, through the prompt store; "" when the read was refused. */
export async function getUserKBPrompt() {
    return (await _readField("kb")) ?? "";
}
