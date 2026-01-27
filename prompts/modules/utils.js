/**
 * Prompts page utility functions
 */

import { log } from "../../agent/modules/utils.js";

/**
 * Auto-grow textarea to fit content
 */
export function autoGrowTextarea(textarea) {
    // Reset height to recalculate
    textarea.style.height = "auto";
    // Set to scrollHeight + 2px to ensure there's always room for one more line
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
}

/**
 * Show status message
 */
export function showStatus(message, isError = false) {
    const statusEl = document.getElementById("status-message");
    if (!statusEl) return;
    
    statusEl.textContent = message;
    statusEl.className = isError ? "error" : "success";
    statusEl.style.display = "block";
    
    // Hide after 3 seconds
    setTimeout(() => {
        statusEl.style.display = "none";
    }, 3000);
}

/**
 * Flash button with color feedback
 */
export function flashButton(button, color = null) {
    if (!button) return;
    
    // Store original styles
    const originalBackground = button.style.background;
    const originalBorder = button.style.border;
    
    // Apply flash based on color
    if (color === "red") {
        button.classList.add("btn-flash-red");
    } else if (color === "blue") {
        button.classList.add("btn-flash-blue");
    } else if (color === "green") {
        button.classList.add("btn-flash-green");
    } else {
        button.classList.add("btn-flash-blue");
    }
    
    // Remove class after animation
    setTimeout(() => {
        button.classList.remove("btn-flash-red", "btn-flash-blue", "btn-flash-green");
        button.style.background = originalBackground;
        button.style.border = originalBorder;
    }, 600);
}

/**
 * Flash element border with color
 */
export function flashBorder(element, color = "blue") {
    if (!element) return;
    
    // Get CSS variable for the color
    let flashClass;
    if (color === "red") {
        flashClass = "border-flash-red";
    } else if (color === "green") {
        flashClass = "border-flash-green";
    } else {
        flashClass = "border-flash-blue";
    }
    
    // Store original outline
    const originalOutline = element.style.outline;
    const originalOutlineOffset = element.style.outlineOffset;
    
    // Apply flash class
    element.classList.add(flashClass);
    
    // Remove after animation
    setTimeout(() => {
        element.classList.remove(flashClass);
        element.style.outline = originalOutline;
        element.style.outlineOffset = originalOutlineOffset;
    }, 600);
}

/**
 * Deep clone an object
 */
export function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
}
