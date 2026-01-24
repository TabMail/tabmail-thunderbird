import { log } from "../agent/modules/utils.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";

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

// Auto-grow textarea function
function autoGrowTextarea(textarea) {
  // Reset height to recalculate
  textarea.style.height = "auto";
  // Set to scrollHeight + 2px to ensure there's always room for one more line
  textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

// Parse markdown into structured data
function parseMarkdown(content, isComposition) {
  const lines = content.split("\n");
  const sections = [];
  let currentSection = null;
  let currentTemplate = null;
  let preContent = [];
  let inSections = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check for section header with DO NOT EDIT marker
    const sectionMatch = line.match(/^#\s+(.+?)\s*\(DO NOT EDIT\/DELETE THIS SECTION HEADER\)/);
    if (sectionMatch) {
      inSections = true;
      const title = sectionMatch[1];
      
      // Save previous section
      if (currentSection) {
        if (currentTemplate) {
          currentSection.templates.push(currentTemplate);
          currentTemplate = null;
        }
        // Trim content to remove extra whitespace
        if (currentSection.content) {
          currentSection.content = currentSection.content.trim();
        }
        sections.push(currentSection);
      }
      
      currentSection = {
        title,
        type: "templates", // Will determine type based on content
        templates: [],
        content: "",
      };
      continue;
    }
    
    // Check for regular section header (# without DO NOT EDIT)
    const regularSectionMatch = line.match(/^#\s+(.+)/);
    if (regularSectionMatch && !inSections) {
      // This is pre-content section, add to preContent
      preContent.push(line);
      continue;
    }
    
    // Collect pre-content (everything before first DO NOT EDIT section)
    if (!inSections) {
      preContent.push(line);
      continue;
    }
    
    // Skip if no current section
    if (!currentSection) {
      continue;
    }
    
    // Check for template header (##)
    const templateMatch = line.match(/^##\s+(.+)/);
    if (templateMatch) {
      const title = templateMatch[1].trim();
      
      // Save previous template
      if (currentTemplate) {
        currentSection.templates.push(currentTemplate);
      }
      
      currentTemplate = {
        title,
        instructions: [],
        exampleReply: "",
      };
      continue;
    }
    
    // Parse template content if we're in a template
    if (currentTemplate) {
      // Check for bullet points (instructions)
      if (line.match(/^-\s+(.+)/)) {
        const instruction = line.match(/^-\s+(.+)/)[1];
        // Skip "Example reply:" line - don't add as instruction
        if (!instruction.match(/^Example reply:/i)) {
          currentTemplate.instructions.push(instruction);
        }
      }
      
      // Check for code block start (example reply)
      else if (line.trim() === "```") {
        // Find the end of code block
        let exampleLines = [];
        i++;
        while (i < lines.length && lines[i].trim() !== "```") {
          exampleLines.push(lines[i]);
          i++;
        }
        currentTemplate.exampleReply = exampleLines.join("\n");
      }
      continue;
    }
    
    // If no template, add to section content (for simple sections)
    if (currentSection && !currentTemplate) {
      // Stop parsing when we hit the END marker
      if (line.trim() === "====END USER INSTRUCTIONS====") {
        // Save current section and stop processing
        if (currentTemplate) {
          currentSection.templates.push(currentTemplate);
          currentTemplate = null;
        }
        // Trim content to remove extra whitespace
        if (currentSection.content) {
          currentSection.content = currentSection.content.trim();
        }
        sections.push(currentSection);
        currentSection = null;
        // Skip the rest of the file
        break;
      }
      
      if (currentSection.content) {
        currentSection.content += "\n" + line;
      } else {
        currentSection.content = line;
      }
    }
  }
  
  // Save last section/template if not already saved
  if (currentTemplate && currentSection) {
    currentSection.templates.push(currentTemplate);
  }
  if (currentSection) {
    // Trim content to remove extra whitespace
    if (currentSection.content) {
      currentSection.content = currentSection.content.trim();
    }
    sections.push(currentSection);
  }
  
  return {
    preContent: preContent.join("\n"),
    sections,
  };
}

// Reconstruct markdown from structured data
function reconstructMarkdown(data, isComposition) {
  let lines = [];
  
  // Add pre-content
  if (data.preContent) {
    lines.push(data.preContent);
  }
  
  // Add sections
  for (const section of data.sections) {
    lines.push("");
    lines.push(`# ${section.title} (DO NOT EDIT/DELETE THIS SECTION HEADER)`);
    
    if (isComposition && section.templates && section.templates.length > 0) {
      // Reconstruct templates
      for (const template of section.templates) {
        lines.push("");
        lines.push(`## ${template.title}`);
        
        // Add instructions
        for (const instruction of template.instructions) {
          lines.push(`- ${instruction}`);
        }
        
        // Add example reply marker
        if (template.exampleReply && template.exampleReply.trim()) {
          lines.push("- Example reply:");
          lines.push("```");
          lines.push(template.exampleReply);
          lines.push("```");
        }
      }
    } else {
      // Simple content - trim to avoid extra newlines
      const content = (section.content || "").trim();
      if (content) {
        lines.push(content);
      }
    }
  }
  
  // Add ending markers for composition prompts
  if (isComposition) {
    lines.push("");
    lines.push("====END USER INSTRUCTIONS====");
    lines.push("");
    lines.push("Now, acknowledge these user instructions and do not deviate from them.");
  }
  
  return lines.join("\n");
}

// Load prompt file
async function loadPromptFile(filename) {
  try {
    const response = await browser.runtime.sendMessage({
      command: "read-prompt-file",
      filename,
    });
    
    if (!response || response.error || !response.ok) {
      throw new Error(response?.error || "Failed to load prompt file");
    }
    
    return response.content;
  } catch (e) {
    log(`[Prompts] Failed to load ${filename}: ${e}`, "error");
    throw e;
  }
}

// Save prompt file
async function savePromptFile(filename, content) {
  try {
    const response = await browser.runtime.sendMessage({
      command: "write-prompt-file",
      filename,
      content,
    });
    
    if (!response || response.error || !response.ok) {
      throw new Error(response?.error || "Failed to save prompt file");
    }
    
    return true;
  } catch (e) {
    log(`[Prompts] Failed to save ${filename}: ${e}`, "error");
    throw e;
  }
}

// Reset prompt to default
async function resetPromptFile(filename) {
  try {
    const response = await browser.runtime.sendMessage({
      command: "reset-prompt-file",
      filename,
    });
    
    if (!response || response.error || !response.ok) {
      throw new Error(response?.error || "Failed to reset prompt file");
    }
    
    return true;
  } catch (e) {
    log(`[Prompts] Failed to reset ${filename}: ${e}`, "error");
    throw e;
  }
}

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
  } else if (promptType === "developer") {
    document.getElementById("developer-editor").classList.add("active");
    // Reload raw content when switching to developer tab
    loadRawContent();
  }
  
  // Re-calculate textarea heights after tab is visible (except for developer and reminders tabs)
  if (promptType !== "developer" && promptType !== "reminders") {
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

// ============================================================
// Reminders Tab Functions
// ============================================================

let remindersData = [];

/**
 * Load reminders from background script (builds fresh list including disabled)
 */
async function loadReminders() {
  try {
    log("[Prompts] Loading reminders...");
    
    const response = await browser.runtime.sendMessage({
      command: "get-all-reminders",
    });
    
    if (!response || !response.ok) {
      throw new Error(response?.error || "Failed to load reminders");
    }
    
    remindersData = response.reminders || [];
    log(`[Prompts] Loaded ${remindersData.length} reminders (${response.counts?.disabled || 0} disabled)`);
    
    renderReminders();
  } catch (e) {
    log(`[Prompts] Error loading reminders: ${e}`, "error");
    document.getElementById("reminders-list").innerHTML = 
      '<div class="reminders-loading">Failed to load reminders</div>';
  }
}

/**
 * Render reminders list
 */
function renderReminders() {
  const container = document.getElementById("reminders-list");
  const emptyMessage = document.getElementById("reminders-empty");
  
  if (!remindersData || remindersData.length === 0) {
    container.innerHTML = "";
    emptyMessage.style.display = "block";
    return;
  }
  
  emptyMessage.style.display = "none";
  container.innerHTML = "";
  
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  
  remindersData.forEach((reminder) => {
    const item = document.createElement("div");
    item.className = "reminder-item" + (reminder.enabled === false ? " disabled" : "");
    item.setAttribute("data-hash", reminder.hash);
    
    // Checkbox
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "reminder-checkbox";
    checkbox.checked = reminder.enabled !== false;
    checkbox.title = reminder.enabled !== false ? "Click to hide this reminder" : "Click to show this reminder";
    checkbox.addEventListener("change", () => handleReminderToggle(reminder.hash, checkbox.checked));
    
    // Details container
    const details = document.createElement("div");
    details.className = "reminder-details";
    
    // Content
    const content = document.createElement("p");
    content.className = "reminder-content";
    content.textContent = reminder.content || "No content";
    details.appendChild(content);
    
    // Meta info
    const meta = document.createElement("div");
    meta.className = "reminder-meta";
    
    // Source badge
    const source = document.createElement("span");
    source.className = "reminder-source";
    source.textContent = reminder.source === "kb" ? "Knowledge Base" : "Email";
    meta.appendChild(source);
    
    // Due date
    if (reminder.dueDate) {
      const dueSpan = document.createElement("span");
      dueSpan.className = "reminder-due";
      
      try {
        const dateParts = reminder.dueDate.split("-");
        if (dateParts.length === 3) {
          const dueYear = parseInt(dateParts[0], 10);
          const dueMonth = parseInt(dateParts[1], 10) - 1;
          const dueDay = parseInt(dateParts[2], 10);
          const dueDateMidnight = new Date(dueYear, dueMonth, dueDay);
          const dueDateTimestamp = dueDateMidnight.getTime();
          const todayTimestamp = today.getTime();
          const tomorrowTimestamp = tomorrow.getTime();
          
          if (dueDateTimestamp < todayTimestamp) {
            const msPerDay = 24 * 60 * 60 * 1000;
            const daysOverdue = Math.floor((todayTimestamp - dueDateTimestamp) / msPerDay);
            dueSpan.textContent = `Overdue (${daysOverdue} day${daysOverdue > 1 ? "s" : ""})`;
            dueSpan.classList.add("overdue");
          } else if (dueDateTimestamp === todayTimestamp) {
            dueSpan.textContent = "Due Today";
            dueSpan.classList.add("today");
          } else if (dueDateTimestamp === tomorrowTimestamp) {
            dueSpan.textContent = "Due Tomorrow";
            dueSpan.classList.add("tomorrow");
          } else {
            const options = { weekday: "short", month: "short", day: "numeric" };
            dueSpan.textContent = `Due ${dueDateMidnight.toLocaleDateString("en-US", options)}`;
          }
          meta.appendChild(dueSpan);
        }
      } catch (e) {
        log(`[Prompts] Error formatting due date: ${e}`, "warn");
      }
    }
    
    // Subject (for message reminders)
    if (reminder.subject && reminder.source === "message") {
      const subject = document.createElement("span");
      subject.className = "reminder-subject";
      subject.textContent = `From: ${reminder.subject}`;
      subject.title = reminder.subject;
      meta.appendChild(subject);
    }
    
    details.appendChild(meta);
    
    item.appendChild(checkbox);
    item.appendChild(details);
    container.appendChild(item);
  });
  
  log(`[Prompts] Rendered ${remindersData.length} reminders`);
}

/**
 * Handle reminder enable/disable toggle
 */
async function handleReminderToggle(hash, enabled) {
  try {
    log(`[Prompts] Toggling reminder ${hash} to enabled=${enabled}`);
    
    const command = enabled ? "enable-reminder" : "disable-reminder";
    const response = await browser.runtime.sendMessage({
      command,
      hash,
    });
    
    if (!response || !response.ok) {
      throw new Error(response?.error || "Failed to update reminder");
    }
    
    // Update local data
    const reminder = remindersData.find(r => r.hash === hash);
    if (reminder) {
      reminder.enabled = enabled;
    }
    
    // Update UI
    const item = document.querySelector(`.reminder-item[data-hash="${hash}"]`);
    if (item) {
      if (enabled) {
        item.classList.remove("disabled");
      } else {
        item.classList.add("disabled");
      }
    }
    
    showStatus(enabled ? "Reminder enabled" : "Reminder hidden");
    log(`[Prompts] Reminder ${hash} toggled to enabled=${enabled}`);
  } catch (e) {
    log(`[Prompts] Error toggling reminder: ${e}`, "error");
    showStatus("Failed to update reminder", true);
    // Reload to get correct state
    loadReminders();
  }
}

// Show status message
function showStatus(message, isError = false) {
  const statusEl = document.getElementById("status-message");
  statusEl.textContent = message;
  statusEl.className = isError ? "error" : "success";
  
  log(`[Prompts] Status: ${message}`);
  
  setTimeout(() => {
    statusEl.textContent = "";
    statusEl.className = "";
  }, 3000);
}

// Add flash effect to button using inline styles (to bypass CSS blocking)
function flashButton(button, color = null) {
  const flashColor = color === "blue" ? "var(--in-content-accent-color)" : color === "red" ? "var(--tag-tm-delete)" : "#666";
  log(`[Prompts] Flashing button: ${button.textContent} with color: ${color}`);
  
  const originalBoxShadow = button.style.boxShadow;
  const originalTransform = button.style.transform;
  
  // Apply flash effect with inline styles
  button.style.boxShadow = `0 0 10px 5px ${flashColor}`;
  button.style.transform = "scale(0.95)";
  button.style.transition = "all 0.15s ease";
  
  setTimeout(() => {
    button.style.transform = "scale(1)";
    button.style.boxShadow = "0 0 0 0 transparent";
    
    setTimeout(() => {
      button.style.boxShadow = originalBoxShadow;
      button.style.transform = originalTransform;
      button.style.transition = "";
    }, 150);
  }, 150);
}

// Simple subtle flash effect like the old config page
function flashBorder(element, color = "blue") {
  if (!element) {
    log(`[Prompts] ERROR: flashBorder called with null element!`, "error");
    return;
  }
  
  log(`[Prompts] Flashing border: className="${element.className}", tagName="${element.tagName}", color="${color}"`);
  
  // Get computed styles to preserve them
  const computedStyle = window.getComputedStyle(element);
  const originalBackground = element.style.backgroundColor || computedStyle.backgroundColor;
  const originalBorderColor = element.style.borderColor || computedStyle.borderColor;
  const originalTransition = element.style.transition;
  
  // Apply subtle flash - background tint + border color change
  element.style.transition = "background-color 0.3s ease, border-color 0.3s ease";
  
  if (color === "blue") {
    element.style.backgroundColor = "color-mix(in srgb, var(--in-content-accent-color) 18%, var(--in-content-box-background))";
    element.style.borderColor = "var(--in-content-accent-color)";
  } else {
    element.style.backgroundColor = "color-mix(in srgb, var(--tag-tm-delete) 18%, var(--in-content-box-background))";
    element.style.borderColor = "var(--tag-tm-delete)";
  }
  
  // Fade back to normal after 300ms
  setTimeout(() => {
    element.style.backgroundColor = originalBackground;
    element.style.borderColor = originalBorderColor;
    
    // Clean up after transition completes
    setTimeout(() => {
      element.style.transition = originalTransition;
    }, 300);
  }, 300);
}

// Deep clone for backup
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

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
    
    // Load KB content
    await loadKbContent();
    
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

