// toolCollapse.js – Collapsible tool call displays for chat UI
// Thunderbird 145, MV3
//
// Older tool calls auto-collapse, showing all messages from the most recent tool call.
// Users can click to expand/collapse to see messages from all tool calls.

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "./chatConfig.js";

// Animation duration for tool bubble fade (ms) - keep in sync with CSS
const TOOL_FADE_DURATION_MS = 500;

/**
 * Transition to new bubble: instantly hide old, fade in new (no vertical movement).
 * 
 * @param {HTMLElement} oldBubble - The bubble to hide immediately
 * @param {HTMLElement} newBubble - The bubble to fade in
 */
function transitionToNewBubble(oldBubble, newBubble) {
  if (!oldBubble || !newBubble) return;
  
  // Instantly hide the old bubble (no animation - prevents vertical jump)
  oldBubble.classList.add("collapsed");
  oldBubble.classList.remove("fading-in");
  
  // Fade in the new bubble
  newBubble.classList.remove("collapsed");
  newBubble.classList.add("fading-in");
  
  // After fade in completes, clean up
  setTimeout(() => {
    newBubble.classList.remove("fading-in");
  }, TOOL_FADE_DURATION_MS);
}

/**
 * Instantly collapse a bubble (no animation) - used when we need immediate hide.
 * 
 * @param {HTMLElement} bubble - The bubble to collapse
 */
function instantCollapse(bubble) {
  if (!bubble || bubble.classList.contains("collapsed")) return;
  bubble.classList.remove("fading-in");
  bubble.classList.add("collapsed");
}

/**
 * Check if a fade animation is currently in progress.
 * 
 * @returns {boolean}
 */
export function isCollapseAnimating() {
  try {
    const container = document.getElementById("chat-container");
    if (!container) return false;
    return container.querySelector(".fading-in") !== null;
  } catch (_) {
    return false;
  }
}

/**
 * Get or create a tool group container for the current tool session.
 * Tool groups visually group sequential tool bubbles and allow collapsing.
 * 
 * @param {HTMLElement} container - The chat container element
 * @param {string} [groupId] - Optional group identifier (e.g. pid or request_id)
 * @returns {HTMLElement} The tool group wrapper element
 */
export function getOrCreateToolGroup(container, groupId = null) {
  if (!CHAT_SETTINGS.toolCollapseEnabled) {
    return null;
  }
  
  try {
    // Check if there's an active (unclosed) tool group
    const existingGroup = container.querySelector(".tool-group:not(.finalized)");
    if (existingGroup) {
      log(`[ToolCollapse] Using existing tool group`);
      return existingGroup;
    }
    
    // Create a new tool group
    const group = document.createElement("div");
    group.className = "tool-group";
    if (groupId) {
      group.setAttribute("data-group-id", groupId);
    }
    
    // Create the header with expand/collapse toggle
    const header = document.createElement("div");
    header.className = "tool-group-header";
    header.innerHTML = `
      <span class="tool-group-toggle">▶</span>
      <span class="tool-group-label"></span>
    `;
    header.addEventListener("click", () => toggleToolGroup(group));
    
    // Create the content area for tool bubbles
    const content = document.createElement("div");
    content.className = "tool-group-content";
    
    group.appendChild(header);
    group.appendChild(content);
    container.appendChild(group);
    
    log(`[ToolCollapse] Created new tool group${groupId ? ` with id=${groupId}` : ""}`);
    return group;
  } catch (e) {
    log(`[ToolCollapse] Failed to get/create tool group: ${e}`, "error");
    return null;
  }
}

/**
 * Add a tool bubble to the current tool group and collapse older bubbles.
 * New bubble starts hidden, then transitions in while old ones hide (no vertical jump).
 * 
 * @param {HTMLElement} bubble - The tool bubble element to add
 * @param {HTMLElement} container - The chat container element
 * @param {string} [activityLabel] - The activity label to show in the header
 * @returns {void}
 */
export function addToolBubbleToGroup(bubble, container, activityLabel = null) {
  if (!CHAT_SETTINGS.toolCollapseEnabled) {
    return;
  }
  
  try {
    const group = getOrCreateToolGroup(container);
    if (!group) {
      log(`[ToolCollapse] No tool group available, bubble added directly`);
      return;
    }
    
    const content = group.querySelector(".tool-group-content");
    if (!content) {
      log(`[ToolCollapse] Tool group content area not found`, "warn");
      return;
    }
    
    // Check if there are existing visible bubbles
    const existingBubbles = Array.from(content.querySelectorAll(".agent-message.tool, .user-message.tool"));
    const hasExisting = existingBubbles.some(b => !b.classList.contains("collapsed"));
    
    // If there are existing bubbles, start new one hidden (will fade in during collapse)
    if (hasExisting) {
      bubble.classList.add("collapsed");
    }
    
    // Add the bubble to the DOM
    content.appendChild(bubble);
    
    // Update header label to show the current tool activity (only for agent bubbles with activity labels)
    const labelEl = group.querySelector(".tool-group-label");
    if (labelEl && activityLabel && bubble.classList.contains("agent-message")) {
      labelEl.textContent = activityLabel;
    }
    
    // Count unique tool calls (by pid) to determine if we should collapse
    const allBubbles = Array.from(content.querySelectorAll(".agent-message.tool, .user-message.tool"));
    const uniquePids = new Set(allBubbles.map(b => b.getAttribute("data-pid") || `_${allBubbles.indexOf(b)}`));
    
    // Trigger collapse/transition to show new bubble and hide old ones
    const minCount = CHAT_SETTINGS.toolCollapseMinCount || 2;
    if (uniquePids.size >= minCount) {
      collapseOlderBubbles(group);
    } else if (hasExisting) {
      // Even if we don't have enough pids to collapse, we still need to show the new bubble
      // if it was added hidden
      bubble.classList.remove("collapsed");
      bubble.classList.add("fading-in");
      setTimeout(() => bubble.classList.remove("fading-in"), TOOL_FADE_DURATION_MS);
    }
    
    log(`[ToolCollapse] Added bubble to group, total bubbles: ${allBubbles.length}, unique tool calls: ${uniquePids.size}`);
  } catch (e) {
    log(`[ToolCollapse] Failed to add bubble to group: ${e}`, "error");
  }
}

/**
 * Collapse older tool bubbles, showing all bubbles from the most recent tool call.
 * Bubbles from older tool calls are hidden, all bubbles from the current tool call are shown.
 * 
 * @param {HTMLElement} group - The tool group element
 * @returns {void}
 */
function collapseOlderBubbles(group) {
  try {
    const content = group.querySelector(".tool-group-content");
    if (!content) return;
    
    const bubbles = Array.from(content.querySelectorAll(".agent-message.tool, .user-message.tool"));
    if (bubbles.length < 2) return;
    
    // Group bubbles by their data-pid (tool call ID)
    const bubblesByPid = new Map();
    const pidOrder = []; // Track order of first appearance
    
    bubbles.forEach(bubble => {
      const pid = bubble.getAttribute("data-pid") || `_no_pid_${bubbles.indexOf(bubble)}`;
      if (!bubblesByPid.has(pid)) {
        bubblesByPid.set(pid, []);
        pidOrder.push(pid);
      }
      bubblesByPid.get(pid).push(bubble);
    });
    
    // If only one pid, nothing to collapse - but ensure all bubbles are visible
    if (pidOrder.length < 2) {
      log(`[ToolCollapse] Only one tool call, ensuring all bubbles visible`);
      bubbles.forEach(bubble => {
        bubble.classList.remove("collapsed", "fading-out");
      });
      return;
    }
    
    // The most recent pid is the last one in order
    const mostRecentPid = pidOrder[pidOrder.length - 1];
    const mostRecentBubbles = bubblesByPid.get(mostRecentPid) || [];
    
    let collapsedCount = 0;
    let shownCount = 0;
    
    // Process bubbles: show all from most recent pid, hide all from older pids
    for (const [pid, pidBubbles] of bubblesByPid) {
      const isMostRecent = pid === mostRecentPid;
      
      pidBubbles.forEach(bubble => {
        if (isMostRecent) {
          // Show ALL bubbles from the most recent tool call
          if (bubble.classList.contains("collapsed")) {
            bubble.classList.remove("collapsed");
            bubble.classList.add("fading-in");
            setTimeout(() => bubble.classList.remove("fading-in"), TOOL_FADE_DURATION_MS);
          }
          shownCount++;
        } else {
          // Hide bubbles from older tool calls
          if (!bubble.classList.contains("collapsed")) {
            instantCollapse(bubble);
            collapsedCount++;
          }
        }
      });
    }
    
    // Update group header to show collapsed state
    if (collapsedCount > 0 || pidOrder.length > 1) {
      group.classList.add("has-collapsed");
      const toggle = group.querySelector(".tool-group-toggle");
      if (toggle) {
        toggle.textContent = "▶";
      }
    }
    
    log(`[ToolCollapse] Collapse: ${collapsedCount} hidden, showing ${shownCount} from pid=${mostRecentPid}`);
  } catch (e) {
    log(`[ToolCollapse] Failed to collapse older bubbles: ${e}`, "error");
  }
}

/**
 * Toggle expand/collapse state of a tool group.
 * Arrow conventions:
 *   ▶ = collapsed (showing all messages from most recent tool call), click to expand all
 *   ▼ = expanded (showing all messages from all tool calls), click to collapse
 * 
 * @param {HTMLElement} group - The tool group element
 * @returns {void}
 */
function toggleToolGroup(group) {
  try {
    const content = group.querySelector(".tool-group-content");
    const toggle = group.querySelector(".tool-group-toggle");
    if (!content || !toggle) return;
    
    const isExpanded = group.classList.contains("expanded");
    
    if (isExpanded) {
      // Collapse - show all messages from the most recent tool call only
      group.classList.remove("expanded");
      toggle.textContent = "▶";
      
      // Use the same logic as collapseOlderBubbles to show all from most recent tool call
      collapseOlderBubbles(group);
      log(`[ToolCollapse] Tool group collapsed to most recent tool call`);
    } else {
      // Expand - show all bubbles (CSS handles the display via .expanded class)
      group.classList.add("expanded");
      toggle.textContent = "▼";
      
      // Remove collapsed class from all bubbles - CSS .expanded rule handles visibility
      const bubbles = content.querySelectorAll(".agent-message.tool, .user-message.tool");
      bubbles.forEach(bubble => {
        bubble.classList.remove("collapsed", "fading-out", "fading-in");
      });
      log(`[ToolCollapse] Tool group expanded, showing ${bubbles.length} bubble(s)`);
    }
  } catch (e) {
    log(`[ToolCollapse] Failed to toggle tool group: ${e}`, "error");
  }
}

/**
 * Finalize and remove the current tool group (called when assistant response arrives).
 * Fades out and removes all tool bubbles just like the old behavior.
 * 
 * @param {HTMLElement} container - The chat container element
 * @returns {Promise<void>}
 */
export async function finalizeToolGroup(container) {
  if (!CHAT_SETTINGS.toolCollapseEnabled) {
    return;
  }
  
  try {
    const activeGroup = container.querySelector(".tool-group:not(.finalized)");
    if (!activeGroup) {
      log(`[ToolCollapse] No active tool group to finalize`);
      return;
    }
    
    // Mark as finalized (no more bubbles will be added)
    activeGroup.classList.add("finalized");
    
    // Fade out and remove the entire tool group (like old behavior)
    const fadeMs = Number(CHAT_SETTINGS?.toolBubbleFadeMs) || 250;
    
    activeGroup.classList.add("tm-fade-out");
    log(`[ToolCollapse] Fading out tool group for ${fadeMs}ms`);
    
    await new Promise(resolve => setTimeout(resolve, fadeMs));
    
    try {
      activeGroup.remove();
      log(`[ToolCollapse] Removed tool group`);
    } catch (e) {
      log(`[ToolCollapse] Failed to remove tool group: ${e}`, "warn");
    }
  } catch (e) {
    log(`[ToolCollapse] Failed to finalize tool group: ${e}`, "error");
  }
}

/**
 * Check if tool collapsing is enabled.
 * 
 * @returns {boolean}
 */
export function isToolCollapseEnabled() {
  return !!CHAT_SETTINGS.toolCollapseEnabled;
}

/**
 * Clean up tool group listeners and animation state (for hot-reload safety).
 * 
 * @param {HTMLElement} container - The chat container element
 * @returns {void}
 */
export function cleanupToolGroups(container) {
  try {
    const groups = container.querySelectorAll(".tool-group");
    groups.forEach(group => {
      const header = group.querySelector(".tool-group-header");
      if (header) {
        // Clone to remove listeners
        const newHeader = header.cloneNode(true);
        header.parentNode.replaceChild(newHeader, header);
      }
    });
    log(`[ToolCollapse] Cleaned up ${groups.length} tool group(s)`);
  } catch (e) {
    log(`[ToolCollapse] Cleanup failed: ${e}`, "warn");
  }
}

