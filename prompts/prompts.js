import { log } from "../agent/modules/utils.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";

// Import modular components
import { clearTestOutput, runKbRefineTest } from "./modules/developer.js";
import { clearChatHistory, loadChatHistory } from "./modules/history.js";
import { parseMarkdown, reconstructMarkdown } from "./modules/markdown.js";
import { loadReminders } from "./modules/reminders.js";
import { loadKbConfig, loadPromptFile, resetPromptFile, saveKbConfig, savePromptFile } from "./modules/storage.js";
import { autoGrowTextarea, deepClone, flashBorder, flashButton, showStatus } from "./modules/utils.js";

// Inject TabMail palette CSS
injectPaletteIntoDocument(document).then(() => {
  console.log("[Prompts] Palette CSS injected");
}).catch((e) => {
  console.warn("[Prompts] Failed to inject palette CSS:", e);
});

// Current state
let currentPrompt = "composition";
let compositionData = null;
let actionData = null;
let kbData = null;
let originalCompositionData = null; // Store original for reload
let originalActionData = null; // Store original for reload
let originalKbData = null; // Store original for reload
let isDebugMode = false; // Track debug mode state

// Note: parseMarkdown, reconstructMarkdown, loadPromptFile, savePromptFile, resetPromptFile
// are now imported from modules

// Render composition templates
function renderCompositionTemplates() {
  const container = document.getElementById("composition-sections");
  container.innerHTML = "";
  
  if (!compositionData || !compositionData.sections) {
    container.innerHTML = "<p>Loading...</p>";
    return;
  }
  
  for (const section of compositionData.sections) {
    // Skip template sections - templates are now managed in the separate Templates page
    if (section.templates && section.templates.length > 0) {
      continue;
    }
    
    // Create section container
    const sectionDiv = document.createElement("div");
    sectionDiv.className = "section-container";
    
    // Section header
    const headerDiv = document.createElement("div");
    headerDiv.className = "section-header";
    
    const titleEl = document.createElement("h3");
    titleEl.textContent = section.title;
    headerDiv.appendChild(titleEl);
    
    // Add section actions for all sections
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "section-header-actions";
    
    const saveBtn = document.createElement("button");
    saveBtn.className = "save-section-btn";
    saveBtn.textContent = "Save";
    saveBtn.title = section.templates.length > 0 
      ? "Save all templates in this section" 
      : "Save this section (Ctrl/Cmd+S)";
    saveBtn.addEventListener("click", () => {
      flashButton(saveBtn, "blue");
      // Flash the actual textarea, not the container
      const textarea = sectionDiv.querySelector("textarea");
      if (textarea) flashBorder(textarea, "blue");
      saveSectionBlock(section, "composition");
    });
    actionsDiv.appendChild(saveBtn);
    
    const reloadBtn = document.createElement("button");
    reloadBtn.className = "reload-section-btn";
    reloadBtn.textContent = "Reload";
    reloadBtn.title = section.templates.length > 0
      ? "Reload all templates in this section from disk"
      : "Reload this section from disk";
    reloadBtn.addEventListener("click", () => {
      flashButton(reloadBtn, "blue");
      // Flash the actual textarea, not the container
      const textarea = sectionDiv.querySelector("textarea");
      if (textarea) flashBorder(textarea, "blue");
      reloadSectionBlock(section, "composition");
    });
    actionsDiv.appendChild(reloadBtn);
    
    const resetBtn = document.createElement("button");
    resetBtn.className = "reset-section-btn";
    resetBtn.textContent = "Reset";
    resetBtn.title = section.templates.length > 0
      ? "Reset all templates in this section to default"
      : "Reset this section to default";
    resetBtn.addEventListener("click", () => {
      flashButton(resetBtn, "red");
      // Flash the actual textarea, not the container
      const textarea = sectionDiv.querySelector("textarea");
      if (textarea) flashBorder(textarea, "red");
      resetSectionBlock(section, "composition");
    });
    actionsDiv.appendChild(resetBtn);
    
    headerDiv.appendChild(actionsDiv);
    
    sectionDiv.appendChild(headerDiv);
    
    // Section content
    const contentDiv = document.createElement("div");
    contentDiv.className = "section-content";
    
    // For non-template sections (like "General writing style")
    if (section.templates.length === 0) {
      const simpleDiv = document.createElement("div");
      simpleDiv.className = "simple-content";
      
      const textarea = document.createElement("textarea");
      textarea.value = section.content || "";
      textarea.placeholder = "Enter content...";
      textarea.addEventListener("input", () => {
        section.content = textarea.value;
        autoGrowTextarea(textarea);
      });
      textarea.setAttribute("data-section", section.title); // For debugging
      simpleDiv.appendChild(textarea);
      contentDiv.appendChild(simpleDiv);
    } else {
      // Render templates
      for (let i = 0; i < section.templates.length; i++) {
        const template = section.templates[i];
        const templateDiv = createTemplateItem(template, section, i);
        contentDiv.appendChild(templateDiv);
      }
      
      // Add template button
      const addBtn = document.createElement("button");
      addBtn.className = "add-template-btn";
      addBtn.textContent = "Create New Template";
      addBtn.addEventListener("click", () => {
        const newTemplate = {
          title: "New Template",
          instructions: [],
          exampleReply: "",
          rawLines: [],
        };
        section.templates.push(newTemplate);
        renderCompositionTemplates();
      });
      contentDiv.appendChild(addBtn);
    }
    
    sectionDiv.appendChild(contentDiv);
    container.appendChild(sectionDiv);
  }
  
  // Auto-grow for composition (which is visible by default on load)
  requestAnimationFrame(() => {
    const simpleTextareas = container.querySelectorAll(".simple-content textarea");
    simpleTextareas.forEach(ta => {
      autoGrowTextarea(ta);
      log(`[Prompts] Auto-growing composition textarea for: ${ta.getAttribute("data-section")}, scrollHeight: ${ta.scrollHeight}`);
    });
    
    // Also auto-grow template textareas
    const templateTextareas = container.querySelectorAll(".template-field-textarea");
    templateTextareas.forEach(ta => {
      autoGrowTextarea(ta);
    });
  });
}

// Create template item UI
function createTemplateItem(template, section, index) {
  const templateDiv = document.createElement("div");
  templateDiv.className = "template-item";
  
  // Template header with title and delete button
  const headerDiv = document.createElement("div");
  headerDiv.className = "template-header";
  
  const titleWrapper = document.createElement("div");
  titleWrapper.className = "template-title-input-wrapper";
  
  const titleLabel = document.createElement("label");
  titleLabel.className = "template-title-label";
  titleLabel.textContent = "Template Title";
  titleWrapper.appendChild(titleLabel);
  
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "template-title-input";
  titleInput.value = template.title;
  titleInput.addEventListener("input", () => {
    template.title = titleInput.value;
  });
  titleWrapper.appendChild(titleInput);
  
  headerDiv.appendChild(titleWrapper);
  
  const actionsDiv = document.createElement("div");
  actionsDiv.className = "template-actions";
  
  const saveBtn = document.createElement("button");
  saveBtn.className = "save-section-btn";
  saveBtn.textContent = "Save";
  saveBtn.title = "Save this template (Ctrl/Cmd+S)";
  saveBtn.addEventListener("click", () => {
    flashButton(saveBtn, "blue");
    // Flash all textareas in the template (title, instructions, example)
    const textareas = templateDiv.querySelectorAll("textarea");
    const titleInput = templateDiv.querySelector(".template-title-input");
    if (titleInput) flashBorder(titleInput, "blue");
    textareas.forEach(ta => flashBorder(ta, "blue"));
    saveTemplateBlock(template, section, "composition");
  });
  actionsDiv.appendChild(saveBtn);
  
  const reloadBtn = document.createElement("button");
  reloadBtn.className = "reload-section-btn";
  reloadBtn.textContent = "Reload";
  reloadBtn.title = "Reload this template from disk";
  reloadBtn.addEventListener("click", () => {
    flashButton(reloadBtn, "blue");
    // Flash all textareas in the template (title, instructions, example)
    const textareas = templateDiv.querySelectorAll("textarea");
    const titleInput = templateDiv.querySelector(".template-title-input");
    if (titleInput) flashBorder(titleInput, "blue");
    textareas.forEach(ta => flashBorder(ta, "blue"));
    reloadTemplateBlock(template, section, index, "composition");
  });
  actionsDiv.appendChild(reloadBtn);
  
  // Check if template is marked for deletion
  if (template.markedForDeletion) {
    templateDiv.classList.add("marked-for-deletion");
    
    const undoBtn = document.createElement("button");
    undoBtn.className = "undo-delete-btn";
    undoBtn.textContent = "Undo";
    undoBtn.title = "Undo deletion of this template";
    undoBtn.addEventListener("click", () => {
      delete template.markedForDeletion;
      renderCompositionTemplates();
      showStatus(`Restored template: ${template.title}`);
    });
    actionsDiv.appendChild(undoBtn);
    
    const deleteNowBtn = document.createElement("button");
    deleteNowBtn.className = "delete-now-btn";
    deleteNowBtn.textContent = "Delete Now";
    deleteNowBtn.title = "Permanently delete this template immediately";
    deleteNowBtn.addEventListener("click", async () => {
      flashButton(deleteNowBtn, "red");
      section.templates.splice(index, 1);
      
      // Save immediately
      const markdown = reconstructMarkdown(compositionData, true);
      await savePromptFile("user_composition.md", markdown);
      originalCompositionData = deepClone(compositionData);
      
      renderCompositionTemplates();
      showStatus(`Deleted template: ${template.title}`);
    });
    actionsDiv.appendChild(deleteNowBtn);
  } else {
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-template-btn";
    deleteBtn.textContent = "Mark for Delete";
    deleteBtn.title = "Mark this template for deletion (will be deleted when you save or close)";
    deleteBtn.addEventListener("click", () => {
      flashButton(deleteBtn, "red");
      flashBorder(templateDiv, "red");
      template.markedForDeletion = true;
      renderCompositionTemplates();
      showStatus(`Marked for deletion: ${template.title} (will be deleted on save or page close)`);
    });
    actionsDiv.appendChild(deleteBtn);
  }
  
  headerDiv.appendChild(actionsDiv);
  templateDiv.appendChild(headerDiv);
  
  // Instructions field
  const instructionsField = document.createElement("div");
  instructionsField.className = "template-field";
  
  const instructionsLabel = document.createElement("label");
  instructionsLabel.className = "template-field-label";
  instructionsLabel.textContent = "Instructions";
  instructionsField.appendChild(instructionsLabel);
  
  const instructionsTextarea = document.createElement("textarea");
  instructionsTextarea.className = "template-field-textarea";
  instructionsTextarea.placeholder = "Enter instructions (one per line, will be saved as bullet points)";
  instructionsTextarea.value = template.instructions.join("\n");
  instructionsTextarea.addEventListener("input", () => {
    template.instructions = instructionsTextarea.value.split("\n").filter(line => line.trim());
    autoGrowTextarea(instructionsTextarea);
  });
  instructionsField.appendChild(instructionsTextarea);
  
  templateDiv.appendChild(instructionsField);
  
  // Call autoGrow after element is in DOM
  requestAnimationFrame(() => autoGrowTextarea(instructionsTextarea));
  
  // Example reply field
  const exampleField = document.createElement("div");
  exampleField.className = "template-field";
  
  const exampleLabel = document.createElement("label");
  exampleLabel.className = "template-field-label";
  exampleLabel.textContent = "Example Reply";
  exampleField.appendChild(exampleLabel);
  
  const exampleTextarea = document.createElement("textarea");
  exampleTextarea.className = "template-field-textarea example-reply";
  exampleTextarea.placeholder = "Enter example reply...";
  exampleTextarea.value = template.exampleReply || "";
  exampleTextarea.addEventListener("input", () => {
    template.exampleReply = exampleTextarea.value;
    autoGrowTextarea(exampleTextarea);
  });
  exampleField.appendChild(exampleTextarea);
  
  templateDiv.appendChild(exampleField);
  
  // Call autoGrow after element is in DOM
  requestAnimationFrame(() => autoGrowTextarea(exampleTextarea));
  
  return templateDiv;
}

// Render action sections
function renderActionSections() {
  const container = document.getElementById("action-sections");
  container.innerHTML = "";
  
  if (!actionData || !actionData.sections) {
    container.innerHTML = "<p>Loading...</p>";
    return;
  }
  
  for (const section of actionData.sections) {
    const sectionDiv = document.createElement("div");
    sectionDiv.className = "section-container";
    
    // Section header
    const headerDiv = document.createElement("div");
    headerDiv.className = "section-header";
    
    const titleEl = document.createElement("h3");
    titleEl.textContent = section.title;
    headerDiv.appendChild(titleEl);
    
    // Add section actions
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "section-header-actions";
    
      const saveBtn = document.createElement("button");
      saveBtn.className = "save-section-btn";
      saveBtn.textContent = "Save";
      saveBtn.title = "Save this section (Ctrl/Cmd+S)";
      saveBtn.addEventListener("click", () => {
        flashButton(saveBtn, "blue");
        // Flash the actual textarea, not the container
        const textarea = sectionDiv.querySelector("textarea");
        if (textarea) flashBorder(textarea, "blue");
        saveSectionBlock(section, "action");
      });
      actionsDiv.appendChild(saveBtn);
      
      const reloadBtn = document.createElement("button");
      reloadBtn.className = "reload-section-btn";
      reloadBtn.textContent = "Reload";
      reloadBtn.title = "Reload this section from disk";
      reloadBtn.addEventListener("click", () => {
        flashButton(reloadBtn, "blue");
        // Flash the actual textarea, not the container
        const textarea = sectionDiv.querySelector("textarea");
        if (textarea) flashBorder(textarea, "blue");
        reloadSectionBlock(section, "action");
      });
      actionsDiv.appendChild(reloadBtn);
      
      const resetBtn = document.createElement("button");
      resetBtn.className = "reset-section-btn";
      resetBtn.textContent = "Reset";
      resetBtn.title = "Reset this section to default";
      resetBtn.addEventListener("click", () => {
        flashButton(resetBtn, "red");
        // Flash the actual textarea, not the container
        const textarea = sectionDiv.querySelector("textarea");
        if (textarea) flashBorder(textarea, "red");
        resetSectionBlock(section, "action");
      });
      actionsDiv.appendChild(resetBtn);
    
    headerDiv.appendChild(actionsDiv);
    sectionDiv.appendChild(headerDiv);
    
    // Section content
    const contentDiv = document.createElement("div");
    contentDiv.className = "section-content";
    
    const simpleDiv = document.createElement("div");
    simpleDiv.className = "simple-content";
    
    const textarea = document.createElement("textarea");
    textarea.value = section.content || "";
    textarea.placeholder = "Enter rules (one per line as bullet points)";
    textarea.addEventListener("input", () => {
      section.content = textarea.value;
      autoGrowTextarea(textarea);
    });
    textarea.setAttribute("data-section", section.title); // For debugging
    simpleDiv.appendChild(textarea);
    contentDiv.appendChild(simpleDiv);
    sectionDiv.appendChild(contentDiv);
    container.appendChild(sectionDiv);
  }
  
  // Don't auto-grow immediately - will be done when tab becomes visible
  // The tab switching function will handle this
}

// Tab switching
function switchTab(promptType) {
  currentPrompt = promptType;
  
  // Update tab buttons
  document.querySelectorAll(".prompt-tab").forEach(tab => {
    if (tab.dataset.prompt === promptType) {
      tab.classList.add("active");
    } else {
      tab.classList.remove("active");
    }
  });
  
  // Update content
  document.querySelectorAll(".prompt-content").forEach(content => {
    content.classList.remove("active");
  });
  
  if (promptType === "composition") {
    document.getElementById("composition-editor").classList.add("active");
  } else if (promptType === "action") {
    document.getElementById("action-editor").classList.add("active");
  } else if (promptType === "kb") {
    document.getElementById("kb-editor").classList.add("active");
  } else if (promptType === "reminders") {
    document.getElementById("reminders-editor").classList.add("active");
    // Load reminders when switching to reminders tab
    loadReminders();
  } else if (promptType === "history") {
    document.getElementById("history-editor").classList.add("active");
    // Load chat history when switching to history tab
    loadChatHistory();
  } else if (promptType === "developer") {
    document.getElementById("developer-editor").classList.add("active");
    // Reload raw content when switching to developer tab
    loadRawContent();
  }
  
  // Re-calculate textarea heights after tab is visible (except for developer, reminders, history tabs)
  if (promptType !== "developer" && promptType !== "reminders" && promptType !== "history") {
    requestAnimationFrame(() => {
      const activeContent = document.querySelector(".prompt-content.active");
      if (activeContent) {
        const textareas = activeContent.querySelectorAll("textarea");
        textareas.forEach(ta => {
          autoGrowTextarea(ta);
          log(`[Prompts] Re-growing textarea after tab switch: ${ta.getAttribute("data-section")}, scrollHeight: ${ta.scrollHeight}`);
        });
      }
    });
  }
}

// Note: Utility functions, reminders, chat history, KB config now in modules

// Load KB content
async function loadKbContent() {
  try {
    const content = await loadPromptFile("user_kb.md");
    kbData = content;
    originalKbData = content; // Store backup for reload
    
    // Update the textarea
    const kbTextarea = document.getElementById("kb-content");
    if (kbTextarea) {
      kbTextarea.value = content;
      requestAnimationFrame(() => {
        autoGrowTextarea(kbTextarea);
      });
    }
    
    log(`[Prompts] KB content loaded`);
  } catch (e) {
    log(`[Prompts] Failed to load KB: ${e}`, "error");
    showStatus(`Failed to load KB: ${e.message}`, true);
  }
}

// Save KB content
async function saveKbContent() {
  try {
    const kbTextarea = document.getElementById("kb-content");
    if (!kbTextarea) return;
    
    const content = kbTextarea.value;
    await savePromptFile("user_kb.md", content);
    kbData = content;
    originalKbData = content;
    
    showStatus("KB saved successfully!");
    log(`[Prompts] KB saved`);
  } catch (e) {
    log(`[Prompts] Failed to save KB: ${e}`, "error");
    showStatus(`Failed to save KB: ${e.message}`, true);
  }
}

// Reload KB content from disk
async function reloadKbContent() {
  try {
    const content = await loadPromptFile("user_kb.md");
    kbData = content;
    originalKbData = content;
    
    const kbTextarea = document.getElementById("kb-content");
    if (kbTextarea) {
      kbTextarea.value = content;
      autoGrowTextarea(kbTextarea);
    }
    
    showStatus("KB reloaded from disk!");
    log(`[Prompts] KB reloaded`);
  } catch (e) {
    log(`[Prompts] Failed to reload KB: ${e}`, "error");
    showStatus(`Failed to reload KB: ${e.message}`, true);
  }
}

// Reset KB to default
async function resetKbContent() {
  try {
    const content = await loadDefaultPromptFile("user_kb.md");
    await savePromptFile("user_kb.md", content);
    kbData = content;
    originalKbData = content;
    
    const kbTextarea = document.getElementById("kb-content");
    if (kbTextarea) {
      kbTextarea.value = content;
      autoGrowTextarea(kbTextarea);
    }
    
    showStatus("KB reset to default!");
    log(`[Prompts] KB reset to default`);
  } catch (e) {
    log(`[Prompts] Failed to reset KB: ${e}`, "error");
    showStatus(`Failed to reset KB: ${e.message}`, true);
  }
}

// Block-wise operations

// Save a single section
async function saveSectionBlock(section, promptType) {
  try {
    const filename = promptType === "composition" ? "user_composition.md" : "user_action.md";
    const data = promptType === "composition" ? compositionData : actionData;
    
    // For composition sections with templates, actually delete marked templates
    if (promptType === "composition" && section.templates && section.templates.length > 0) {
      section.templates = section.templates.filter(t => !t.markedForDeletion);
    }
    
    const markdown = reconstructMarkdown(data, promptType === "composition");
    await savePromptFile(filename, markdown);
    
    // Update original data without re-rendering (which causes the shrink issue)
    if (promptType === "composition") {
      originalCompositionData = deepClone(compositionData);
      // Don't re-render - just update the data
    } else {
      originalActionData = deepClone(actionData);
    }
    
    showStatus(`Saved: ${section.title}`);
    log(`[Prompts] Saved section: ${section.title}`);
  } catch (e) {
    showStatus(`Failed to save: ${e.message}`, true);
    log(`[Prompts] Failed to save section: ${e}`, "error");
  }
}

// Save a single template
async function saveTemplateBlock(template, section, promptType) {
  try {
    const filename = promptType === "composition" ? "user_composition.md" : "user_action.md";
    const data = promptType === "composition" ? compositionData : actionData;
    
    const markdown = reconstructMarkdown(data, promptType === "composition");
    await savePromptFile(filename, markdown);
    
    // Update original data
    if (promptType === "composition") {
      originalCompositionData = deepClone(compositionData);
    } else {
      originalActionData = deepClone(actionData);
    }
    
    showStatus(`Saved template: ${template.title}`);
    log(`[Prompts] Saved template: ${template.title}`);
  } catch (e) {
    showStatus(`Failed to save: ${e.message}`, true);
    log(`[Prompts] Failed to save template: ${e}`, "error");
  }
}

// Reload a single section from disk
async function reloadSectionBlock(section, promptType) {
  try {
    const filename = promptType === "composition" ? "user_composition.md" : "user_action.md";
    const content = await loadPromptFile(filename);
    const parsedData = parseMarkdown(content, promptType === "composition");
    
    // Find the matching section
    const matchingSection = parsedData.sections.find(s => s.title === section.title);
    if (matchingSection) {
      // Update section content only - don't re-render to avoid height recalculation issues
      section.content = matchingSection.content;
      section.templates = matchingSection.templates;
      
      // Update the textarea value directly instead of re-rendering everything
      const data = promptType === "composition" ? compositionData : actionData;
      const sectionIndex = data.sections.findIndex(s => s.title === section.title);
      if (sectionIndex >= 0) {
        // Find the textarea for this section
        const container = promptType === "composition" 
          ? document.getElementById("composition-sections")
          : document.getElementById("action-sections");
        const sectionDivs = container.querySelectorAll(".section-container");
        if (sectionDivs[sectionIndex]) {
          const textarea = sectionDivs[sectionIndex].querySelector("textarea");
          if (textarea) {
            textarea.value = matchingSection.content || "";
            autoGrowTextarea(textarea);
          }
        }
      }
      
      showStatus(`Reloaded: ${section.title}`);
      log(`[Prompts] Reloaded section: ${section.title}`);
    } else {
      throw new Error("Section not found in file");
    }
  } catch (e) {
    showStatus(`Failed to reload: ${e.message}`, true);
    log(`[Prompts] Failed to reload section: ${e}`, "error");
  }
}

// Reload a single template from disk
async function reloadTemplateBlock(template, section, index, promptType) {
  try {
    const filename = promptType === "composition" ? "user_composition.md" : "user_action.md";
    const content = await loadPromptFile(filename);
    const parsedData = parseMarkdown(content, promptType === "composition");
    
    // Find the matching section and template
    const matchingSection = parsedData.sections.find(s => s.title === section.title);
    if (matchingSection && matchingSection.templates[index]) {
      // Update template content
      Object.assign(template, matchingSection.templates[index]);
      
      // Re-render
      renderCompositionTemplates();
      
      showStatus(`Reloaded template: ${template.title}`);
      log(`[Prompts] Reloaded template: ${template.title}`);
    } else {
      throw new Error("Template not found in file");
    }
  } catch (e) {
    showStatus(`Failed to reload: ${e.message}`, true);
    log(`[Prompts] Failed to reload template: ${e}`, "error");
  }
}

// Reset a single section to default
async function resetSectionBlock(section, promptType) {
  if (!confirm(`Are you sure you want to reset "${section.title}" to default? This cannot be undone.`)) {
    return;
  }
  
  try {
    const filename = promptType === "composition" ? "user_composition.md" : "user_action.md";
    
    // Get default file content
    await resetPromptFile(filename);
    const defaultContent = await loadPromptFile(filename);
    const defaultData = parseMarkdown(defaultContent, promptType === "composition");
    
    // Find the section in default data
    const defaultSection = defaultData.sections.find(s => s.title === section.title);
    if (!defaultSection) {
      throw new Error("Section not found in default file");
    }
    
    // Get current data
    const currentData = promptType === "composition" ? compositionData : actionData;
    
    // Replace only this section with default
    const sectionIndex = currentData.sections.findIndex(s => s.title === section.title);
    if (sectionIndex >= 0) {
      currentData.sections[sectionIndex] = deepClone(defaultSection);
      
      // Save the modified (not fully reset) data back
      const markdown = reconstructMarkdown(currentData, promptType === "composition");
      await savePromptFile(filename, markdown);
      
      // Update original data
      if (promptType === "composition") {
        originalCompositionData = deepClone(compositionData);
        renderCompositionTemplates();
      } else {
        originalActionData = deepClone(actionData);
        renderActionSections();
      }
      
      showStatus(`Reset: ${section.title}`);
      log(`[Prompts] Reset section: ${section.title}`);
    } else {
      throw new Error("Section not found in current data");
    }
  } catch (e) {
    showStatus(`Failed to reset: ${e.message}`, true);
    log(`[Prompts] Failed to reset section: ${e}`, "error");
  }
}

// Check if debug mode is enabled
async function checkDebugMode() {
  try {
    const { debugMode } = await browser.storage.local.get({ debugMode: false });
    isDebugMode = debugMode;
    
    // Show/hide developer tab
    const devTab = document.querySelector('.prompt-tab[data-prompt="developer"]');
    if (devTab) {
      devTab.style.display = isDebugMode ? 'block' : 'none';
    }
    
    log(`[Prompts] Debug mode: ${isDebugMode}`);
  } catch (e) {
    log(`[Prompts] Failed to check debug mode: ${e}`, "error");
  }
}

// Load raw content for developer tab
async function loadRawContent() {
  try {
    const compositionContent = await loadPromptFile("user_composition.md");
    document.getElementById("raw-composition-content").value = compositionContent;
    
    const actionContent = await loadPromptFile("user_action.md");
    document.getElementById("raw-action-content").value = actionContent;
    
    const kbContent = await loadPromptFile("user_kb.md");
    document.getElementById("raw-kb-content").value = kbContent;
    
    log("[Prompts] Loaded raw content for developer tab");
  } catch (e) {
    log(`[Prompts] Failed to load raw content: ${e}`, "error");
  }
}

// Initialize
async function initialize() {
  try {
    // Check debug mode first
    await checkDebugMode();
    
    // Load composition prompt
    const compositionContent = await loadPromptFile("user_composition.md");
    compositionData = parseMarkdown(compositionContent, true);
    originalCompositionData = deepClone(compositionData);
    renderCompositionTemplates();
    
    // Load action prompt
    const actionContent = await loadPromptFile("user_action.md");
    actionData = parseMarkdown(actionContent, false);
    originalActionData = deepClone(actionData);
    renderActionSections();
    
    // Load KB content and config
    await loadKbContent();
    await loadKbConfig();
    
    // Load raw content if debug mode is enabled
    if (isDebugMode) {
      await loadRawContent();
    }
    
    log("[Prompts] Initialized successfully");
  } catch (e) {
    log(`[Prompts] Failed to initialize: ${e}`, "error");
    showStatus("Failed to load prompts", true);
  }
}

// Keyboard shortcut helper - finds the focused element's section/template
function findFocusedBlock() {
  const focusedElement = document.activeElement;
  
  log(`[Prompts] Finding focused block, activeElement: ${focusedElement ? focusedElement.tagName : "none"}`);
  
  // Check if it's a textarea
  if (focusedElement && focusedElement.tagName === "TEXTAREA") {
    // Find the parent template-item or simple-content
    let parent = focusedElement.closest(".template-item");
    if (parent) {
      // It's a template - find which one
      const allTemplates = document.querySelectorAll(".template-item");
      const index = Array.from(allTemplates).indexOf(parent);
      
      log(`[Prompts] Focused on template, index: ${index}, currentPrompt: ${currentPrompt}`);
      
      if (currentPrompt === "composition") {
        // Find section containing this template
        let sectionIndex = 0;
        let templateIndex = 0;
        for (const section of compositionData.sections) {
          if (templateIndex + section.templates.length > index) {
            const localIndex = index - templateIndex;
            log(`[Prompts] Found template in section "${section.title}", localIndex: ${localIndex}`);
            return { 
              type: "template", 
              section: section, 
              template: section.templates[localIndex],
              index: localIndex,
              promptType: "composition"
            };
          }
          templateIndex += section.templates.length;
          sectionIndex++;
        }
      }
    }
    
    parent = focusedElement.closest(".simple-content");
    if (parent) {
      // Check if it's the KB textarea
      if (focusedElement.id === "kb-content") {
        log(`[Prompts] Focused on KB textarea`);
        return { 
          type: "kb"
        };
      }
      
      // It's a simple section - scope to the current tab's container
      const sectionContainer = parent.closest(".section-container");
      
      // Get sections only from the current tab's container to avoid index mismatch
      let containerId;
      if (currentPrompt === "composition") {
        containerId = "#composition-sections";
      } else if (currentPrompt === "action") {
        containerId = "#action-sections";
      } else {
        log(`[Prompts] Unknown prompt type for section lookup: ${currentPrompt}`);
        return null;
      }
      
      const allSections = document.querySelectorAll(`${containerId} .section-container`);
      const index = Array.from(allSections).indexOf(sectionContainer);
      
      log(`[Prompts] Focused on simple section, index: ${index}, currentPrompt: ${currentPrompt}, containerId: ${containerId}, totalSections: ${allSections.length}`);
      
      if (currentPrompt === "composition" && index >= 0 && index < compositionData.sections.length) {
        log(`[Prompts] Found composition section: "${compositionData.sections[index].title}"`);
        return { 
          type: "section", 
          section: compositionData.sections[index],
          promptType: "composition"
        };
      } else if (currentPrompt === "action" && index >= 0 && index < actionData.sections.length) {
        log(`[Prompts] Found action section: "${actionData.sections[index].title}"`);
        return { 
          type: "section", 
          section: actionData.sections[index],
          promptType: "action"
        };
      }
    }
  }
  
  log(`[Prompts] No focused block found`);
  return null;
}

// Event listeners
document.addEventListener("DOMContentLoaded", () => {
  // Tab switching
  document.querySelectorAll(".prompt-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      switchTab(tab.dataset.prompt);
    });
  });
  
  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    const ctrlKey = isMac ? e.metaKey : e.ctrlKey;
    
    // Ctrl/Cmd+S to save focused block
    if (ctrlKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      
      const focused = findFocusedBlock();
      log(`[Prompts] Ctrl+S pressed, focused: ${focused ? focused.type : "none"}`);
      
      if (focused) {
        if (focused.type === "template") {
          // Flash all fields in the template (title, instructions, example)
          const focusedElement = document.activeElement;
          const templateDiv = focusedElement.closest(".template-item");
          if (templateDiv) {
            const titleInput = templateDiv.querySelector(".template-title-input");
            const textareas = templateDiv.querySelectorAll("textarea");
            if (titleInput) flashBorder(titleInput, "blue");
            textareas.forEach(ta => flashBorder(ta, "blue"));
          }
          saveTemplateBlock(focused.template, focused.section, focused.promptType);
        } else if (focused.type === "section") {
          // Flash the focused textarea
          const focusedTextarea = document.activeElement;
          if (focusedTextarea && focusedTextarea.tagName === "TEXTAREA") {
            flashBorder(focusedTextarea, "blue");
          }
          saveSectionBlock(focused.section, focused.promptType);
        } else if (focused.type === "kb") {
          // Flash KB textarea
          const kbTextarea = document.getElementById("kb-content");
          if (kbTextarea) flashBorder(kbTextarea, "blue");
          saveKbContent();
        }
      } else {
        // No specific focus, save entire file
        (async () => {
          try {
            if (currentPrompt === "composition") {
              const markdown = reconstructMarkdown(compositionData, true);
              await savePromptFile("user_composition.md", markdown);
              originalCompositionData = deepClone(compositionData);
            } else if (currentPrompt === "action") {
              const markdown = reconstructMarkdown(actionData, false);
              await savePromptFile("user_action.md", markdown);
              originalActionData = deepClone(actionData);
            } else if (currentPrompt === "kb") {
              await saveKbContent();
            }
            showStatus("Saved all changes!");
          } catch (e) {
            showStatus("Failed to save: " + e.message, true);
          }
        })();
      }
    }
  });
  
  // Save all changes (global button)
  document.getElementById("save-changes").addEventListener("click", async () => {
    const saveBtn = document.getElementById("save-changes");
    flashButton(saveBtn, "blue");
    
    try {
      if (currentPrompt === "composition") {
        // Actually delete marked templates
        for (const section of compositionData.sections) {
          if (section.templates && section.templates.length > 0) {
            section.templates = section.templates.filter(t => !t.markedForDeletion);
          }
        }
        
        const markdown = reconstructMarkdown(compositionData, true);
        await savePromptFile("user_composition.md", markdown);
        originalCompositionData = deepClone(compositionData);
        renderCompositionTemplates();
        showStatus("Saved entire Email Composition!");
      } else if (currentPrompt === "action") {
        const markdown = reconstructMarkdown(actionData, false);
        await savePromptFile("user_action.md", markdown);
        originalActionData = deepClone(actionData);
        showStatus("Saved entire Action Classification!");
      } else if (currentPrompt === "kb") {
        await saveKbContent();
        showStatus("Saved Knowledge Base!");
      } else {
        showStatus("Cannot save from Developer tab", true);
        return;
      }
    } catch (e) {
      showStatus("Failed to save: " + e.message, true);
    }
  });
  
  // Reload prompts (global button)
  document.getElementById("reload-prompts").addEventListener("click", async () => {
    const reloadBtn = document.getElementById("reload-prompts");
    flashButton(reloadBtn, "blue");
    
    try {
      if (currentPrompt === "composition") {
        const content = await loadPromptFile("user_composition.md");
        compositionData = parseMarkdown(content, true);
        originalCompositionData = deepClone(compositionData);
        renderCompositionTemplates();
        showStatus("Reloaded entire Email Composition from disk!");
      } else if (currentPrompt === "action") {
        const content = await loadPromptFile("user_action.md");
        actionData = parseMarkdown(content, false);
        originalActionData = deepClone(actionData);
        renderActionSections();
        showStatus("Reloaded entire Action Classification from disk!");
      } else {
        showStatus("Use the Developer tab buttons to reload raw files", true);
        return;
      }
    } catch (e) {
      showStatus("Failed to reload: " + e.message, true);
    }
  });
  
  // Reset prompt (global button)
  document.getElementById("reset-prompt").addEventListener("click", async () => {
    if (currentPrompt === "developer") {
      showStatus("Use the Developer tab buttons to reset raw files", true);
      return;
    }
    
    const filename = currentPrompt === "composition" ? "user_composition.md" 
      : currentPrompt === "action" ? "user_action.md" 
      : "user_kb.md";
    const promptName = currentPrompt === "composition" ? "Email Composition" 
      : currentPrompt === "action" ? "Action Classification" 
      : "Knowledge Base";
    
    if (!confirm(`Are you sure you want to reset ALL "${promptName}" to default? This cannot be undone.`)) {
      return;
    }
    
    const resetBtn = document.getElementById("reset-prompt");
    flashButton(resetBtn, "red");
    
    try {
      await resetPromptFile(filename);
      
      // Reload the specific prompt type
      if (currentPrompt === "composition") {
        const content = await loadPromptFile("user_composition.md");
        compositionData = parseMarkdown(content, true);
        originalCompositionData = deepClone(compositionData);
        renderCompositionTemplates();
      } else if (currentPrompt === "action") {
        const content = await loadPromptFile("user_action.md");
        actionData = parseMarkdown(content, false);
        originalActionData = deepClone(actionData);
        renderActionSections();
      } else if (currentPrompt === "kb") {
        await resetKbContent();
      }
      
      showStatus(`Reset entire ${promptName} to default!`);
    } catch (e) {
      showStatus("Failed to reset: " + e.message, true);
    }
  });
  
  // KB-specific buttons
  document.getElementById("save-kb").addEventListener("click", async () => {
    const saveBtn = document.getElementById("save-kb");
    flashButton(saveBtn, "blue");
    const kbTextarea = document.getElementById("kb-content");
    if (kbTextarea) flashBorder(kbTextarea, "blue");
    await saveKbContent();
  });
  
  document.getElementById("reload-kb").addEventListener("click", async () => {
    const reloadBtn = document.getElementById("reload-kb");
    flashButton(reloadBtn, "blue");
    const kbTextarea = document.getElementById("kb-content");
    if (kbTextarea) flashBorder(kbTextarea, "blue");
    await reloadKbContent();
  });
  
  document.getElementById("reset-kb").addEventListener("click", async () => {
    if (!confirm("Are you sure you want to reset the Knowledge Base to default? This cannot be undone.")) {
      return;
    }
    const resetBtn = document.getElementById("reset-kb");
    flashButton(resetBtn, "red");
    const kbTextarea = document.getElementById("kb-content");
    if (kbTextarea) flashBorder(kbTextarea, "red");
    await resetKbContent();
  });
  
  // KB config auto-save on change
  const kbConfigInputs = [
    document.getElementById("kb-recent-chats"),
    document.getElementById("kb-reminder-retention"),
    document.getElementById("kb-max-bullets"),
  ];
  for (const input of kbConfigInputs) {
    if (input) {
      input.addEventListener("change", async () => {
        await saveKbConfig();
      });
    }
  }
  
  // Developer test handlers (implementation in modules/developer.js)
  document.getElementById("test-kb-refine").addEventListener("click", runKbRefineTest);
  document.getElementById("clear-test-output").addEventListener("click", clearTestOutput);

  // Raw developer tab handlers
  document.getElementById("save-raw-composition").addEventListener("click", async () => {
    try {
      const content = document.getElementById("raw-composition-content").value;
      await savePromptFile("user_composition.md", content);
      
      // Reload parsed data
      compositionData = parseMarkdown(content, true);
      originalCompositionData = deepClone(compositionData);
      renderCompositionTemplates();
      
      showStatus("Saved user_composition.md");
    } catch (e) {
      showStatus("Failed to save: " + e.message, true);
    }
  });
  
  document.getElementById("reload-raw-composition").addEventListener("click", async () => {
    try {
      const content = await loadPromptFile("user_composition.md");
      document.getElementById("raw-composition-content").value = content;
      showStatus("Reloaded user_composition.md");
    } catch (e) {
      showStatus("Failed to reload: " + e.message, true);
    }
  });
  
  document.getElementById("reset-raw-composition").addEventListener("click", async () => {
    if (!confirm("Are you sure you want to reset user_composition.md to default? This cannot be undone.")) {
      return;
    }
    try {
      await resetPromptFile("user_composition.md");
      const content = await loadPromptFile("user_composition.md");
      document.getElementById("raw-composition-content").value = content;
      
      // Reload parsed data
      compositionData = parseMarkdown(content, true);
      originalCompositionData = deepClone(compositionData);
      renderCompositionTemplates();
      
      showStatus("Reset user_composition.md");
    } catch (e) {
      showStatus("Failed to reset: " + e.message, true);
    }
  });
  
  document.getElementById("save-raw-action").addEventListener("click", async () => {
    try {
      const content = document.getElementById("raw-action-content").value;
      await savePromptFile("user_action.md", content);
      
      // Reload parsed data
      actionData = parseMarkdown(content, false);
      originalActionData = deepClone(actionData);
      renderActionSections();
      
      showStatus("Saved user_action.md");
    } catch (e) {
      showStatus("Failed to save: " + e.message, true);
    }
  });
  
  document.getElementById("reload-raw-action").addEventListener("click", async () => {
    try {
      const content = await loadPromptFile("user_action.md");
      document.getElementById("raw-action-content").value = content;
      showStatus("Reloaded user_action.md");
    } catch (e) {
      showStatus("Failed to reload: " + e.message, true);
    }
  });
  
  document.getElementById("reset-raw-action").addEventListener("click", async () => {
    if (!confirm("Are you sure you want to reset user_action.md to default? This cannot be undone.")) {
      return;
    }
    try {
      await resetPromptFile("user_action.md");
      const content = await loadPromptFile("user_action.md");
      document.getElementById("raw-action-content").value = content;
      
      // Reload parsed data
      actionData = parseMarkdown(content, false);
      originalActionData = deepClone(actionData);
      renderActionSections();
      
      showStatus("Reset user_action.md");
    } catch (e) {
      showStatus("Failed to reset: " + e.message, true);
    }
  });
  
  // Raw KB handlers
  document.getElementById("save-raw-kb").addEventListener("click", async () => {
    try {
      const content = document.getElementById("raw-kb-content").value;
      await savePromptFile("user_kb.md", content);
      
      // Reload KB data
      kbData = content;
      originalKbData = content;
      const kbTextarea = document.getElementById("kb-content");
      if (kbTextarea) {
        kbTextarea.value = content;
        autoGrowTextarea(kbTextarea);
      }
      
      showStatus("Saved user_kb.md");
    } catch (e) {
      showStatus("Failed to save: " + e.message, true);
    }
  });
  
  document.getElementById("reload-raw-kb").addEventListener("click", async () => {
    try {
      const content = await loadPromptFile("user_kb.md");
      document.getElementById("raw-kb-content").value = content;
      showStatus("Reloaded user_kb.md");
    } catch (e) {
      showStatus("Failed to reload: " + e.message, true);
    }
  });
  
  document.getElementById("reset-raw-kb").addEventListener("click", async () => {
    if (!confirm("Are you sure you want to reset user_kb.md to default? This cannot be undone.")) {
      return;
    }
    try {
      await resetPromptFile("user_kb.md");
      const content = await loadPromptFile("user_kb.md");
      document.getElementById("raw-kb-content").value = content;
      
      // Reload KB data
      kbData = content;
      originalKbData = content;
      const kbTextarea = document.getElementById("kb-content");
      if (kbTextarea) {
        kbTextarea.value = content;
        autoGrowTextarea(kbTextarea);
      }
      
      showStatus("Reset user_kb.md");
    } catch (e) {
      showStatus("Failed to reset: " + e.message, true);
    }
  });
  
  // Clean up marked templates when page closes
  window.addEventListener("beforeunload", async (e) => {
    // Check if there are any marked templates
    let hasMarkedTemplates = false;
    for (const section of compositionData.sections) {
      if (section.templates && section.templates.some(t => t.markedForDeletion)) {
        hasMarkedTemplates = true;
        break;
      }
    }
    
    if (hasMarkedTemplates) {
      // Actually delete marked templates before closing
      for (const section of compositionData.sections) {
        if (section.templates && section.templates.length > 0) {
          section.templates = section.templates.filter(t => !t.markedForDeletion);
        }
      }
      
      // Save silently
      try {
        const markdown = reconstructMarkdown(compositionData, true);
        await savePromptFile("user_composition.md", markdown);
        log("[Prompts] Cleaned up marked templates on page close");
      } catch (error) {
        log(`[Prompts] Failed to save on close: ${error}`, "error");
      }
    }
  });
  
  // Refresh reminders button
  document.getElementById("refresh-reminders").addEventListener("click", async () => {
    const refreshBtn = document.getElementById("refresh-reminders");
    flashButton(refreshBtn, "blue");
    await loadReminders();
    showStatus("Reminders refreshed");
  });
  
  // Chat history handlers
  document.getElementById("refresh-history").addEventListener("click", async () => {
    const refreshBtn = document.getElementById("refresh-history");
    flashButton(refreshBtn, "blue");
    await loadChatHistory();
    showStatus("Chat history refreshed");
  });
  
  document.getElementById("clear-history").addEventListener("click", async () => {
    if (!confirm("Are you sure you want to clear all chat history? This cannot be undone.")) {
      return;
    }
    const clearBtn = document.getElementById("clear-history");
    flashButton(clearBtn, "red");
    await clearChatHistory();
  });

  document.getElementById("remigrate-history").addEventListener("click", async () => {
    const remigrateBtn = document.getElementById("remigrate-history");
    flashButton(remigrateBtn, "blue");
    try {
      const { remigrateChatHistory } = await import("./modules/history.js");
      await remigrateChatHistory();
    } catch (e) {
      showStatus("Re-migration failed: " + e, true);
    }
  });
  
  // Storage listener for auto-updating reminders when they change
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === "local" && changes.disabled_reminders) {
      // Only auto-update if we're on the reminders tab
      if (currentPrompt === "reminders") {
        log("[Prompts] Disabled reminders changed, refreshing list");
        loadReminders();
      }
    }
  });
  
  // Initialize
  initialize();
});

