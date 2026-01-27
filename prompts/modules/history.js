/**
 * Chat History tab functionality
 */

import { log } from "../../agent/modules/utils.js";
import { showStatus } from "./utils.js";

const CHAT_HISTORY_STORAGE_KEY = "chat_history_queue";
let chatHistoryData = [];

/**
 * Load chat history from storage
 */
export async function loadChatHistory() {
    try {
        log("[Prompts] Loading chat history...");
        
        const result = await browser.storage.local.get(CHAT_HISTORY_STORAGE_KEY);
        chatHistoryData = result[CHAT_HISTORY_STORAGE_KEY] || [];
        
        log(`[Prompts] Loaded ${chatHistoryData.length} chat sessions`);
        renderChatHistory();
    } catch (e) {
        log(`[Prompts] Error loading chat history: ${e}`, "error");
        document.getElementById("history-list").innerHTML = 
            '<div class="history-loading">Failed to load chat history</div>';
    }
}

/**
 * Render chat history list
 */
function renderChatHistory() {
    const container = document.getElementById("history-list");
    const emptyMessage = document.getElementById("history-empty");
    const statsDiv = document.getElementById("history-stats");
    
    // Calculate stats
    const totalSessions = chatHistoryData.length;
    const rememberedCount = chatHistoryData.filter(s => s.remembered).length;
    const unrememberedCount = totalSessions - rememberedCount;
    const totalMessages = chatHistoryData.reduce((sum, s) => sum + (s.messages?.length || 0), 0);
    
    statsDiv.innerHTML = `
        <span class="history-stat">
            <span class="history-stat-label">Sessions:</span>
            <span class="history-stat-value">${totalSessions}</span>
        </span>
        <span class="history-stat">
            <span class="history-stat-label">Pending:</span>
            <span class="history-stat-value">${unrememberedCount}</span>
        </span>
        <span class="history-stat">
            <span class="history-stat-label">In Knowledge Base:</span>
            <span class="history-stat-value">${rememberedCount}</span>
        </span>
        <span class="history-stat">
            <span class="history-stat-label">Messages:</span>
            <span class="history-stat-value">${totalMessages}</span>
        </span>
    `;
    
    if (!chatHistoryData || chatHistoryData.length === 0) {
        container.innerHTML = "";
        emptyMessage.style.display = "block";
        return;
    }
    
    emptyMessage.style.display = "none";
    container.innerHTML = "";
    
    // Sort by timestamp descending (most recent first)
    const sortedSessions = [...chatHistoryData].sort((a, b) => b.timestamp - a.timestamp);
    
    sortedSessions.forEach((session) => {
        const sessionDiv = document.createElement("div");
        sessionDiv.className = "history-session" + (session.remembered ? " remembered" : "");
        sessionDiv.setAttribute("data-session-id", session.id);
        
        // Header
        const header = document.createElement("div");
        header.className = "history-session-header";
        header.onclick = () => {
            sessionDiv.classList.toggle("expanded");
        };
        
        const info = document.createElement("div");
        info.className = "history-session-info";
        
        const timeSpan = document.createElement("span");
        timeSpan.className = "history-session-time";
        timeSpan.textContent = formatSessionTime(session.timestamp);
        info.appendChild(timeSpan);
        
        const badge = document.createElement("span");
        badge.className = "history-session-badge" + (session.remembered ? " remembered" : "");
        badge.textContent = session.remembered ? "In Knowledge Base" : "Pending";
        info.appendChild(badge);
        
        const rightSide = document.createElement("div");
        rightSide.className = "history-session-right";
        
        const meta = document.createElement("span");
        meta.className = "history-session-meta";
        meta.textContent = `${session.messages?.length || 0} messages`;
        rightSide.appendChild(meta);
        
        const deleteBtn = document.createElement("button");
        deleteBtn.className = "history-delete-btn";
        deleteBtn.textContent = "×";
        deleteBtn.title = "Delete this session";
        deleteBtn.onclick = (e) => {
            e.stopPropagation(); // Prevent expand/collapse
            deleteSession(session.id);
        };
        rightSide.appendChild(deleteBtn);
        
        header.appendChild(info);
        header.appendChild(rightSide);
        sessionDiv.appendChild(header);
        
        // Messages (hidden by default)
        const messagesDiv = document.createElement("div");
        messagesDiv.className = "history-session-messages";
        
        (session.messages || []).forEach((msg) => {
            const msgDiv = document.createElement("div");
            msgDiv.className = "history-message " + msg.role;
            
            // Check if this is the automated greeting marker
            const isGreeting = msg.content === "[automated greeting]";
            
            const roleDiv = document.createElement("div");
            roleDiv.className = "history-message-role";
            roleDiv.textContent = msg.role === "user" ? "You" : (isGreeting ? "Agent (greeting)" : "Agent");
            
            const contentDiv = document.createElement("div");
            contentDiv.className = "history-message-content";
            if (isGreeting) {
                contentDiv.textContent = "(automated inbox summary and reminders)";
                contentDiv.style.fontStyle = "italic";
                contentDiv.style.opacity = "0.7";
            } else {
                contentDiv.textContent = msg.content || "";
            }
            
            msgDiv.appendChild(roleDiv);
            msgDiv.appendChild(contentDiv);
            messagesDiv.appendChild(msgDiv);
        });
        
        sessionDiv.appendChild(messagesDiv);
        container.appendChild(sessionDiv);
    });
    
    log(`[Prompts] Rendered ${chatHistoryData.length} chat sessions`);
}

/**
 * Format session timestamp for display
 */
function formatSessionTime(timestamp) {
    if (!timestamp) return "Unknown";
    
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    if (diffDays === 0) {
        return `Today at ${timeStr}`;
    } else if (diffDays === 1) {
        return `Yesterday at ${timeStr}`;
    } else if (diffDays < 7) {
        const dayName = date.toLocaleDateString([], { weekday: 'long' });
        return `${dayName} at ${timeStr}`;
    } else {
        return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ` at ${timeStr}`;
    }
}

/**
 * Delete a single chat session
 */
async function deleteSession(sessionId) {
    try {
        // Filter out the session to delete
        chatHistoryData = chatHistoryData.filter(s => s.id !== sessionId);
        
        // Save to storage
        await browser.storage.local.set({ [CHAT_HISTORY_STORAGE_KEY]: chatHistoryData });
        
        // Re-render
        renderChatHistory();
        log(`[Prompts] Deleted chat session: ${sessionId}`);
    } catch (e) {
        log(`[Prompts] Error deleting session: ${e}`, "error");
        showStatus("Failed to delete session", true);
    }
}

/**
 * Clear all chat history
 */
export async function clearChatHistory() {
    try {
        await browser.storage.local.remove(CHAT_HISTORY_STORAGE_KEY);
        chatHistoryData = [];
        renderChatHistory();
        showStatus("Chat history cleared");
        log("[Prompts] Chat history cleared");
    } catch (e) {
        log(`[Prompts] Error clearing chat history: ${e}`, "error");
        showStatus("Failed to clear chat history", true);
    }
}
