/**
 * Reminders tab functionality
 */

import { log } from "../../agent/modules/utils.js";
import { showStatus } from "./utils.js";

// Module state
let remindersData = [];
let reachedOutIds = {};

/**
 * Load reminders from background script
 */
export async function loadReminders() {
    try {
        log("[Prompts] Loading reminders...");

        const [response, reachedOutStored] = await Promise.all([
            browser.runtime.sendMessage({ command: "get-all-reminders" }),
            browser.storage.local.get({ "notifications.reached_out_ids": {} }),
        ]);

        if (!response || !response.ok) {
            throw new Error(response?.error || "Failed to load reminders");
        }

        remindersData = response.reminders || [];
        reachedOutIds = reachedOutStored["notifications.reached_out_ids"] || {};
        log(`[Prompts] Loaded ${remindersData.length} reminders (${response.counts?.disabled || 0} disabled, ${Object.keys(reachedOutIds).length} notified)`);

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

        // Notified badge (if user was reached out about this reminder)
        if (reminder.hash && reachedOutIds[reminder.hash]) {
            const notified = document.createElement("span");
            notified.className = "reminder-notified";
            notified.textContent = "✓ Notified";
            notified.title = `User was notified (${reachedOutIds[reminder.hash].trigger === "due_approaching" ? "due approaching" : "new reminder"})`;
            meta.appendChild(notified);
        }
        
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

/**
 * Get current reminders data (for external access)
 */
export function getRemindersData() {
    return remindersData;
}
