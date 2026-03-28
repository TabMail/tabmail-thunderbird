/**
 * Scheduled Tasks tab functionality
 */

import { log } from "../../agent/modules/utils.js";
import { showStatus } from "./utils.js";

// Module state
let tasksData = [];

/**
 * Load tasks from background script
 */
export async function loadTasks() {
    try {
        log("[Prompts] Loading tasks...");

        const response = await browser.runtime.sendMessage({ command: "get-all-reminders" });

        if (!response || !response.ok) {
            throw new Error(response?.error || "Failed to load tasks");
        }

        const allReminders = response.reminders || [];
        tasksData = allReminders.filter(r => r.type === "task");
        log(`[Prompts] Loaded ${tasksData.length} tasks`);

        renderTasks();
    } catch (e) {
        log(`[Prompts] Error loading tasks: ${e}`, "error");
        document.getElementById("tasks-list").innerHTML =
            '<div class="reminders-loading">Failed to load tasks</div>';
    }
}

/**
 * Render tasks list
 */
function renderTasks() {
    const container = document.getElementById("tasks-list");
    const emptyMessage = document.getElementById("tasks-empty");

    if (!tasksData || tasksData.length === 0) {
        container.innerHTML = "";
        emptyMessage.style.display = "block";
        return;
    }

    emptyMessage.style.display = "none";
    container.innerHTML = "";

    tasksData.forEach((task) => {
        const item = document.createElement("div");
        item.className = "reminder-item" + (task.enabled === false ? " disabled" : "");
        item.setAttribute("data-hash", task.hash);

        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.className = "reminder-checkbox";
        checkbox.checked = task.enabled !== false;
        checkbox.title = task.enabled !== false ? "Click to disable this scheduled task" : "Click to enable this scheduled task";
        checkbox.addEventListener("change", () => handleTaskToggle(task.hash, checkbox.checked));

        const details = document.createElement("div");
        details.className = "reminder-details";

        const content = document.createElement("p");
        content.className = "reminder-content";
        content.textContent = task.instruction || task.content || "No content";
        details.appendChild(content);

        const meta = document.createElement("div");
        meta.className = "reminder-meta";

        const tag = document.createElement("span");
        tag.className = "reminder-source reminder-repeated-tag";
        tag.textContent = task.kind === "once" ? "One-time" : "Recurring";
        meta.appendChild(tag);

        if (task.scheduleDays || task.scheduleDate || task.scheduleTime) {
            const schedule = document.createElement("span");
            schedule.className = "reminder-due";
            const scheduleLabel = task.kind === "once" && task.scheduleDate
                ? `${task.scheduleDate} at ${task.scheduleTime || ""}`
                : `${task.scheduleDays || ""} at ${task.scheduleTime || ""}`;
            schedule.textContent = scheduleLabel;
            if (task.timezone) {
                schedule.title = `Timezone: ${task.timezone}`;
            }
            meta.appendChild(schedule);
        }

        details.appendChild(meta);
        item.appendChild(checkbox);
        item.appendChild(details);

        // Delete button
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "reminder-delete-btn";
        deleteBtn.title = "Delete this task";
        deleteBtn.innerHTML = "&#128465;"; // 🗑 wastebasket
        deleteBtn.addEventListener("click", () => handleTaskDelete(task));
        item.appendChild(deleteBtn);

        container.appendChild(item);
    });

    log(`[Prompts] Rendered ${tasksData.length} tasks`);
}

/**
 * Handle task enable/disable toggle
 */
async function handleTaskToggle(hash, enabled) {
    try {
        log(`[Prompts] Toggling task ${hash} to enabled=${enabled}`);

        const command = enabled ? "enable-reminder" : "disable-reminder";
        const response = await browser.runtime.sendMessage({
            command,
            hash,
        });

        if (!response || !response.ok) {
            throw new Error(response?.error || "Failed to update task");
        }

        // Update local data
        const task = tasksData.find(r => r.hash === hash);
        if (task) {
            task.enabled = enabled;
        }

        // Update UI
        const item = document.querySelector(`#tasks-list .reminder-item[data-hash="${hash}"]`);
        if (item) {
            if (enabled) {
                item.classList.remove("disabled");
            } else {
                item.classList.add("disabled");
            }
        }

        showStatus(enabled ? "Task enabled" : "Task hidden");
        log(`[Prompts] Task ${hash} toggled to enabled=${enabled}`);
    } catch (e) {
        log(`[Prompts] Error toggling task: ${e}`, "error");
        showStatus("Failed to update task", true);
        // Reload to get correct state
        loadTasks();
    }
}

/**
 * Handle KB task deletion
 */
async function handleTaskDelete(task) {
    try {
        log(`[Prompts] Deleting KB task ${task.hash}`);

        const response = await browser.runtime.sendMessage({
            command: "delete-kb-reminder",
            hash: task.hash,
            content: task.rawLine || task.content,
            type: "task",
        });

        if (!response || !response.ok) {
            throw new Error(response?.error || "Failed to delete task");
        }

        // Remove from local data and re-render
        tasksData = tasksData.filter(t => t.hash !== task.hash);
        renderTasks();

        showStatus("Task deleted");
        log(`[Prompts] Task ${task.hash} deleted`);
    } catch (e) {
        log(`[Prompts] Error deleting task: ${e}`, "error");
        showStatus("Failed to delete task", true);
    }
}

/**
 * Get current tasks data (for external access)
 */
export function getTasksData() {
    return tasksData;
}
