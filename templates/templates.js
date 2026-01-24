/**
 * TabMail Templates Page
 *
 * Manages email templates via left-right panel UI.
 * Communicates with background script for storage operations.
 * Supports template marketplace for sharing and downloading templates.
 */

import { getTemplateWorkerUrl } from "../agent/modules/config.js";
import { log } from "../agent/modules/utils.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";

// Inject TabMail palette CSS
injectPaletteIntoDocument(document)
    .then(() => {
        console.log("[Templates] Palette CSS injected");
    })
    .catch((e) => {
        console.warn("[Templates] Failed to inject palette CSS:", e);
    });

const PFX = "[Templates] ";

// State
let templates = [];
let selectedTemplateId = null;
let hasUnsavedChanges = false;

// Marketplace state
let marketplaceTemplates = [];
let marketplaceOffset = 0;
let marketplaceHasMore = false;
let marketplaceSearchTerm = "";
let marketplaceSort = "popular";
let installedTemplateIds = new Set();

/**
 * Auto-grow textarea to fit content
 * @param {HTMLTextAreaElement} textarea
 * @param {boolean} isBulletInput - Whether this is a bullet list input (starts single-line)
 */
function autoGrowTextarea(textarea, isBulletInput = false) {
    if (isBulletInput) {
        // For bullet inputs, calculate exact single-line height
        const computed = window.getComputedStyle(textarea);
        const paddingTop = parseFloat(computed.paddingTop) || 10;
        const paddingBottom = parseFloat(computed.paddingBottom) || 10;
        const fontSize = parseFloat(computed.fontSize) || 14;
        const lineHeightValue = parseFloat(computed.lineHeight);
        // If line-height is a number (not px), multiply by font-size
        const lineHeight = lineHeightValue > 10 ? lineHeightValue : lineHeightValue * fontSize;
        const borderTop = parseFloat(computed.borderTopWidth) || 1;
        const borderBottom = parseFloat(computed.borderBottomWidth) || 1;
        
        // Calculate exact single-line height
        const singleLineHeight = paddingTop + paddingBottom + lineHeight + borderTop + borderBottom;
        
        // Set to single-line height first (this ensures empty textarea is single-line)
        textarea.style.height = `${singleLineHeight}px`;
        
        // Now measure actual content height needed
        const contentHeight = textarea.scrollHeight;
        
        // Use the larger of content height or calculated single-line height
        const finalHeight = Math.max(contentHeight, singleLineHeight);
        textarea.style.height = `${finalHeight}px`;
    } else {
        // Reset height to recalculate
        textarea.style.height = "auto";
        // Set to scrollHeight + 2px to ensure there's always room for one more line
        textarea.style.height = `${textarea.scrollHeight + 2}px`;
    }
}

// DOM Elements
let templateListEl;
let editorEmptyEl;
let editorFormEl;
let editorActionsEl;
let editorTitleEl;
let nameInput;
let instructionsListEl;
let contentTextarea;

/**
 * Initialize the page
 */
async function initialize() {
    // Cache DOM elements
    templateListEl = document.getElementById("template-list");
    editorEmptyEl = document.getElementById("editor-empty");
    editorFormEl = document.getElementById("editor-form");
    editorActionsEl = document.getElementById("editor-actions");
    editorTitleEl = document.getElementById("editor-title");
    nameInput = document.getElementById("template-name");
    instructionsListEl = document.getElementById("instructions-list");
    contentTextarea = document.getElementById("template-content");

    // Set up event listeners
    setupEventListeners();

    // Load templates
    await loadTemplates();

    log(`${PFX}Initialized`);
}

/**
 * Render instructions as a bullet list
 * @param {string[]} instructions - Array of instruction strings
 */
function renderInstructionsList(instructions) {
    instructionsListEl.innerHTML = "";

    if (instructions.length === 0) {
        // Show empty state placeholder
        const emptyEl = document.createElement("div");
        emptyEl.className = "bullet-list-empty";
        emptyEl.textContent = "No instructions yet. Click \"+ Add instruction\" below.";
        instructionsListEl.appendChild(emptyEl);
        return;
    }

    instructions.forEach((instruction, index) => {
        const item = createInstructionItem(instruction, index);
        instructionsListEl.appendChild(item);
    });
}

/**
 * Create an instruction list item
 * @param {string} value - Instruction text
 * @param {number} index - Index in the list
 * @returns {HTMLElement}
 */
function createInstructionItem(value, index) {
    const item = document.createElement("div");
    item.className = "bullet-item";
    item.dataset.index = index;

    // Bullet prefix
    const bullet = document.createElement("span");
    bullet.className = "bullet-prefix";
    bullet.textContent = "•";

    // Textarea field (multiline, auto-grow)
    const textarea = document.createElement("textarea");
    textarea.className = "bullet-input";
    textarea.value = value;
    textarea.placeholder = "Enter instruction...";
    // Don't set rows - we control height via CSS and JS
    textarea.addEventListener("input", () => {
        autoGrowTextarea(textarea, true);
        onFormChange();
    });

    // Initial auto-grow after DOM insertion
    requestAnimationFrame(() => autoGrowTextarea(textarea, true));

    // Remove button
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "bullet-remove-btn";
    removeBtn.innerHTML = "×";
    removeBtn.title = "Remove instruction";
    removeBtn.addEventListener("click", () => removeInstruction(index));

    item.appendChild(bullet);
    item.appendChild(textarea);
    item.appendChild(removeBtn);

    return item;
}

/**
 * Get all instructions from the list
 * @returns {string[]}
 */
function getInstructionsFromList() {
    const inputs = instructionsListEl.querySelectorAll(".bullet-input");
    const instructions = [];
    inputs.forEach((input) => {
        const value = input.value.trim();
        if (value) {
            instructions.push(value);
        }
    });
    return instructions;
}

/**
 * Add a new instruction to the list
 */
function addInstruction() {
    const instructions = getInstructionsFromList();
    instructions.push("");
    renderInstructionsList(instructions);
    onFormChange();

    // Focus the new input
    const inputs = instructionsListEl.querySelectorAll(".bullet-input");
    if (inputs.length > 0) {
        inputs[inputs.length - 1].focus();
    }
}

/**
 * Remove an instruction from the list
 * @param {number} index - Index to remove
 */
function removeInstruction(index) {
    const instructions = getInstructionsFromList();
    // Re-get the actual values before removal since indices might have changed
    const items = instructionsListEl.querySelectorAll(".bullet-item");
    const newInstructions = [];
    items.forEach((item, i) => {
        if (i !== index) {
            const input = item.querySelector(".bullet-input");
            if (input) {
                newInstructions.push(input.value);
            }
        }
    });
    renderInstructionsList(newInstructions);
    onFormChange();
}

/**
 * Set up all event listeners
 */
function setupEventListeners() {
    // Add template button
    document.getElementById("add-template-btn").addEventListener("click", addNewTemplate);

    // Get more templates button
    document.getElementById("get-more-templates-btn").addEventListener("click", showMarketplaceDialog);

    // Editor buttons
    document.getElementById("save-template-btn").addEventListener("click", saveCurrentTemplate);
    document.getElementById("share-template-btn").addEventListener("click", showShareDialog);
    document.getElementById("duplicate-template-btn").addEventListener("click", duplicateCurrentTemplate);
    document.getElementById("delete-template-btn").addEventListener("click", deleteCurrentTemplate);

    // Import/Export/Reset buttons
    document.getElementById("import-templates-btn").addEventListener("click", showImportDialog);
    document.getElementById("export-templates-btn").addEventListener("click", exportAllTemplates);
    document.getElementById("reset-templates-btn").addEventListener("click", resetToDefaults);

    // Refresh templates when page becomes visible (e.g., returning from marketplace tab)
    document.addEventListener("visibilitychange", onVisibilityChange);

    // Listen for storage changes to detect template updates from other tabs
    browser.storage.onChanged.addListener(onStorageChange);

    // Import dialog
    document.getElementById("import-cancel-btn").addEventListener("click", hideImportDialog);
    document.getElementById("import-confirm-btn").addEventListener("click", confirmImport);

    // Marketplace dialog
    document.getElementById("marketplace-close-btn").addEventListener("click", hideMarketplaceDialog);
    document.getElementById("marketplace-search").addEventListener("input", debounce(onMarketplaceSearch, 300));
    document.getElementById("marketplace-sort").addEventListener("change", onMarketplaceSortChange);
    document.getElementById("marketplace-retry-btn").addEventListener("click", loadMarketplaceTemplates);
    document.getElementById("marketplace-load-more").addEventListener("click", loadMoreMarketplaceTemplates);

    // Share dialog
    document.getElementById("share-cancel-btn").addEventListener("click", hideShareDialog);
    document.getElementById("share-confirm-btn").addEventListener("click", confirmShareTemplate);
    document.getElementById("share-guidelines-agree").addEventListener("change", onGuidelinesCheckboxChange);

    // Form input handlers (track changes + auto-grow)
    nameInput.addEventListener("input", onFormChange);
    // Instructions list is handled via renderInstructionsList
    document.getElementById("add-instruction-btn").addEventListener("click", addInstruction);
    contentTextarea.addEventListener("input", () => {
        onFormChange();
        autoGrowTextarea(contentTextarea);
    });

    // Keyboard shortcuts
    document.addEventListener("keydown", handleKeydown);

    // Warn on unsaved changes
    window.addEventListener("beforeunload", (e) => {
        if (hasUnsavedChanges) {
            e.preventDefault();
            e.returnValue = "";
        }
    });
}

/**
 * Handle keyboard shortcuts
 */
function handleKeydown(e) {
    const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const ctrlKey = isMac ? e.metaKey : e.ctrlKey;

    // Ctrl/Cmd+S to save
    if (ctrlKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (selectedTemplateId) {
            saveCurrentTemplate();
        }
    }
}

/**
 * Handle visibility change - refresh templates when page becomes visible
 * This ensures we pick up templates installed from marketplace
 */
async function onVisibilityChange() {
    if (document.visibilityState === "visible") {
        log(`${PFX}Page became visible, refreshing templates...`);
        await loadTemplates();
    }
}

/**
 * Handle storage changes - refresh templates if they changed from another tab
 */
async function onStorageChange(changes, areaName) {
    if (areaName === "local" && changes.user_templates) {
        log(`${PFX}Templates changed in storage, refreshing...`);
        await loadTemplates();
    }
}

/**
 * Load templates from storage via background script
 */
async function loadTemplates() {
    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-load",
        });

        if (response && response.ok && Array.isArray(response.templates)) {
            templates = response.templates;
            
            // Deduplicate templates by ID (keep first occurrence)
            const deduplicationResult = deduplicateTemplates(templates);
            if (deduplicationResult.hadDuplicates) {
                templates = deduplicationResult.templates;
                log(`${PFX}Cleaned up ${deduplicationResult.removedCount} duplicate templates`);
                // Save the cleaned list back to storage
                await browser.runtime.sendMessage({
                    command: "templates-save-all",
                    templates: templates,
                });
            }
            
            renderTemplateList();
            log(`${PFX}Loaded ${templates.length} templates`);
        } else {
            throw new Error(response?.error || "Failed to load templates");
        }
    } catch (e) {
        log(`${PFX}Error loading templates: ${e}`, "error");
        showStatus("Failed to load templates", true);
    }
}

/**
 * Remove duplicate templates by ID, keeping the first occurrence
 * @param {Array} templateList - Array of templates
 * @returns {{templates: Array, hadDuplicates: boolean, removedCount: number}}
 */
function deduplicateTemplates(templateList) {
    const seen = new Set();
    const deduplicated = [];
    let removedCount = 0;
    
    for (const template of templateList) {
        if (seen.has(template.id)) {
            log(`${PFX}Found duplicate template: ${template.name} (${template.id})`);
            removedCount++;
        } else {
            seen.add(template.id);
            deduplicated.push(template);
        }
    }
    
    return {
        templates: deduplicated,
        hadDuplicates: removedCount > 0,
        removedCount,
    };
}

/**
 * Render the template list
 */
function renderTemplateList() {
    templateListEl.innerHTML = "";

    if (templates.length === 0) {
        templateListEl.innerHTML = `
      <div class="template-list-empty">
        <p>No templates yet</p>
        <p class="hint">Click "Add" to create your first template</p>
      </div>
    `;
        return;
    }

    for (const template of templates) {
        const item = createTemplateListItem(template);
        templateListEl.appendChild(item);
    }
}

// Drag-and-drop state
let draggedElement = null;
let draggedTemplateId = null;

/**
 * Handle drag start on template list item
 */
function onDragStart(e, templateId) {
    draggedElement = e.target.closest(".template-list-item");
    draggedTemplateId = templateId;
    draggedElement.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", templateId);
    log(`${PFX}Drag start: ${templateId}`);
}

/**
 * Handle drag end
 */
function onDragEnd(e) {
    if (draggedElement) {
        draggedElement.classList.remove("dragging");
    }
    draggedElement = null;
    draggedTemplateId = null;
    
    // Remove all drag-over indicators
    document.querySelectorAll(".template-list-item.drag-over").forEach((el) => {
        el.classList.remove("drag-over");
    });
}

/**
 * Handle drag over on template list item
 */
function onDragOver(e, templateId) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    
    const targetItem = e.target.closest(".template-list-item");
    if (targetItem && targetItem.dataset.id !== draggedTemplateId) {
        // Remove drag-over from all items
        document.querySelectorAll(".template-list-item.drag-over").forEach((el) => {
            el.classList.remove("drag-over");
        });
        targetItem.classList.add("drag-over");
    }
}

/**
 * Handle drag leave on template list item
 */
function onDragLeave(e) {
    const targetItem = e.target.closest(".template-list-item");
    if (targetItem && !targetItem.contains(e.relatedTarget)) {
        targetItem.classList.remove("drag-over");
    }
}

/**
 * Handle drop on template list item
 */
async function onDrop(e, targetTemplateId) {
    e.preventDefault();
    
    // Remove all drag-over indicators
    document.querySelectorAll(".template-list-item.drag-over").forEach((el) => {
        el.classList.remove("drag-over");
    });
    
    if (!draggedTemplateId || draggedTemplateId === targetTemplateId) {
        return;
    }
    
    log(`${PFX}Drop: ${draggedTemplateId} onto ${targetTemplateId}`);
    
    // Find indices
    const fromIndex = templates.findIndex((t) => t.id === draggedTemplateId);
    const toIndex = templates.findIndex((t) => t.id === targetTemplateId);
    
    if (fromIndex === -1 || toIndex === -1) {
        return;
    }
    
    // Reorder in local state
    const [movedTemplate] = templates.splice(fromIndex, 1);
    templates.splice(toIndex, 0, movedTemplate);
    
    // Re-render immediately for visual feedback
    renderTemplateList();
    
    // Re-select if needed
    if (selectedTemplateId) {
        document.querySelectorAll(".template-list-item").forEach((item) => {
            item.classList.toggle("selected", item.dataset.id === selectedTemplateId);
        });
    }
    
    // Save to backend
    try {
        const orderedIds = templates.map((t) => t.id);
        const response = await browser.runtime.sendMessage({
            command: "templates-reorder",
            orderedIds,
        });
        
        if (response && response.ok) {
            log(`${PFX}Reordered templates saved`);
            showStatus("Template order saved");
        } else {
            throw new Error(response?.error || "Failed to save order");
        }
    } catch (e) {
        log(`${PFX}Error saving template order: ${e}`, "error");
        showStatus("Failed to save template order", true);
        // Reload to restore correct order
        await loadTemplates();
    }
}

/**
 * Create a template list item element
 */
function createTemplateListItem(template) {
    const item = document.createElement("div");
    item.className = "template-list-item";
    item.dataset.id = template.id;

    if (template.id === selectedTemplateId) {
        item.classList.add("selected");
    }
    if (!template.enabled) {
        item.classList.add("disabled");
    }

    // Enable drag-drop
    item.draggable = true;
    item.addEventListener("dragstart", (e) => onDragStart(e, template.id));
    item.addEventListener("dragend", onDragEnd);
    item.addEventListener("dragover", (e) => onDragOver(e, template.id));
    item.addEventListener("dragleave", onDragLeave);
    item.addEventListener("drop", (e) => onDrop(e, template.id));

    // Drag handle
    const dragHandle = document.createElement("div");
    dragHandle.className = "template-drag-handle";
    dragHandle.innerHTML = "⋮⋮";
    dragHandle.title = "Drag to reorder";

    // Checkbox
    const checkbox = document.createElement("div");
    checkbox.className = "template-checkbox";
    const checkInput = document.createElement("input");
    checkInput.type = "checkbox";
    checkInput.checked = template.enabled;
    checkInput.title = template.enabled ? "Disable template" : "Enable template";
    checkInput.addEventListener("click", (e) => {
        e.stopPropagation();
    });
    checkInput.addEventListener("change", async () => {
        await toggleTemplateEnabled(template.id, checkInput.checked);
    });
    checkbox.appendChild(checkInput);

    // Info
    const info = document.createElement("div");
    info.className = "template-info";

    const nameEl = document.createElement("div");
    nameEl.className = "template-item-name";
    nameEl.textContent = template.name;

    info.appendChild(nameEl);

    item.appendChild(dragHandle);
    item.appendChild(checkbox);
    item.appendChild(info);

    // Click to select
    item.addEventListener("click", (e) => {
        if (e.target.type !== "checkbox" && !e.target.closest(".template-drag-handle")) {
            selectTemplate(template.id);
        }
    });

    return item;
}

/**
 * Select a template for editing
 */
function selectTemplate(id) {
    // Check for unsaved changes
    if (hasUnsavedChanges && selectedTemplateId) {
        if (!confirm("You have unsaved changes. Discard them?")) {
            return;
        }
    }

    selectedTemplateId = id;
    hasUnsavedChanges = false;

    // Update list selection
    document.querySelectorAll(".template-list-item").forEach((item) => {
        item.classList.toggle("selected", item.dataset.id === id);
    });

    // Load template into editor
    const template = templates.find((t) => t.id === id);
    if (template) {
        editorEmptyEl.style.display = "none";
        editorFormEl.style.display = "flex";
        editorActionsEl.style.display = "flex";
        editorTitleEl.textContent = "Edit Template";

        nameInput.value = template.name;
        renderInstructionsList(template.instructions || []);
        contentTextarea.value = template.exampleReply || "";

        // Auto-grow textarea after loading content
        requestAnimationFrame(() => {
            autoGrowTextarea(contentTextarea);
        });
    }
}

/**
 * Clear editor selection
 */
function clearSelection() {
    selectedTemplateId = null;
    hasUnsavedChanges = false;

    document.querySelectorAll(".template-list-item").forEach((item) => {
        item.classList.remove("selected");
    });

    editorEmptyEl.style.display = "flex";
    editorFormEl.style.display = "none";
    editorActionsEl.style.display = "none";
    editorTitleEl.textContent = "Select a Template";
}

/**
 * Mark form as having unsaved changes
 */
function onFormChange() {
    hasUnsavedChanges = true;
}

/**
 * Add a new template
 */
async function addNewTemplate() {
    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-add",
            template: {
                name: "New Template",
                instructions: [],
                exampleReply: "",
            },
        });

        if (response && response.ok && response.template) {
            templates.push(response.template);
            renderTemplateList();
            selectTemplate(response.template.id);
            showStatus("Template created");
            log(`${PFX}Added new template: ${response.template.id}`);
        } else {
            throw new Error(response?.error || "Failed to create template");
        }
    } catch (e) {
        log(`${PFX}Error adding template: ${e}`, "error");
        showStatus("Failed to create template", true);
    }
}

/**
 * Save the current template
 */
async function saveCurrentTemplate() {
    if (!selectedTemplateId) {
        return;
    }

    const updates = {
        name: nameInput.value.trim() || "Untitled Template",
        instructions: getInstructionsFromList(),
        exampleReply: contentTextarea.value,
    };

    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-update",
            id: selectedTemplateId,
            updates,
        });

        if (response && response.ok && response.template) {
            // Update local state
            const index = templates.findIndex((t) => t.id === selectedTemplateId);
            if (index >= 0) {
                templates[index] = response.template;
            }

            hasUnsavedChanges = false;
            renderTemplateList();

            // Re-select to update list item
            document.querySelectorAll(".template-list-item").forEach((item) => {
                item.classList.toggle("selected", item.dataset.id === selectedTemplateId);
            });

            showStatus("Template saved");
            log(`${PFX}Saved template: ${selectedTemplateId}`);
        } else {
            throw new Error(response?.error || "Failed to save template");
        }
    } catch (e) {
        log(`${PFX}Error saving template: ${e}`, "error");
        showStatus("Failed to save template", true);
    }
}

/**
 * Duplicate the current template
 */
async function duplicateCurrentTemplate() {
    if (!selectedTemplateId) {
        return;
    }

    const original = templates.find((t) => t.id === selectedTemplateId);
    if (!original) {
        return;
    }

    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-add",
            template: {
                name: `${original.name} (Copy)`,
                instructions: [...original.instructions],
                exampleReply: original.exampleReply,
            },
        });

        if (response && response.ok && response.template) {
            templates.push(response.template);
            renderTemplateList();
            selectTemplate(response.template.id);
            showStatus("Template duplicated");
            log(`${PFX}Duplicated template: ${response.template.id}`);
        } else {
            throw new Error(response?.error || "Failed to duplicate template");
        }
    } catch (e) {
        log(`${PFX}Error duplicating template: ${e}`, "error");
        showStatus("Failed to duplicate template", true);
    }
}

/**
 * Delete the current template
 */
async function deleteCurrentTemplate() {
    if (!selectedTemplateId) {
        return;
    }

    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template) {
        return;
    }

    if (!confirm(`Delete template "${template.name}"? This cannot be undone.`)) {
        return;
    }

    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-delete",
            id: selectedTemplateId,
        });

        if (response && response.ok) {
            templates = templates.filter((t) => t.id !== selectedTemplateId);
            clearSelection();
            renderTemplateList();
            showStatus("Template deleted");
            log(`${PFX}Deleted template: ${selectedTemplateId}`);
        } else {
            throw new Error(response?.error || "Failed to delete template");
        }
    } catch (e) {
        log(`${PFX}Error deleting template: ${e}`, "error");
        showStatus("Failed to delete template", true);
    }
}

/**
 * Toggle template enabled state
 */
async function toggleTemplateEnabled(id, enabled) {
    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-update",
            id,
            updates: { enabled },
        });

        if (response && response.ok) {
            // Update local state
            const index = templates.findIndex((t) => t.id === id);
            if (index >= 0) {
                templates[index].enabled = enabled;
            }

            renderTemplateList();

            // Re-select if needed
            if (id === selectedTemplateId) {
                document.querySelectorAll(".template-list-item").forEach((item) => {
                    item.classList.toggle("selected", item.dataset.id === id);
                });
            }

            showStatus(enabled ? "Template enabled" : "Template disabled");
            log(`${PFX}Toggled template ${id}: enabled=${enabled}`);
        } else {
            throw new Error(response?.error || "Failed to toggle template");
        }
    } catch (e) {
        log(`${PFX}Error toggling template: ${e}`, "error");
        showStatus("Failed to update template", true);
        // Reload to restore correct state
        await loadTemplates();
    }
}

/**
 * Show import dialog
 */
function showImportDialog() {
    document.getElementById("import-dialog").style.display = "flex";
    document.getElementById("import-textarea").value = "";
    document.getElementById("import-textarea").focus();
}

/**
 * Hide import dialog
 */
function hideImportDialog() {
    document.getElementById("import-dialog").style.display = "none";
}

/**
 * Confirm import
 */
async function confirmImport() {
    const json = document.getElementById("import-textarea").value.trim();

    if (!json) {
        showStatus("Please paste template JSON", true);
        return;
    }

    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-import",
            json,
        });

        if (response && response.ok) {
            hideImportDialog();
            await loadTemplates();
            showStatus(`Imported ${response.imported} template(s)`);
            log(`${PFX}Imported ${response.imported} templates, skipped ${response.skipped}`);
        } else {
            throw new Error(response?.error || "Failed to import templates");
        }
    } catch (e) {
        log(`${PFX}Error importing templates: ${e}`, "error");
        showStatus(`Import failed: ${e.message}`, true);
    }
}

/**
 * Export all templates
 */
async function exportAllTemplates() {
    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-export",
        });

        if (response && response.ok && response.json) {
            // Copy to clipboard
            await navigator.clipboard.writeText(response.json);
            showStatus("Templates copied to clipboard");
            log(`${PFX}Exported ${templates.length} templates`);
        } else {
            throw new Error(response?.error || "Failed to export templates");
        }
    } catch (e) {
        log(`${PFX}Error exporting templates: ${e}`, "error");
        showStatus("Failed to export templates", true);
    }
}

/**
 * Reset templates to defaults
 */
async function resetToDefaults() {
    if (!confirm("Reset all templates to defaults? This will delete all your custom templates and restore the original ones. This cannot be undone.")) {
        return;
    }

    try {
        const response = await browser.runtime.sendMessage({
            command: "templates-reset",
        });

        if (response && response.ok) {
            clearSelection();
            await loadTemplates();
            showStatus(`Reset to ${response.count} default templates`);
            log(`${PFX}Reset to ${response.count} default templates`);
        } else {
            throw new Error(response?.error || "Failed to reset templates");
        }
    } catch (e) {
        log(`${PFX}Error resetting templates: ${e}`, "error");
        showStatus("Failed to reset templates", true);
    }
}

/**
 * Debounce helper
 */
function debounce(fn, delay) {
    let timeoutId;
    return (...args) => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), delay);
    };
}

/**
 * Get auth token from storage
 */
async function getAuthToken() {
    try {
        const result = await browser.storage.local.get("supabaseSession");
        const session = result.supabaseSession;
        if (session && session.access_token) {
            return session.access_token;
        }
        return null;
    } catch (e) {
        log(`${PFX}Failed to get auth token: ${e}`, "error");
        return null;
    }
}

/**
 * Show marketplace - opens in a new TB content tab, or switches to existing one
 */
async function showMarketplaceDialog() {
    try {
        const marketplaceUrl = browser.runtime.getURL("marketplace/marketplace.html");
        
        // Check if marketplace tab already exists
        const existingTabs = await browser.tabs.query({ url: marketplaceUrl });
        
        if (existingTabs.length > 0) {
            // Switch to existing tab
            await browser.tabs.update(existingTabs[0].id, { active: true });
            log(`${PFX}Switched to existing marketplace tab: ${existingTabs[0].id}`);
        } else {
            // Open a new tab
            await browser.tabs.create({ url: marketplaceUrl });
            log(`${PFX}Opened marketplace page: ${marketplaceUrl}`);
        }
    } catch (e) {
        log(`${PFX}Failed to open marketplace: ${e}`, "error");
        showStatus(`Failed to open marketplace: ${e.message}`, true);
    }
}

/**
 * Hide marketplace dialog
 */
function hideMarketplaceDialog() {
    document.getElementById("marketplace-dialog").style.display = "none";
}

/**
 * Load marketplace templates from API
 */
async function loadMarketplaceTemplates() {
    const listEl = document.getElementById("marketplace-list");
    const loadingEl = document.getElementById("marketplace-loading");
    const errorEl = document.getElementById("marketplace-error");
    const emptyEl = document.getElementById("marketplace-empty");
    const paginationEl = document.getElementById("marketplace-pagination");

    // Reset state for new load
    marketplaceOffset = 0;
    marketplaceTemplates = [];

    // Show loading
    listEl.style.display = "none";
    errorEl.style.display = "none";
    emptyEl.style.display = "none";
    paginationEl.style.display = "none";
    loadingEl.style.display = "block";

    try {
        const token = await getAuthToken();
        if (!token) {
            throw new Error("Please sign in to access the template marketplace");
        }

        const baseUrl = await getTemplateWorkerUrl();
        const params = new URLSearchParams({
            sort: marketplaceSort,
            limit: "20",
            offset: "0",
        });
        if (marketplaceSearchTerm) {
            params.set("search", marketplaceSearchTerm);
        }

        const response = await fetch(`${baseUrl}/list?${params}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to load templates (${response.status})`);
        }

        const data = await response.json();
        marketplaceTemplates = data.templates || [];
        marketplaceHasMore = data.pagination?.has_more || false;
        marketplaceOffset = data.pagination?.offset || 0;

        loadingEl.style.display = "none";

        if (marketplaceTemplates.length === 0) {
            emptyEl.style.display = "block";
        } else {
            renderMarketplaceList();
            listEl.style.display = "flex";
            paginationEl.style.display = marketplaceHasMore ? "block" : "none";
        }

        log(`${PFX}Loaded ${marketplaceTemplates.length} marketplace templates`);
    } catch (e) {
        log(`${PFX}Failed to load marketplace templates: ${e}`, "error");
        loadingEl.style.display = "none";
        document.getElementById("marketplace-error-text").textContent = e.message || "Failed to load templates";
        errorEl.style.display = "block";
    }
}

/**
 * Load more marketplace templates
 */
async function loadMoreMarketplaceTemplates() {
    const loadMoreBtn = document.getElementById("marketplace-load-more");
    loadMoreBtn.disabled = true;
    loadMoreBtn.textContent = "Loading...";

    try {
        const token = await getAuthToken();
        if (!token) {
            throw new Error("Please sign in");
        }

        const baseUrl = await getTemplateWorkerUrl();
        const newOffset = marketplaceOffset + 20;
        const params = new URLSearchParams({
            sort: marketplaceSort,
            limit: "20",
            offset: String(newOffset),
        });
        if (marketplaceSearchTerm) {
            params.set("search", marketplaceSearchTerm);
        }

        const response = await fetch(`${baseUrl}/list?${params}`, {
            method: "GET",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to load more templates (${response.status})`);
        }

        const data = await response.json();
        const newTemplates = data.templates || [];
        marketplaceTemplates = [...marketplaceTemplates, ...newTemplates];
        marketplaceHasMore = data.pagination?.has_more || false;
        marketplaceOffset = newOffset;

        renderMarketplaceList();
        document.getElementById("marketplace-pagination").style.display = marketplaceHasMore ? "block" : "none";
    } catch (e) {
        log(`${PFX}Failed to load more templates: ${e}`, "error");
        showStatus("Failed to load more templates", true);
    } finally {
        loadMoreBtn.disabled = false;
        loadMoreBtn.textContent = "Load More";
    }
}

/**
 * Handle marketplace search input
 */
function onMarketplaceSearch(e) {
    marketplaceSearchTerm = e.target.value.trim();
    loadMarketplaceTemplates();
}

/**
 * Handle marketplace sort change
 */
function onMarketplaceSortChange(e) {
    marketplaceSort = e.target.value;
    loadMarketplaceTemplates();
}

/**
 * Render marketplace template list
 */
function renderMarketplaceList() {
    const listEl = document.getElementById("marketplace-list");
    listEl.innerHTML = "";

    for (const template of marketplaceTemplates) {
        const card = createMarketplaceCard(template);
        listEl.appendChild(card);
    }
}

/**
 * Create a marketplace template card
 */
function createMarketplaceCard(template) {
    const card = document.createElement("div");
    card.className = "marketplace-card";
    card.dataset.id = template.id;

    const isInstalled = installedTemplateIds.has(template.id);

    // Truncate example reply for preview (collapsed view)
    const previewText = template.example_reply
        ? template.example_reply.substring(0, 200).replace(/\n/g, " ")
        : "No preview available";

    // Full content for expanded view
    const fullPreviewText = template.example_reply || "No preview available";

    // Build instructions list for expanded view
    const instructionsHtml = template.instructions && template.instructions.length > 0
        ? `<div class="marketplace-card-instructions">
            <strong>Instructions:</strong>
            <ul>${template.instructions.map((inst) => `<li>${escapeHtml(inst)}</li>`).join("")}</ul>
           </div>`
        : "";

    card.innerHTML = `
        <div class="marketplace-card-header">
            <div class="marketplace-card-info">
                <h4 class="marketplace-card-name">${escapeHtml(template.name)}</h4>
                <span class="marketplace-card-expand-hint">Click to expand</span>
            </div>
            <div class="marketplace-card-stats">
                <span class="marketplace-card-stat" title="Downloads">
                    ↓ ${formatNumber(template.download_count || 0)}
                </span>
            </div>
        </div>
        ${template.description ? `<p class="marketplace-card-description">${escapeHtml(template.description)}</p>` : ""}
        <div class="marketplace-card-preview marketplace-card-preview-collapsed">${escapeHtml(previewText)}</div>
        <div class="marketplace-card-preview marketplace-card-preview-expanded" style="display: none;">
            ${instructionsHtml}
            <div class="marketplace-card-example">
                <strong>Example Reply:</strong>
                <pre>${escapeHtml(fullPreviewText)}</pre>
            </div>
        </div>
        <div class="marketplace-card-actions">
            <button class="install-btn ${isInstalled ? "installed" : ""}" data-id="${template.id}" ${isInstalled ? "disabled" : ""}>
                ${isInstalled ? "✓ Installed" : "Install"}
            </button>
        </div>
    `;

    // Add click handler to expand/collapse the card
    card.addEventListener("click", (e) => {
        // Don't toggle if clicking on the install button
        if (e.target.closest(".install-btn")) {
            return;
        }
        toggleMarketplaceCardExpand(card);
    });

    // Add install button handler (only if not installed)
    const installBtn = card.querySelector(".install-btn");
    if (!isInstalled) {
        installBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            installTemplate(template);
        });
    }

    return card;
}

/**
 * Toggle marketplace card expand/collapse
 */
function toggleMarketplaceCardExpand(card) {
    const isExpanded = card.classList.contains("expanded");
    const collapsedPreview = card.querySelector(".marketplace-card-preview-collapsed");
    const expandedPreview = card.querySelector(".marketplace-card-preview-expanded");
    const expandHint = card.querySelector(".marketplace-card-expand-hint");
    
    if (isExpanded) {
        // Collapse
        card.classList.remove("expanded");
        collapsedPreview.style.display = "";
        expandedPreview.style.display = "none";
        if (expandHint) expandHint.textContent = "Click to expand";
    } else {
        // Expand
        card.classList.add("expanded");
        collapsedPreview.style.display = "none";
        expandedPreview.style.display = "";
        if (expandHint) expandHint.textContent = "Click to collapse";
    }
}

/**
 * Install (download) a template from marketplace
 */
async function installTemplate(template) {
    const installBtn = document.querySelector(`.marketplace-card[data-id="${template.id}"] .install-btn`);
    if (!installBtn) return;

    installBtn.disabled = true;
    installBtn.textContent = "Installing...";

    try {
        const token = await getAuthToken();
        if (!token) {
            throw new Error("Please sign in");
        }

        const baseUrl = await getTemplateWorkerUrl();
        const response = await fetch(`${baseUrl}/download/${template.id}`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
        });

        if (!response.ok) {
            throw new Error(`Failed to download template (${response.status})`);
        }

        const data = await response.json();
        const downloadedTemplate = data.template;

        // Import the template via background script (no author info - kept private for payouts)
        const importResponse = await browser.runtime.sendMessage({
            command: "templates-add",
            template: {
                id: downloadedTemplate.id,
                name: downloadedTemplate.name,
                instructions: downloadedTemplate.instructions,
                exampleReply: downloadedTemplate.exampleReply,
                enabled: true,
            },
        });

        if (importResponse && importResponse.ok) {
            templates.push(importResponse.template);
            installedTemplateIds.add(template.id);
            renderTemplateList();
            showStatus(`Installed "${template.name}"`);
            log(`${PFX}Installed template: ${template.id}`);

            // Update button state
            installBtn.textContent = "✓ Installed";
            installBtn.classList.add("installed");
        } else {
            throw new Error(importResponse?.error || "Failed to import template");
        }
    } catch (e) {
        log(`${PFX}Failed to install template: ${e}`, "error");
        showStatus(`Failed to install: ${e.message}`, true);
        installBtn.textContent = "Install";
    } finally {
        installBtn.disabled = false;
    }
}

/**
 * Show share template dialog (saves the template first)
 */
async function showShareDialog() {
    if (!selectedTemplateId) return;

    // Save the template first before sharing
    await saveCurrentTemplate();

    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template) return;

    document.getElementById("share-template-name").textContent = template.name;
    document.getElementById("share-description").value = "";
    
    // Reset guidelines checkbox and confirm button state
    const guidelinesCheckbox = document.getElementById("share-guidelines-agree");
    const confirmBtn = document.getElementById("share-confirm-btn");
    guidelinesCheckbox.checked = false;
    confirmBtn.disabled = true;
    
    document.getElementById("share-dialog").style.display = "flex";
}

/**
 * Hide share dialog
 */
function hideShareDialog() {
    document.getElementById("share-dialog").style.display = "none";
}

/**
 * Handle guidelines checkbox change - enable/disable share button
 */
function onGuidelinesCheckboxChange() {
    const checkbox = document.getElementById("share-guidelines-agree");
    const confirmBtn = document.getElementById("share-confirm-btn");
    confirmBtn.disabled = !checkbox.checked;
}

/**
 * Confirm and share template
 */
async function confirmShareTemplate() {
    if (!selectedTemplateId) return;

    const template = templates.find((t) => t.id === selectedTemplateId);
    if (!template) return;

    const description = document.getElementById("share-description").value.trim();
    const confirmBtn = document.getElementById("share-confirm-btn");

    confirmBtn.disabled = true;
    confirmBtn.textContent = "Sharing...";

    try {
        const token = await getAuthToken();
        if (!token) {
            throw new Error("Please sign in to share templates");
        }

        const baseUrl = await getTemplateWorkerUrl();
        const response = await fetch(`${baseUrl}/upload`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                id: template.id,
                name: template.name,
                description: description || null,
                instructions: template.instructions || [],
                example_reply: template.exampleReply || "",
            }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || `Failed to share template (${response.status})`);
        }

        const responseData = await response.json().catch(() => ({}));
        const newTemplateId = responseData.template_id;

        // If server returned a new template_id (e.g., when re-sharing a downloaded template),
        // the template was shared as a new upload with a new UUID
        if (newTemplateId && newTemplateId !== template.id) {
            log(`${PFX}Template re-shared as new upload: original UUID ${template.id}, new UUID ${newTemplateId}`);
        }

        hideShareDialog();
        showStatus(`"${template.name}" submitted for review!`);
        log(`${PFX}Shared template (pending review): ${newTemplateId || template.id}`);
    } catch (e) {
        log(`${PFX}Failed to share template: ${e}`, "error");
        showStatus(`Failed to share: ${e.message}`, true);
    } finally {
        // Re-enable button based on checkbox state (in case of error)
        const checkbox = document.getElementById("share-guidelines-agree");
        confirmBtn.disabled = !checkbox.checked;
        confirmBtn.textContent = "Share Template";
    }
}

/**
 * Escape HTML for safe display
 */
function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
}

/**
 * Format number for display (1000 -> 1K)
 */
function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(1) + "M";
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + "K";
    }
    return String(num);
}

/**
 * Show status message
 */
function showStatus(message, isError = false) {
    const statusEl = document.getElementById("status-message");
    statusEl.textContent = message;
    statusEl.className = isError ? "error" : "success";

    log(`${PFX}Status: ${message}`);

    setTimeout(() => {
        statusEl.textContent = "";
        statusEl.className = "";
    }, 3000);
}

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", initialize);
