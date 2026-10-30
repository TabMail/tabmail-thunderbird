/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { ACTION_CONFIG_TS_KEY } from "../agent/modules/actionCompactConfig.js";
import { log } from "../agent/modules/utils.js";
import { injectPaletteIntoDocument } from "../theme/palette/palette.js";

// Import modular components
import { clearTestOutput, runKbRefineTest } from "./modules/developer.js";
import { initHistoryHandlers, loadChatHistory, showClearAllConfirmation } from "./modules/history.js";
import { BULLET_STATE_KEYS, PROMPT_KEYS, readView, SECTION_MARKER_REFUSAL } from "../agent/modules/promptStore.js";
import { pageSections, removeItem } from "./modules/markdown.js";
import { loadReminders } from "./modules/reminders.js";
import { loadTasks } from "./modules/tasks.js";
import { addLine as addStoredLine, editShown, loadActionConfig, loadKbConfig, resetSection as resetStoredSection, resetWholeField as resetStoredField, saveActionConfig, saveKbConfig } from "./modules/storage.js";
import { autoGrowTextarea, flashBorder, flashButton, showStatus } from "./modules/utils.js";

// Inject TabMail palette CSS
injectPaletteIntoDocument(document).then(() => {
  console.log("[Prompts] Palette CSS injected");
}).catch((e) => {
  console.warn("[Prompts] Failed to inject palette CSS:", e);
});

// Regex for reminder lines (matches backend REMINDER_ITEM_REGEX)
// Supports both new format "[Reminder]" and legacy format "Reminder:"
const REMINDER_LINE_REGEX = /^-\s*(?:Reminder:|\[Reminder\])\s*/i;

// The page keeps no text of its own: each edit is saved when it is made. It shows each field's stored
// text and the labels it shows, read together and read again on every storage change, and each action on
// it (remove a line, add one, reset a section) is one edit of the text shown, saved right away against
// the labels shown with it (DS-DISPLAYED).
const FIELDS = ["composition", "action", "kb"];

/** Per field, what is shown: { content, captured } from one read of the store (`readView`). */
const shown = { composition: null, action: null, kb: null };
/** Per field, how many reads the page has started: only the last one started is shown. */
const readsStarted = { composition: 0, action: 0, kb: 0 };
/** Per add box ("field:key#copy"), what the user typed and its refusal: not part of any text, kept
 * through re-renders until it is added or changed. */
const addBoxes = new Map();

const ADD_PLACEHOLDER = { composition: "Add rule...", action: "Add rule...", kb: "Add knowledge base entry..." };

function boxKey(field, where) {
  return `${field}:${where.key}#${where.copy}`;
}

/** Shows `e` for a failed edit; a refused add keeps its text and says why in its box. */
function editFailed(e, field, where) {
  if (where && e.message === SECTION_MARKER_REFUSAL) setBoxError(field, where, e.message);
  showStatus(`Failed to save: ${e.message}`, true);
  log(`[Prompts] Failed to save ${field}: ${e}`, "error");
}

function setBoxError(field, where, error) {
  const key = boxKey(field, where);
  const box = addBoxes.get(key) ?? { value: "", error: "" };
  addBoxes.set(key, { ...box, error });
  const errorEl = document.querySelector(`.bullet-add-error[data-box="${key}"]`);
  if (errorEl) errorEl.textContent = error;
}

async function removeLine(field, where, text) {
  try {
    const outcome = await editShown(field, shown[field], (content) => removeItem(field, content, { ...where, text }));
    showStatus(outcome === "saved" ? "Saved" : "That line was already removed");
  } catch (e) {
    editFailed(e, field);
  }
}

async function addLine(field, where, text) {
  const key = boxKey(field, where);
  try {
    const outcome = await addStoredLine(field, shown[field], where, text);
    if (outcome === "gone") {
      setBoxError(field, where, "This section is no longer in the text, so nothing changed.");
      return;
    }
    // Added: the box empties, unless the user has typed something else meanwhile.
    if ((addBoxes.get(key)?.value ?? "").trim() === text) {
      addBoxes.delete(key);
      const input = document.querySelector(`.bullet-add-input[data-box="${key}"]`);
      if (input) input.value = "";
      setBoxError(field, where, "");
    }
    showStatus("Saved");
  } catch (e) {
    editFailed(e, field, where);
  }
}

/**
 * A section's editor: its items, each with a remove button, and an add box. `where` ({ key, copy }) is
 * the section the actions edit; the add box keeps what the user typed through re-renders.
 */
function createBulletListEditor(field, where, items) {
  const key = boxKey(field, where);
  const container = document.createElement("div");
  container.className = "bullet-list-editor";

  items.forEach((item) => {
    const itemDiv = document.createElement("div");
    itemDiv.className = "bullet-item";

    const textSpan = document.createElement("span");
    textSpan.className = "bullet-text";
    textSpan.textContent = item.text;
    itemDiv.appendChild(textSpan);

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "bullet-delete-btn";
    deleteBtn.textContent = "×"; // ×
    deleteBtn.title = "Remove this item";
    deleteBtn.addEventListener("click", () => removeLine(field, where, item.text));
    itemDiv.appendChild(deleteBtn);

    container.appendChild(itemDiv);
  });

  const box = addBoxes.get(key) ?? { value: "", error: "" };
  const addRow = document.createElement("div");
  addRow.className = "bullet-add-row";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "bullet-add-input";
  input.placeholder = ADD_PLACEHOLDER[field];
  input.dataset.box = key;
  input.value = box.value;

  const addBtn = document.createElement("button");
  addBtn.className = "bullet-add-btn";
  addBtn.textContent = "Add";
  addBtn.disabled = input.value.trim() === "";

  const errorEl = document.createElement("div");
  errorEl.className = "bullet-add-error";
  errorEl.dataset.box = key;
  errorEl.textContent = box.error;

  input.addEventListener("input", () => {
    addBoxes.set(key, { value: input.value, error: "" });
    errorEl.textContent = "";
    addBtn.disabled = input.value.trim() === "";
  });

  function addItem() {
    const text = input.value.trim();
    if (!text) return;
    addLine(field, where, text);
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addItem();
    }
  });
  addBtn.addEventListener("click", addItem);

  addRow.appendChild(input);
  addRow.appendChild(addBtn);
  container.appendChild(addRow);
  container.appendChild(errorEl);
  return container;
}

/** Re-renders `field` from its stored text, keeping the focus in an add box the user is typing in. */
function renderField(field) {
  const focused = document.activeElement?.classList?.contains("bullet-add-input") ? document.activeElement.dataset.box : null;
  const caret = focused ? document.activeElement.selectionStart : null;
  if (field === "kb") renderKb();
  else renderSections(field);
  // The Developer tab's raw text is a read-only view of what is shown.
  const raw = document.getElementById(`raw-${field}-content`);
  if (raw) raw.value = shown[field]?.content ?? "";
  if (focused) {
    const input = document.querySelector(`.bullet-add-input[data-box="${focused}"]`);
    if (input) {
      input.focus();
      if (caret !== null) input.setSelectionRange(caret, caret);
    }
  }
}

// Render a writing-style or action field's sections
function renderSections(field) {
  const container = document.getElementById(field === "composition" ? "composition-sections" : "action-sections");
  container.innerHTML = "";

  if (shown[field] === null) {
    container.innerHTML = "<p>Loading...</p>";
    return;
  }

  for (const section of pageSections(field, shown[field].content)) {
    const where = { key: section.key, copy: section.copy };
    const sectionDiv = document.createElement("div");
    sectionDiv.className = "section-container";

    const headerDiv = document.createElement("div");
    headerDiv.className = "section-header";

    const titleEl = document.createElement("h3");
    titleEl.textContent = section.title;
    if (field === "action") {
      const countSpan = document.createElement("span");
      countSpan.className = "kb-entry-count";
      countSpan.textContent = ` (${section.items.length})`;
      titleEl.appendChild(countSpan);
    }
    headerDiv.appendChild(titleEl);

    const actionsDiv = document.createElement("div");
    actionsDiv.className = "section-header-actions";
    const resetBtn = document.createElement("button");
    resetBtn.className = "reset-section-btn";
    resetBtn.textContent = "Reset";
    resetBtn.title = "Reset this section to default";
    resetBtn.addEventListener("click", () => {
      flashButton(resetBtn, "red");
      resetSection(field, section.title, where);
    });
    actionsDiv.appendChild(resetBtn);
    headerDiv.appendChild(actionsDiv);
    sectionDiv.appendChild(headerDiv);

    const contentDiv = document.createElement("div");
    contentDiv.className = "section-content";
    const simpleDiv = document.createElement("div");
    simpleDiv.className = "simple-content";
    const bulletEditor = createBulletListEditor(field, where, section.items);
    bulletEditor.setAttribute("data-section", section.title);
    simpleDiv.appendChild(bulletEditor);
    contentDiv.appendChild(simpleDiv);
    sectionDiv.appendChild(contentDiv);
    container.appendChild(sectionDiv);
  }
}

// Render the knowledge base
function renderKb() {
  const kbContainer = document.getElementById("kb-content-container");
  if (kbContainer && shown.kb !== null) {
    kbContainer.innerHTML = "";
    const bulletEditor = createBulletListEditor("kb", { key: "", copy: 0 }, pageSections("kb", shown.kb.content)[0].items);
    bulletEditor.id = "kb-bullet-editor";
    kbContainer.appendChild(bulletEditor);
  }
  updateKbEntryCount();
}

/** Shows `field`'s text and its labels as the store reads them now, unless a later read was started
 * meanwhile (a storage change since): that one shows a newer state. */
async function loadField(field) {
  const started = ++readsStarted[field];
  try {
    const view = await readView(field);
    if (readsStarted[field] !== started) return;
    shown[field] = view;
    renderField(field);
  } catch (e) {
    log(`[Prompts] Failed to read ${field}: ${e}`, "error");
    if (readsStarted[field] === started) showStatus(`Failed to load: ${e.message}`, true);
  }
}

/** Section Reset: the items of the copy the user clicked replaced by the section's defaults, in one edit;
 * every other line, another copy of the section included, is kept. */
async function resetSection(field, title, where) {
  if (!confirm(`Are you sure you want to reset "${title}" to default? This cannot be undone.`)) return;
  try {
    const outcome = await resetStoredSection(field, shown[field], where);
    if (outcome === "gone") throw new Error("Section not found in the text");
    showStatus(`Reset: ${title}`);
    log(`[Prompts] Reset section: ${title}`);
  } catch (e) {
    showStatus(`Failed to reset: ${e.message}`, true);
    log(`[Prompts] Failed to reset section: ${e}`, "error");
  }
}

/** Reset Entire Prompt and the knowledge base's Reset: DS-RESET of `field`, the one clicked for. */
async function resetWholeField(field, promptName) {
  try {
    await resetStoredField(field);
    showStatus(`Reset entire ${promptName} to default!`);
  } catch (e) {
    showStatus(`Failed to reset: ${e.message}`, true);
  }
}

// Sync toggle state
const SYNC_AUTO_KEY = "device_sync_auto_enabled";

function updateSyncToggleUI(autoEnabled, connected) {
  const btn = document.getElementById("sync-toggle");
  const label = document.getElementById("sync-toggle-label");
  if (!btn) return;
  btn.classList.remove("active", "connecting");
  if (autoEnabled && connected) {
    btn.classList.add("active");
    label.textContent = "Syncing";
  } else if (autoEnabled) {
    btn.classList.add("connecting");
    label.textContent = "Sync";
  } else {
    label.textContent = "Sync Off";
  }
}

// Current state
let currentPrompt = "composition";
let isDebugMode = false; // Track debug mode state

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
  } else if (promptType === "tasks") {
    document.getElementById("tasks-editor").classList.add("active");
    // Load tasks when switching to tasks tab
    loadTasks();
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
  }

  // Re-calculate textarea heights after tab is visible (except for developer, reminders, history tabs)
  if (promptType !== "developer" && promptType !== "tasks" && promptType !== "reminders" && promptType !== "history") {
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

// Update KB entry count display
function updateKbEntryCount() {
  const countSpan = document.getElementById("kb-entry-count");
  const maxBulletsSlider = document.getElementById("kb-max-bullets");
  if (!countSpan) return;

  const content = shown.kb?.content || "";
  const lines = content.split("\n").filter(l => l.trim());
  // Exclude reminder lines (consistent with backend counting)
  const entryCount = lines.filter(l => !REMINDER_LINE_REGEX.test(l.trim())).length;
  const maxBullets = maxBulletsSlider ? parseInt(maxBulletsSlider.value, 10) : 200;

  countSpan.textContent = `(${entryCount}/${maxBullets})`;
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

// Initialize
async function initialize() {
  try {
    // Check debug mode first
    await checkDebugMode();
    for (const field of FIELDS) await loadField(field);
    await loadActionConfig();
    await loadKbConfig();
    // Re-update count now that loadKbConfig has set the real max_bullets slider value
    updateKbEntryCount();
    log("[Prompts] Initialized successfully");
  } catch (e) {
    log(`[Prompts] Failed to initialize: ${e}`, "error");
    showStatus("Failed to load prompts", true);
  }
}

// Event listeners
document.addEventListener("DOMContentLoaded", () => {
  // Tab switching
  document.querySelectorAll(".prompt-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      switchTab(tab.dataset.prompt);
    });
  });
  
  // Reset Entire Prompt: the field of the tab it was clicked on, only.
  document.getElementById("reset-prompt").addEventListener("click", async () => {
    const field = currentPrompt;
    if (!FIELDS.includes(field)) {
      showStatus("Use the Developer tab buttons to reset raw files", true);
      return;
    }
    const promptName = field === "composition" ? "Email Composition" : field === "action" ? "Action Classification" : "Knowledge Base";
    if (!confirm(`Are you sure you want to reset ALL "${promptName}" to default? This cannot be undone.`)) {
      return;
    }
    flashButton(document.getElementById("reset-prompt"), "red");
    await resetWholeField(field, promptName);
  });

  document.getElementById("reset-kb").addEventListener("click", async () => {
    if (!confirm("Are you sure you want to reset the Knowledge Base to default? This cannot be undone.")) {
      return;
    }
    flashButton(document.getElementById("reset-kb"), "red");
    const kbContainer = document.getElementById("kb-content-container");
    if (kbContainer) flashBorder(kbContainer, "red");
    await resetWholeField("kb", "Knowledge Base");
  });

  // KB Compress button
  document.getElementById("compress-kb").addEventListener("click", async () => {
    const compressBtn = document.getElementById("compress-kb");
    const spinner = document.getElementById("compress-kb-spinner");
    const originalText = compressBtn.textContent;
    compressBtn.disabled = true;
    compressBtn.textContent = "Compressing\u2026";
    spinner.style.display = "inline-block";
    try {
      const result = await browser.runtime.sendMessage({ command: "kb-compress" });
      if (result && result.ok) {
        // The storage listener shows what was saved, with its labels.
        flashButton(compressBtn, "blue");
        showStatus("Knowledge base compressed successfully!");
      } else {
        showStatus("Compress failed: " + (result?.error || "unknown error"), true);
      }
    } catch (e) {
      showStatus("Compress failed: " + e.message, true);
    } finally {
      compressBtn.disabled = false;
      compressBtn.textContent = originalText;
      spinner.style.display = "none";
    }
  });

  // Action config slider: sync displayed value on input, auto-save on change
  const actionCompactSlider = document.getElementById("action-compact-threshold");
  const actionCompactVal = document.getElementById("action-compact-threshold-val");
  if (actionCompactSlider) {
    if (actionCompactVal) {
      actionCompactSlider.addEventListener("input", () => {
        actionCompactVal.textContent = actionCompactSlider.value;
      });
    }
    actionCompactSlider.addEventListener("change", async () => {
      await saveActionConfig();
    });
  }

  // Action config chars slider: sync displayed value on input, auto-save on change
  const actionCompactCharsSlider = document.getElementById("action-compact-threshold-chars");
  const actionCompactCharsVal = document.getElementById("action-compact-threshold-chars-val");
  if (actionCompactCharsSlider) {
    if (actionCompactCharsVal) {
      actionCompactCharsSlider.addEventListener("input", () => {
        actionCompactCharsVal.textContent = actionCompactCharsSlider.value;
      });
    }
    actionCompactCharsSlider.addEventListener("change", async () => {
      await saveActionConfig();
    });
  }

  // Compact now button
  document.getElementById("action-compact-now")?.addEventListener("click", async () => {
    const btn = document.getElementById("action-compact-now");
    const spinner = document.getElementById("action-compact-now-spinner");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Compacting…";
    if (spinner) spinner.style.display = "inline-block";
    try {
      const result = await browser.runtime.sendMessage({ command: "action-compact-now" });
      if (result && result.ok) {
        flashButton(btn, "blue");
        // Backend reason codes distinguish a discarded merge from a clean file
        const REASON_TEXT = {
          guard_char_retention: "Merge discarded by safety check \u2014 try again",
          guard_pure_delete: "Merge discarded by safety check \u2014 try again",
          no_ops_applied: "Merge didn't match current rules \u2014 try again",
          no_ops_parsed: "Merge didn't match current rules \u2014 try again",
          parse_failed: "Model response unusable \u2014 try again",
          llm_error: "Model response unusable \u2014 try again",
        };
        const msg = result.applied > 0
          ? `Merged ${result.applied} rule${result.applied !== 1 ? "s" : ""}`
          : (REASON_TEXT[result.reason] || "Nothing to compact");
        // The storage listener shows the merged rules once they are saved.
        showStatus(msg);
      } else if (result && result.ok === false && result.reason === "drift") {
        showStatus("The action rules changed while they were being compacted, so nothing was saved. Try again.", true);
      } else {
        showStatus("Compaction failed: " + (result?.error || "unknown error"), true);
      }
    } catch (e) {
      showStatus("Compaction failed: " + e.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
      if (spinner) spinner.style.display = "none";
    }
  });

  // KB config sliders: sync displayed value on input, auto-save on change
  const kbSliders = [
    { slider: document.getElementById("kb-reminder-retention"), display: document.getElementById("kb-reminder-retention-val") },
    { slider: document.getElementById("kb-max-bullets"), display: document.getElementById("kb-max-bullets-val") },
  ];
  for (const { slider, display } of kbSliders) {
    if (slider) {
      if (display) {
        slider.addEventListener("input", () => {
          display.textContent = slider.value;
          // Update KB entry count when max_bullets slider changes
          if (slider.id === "kb-max-bullets") updateKbEntryCount();
        });
      }
      slider.addEventListener("change", async () => {
        await saveKbConfig();
      });
    }
  }
  
  // Developer test handlers (implementation in modules/developer.js)
  document.getElementById("test-kb-refine").addEventListener("click", runKbRefineTest);
  document.getElementById("clear-test-output").addEventListener("click", clearTestOutput);

  // The raw texts on the Developer tab are a read-only view of what is stored, shown with each field.

  // Refresh tasks button
  document.getElementById("refresh-tasks").addEventListener("click", async () => {
    const refreshBtn = document.getElementById("refresh-tasks");
    flashButton(refreshBtn, "blue");
    await loadTasks();
    showStatus("Tasks refreshed");
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
  
  document.getElementById("clear-history").addEventListener("click", () => {
    showClearAllConfirmation();
  });

  // Initialize history-specific handlers (search, pagination, delete old)
  initHistoryHandlers();
  
  // Every stored text change is shown, whoever made it: the page keeps no text of its own.
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    for (const field of FIELDS) {
      if (changes[PROMPT_KEYS[field]] || changes[BULLET_STATE_KEYS[field]]) loadField(field);
    }

    // Compaction thresholds changed. Refresh on the timestamp, not the value: a sync
    // write carries both, while this page's own save carries only the value and the
    // background stamps the timestamp afterwards. Reading before that stamp resolves a
    // deliberate legacy-default value as never edited and shows the migrated default.
    if (changes[ACTION_CONFIG_TS_KEY]) {
      log("[Prompts] Action config changed, refreshing sliders");
      loadActionConfig();
    }

    // Reminders changed
    if (changes.disabled_reminders) {
      if (currentPrompt === "reminders") {
        log("[Prompts] Disabled reminders changed, refreshing list");
        loadReminders();
      }
    }
  });
  
  // Initialize
  initialize();

  // --- Auto-Sync Toggle (header button) ---
  (async () => {
    const syncAutoStored = await browser.storage.local.get({ [SYNC_AUTO_KEY]: true });
    let syncAutoEnabled = syncAutoStored[SYNC_AUTO_KEY] !== false;
    const syncStatus = await browser.runtime.sendMessage({ command: "device-sync-status" }).catch(() => null);
    updateSyncToggleUI(syncAutoEnabled, syncStatus?.connected || false);

    browser.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes._deviceSyncConnected !== undefined) {
        updateSyncToggleUI(syncAutoEnabled, !!changes._deviceSyncConnected.newValue);
      }
      if (area === "local" && changes[SYNC_AUTO_KEY] !== undefined) {
        syncAutoEnabled = changes[SYNC_AUTO_KEY].newValue !== false;
        updateSyncToggleUI(syncAutoEnabled, false);
      }
    });

    browser.runtime.sendMessage({ command: "device-sync-add-listener" }).then((res) => {
      if (res?.ok) updateSyncToggleUI(syncAutoEnabled, res.connected);
    }).catch(() => {});

    let syncPollTimer = null;
    document.getElementById("sync-toggle").addEventListener("click", async () => {
      // Cancel any stale poll from a previous enable toggle
      if (syncPollTimer) {
        clearInterval(syncPollTimer);
        syncPollTimer = null;
      }

      syncAutoEnabled = !syncAutoEnabled;
      await browser.storage.local.set({ [SYNC_AUTO_KEY]: syncAutoEnabled });
      updateSyncToggleUI(syncAutoEnabled, false);

      if (syncAutoEnabled) {
        await browser.runtime.sendMessage({ command: "device-sync-enable" }).catch(() => {});
        let attempts = 0;
        syncPollTimer = setInterval(async () => {
          attempts++;
          // Re-check current state — user may have toggled again while polling
          if (!syncAutoEnabled) {
            clearInterval(syncPollTimer);
            syncPollTimer = null;
            return;
          }
          const status = await browser.runtime.sendMessage({ command: "device-sync-status" }).catch(() => null);
          if (status?.connected) {
            updateSyncToggleUI(syncAutoEnabled, true);
            clearInterval(syncPollTimer);
            syncPollTimer = null;
          } else if (attempts >= 10) {
            clearInterval(syncPollTimer);
            syncPollTimer = null;
          }
        }, 500);
      } else {
        await browser.runtime.sendMessage({ command: "device-sync-disable" }).catch(() => {});
      }
    });
  })();

  // ─── Sync History Button (opens standalone page) ────────────────────
  document.getElementById("sync-history-btn")?.addEventListener("click", async () => {
    const url = browser.runtime.getURL("prompts/sync-history.html");
    const existing = await browser.tabs.query({ url }).catch(() => []);
    if (existing.length > 0) {
      await browser.tabs.update(existing[0].id, { active: true });
      await browser.windows.update(existing[0].windowId, { focused: true });
    } else {
      await browser.tabs.create({ url });
    }
  });

  // ─── Sync Now Button ────────────────────────────────────────────────
  document.getElementById("sync-now-btn")?.addEventListener("click", async () => {
    const btn = document.getElementById("sync-now-btn");
    btn.disabled = true;
    btn.textContent = "Syncing...";
    try {
      const result = await browser.runtime.sendMessage({ command: "device-sync-now" });
      if (!result?.ok) throw new Error(result?.error || "no reply");
      // What peers send is shown by the storage listener once it is saved.
      btn.textContent = "Synced!";
      setTimeout(() => { btn.textContent = "Sync Now"; btn.disabled = false; }, 1500);
    } catch (e) {
      showStatus(`Sync failed: ${e.message}`, true);
      log(`[Prompts] Sync Now failed: ${e}`, "error");
      btn.textContent = "Sync Now";
      btn.disabled = false;
    }
  });
});

// (Sync history functions moved to standalone sync-history.js page)
